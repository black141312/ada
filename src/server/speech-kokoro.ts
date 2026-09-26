/**
 * Server speech for Ada Tutor: POST /v1/tutor/speech { text, voice } → audio/wav.
 *
 * Two engines (ADA_SPEECH_PROVIDER; default openrouter when OPENROUTER_API_KEY is set, else kokoro):
 * OpenRouter's gpt-audio-mini (speech-openrouter.ts) — fast, metered, checked for verbatim reading —
 * with Kokoro as the fallback for any line it gets wrong, times out on, or isn't allowed to pay for.
 *
 * Kokoro-82M (the app's local voice, same voice map) runs in a forked child process
 * (kokoro-worker.mjs), one line at a time per instance. Output is 16 kHz mono 16-bit WAV
 * (~32 KB/s). Lines are cached by sha1(voice + text): in memory (LRU, 200 MB) and on disk under
 * ADA_DATA_DIR when there is one (not on Cloud Run, whose disk is memory — see diskDir).
 *
 * Memory: the worker holds ~400 MB once the model is loaded, plus the LRU — the service needs
 * ~1.5–2 GiB, not Cloud Run's 512 MiB default.
 *
 * Not a free general TTS: signed-in only, text capped at 1500 characters, and a per-user rate limit.
 */
import { fork, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Identity } from "./enterprise.ts";
import { readBodyLimited } from "./classes.ts";
import { checkEntitlement, planFor } from "./plans.ts";
import { appendUsage, enterpriseMode } from "./enterprise.ts";
import { getInstitute, isSlug } from "./institutes.ts";
import { instituteCostSince, recordUsage } from "./usage.ts";
import { OR_SPEECH_MODEL, mapOrVoice, orSpeak, type SpeechUsage } from "./speech-openrouter.ts";

/** Lessons carry OpenAI-style voice names; Kokoro's live only here. Identical to the app's map. */
export const VOICE_MAP: Record<string, string> = {
  nova: "af_heart",
  coral: "af_bella",
  shimmer: "af_nicole",
  alloy: "af_sarah",
  sage: "bf_emma",
  echo: "am_michael",
  onyx: "am_fenrir",
  ash: "am_puck",
  verse: "am_eric",
  fable: "bm_george",
  ballad: "bm_fable",
};
export const mapVoice = (name: unknown): string => (typeof name === "string" && Object.hasOwn(VOICE_MAP, name) ? VOICE_MAP[name]! : "af_heart");

export const MAX_TEXT = 1500;
const BODY_LIMIT = 16_384; // 1500 chars of JSON-escaped text fits with room to spare

/** `voice` is the Kokoro voice; `name` the lesson's voice name as sent (for the other engine's map). */
export type SpeechInput = { ok: true; text: string; voice: string; name: string } | { ok: false; status: 400; message: string };

/** Validate a request body. `voice` is the Kokoro voice after mapping. */
export function validateSpeech(body: unknown): SpeechInput {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { ok: false, status: 400, message: "expected { text, voice }" };
  const b = body as Record<string, unknown>;
  if (typeof b.text !== "string") return { ok: false, status: 400, message: "missing 'text'" };
  const text = b.text.trim();
  if (!text) return { ok: false, status: 400, message: "empty 'text'" };
  if (text.length > MAX_TEXT) return { ok: false, status: 400, message: `'text' is too long (${MAX_TEXT} characters max)` };
  return { ok: true, text, voice: mapVoice(b.voice), name: typeof b.voice === "string" ? b.voice : "nova" };
}

export const cacheKey = (voice: string, text: string): string => createHash("sha1").update(`${voice}\n${text}`).digest("hex");

export type SpeechProvider = "openrouter" | "kokoro";
/** Read per request, so flipping the env on a running service needs no restart. */
export function speechProvider(env: NodeJS.ProcessEnv = process.env): SpeechProvider {
  const p = env.ADA_SPEECH_PROVIDER;
  if (p === "openrouter" || p === "kokoro") return p;
  return env.OPENROUTER_API_KEY ? "openrouter" : "kokoro";
}
/** The cache key names the engine and its own voice, so a Kokoro line never answers for OpenRouter. */
export const speechKey = (provider: SpeechProvider, voice: string, text: string): string => cacheKey(`${provider}:${voice}`, text);

