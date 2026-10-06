import { describe, expect, test } from "bun:test";
import { decisionsErrorMessage, fromDecisionsResponse, toDecisionsRequest, type DecisionsResponse } from "./openai";
import type { RunRequest } from "./shared";

const base: RunRequest = { model: "gpt-6-luna", state: "I was charged twice.", questions: {}, images: [] };

describe("toDecisionsRequest", () => {
  test("maps noul, choice and score questions", () => {
    const req = toDecisionsRequest("gpt-6-luna", {
      ...base,
      questions: {
        refund: { type: "noul", instructions: "Wants money back?", criteria: { true: "asks for a refund", false: " " } },
        team: { type: "choice", instructions: "Which team?", criteria: { billing: "Payments", tech: null } },
        severity: { type: "score", instructions: "How severe?", criteria: ["Low", "High"] },
      },
    });
    expect(req.questions).toEqual([
      { type: "predicate", name: "refund", instructions: "Wants money back?\nYes means: asks for a refund" },
      {
        type: "choice",
        name: "team",
        instructions: "Which team?",
        choices: [{ value: "billing", description: "Payments" }, { value: "tech" }],
      },
      { type: "score", name: "severity", instructions: "How severe?", levels: [{ label: "Low" }, { label: "High" }] },
    ]);
  });

  test("sends structured state as JSON text", () => {
    const req = toDecisionsRequest("gpt-6-luna", { ...base, state: { records: [1, 2] } });
    expect(req.input[0]!.content).toEqual([{ type: "input_text", text: '{"records":[1,2]}' }]);
  });

  test("sends images as input_image parts, dropping empty text", () => {
    const req = toDecisionsRequest("gpt-6-luna", { ...base, state: "", images: ["data:image/png;base64,AAAA"] });
    expect(req.input[0]!.content).toEqual([{ type: "input_image", image_url: "data:image/png;base64,AAAA" }]);
  });
});

describe("fromDecisionsResponse", () => {
  test("converts answers to the Clef shape keyed by name", () => {
    const res: DecisionsResponse = {
      model: "gpt-6-luna",
      answers: [
        { type: "predicate", name: "refund", probability: 0.72 },
        {
          type: "choice",
          name: "team",
          choice: "billing",
          probabilities: [
            { value: "billing", probability: 0.95 },
            { value: "tech", probability: 0.05 },
          ],
          confidence: 0.93,
        },
        {
          type: "score",
          name: "severity",
          score: 0.41,
          probabilities: [
            { value: 0, label: "Low", probability: 0.59 },
            { value: 1, label: "High", probability: 0.41 },
          ],
          confidence: 0.18,
        },
      ],
      usage: { input_tokens: 268, output_tokens: 0, total_tokens: 268 },
    };
    expect(fromDecisionsResponse(res)).toEqual({
      model: "gpt-6-luna",
      answers: {
        refund: { type: "noul", noul: 0.72 },
        team: { type: "choice", choice: "billing", probabilities: { billing: 0.95, tech: 0.05 }, confidence: 0.93 },
        severity: {
          type: "score",
          score: 0.41,
          legend: { "0": "Low", "1": "High" },
          probabilities: { "0": 0.59, "1": 0.41 },
          confidence: 0.18,
        },
      },
      usage: { input_tokens: 268, output_tokens: 0 },
    });
  });

  test("formats errors with their code", () => {
    expect(decisionsErrorMessage({ message: "nope", code: "model_not_found" })).toBe("[model_not_found] nope");
    expect(decisionsErrorMessage({ message: "nope" })).toBe("nope");
  });
});
