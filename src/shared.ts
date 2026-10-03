// Types and constants shared by the server and the web UI.

export type ModelName = "clef" | "clef-flash";

export const MODELS: Record<ModelName, { id: string; label: string; usdPerMInput: number }> = {
  clef: { id: "@cf/cloudflare/clef", label: "clef (27B)", usdPerMInput: 0.24 },
  "clef-flash": { id: "@cf/cloudflare/clef-flash", label: "clef-flash (9B)", usdPerMInput: 0.09 },
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
export type Question = NoulQuestion | ChoiceQuestion | ScoreQuestion;
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
export type Answer = NoulAnswer | ChoiceAnswer | ScoreAnswer;

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