/** Sliding one-minute window per user. ponytail: per instance, in memory — across N instances a
 *  user gets N× the rate; fine for "not a free TTS", not a billing control. */
export class RateLimiter {
  private hits = new Map<string, number[]>();
  constructor(
    readonly perMinute: number,
    private readonly windowMs = 60_000,
  ) {}
  /** True if this request is allowed (and counts it). */
  take(user: string, now = Date.now()): boolean {
    const recent = (this.hits.get(user) ?? []).filter((t) => now - t < this.windowMs);
    if (recent.length >= this.perMinute) {
      this.hits.set(user, recent);
      return false;
    }
    recent.push(now);
    this.hits.set(user, recent);
    if (this.hits.size > 10_000) for (const [u, ts] of this.hits) if (!ts.some((t) => now - t < this.windowMs)) this.hits.delete(u);
    return true;
  }
  /** Seconds until the user may try again (for Retry-After). */
  retryAfter(user: string, now = Date.now()): number {
    const oldest = (this.hits.get(user) ?? [])[0];
    return oldest === undefined ? 0 : Math.max(1, Math.ceil((this.windowMs - (now - oldest)) / 1000));
  }
}

/** Byte-budgeted LRU (Map insertion order = recency). */
export class LruBytes {
  private map = new Map<string, Uint8Array>();
  private bytes = 0;
  constructor(readonly maxBytes: number) {}
  get(k: string): Uint8Array | undefined {
    const v = this.map.get(k);
    if (v) {
      this.map.delete(k);
      this.map.set(k, v);
    }
    return v;
  }
  set(k: string, v: Uint8Array): void {
    if (v.byteLength > this.maxBytes) return;
    const old = this.map.get(k);
    if (old) {
      this.bytes -= old.byteLength;
      this.map.delete(k);
    }
    this.map.set(k, v);
    this.bytes += v.byteLength;
    for (const [key, val] of this.map) {
      if (this.bytes <= this.maxBytes) break;
      this.map.delete(key);
      this.bytes -= val.byteLength;
    }
  }
  get size(): number {
    return this.bytes;
  }
}

// ---------- the worker client (the app's createSynth, over child_process) ----------

/** A synth failure with the HTTP status it should become (429 = this user's fault, 503 = ours). */
export class SpeechError extends Error {
  constructor(
    readonly status: 429 | 503,
    message: string,
  ) {
    super(message);
  }
}

export interface SynthOptions {
  /** Who asked — for the per-user queue share. */
  owner?: string;
  /** Aborted when the HTTP request goes away: a queued line nobody will hear is dropped. */
  signal?: AbortSignal;
}
export type Synth = (voice: string, text: string, opts?: SynthOptions) => Promise<Uint8Array>;

type Req = {
  id: number;
  voice: string;
  text: string;
  owner?: string;
  resolve: (b: Uint8Array) => void;
  reject: (e: Error) => void;
  timer?: NodeJS.Timeout;
  waitTimer?: NodeJS.Timeout;
  onAbort?: () => void;
  signal?: AbortSignal;
  child?: ChildProcess;
};

/** One request at the worker at a time; the rest wait here, fairly:
 *  - at most `perOwner` lines queued per user (a 429 past that), `maxWaiting` in all (503);
 *  - a line waits at most `waitMs` for its turn (503 — the client uses the browser voice);
 *  - a line whose HTTP request closed is dropped from the queue.
 *  A worker that exits takes its in-flight request with it; one that doesn't answer within
 *  `timeoutMs` is SIGKILLed — a hung onnxruntime would otherwise hold every later line hostage —
 *  and the next line forks a fresh one. */
