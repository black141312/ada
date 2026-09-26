// Ada Tutor voice via OpenRouter's gpt-audio-mini, Kokoro kept as the fallback: provider choice, the
// voice map, SSE audio parsing, the verbatim guard, timeouts, and — over HTTP against a fake
// OpenRouter — who pays (institute / own plan / nobody → Kokoro), metering rows, the cache, the
// per-user in-flight limit, and falling back to Kokoro when a line isn't read verbatim.
//   run: node --import tsx test/speech-openrouter.mjs
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const dir = mkdtempSync(join(tmpdir(), "ada-or-speech-"));
for (const k of ["DATABASE_URL", "ADA_FREE_TIER", "ADA_ADMIN_KEY", "ADA_ADMIN_USERS", "ADA_ALLOWED_USERS", "ADA_UPSTREAM_URL", "BETTER_AUTH_ENABLED", "ADA_OIDC_ISSUER", "ADA_FREE_MODELS", "ADA_TTS_CACHE_DIR", "ADA_SPEECH_PROVIDER"]) delete process.env[k];
process.env.ADA_CLIENT_KEYS = "student-key";
process.env.ADA_DATA_DIR = dir;
process.env.ADA_AUTH_DB = join(dir, "auth.db");
process.env.ADA_SPEECH_PER_MINUTE = "1000";
process.env.HOME = process.env.USERPROFILE = dir;
process.env.OPENROUTER_API_KEY = "test-key";
process.chdir(dir);

const base = resolve(import.meta.dirname, "..");
const mod = (p) => import(pathToFileURL(join(base, p)).href);
const O = await mod("src/server/speech-openrouter.ts");

// ---------- a fake SSE body ----------
const pcmB64 = (samples) => {
  const b = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++) b.writeInt16LE(Math.round(Math.sin(i / 10) * 8000), i * 2);
  return b.toString("base64");
};
const sse = (transcript, { audio = 24_000, usage = { prompt_tokens: 40, completion_tokens: 120 }, error } = {}) => {
  const ev = [];
  ev.push({ choices: [{ delta: { role: "assistant" } }] });
  const words = transcript.split(" ");
  const per = Math.floor(audio / words.length);
  words.forEach((w, i) => ev.push({ choices: [{ delta: { audio: { data: pcmB64(per), transcript: (i ? " " : "") + w } } }] }));
  if (error) ev.push({ error });
  if (usage) ev.push({ choices: [], usage });
  return ev.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("") + ": keep-alive\n\ndata: [DONE]\n\n";
};

// --- provider selection -----------------------------------------------------------------------
const S = await mod("src/server/speech-kokoro.ts");
assert.equal(S.speechProvider({ OPENROUTER_API_KEY: "k" }), "openrouter", "a key means OpenRouter by default");
assert.equal(S.speechProvider({}), "kokoro", "no key → Kokoro");
assert.equal(S.speechProvider({ OPENROUTER_API_KEY: "k", ADA_SPEECH_PROVIDER: "kokoro" }), "kokoro", "the env forces it");
assert.equal(S.speechProvider({ ADA_SPEECH_PROVIDER: "openrouter" }), "openrouter");
assert.equal(S.speechProvider({ OPENROUTER_API_KEY: "k", ADA_SPEECH_PROVIDER: "nonsense" }), "openrouter", "an unknown value falls back to the default");
assert.notEqual(S.speechKey("openrouter", "marin", "hi"), S.speechKey("kokoro", "marin", "hi"), "the key names the engine");

// --- voices -------------------------------------------------------------------------------------
const GPT_VOICES = new Set(["alloy", "ash", "ballad", "coral", "echo", "sage", "shimmer", "verse", "marin", "cedar"]);
for (const name of Object.keys(S.VOICE_MAP)) assert.ok(GPT_VOICES.has(O.mapOrVoice(name)), `${name} → a real gpt-audio voice`);
assert.equal(new Set(Object.keys(S.VOICE_MAP).map(O.mapOrVoice)).size, 10, "eleven lesson voices use all ten gpt-audio voices");
assert.equal(O.mapOrVoice("nova"), "marin", "the default teacher");
assert.equal(O.mapOrVoice("whatever"), "marin");
assert.equal(O.mapOrVoice("constructor"), "marin");

