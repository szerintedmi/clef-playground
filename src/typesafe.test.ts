import { describe, expect, test } from "bun:test";
import { needsImagesHeader, stateWithImages, toSystemOneRequest, typesafeErrorMessage } from "./typesafe";
import type { RunRequest } from "./shared";

const base: RunRequest = {
  model: "jev-1.14",
  state: "A photo from the door camera.",
  questions: { face: { type: "box", instructions: "the face in `images[0]`" } },
  images: [],
};
const refs = () => {
  let n = 0;
  return () => `ref-${++n}`;
};

describe("toSystemOneRequest", () => {
  test("passes text-only requests through unchanged", () => {
    expect(toSystemOneRequest("jev-1.13.0", { ...base, questions: {} })).toEqual({
      model: "jev-1.13.0",
      state: base.state,
      questions: {},
    });
  });

  test("moves images into assets and references them from the state", () => {
    const req = toSystemOneRequest(
      "jev-1.14.0",
      { ...base, images: ["data:image/png;base64,AAAA", "data:image/jpeg;base64,BBBB"] },
      refs(),
    );
    expect(req).toEqual({
      model: "jev-1.14.0",
      state: { text: base.state, images: ["ref-1", "ref-2"] },
      questions: base.questions,
      assets: {
        "ref-1": { type: "image", format: "png", data_base64: "AAAA" },
        "ref-2": { type: "image", format: "jpg", data_base64: "BBBB" },
      },
    });
  });

  test("uses unique references by default", () => {
    const req = toSystemOneRequest("jev-1.14.0", { ...base, images: ["data:image/png;base64,A", "data:image/png;base64,B"] });
    const keys = Object.keys(req.assets!);
    expect(new Set(keys).size).toBe(2);
    expect(req.state).toEqual({ text: base.state, images: keys });
  });

  test("rejects formats TypeSafe doesn't accept", () => {
    expect(() => toSystemOneRequest("jev-1.14.0", { ...base, images: ["data:image/webp;base64,AAAA"] })).toThrow(
      "PNG or JPEG",
    );
  });
});

describe("stateWithImages", () => {
  test("puts images next to the existing state", () => {
    expect(stateWithImages("", ["r"])).toEqual({ images: ["r"] });
    expect(stateWithImages({ camera: "front" }, ["r"])).toEqual({ camera: "front", images: ["r"] });
    expect(stateWithImages({ images: "mine" }, ["r"])).toEqual({ state: { images: "mine" }, images: ["r"] });
    expect(stateWithImages([1, 2], ["r"])).toEqual({ state: [1, 2], images: ["r"] });
    expect(stateWithImages({ a: 1 }, [])).toEqual({ a: 1 });
  });
});

describe("needsImagesHeader", () => {
  test("is set for images or box questions", () => {
    expect(needsImagesHeader(base)).toBe(true);
    expect(needsImagesHeader({ ...base, questions: { q: { type: "noul", instructions: "?" } } })).toBe(false);
    expect(needsImagesHeader({ ...base, questions: {}, images: ["data:image/png;base64,A"] })).toBe(true);
  });
});

describe("typesafeErrorMessage", () => {
  test("formats the error shapes the API returns", () => {
    expect(typesafeErrorMessage({ detail: { error_type: "authentication_error", message: "Bad key" } })).toBe(
      "[authentication_error] Bad key",
    );
    expect(typesafeErrorMessage({ detail: [{ loc: ["body", "questions"], msg: "Field required" }] })).toBe(
      "body.questions: Field required",
    );
    expect(typesafeErrorMessage({ detail: "Images are not turned on" })).toBe("Images are not turned on");
  });
});
