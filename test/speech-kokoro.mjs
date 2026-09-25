// Ada Tutor server speech, the pure parts: request validation, the voice map, the per-user rate
// limit, the byte-budgeted LRU, 24→16 kHz downsampling and the WAV header, and the worker client's
// queue/timeout/exit handling against a fake child process. No model needed.
//   run: node --import tsx test/speech-kokoro.mjs
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, readdirSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const base = resolve(import.meta.dirname, "..");
const S = await import(pathToFileURL(join(base, "src/server/speech-kokoro.ts")).href);
const W = await import(pathToFileURL(join(base, "src/server/wav.mjs")).href);

// --- validation + voices ------------------------------------------------------
assert.deepEqual(S.validateSpeech({ text: "  Hello.  ", voice: "echo" }), { ok: true, text: "Hello.", voice: "am_michael" });
assert.equal(S.validateSpeech({ text: "Hi", voice: "made-up" }).voice, "af_heart", "unknown voice → the default");
assert.equal(S.validateSpeech({ text: "Hi", voice: "constructor" }).voice, "af_heart", "prototype keys are not voices");
assert.equal(S.validateSpeech({ text: "Hi" }).voice, "af_heart");
assert.equal(S.validateSpeech({ text: "x".repeat(1500) }).ok, true, "1500 characters is allowed");
assert.equal(S.validateSpeech({ text: "x".repeat(1501) }).ok, false, "1501 is not");
assert.equal(S.validateSpeech({ text: "   " }).ok, false);
assert.equal(S.validateSpeech({ text: 5 }).ok, false);
assert.equal(S.validateSpeech(null).ok, false);
assert.equal(S.validateSpeech([]).ok, false);
assert.equal(Object.keys(S.VOICE_MAP).length, 11, "same eleven voices as the app");
assert.notEqual(S.cacheKey("af_heart", "a"), S.cacheKey("af_bella", "a"), "the key includes the voice");

// --- rate limit -----------------------------------------------------------------
{
  const rl = new S.RateLimiter(3);
  const t = 1_000_000;
  assert.ok(rl.take("u", t) && rl.take("u", t + 1) && rl.take("u", t + 2));
  assert.equal(rl.take("u", t + 3), false, "the 4th in a minute is refused");
  assert.ok(rl.take("v", t + 3), "limits are per user");
  assert.equal(rl.retryAfter("u", t + 3), 60);
  assert.equal(rl.take("u", t + 59_999), false, "still inside the window");
  assert.ok(rl.take("u", t + 60_000), "the oldest hit has aged out");
}

// --- LRU ------------------------------------------------------------------------
{
  const c = new S.LruBytes(10);
  c.set("a", new Uint8Array(4));
  c.set("b", new Uint8Array(4));
  c.get("a"); // a is now most recent
  c.set("c", new Uint8Array(4)); // 12 > 10 → evict the least recent (b)
  assert.ok(c.get("a") && c.get("c") && !c.get("b"));
  assert.equal(c.size, 8);
  c.set("huge", new Uint8Array(11));
  assert.equal(c.get("huge"), undefined, "an entry larger than the budget is not kept");
  c.set("a", new Uint8Array(2));
  assert.equal(c.size, 6, "replacing an entry re-counts its bytes");
}

// --- resample + WAV -------------------------------------------------------------
{
  const sine = new Float32Array(24_000).map((_, i) => Math.sin((2 * Math.PI * 440 * i) / 24_000) * 0.5);
  const out = W.resample(sine, 24_000, 16_000);
  assert.equal(out.length, 16_000, "one second stays one second");
  // A 440 Hz tone survives: compare against the ideal 16 kHz sine (box filter attenuates it slightly).
  let err = 0;
  for (let i = 0; i < out.length; i++) err += Math.abs(out[i] - Math.sin((2 * Math.PI * 440 * (i * 1.5 + 0.25)) / 24_000) * 0.5);
  assert.ok(err / out.length < 0.02, `tone preserved (mean error ${(err / out.length).toFixed(4)})`);
  assert.deepEqual([...W.resample(new Float32Array([0.25, 0.25, 0.25]), 24_000, 16_000)], [0.25, 0.25], "DC stays DC");
  assert.equal(W.resample(new Float32Array(3), 16_000, 16_000).length, 3);
  // Anti-aliasing: what can't exist at 16 kHz (above 8 kHz) is filtered, not folded back as hiss.
  const rms = (a) => Math.sqrt(a.reduce((q, x) => q + x * x, 0) / a.length);
  const db = (f) => {
    const x = new Float32Array(24_000).map((_, i) => Math.sin((2 * Math.PI * f * i) / 24_000) * 0.5);
    return 20 * Math.log10(rms(W.resample(x, 24_000, 16_000).slice(20, -20)) / rms(x));
  };
  assert.ok(Math.abs(db(440)) < 0.5 && Math.abs(db(3000)) < 0.5, "the voice band passes");
  assert.ok(db(9000) < -15, `9 kHz attenuated (${db(9000).toFixed(1)} dB)`);
  assert.ok(db(11_000) < -40, `11 kHz attenuated (${db(11_000).toFixed(1)} dB)`);
  assert.equal(W.resample(new Float32Array(2), 8_000, 16_000).length, 4, "upsampling works too");

  const wav = W.pcm16Wav(out, 16_000);
  const v = new DataView(wav.buffer);
  const tag = (o) => String.fromCharCode(...wav.slice(o, o + 4));
  assert.equal(tag(0), "RIFF");
  assert.equal(tag(8), "WAVE");
  assert.equal(v.getUint16(22, true), 1, "mono");
  assert.equal(v.getUint32(24, true), 16_000, "16 kHz");
  assert.equal(v.getUint32(28, true), 32_000, "≈32 KB per second");
  assert.equal(v.getUint16(34, true), 16, "16-bit");
  assert.equal(wav.length, 44 + 32_000);
  const clip = W.pcm16Wav(new Float32Array([2, -2]), 16_000);
  assert.deepEqual([new DataView(clip.buffer).getInt16(44, true), new DataView(clip.buffer).getInt16(46, true)], [32767, -32768], "clipped, not wrapped");
  assert.equal(W.looksCorrupt({ size: 1000 }), true);
  assert.equal(W.looksCorrupt({ size: 92_000_000, message: "libonnxruntime.so: cannot open" }), false);
}

