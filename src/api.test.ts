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

const DECISIONS = {
  model: "gpt-6-luna",
  answers: [{ type: "predicate", name: "urgent", probability: 0.88 }],
  usage: { input_tokens: 268, input_tokens_details: { cached_tokens: 0 }, output_tokens: 0, total_tokens: 268 },
};

// Starts the API on a random port with a fake Cloudflare / OpenAI backend.
function start(opts: { configured?: boolean; openai?: boolean; typesafe?: boolean } = {}) {
  const configured = opts.configured ?? true;
  server = Bun.serve({
    port: 0,
    routes: apiRoutes({
      store,
      accountId: configured ? "acct123" : undefined,
      apiToken: configured ? "tok" : undefined,
      openaiApiKey: opts.openai ?? true ? "sk-test" : undefined,
      typesafeApiKey: opts.typesafe ?? true ? "ts-test" : undefined,
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

describe("/api/run with an OpenAI model", () => {
  const OPENAI_REQUEST: RunRequest = { ...REQUEST, model: "gpt-6-luna" };

  test("sends a Decisions API request and normalizes the answers", async () => {
    cloudflare.mockImplementation(async () => Response.json(DECISIONS));
    start({ configured: false });
    const { body } = await post("/api/run", { ...OPENAI_REQUEST, images: ["data:image/png;base64,AAAA"] });

    const [url, init] = cloudflare.mock.calls[0]!;
    expect(url).toBe("https://api.openai.com/v1/decisions");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer sk-test");
    expect(JSON.parse(init.body as string)).toEqual({
      model: "gpt-6-luna",
      input: [
        {
          role: "user",
          content: [
            { type: "input_text", text: "Checkout is down" },
            { type: "input_image", image_url: "data:image/png;base64,AAAA" },
          ],
        },
      ],
      questions: [{ type: "predicate", name: "urgent", instructions: "Urgent?" }],
    });

    expect(body.ok).toBe(true);
    expect(body.result).toEqual({
      model: "gpt-6-luna",
      answers: { urgent: { type: "noul", noul: 0.88 } },
      usage: { input_tokens: 268, output_tokens: 0 },
    });
    expect(body.costUsd).toBeCloseTo(costFor("gpt-6-luna", 268), 12);
  });

  test("records the run with tokens and cost", async () => {
    cloudflare.mockImplementation(async () => Response.json(DECISIONS));
    start();
    const { body } = await post("/api/run", OPENAI_REQUEST);
    const saved = store.runs.get(body.id)!;
    expect(saved).toMatchObject({ ok: true, model: "gpt-6-luna", inputTokens: 268, outputTokens: 0, response: DECISIONS });
    expect(saved.costUsd).toBeCloseTo(0.0000268, 12);
  });

  test("surfaces OpenAI errors", async () => {
    cloudflare.mockImplementation(async () =>
      Response.json(
        { error: { message: "Incorrect API key provided", type: "invalid_request_error", code: "invalid_api_key" } },
        { status: 401 },
      ),
    );
    start();
    const { body } = await post("/api/run", OPENAI_REQUEST);
    expect(body).toMatchObject({ ok: false, error: "[invalid_api_key] Incorrect API key provided", costUsd: 0 });
    expect(store.runs.get(body.id)).toMatchObject({ ok: false, inputTokens: 0 });
  });

  test("requires OPENAI_API_KEY only for OpenAI models", async () => {
    start({ openai: false });
    const { status, body } = await post("/api/run", OPENAI_REQUEST);
    expect(status).toBe(400);
    expect(body.error).toContain("OPENAI_API_KEY");
    expect(cloudflare).not.toHaveBeenCalled();
    expect((await post("/api/run", REQUEST)).body.ok).toBe(true);
  });
});

describe("/api/run with a TypeSafe model", () => {
  const BOX_REQUEST: RunRequest = {
    model: "jev-1.14",
    state: "",
    questions: { face: { type: "box", instructions: "the face in `images[0]`" } },
    images: ["data:image/jpeg;base64,AAAA"],
  };
  const SYSTEM_ONE = {
    model: "jev-1.14.0",
    answers: { face: { type: "box", box: { top: 0.2, bottom: 0.6, left: 0.3, right: 0.7 }, confidence: 0.9 } },
    usage: { input_tokens: 1200, output_tokens: 21 },
  };

  test("sends images as assets with the images header and returns the answers as-is", async () => {
    cloudflare.mockImplementation(async () => Response.json(SYSTEM_ONE));
    start({ configured: false });
    const { body } = await post("/api/run", BOX_REQUEST);

    const [url, init] = cloudflare.mock.calls[0]!;
    expect(url).toBe("https://api.typesafe.ai/v1/systemone");
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer ts-test");
    expect(headers["TypeSafe-Danger-Zone-Images"]).toBe("true");
    const sent = JSON.parse(init.body as string);
    const [ref] = Object.keys(sent.assets);
    expect(sent).toEqual({
      model: "jev-1.14.0",
      state: { images: [ref] },
      questions: BOX_REQUEST.questions,
      assets: { [ref!]: { type: "image", format: "jpg", data_base64: "AAAA" } },
    });

    expect(body).toMatchObject({ ok: true, result: SYSTEM_ONE });
    expect(body.costUsd).toBeCloseTo(costFor("jev-1.14", 1200), 12);
    expect(store.runs.get(body.id)).toMatchObject({ ok: true, inputTokens: 1200, response: SYSTEM_ONE });
  });

  test("omits the images header for text-only requests", async () => {
    cloudflare.mockImplementation(async () => Response.json({ ...SYSTEM_ONE, answers: RESULT.answers }));
    start();
    await post("/api/run", { ...REQUEST, model: "jev-1.13" });
    const init = cloudflare.mock.calls[0]![1];
    expect((init.headers as Record<string, string>)["TypeSafe-Danger-Zone-Images"]).toBeUndefined();
    expect(JSON.parse(init.body as string)).toEqual({ model: "jev-1.13.0", state: REQUEST.state, questions: REQUEST.questions });
  });

  test("rejects box questions for models without box support", async () => {
    start();
    for (const model of ["jev-1.13", "clef", "gpt-6-luna"]) {
      const { status, body } = await post("/api/run", { ...BOX_REQUEST, model });
      expect(status).toBe(400);
      expect(body.error).toContain("box");
    }
    expect(cloudflare).not.toHaveBeenCalled();
  });

  test("surfaces TypeSafe errors", async () => {
    cloudflare.mockImplementation(async () =>
      Response.json({ detail: { error_type: "authentication_error", message: "Bad key" } }, { status: 401 }),
    );
    start();
    const { body } = await post("/api/run", BOX_REQUEST);
    expect(body).toMatchObject({ ok: false, error: "[authentication_error] Bad key", costUsd: 0 });
  });

  test("requires TYPESAFE_API_KEY", async () => {
    start({ typesafe: false });
    const { status, body } = await post("/api/run", BOX_REQUEST);
    expect(status).toBe(400);
    expect(body.error).toContain("TYPESAFE_API_KEY");
  });
});

describe("/api/config", () => {
  test("reports which providers have credentials", async () => {
    start({ configured: false });
    const { body } = await call("/api/config");
    expect(body.configured).toEqual({ cloudflare: false, openai: true, typesafe: true });
    expect(Object.keys(body.models)).toEqual(["clef", "clef-flash", "gpt-6-luna", "jev-1.14", "jev-1.13"]);
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
