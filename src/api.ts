import type { Store } from "./db";
import {
  OPENAI_DECISIONS_URL,
  decisionsErrorMessage,
  fromDecisionsResponse,
  toDecisionsRequest,
  type DecisionsError,
  type DecisionsResponse,
} from "./openai";
import {
  IMAGES_HEADER,
  TYPESAFE_URL,
  isSystemOneResult,
  needsImagesHeader,
  toSystemOneRequest,
  typesafeErrorMessage,
  type TypeSafeError,
} from "./typesafe";
import { MODELS, costFor, type ClefResult, type Provider, type RunRequest, type RunResponse } from "./shared";

export type ApiConfig = {
  store: Store;
  accountId?: string;
  apiToken?: string;
  openaiApiKey?: string;
  typesafeApiKey?: string;
  // Injectable so tests can stand in for the Cloudflare / OpenAI APIs.
  fetch?: typeof fetch;
};

const badRequest = (error: string) => Response.json({ error }, { status: 400 });

const MISSING_CREDENTIALS: Record<Provider, string> = {
  cloudflare: "Missing CLOUDFLARE_ACCOUNT_ID / CLOUDFLARE_API_TOKEN in .env",
  openai: "Missing OPENAI_API_KEY in .env",
  typesafe: "Missing TYPESAFE_API_KEY in .env",
};

type Outcome = { raw: unknown; result?: ClefResult; error?: string };

const httpError = (status: number, raw: unknown) =>
  `HTTP ${status}: ${typeof raw === "string" ? raw.slice(0, 500) : JSON.stringify(raw).slice(0, 500)}`;

export function apiRoutes({ store, accountId, apiToken, openaiApiKey, typesafeApiKey, fetch: doFetch = fetch }: ApiConfig) {
  const configured: Record<Provider, boolean> = {
    cloudflare: !!(accountId && apiToken),
    openai: !!openaiApiKey,
    typesafe: !!typesafeApiKey,
  };

  async function postJson(url: string, token: string, payload: unknown, headers: Record<string, string> = {}) {
    const res = await doFetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...headers },
      body: JSON.stringify(payload),
    });
    const text = await res.text();
    try {
      return { res, raw: JSON.parse(text) as unknown };
    } catch {
      return { res, raw: text as unknown };
    }
  }

  async function callCloudflare(body: RunRequest): Promise<Outcome> {
    const payload: Record<string, unknown> = { model: body.model, state: body.state, questions: body.questions };
    if (body.images.length) payload.images = body.images;
    const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/${MODELS[body.model].id}`;
    const { res, raw } = await postJson(url, apiToken!, payload);
    const env = raw as { success?: boolean; result?: ClefResult; errors?: { code?: number; message: string }[] };
    if (res.ok && env?.success !== false && env?.result) return { raw, result: env.result };
    const error = env?.errors?.map((e) => (e.code ? `[${e.code}] ${e.message}` : e.message)).join("; ");
    return { raw, error: error || httpError(res.status, raw) };
  }

  async function callOpenAI(body: RunRequest): Promise<Outcome> {
    const { res, raw } = await postJson(OPENAI_DECISIONS_URL, openaiApiKey!, toDecisionsRequest(MODELS[body.model].id, body));
    const r = raw as Partial<DecisionsResponse & DecisionsError>;
    if (res.ok && Array.isArray(r?.answers)) return { raw, result: fromDecisionsResponse(r as DecisionsResponse) };
    return { raw, error: r?.error?.message ? decisionsErrorMessage(r.error) : httpError(res.status, raw) };
  }

  async function callTypeSafe(body: RunRequest): Promise<Outcome> {
    const headers: Record<string, string> = needsImagesHeader(body) ? { [IMAGES_HEADER]: "true" } : {};
    const { res, raw } = await postJson(TYPESAFE_URL, typesafeApiKey!, toSystemOneRequest(MODELS[body.model].id, body), headers);
    if (res.ok && isSystemOneResult(raw)) return { raw, result: raw };
    const r = raw as Partial<TypeSafeError>;
    return { raw, error: r?.detail ? typesafeErrorMessage(r as TypeSafeError) : httpError(res.status, raw) };
  }

  const CALLS: Record<Provider, (body: RunRequest) => Promise<Outcome>> = {
    cloudflare: callCloudflare,
    openai: callOpenAI,
    typesafe: callTypeSafe,
  };

  async function run(body: RunRequest): Promise<RunResponse> {
    const started = performance.now();
    let outcome: Outcome;
    try {
      outcome = await CALLS[MODELS[body.model].provider](body);
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      outcome = { raw: { error }, error };
    }
    const { raw, result, error } = outcome;
    const ok = !!result;

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
        const body = (await req.json()) as RunRequest;
        if (!(body.model in MODELS)) return badRequest(`Unknown model: ${body.model}`);
        const provider = MODELS[body.model].provider;
        if (!configured[provider]) return badRequest(MISSING_CREDENTIALS[provider]);
        if (!body.questions || !Object.keys(body.questions).length) return badRequest("Add at least one question");
        if (!MODELS[body.model].box && Object.values(body.questions).some((q) => q.type === "box"))
          return badRequest(`${body.model} does not support box questions`);
        body.images ??= [];
        return Response.json(await run(body));
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
