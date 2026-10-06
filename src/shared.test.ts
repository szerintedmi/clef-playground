import { expect, test } from "bun:test";
import { MODELS, costFor } from "./shared";

test("costFor uses each model's input-token price", () => {
  expect(costFor("clef", 1_000_000)).toBeCloseTo(0.24, 12);
  expect(costFor("clef-flash", 1_000_000)).toBeCloseTo(0.09, 12);
  expect(costFor("clef", 412)).toBeCloseTo(0.00009888, 12);
  expect(costFor("clef", 0)).toBe(0);
  expect(costFor("gpt-6-luna", 1_000_000)).toBeCloseTo(0.1, 12);
  expect(costFor("gpt-6-luna", 268)).toBeCloseTo(0.0000268, 12);
});

test("model ids map to the Workers AI catalog", () => {
  expect(MODELS.clef.id).toBe("@cf/cloudflare/clef");
  expect(MODELS["clef-flash"].id).toBe("@cf/cloudflare/clef-flash");
});

test("each model belongs to a provider", () => {
  expect(MODELS.clef.provider).toBe("cloudflare");
  expect(MODELS["gpt-6-luna"]).toMatchObject({ id: "gpt-6-luna", provider: "openai" });
});
