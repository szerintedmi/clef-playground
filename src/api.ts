import type { Store } from "./db";
import { MODELS, costFor, type ClefResult, type RunRequest, type RunResponse } from "./shared";

export type ApiConfig = {
  store: Store;
  accountId?: string;
  apiToken?: string;
  // Injectable so tests can stand in for the Cloudflare API.
  fetch?: typeof fetch;
};

const badRequest = (error: string) => Response.json({ error }, { status: 400 });

export function apiRoutes({ store, accountId, apiToken, fetch: doFetch = fetch }: ApiConfig) {
  const configured = !!(accountId && apiToken);

  async function runClef(body: RunRequest): Promise<RunResponse> {
    const model = MODELS[body.model];
    const payload: Record<string, unknown> = { model: body.model, state: body.state, questions: body.questions };
    if (body.images.length) payload.images = body.images;

    const started = performance.now();
    let ok = false;
    let result: ClefResult | undefined;
    let error: string | undefined;
    let raw: unknown;

    try {
      const res = await doFetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/${model.id}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiToken}`, "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const text = await res.text();
      try {
        raw = JSON.parse(text);
      } catch {
        raw = text;
      }
      const env = raw as { success?: boolean; result?: ClefResult; errors?: { code?: number; message: string }[] };
      if (res.ok && env?.success !== false && env?.result) {
        ok = true;
        result = env.result;
      } else {
        error =
          env?.errors?.map((e) => (e.code ? `[${e.code}] ${e.message}` : e.message)).join("; ") ||
          `HTTP ${res.status}: ${typeof raw === "string" ? raw.slice(0, 500) : JSON.stringify(raw).slice(0, 500)}`;
      }
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
      raw = { error };
    }

    const latencyMs = performance.now() - started;
    const inputTokens = result?.usage?.input_tokens ?? 0;
    const outputTokens = result?.usage?.output_tokens ?? 0;
    const costUsd = costFor(body.model, inputTokens);

    const id = store.runs.insert({
      model: body.model,
      request: body,
      response: raw,
      ok,
      inputTokens,
      outputTokens,
      costUsd,
      latencyMs,
    });

    return { id, ok, result, error, latencyMs, costUsd };
  }

  return {
    "/api/config": () => Response.json({ models: MODELS, configured }),

    "/api/run": {
      POST: async (req: Request) => {
        if (!configured) return badRequest("Missing CLOUDFLARE_ACCOUNT_ID / CLOUDFLARE_API_TOKEN in .env");
        const body = (await req.json()) as RunRequest;
        if (!(body.model in MODELS)) return badRequest(`Unknown model: ${body.model}`);
        if (!body.questions || !Object.keys(body.questions).length) return badRequest("Add at least one question");
        body.images ??= [];
        return Response.json(await runClef(body));
      },
    },

    "/api/runs": {
      GET: () => Response.json(store.runs.list()),
      DELETE: () => {
        store.runs.clear();
        return Response.json({ ok: true });
      },
    },
    "/api/runs/:id": (req: Bun.BunRequest<"/api/runs/:id">) => {
      const run = store.runs.get(Number(req.params.id));
      return run ? Response.json(run) : Response.json({ error: "Not found" }, { status: 404 });
    },

    "/api/question-sets": {
      GET: () => Response.json(store.questionSets.list()),
      POST: async (req: Request) => {
        const { name, questions } = await req.json();
        if (!name?.trim()) return badRequest("Name is required");
        return Response.json(store.questionSets.save(name.trim(), questions));
      },
    },
    "/api/question-sets/:id": {
      DELETE: (req: Bun.BunRequest<"/api/question-sets/:id">) => {
        store.questionSets.remove(Number(req.params.id));
        return Response.json({ ok: true });
      },
    },

    "/api/inputs": {
      GET: () => Response.json(store.inputs.list()),
      POST: async (req: Request) => {
        const { name, state, stateIsJson, images } = await req.json();
        if (!name?.trim()) return badRequest("Name is required");
        return Response.json(store.inputs.save(name.trim(), state ?? "", !!stateIsJson, images ?? []));
      },
    },
    "/api/inputs/:id": {
      DELETE: (req: Bun.BunRequest<"/api/inputs/:id">) => {
        store.inputs.remove(Number(req.params.id));
        return Response.json({ ok: true });
      },
    },
  };
}
