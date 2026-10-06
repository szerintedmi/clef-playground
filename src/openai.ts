// Translation between the playground's Clef-shaped requests/results and OpenAI's Decisions API
// (https://developers.openai.com/api/docs/guides/decisions). Pure functions, so the web UI can use them too.

import type { Answer, ClefResult, Question, RunRequest } from "./shared";

export const OPENAI_DECISIONS_URL = "https://api.openai.com/v1/decisions";

type ContentPart = { type: "input_text"; text: string } | { type: "input_image"; image_url: string };

export type DecisionQuestion =
  | { type: "predicate"; name: string; instructions: string }
  | { type: "choice"; name: string; instructions: string; choices: { value: string; description?: string }[] }
  | { type: "score"; name: string; instructions: string; levels: { label: string; description?: string }[] };

export type DecisionsRequest = {
  model: string;
  input: { role: "user"; content: ContentPart[] }[];
  questions: DecisionQuestion[];
};

type Probability = { value: string | number; label?: string; probability: number };
export type DecisionAnswer =
  | { type: "predicate"; name: string; probability: number }
  | { type: "choice"; name: string; choice: string; probabilities: Probability[]; confidence: number }
  | { type: "score"; name: string; score: number; probabilities: Probability[]; confidence: number };

export type DecisionsResponse = {
  model: string;
  answers: DecisionAnswer[];
  usage: { input_tokens: number; output_tokens: number; total_tokens?: number };
};

export type DecisionsError = { error: { message: string; type?: string; code?: string | null } };

function toDecisionQuestion(name: string, q: Question): DecisionQuestion {
  if (q.type === "noul") {
    // Predicates have no criteria field, so Clef's yes/no criteria are folded into the instructions.
    const notes = [
      q.criteria?.true?.trim() && `Yes means: ${q.criteria.true.trim()}`,
      q.criteria?.false?.trim() && `No means: ${q.criteria.false.trim()}`,
    ].filter(Boolean);
    return { type: "predicate", name, instructions: [q.instructions, ...notes].join("\n") };
  }
  if (q.type === "choice") {
    return {
      type: "choice",
      name,
      instructions: q.instructions,
      choices: Object.entries(q.criteria).map(([value, description]) => (description ? { value, description } : { value })),
    };
  }
  return { type: "score", name, instructions: q.instructions, levels: q.criteria.map((label) => ({ label })) };
}

export function toDecisionsRequest(model: string, body: RunRequest): DecisionsRequest {
  const text = typeof body.state === "string" ? body.state : JSON.stringify(body.state);
  const content: ContentPart[] = [
    ...(text || !body.images.length ? [{ type: "input_text" as const, text }] : []),
    ...body.images.map((image_url) => ({ type: "input_image" as const, image_url })),
  ];
  return {
    model,
    input: [{ role: "user", content }],
    questions: Object.entries(body.questions).map(([name, q]) => toDecisionQuestion(name, q)),
  };
}

function toAnswer(a: DecisionAnswer): Answer {
  if (a.type === "predicate") return { type: "noul", noul: a.probability };
  const probabilities = Object.fromEntries(a.probabilities.map((p) => [String(p.value), p.probability]));
  if (a.type === "choice") return { type: "choice", choice: a.choice, probabilities, confidence: a.confidence };
  const legend = Object.fromEntries(a.probabilities.map((p) => [String(p.value), p.label ?? ""]));
  return { type: "score", score: a.score, legend, probabilities, confidence: a.confidence };
}

/** Normalizes a Decisions API response into the playground's Clef result shape. */
export function fromDecisionsResponse(r: DecisionsResponse): ClefResult {
  return {
    model: r.model,
    answers: Object.fromEntries(r.answers.map((a) => [a.name, toAnswer(a)])),
    usage: { input_tokens: r.usage?.input_tokens ?? 0, output_tokens: r.usage?.output_tokens ?? 0 },
  };
}

export const decisionsErrorMessage = (e: DecisionsError["error"]) => (e.code ? `[${e.code}] ${e.message}` : e.message);
