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
    if (a?.data) this.chunks.push(Buffer.from(a.data, "base64"));
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

const words = (s: string): string[] =>
  s
    .toLowerCase()
    .replace(/[’']/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .split(" ")
    .filter(Boolean);

/** Word-level similarity in [0, 1]: 1 − edit distance over the longer word count. Punctuation and
 *  case never count; a dropped, added or changed word does. */
export function wordSimilarity(a: string, b: string): number {
  const x = words(a);
  const y = words(b);
  if (!x.length && !y.length) return 1;
  let prev = Array.from({ length: y.length + 1 }, (_, j) => j);
  for (let i = 1; i <= x.length; i++) {
    const cur = [i];
    for (let j = 1; j <= y.length; j++) cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (x[i - 1] === y[j - 1] ? 0 : 1));
    prev = cur;
  }
  return 1 - prev[y.length]! / Math.max(x.length, y.length);
}
export const VERBATIM_MIN = 0.9;

// ---------- the call ----------

export type OrSpeechResult =
  | { ok: true; wav: Uint8Array; transcript: string; usage: SpeechUsage | null }
  /** `reason` says why the caller should fall back; `usage` is set when the call was billed anyway. */
  | { ok: false; reason: "not_verbatim" | "error" | "timeout"; detail: string; usage: SpeechUsage | null };

export async function orSpeak(opts: {
  text: string;
  voice: string; // a gpt-audio voice (mapOrVoice)
  timeoutMs?: number;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}): Promise<OrSpeechResult> {
  const { text, voice, timeoutMs = 15_000, fetchImpl = fetch } = opts;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(new Error("timeout")), timeoutMs);
  const onAbort = () => ac.abort(new Error("cancelled"));
  opts.signal?.addEventListener("abort", onAbort, { once: true });
  const s = new AudioStream();
  try {
    const res = await fetchImpl(`${PROVIDERS.openrouter.baseURL}/chat/completions`, {
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
    if (!res.ok || !res.body) {
      const body = await res.text().catch(() => "");
      return { ok: false, reason: "error", detail: `HTTP ${res.status}: ${body.slice(0, 200)}`, usage: null };
    }
    const dec = new TextDecoder();
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) s.push(dec.decode(chunk, { stream: true }));
    s.end();
  } catch (e) {
    const timedOut = ac.signal.aborted && String((ac.signal.reason as Error | undefined)?.message) === "timeout";
    return { ok: false, reason: timedOut ? "timeout" : "error", detail: e instanceof Error ? e.message : String(e), usage: s.usage };
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener("abort", onAbort);
  }
  if (s.error) return { ok: false, reason: "error", detail: s.error, usage: s.usage };
  const pcm = s.pcm();
  if (pcm.length < 2) return { ok: false, reason: "error", detail: "no audio in the stream", usage: s.usage };
  const sim = wordSimilarity(text, s.transcript);
  if (sim < VERBATIM_MIN) {
    return { ok: false, reason: "not_verbatim", detail: `similarity ${sim.toFixed(2)}: ${JSON.stringify(s.transcript.slice(0, 160))}`, usage: s.usage };
  }
  return { ok: true, wav: pcm24ToWav16(pcm), transcript: s.transcript, usage: s.usage };
}
