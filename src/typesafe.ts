// Translation between the playground's requests and TypeSafe's System One API (https://docs.typesafe.ai/api).
// Questions and answers already share Clef's shape; only images differ: they go in a top-level `assets` map and
// are referenced from the state by key. Pure functions, so the web UI can use them too.

import type { ClefResult, RunRequest } from "./shared";

export const TYPESAFE_URL = "https://api.typesafe.ai/v1/systemone";
// Images and Box questions are opt-in per request.
export const IMAGES_HEADER = "TypeSafe-Danger-Zone-Images";

export type TypeSafeAsset = { type: "image"; format: "png" | "jpg"; data_base64: string };

export type SystemOneRequest = {
  model: string;
  state: unknown;
  questions: RunRequest["questions"];
  assets?: Record<string, TypeSafeAsset>;
};

export type TypeSafeError = { detail: string | { error_type?: string; message?: string } | { loc?: unknown[]; msg: string }[] };

const FORMATS: Record<string, TypeSafeAsset["format"]> = { "image/png": "png", "image/jpeg": "jpg", "image/jpg": "jpg" };

// References are matched as plain text anywhere in the request, so they must not occur by accident.
const newRef = () => `img-${crypto.randomUUID()}`;

/** A data URL as a TypeSafe asset. Anything else (e.g. the UI's preview placeholders) is passed through as-is. */
function toAsset(image: string): TypeSafeAsset {
  const m = /^data:([^;,]+);base64,(.*)$/s.exec(image);
  if (!m) return { type: "image", format: "png", data_base64: image };
  const format = FORMATS[m[1]!.toLowerCase()];
  if (!format) throw new Error(`TypeSafe accepts PNG or JPEG images only, not ${m[1]}`);
  return { type: "image", format, data_base64: m[2]! };
}

/**
 * Where the images go in the state, so questions can refer to them as `images[0]`, `images[1]`, …: a text state
 * becomes {text, images}, an object state gets an `images` field, and anything else is wrapped as {state, images}.
 */
export function stateWithImages(state: unknown, refs: string[]): unknown {
  if (!refs.length) return state;
  if (typeof state === "string") return state.trim() ? { text: state, images: refs } : { images: refs };
  if (state && typeof state === "object" && !Array.isArray(state) && !("images" in state)) return { ...state, images: refs };
  return { state, images: refs };
}

export function toSystemOneRequest(model: string, body: RunRequest, ref: () => string = newRef): SystemOneRequest {
  const refs = body.images.map(() => ref());
  const req: SystemOneRequest = { model, state: stateWithImages(body.state, refs), questions: body.questions };
  if (refs.length) req.assets = Object.fromEntries(refs.map((r, i) => [r, toAsset(body.images[i]!)]));
  return req;
}

export const needsImagesHeader = (body: RunRequest) =>
  body.images.length > 0 || Object.values(body.questions).some((q) => q.type === "box");

export function typesafeErrorMessage(e: TypeSafeError): string {
  const d = e.detail;
  if (typeof d === "string") return d;
  if (Array.isArray(d)) return d.map((x) => (x.loc?.length ? `${x.loc.join(".")}: ${x.msg}` : x.msg)).join("; ");
  return d?.error_type ? `[${d.error_type}] ${d.message}` : (d?.message ?? JSON.stringify(d));
}

export const isSystemOneResult = (r: unknown): r is ClefResult =>
  !!r && typeof r === "object" && "answers" in r && typeof (r as ClefResult).answers === "object";
