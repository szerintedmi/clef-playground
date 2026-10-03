import { describe, expect, test } from "bun:test";
import type { Questions } from "../shared";
import {
  DEFAULT_QUESTIONS,
  argmax,
  blankDraft,
  dataUrlBytes,
  draftsFromQuestions,
  fmtMs,
  fmtUsd,
  pct,
  questionsFromDrafts,
  validateDrafts,
  type QDraft,
} from "./lib";

const draft = (patch: Partial<QDraft>): QDraft => ({ ...blankDraft("q"), instructions: "Is it?", ...patch });

describe("draftsFromQuestions / questionsFromDrafts", () => {
  test("round-trips all three question types", () => {
    const qs: Questions = {
      ...DEFAULT_QUESTIONS,
      spam: { type: "noul", instructions: "Spam?", criteria: { true: "Unsolicited", false: "Legit" } },
      lang: { type: "choice", instructions: "Language?", criteria: { en: null, de: "German" } },
    };
    expect(questionsFromDrafts(draftsFromQuestions(qs))).toEqual(qs);
  });

  test("preserves question order", () => {
    const ids = draftsFromQuestions(DEFAULT_QUESTIONS).map((d) => d.id);
    expect(ids).toEqual(["urgent", "team", "severity"]);
  });

  test("stringifies object instructions and criteria for editing", () => {
    const [d] = draftsFromQuestions({
      q: { type: "score", instructions: { ask: "Rate" } as never, criteria: [{ lvl: 0 } as never, "high"] },
    });
    expect(d!.instructions).toBe('{"ask":"Rate"}');
    expect(d!.levels).toEqual(['{"lvl":0}', "high"]);
  });

  test("omits empty noul criteria entirely", () => {
    expect(questionsFromDrafts([draft({ id: "a" })])).toEqual({ a: { type: "noul", instructions: "Is it?" } });
  });

  test("keeps only the filled-in noul criterion", () => {
    const out = questionsFromDrafts([draft({ id: "a", noulTrue: "yes!" })]);
    expect(out.a).toEqual({ type: "noul", instructions: "Is it?", criteria: { true: "yes!" } });
  });

  test("trims ids and option keys, drops blank options, maps empty descriptions to null", () => {
    const out = questionsFromDrafts([
      draft({
        id: "  pick ",
        type: "choice",
        options: [
          { key: " x ", desc: "the x" },
          { key: "y", desc: "  " },
          { key: "  ", desc: "ignored" },
        ],
      }),
    ]);
    expect(out).toEqual({ pick: { type: "choice", instructions: "Is it?", criteria: { x: "the x", y: null } } });
  });

  test("skips drafts with no id", () => {
    expect(questionsFromDrafts([draft({ id: "  " })])).toEqual({});
  });

  test("only emits fields for the selected type", () => {
    const out = questionsFromDrafts([draft({ id: "s", type: "score", noulTrue: "stale", levels: ["lo", "hi"] })]);
    expect(out.s).toEqual({ type: "score", instructions: "Is it?", criteria: ["lo", "hi"] });
  });
});

describe("validateDrafts", () => {
  test("accepts the default questions", () => {
    expect(validateDrafts(draftsFromQuestions(DEFAULT_QUESTIONS))).toEqual([]);
  });

  test("requires at least one question", () => {
    expect(validateDrafts([])).toContain("Add at least one question.");
  });

  test("caps at 64 questions", () => {
    const many = Array.from({ length: 65 }, (_, i) => draft({ id: `q${i}` }));
    expect(validateDrafts(many)).toContain("Max 64 questions.");
    expect(validateDrafts(many.slice(0, 64))).toEqual([]);
  });

  test("rejects missing, malformed, too long, and duplicate ids", () => {
    expect(validateDrafts([draft({ id: "" })])).toContain("A question is missing an id.");
    expect(validateDrafts([draft({ id: "has space" })])[0]).toContain("ids may only use");
    expect(validateDrafts([draft({ id: "x".repeat(101) })])[0]).toContain("ids may only use");
    expect(validateDrafts([draft({ id: "ok_id.v-1" })])).toEqual([]);
    expect(validateDrafts([draft({ id: "a" }), draft({ id: "a" })])).toContain('Duplicate id "a".');
  });

  test("requires instructions", () => {
    expect(validateDrafts([draft({ id: "a", instructions: "  " })])).toContain('"a": instructions are required.');
  });

  test("choice needs 2+ distinct, non-blank option keys", () => {
    const opts = (...keys: string[]) => keys.map((key) => ({ key, desc: "" }));
    const errs = (...keys: string[]) => validateDrafts([draft({ id: "c", type: "choice", options: opts(...keys) })]);
    expect(errs("a", "")).toContain('"c": choice needs at least 2 options.');
    expect(errs("a", "a")).toContain('"c": duplicate option keys.');
    expect(errs("a", "b")).toEqual([]);
  });

  test("score needs 2–10 levels", () => {
    const errs = (n: number) => validateDrafts([draft({ id: "s", type: "score", levels: Array(n).fill("l") })]);
    expect(errs(1)).toContain('"s": score needs 2–10 levels.');
    expect(errs(11)).toContain('"s": score needs 2–10 levels.');
    expect(errs(2)).toEqual([]);
    expect(errs(10)).toEqual([]);
  });

  test("ignores choice/score rules when the type is noul", () => {
    expect(validateDrafts([draft({ id: "n", options: [], levels: [] })])).toEqual([]);
  });
});

describe("formatting", () => {
  test("fmtUsd keeps ~3 significant digits without exponent notation", () => {
    expect(fmtUsd(0)).toBe("$0");
    expect(fmtUsd(0.0000989)).toBe("$0.0000989");
    expect(fmtUsd(0.000412)).toBe("$0.000412");
    expect(fmtUsd(0.0989)).toBe("$0.0989");
    expect(fmtUsd(1.5)).toBe("$1.5000");
  });

  test("fmtMs switches to seconds at 1000 ms", () => {
    expect(fmtMs(734.2)).toBe("734 ms");
    expect(fmtMs(999.4)).toBe("999 ms");
    expect(fmtMs(1000)).toBe("1.00 s");
    expect(fmtMs(2345)).toBe("2.35 s");
  });

  test("pct", () => {
    expect(pct(0.9731)).toBe("97.3%");
    expect(pct(0)).toBe("0.0%");
  });

  test("argmax returns the most likely key", () => {
    expect(argmax({ "0": 0.01, "1": 0.06, "2": 0.38, "3": 0.55 })).toBe("3");
    expect(argmax({ billing: 0.5, technical: 0.3 })).toBe("billing");
  });
});

describe("dataUrlBytes", () => {
  const url = (bytes: number) => `data:image/png;base64,${Buffer.alloc(bytes, 7).toString("base64")}`;

  test("matches the decoded size for every padding case", () => {
    for (const n of [0, 1, 2, 3, 4, 5, 1000, 4 * 1024 * 1024]) expect(dataUrlBytes(url(n))).toBe(n);
  });
});
