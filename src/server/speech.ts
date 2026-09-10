/**
 * /v1/audio/speech — cloud narration for Ada's classroom. Pure request shaping lives here so it is
 * testable without a socket; the handler in index.ts does the forwarding and metering.
 */
export const SPEECH_MODEL = "gpt-4o-mini-tts";
export const SPEECH_MAX_CHARS = 4096; // OpenAI's per-request limit
export const SPEECH_VOICES = ["alloy", "ash", "ballad", "coral", "echo", "fable", "nova", "onyx", "sage", "shimmer", "verse"] as const;
const DEFAULT_VOICE = "nova";

export type SpeechRequest =
  | { ok: true; input: string; voice: string; model: string; response_format: "mp3" }
  | { ok: false; status: number; message: string };

export function buildSpeechRequest(body: unknown): SpeechRequest {
  if (!body || typeof body !== "object") return { ok: false, status: 400, message: "invalid JSON body" };
  const b = body as Record<string, unknown>;
  const input = typeof b.input === "string" ? b.input.trim() : "";
  if (!input) return { ok: false, status: 400, message: "missing 'input'" };
  if (input.length > SPEECH_MAX_CHARS) return { ok: false, status: 413, message: `'input' exceeds ${SPEECH_MAX_CHARS} characters` };
  const voice = typeof b.voice === "string" && (SPEECH_VOICES as readonly string[]).includes(b.voice) ? b.voice : DEFAULT_VOICE;
  // One model, one container: the caller does not pick them, so the price is the price.
  return { ok: true, input, voice, model: SPEECH_MODEL, response_format: "mp3" };
}
