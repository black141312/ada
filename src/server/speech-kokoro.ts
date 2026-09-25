/**
 * Server speech for Ada Tutor: POST /v1/tutor/speech { text, voice } → audio/wav.
 *
 * Kokoro-82M (the app's local voice, same voice map) runs in a forked child process
 * (kokoro-worker.mjs), one line at a time per instance. Output is 16 kHz mono 16-bit WAV
 * (~32 KB/s). Lines are cached by sha1(voice + text): in memory (LRU, 200 MB) and on disk under
 * ADA_DATA_DIR when there is one.
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

export type SpeechInput = { ok: true; text: string; voice: string } | { ok: false; status: 400; message: string };

/** Validate a request body. `voice` is the Kokoro voice after mapping. */
export function validateSpeech(body: unknown): SpeechInput {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { ok: false, status: 400, message: "expected { text, voice }" };
  const b = body as Record<string, unknown>;
  if (typeof b.text !== "string") return { ok: false, status: 400, message: "missing 'text'" };
  const text = b.text.trim();
  if (!text) return { ok: false, status: 400, message: "empty 'text'" };
  if (text.length > MAX_TEXT) return { ok: false, status: 400, message: `'text' is too long (${MAX_TEXT} characters max)` };
  return { ok: true, text, voice: mapVoice(b.voice) };
}

export const cacheKey = (voice: string, text: string): string => createHash("sha1").update(`${voice}\n${text}`).digest("hex");

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

type Req = { id: number; voice: string; text: string; resolve: (b: Uint8Array) => void; reject: (e: Error) => void; timer?: NodeJS.Timeout; child?: ChildProcess };

/** One request at the worker at a time; the rest wait here. A worker that exits takes its in-flight
 *  request with it and the next call forks a fresh one. Past `maxWaiting` queued lines the call fails
 *  fast ("voice busy") — the client falls back to the browser voice rather than wait minutes. */
export function createSynth({ spawn, timeoutMs = 120_000, maxWaiting = 32 }: { spawn: () => ChildProcess; timeoutMs?: number; maxWaiting?: number }) {
  let child: ChildProcess | null = null;
  let seq = 0;
  let current: Req | null = null;
  const waiting: Req[] = [];
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
    const req = (current = waiting.shift()!);
    try {
      child ??= start();
    } catch (err) {
      current = null;
      req.reject(err instanceof Error ? err : new Error(String(err)));
      return pump();
    }
    req.child = child;
    req.timer = setTimeout(() => {
      if (current !== req) return;
      finish().reject(new Error("voice timed out"));
      pump();
    }, timeoutMs);
    child.send({ id: req.id, voice: req.voice, text: req.text });
  };
  return (voice: string, text: string): Promise<Uint8Array> =>
    new Promise((resolve, reject) => {
      if (waiting.length >= maxWaiting) return reject(new Error("voice busy"));
      waiting.push({ id: ++seq, voice, text, resolve, reject });
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
const diskDir = (): string | null => process.env.ADA_TTS_CACHE_DIR || (process.env.ADA_DATA_DIR ? join(process.env.ADA_DATA_DIR, "tts") : null);
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

/** Swappable for tests — the real one forks Kokoro on first use. */
export const speechEngine: { synth: (voice: string, text: string) => Promise<Uint8Array> } = {
  synth: (voice, text) => {
    const s = createSynth({ spawn: spawnWorker });
    speechEngine.synth = s;
    return s(voice, text);
  },
};

export const speechLimiter = new RateLimiter(Number(process.env.ADA_SPEECH_PER_MINUTE) || 60);

function fail(res: ServerResponse, status: number, message: string, headers: Record<string, string> = {}): void {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify({ error: { message } }));
}

export async function handleSpeech(req: IncomingMessage, res: ServerResponse, who: Identity): Promise<void> {
  if (who.user === "anon") return fail(res, 401, "sign in to use voice");
  if (!speechLimiter.take(who.user)) {
    return fail(res, 429, "too many voice requests — slow down", { "retry-after": String(speechLimiter.retryAfter(who.user)) });
  }
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

  const key = cacheKey(v.voice, v.text);
  let wav = memory.get(key) ?? null;
  let cache = "memory";
  if (!wav) {
    wav = diskGet(key);
    cache = "disk";
    if (wav) memory.set(key, wav);
  }
  if (!wav) {
    cache = "miss";
    try {
      wav = await speechEngine.synth(v.voice, v.text);
    } catch (e) {
      // 503, not 500: the client's answer to this is "use the browser voice", not "report a bug".
      return fail(res, 503, `voice unavailable: ${e instanceof Error ? e.message : String(e)}`);
    }
    memory.set(key, wav);
    diskPut(key, wav);
  }
  res.writeHead(200, {
    "content-type": "audio/wav",
    "content-length": String(wav.byteLength),
    "cache-control": "private, max-age=604800, immutable",
    "x-ada-cache": cache,
  });
  res.end(Buffer.from(wav.buffer, wav.byteOffset, wav.byteLength));
}