// --- SSE parsing --------------------------------------------------------------------------------
{
  const s = new O.AudioStream();
  const body = sse("Two plus two is four.", { audio: 2400 });
  for (let i = 0; i < body.length; i += 37) s.push(body.slice(i, i + 37)); // torn across chunk edges
  s.end();
  assert.equal(s.transcript, "Two plus two is four.");
  assert.equal(s.pcm().length, 2 * 2400 - (2400 % 5) * 2, "all audio deltas, in order");
  assert.deepEqual(s.usage, { promptTokens: 40, completionTokens: 120 });
  assert.equal(s.error, null);
  const bad = new O.AudioStream();
  bad.push(sse("x", { error: { message: "upstream exploded" } }));
  bad.end();
  assert.match(bad.error, /exploded/);
  const wav = O.pcm24ToWav16(Buffer.from(pcmB64(24_000), "base64"));
  assert.equal(new DataView(wav.buffer).getUint32(24, true), 16_000, "resampled to 16 kHz");
  assert.equal(wav.length, 44 + 16_000 * 2, "one second in, one second out");
}

// --- verbatim guard -----------------------------------------------------------------------------
assert.equal(O.wordSimilarity("Two plus two is four.", "two plus two, is four"), 1, "case and punctuation don't count");
assert.equal(O.wordSimilarity("one two three four five six seven eight nine ten", "one two three four five six seven eight nine TEN!"), 1);
assert.equal(O.wordSimilarity("one two three four five six seven eight nine ten", "one two three four five six seven eight nine eleven"), 0.9);
assert.ok(O.wordSimilarity("The answer is four.", "Sure! The answer is four. Let me know if you need more help.") < O.VERBATIM_MIN, "chatter is caught");
assert.ok(O.wordSimilarity("The answer is four.", "") < O.VERBATIM_MIN);
assert.equal(O.VERBATIM_MIN, 0.95);

// numbers are heard, not spelled: digits and words compare equal; any different number fails
assert.deepEqual(O.spokenWords("v = 20.4 m/s, the 2nd time, -3 degrees, 1,000 items."), ["v", "twenty", "point", "four", "m", "s", "the", "second", "time", "minus", "three", "degrees", "one", "thousand", "items"]);
assert.deepEqual(O.spokenWords("One hundred and five"), ["one", "hundred", "five"], "British 'and' inside a number is dropped");
assert.deepEqual(O.spokenWords("salt and pepper"), ["salt", "and", "pepper"], "an ordinary 'and' is kept");
assert.equal(O.verbatim("So v equals 20 metres per second.", "So v equals twenty metres per second.").ok, true, "20 read as twenty");
assert.equal(O.verbatim("The height is 20.4 metres.", "The height is twenty point four metres.").ok, true);
assert.equal(O.verbatim("It is 105 grams.", "It is one hundred and five grams.").ok, true);
const TWELVE = "The mass is 12 kilograms and the speed is 5 metres per second.";
assert.match(O.verbatim(TWELVE, TWELVE.replace("12", "20")).why, /numbers differ/, "one changed number in a 12-word line fails");
assert.equal(O.verbatim(TWELVE, TWELVE.replace("12", "twelve")).ok, true);
assert.match(O.verbatim(TWELVE, TWELVE.replace("mass", "weight")).why, /similarity/, "one changed word in 12 (0.92) fails the 0.95 bar");
assert.equal(O.verbatim(TWELVE, "the mass is twelve kilograms, and the speed is five metres per second").ok, true, "case, commas and digits-as-words pass");
assert.equal(O.wordSimilarity("It's v squared.", "its v squared"), 1, "apostrophes don't count");

