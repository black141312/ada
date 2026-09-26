// Types for wav.mjs (plain JS so the Kokoro worker can import it without a TS loader).
export function resample(samples: ArrayLike<number>, from: number, to: number): Float32Array;
export function pcm16Wav(samples: ArrayLike<number>, sampleRate: number): Uint8Array;
export function looksCorrupt(x: { size?: number; message?: string }): boolean;