export function createSynth({
  spawn,
  timeoutMs = 60_000, // a baked model loads in ~3 s and a 1500-char line takes well under this
  maxWaiting = 32,
  perOwner = 2,
  waitMs = 60_000,
}: {
  spawn: () => ChildProcess;
  timeoutMs?: number;
  maxWaiting?: number;
  perOwner?: number;
  waitMs?: number;
}): Synth {
  let child: ChildProcess | null = null;
  let seq = 0;
  let current: Req | null = null;
  const waiting: Req[] = [];
  const unqueue = (req: Req): boolean => {
    const i = waiting.indexOf(req);
    if (i < 0) return false;
    waiting.splice(i, 1);
    clearTimeout(req.waitTimer);
    if (req.onAbort) req.signal?.removeEventListener("abort", req.onAbort);
    return true;
  };
  const finish = (): Req => {
    const req = current!;
    clearTimeout(req.timer);
    current = null;
    return req;
  };
  const start = (): ChildProcess => {
    const c = spawn();
    c.on("message", (m: { id?: number; ok?: boolean; wav?: Uint8Array; error?: string }) => {
      if (!current || m?.id !== current.id) return; // a late reply to a timed-out request
      const req = finish();
      if (m.ok && m.wav) req.resolve(new Uint8Array(m.wav));
      else req.reject(new Error(m.error || "voice failed"));
      pump();
    });
    c.on("error", () => {}); // 'exit' does the cleanup
    c.on("exit", () => {
      if (child === c) child = null;
      if (current?.child === c) finish().reject(new Error("voice worker exited"));
      pump();
    });
    return c;
  };
  const pump = (): void => {
    if (current || !waiting.length) return;
    const req = waiting[0]!;
    unqueue(req);
    current = req;
    try {
      child ??= start();
    } catch (err) {
      current = null;
      req.reject(err instanceof Error ? err : new Error(String(err)));
      return pump();
    }
    const c = (req.child = child);
    req.timer = setTimeout(() => {
      if (current !== req) return;
      // Hung, not slow: kill it so the next line gets a fresh worker instead of queueing behind it.
      if (child === c) child = null;
      try {
        c.kill("SIGKILL");
      } catch {}
      finish().reject(new SpeechError(503, "voice timed out"));
      pump();
    }, timeoutMs);
    c.send({ id: req.id, voice: req.voice, text: req.text });
  };
  return (voice, text, opts = {}) =>
    new Promise((resolve, reject) => {
      const { owner, signal } = opts;
      if (signal?.aborted) return reject(new SpeechError(503, "cancelled"));
      if (owner !== undefined && waiting.filter((r) => r.owner === owner).length >= perOwner) {
        return reject(new SpeechError(429, "too many lines queued — wait for the current ones"));
      }
      if (waiting.length >= maxWaiting) return reject(new SpeechError(503, "voice busy"));
      const req: Req = { id: ++seq, voice, text, owner, resolve, reject, signal };
      req.waitTimer = setTimeout(() => {
        if (unqueue(req)) reject(new SpeechError(503, "voice busy"));
      }, waitMs);
      if (signal) {
        req.onAbort = () => {
          if (unqueue(req)) reject(new SpeechError(503, "cancelled"));
        };
        signal.addEventListener("abort", req.onAbort, { once: true });
      }
      waiting.push(req);
      pump();
    });
}

const WORKER = fileURLToPath(new URL("./kokoro-worker.mjs", import.meta.url));
const spawnWorker = (): ChildProcess =>
  // `advanced` serialization carries the WAV as bytes; the default JSON one would turn a Uint8Array
  // into an object with a key per byte. No inherited execArgv: the worker is plain JS.
  fork(WORKER, [], { serialization: "advanced", execArgv: [], stdio: ["ignore", "inherit", "inherit", "ipc"] });

// ---------- caches ----------

const memory = new LruBytes(Number(process.env.ADA_TTS_MEMORY_BYTES) || 200_000_000);
// On Cloud Run (K_SERVICE set) the container filesystem IS memory and dies with the instance, so a
// disk copy would only double what the LRU above already holds. Elsewhere /data is a real volume.
const diskDir = (): string | null =>
  process.env.ADA_TTS_CACHE_DIR || (process.env.ADA_DATA_DIR && !process.env.K_SERVICE ? join(process.env.ADA_DATA_DIR, "tts") : null);
const DISK_MAX = 200_000_000;
let writes = 0;