// --- orSpeak with a fake fetch ------------------------------------------------------------------
const streamOf = (text) => new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(text)); c.close(); } }), { status: 200 });
{
  let sent;
  const ok = await O.orSpeak({ text: "Two plus two is four.", voice: "marin", fetchImpl: async (url, init) => ((sent = { url, body: JSON.parse(init.body) }), streamOf(sse("Two plus two is four."))) });
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.usage, { promptTokens: 40, completionTokens: 120 });
  assert.match(sent.url, /\/chat\/completions$/);
  assert.equal(sent.body.model, "openai/gpt-audio-mini");
  assert.deepEqual(sent.body.audio, { voice: "marin", format: "pcm16" });
  assert.deepEqual(sent.body.modalities, ["text", "audio"]);
  assert.deepEqual(sent.body.usage, { include: true }, "usage is requested so the call can be metered");
  assert.equal(sent.body.stream, true);
  assert.equal(sent.body.messages[1].content, "Two plus two is four.");

  const misread = await O.orSpeak({ text: "Two plus two is four.", voice: "marin", fetchImpl: async () => streamOf(sse("Of course! Two plus two equals four, great question.")) });
  assert.equal(misread.ok, false);
  assert.equal(misread.reason, "not_verbatim");
  assert.ok(misread.usage, "a misread call was still billed — its usage comes back for metering");

  const http = await O.orSpeak({ text: "x", voice: "marin", fetchImpl: async () => new Response("nope", { status: 500 }) });
  assert.equal(http.reason, "error");
  const noAudio = await O.orSpeak({ text: "x", voice: "marin", fetchImpl: async () => streamOf(sse("x", { audio: 0 })) });
  assert.equal(noAudio.reason, "error");

  const t0 = Date.now();
  const hang = await O.orSpeak({
    text: "x",
    voice: "marin",
    timeoutMs: 60,
    fetchImpl: (_u, init) => new Promise((_r, reject) => init.signal.addEventListener("abort", () => reject(init.signal.reason))),
  });
  assert.equal(hang.reason, "timeout");
  assert.ok(Date.now() - t0 < 1000, "bounded by the timeout");
  assert.equal(hang.estimated, true, "a timed-out call isn't free: its usage is estimated");
  assert.ok(hang.usage.completionTokens > 0 && hang.usage.promptTokens > 0);

  // strict guard through orSpeak
  const wrongNumber = await O.orSpeak({ text: TWELVE, voice: "marin", fetchImpl: async () => streamOf(sse(TWELVE.replace("12", "20"))) });
  assert.equal(wrongNumber.ok, false, "a 12-word line with one changed number falls back");
  assert.equal(wrongNumber.reason, "not_verbatim");
  assert.equal(wrongNumber.estimated, undefined, "the stream's own usage is used when present");
  const spelled = await O.orSpeak({ text: "So v equals 20 metres per second.", voice: "marin", fetchImpl: async () => streamOf(sse("So v equals twenty metres per second.")) });
  assert.equal(spelled.ok, true, "20 read as twenty is accepted");

  // cut off mid-stream: some audio arrived, no usage → estimated from what arrived / the line
  const partial = await O.orSpeak({
    text: "A long line that never finishes.",
    voice: "marin",
    timeoutMs: 80,
    fetchImpl: async (_u, init) =>
      new Response(
        new ReadableStream({
          start(c) {
            c.enqueue(new TextEncoder().encode(sse("A long", { audio: 48_000, usage: null }).replace("data: [DONE]\n\n", "")));
            init.signal.addEventListener("abort", () => c.error(init.signal.reason));
          },
        }),
      ),
  });
  assert.equal(partial.reason, "timeout");
  assert.equal(partial.estimated, true);
  assert.ok(partial.usage.completionTokens >= 50, "at least the 2 s of audio that arrived");

  // byte cap: a runaway stream is abandoned and billed by estimate
  const runaway = await O.orSpeak({ text: "Short.", voice: "marin", maxPcmBytes: 10_000, fetchImpl: async () => streamOf(sse("Short.", { audio: 24_000, usage: null })) });
  assert.equal(runaway.ok, false);
  assert.match(runaway.detail, /abandoned/);
  assert.equal(runaway.estimated, true);
  assert.equal(O.MAX_PCM_BYTES, 8 * 1024 * 1024);
  // an HTTP error isn't a generation: nothing to bill
  assert.equal((await O.orSpeak({ text: "x", voice: "marin", fetchImpl: async () => new Response("no", { status: 502 }) })).usage, null);
}

