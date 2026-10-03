import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  MODELS,
  type Answer,
  type ModelName,
  type Question,
  type QuestionSet,
  type Questions,
  type RunRecord,
  type RunRequest,
  type RunResponse,
  type SavedInput,
} from "../shared";
import {
  DEFAULT_MAX_PIXELS,
  DEFAULT_QUESTIONS,
  DOWNSCALE_OPTIONS,
  IMAGE_TYPES,
  MAX_IMAGES,
  MAX_ORIGINAL_BYTES,
  argmax,
  asText,
  blankDraft,
  downscaleLabel,
  draftsFromQuestions,
  fmtBytes,
  fmtMs,
  fmtTokens,
  fmtUsd,
  pct,
  questionsFromDrafts,
  uid,
  validateDrafts,
  validateSentImages,
  type QDraft,
} from "./lib";
import { prepareImage, type PreparedImage } from "./images";

// ---------- helpers ----------

const api = async <T,>(path: string, init?: RequestInit): Promise<T> => {
  const res = await fetch(path, {
    ...init,
    headers: init?.body ? { "Content-Type": "application/json" } : undefined,
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data?.error ?? `HTTP ${res.status}`);
  return data as T;
};

const readAsDataUrl = (f: File) =>
  new Promise<string>((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result as string);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(f);
  });

// ---------- components ----------

function SavedPicker<T extends { id: number; name: string }>(props: {
  label: string;
  items: T[];
  current: string;
  onCurrent: (name: string) => void;
  onLoad: (item: T) => void;
  onSave: (name: string) => Promise<void>;
  onDelete: (item: T) => Promise<void>;
}) {
  const { items, current } = props;
  const selected = items.find((i) => i.name === current);
  return (
    <div className="picker">
      <select
        value={selected?.id ?? ""}
        onChange={(e) => {
          const item = items.find((i) => i.id === Number(e.target.value));
          if (item) {
            props.onCurrent(item.name);
            props.onLoad(item);
          }
        }}
      >
        <option value="">{items.length ? `Load ${props.label}…` : `No saved ${props.label}s`}</option>
        {items.map((i) => (
          <option key={i.id} value={i.id}>
            {i.name}
          </option>
        ))}
      </select>
      <input placeholder="name" value={current} onChange={(e) => props.onCurrent(e.target.value)} />
      <button disabled={!current.trim()} onClick={() => props.onSave(current.trim())}>
        {selected ? "Update" : "Save"}
      </button>
      {selected && (
        <button className="ghost danger" title="Delete" onClick={() => props.onDelete(selected)}>
          ✕
        </button>
      )}
    </div>
  );
}

