// Minimal forward-only SQL migrations.
//
// Migrations are files named NNNN_name.sql in migrations/, applied in numeric order. Each one runs in a
// transaction and is recorded in schema_migrations, so a failed migration leaves the database untouched.
// Never edit a migration that has been applied; add a new one instead (edits are reported as checksum mismatches).
//
// CLI:
//   bun src/migrate.ts            apply pending migrations to $CLEF_DB (default data/sqlite/clef.sqlite)
//   bun src/migrate.ts status     list applied / pending migrations
//   bun src/migrate.ts new <name> create the next numbered migration file

import type { Database } from "bun:sqlite";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const MIGRATIONS_DIR = join(import.meta.dir, "..", "migrations");
export const DEFAULT_DB_PATH = "data/sqlite/clef.sqlite";

const FILE_RE = /^(\d+)_([a-z0-9_-]+)\.sql$/i;

export type Migration = { version: number; name: string; file: string; sql: string; checksum: string };
type AppliedRow = { version: number; name: string; checksum: string; applied_at: string };

export function loadMigrations(dir = MIGRATIONS_DIR): Migration[] {
  const migrations = readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .map((file) => {
      const m = FILE_RE.exec(file);
      if (!m) throw new Error(`Bad migration filename "${file}"; expected NNNN_name.sql`);
      const sql = readFileSync(join(dir, file), "utf8");
      return { version: Number(m[1]), name: m[2]!, file, sql, checksum: new Bun.CryptoHasher("sha256").update(sql).digest("hex") };
    })
    .sort((a, b) => a.version - b.version);

  for (let i = 1; i < migrations.length; i++) {
    if (migrations[i]!.version === migrations[i - 1]!.version)
      throw new Error(`Duplicate migration version ${migrations[i]!.version}: ${migrations[i - 1]!.file}, ${migrations[i]!.file}`);
  }
  return migrations;
}

function ensureTable(db: Database) {
  db.run(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    checksum TEXT NOT NULL,
    applied_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
}

export function migrationStatus(db: Database, dir = MIGRATIONS_DIR) {
  ensureTable(db);
  const migrations = loadMigrations(dir);
  const applied = new Map(
    db
      .query<AppliedRow, []>("SELECT * FROM schema_migrations ORDER BY version")
      .all()
      .map((r) => [r.version, r]),
  );
  return {
    applied: [...applied.values()],
    pending: migrations.filter((m) => !applied.has(m.version)),
    modified: migrations.filter((m) => applied.has(m.version) && applied.get(m.version)!.checksum !== m.checksum),
    unknown: [...applied.values()].filter((r) => !migrations.some((m) => m.version === r.version)),
  };
}

/** Applies pending migrations in order. Returns the ones applied. */
export function migrate(db: Database, opts: { dir?: string; log?: (msg: string) => void } = {}): Migration[] {
  const log = opts.log ?? (() => {});
  const { pending, modified, unknown } = migrationStatus(db, opts.dir);

  for (const m of modified) log(`⚠  migration ${m.file} was edited after it was applied`);
  for (const r of unknown) log(`⚠  database has migration ${r.version}_${r.name}, which is missing from disk`);

  for (const m of pending) {
    db.transaction(() => {
      db.run(m.sql);
      db.run("INSERT INTO schema_migrations (version, name, checksum) VALUES (?, ?, ?)", [m.version, m.name, m.checksum]);
    })();
    log(`✓ applied ${m.file}`);
  }
  return pending;
}

/** Creates the next numbered, empty migration file and returns its path. */
export function newMigration(name: string, dir = MIGRATIONS_DIR): string {
  const slug = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
  if (!slug) throw new Error("Migration name is required");
  const next = (loadMigrations(dir).at(-1)?.version ?? 0) + 1;
  const path = join(dir, `${String(next).padStart(4, "0")}_${slug}.sql`);
  writeFileSync(path, `-- ${slug}\n\n`, { flag: "wx" });
  return path;
}

if (import.meta.main) {
  const [cmd, ...rest] = process.argv.slice(2);
  if (cmd === "new") {
    console.log(`created ${newMigration(rest.join(" "))}`);
  } else {
    const { createDatabase } = await import("./db");
    const db = createDatabase(process.env.CLEF_DB ?? DEFAULT_DB_PATH, { migrate: false });
    if (cmd === "status") {
      const s = migrationStatus(db);
      for (const r of s.applied) console.log(`  applied  ${String(r.version).padStart(4, "0")}_${r.name}  (${r.applied_at})`);
      for (const m of s.pending) console.log(`  pending  ${m.file}`);
      for (const m of s.modified) console.log(`  ⚠ edited ${m.file}`);
      for (const r of s.unknown) console.log(`  ⚠ unknown ${r.version}_${r.name}`);
      if (!s.applied.length && !s.pending.length) console.log("  no migrations");
    } else if (!cmd || cmd === "up") {
      const applied = migrate(db, { log: console.log });
      if (!applied.length) console.log("Database is up to date.");
    } else {
      console.error(`Unknown command "${cmd}". Use: up | status | new <name>`);
      process.exit(1);
    }
    db.close();
  }
}
