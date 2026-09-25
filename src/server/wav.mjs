// Pure audio helpers for server speech (Ada Tutor). Plain JS so the Kokoro worker — a plain Node
// child process, no tsx loader — can import them, and so can the tests.

/** Downsample (or upsample) mono float PCM. Kokoro speaks at 24 kHz; the phone gets 16 kHz, which
 *  is a third fewer bytes and still clear for a voice. Downsampling is a 15-tap Blackman-windowed
 *  sinc low-pass centred on each output instant, cut off just under the new Nyquist (8 kHz), so
 *  the 8–12 kHz band Kokoro produces is filtered out instead of folding back as hiss. The taps are
 *  normalised per sample, which keeps DC exact and the edges sane. */
const TAPS = 15;
const HALF = (TAPS - 1) / 2;
export function resample(samples, from, to) {
  if (!(from > 0) || !(to > 0)) throw new Error('bad sample rate');
  if (from === to) return Float32Array.from(samples);
  const ratio = from / to;
  const n = Math.floor(samples.length / ratio);
  const out = new Float32Array(n);
  if (ratio > 1) {
    const fc = 0.45 / ratio; // cycles per input sample: 0.9 × the output Nyquist
    for (let i = 0; i < n; i++) {
      const t = i * ratio;
      const lo = Math.max(0, Math.ceil(t - HALF));
      const hi = Math.min(samples.length - 1, Math.floor(t + HALF));
      let acc = 0;
      let w = 0;
      for (let j = lo; j <= hi; j++) {
        const x = j - t;
        const sinc = x === 0 ? 1 : Math.sin(2 * Math.PI * fc * x) / (2 * Math.PI * fc * x);
        const p = (x + HALF + 1) / (TAPS + 1); // window position in (0, 1)
        const win = 0.42 - 0.5 * Math.cos(2 * Math.PI * p) + 0.08 * Math.cos(4 * Math.PI * p);
        const k = sinc * win;
        acc += samples[j] * k;
        w += k;
      }
      out[i] = w ? acc / w : 0;
    }
  } else {
    for (let i = 0; i < n; i++) {
      const t = i * ratio;
      const j = Math.floor(t);
      const f = t - j;
      const a = samples[j] ?? 0;
      const b = samples[j + 1] ?? a;
      out[i] = a + (b - a) * f;
    }
  }
  return out;
}

/** 16-bit mono PCM WAV (the app's electron/wav.js, ported). */
export function pcm16Wav(samples, sampleRate) {
  const bytes = samples.length * 2;
  const v = new DataView(new ArrayBuffer(44 + bytes));
  const ascii = (o, s) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  ascii(0, 'RIFF');
  v.setUint32(4, 36 + bytes, true);
  ascii(8, 'WAVE');
  ascii(12, 'fmt ');
  v.setUint32(16, 16, true); // fmt chunk size
  v.setUint16(20, 1, true); // PCM
  v.setUint16(22, 1, true); // mono
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * 2, true); // byte rate
  v.setUint16(32, 2, true); // block align
  v.setUint16(34, 16, true); // bits per sample
  ascii(36, 'data');
  v.setUint32(40, bytes, true);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    v.setInt16(44 + i * 2, Math.round(s < 0 ? s * 0x8000 : s * 0x7fff), true);
  }
  return new Uint8Array(v.buffer);
}

/** Whether a failed model load means the cached file itself is bad (safe to delete and download
 *  again) rather than a platform failure that would re-download ~90 MB on every line. */
const MIN_OK_SIZE = 80_000_000; // the real q8 file is ~92 MB; a truncated download lands well under
const CORRUPT_MESSAGE = /protobuf|parse|invalid (model|protobuf|onnx|graph)|corrupt|failed to load model|load model/i;
export function looksCorrupt({ size, message }) {
  if (typeof size === 'number' && size < MIN_OK_SIZE) return true;
  return CORRUPT_MESSAGE.test(String(message || ''));
}
