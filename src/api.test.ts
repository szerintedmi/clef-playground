import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { apiRoutes } from "./api";
import { createStore, type Store } from "./db";
import { costFor, type ClefResult, type RunRequest, type RunResponse } from "./shared";

const RESULT: ClefResult = {
  model: "clef",
  usage: { input_tokens: 412, output_tokens: 9 },
  answers: { urgent: { type: "noul", noul: 0.97 } },
};

const REQUEST: RunRequest = {
  model: "clef",
  state: "Checkout is down",
  questions: { urgent: { type: "noul", instructions: "Urgent?" } },
  images: [],
};

let store: Store;
let server: ReturnType<typeof Bun.serve>;
let cloudflare: ReturnType<typeof mock<(url: string, init: RequestInit) => Promise<Response>>>;

// Starts the API on a random port with a fake Cloudflare backend.
function start(opts: { configured?: boolean } = {}) {
  const configured = opts.configured ?? true;
  server = Bun.serve({
    port: 0,
    routes: apiRoutes({
      store,
      accountId: configured ? "acct123" : undefined,
      apiToken: configured ? "tok" : undefined,
      fetch: cloudflare as unknown as typeof fetch,
    }),
  });
}

const call = async (path: string, init?: RequestInit) => {
  const res = await fetch(new URL(path, server.url), init);
  return { status: res.status, body: (await res.json()) as any };
};
const post = (path: string, body: unknown) => call(path, { method: "POST", body: JSON.stringify(body) });

beforeEach(() => {
  store = createStore(":memory:");
  cloudflare = mock(async () => Response.json({ success: true, errors: [], messages: [], result: RESULT }));
});
afterEach(() => {
  server?.stop(true);
  store.close();
});

describe("/api/run", () => {
  test("forwards the request to the right Cloudflare endpoint", async () => {
    start();
    await post("/api/run", { ...REQUEST, model: "clef-flash" });

    expect(cloudflare).toHaveBeenCalledTimes(1);
    const [url, init] = cloudflare.mock.calls[0]!;
    expect(url).toBe("https://api.cloudflare.com/client/v4/accounts/acct123/ai/run/@cf/cloudflare/clef-flash");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer tok");
    expect(JSON.parse(init.body as string)).toEqual({
      model: "clef-flash",
      state: REQUEST.state,
      questions: REQUEST.questions,
    });
  });

  test("includes images only when attached", async () => {
    start();
    await post("/api/run", { ...REQUEST, images: ["data:image/png;base64,AAAA"] });
    expect(JSON.parse(cloudflare.mock.calls[0]![1].body as string).images).toEqual(["data:image/png;base64,AAAA"]);
  });

  test("passes structured state through as JSON, not a string", async () => {
    start();
    await post("/api/run", { ...REQUEST, state: { records: [1, 2] } });
    expect(JSON.parse(cloudflare.mock.calls[0]![1].body as string).state).toEqual({ records: [1, 2] });
  });

  test("returns the result with cost and latency, and records the run", async () => {
    start();
    const { status, body } = await post("/api/run", REQUEST);
    const res = body as RunResponse;

    expect(status).toBe(200);
    expect(res.ok).toBe(true);
    expect(res.result).toEqual(RESULT);
    expect(res.costUsd).toBeCloseTo(costFor("clef", 412), 12);
    expect(res.latencyMs).toBeGreaterThanOrEqual(0);

    const saved = store.runs.get(res.id)!;
    expect(saved).toMatchObject({ ok: true, model: "clef", inputTokens: 412, outputTokens: 9, request: REQUEST });
    expect(saved.costUsd).toBeCloseTo(res.costUsd, 12);
  });

  test("defaults missing images to an empty list", async () => {
    start();
    const { images, ...noImages } = REQUEST;
    const { body } = await post("/api/run", noImages);
    expect(body.ok).toBe(true);
    expect(store.runs.get(body.id)!.request.images).toEqual([]);
  });

  test("surfaces Cloudflare API errors and still records the run", async () => {
    cloudflare.mockImplementation(async () =>
      Response.json(
        { success: false, result: null, errors: [{ code: 10000, message: "Authentication error" }], messages: [] },
        { status: 401 },
      ),
    );
    start();
    const { status, body } = await post("/api/run", REQUEST);

    expect(status).toBe(200);
    expect(body).toMatchObject({ ok: false, error: "[10000] Authentication error", costUsd: 0 });
    expect(store.runs.get(body.id)).toMatchObject({ ok: false, inputTokens: 0 });
  });

  test("reports non-JSON error bodies with the HTTP status", async () => {
    cloudflare.mockImplementation(async () => new Response("Bad Gateway", { status: 502 }));
    start();
    const { body } = await post("/api/run", REQUEST);
    expect(body.error).toBe("HTTP 502: Bad Gateway");
  });

  test("reports network failures", async () => {
    cloudflare.mockImplementation(async () => {
      throw new Error("connect ECONNREFUSED");
    });
    start();
    const { body } = await post("/api/run", REQUEST);
    expect(body).toMatchObject({ ok: false, error: "connect ECONNREFUSED" });
    expect(store.runs.list()).toHaveLength(1);
  });

  test("rejects unknown models and empty question sets without calling Cloudflare", async () => {
    start();
    expect((await post("/api/run", { ...REQUEST, model: "gpt" })).status).toBe(400);
    expect((await post("/api/run", { ...REQUEST, questions: {} })).status).toBe(400);
    expect(cloudflare).not.toHaveBeenCalled();
  });

  test("refuses to run without credentials", async () => {
    start({ configured: false });
    const { status, body } = await post("/api/run", REQUEST);
    expect(status).toBe(400);
    expect(body.error).toContain("CLOUDFLARE_ACCOUNT_ID");
    expect(cloudflare).not.toHaveBeenCalled();
  });
});