// ---------- HTTP, against a fake OpenRouter ----------
const upstream = [];
let slow = 0;
const fake = createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", async () => {
    const b = JSON.parse(body);
    const text = b.messages[1].content;
    upstream.push(text);
    if (text.startsWith("hang")) {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(sse("hang", { audio: 2400, usage: null }).replace("data: [DONE]\n\n", ""));
      return; // never ends
    }
    if (text.startsWith("slow")) {
      slow++;
      await new Promise((r) => setTimeout(r, 300));
    }
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(sse(text.startsWith("chatty") ? "Sure thing! Here you go: " + text + " Anything else?" : text));
  });
});
await new Promise((r) => fake.listen(0, "127.0.0.1", r));
const { PROVIDERS } = await mod("src/server/config.ts");
PROVIDERS.openrouter.baseURL = `http://127.0.0.1:${fake.address().port}`;
const { createAdaServer } = await mod("src/server/index.ts");
const I = await mod("src/server/institutes.ts");
const { setPlan } = await mod("src/server/plans.ts");
const kokoro = [];
S.speechEngine.synth = async (voice, text) => (kokoro.push([voice, text]), new Uint8Array([82, 73, 70, 70, 1]));

const server = createAdaServer();
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const origin = `http://127.0.0.1:${server.address().port}`;
const speak = async (text, headers = {}, voice = "nova") => {
  const r = await fetch(origin + "/v1/tutor/speech", { method: "POST", headers: { authorization: "Bearer student-key", "content-type": "application/json", ...headers }, body: JSON.stringify({ text, voice }) });
  const buf = Buffer.from(await r.arrayBuffer());
  return { status: r.status, voice: r.headers.get("x-ada-voice"), cache: r.headers.get("x-ada-cache"), type: r.headers.get("content-type"), buf };
};
const db = () => new (createRequire(import.meta.url)(join(base, "node_modules/better-sqlite3")))(join(dir, "auth.db"), { readonly: true });
const rows = () => db().prepare("select user_id, model, provider, prompt_tokens, completion_tokens, institute from usage_events order by id").all();
const settle = () => new Promise((r) => setTimeout(r, 150));
const DEMO = { "x-ada-institute": "demo" };

