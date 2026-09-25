// Kokoro-82M in its own process (Ada Tutor server speech) — the app's electron/kokoro-worker.mjs,
// ported. The parent (speech-kokoro.ts) forks this with child_process and posts { id, voice, text };
// it answers { id, ok, wav } with a 16 kHz mono 16-bit WAV. Requests run one at a time.
//
// Also imported directly (not forked) by the Dockerfile's bake step, which calls load() + synth()
// once so the ~90 MB model ships inside the image and a cold start never downloads it.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { KokoroTTS, TextSplitterStream } from 'kokoro-js';
import { looksCorrupt, pcm16Wav, resample } from './wav.mjs';

export const MODEL = 'onnx-community/Kokoro-82M-v1.0-ONNX';
export const OUT_RATE = 16_000;

// kokoro-js pins transformers 3.x; cos0 itself depends on 4.x, so npm nests kokoro's copy. Setting
// cacheDir on the top-level `env` would configure the WRONG instance and the model would land in
// node_modules. Import the exact ESM file kokoro-js resolves, which is the same module instance.
async function kokoroEnv() {
  const req = createRequire(fileURLToPath(import.meta.resolve('kokoro-js')));
  const cjs = req.resolve('@huggingface/transformers');
  const esm = cjs.replace(/\.cjs$/, '.mjs');
  return (await import(fs.existsSync(esm) ? pathToFileURL(esm).href : '@huggingface/transformers')).env;
}
const env = await kokoroEnv();
env.cacheDir = process.env.ADA_KOKORO_DIR || path.join(os.homedir(), '.ada', 'kokoro');
export const modelDir = () => path.join(env.cacheDir, MODEL);

let model = null;
export function load() {
  if (!model) {
    const quantizedPath = path.join(modelDir(), 'onnx', 'model_quantized.onnx');
    model = KokoroTTS.from_pretrained(MODEL, { dtype: 'q8', device: 'cpu' }).catch((err) => {
      model = null; // offline on first use: the next request tries again
      // A download cut short leaves a truncated file that fails every load forever — drop it, but
      // only when the file actually looks corrupt (a platform failure isn't the file's fault).
      const size = fs.existsSync(quantizedPath) ? fs.statSync(quantizedPath).size : undefined;
      if (looksCorrupt({ size, message: err?.message })) {
        try {
          fs.rmSync(modelDir(), { recursive: true, force: true });
        } catch {}
      }
      throw err;
    });
  }
  return model;
}

// generate() truncates at 510 tokens, so speak sentence by sentence and join. The splitter must be
// closed or the stream waits for more text forever.
export async function synth(voice, text) {
  const tts = await load();
  const splitter = new TextSplitterStream();
  splitter.push(text);
  splitter.close();
  const parts = [];
  let rate = 24000;
  for await (const { audio } of tts.stream(splitter, { voice })) {
    parts.push(audio.audio);
    rate = audio.sampling_rate;
  }
  const all = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    all.set(p, o);
    o += p.length;
  }
  return pcm16Wav(resample(all, rate, OUT_RATE), OUT_RATE);
}

// Forked: speak the parent's protocol. Imported (bake step, tests): do nothing.
if (process.send) {
  let queue = Promise.resolve();
  process.on('message', (m) => {
    queue = queue.then(async () => {
      try {
        process.send({ id: m.id, ok: true, wav: await synth(m.voice, m.text) });
      } catch (err) {
        process.send({ id: m.id, ok: false, error: String(err?.message || err).slice(0, 300) });
      }
    });
  });
  // The parent going away must take this process with it, not leave a 300 MB orphan.
  process.on('disconnect', () => process.exit(0));
}
