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

// ---------- image downscaling ----------

// Clef's image processor (Qwen2VLImageProcessor, from the model's processor_config.json) resizes every image to
// fit between these pixel counts, in 32×32-pixel blocks (16px patches merged 2×2), one token per block.
export const MIN_IMAGE_PIXELS = 65_536;
export const MAX_IMAGE_PIXELS = 16_777_216;
const TOKEN_BLOCK = 32;

// Originals can be larger than the API limits since they are usually downscaled before sending.
export const MAX_ORIGINAL_BYTES = 32 * 1024 * 1024;

export const DOWNSCALE_OPTIONS: { label: string; maxPixels: number | null }[] = [
  { label: "Original", maxPixels: null },
  { label: "8 MP", maxPixels: 8 * 1024 * 1024 },
  { label: "4 MP", maxPixels: 4 * 1024 * 1024 },
  { label: "2 MP", maxPixels: 2 * 1024 * 1024 },
  { label: "1 MP", maxPixels: 1024 * 1024 },
  { label: "0.5 MP", maxPixels: 512 * 1024 },
  { label: "0.25 MP", maxPixels: 256 * 1024 },
];
export const DEFAULT_MAX_PIXELS = 1024 * 1024;

/** Largest size with the same aspect ratio that fits in maxPixels. Never upscales. */
export function fitWithin(width: number, height: number, maxPixels: number | null) {
  if (maxPixels == null || width * height <= maxPixels) return { width, height };
  const scale = Math.sqrt(maxPixels / (width * height));
  const w = Math.floor(width * scale);
  const h = Math.floor(height * scale);
  // For extreme aspect ratios one side can round to 0; pin it to 1px and give the budget to the other side.
  if (h < 1) return { width: Math.min(width, Math.floor(maxPixels)), height: 1 };
  if (w < 1) return { width: 1, height: Math.min(height, Math.floor(maxPixels)) };
  return { width: w, height: h };
}

/** Estimated image tokens, mirroring Qwen2-VL's smart_resize. Cloudflare's hosted preprocessing may differ. */
export function estimateImageTokens(width: number, height: number) {
  const f = TOKEN_BLOCK;
  let h = Math.max(f, Math.round(height / f) * f);
  let w = Math.max(f, Math.round(width / f) * f);
  if (h * w > MAX_IMAGE_PIXELS) {
    const beta = Math.sqrt((height * width) / MAX_IMAGE_PIXELS);
    h = Math.max(f, Math.floor(height / beta / f) * f);
    w = Math.max(f, Math.floor(width / beta / f) * f);
  } else if (h * w < MIN_IMAGE_PIXELS) {
    const beta = Math.sqrt(MIN_IMAGE_PIXELS / (height * width));
    h = Math.ceil((height * beta) / f) * f;
    w = Math.ceil((width * beta) / f) * f;
  }
  return (h / f) * (w / f);
}

/**
 * Dropdown label for a downscale option: the resolution it produces for the given image (e.g. the largest
 * attached one), or the square equivalent when there is no image.
 */
export function downscaleLabel(option: { label: string; maxPixels: number | null }, image?: { width: number; height: number }) {
  if (image) {
    const { width, height } = fitWithin(image.width, image.height, option.maxPixels);
    return `${option.label} · ${width}×${height}`;
  }
  if (option.maxPixels == null) return option.label;
  const side = Math.floor(Math.sqrt(option.maxPixels));
  return `${option.label} · ${side}×${side}`;
}

export type SentImage = { width: number; height: number; bytes: number };

/** API limits, checked against the images that will actually be sent. */
export function validateSentImages(images: SentImage[]): string[] {
  const errs: string[] = [];
  images.forEach((img, i) => {
    if (img.bytes > MAX_IMAGE_BYTES) errs.push(`Image ${i + 1} is ${fmtBytes(img.bytes)}; max 4 MiB each. Pick a smaller downscale.`);
    if (img.width * img.height > MAX_IMAGE_PIXELS)
      errs.push(`Image ${i + 1} is ${fmtMp(img.width * img.height)}; max 16 MP. Pick a downscale.`);
  });
  const total = images.reduce((s, i) => s + i.bytes, 0);
  if (total > MAX_TOTAL_BYTES) errs.push(`Images total ${fmtBytes(total)}; max 8 MiB. Pick a smaller downscale.`);
  return errs;
}

export const fmtBytes = (n: number) =>
  n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MiB` : `${Math.max(1, Math.round(n / 1024))} KB`;
export const fmtMp = (pixels: number) => `${(pixels / 1024 / 1024).toFixed(1)} MP`;
export const fmtTokens = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
