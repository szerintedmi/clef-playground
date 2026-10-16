// Types and constants shared by the server and the web UI.

export type ModelName = "clef" | "clef-flash" | "gpt-6-luna" | "jev-1.14" | "jev-1.13";
export type Provider = "cloudflare" | "openai" | "typesafe";

export type ModelInfo = { id: string; label: string; provider: Provider; usdPerMInput: number; box?: boolean };

export const MODELS: Record<ModelName, ModelInfo> = {
  clef: { id: "@cf/cloudflare/clef", label: "clef (27B)", provider: "cloudflare", usdPerMInput: 0.24 },
  "clef-flash": { id: "@cf/cloudflare/clef-flash", label: "clef-flash (9B)", provider: "cloudflare", usdPerMInput: 0.09 },
  // OpenAI Decisions API; bills input tokens only (no cache or output-token charges).
  "gpt-6-luna": { id: "gpt-6-luna", label: "gpt-6-luna (OpenAI)", provider: "openai", usdPerMInput: 0.1 },
  // TypeSafe System One; bills input tokens only. Box questions need Jev 1.14 (currently `jev-preview`).
  "jev-1.14": { id: "jev-1.14.0", label: "jev-1.14 (TypeSafe)", provider: "typesafe", usdPerMInput: 0.042, box: true },
  "jev-1.13": { id: "jev-1.13.0", label: "jev-1.13 (TypeSafe)", provider: "typesafe", usdPerMInput: 0.042 },
};

export type NoulQuestion = {
  type: "noul";
  instructions: string;
  criteria?: { true?: string; false?: string };
};
export type ChoiceQuestion = {
  type: "choice";
  instructions: string;
  criteria: Record<string, string | null>;
};
export type ScoreQuestion = {
  type: "score";
  instructions: string;
  criteria: string[];
};
// TypeSafe only (Jev 1.14+): where something is in an image. Takes no criteria.
export type BoxQuestion = {
  type: "box";
  instructions: string;
};
export type Question = NoulQuestion | ChoiceQuestion | ScoreQuestion | BoxQuestion;
export type Questions = Record<string, Question>;

export type NoulAnswer = { type: "noul"; noul: number };
export type ChoiceAnswer = {
  type: "choice";
  choice: string;
  probabilities: Record<string, number>;
  confidence: number;
};
export type ScoreAnswer = {
  type: "score";
  score: number;
  legend: Record<string, unknown>;
  probabilities: Record<string, number>;
  confidence: number;
};
// Edges as fractions of the image's width (left/right) and height (top/bottom), from the top-left corner.
export type BoxEdges = { top: number; bottom: number; left: number; right: number };
export type BoxAnswer = { type: "box"; box: BoxEdges; confidence: number };
export type Answer = NoulAnswer | ChoiceAnswer | ScoreAnswer | BoxAnswer;

export type ClefResult = {
  model: string;
  answers: Record<string, Answer>;
  usage: { input_tokens: number; output_tokens: number };
};

export type RunRequest = {
  model: ModelName;
  state: unknown;
  questions: Questions;
  images: string[]; // data URLs
};

export type RunResponse = {
  id: number;
  ok: boolean;
  result?: ClefResult;
  error?: string;
  latencyMs: number;
  costUsd: number;
};

export type QuestionSet = { id: number; name: string; questions: Questions; updatedAt: string };
export type SavedInput = {
  id: number;
  name: string;
  state: string;
  stateIsJson: boolean;
  images: string[];
  updatedAt: string;
};
export type RunRecord = {
  id: number;
  model: ModelName;
  request: RunRequest;
  response: unknown;
  ok: boolean;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  latencyMs: number;
  createdAt: string;
};

export function costFor(model: ModelName, inputTokens: number): number {
  return (inputTokens / 1_000_000) * MODELS[model].usdPerMInput;
}