describe("/api/config", () => {
  test("reports whether credentials are configured", async () => {
    start({ configured: false });
    const { body } = await call("/api/config");
    expect(body.configured).toBe(false);
    expect(Object.keys(body.models)).toEqual(["clef", "clef-flash"]);
  });
});

describe("/api/runs", () => {
  test("lists, fetches, and clears history", async () => {
    start();
    const { body: run } = await post("/api/run", REQUEST);

    expect((await call("/api/runs")).body.map((r: { id: number }) => r.id)).toEqual([run.id]);
    expect((await call(`/api/runs/${run.id}`)).body.id).toBe(run.id);
    expect((await call("/api/runs/999")).status).toBe(404);

    await call("/api/runs", { method: "DELETE" });
    expect((await call("/api/runs")).body).toEqual([]);
  });
});

describe("saved question sets and inputs", () => {
  test("question sets: save trims the name, list, delete", async () => {
    start();
    const { body: saved } = await post("/api/question-sets", { name: "  triage ", questions: REQUEST.questions });
    expect(saved.name).toBe("triage");
    expect((await call("/api/question-sets")).body).toHaveLength(1);

    await call(`/api/question-sets/${saved.id}`, { method: "DELETE" });
    expect((await call("/api/question-sets")).body).toEqual([]);
  });

  test("inputs: save with defaults, list, delete", async () => {
    start();
    const { body: saved } = await post("/api/inputs", { name: "ticket" });
    expect(saved).toMatchObject({ name: "ticket", state: "", stateIsJson: false, images: [] });

    await call(`/api/inputs/${saved.id}`, { method: "DELETE" });
    expect((await call("/api/inputs")).body).toEqual([]);
  });

  test("a name is required", async () => {
    start();
    expect((await post("/api/question-sets", { name: " ", questions: {} })).status).toBe(400);
    expect((await post("/api/inputs", { state: "x" })).status).toBe(400);
  });
});