// --- worker client --------------------------------------------------------------
function fakeChild(behave) {
  const c = new EventEmitter();
  c.sent = [];
  c.send = (m) => {
    c.sent.push(m);
    behave(c, m);
  };
  return c;
}
{
  // replies in order, one at a time
  let inFlight = 0;
  let maxInFlight = 0;
  const children = [];
  const synth = S.createSynth({
    spawn: () => {
      const c = fakeChild((c, m) => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        setTimeout(() => {
          inFlight--;
          c.emit("message", { id: m.id, ok: true, wav: new Uint8Array([m.text.length]) });
        }, 5);
      });
      children.push(c);
      return c;
    },
  });
  const got = await Promise.all(["a", "bb", "ccc"].map((t) => synth("af_heart", t)));
  assert.deepEqual(got.map((b) => b[0]), [1, 2, 3]);
  assert.equal(maxInFlight, 1, "one line at the worker at a time");
  assert.equal(children.length, 1, "the worker is reused");
}
{
  // a worker that dies takes its request with it; the next call forks a fresh one
  let n = 0;
  const synth = S.createSynth({
    spawn: () => {
      const k = ++n;
      return fakeChild((c, m) => setTimeout(() => (k === 1 ? c.emit("exit", 1) : c.emit("message", { id: m.id, ok: true, wav: new Uint8Array([9]) })), 1));
    },
  });
  await assert.rejects(synth("v", "x"), /exited/);
  assert.deepEqual([...(await synth("v", "y"))], [9]);
  assert.equal(n, 2);
}
{
  // timeout: rejected, and a late reply is ignored rather than answering the next request
  let first = true;
  const synth = S.createSynth({
    timeoutMs: 20,
    spawn: () =>
      fakeChild((c, m) => {
        if (first) {
          first = false;
          setTimeout(() => c.emit("message", { id: m.id, ok: true, wav: new Uint8Array([1]) }), 60);
        } else setTimeout(() => c.emit("message", { id: m.id, ok: true, wav: new Uint8Array([2]) }), 80);
      }),
  });
  await assert.rejects(synth("v", "slow"), /timed out/);
  const b = await S.createSynth({ spawn: () => fakeChild((c, m) => c.emit("message", { id: m.id, ok: false, error: "bad voice" })) })("v", "x").catch((e) => e);
  assert.match(b.message, /bad voice/, "worker errors surface");
}
{
  // back-pressure: past maxWaiting the call fails fast
  const synth = S.createSynth({ maxWaiting: 2, spawn: () => fakeChild(() => {}) , timeoutMs: 50 });
  const p = [synth("v", "1"), synth("v", "2"), synth("v", "3")]; // 1 at worker, 2 waiting
  await assert.rejects(synth("v", "4"), /busy/);
  await Promise.allSettled(p);
}

// --- disk prune -----------------------------------------------------------------
{
  const dir = mkdtempSync(join(tmpdir(), "ada-tts-prune-"));
  for (let i = 0; i < 5; i++) {
    const p = join(dir, `${i}.wav`);
    writeFileSync(p, Buffer.alloc(100));
    utimesSync(p, 1000 + i, 1000 + i);
  }
  writeFileSync(join(dir, "keep.txt"), "x");
  assert.equal(S.prune(dir, 250), 3, "oldest first until under budget");
  assert.deepEqual(readdirSync(dir).sort(), ["3.wav", "4.wav", "keep.txt"]);
}

console.log("ok");
