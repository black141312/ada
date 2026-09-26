/**
 * Server speech via OpenRouter's `openai/gpt-audio-mini` (Ada Tutor). Kokoro on Cloud Run's CPU ran
 * 16–63 s per line (~2.5× slower than real time); this answers a 9 s line in 2–4 s.
 *
 * It is a chat model asked to read the line aloud, so two things are checked rather than trusted:
 * the transcript it reports must match the text word for word (else the caller falls back to
 * Kokoro), and the whole call is bounded by a timeout. Output: pcm16 at 24 kHz, resampled to the
 * same 16 kHz mono WAV the Kokoro path returns, so the HTTP contract doesn't change.
 */
import { PROVIDERS, providerKey } from "./config.ts";
import { pcm16Wav, resample } from "./wav.mjs";

export const OR_SPEECH_MODEL = "openai/gpt-audio-mini";
const IN_RATE = 24_000;
const OUT_RATE = 16_000;
const SYSTEM =
  "You are a text-to-speech reader. Read the user message aloud exactly as written, word for word, in a warm teacher voice. Say nothing else.";

/** Lesson voice names (the app's, kept as the input) → gpt-audio voices. Ten voices for eleven
 *  names, so one pair shares; the rest are distinct and keep each lesson voice's character. */
export const OR_VOICE_MAP: Record<string, string> = {
  nova: "marin", // the default teacher: warm, female
  coral: "coral",
  shimmer: "shimmer",
  alloy: "alloy",
  sage: "sage",
  echo: "echo",
  onyx: "cedar", // deep male
  ash: "ash",
  verse: "verse",
  ballad: "ballad",
  fable: "cedar", // the one shared voice: a second deep male narrator
};
export const mapOrVoice = (name: unknown): string => (typeof name === "string" && Object.hasOwn(OR_VOICE_MAP, name) ? OR_VOICE_MAP[name]! : "marin");

// ---------- the stream ----------

export interface SpeechUsage {
  promptTokens: number;
  completionTokens: number;
}

/** Collects an OpenRouter chat SSE stream carrying audio deltas. Feed it raw text chunks. */
export class AudioStream {
  private buf = "";
  private chunks: Buffer[] = [];
  /** Decoded audio bytes so far. */
  bytes = 0;
  transcript = "";
  usage: SpeechUsage | null = null;
  error: string | null = null;
  push(text: string): void {
    this.buf += text;
    let i: number;
    while ((i = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, i).trim();
      this.buf = this.buf.slice(i + 1);
      this.line(line);
    }
  }
  end(): void {
    if (this.buf.trim()) this.line(this.buf.trim());
    this.buf = "";
  }
  private line(l: string): void {
    if (!l.startsWith("data:")) return;
    const d = l.slice(5).trim();
    if (!d || d === "[DONE]") return;
    let j: {
      error?: unknown;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
      choices?: Array<{ delta?: { audio?: { data?: string; transcript?: string } } }>;
    };
    try {
      j = JSON.parse(d);
    } catch {
      return; // a torn or non-JSON keep-alive line
    }
    if (j.error) this.error = (typeof j.error === "string" ? j.error : JSON.stringify(j.error)).slice(0, 300);
    const a = j.choices?.[0]?.delta?.audio;
    if (a?.data) {
      const b = Buffer.from(a.data, "base64");
      this.chunks.push(b);
      this.bytes += b.length;
    }
    if (a?.transcript) this.transcript += a.transcript;
    if (j.usage && (j.usage.prompt_tokens != null || j.usage.completion_tokens != null)) {
      this.usage = { promptTokens: j.usage.prompt_tokens ?? 0, completionTokens: j.usage.completion_tokens ?? 0 };
    }
  }
  /** Little-endian 16-bit PCM at 24 kHz, as received. */
  pcm(): Buffer {
    return Buffer.concat(this.chunks);
  }
}

/** pcm16 LE 24 kHz → the 16 kHz mono WAV every speech path returns. */
export function pcm24ToWav16(pcm: Buffer): Uint8Array {
  const n = Math.floor(pcm.length / 2);
  const f = new Float32Array(n);
  for (let i = 0; i < n; i++) f[i] = pcm.readInt16LE(i * 2) / 32768;
  return pcm16Wav(resample(f, IN_RATE, OUT_RATE), OUT_RATE);
}

// ---------- the verbatim guard ----------