function diskGet(key: string): Uint8Array | null {
  const dir = diskDir();
  if (!dir) return null;
  try {
    return new Uint8Array(readFileSync(join(dir, `${key}.wav`)));
  } catch {
    return null;
  }
}
function diskPut(key: string, wav: Uint8Array): void {
  const dir = diskDir();
  if (!dir) return;
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${key}.wav`), wav);
    // ponytail: prune every 50 writes, oldest-written first — reads don't bump mtime.
    if (++writes % 50 === 0) prune(dir, DISK_MAX);
  } catch {
    // the disk cache is an optimisation; a full or read-only disk must not fail the request
  }
}
export function prune(dir: string, maxBytes: number): number {
  let files: Array<{ p: string; size: number; mtime: number }>;
  try {
    files = readdirSync(dir)
      .filter((n) => n.endsWith(".wav"))
      .map((n) => {
        const p = join(dir, n);
        const st = statSync(p);
        return { p, size: st.size, mtime: st.mtimeMs };
      });
  } catch {
    return 0;
  }
  let total = files.reduce((s, f) => s + f.size, 0);
  files.sort((a, b) => a.mtime - b.mtime);
  let removed = 0;
  for (const f of files) {
    if (total <= maxBytes) break;
    try {
      unlinkSync(f.p);
      total -= f.size;
      removed++;
    } catch {}
  }
  return removed;
}

// ---------- HTTP ----------

/** Swappable for tests — `synth` forks Kokoro on first use; `or` calls OpenRouter. */
export const speechEngine: { synth: Synth; or: typeof orSpeak } = {
  synth: (voice, text, opts) => {
    const s = createSynth({ spawn: spawnWorker });
    speechEngine.synth = s;
    return s(voice, text, opts);
  },
  or: orSpeak,
};

/** OpenRouter lines in flight per user. The engine is I/O-bound, so there's no instance-wide queue —
 *  but one user can't hold more than a few paid calls open at once. */
export const OR_PER_USER = 3;
const orInFlight = new Map<string, number>();

/** Who pays for an OpenRouter line, or why nobody will (→ Kokoro, which costs nothing).
 *  An active institute named by x-ada-institute pays while under its daily budget, exactly like chat;
 *  otherwise the user's own plan must allow the model (enterprise seats are billed by contract). */
export async function speechPayer(req: IncomingMessage, user: string): Promise<{ institute?: string } | { denied: string; status?: 403 }> {
  // A ban beats every payer — same rule as the chat waiver (decideInstitute). handleSpeech also
  // refuses banned users up front; this keeps the payer decision safe on its own.
  if ((await planFor(user)).status === "banned") return { denied: "This account is suspended.", status: 403 };
  const raw = req.headers["x-ada-institute"];
  const slug = (Array.isArray(raw) ? raw[0] : raw)?.trim();
  if (isSlug(slug)) {
    const inst = await getInstitute(slug);
    if (inst?.active) {
      if (inst.dailyBudgetUsd != null) {
        const day = new Date().toISOString().slice(0, 10);
        if ((await instituteCostSince(slug, Date.parse(`${day}T00:00:00Z`))) >= inst.dailyBudgetUsd) return { denied: `institute ${slug} is over today's budget` };
      }
      return { institute: slug };
    }
  }
  if (enterpriseMode()) return {};
  const ent = await checkEntitlement(user, OR_SPEECH_MODEL);
  return ent.ok ? {} : { denied: `plan: ${ent.message ?? "not entitled"}` };
}

function meter(user: string, usage: SpeechUsage | null, institute: string | undefined, started: number): void {
  if (!usage) {
    console.warn("[speech] openrouter reported no usage — this line is unmetered");
    return;
  }
  const row = {
    ts: Date.now(),
    user,
    model: OR_SPEECH_MODEL,
    provider: "openrouter",
    promptTokens: usage.promptTokens,
    completionTokens: usage.completionTokens,
    ms: Date.now() - started,
    ...(institute ? { institute } : {}),
  };
  appendUsage(row);
  void recordUsage(row);
}

/** 20 NEW lines a minute (cache hits aren't counted): a doubt's mini-class is ~15–40 lines, heard
 *  over several minutes. ADA_SPEECH_PER_MINUTE overrides. */
export const speechLimiter = new RateLimiter(Number(process.env.ADA_SPEECH_PER_MINUTE) || 20);

function fail(res: ServerResponse, status: number, message: string, headers: Record<string, string> = {}): void {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify({ error: { message } }));
}

