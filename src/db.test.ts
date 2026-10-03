import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createStore, type Store } from "./db";
import type { RunRecord } from "./shared";

let store: Store;
beforeEach(() => {
  store = createStore(":memory:");
});
afterEach(() => store.close());

const q = { a: { type: "noul" as const, instructions: "x" } };

describe("questionSets", () => {
  test("save returns the stored set with parsed questions", () => {
    const s = store.questionSets.save("demo", q);
    expect(s).toMatchObject({ id: expect.any(Number), name: "demo", questions: q });
    expect(store.questionSets.list()).toEqual([s]);
  });

  test("saving an existing name overwrites it in place", () => {
    const first = store.questionSets.save("demo", q);
    const q2 = { b: { type: "score" as const, instructions: "y", criteria: ["lo", "hi"] } };
    const second = store.questionSets.save("demo", q2);
    expect(second.id).toBe(first.id);
    expect(store.questionSets.list()).toHaveLength(1);
    expect(store.questionSets.list()[0]!.questions).toEqual(q2);
  });

  test("remove deletes by id", () => {
    const a = store.questionSets.save("a", q);
    store.questionSets.save("b", q);
    store.questionSets.remove(a.id);
    expect(store.questionSets.list().map((s) => s.name)).toEqual(["b"]);
  });
});

describe("inputs", () => {
  test("round-trips state, JSON flag, and images", () => {
    const img = "data:image/png;base64,AAAA";
    const saved = store.inputs.save("in", '{"a":1}', true, [img]);
    expect(saved).toMatchObject({ name: "in", state: '{"a":1}', stateIsJson: true, images: [img] });
    expect(store.inputs.list()).toEqual([saved]);
  });

  test("upserts by name", () => {
    const first = store.inputs.save("in", "one", false, []);
    const second = store.inputs.save("in", "two", true, ["data:x"]);
    expect(second.id).toBe(first.id);
    expect(store.inputs.list()).toEqual([second]);
    expect(second).toMatchObject({ state: "two", stateIsJson: true, images: ["data:x"] });
  });

  test("remove deletes by id", () => {
    const saved = store.inputs.save("in", "x", false, []);
    store.inputs.remove(saved.id);
    expect(store.inputs.list()).toEqual([]);
  });
});

describe("runs", () => {
  const run = (patch: Partial<RunRecord> = {}): Omit<RunRecord, "id" | "createdAt"> => ({
    model: "clef",
    request: { model: "clef", state: { x: 1 }, questions: q, images: ["data:image/png;base64,AAAA"] },
    response: { result: { answers: {} } },
    ok: true,
    inputTokens: 412,
    outputTokens: 9,
    costUsd: 0.0000989,
    latencyMs: 734.2,
    ...patch,
  });

  test("insert returns increasing ids; list is newest first", () => {
    const a = store.runs.insert(run());
    const b = store.runs.insert(run({ model: "clef-flash" }));
    expect(b).toBeGreaterThan(a);
    expect(store.runs.list().map((r) => r.id)).toEqual([b, a]);
  });

  test("get returns the full record including images", () => {
    const id = store.runs.insert(run());
    expect(store.runs.get(id)).toMatchObject({ id, ...run() });
  });

  test("list blanks image data but keeps the count", () => {
    store.runs.insert(run());
    expect(store.runs.list()[0]!.request.images).toEqual([""]);
  });

  test("ok is stored as a boolean", () => {
    const id = store.runs.insert(run({ ok: false }));
    expect(store.runs.get(id)!.ok).toBe(false);
  });

  test("list respects the limit", () => {
    for (let i = 0; i < 5; i++) store.runs.insert(run());
    expect(store.runs.list(3)).toHaveLength(3);
  });

  test("get returns null for an unknown id; clear empties history", () => {
    store.runs.insert(run());
    expect(store.runs.get(999)).toBeNull();
    store.runs.clear();
    expect(store.runs.list()).toEqual([]);
  });
});
