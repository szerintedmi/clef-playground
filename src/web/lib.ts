import type { Question, Questions } from "../shared";

// ---------- question editor model ----------

export type QType = Question["type"];
export type QDraft = {
  uid: string;
  id: string;
  type: QType;
  instructions: string;
  noulTrue: string;
  noulFalse: string;
  options: { key: string; desc: string }[];
  levels: string[];
};

export const uid = () => Math.random().toString(36).slice(2, 10);
export const asText = (v: unknown) => (v == null ? "" : typeof v === "string" ? v : JSON.stringify(v));

export const blankDraft = (id: string): QDraft => ({
  uid: uid(),
  id,
  type: "noul",
  instructions: "",
  noulTrue: "",
  noulFalse: "",
  options: [
    { key: "a", desc: "" },
    { key: "b", desc: "" },
  ],
  levels: ["Low", "Medium", "High"],
});

export function draftsFromQuestions(qs: Questions): QDraft[] {
  return Object.entries(qs).map(([id, q]) => {
    const d = blankDraft(id);
    d.type = q.type;
    d.instructions = asText(q.instructions);
    if (q.type === "noul") {
      d.noulTrue = asText(q.criteria?.true);
      d.noulFalse = asText(q.criteria?.false);
    } else if (q.type === "choice") {
      d.options = Object.entries(q.criteria).map(([key, desc]) => ({ key, desc: asText(desc) }));
    } else {
      d.levels = q.criteria.map(asText);
    }
    return d;
  });
}

export function questionsFromDrafts(drafts: QDraft[]): Questions {
  const out: Questions = {};
  for (const d of drafts) {
    const id = d.id.trim();
    if (!id) continue;
    if (d.type === "noul") {
      const criteria: { true?: string; false?: string } = {};
      if (d.noulTrue.trim()) criteria.true = d.noulTrue;
      if (d.noulFalse.trim()) criteria.false = d.noulFalse;
      out[id] = { type: "noul", instructions: d.instructions, ...(Object.keys(criteria).length ? { criteria } : {}) };
    } else if (d.type === "choice") {
      const criteria: Record<string, string | null> = {};
      for (const o of d.options) if (o.key.trim()) criteria[o.key.trim()] = o.desc.trim() ? o.desc : null;
      out[id] = { type: "choice", instructions: d.instructions, criteria };
    } else {
      out[id] = { type: "score", instructions: d.instructions, criteria: d.levels };
    }
  }
  return out;
}

export function validateDrafts(drafts: QDraft[]): string[] {
  const errs: string[] = [];
  const seen = new Set<string>();
  if (!drafts.length) errs.push("Add at least one question.");
  if (drafts.length > 64) errs.push("Max 64 questions.");
  for (const d of drafts) {
    const id = d.id.trim();
    if (!id) errs.push("A question is missing an id.");
    else if (!/^[A-Za-z0-9_.-]{1,100}$/.test(id)) errs.push(`"${id}": ids may only use letters, digits, _ . -`);
    else if (seen.has(id)) errs.push(`Duplicate id "${id}".`);
    seen.add(id);
    if (!d.instructions.trim()) errs.push(`"${id || "?"}": instructions are required.`);
    if (d.type === "choice") {
      const keys = d.options.map((o) => o.key.trim()).filter(Boolean);
      if (keys.length < 2) errs.push(`"${id}": choice needs at least 2 options.`);
      if (new Set(keys).size !== keys.length) errs.push(`"${id}": duplicate option keys.`);
    }
    if (d.type === "score" && (d.levels.length < 2 || d.levels.length > 10))
      errs.push(`"${id}": score needs 2–10 levels.`);
  }
  return errs;
}

export const DEFAULT_QUESTIONS: Questions = {
  urgent: { type: "noul", instructions: "Is this support request urgent?" },
  team: {
    type: "choice",
    instructions: "Which team should handle this request?",
    criteria: {
      billing: "Payments, invoices, and refunds",
      technical: "Outages, errors, and configuration",
      sales: "Plans and upgrades",
    },
  },
  severity: {
    type: "score",
    instructions: "How severe is the customer impact?",
    criteria: ["No impact", "Minor", "Major", "Critical"],
  },
};

// ---------- formatting & limits ----------

export const fmtUsd = (n: number) => {
  if (n === 0) return "$0";
  // Keep ~3 significant digits for tiny per-run costs without switching to exponent notation.
  return `$${n.toFixed(Math.max(4, 2 - Math.floor(Math.log10(n))))}`;
};
export const fmtMs = (ms: number) => (ms >= 1000 ? `${(ms / 1000).toFixed(2)} s` : `${Math.round(ms)} ms`);
export const argmax = (probs: Record<string, number>) =>
  Object.entries(probs).reduce((best, e) => (e[1] > best[1] ? e : best), ["", -1])[0];
export const pct = (p: number) => `${(p * 100).toFixed(1)}%`;

export const MAX_IMAGES = 4;
export const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
export const MAX_TOTAL_BYTES = 8 * 1024 * 1024;
export const IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp"];
// Decoded byte size of a base64 data URL, without decoding it.
export const dataUrlBytes = (d: string) => {
  const b64 = d.slice(d.indexOf(",") + 1);
  const padding = b64.endsWith("==") ? 2 : b64.endsWith("=") ? 1 : 0;
  return Math.floor((b64.length * 3) / 4) - padding;
};
