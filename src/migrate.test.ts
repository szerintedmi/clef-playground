import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDatabase } from "./db";
import { MIGRATIONS_DIR, loadMigrations, migrate, migrationStatus, newMigration } from "./migrate";

let dir: string;
let db: Database;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "clef-migrations-"));
  db = new Database(":memory:", { strict: true });
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const write = (file: string, sql: string) => writeFileSync(join(dir, file), sql);
const tables = () =>
  db
    .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all()
    .map((r) => r.name);

describe("loadMigrations", () => {
  test("sorts numerically, not lexically", () => {
    write("10_ten.sql", "");
    write("2_two.sql", "");
    write("0001_one.sql", "");
    expect(loadMigrations(dir).map((m) => m.version)).toEqual([1, 2, 10]);
  });

  test("ignores non-.sql files and rejects badly named ones", () => {
    write("README.md", "");
    write("0001_ok.sql", "");
    expect(loadMigrations(dir)).toHaveLength(1);
    write("init.sql", "");
    expect(() => loadMigrations(dir)).toThrow('Bad migration filename "init.sql"');
  });

  test("rejects duplicate versions", () => {
    write("0001_a.sql", "");
    write("1_b.sql", "");
    expect(() => loadMigrations(dir)).toThrow("Duplicate migration version 1");
  });
});

describe("migrate", () => {
  test("applies pending migrations in order, each with multiple statements", () => {
    write("0001_a.sql", "CREATE TABLE a (id INTEGER); CREATE TABLE b (id INTEGER);");
    write("0002_c.sql", "ALTER TABLE a ADD COLUMN note TEXT;");
    const applied = migrate(db, { dir });

    expect(applied.map((m) => m.file)).toEqual(["0001_a.sql", "0002_c.sql"]);
    expect(tables()).toEqual(["a", "b", "schema_migrations"]);
    expect(db.query("SELECT note FROM a").all()).toEqual([]);
  });

  test("is idempotent and only applies new files on later runs", () => {
    write("0001_a.sql", "CREATE TABLE a (id INTEGER);");
    migrate(db, { dir });
    expect(migrate(db, { dir })).toEqual([]);

    write("0002_b.sql", "CREATE TABLE b (id INTEGER);");
    expect(migrate(db, { dir }).map((m) => m.version)).toEqual([2]);
  });

  test("records version, name, and checksum", () => {
    write("0001_add_things.sql", "CREATE TABLE t (id INTEGER);");
    migrate(db, { dir });
    const row = db.query<{ version: number; name: string; checksum: string }, []>("SELECT * FROM schema_migrations").get();
    expect(row).toMatchObject({ version: 1, name: "add_things", checksum: expect.stringMatching(/^[0-9a-f]{64}$/) });
  });

  test("rolls back a failing migration entirely and stops there", () => {
    write("0001_ok.sql", "CREATE TABLE ok (id INTEGER);");
    write("0002_bad.sql", "CREATE TABLE half (id INTEGER); INSERT INTO nope VALUES (1);");
    write("0003_never.sql", "CREATE TABLE never (id INTEGER);");

    expect(() => migrate(db, { dir })).toThrow("no such table: nope");
    expect(tables()).toEqual(["ok", "schema_migrations"]);
    expect(migrationStatus(db, dir).pending.map((m) => m.version)).toEqual([2, 3]);
  });

  test("warns about edited and missing migrations without failing", () => {
    write("0001_a.sql", "CREATE TABLE a (id INTEGER);");
    write("0002_b.sql", "CREATE TABLE b (id INTEGER);");
    migrate(db, { dir });
    write("0001_a.sql", "CREATE TABLE a (id INTEGER); -- edited");
    rmSync(join(dir, "0002_b.sql"));

    const logs: string[] = [];
    migrate(db, { dir, log: (m) => logs.push(m) });
    expect(logs).toEqual([
      "⚠  migration 0001_a.sql was edited after it was applied",
      "⚠  database has migration 2_b, which is missing from disk",
    ]);
  });
});

describe("newMigration", () => {
  test("creates the next number with a slugified name", () => {
    expect(newMigration("first", dir)).toEndWith("0001_first.sql");
    write("0007_seven.sql", "");
    const path = newMigration("Add run notes!", dir);
    expect(path).toEndWith("0008_add_run_notes.sql");
    expect(readFileSync(path, "utf8")).toBe("-- add_run_notes\n\n");
  });

  test("requires a name", () => {
    expect(() => newMigration(" !! ", dir)).toThrow("Migration name is required");
    expect(readdirSync(dir)).toEqual([]);
  });
});

describe("project migrations", () => {
  test("build the schema the store expects", () => {
    const real = createDatabase(":memory:");
    const cols = (t: string) => real.query<{ name: string }, []>(`PRAGMA table_info(${t})`).all().map((c) => c.name);
    expect(cols("question_sets")).toEqual(["id", "name", "questions", "updated_at"]);
    expect(cols("inputs")).toEqual(["id", "name", "state", "state_is_json", "images", "updated_at"]);
    expect(cols("runs")).toContain("latency_ms");
    expect(migrationStatus(real).pending).toEqual([]);
    real.close();
  });

  test("baseline applies cleanly to a database created before migrations existed", () => {
    // Simulate a pre-migrations database that already has the tables (and data).
    const sql = loadMigrations(MIGRATIONS_DIR)[0]!.sql;
    db.run(sql);
    db.run("INSERT INTO runs (model, request, response, ok, latency_ms) VALUES ('clef', '{}', '{}', 1, 1)");

    expect(migrate(db).map((m) => m.version)).toContain(1);
    expect(db.query<{ n: number }, []>("SELECT count(*) n FROM runs").get()!.n).toBe(1);
  });
});