const ONES = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen"];
const TENS = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"];
const SCALES: Array<[number, string]> = [
  [1e12, "trillion"],
  [1e9, "billion"],
  [1e6, "million"],
  [1e3, "thousand"],
];
function intWords(n: number): string[] {
  if (n < 20) return [ONES[n]!];
  if (n < 100) return [TENS[Math.floor(n / 10)]!, ...(n % 10 ? [ONES[n % 10]!] : [])];
  if (n < 1000) return [ONES[Math.floor(n / 100)]!, "hundred", ...(n % 100 ? intWords(n % 100) : [])];
  for (const [v, name] of SCALES) if (n >= v) return [...intWords(Math.floor(n / v)), name, ...(n % v ? intWords(n % v) : [])];
  return [String(n)];
}
const ORDINAL: Record<string, string> = { one: "first", two: "second", three: "third", five: "fifth", eight: "eighth", nine: "ninth", twelve: "twelfth" };
const ordinalOf = (w: string): string => ORDINAL[w] ?? (w.endsWith("y") ? `${w.slice(0, -1)}ieth` : `${w}th`);
/** A digit token ("20", "20.4", "-3", "1,000", "2nd") spelled out the way it's read aloud. */
function spell(tok: string): string[] | null {
  const m = /^(-?)(\d{1,15})(?:\.(\d+))?(st|nd|rd|th)?$/.exec(tok);
  if (!m) return null;
  const out = [...(m[1] ? ["minus"] : []), ...intWords(Number(m[2]))];
  if (m[3]) out.push("point", ...[...m[3]].map((d) => ONES[Number(d)]!));
  if (m[4] && !m[3]) out.push(ordinalOf(out.pop()!));
  return out;
}
const NUMBER_WORDS = new Set([...ONES, ...TENS.filter(Boolean), "hundred", "thousand", "million", "billion", "trillion", "point", "minus"]);
const isNumberWord = (w: string): boolean => NUMBER_WORDS.has(w) || [...NUMBER_WORDS].some((n) => n !== "point" && n !== "minus" && ordinalOf(n) === w);

/** Words as they'd be heard: lower-case, no punctuation, digits spelled out ("20.4" → twenty point
 *  four), and the British "hundred AND five" treated like "hundred five". */
