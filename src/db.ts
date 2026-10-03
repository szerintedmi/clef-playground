import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { migrate } from "./migrate";
import type { ModelName, QuestionSet, Questions, RunRecord, RunRequest, SavedInput } from "./shared";

type QuestionSetRow = { id: number; name: string; questions: string; updated_at: string };
type InputRow = {
  id: number;
  name: string;
  state: string;
  state_is_json: number;
  images: string;
  updated_at: string;
};
type RunRow = {
  id: number;
  model: string;
  request: string;
  response: string;
  ok: number;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
  latency_ms: number;
  created_at: string;
};

const toQuestionSet = (r: QuestionSetRow): QuestionSet => ({
  id: r.id,
  name: r.name,
  questions: JSON.parse(r.questions),
  updatedAt: r.updated_at,
});

const toInput = (r: InputRow): SavedInput => ({
  id: r.id,
  name: r.name,
  state: r.state,
  stateIsJson: !!r.state_is_json,
  images: JSON.parse(r.images),
  updatedAt: r.updated_at,
});

const toRun = (r: RunRow, withImages: boolean): RunRecord => {
  const request: RunRequest = JSON.parse(r.request);
  if (!withImages) request.images = request.images.map(() => "");
  return {
    id: r.id,
    model: r.model as ModelName,
    request,
    response: JSON.parse(r.response),
    ok: !!r.ok,
    inputTokens: r.input_tokens,
    outputTokens: r.output_tokens,
    costUsd: r.cost_usd,
    latencyMs: r.latency_ms,
    createdAt: r.created_at,
  };
};

export type Store = ReturnType<typeof createStore>;

/** Opens (creating if needed) a SQLite database and brings its schema up to date. */
export function createDatabase(path: string, opts: { migrate?: boolean; migrationsDir?: string } = {}) {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path, { create: true, strict: true });
  db.run("PRAGMA journal_mode = WAL");
  if (opts.migrate ?? true) migrate(db, { dir: opts.migrationsDir, log: path === ":memory:" ? undefined : console.log });
  return db;
}

export function createStore(path: string) {
  const db = createDatabase(path);

  // Upserts are keyed by name so "Save" with an existing name overwrites it.

  const questionSets = {
    list: () =>
      db.query<QuestionSetRow, []>("SELECT * FROM question_sets ORDER BY updated_at DESC").all().map(toQuestionSet),
    save: (name: string, questions: Questions) =>
      toQuestionSet(
        db
          .query<QuestionSetRow, { name: string; questions: string }>(
            `INSERT INTO question_sets (name, questions) VALUES ($name, $questions)
             ON CONFLICT(name) DO UPDATE SET questions = excluded.questions, updated_at = datetime('now')
             RETURNING *`,
          )
          .get({ name, questions: JSON.stringify(questions) })!,
      ),
    remove: (id: number) => db.run("DELETE FROM question_sets WHERE id = ?", [id]),
  };

  const inputs = {
    list: () => db.query<InputRow, []>("SELECT * FROM inputs ORDER BY updated_at DESC").all().map(toInput),
    save: (name: string, state: string, stateIsJson: boolean, images: string[]) =>
      toInput(
        db
          .query<InputRow, { name: string; state: string; isJson: number; images: string }>(
            `INSERT INTO inputs (name, state, state_is_json, images) VALUES ($name, $state, $isJson, $images)
             ON CONFLICT(name) DO UPDATE SET state = excluded.state, state_is_json = excluded.state_is_json,
               images = excluded.images, updated_at = datetime('now')
             RETURNING *`,
          )
          .get({ name, state, isJson: stateIsJson ? 1 : 0, images: JSON.stringify(images) })!,
      ),
    remove: (id: number) => db.run("DELETE FROM inputs WHERE id = ?", [id]),
  };

  const runs = {
    list: (limit = 50) =>
      db
        .query<RunRow, [number]>("SELECT * FROM runs ORDER BY id DESC LIMIT ?")
        .all(limit)
        .map((r) => toRun(r, false)),
    get: (id: number) => {
      const row = db.query<RunRow, [number]>("SELECT * FROM runs WHERE id = ?").get(id);
      return row ? toRun(row, true) : null;
    },
    insert: (r: Omit<RunRecord, "id" | "createdAt">) =>
      db
        .query<{ id: number }, Record<string, string | number>>(
          `INSERT INTO runs (model, request, response, ok, input_tokens, output_tokens, cost_usd, latency_ms)
           VALUES ($model, $request, $response, $ok, $inputTokens, $outputTokens, $costUsd, $latencyMs)
           RETURNING id`,
        )
        .get({
          model: r.model,
          request: JSON.stringify(r.request),
          response: JSON.stringify(r.response),
          ok: r.ok ? 1 : 0,
          inputTokens: r.inputTokens,
          outputTokens: r.outputTokens,
          costUsd: r.costUsd,
          latencyMs: r.latencyMs,
        })!.id,
    clear: () => db.run("DELETE FROM runs"),
  };

  return { questionSets, inputs, runs, close: () => db.close() };
}
