// Real Kokoro synthesis through the forked worker — the one test that needs the ~90 MB model.
// Runs when the model is already on disk (ADA_KOKORO_DIR, default ~/.ada/kokoro), or when
// ADA_KOKORO_REAL=1 allows downloading it; otherwise it skips. A failed download also skips —
// this checks the voice works, not that the network does.
//   run: node --import tsx test/speech-kokoro-real.mjs
//   ADA_KOKORO_REAL=1 node --import tsx test/speech-kokoro-real.mjs   (downloads if needed)
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const dir = process.env.ADA_KOKORO_DIR || join(homedir(), ".ada", "kokoro");
const onDisk = existsSync(join(dir, "onnx-community", "Kokoro-82M-v1.0-ONNX", "onnx", "model_quantized.onnx"));
if (!onDisk && process.env.ADA_KOKORO_REAL !== "1") {
  console.log(`skip: no Kokoro model in ${dir} (set ADA_KOKORO_REAL=1 to download ~90 MB)`);
  process.exit(0);
}

const base = resolve(import.meta.dirname, "..");
const S = await import(pathToFileURL(join(base, "src/server/speech-kokoro.ts")).href);
const started = Date.now();
let wav;
try {
  wav = await S.speechEngine.synth("af_heart", "Two plus two is four. Let's check it on the board.");
} catch (e) {
  if (!onDisk) {
    console.log(`skip: model download failed (${e.message})`);
    process.exit(0);
  }
  throw e;
}
const v = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
assert.equal(String.fromCharCode(...wav.slice(0, 4)), "RIFF");
assert.equal(v.getUint16(22, true), 1, "mono");
assert.equal(v.getUint32(24, true), 16_000, "16 kHz");
assert.equal(v.getUint16(34, true), 16, "16-bit");
const seconds = (wav.length - 44) / 32_000;
assert.ok(seconds > 1.5 && seconds < 15, `a sentence-length clip (${seconds.toFixed(2)} s)`);
let peak = 0;
for (let i = 44; i + 1 < wav.length; i += 2) peak = Math.max(peak, Math.abs(v.getInt16(i, true)));
assert.ok(peak > 1000, "not silence");

const t2 = Date.now();
await S.speechEngine.synth("am_michael", "Second line, warm worker.");
console.log(`ok (${seconds.toFixed(2)} s of audio, ${wav.length} bytes; first ${Date.now() - started - (Date.now() - t2)} ms incl. load, second ${Date.now() - t2} ms)`);
process.exit(0); // the forked worker keeps the event loop alive
