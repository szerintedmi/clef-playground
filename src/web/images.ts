// Browser-only image helpers: decoding and canvas downscaling of data URLs.

import { dataUrlBytes, estimateImageTokens, fitWithin } from "./lib";

export type PreparedImage = {
  url: string; // what gets sent
  width: number;
  height: number;
  bytes: number;
  tokens: number;
  origWidth: number;
  origHeight: number;
  origBytes: number;
};

const ENCODE_QUALITY = 0.92;

const blobToDataUrl = (blob: Blob) =>
  new Promise<string>((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result as string);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });

/** Downscales a data URL image to at most maxPixels (keeping its format), or passes it through if already small. */
export async function prepareImage(src: string, maxPixels: number | null): Promise<PreparedImage> {
  const blob = await (await fetch(src)).blob();
  const bitmap = await createImageBitmap(blob);
  const orig = { origWidth: bitmap.width, origHeight: bitmap.height, origBytes: dataUrlBytes(src) };
  const { width, height } = fitWithin(bitmap.width, bitmap.height, maxPixels);

  if (width === bitmap.width && height === bitmap.height) {
    bitmap.close();
    return { url: src, width, height, bytes: orig.origBytes, tokens: estimateImageTokens(width, height), ...orig };
  }

  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext("2d")!;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();
  const out = await canvas.convertToBlob({ type: blob.type || "image/png", quality: ENCODE_QUALITY });
  const url = await blobToDataUrl(out);
  return { url, width, height, bytes: out.size, tokens: estimateImageTokens(width, height), ...orig };
}