export function spokenWords(s: string): string[] {
  const raw = s
    .toLowerCase()
    .replace(/[’']/g, "")
    .replace(/(\d),(?=\d{3}\b)/g, "$1") // 1,000 → 1000
    .replace(/(^|[^\p{L}\p{N}.])-(?=\d)/gu, "$1 -") // keep a leading minus attached to its number
    .replace(/[^\p{L}\p{N}.-]+/gu, " ")
    .split(" ")
    .flatMap((t) => {
      const tok = t.replace(/^[.-]+(?!\d)|[.]+$/g, "");
      if (!tok) return [];
      return spell(tok) ?? tok.split(/[.-]+/).filter(Boolean);
    });
  return raw.filter((w, i) => !(w === "and" && i > 0 && isNumberWord(raw[i - 1]!) && i + 1 < raw.length && isNumberWord(raw[i + 1]!)));
}

/** Word-level similarity in [0, 1]: 1 − edit distance over the longer word count, on spokenWords. */
export function wordSimilarity(a: string, b: string): number {
  const x = spokenWords(a);
  const y = spokenWords(b);
  if (!x.length && !y.length) return 1;
  let prev = Array.from({ length: y.length + 1 }, (_, j) => j);
  for (let i = 1; i <= x.length; i++) {
    const cur = [i];
    for (let j = 1; j <= y.length; j++) cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (x[i - 1] === y[j - 1] ? 0 : 1));
    prev = cur;
  }
  return 1 - prev[y.length]! / Math.max(x.length, y.length);
}
export const VERBATIM_MIN = 0.95;

/** Strict for tutoring: every number must be read exactly (a wrong number is a wrong answer, however
 *  similar the rest), and otherwise at least 95% of the words must match. "20" read as "twenty" is
 *  the same number; "20" read as "twelve" is not. */
export function verbatim(text: string, transcript: string): { ok: boolean; why: string } {
  const nums = (s: string) => spokenWords(s).filter(isNumberWord).join(" ");
  const want = nums(text);
  const got = nums(transcript);
  if (want !== got) return { ok: false, why: `numbers differ: want "${want}", heard "${got}"` };
  const sim = wordSimilarity(text, transcript);
  return sim < VERBATIM_MIN ? { ok: false, why: `similarity ${sim.toFixed(2)}` } : { ok: true, why: "" };
}

// ---------- the call ----------

/** Past this much decoded audio (~170 s, far beyond a 1500-character line) the stream is abandoned. */
export const MAX_PCM_BYTES = 8 * 1024 * 1024;

/** What a call probably cost when the stream never reported usage (cut off, timed out, too big).
 *  Measured: ~14 characters of text per second of speech and ~25 completion tokens per second of
 *  audio (6.2 s → 156 tokens). Takes the larger of what arrived and what the whole line would be. */
export function estimateUsage(text: string, pcmBytes: number): SpeechUsage {
  const seconds = Math.max(pcmBytes / (IN_RATE * 2), text.length / 14);
  return { promptTokens: Math.ceil((SYSTEM.length + text.length) / 4), completionTokens: Math.ceil(seconds * 25) };
}

export type OrSpeechResult =
  | { ok: true; wav: Uint8Array; transcript: string; usage: SpeechUsage | null }
  /** `reason` says why the caller should fall back; `usage` is set when the call was billed anyway
   *  (`estimated` when the stream never said, so a timeout isn't free). */
  | { ok: false; reason: "not_verbatim" | "error" | "timeout"; detail: string; usage: SpeechUsage | null; estimated?: boolean };

export async function orSpeak(opts: {
  text: string;
  voice: string; // a gpt-audio voice (mapOrVoice)
  timeoutMs?: number;
  maxPcmBytes?: number;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}): Promise<OrSpeechResult> {
  const { text, voice, timeoutMs = 15_000, maxPcmBytes = MAX_PCM_BYTES, fetchImpl = fetch } = opts;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(new Error("timeout")), timeoutMs);
  const onAbort = () => ac.abort(new Error("cancelled"));
  opts.signal?.addEventListener("abort", onAbort, { once: true });
  const s = new AudioStream();
  let sent = false; // the request reached OpenRouter, so it may be billed
  const billed = () => (s.usage ? { usage: s.usage } : sent ? { usage: estimateUsage(text, s.bytes), estimated: true } : { usage: null });
  try {
    const req = fetchImpl(`${PROVIDERS.openrouter.baseURL}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${providerKey("openrouter") ?? ""}` },
      body: JSON.stringify({
        model: OR_SPEECH_MODEL,
        stream: true,
        modalities: ["text", "audio"],
        audio: { voice, format: "pcm16" },
        usage: { include: true },
        messages: [
          { role: "system", content: SYSTEM },
          { role: "user", content: text },
        ],
      }),
      signal: ac.signal,
    });
    sent = true;
    const res = await req;
    if (!res.ok || !res.body) {
      sent = false; // an error status is not a generation
      const body = await res.text().catch(() => "");
      return { ok: false, reason: "error", detail: `HTTP ${res.status}: ${body.slice(0, 200)}`, usage: null };
    }
    const dec = new TextDecoder();
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      s.push(dec.decode(chunk, { stream: true }));
      if (s.bytes > maxPcmBytes) {
        ac.abort(new Error("too big"));
        return { ok: false, reason: "error", detail: `stream over ${maxPcmBytes} bytes of audio — abandoned`, ...billed() };
      }
    }
    s.end();
  } catch (e) {
    const why = String((ac.signal.reason as Error | undefined)?.message);
    const timedOut = ac.signal.aborted && why === "timeout";
    return { ok: false, reason: timedOut ? "timeout" : "error", detail: e instanceof Error ? e.message : String(e), ...billed() };
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener("abort", onAbort);
  }
  if (s.error) return { ok: false, reason: "error", detail: s.error, ...billed() };
  const pcm = s.pcm();
  if (pcm.length < 2) return { ok: false, reason: "error", detail: "no audio in the stream", ...billed() };
  const v = verbatim(text, s.transcript);
  if (!v.ok) return { ok: false, reason: "not_verbatim", detail: `${v.why}: ${JSON.stringify(s.transcript.slice(0, 160))}`, ...billed() };
  return { ok: true, wav: pcm24ToWav16(pcm), transcript: s.transcript, usage: s.usage ?? estimateUsage(text, pcm.length) };
}