export async function handleSpeech(req: IncomingMessage, res: ServerResponse, who: Identity): Promise<void> {
  if (who.user === "anon") return fail(res, 401, "sign in to use voice");
  if ((await planFor(who.user)).status === "banned") return fail(res, 403, "This account is suspended.");
  const raw = await readBodyLimited(req, BODY_LIMIT);
  if (raw === null) return fail(res, 413, `body too large (${MAX_TEXT} characters of text max)`);
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return fail(res, 400, "invalid JSON body");
  }
  const v = validateSpeech(body);
  if (!v.ok) return fail(res, v.status, v.message);

  const provider = speechProvider();
  const orVoice = mapOrVoice(v.name);
  const kokoroKey = speechKey("kokoro", v.voice, v.text);
  const orKey = speechKey("openrouter", orVoice, v.text);
  // Look up the requested engine's line first, then — on the OpenRouter path — a Kokoro stand-in
  // cached earlier for the same line (a misread, a timeout, or a user OpenRouter won't bill).
  // ponytail: a stand-in is kept for good; a transient OpenRouter failure isn't retried for that line.
  const lookups: Array<[string, SpeechProvider]> = provider === "openrouter" ? [[orKey, "openrouter"], [kokoroKey, "kokoro"]] : [[kokoroKey, "kokoro"]];
  let wav: Uint8Array | null = null;
  let cache = "miss";
  let engine: SpeechProvider = provider;
  for (const [k, e] of lookups) {
    const m = memory.get(k);
    const d = m ? null : diskGet(k);
    if (m || d) {
      wav = (m ?? d)!;
      if (d) memory.set(k, d);
      cache = m ? "memory" : "disk";
      engine = e;
      break;
    }
  }
  if (!wav) {
    // Only synthesis counts against the rate: a cached line costs nothing, and a replayed lesson
    // (all hits) must not lock the student out of the next new one.
    if (!speechLimiter.take(who.user)) {
      return fail(res, 429, "too many voice requests — slow down", { "retry-after": String(speechLimiter.retryAfter(who.user)) });
    }
    // The student skipped ahead or closed the page: drop the line if it's still only queued.
    const gone = new AbortController();
    res.on("close", () => {
      if (!res.writableFinished) gone.abort();
    });
    if (provider === "openrouter") {
      const payer = await speechPayer(req, who.user);
      if ("denied" in payer && payer.status === 403) return fail(res, 403, payer.denied);
      if ("denied" in payer) {
        console.warn(`[speech] kokoro instead of openrouter for ${who.user}: ${payer.denied}`);
      } else {
        const n = orInFlight.get(who.user) ?? 0;
        if (n >= OR_PER_USER) return fail(res, 429, "too many voice lines at once — wait for the current ones");
        orInFlight.set(who.user, n + 1);
        const started = Date.now();
        try {
          const r = await speechEngine.or({ text: v.text, voice: orVoice, signal: gone.signal });
          if (!r.ok && r.estimated) console.warn(`[speech] openrouter reported no usage (${r.reason}) — metering an estimate`);
          meter(who.user, r.usage, payer.institute, started);
          if (r.ok) wav = r.wav;
          else console.warn(`[speech] openrouter → kokoro fallback (${r.reason}): ${r.detail}`);
        } finally {
          const left = (orInFlight.get(who.user) ?? 1) - 1;
          if (left > 0) orInFlight.set(who.user, left);
          else orInFlight.delete(who.user);
        }
      }
    }
    if (wav) {
      memory.set(orKey, wav);
      diskPut(orKey, wav);
    } else {
      engine = "kokoro";
      try {
        wav = await speechEngine.synth(v.voice, v.text, { owner: who.user, signal: gone.signal });
      } catch (e) {
        // 503, not 500: the client's answer to this is "use the browser voice", not "report a bug".
        const status = e instanceof SpeechError ? e.status : 503;
        return fail(res, status, `voice unavailable: ${e instanceof Error ? e.message : String(e)}`);
      }
      memory.set(kokoroKey, wav);
      diskPut(kokoroKey, wav);
    }
  }
  res.writeHead(200, {
    "content-type": "audio/wav",
    "content-length": String(wav.byteLength),
    "cache-control": "private, max-age=604800, immutable",
    "x-ada-cache": cache,
    "x-ada-voice": engine,
  });
  res.end(Buffer.from(wav.buffer, wav.byteOffset, wav.byteLength));
}