function QuestionCard(props: {
  d: QDraft;
  onChange: (d: QDraft) => void;
  onRemove: () => void;
  onDuplicate: () => void;
}) {
  const { d, onChange } = props;
  const set = (patch: Partial<QDraft>) => onChange({ ...d, ...patch });
  return (
    <div className="qcard">
      <div className="qhead">
        <input className="mono qid" value={d.id} placeholder="question_id" onChange={(e) => set({ id: e.target.value })} />
        <div className="seg small">
          {(["noul", "choice", "score"] as const).map((t) => (
            <button key={t} className={d.type === t ? "on" : ""} onClick={() => set({ type: t })}>
              {t}
            </button>
          ))}
        </div>
        <span className="spacer" />
        <button className="ghost" title="Duplicate" onClick={props.onDuplicate}>
          ⧉
        </button>
        <button className="ghost danger" title="Remove" onClick={props.onRemove}>
          ✕
        </button>
      </div>
      <textarea
        rows={2}
        placeholder={d.type === "noul" ? "Yes/no question…" : d.type === "choice" ? "What should be decided…" : "What should be rated…"}
        value={d.instructions}
        onChange={(e) => set({ instructions: e.target.value })}
      />
      {d.type === "noul" && (
        <div className="crit">
          <label>
            <span>yes means</span>
            <input value={d.noulTrue} placeholder="optional" onChange={(e) => set({ noulTrue: e.target.value })} />
          </label>
          <label>
            <span>no means</span>
            <input value={d.noulFalse} placeholder="optional" onChange={(e) => set({ noulFalse: e.target.value })} />
          </label>
        </div>
      )}
      {d.type === "choice" && (
        <div className="crit">
          {d.options.map((o, i) => (
            <div className="row" key={i}>
              <input
                className="mono key"
                value={o.key}
                placeholder="option"
                onChange={(e) => set({ options: d.options.map((x, j) => (j === i ? { ...x, key: e.target.value } : x)) })}
              />
              <input
                value={o.desc}
                placeholder="description (optional)"
                onChange={(e) => set({ options: d.options.map((x, j) => (j === i ? { ...x, desc: e.target.value } : x)) })}
              />
              <button className="ghost" onClick={() => set({ options: d.options.filter((_, j) => j !== i) })}>
                −
              </button>
            </div>
          ))}
          <button className="ghost add" onClick={() => set({ options: [...d.options, { key: "", desc: "" }] })}>
            + option
          </button>
        </div>
      )}
      {d.type === "score" && (
        <div className="crit">
          {d.levels.map((l, i) => (
            <div className="row" key={i}>
              <span className="mono lvl">{i}</span>
              <input value={l} onChange={(e) => set({ levels: d.levels.map((x, j) => (j === i ? e.target.value : x)) })} />
              <button className="ghost" disabled={i === 0} title="Move up" onClick={() => {
                const levels = [...d.levels];
                [levels[i - 1], levels[i]] = [levels[i]!, levels[i - 1]!];
                set({ levels });
              }}>
                ↑
              </button>
              <button className="ghost" onClick={() => set({ levels: d.levels.filter((_, j) => j !== i) })}>
                −
              </button>
            </div>
          ))}
          {d.levels.length < 10 && (
            <button className="ghost add" onClick={() => set({ levels: [...d.levels, ""] })}>
              + level
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function Bar({ p, highlight }: { p: number; highlight?: boolean }) {
  return (
    <div className="bar">
      <div className={highlight ? "fill hi" : "fill"} style={{ width: `${Math.max(0, Math.min(1, p)) * 100}%` }} />
    </div>
  );
}

function AnswerCard({ id, a, q }: { id: string; a: Answer; q?: Question }) {
  return (
    <div className="acard">
      <div className="ahead">
        <span className="mono aid">{id}</span>
        <span className="badge">{a.type}</span>
        {q && <span className="muted ainstr" title={asText(q.instructions)}>{asText(q.instructions)}</span>}
      </div>
      {a.type === "noul" && (
        <div className="noul">
          <span className={`big ${a.noul >= 0.5 ? "yes" : "no"}`}>{a.noul >= 0.5 ? "YES" : "NO"}</span>
          <span className="mono">P(yes) = {a.noul.toFixed(4)}</span>
          <Bar p={a.noul} highlight={a.noul >= 0.5} />
        </div>
      )}
      {a.type === "choice" && (
        <>
          <div className="summary">
            <span className="big">{a.choice}</span>
            <span className="muted">confidence {pct(a.confidence)}</span>
          </div>
          <ProbList probs={a.probabilities} top={a.choice} />
        </>
      )}
      {a.type === "score" && (
        <>
          <div className="summary">
            <span className="big">{a.score.toFixed(2)}</span>
            <span className="muted">
              / {Object.keys(a.legend).length - 1} · ≈ {asText(a.legend[String(Math.round(a.score))])} · confidence{" "}
              {pct(a.confidence)}
            </span>
          </div>
          <ProbList probs={a.probabilities} legend={a.legend} top={argmax(a.probabilities)} keepOrder />
        </>
      )}
    </div>
  );
}

function ProbList(props: { probs: Record<string, number>; top: string; legend?: Record<string, unknown>; keepOrder?: boolean }) {
  const entries = Object.entries(props.probs);
  if (!props.keepOrder) entries.sort((a, b) => b[1] - a[1]);
  return (
    <div className="probs">
      {entries.map(([k, p]) => (
        <div className="prob" key={k}>
          <span className="mono plabel" title={props.legend ? asText(props.legend[k]) : k}>
            {props.legend ? `${k} · ${asText(props.legend[k])}` : k}
          </span>
          <Bar p={p} highlight={k === props.top} />
          <span className="mono pval">{pct(p)}</span>
        </div>
      ))}
    </div>
  );
}

// ---------- app ----------

function App() {
  const [configured, setConfigured] = useState(true);
  const [model, setModel] = useState<ModelName>("clef");

  const [stateText, setStateText] = useState("Checkout has been failing for every customer for the last hour.");
  const [stateIsJson, setStateIsJson] = useState(false);
  const [images, setImages] = useState<string[]>([]); // originals; downscaled copies are what get sent
  const [imageError, setImageError] = useState("");
  const [maxPixels, setMaxPixels] = useState<number | null>(() => {
    try {
      const v = localStorage.getItem("clef.maxPixels");
      return v === null ? DEFAULT_MAX_PIXELS : v === "original" ? null : Number(v);
    } catch {
      return DEFAULT_MAX_PIXELS;
    }
  });
  const [prepared, setPrepared] = useState<{ images: string[]; maxPixels: number | null; items: PreparedImage[] }>({
    images: [],
    maxPixels: null,
    items: [],
  });

  const [drafts, setDrafts] = useState<QDraft[]>(() => draftsFromQuestions(DEFAULT_QUESTIONS));
  const [rawMode, setRawMode] = useState(false);
  const [questionsCollapsed, setQuestionsCollapsed] = useState(() => {
    try {
      return localStorage.getItem("clef.questionsCollapsed") === "1";
    } catch {
      return false;
    }
  });
  const [rawText, setRawText] = useState("");
  const [rawError, setRawError] = useState("");

  const [running, setRunning] = useState(false);
  const [response, setResponse] = useState<RunResponse | null>(null);
  const [responseQuestions, setResponseQuestions] = useState<Questions>({});
  const [showRaw, setShowRaw] = useState(false);

  const [sets, setSets] = useState<QuestionSet[]>([]);
  const [savedInputs, setSavedInputs] = useState<SavedInput[]>([]);
  const [history, setHistory] = useState<RunRecord[]>([]);
  const [setName, setSetName] = useState("");
  const [inputName, setInputName] = useState("");
  const [toast, setToast] = useState("");

  const fileRef = useRef<HTMLInputElement>(null);

  const flash = (msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(""), 2200);
  };

  const refresh = useCallback(async () => {
    const [s, i, h] = await Promise.all([
      api<QuestionSet[]>("/api/question-sets"),
      api<SavedInput[]>("/api/inputs"),
      api<RunRecord[]>("/api/runs"),
    ]);
    setSets(s);
    setSavedInputs(i);
    setHistory(h);
  }, []);

  useEffect(() => {
    api<{ configured: boolean }>("/api/config").then((c) => setConfigured(c.configured));
    refresh();
    const runId = Number(new URLSearchParams(location.search).get("run"));
    if (runId) loadRun(runId);
  }, [refresh]);

  // --- state parsing
  const parsedState = useMemo((): { ok: true; value: unknown } | { ok: false; error: string } => {
    if (!stateIsJson) return { ok: true, value: stateText };
    try {
      return { ok: true, value: JSON.parse(stateText) };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  }, [stateText, stateIsJson]);

  const validation = useMemo(() => validateDrafts(drafts), [drafts]);

  // --- images
  const addFiles = async (files: FileList | File[]) => {
    setImageError("");
    const next = [...images];
    for (const f of Array.from(files)) {
      if (!IMAGE_TYPES.includes(f.type)) {
        setImageError(`${f.name}: only PNG, JPEG, WebP`);
        continue;
      }
      if (f.size > MAX_ORIGINAL_BYTES) {
        setImageError(`${f.name}: over ${fmtBytes(MAX_ORIGINAL_BYTES)}`);
        continue;
      }
      if (next.length >= MAX_IMAGES) {
        setImageError(`Max ${MAX_IMAGES} images`);
        break;
      }
      next.push(await readAsDataUrl(f));
    }
    setImages(next);
  };

  const changeMaxPixels = (v: number | null) => {
    setMaxPixels(v);
    try {
      localStorage.setItem("clef.maxPixels", v === null ? "original" : String(v));
    } catch {}
  };

  const toggleQuestions = () => {
    const v = !questionsCollapsed;
    setQuestionsCollapsed(v);
    try {
      localStorage.setItem("clef.questionsCollapsed", v ? "1" : "0");
    } catch {}
  };

  // Re-encode whenever the originals or the downscale setting change.
  useEffect(() => {
    let cancelled = false;
    Promise.all(images.map((src) => prepareImage(src, maxPixels)))
      .then((items) => !cancelled && setPrepared({ images, maxPixels, items }))
      .catch((e) => !cancelled && setImageError(`Could not process image: ${(e as Error).message}`));
    return () => {
      cancelled = true;
    };
  }, [images, maxPixels]);

  const imagesReady = prepared.images === images && prepared.maxPixels === maxPixels;
  const sendErrors = useMemo(() => (imagesReady ? validateSentImages(prepared.items) : []), [imagesReady, prepared]);
  const imageTokens = prepared.items.reduce((s, p) => s + p.tokens, 0);
  const largestImage = prepared.items
    .map((p) => ({ width: p.origWidth, height: p.origHeight }))
    .reduce<{ width: number; height: number } | undefined>((a, b) => (!a || b.width * b.height > a.width * a.height ? b : a), undefined);

  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const files = Array.from(e.clipboardData?.files ?? []).filter((f) => f.type.startsWith("image/"));
      if (files.length) {
        e.preventDefault();
        addFiles(files);
      }
    };
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  });

  // --- raw JSON question mode
  const enterRaw = () => {
    setRawText(JSON.stringify(questionsFromDrafts(drafts), null, 2));
    setRawError("");
    setRawMode(true);
  };
  const parseRaw = (): Questions | null => {
    try {
      const parsed = JSON.parse(rawText);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Expected an object of questions");
      setRawError("");
      // Accept either a bare questions map or a full request body with a `questions` key.
      return parsed.questions && typeof parsed.questions === "object" ? parsed.questions : parsed;
    } catch (e) {
      setRawError((e as Error).message);
      return null;
    }
  };
  const applyRaw = (): boolean => {
    const qs = parseRaw();
    if (qs) setDrafts(draftsFromQuestions(qs));
    return !!qs;
  };

  // --- run
  const canRun =
    configured && !running && parsedState.ok && validation.length === 0 && !rawMode && imagesReady && sendErrors.length === 0;
  const run = async () => {
    if (!canRun || !parsedState.ok) return;
    const questions = questionsFromDrafts(drafts);
    const body: RunRequest = { model, state: parsedState.value, questions, images: prepared.items.map((p) => p.url) };
    setRunning(true);
    setResponse(null);
    try {
      const res = await api<RunResponse>("/api/run", { method: "POST", body: JSON.stringify(body) });
      setResponse(res);
      setResponseQuestions(questions);
    } catch (e) {
      setResponse({ id: 0, ok: false, error: (e as Error).message, latencyMs: 0, costUsd: 0 });
    } finally {
      setRunning(false);
      refresh();
    }
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
        e.preventDefault();
        run();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const loadRun = async (id: number) => {
    const r = await api<RunRecord>(`/api/runs/${id}`);
    setModel(r.model);
    const isStr = typeof r.request.state === "string";
    setStateIsJson(!isStr);
    setStateText(isStr ? (r.request.state as string) : JSON.stringify(r.request.state, null, 2));
    setImages(r.request.images);
    setDrafts(draftsFromQuestions(r.request.questions));
    setRawMode(false);
    setResponseQuestions(r.request.questions);
    const env = r.response as { result?: RunResponse["result"]; errors?: { message: string }[]; error?: string };
    setResponse({
      id: r.id,
      ok: r.ok,
      result: env?.result,
      error: r.ok ? undefined : env?.errors?.map((e) => e.message).join("; ") || env?.error || JSON.stringify(r.response),
      latencyMs: r.latencyMs,
      costUsd: r.costUsd,
    });
  };

  const result = response?.result;
  const rawRequest = parsedState.ok
    ? { model, state: parsedState.value, questions: questionsFromDrafts(drafts), ...(images.length ? { images: prepared.items.map((p, i) => `<image ${i + 1}: ${p.width}×${p.height}, ${fmtBytes(p.bytes)}>`) } : {}) }
    : null;

  return (
    <div className="app">
      <header>
        <div className="brand">
          <span className="logo">♪</span> Clef Playground
        </div>
        <div className="seg">
          {(Object.keys(MODELS) as ModelName[]).map((m) => (
            <button key={m} className={model === m ? "on" : ""} onClick={() => setModel(m)}>
              {MODELS[m].label}
              <span className="price">${MODELS[m].usdPerMInput}/M</span>
            </button>
          ))}
        </div>
        <span className="spacer" />
        {!configured && <span className="warn">Set CLOUDFLARE_ACCOUNT_ID / CLOUDFLARE_API_TOKEN in .env</span>}
        <button className="primary" disabled={!canRun} onClick={run} title="⌘↵">
          {running ? "Running…" : "Run ⌘↵"}
        </button>
      </header>

      <main className={questionsCollapsed ? "q-collapsed" : ""}>
        {/* ---------- input ---------- */}
        <section className="col">
          <div className="colhead">
            <h2>State</h2>
            <label className="check">
              <input type="checkbox" checked={stateIsJson} onChange={(e) => setStateIsJson(e.target.checked)} /> send as JSON
            </label>
          </div>
          <SavedPicker
            label="input"
            items={savedInputs}
            current={inputName}
            onCurrent={setInputName}
            onLoad={(i) => {
              setStateText(i.state);
              setStateIsJson(i.stateIsJson);
              setImages(i.images);
            }}
            onSave={async (name) => {
              await api("/api/inputs", { method: "POST", body: JSON.stringify({ name, state: stateText, stateIsJson, images }) });
              flash(`Saved input "${name}"`);
              refresh();
            }}
            onDelete={async (i) => {
              await api(`/api/inputs/${i.id}`, { method: "DELETE" });
              setInputName("");
              refresh();
            }}
          />
          <textarea
            className={`state mono ${!parsedState.ok ? "invalid" : ""}`}
            value={stateText}
            spellCheck={false}
            onChange={(e) => setStateText(e.target.value)}
            placeholder={stateIsJson ? '{"records": [...]}' : "Text to evaluate…"}
          />
          {!parsedState.ok && <div className="err">JSON: {parsedState.error}</div>}
          {stateIsJson && parsedState.ok && (
            <button className="ghost add" onClick={() => setStateText(JSON.stringify(parsedState.value, null, 2))}>
              format JSON
            </button>
          )}

          <div className="colhead">
            <h2>
              Images <span className="muted">{images.length}/{MAX_IMAGES}</span>
              {imageTokens > 0 && <span className="muted"> · ~{fmtTokens(imageTokens)} tok</span>}
            </h2>
            <label
              className="check"
              title={`Images larger than this are downscaled (keeping aspect ratio) before sending.${largestImage ? " Resolutions shown are for the largest attached image." : ""}`}
            >
              downscale to
              <select
                className="inline"
                value={maxPixels ?? "original"}
                onChange={(e) => changeMaxPixels(e.target.value === "original" ? null : Number(e.target.value))}
              >
                {DOWNSCALE_OPTIONS.map((o) => (
                  <option key={o.label} value={o.maxPixels ?? "original"}>
                    {downscaleLabel(o, largestImage)}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <div
            className="drop"
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              e.preventDefault();
              addFiles(e.dataTransfer.files);
            }}
            onClick={() => fileRef.current?.click()}
          >
            {images.length === 0 ? (
              <span className="muted">Drop, paste, or click to add up to 4 PNG / JPEG / WebP images</span>
            ) : (
              <div className="thumbs">
                {images.map((src, i) => {
                  const p = imagesReady ? prepared.items[i] : undefined;
                  const scaled = p && (p.width !== p.origWidth || p.height !== p.origHeight);
                  return (
                    <div className="thumbwrap" key={i} onClick={(e) => e.stopPropagation()}>
                      <div className="thumb">
                        <img src={src} />
                        <button className="x" onClick={() => setImages(images.filter((_, j) => j !== i))}>
                          ✕
                        </button>
                      </div>
                      {p ? (
                        <div className="mono caption" title={`original ${p.origWidth}×${p.origHeight}, ${fmtBytes(p.origBytes)}`}>
                          {scaled && <s>{p.origWidth}×{p.origHeight}</s>}
                          <span>
                            {p.width}×{p.height}
                          </span>
                          <span className="muted">{fmtBytes(p.bytes)}</span>
                          <span className="muted">~{fmtTokens(p.tokens)} tok</span>
                        </div>
                      ) : (
                        <div className="mono caption muted">processing…</div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
            <input
              ref={fileRef}
              type="file"
              accept={IMAGE_TYPES.join(",")}
              multiple
              hidden
              onChange={(e) => {
                if (e.target.files) addFiles(e.target.files);
                e.target.value = "";
              }}
            />
          </div>
          {imageError && <div className="err">{imageError}</div>}
          {sendErrors.map((e) => (
            <div className="err" key={e}>
              {e}
            </div>
          ))}
        </section>

        {/* ---------- questions ---------- */}
        {questionsCollapsed ? (
          <section className="col rail">
            <button className="ghost" onClick={toggleQuestions} title="Show questions">
              »
            </button>
            <button className="rail-label" onClick={toggleQuestions} title="Show questions">
              Questions <span className="muted">{drafts.length}</span>
              {validation.length > 0 && <span className="rail-err"> ⚠</span>}
            </button>
          </section>
        ) : (
        <section className="col">
          <div className="colhead">
            <h2>
              Questions <span className="muted">{drafts.length}/64</span>
            </h2>
            <span className="spacer" />
            <div className="seg small">
              <button className={!rawMode ? "on" : ""} onClick={() => rawMode && applyRaw() && setRawMode(false)}>
                form
              </button>
              <button className={rawMode ? "on" : ""} onClick={() => !rawMode && enterRaw()}>
                JSON
              </button>
            </div>
            <button className="ghost" onClick={toggleQuestions} title="Collapse questions">
              «
            </button>
          </div>
          <SavedPicker
            label="question set"
            items={sets}
            current={setName}
            onCurrent={setSetName}
            onLoad={(s) => {
              setDrafts(draftsFromQuestions(s.questions));
              setRawMode(false);
            }}
            onSave={async (name) => {
              const questions = rawMode ? parseRaw() : questionsFromDrafts(drafts);
              if (!questions) return;
              await api("/api/question-sets", { method: "POST", body: JSON.stringify({ name, questions }) });
              flash(`Saved question set "${name}"`);
              refresh();
            }}
            onDelete={async (s) => {
              await api(`/api/question-sets/${s.id}`, { method: "DELETE" });
              setSetName("");
              refresh();
            }}
          />
          {rawMode ? (
            <>
              <textarea className="state mono raw" spellCheck={false} value={rawText} onChange={(e) => setRawText(e.target.value)} />
              {rawError && <div className="err">{rawError}</div>}
              <button onClick={() => applyRaw() && setRawMode(false)}>Apply</button>
            </>
          ) : (
            <div className="qlist">
              {drafts.map((d, i) => (
                <QuestionCard
                  key={d.uid}
                  d={d}
                  onChange={(nd) => setDrafts(drafts.map((x) => (x.uid === d.uid ? nd : x)))}
                  onRemove={() => setDrafts(drafts.filter((x) => x.uid !== d.uid))}
                  onDuplicate={() => {
                    const copy = { ...structuredClone(d), uid: uid(), id: `${d.id}_copy` };
                    setDrafts([...drafts.slice(0, i + 1), copy, ...drafts.slice(i + 1)]);
                  }}
                />
              ))}
              <button className="addq" onClick={() => setDrafts([...drafts, blankDraft(`q${drafts.length + 1}`)])}>
                + Add question
              </button>
              {validation.length > 0 && (
                <ul className="err">
                  {validation.map((v) => (
                    <li key={v}>{v}</li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </section>
        )}

        {/* ---------- results ---------- */}
        <section className="col">
          <div className="colhead">
            <h2>Response</h2>
            <label className="check">
              <input type="checkbox" checked={showRaw} onChange={(e) => setShowRaw(e.target.checked)} /> raw
            </label>
          </div>

          {running && <div className="placeholder pulse">Running {model}…</div>}
          {!running && !response && <div className="placeholder muted">Run to see answers. ⌘↵</div>}

          {response && (
            <>
              <div className="metrics">
                <div>
                  <label>inference</label>
                  <b>{fmtMs(response.latencyMs)}</b>
                </div>
                <div>
                  <label>input tok</label>
                  <b>{result?.usage.input_tokens.toLocaleString() ?? "—"}</b>
                </div>
                <div>
                  <label>output tok</label>
                  <b>{result?.usage.output_tokens.toLocaleString() ?? "—"}</b>
                </div>
                <div title={`≈ ${fmtUsd(response.costUsd * 1000)} per 1k runs`}>
                  <label>cost</label>
                  <b>{fmtUsd(response.costUsd)}</b>
                  <small>{fmtUsd(response.costUsd * 1000)}/1k</small>
                </div>
              </div>
              {result?.model && <div className="muted tiny">model: {result.model} · run #{response.id}</div>}
              {response.error && <div className="err box">{response.error}</div>}
              {result && !showRaw && (
                <div className="alist">
                  {Object.entries(result.answers).map(([id, a]) => (
                    <AnswerCard key={id} id={id} a={a} q={responseQuestions[id]} />
                  ))}
                </div>
              )}
              {showRaw && (
                <>
                  <h3>request</h3>
                  <pre>{JSON.stringify(rawRequest, null, 2)}</pre>
                  <h3>response</h3>
                  <pre>{JSON.stringify(result ?? response, null, 2)}</pre>
                </>
              )}
            </>
          )}

          <div className="colhead history-head">
            <h2>History</h2>
            {history.length > 0 && (
              <button
                className="ghost danger"
                onClick={async () => {
                  if (!confirm("Clear all run history?")) return;
                  await api("/api/runs", { method: "DELETE" });
                  refresh();
                }}
              >
                clear
              </button>
            )}
          </div>
          <div className="history">
            {history.length === 0 && <div className="muted tiny">No runs yet.</div>}
            {history.map((h) => (
              <button key={h.id} className={`hrow ${response?.id === h.id ? "on" : ""}`} onClick={() => loadRun(h.id)}>
                <span className={`dot ${h.ok ? "ok" : "bad"}`} />
                <span className="mono">#{h.id}</span>
                <span className="badge">{h.model}</span>
                <span className="hstate">{typeof h.request.state === "string" ? h.request.state : JSON.stringify(h.request.state)}</span>
                <span className="mono muted">{fmtMs(h.latencyMs)}</span>
                <span className="mono muted">{fmtUsd(h.costUsd)}</span>
              </button>
            ))}
          </div>
        </section>
      </main>
      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