try {
  await I.getInstitute("demo"); // seed

  // institute pays → OpenRouter audio, metered to the institute
  const a = await speak("The answer is four.", DEMO);
  assert.equal(a.status, 200);
  assert.equal(a.type, "audio/wav");
  assert.equal(a.voice, "openrouter");
  assert.equal(a.cache, "miss");
  assert.equal(new DataView(a.buf.buffer, a.buf.byteOffset).getUint32(24, true), 16_000, "same 16 kHz WAV contract");
  await settle();
  assert.deepEqual(rows(), [{ user_id: "team", model: "openai/gpt-audio-mini", provider: "openrouter", prompt_tokens: 40, completion_tokens: 120, institute: "demo" }]);
  assert.equal(kokoro.length, 0);

  // cached: no second upstream call, no second row
  const again = await speak("The answer is four.", DEMO);
  assert.equal(again.cache, "memory");
  assert.equal(again.voice, "openrouter");
  assert.equal(upstream.length, 1);
  await settle();
  assert.equal(rows().length, 1);
  assert.equal((await speak("The answer is four.", DEMO, "onyx")).cache, "miss", "another voice is another line");

  // not verbatim → Kokoro for that line, still metered, and the stand-in is cached
  const chatty = await speak("chatty line here.", DEMO);
  assert.equal(chatty.status, 200);
  assert.equal(chatty.voice, "kokoro");
  assert.deepEqual(kokoro.at(-1), ["af_heart", "chatty line here."]);
  await settle();
  assert.equal(rows().filter((r) => r.institute === "demo").length, 3, "the misread call was billed, so it's metered");
  const chatty2 = await speak("chatty line here.", DEMO);
  assert.equal(chatty2.cache, "memory");
  assert.equal(chatty2.voice, "kokoro", "the stand-in is reused, not paid for again");
  assert.equal(upstream.filter((t) => t.startsWith("chatty")).length, 1);

  // counts toward the institute's budget: over it → Kokoro, nothing sent upstream
  await I.putInstitute({ ...I.DEMO, dailyBudgetUsd: 0.0000001 });
  const n0 = upstream.length;
  const broke = await speak("Budget line.", DEMO);
  assert.equal(broke.voice, "kokoro");
  assert.equal(upstream.length, n0, "an institute over budget isn't billed for voice");
  await I.putInstitute(I.DEMO);

  // no institute: the user's own plan decides — free can't use it (→ Kokoro, unmetered) ...
  const own = await speak("My own line.");
  assert.equal(own.voice, "kokoro");
  assert.equal(upstream.includes("My own line."), false);
  // ... pro can, billed to the user
  await setPlan("team", "pro");
  const pro = await speak("Pro line.");
  assert.equal(pro.voice, "openrouter");
  await settle();
  assert.deepEqual(rows().at(-1), { user_id: "team", model: "openai/gpt-audio-mini", provider: "openrouter", prompt_tokens: 40, completion_tokens: 120, institute: null });

  // per-user in-flight limit: 3 OpenRouter lines at once, the 4th is refused
  const burst = await Promise.all([1, 2, 3, 4].map((n) => speak(`slow line ${n}.`, DEMO)));
  assert.equal(burst.filter((r) => r.status === 200).length, 3);
  assert.equal(burst.filter((r) => r.status === 429).length, 1);
  assert.equal(slow, 3);

  // a timed-out line is still metered (estimate) and falls back to Kokoro
  const realOr = S.speechEngine.or;
  S.speechEngine.or = (o) => O.orSpeak({ ...o, timeoutMs: 100 });
  const before = rows().length;
  const timedOut = await speak("hang here please.", DEMO);
  assert.equal(timedOut.voice, "kokoro");
  await settle();
  assert.equal(rows().length, before + 1, "the timeout was metered");
  assert.ok(rows().at(-1).completion_tokens > 0);
  S.speechEngine.or = realOr;

  // a banned student can't make the institute pay for voice
  await setPlan("team", "pro", "banned");
  const n2 = upstream.length;
  const banned = await speak("Banned line.", DEMO);
  assert.equal(banned.status, 403);
  assert.equal(upstream.length, n2, "no OpenRouter call for a banned user");
  const denied = await S.speechPayer({ headers: DEMO }, "team");
  assert.deepEqual(denied, { denied: "This account is suspended.", status: 403 }, "the payer decision refuses bans on its own");
  await setPlan("team", "pro", "active");

  // ADA_SPEECH_PROVIDER=kokoro: OpenRouter is never called
  process.env.ADA_SPEECH_PROVIDER = "kokoro";
  const n1 = upstream.length;
  assert.equal((await speak("Forced kokoro.", DEMO)).voice, "kokoro");
  assert.equal(upstream.length, n1);
  delete process.env.ADA_SPEECH_PROVIDER;
  console.log("ok");
} finally {
  server.close();
  fake.close();
}
