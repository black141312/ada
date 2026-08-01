#!/usr/bin/env node
// ARC-AGI-3 harness for ada.
//
// ARC-AGI-3 is interactive: you see a 64x64 grid frame and pick one action (1-5, 7 simple; 6 needs
// x/y) until you win or die. The rules are never stated — discovering them IS the benchmark.
//
// ada plays it as an agent: we start a game session, then hand ada this same file as a CLI it drives
// with its `bash` tool. Every action, every frame, every hypothesis lives in ada's own loop — it can
// take notes, write scratch scripts to diff frames, and reset after a death, all inside one context.
//
//   ARC_API_KEY=... node bench/arcagi3.mjs --model claude-opus-4-8 --out runs/arc [--limit 1]
//   ARC_API_KEY=... node bench/arcagi3.mjs --model gpt-... --games ls20-016295f7601e --steps 100
//   node bench/arcagi3.mjs --model-only --model ...   # baseline: one raw model call per frame, no agent
//   node bench/arcagi3.mjs --selftest                 # offline checks of the pure helpers
//
//   node bench/arcagi3.mjs compare runs/a runs/b       # diff finished runs from their logs
//
// The CLI ada (or you) drives, from inside a run dir:
//   node bench/arcagi3.mjs play            # look at the current frame, don't act
//   node bench/arcagi3.mjs play ACTION3
//   node bench/arcagi3.mjs play ACTION6 12 34
//   node bench/arcagi3.mjs play RESET      # after a GAME_OVER
//
// ponytail: no arc-agi Python SDK — the REST API is 5 endpoints and this is a Node repo.
// Prereqs: a running `ada-server` with provider keys, and an ARC API key from https://three.arcprize.org.

import { spawn } from "node:child_process";
import { deflateSync } from "node:zlib";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

const HERE = dirname(fileURLToPath(import.meta.url));
const SELF = resolve(HERE, "arcagi3.mjs");
// The agent runs this path through a shell, where Windows backslashes are escape characters and
// silently corrupt it into an unloadable path. Node accepts forward slashes on every platform.
const SELF_CMD = SELF.split("\\").join("/");
const ADA_BIN = resolve(HERE, "..", "bin", "ada.mjs");
const ARC = process.env.ARC_BASE_URL || "https://three.arcprize.org";
const BACKEND = process.env.ADA_BACKEND_URL || "http://localhost:8787/v1";
const SESSION = "arc-session.json";
const HEX = "0123456789abcdef";

// ---------- pure helpers (covered by --selftest) ----------

export function parseArgs(argv) {
  const f = { steps: 200, out: "runs/arc", timeout: 3600 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--selftest") f.selftest = true;
    else if (a === "--model-only") f.modelOnly = true;
    else if (a === "--model") f.model = argv[++i];
    else if (a === "--games")
      f.games = String(argv[++i])
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
    else if (a === "--limit") f.limit = Number(argv[++i]);
    else if (a === "--steps") f.steps = Number(argv[++i]);
    else if (a === "--out") f.out = argv[++i];
    else if (a === "--timeout") f.timeout = Number(argv[++i]);
    else if (a === "--tag") f.tag = argv[++i];
    else if (a === "--image") f.image = true;
  }
  return f;
}

// `frame` is either one grid (number[][]) or a stack of grids (number[][][]); we want the newest grid.
export function latestGrid(frame) {
  if (!Array.isArray(frame) || frame.length === 0) return [];
  const last = frame[frame.length - 1];
  return Array.isArray(last) && Array.isArray(last[0]) ? last : frame;
}

export function renderGrid(grid) {
  return grid.map((row) => row.map((c) => HEX[c] ?? "?").join("")).join("\n");
}

// Display palette for the 16 colour indices. Indices 0-9 follow ARC's published colours; 10-15 are
// our own choices — the API returns indices, not colours, so only the distinctness matters.
const PALETTE = [
  [17, 17, 17],
  [0, 116, 217],
  [196, 52, 43],
  [46, 204, 64],
  [232, 184, 0],
  [184, 184, 184],
  [240, 18, 190],
  [255, 133, 27],
  [127, 199, 232],
  [122, 20, 36],
  [77, 77, 77],
  [0, 179, 119],
  [46, 46, 61],
  [255, 255, 255],
  [140, 110, 60],
  [200, 200, 255],
];

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
};

/** The frame as a PNG. Hand-rolled because zlib is the only hard part and it's in the stdlib —
 *  an image encoder dependency for 40 lines of RGB scanlines isn't worth it.
 *  ponytail: RGB, no palette chunk, no filtering — the file is a few KB either way. */
export function pngFromGrid(grid, scale = 8) {
  const h = grid.length;
  const w = h ? grid[0].length : 0;
  if (!w || !h) throw new Error("empty grid");
  const W = w * scale;
  const raw = Buffer.alloc((W * 3 + 1) * h * scale);
  let p = 0;
  for (let y = 0; y < h; y++) {
    const rowStart = p;
    raw[p++] = 0; // filter: none
    for (let x = 0; x < w; x++) {
      const [r, g, b] = PALETTE[grid[y][x]] ?? [255, 0, 255];
      for (let s = 0; s < scale; s++) {
        raw[p++] = r;
        raw[p++] = g;
        raw[p++] = b;
      }
    }
    // Repeat the scanline `scale` times to square up the pixels.
    const line = raw.subarray(rowStart, p);
    for (let s = 1; s < scale; s++) {
      line.copy(raw, p);
      p += line.length;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0);
  ihdr.writeUInt32BE(h * scale, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: truecolour
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// How many cells an action altered. 0 means the move was legal but inert — the game ignored it.
// That distinction is the whole game: "picked a valid action" vs "the action did something".
export function countChanged(a, b) {
  if (!a?.length || !b?.length) return 0;
  let n = 0;
  for (let y = 0; y < Math.min(a.length, b.length); y++) {
    const ra = a[y] ?? [];
    const rb = b[y] ?? [];
    for (let x = 0; x < Math.max(ra.length, rb.length); x++) {
      if (ra[x] !== rb[x]) n++;
    }
  }
  return n;
}

// What ada sees in its bash output after every action.
export function formatObs(obs, used, max) {
  const acts = (obs.available_actions ?? [])
    .map((n) => (n === 6 ? "ACTION6 <x> <y>" : `ACTION${n}`))
    .join(", ");
  const left = max - used;
  const banner =
    obs.state === "WIN"
      ? "\nWIN — this game is solved. Stop here."
      : obs.state === "GAME_OVER"
        ? `\nGAME_OVER — run \`play RESET\` to start over (costs no actions), or stop.`
        : left <= 0
          ? "\nBUDGET EXHAUSTED — no actions left. Stop here."
          : "";
  return `${renderGrid(latestGrid(obs.frame))}

state ${obs.state} · level ${obs.levels_completed ?? 0}/${obs.win_levels ?? "?"} · actions ${used}/${max} (${left} left)
legal actions: ${acts || "(none reported)"}${banner}`;
}

export function buildAgentPrompt(gameId, maxSteps) {
  return `You are playing an ARC-AGI-3 game called \`${gameId}\`. Nobody will tell you the rules — working
them out from what you observe IS the task.

Drive the game with this command (run it from the current directory):

  node ${SELF_CMD} play              # print the current frame without acting
  node ${SELF_CMD} play ACTION3      # take a simple action
  node ${SELF_CMD} play ACTION6 12 34  # click cell x=12 y=34 (x and y are 0-63)
  node ${SELF_CMD} play RESET        # start the level over after a GAME_OVER; costs no actions

Each call prints the frame as a grid of hex digits 0-f, one character per cell, one line per row —
each digit is a colour. It also prints the game state, the level you are on, how many actions you
have left, and which actions are currently legal. Only the legal ones do anything.

You have ${maxSteps} actions total. Play to win: complete levels until the state is WIN, or until the
budget runs out.

How to approach it:
- Take an action, then compare the new frame against the previous one. What moved? What changed
  colour? Which action caused it? That difference is your only source of truth.
- Write your working notes to notes.md as you go, and keep them current — hypotheses about the rules,
  what each action does, what seems to score. You will need them after many turns.
- Feel free to write throwaway scripts to diff frames or find shapes if that is faster than eyeballing
  a 64x64 grid. Anything in this directory is yours.
- When something stops working, form a new hypothesis and test it. Do not repeat a dead action.

Stop when the state is WIN, when the budget is exhausted, or when RESET stops being useful.`;
}

export function buildFramePrompt(o) {
  const acts = (o.availableActions ?? []).map((n) =>
    n === 6 ? "ACTION6 x=<0-63> y=<0-63>  (click a cell)" : `ACTION${n}`,
  );
  return `You are playing an ARC-AGI-3 game. Each turn you see the current frame and pick ONE action.

${
  o.asImage
    ? "The frame is the attached image: a 64x64 grid of coloured cells, drawn 8 screen pixels per cell. Cell (x,y) counts from 0 at the top-left."
    : `The frame is a grid of colours written as hex digits 0-f (one char per cell, one line per row):

${renderGrid(o.grid)}`
}

Progress: level ${o.levels ?? 0} of ${o.winLevels ?? "?"} · step ${o.step} of ${o.maxSteps} · state ${o.state}
Your last actions: ${o.history?.length ? o.history.join(", ") : "(none yet)"}

Legal actions this turn:
${acts.map((a) => `- ${a}`).join("\n")}

Work out what changed since your last action and what the game seems to reward, then answer with the
action on the FINAL line, alone, exactly in one of the legal forms above. No other text on that line.`;
}

export function parseAction(text, available, step = 0) {
  const legal = available?.length ? available : [1, 2, 3, 4, 5];
  const hits = [...String(text ?? "").matchAll(/ACTION\s*([1-7])/gi)];
  const last = hits[hits.length - 1];
  const id = last ? Number(last[1]) : NaN;
  if (!legal.includes(id))
    return { id: legal[step % legal.length], x: 0, y: 0, fallback: true };
  if (id !== 6) return { id, fallback: false };

  const tail = String(text).slice(last.index + last[0].length); // past "ACTION6" itself, so its 6 isn't read as x
  const xy =
    /x\s*[=:]?\s*(\d{1,2})\D+y\s*[=:]?\s*(\d{1,2})/i.exec(tail) ??
    /(\d{1,2})\D+(\d{1,2})/.exec(tail);
  if (!xy)
    return { id: legal[step % legal.length], x: 0, y: 0, fallback: true };
  const clamp = (n) => Math.min(63, Math.max(0, Number(n)));
  return { id: 6, x: clamp(xy[1]), y: clamp(xy[2]), fallback: false };
}

// ---------- session (persisted so each `play` invocation resumes the same game) ----------

function loadSession(dir) {
  const p = join(dir, SESSION);
  if (!existsSync(p))
    throw new Error(
      `no ${SESSION} here — start the harness from bench/arcagi3.mjs first`,
    );
  return JSON.parse(readFileSync(p, "utf8"));
}

const saveSession = (dir, s) =>
  writeFileSync(join(dir, SESSION), JSON.stringify(s, null, 2));

// ---------- wire ----------

function jar(initial) {
  const store = new Map(Object.entries(initial ?? {}));
  return {
    header: () => [...store].map(([k, v]) => `${k}=${v}`).join("; "),
    toJSON: () => Object.fromEntries(store),
    absorb(res) {
      const one = res.headers.get("set-cookie");
      const raw = res.headers.getSetCookie?.() ?? (one ? [one] : []);
      for (const c of raw) {
        const kv = c.split(";")[0];
        const i = kv.indexOf("=");
        if (i > 0) store.set(kv.slice(0, i).trim(), kv.slice(i + 1).trim());
      }
    },
  };
}

async function arc(path, { key, cookies, method = "POST", body }) {
  const cookie = cookies.header();
  const res = await fetch(`${ARC}${path}`, {
    method,
    headers: {
      "X-API-Key": key,
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      ...(cookie ? { Cookie: cookie } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  cookies.absorb(res);
  if (!res.ok)
    throw new Error(
      `${path} → ${res.status} ${(await res.text()).slice(0, 200)}`,
    );
  return res.json();
}

const apiKey = () => {
  const k = process.env.ARC_API_KEY;
  if (!k)
    throw new Error("set ARC_API_KEY (get one at https://three.arcprize.org)");
  return k;
};

// ---------- `play` — the CLI ada drives ----------

async function play(argv) {
  const dir = process.cwd();
  const s = loadSession(dir);
  const cookies = jar(s.cookies);
  // The session carries the key because ada deliberately scrubs `*_API_KEY` from the environment it
  // hands a model-controlled subprocess (src/client/secret-env.ts) — so inheriting ARC_API_KEY here
  // is impossible by design, and every action would 401. This mirrors how ada re-supplies a token
  // provisioned for a specific tool. Env still wins when set, for playing by hand.
  const key = process.env.ARC_API_KEY || s.key;
  if (!key)
    throw new Error("no ARC key in the environment or in arc-session.json");
  const word = argv.join(" ").toUpperCase(); // "ACTION6 12 34" — x/y live in the later args
  let changed; // cells this action altered. A legal move that changes nothing is a wasted move —
  // the difference between "the model picked a valid action" and "the action did anything".

  if (!word) {
    console.log(formatObs(s.obs, s.used, s.maxSteps));
    return;
  }

  let act = null;
  if (word === "RESET") {
    s.obs = await arc("/api/cmd/RESET", {
      key,
      cookies,
      body: { game_id: s.game_id, card_id: s.card_id, guid: s.obs.guid },
    });
    s.resets = (s.resets ?? 0) + 1;
  } else {
    if (s.used >= s.maxSteps) {
      console.log(
        `BUDGET EXHAUSTED — ${s.used}/${s.maxSteps} actions used. Stop here.`,
      );
      process.exitCode = 1;
      return;
    }
    act = parseAction(word, s.obs.available_actions, s.used);
    if (act.fallback) {
      console.log(
        `"${argv.join(" ")}" is not a legal action right now. Legal: ${(s.obs.available_actions ?? []).join(", ")}. Nothing happened.`,
      );
      // Costs no budget, but it's a quality signal — log it so `compare` can count wasted moves.
      appendFileSync(
        join(dir, "steps.jsonl"),
        `${JSON.stringify({ step: s.used, refused: argv.join(" ") })}\n`,
      );
      process.exitCode = 1;
      return;
    }
    const before = latestGrid(s.obs.frame);
    s.obs = await arc(`/api/cmd/ACTION${act.id}`, {
      key,
      cookies,
      body: {
        game_id: s.game_id,
        guid: s.obs.guid,
        ...(act.id === 6 ? { x: act.x, y: act.y } : {}),
        reasoning: { agent: "ada", model: s.model },
      },
    });
    changed = countChanged(before, latestGrid(s.obs.frame));
    s.used++;
  }

  s.cookies = cookies.toJSON();
  s.best = Math.max(s.best ?? 0, s.obs.levels_completed ?? 0);
  saveSession(dir, s);
  const label = act
    ? act.id === 6
      ? `ACTION6(${act.x},${act.y})`
      : `ACTION${act.id}`
    : "RESET";
  appendFileSync(
    join(dir, "steps.jsonl"),
    `${JSON.stringify({ step: s.used, action: label, changed, state: s.obs.state, levels_completed: s.obs.levels_completed })}\n`,
  );
  console.log(formatObs(s.obs, s.used, s.maxSteps));
}

// ---------- agent mode ----------

function runAda(prompt, cwd, model, timeoutMs) {
  return new Promise((res) => {
    const child = spawn(
      process.execPath,
      [ADA_BIN, "-p", prompt, "--model", model, "--json"],
      { cwd, env: process.env },
    );
    let out = "";
    let err = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("exit", (code) => {
      clearTimeout(timer);
      let usage = "";
      const line = out
        .split("\n")
        .reverse()
        .find((l) => l.trim().startsWith("{"));
      try {
        usage = line ? (JSON.parse(line).usage ?? "") : "";
      } catch {
        /* ignore */
      }
      res({ code, timedOut, usage, err: err.slice(-500) });
    });
    child.on("error", (e) => {
      clearTimeout(timer);
      res({ code: -1, timedOut, usage: "", err: String(e) });
    });
  });
}

// `cookies` is the SAME jar used for scorecard/open. ARC games sit behind a load balancer and
// need session affinity (AWSALB*) — a fresh jar here lands on a node that has never seen the
// scorecard, and RESET fails with "game not found". Intermittent, so it must be threaded, not retried.
async function playAsAgent(gameId, f, key, cardId, cookies) {
  const dir = resolve(f.out, gameId);
  mkdirSync(dir, { recursive: true });
  const obs = await arc("/api/cmd/RESET", {
    key,
    cookies,
    body: { game_id: gameId, card_id: cardId },
  });
  saveSession(dir, {
    game_id: gameId,
    card_id: cardId,
    model: f.model,
    maxSteps: f.steps,
    used: 0,
    best: 0,
    key, // ada can't inherit ARC_API_KEY (scrubbed); the play CLI reads it from here. runs/ is gitignored.
    cookies: cookies.toJSON(),
    obs,
  });

  const t0 = Date.now();
  const r = await runAda(
    buildAgentPrompt(gameId, f.steps),
    dir,
    f.model,
    f.timeout * 1000,
  );
  const s = loadSession(dir);
  return {
    game_id: gameId,
    state: s.obs.state,
    levels: s.obs.levels_completed,
    win_levels: s.obs.win_levels,
    best_level: s.best,
    actions: s.used,
    resets: s.resets ?? 0,
    seconds: Math.round((Date.now() - t0) / 1000),
    note: r.timedOut
      ? "agent timeout"
      : r.code === 0
        ? `usage:${r.usage}`
        : `ada exit ${r.code}: ${r.err}`,
  };
}

// ---------- model-only baseline ----------

// `png` (a Buffer) sends the frame as an image instead of hex text. Reading a 64x64 grid out of
// 4,096 hex digits is a handicap the picture removes — worth isolating from the model's actual
// ability to play. Only reachable in --model-only: ada's read tool cannot view images
// (src/client/tools.ts — "this build cannot view images"), so agent mode has no way to use one.
async function askModel(model, prompt, timeoutMs, png) {
  const content = png
    ? [
        { type: "text", text: prompt },
        {
          type: "image_url",
          image_url: { url: `data:image/png;base64,${png.toString("base64")}` },
        },
      ]
    : prompt;
  return askModelWith(model, content, timeoutMs);
}

async function askModelWith(model, content, timeoutMs) {
  const res = await fetch(`${BACKEND}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(process.env.ADA_API_KEY
        ? { Authorization: `Bearer ${process.env.ADA_API_KEY}` }
        : {}),
    },
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content }],
      temperature: 0,
      // Reasoning models spend this budget thinking before they write anything, and the thinking
      // counts against it. At 600 a model like gpt-5.6-luna burns ~1,800 reasoning tokens, returns
      // content: null with finish_reason "length", and never answers at all.
      max_tokens: 4096,
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok)
    throw new Error(
      `ada-server → ${res.status} ${(await res.text()).slice(0, 200)}`,
    );
  const json = await res.json();
  const choice = json.choices?.[0];
  const text = choice?.message?.content ?? "";
  // An empty answer that ran out of budget is a harness failure, not a bad move. Surfacing it as an
  // error keeps it out of the fallback count, which is supposed to measure the model's play.
  if (!text.trim() && choice?.finish_reason === "length")
    throw new Error(
      `model produced no answer — hit max_tokens (${json.usage?.completion_tokens ?? "?"} tokens, all reasoning)`,
    );
  return text;
}

async function playAsModel(gameId, f, key, cardId, cookies) {
  const dir = resolve(f.out, gameId);
  mkdirSync(dir, { recursive: true });
  const logPath = join(dir, "steps.jsonl");
  let obs = await arc("/api/cmd/RESET", {
    key,
    cookies,
    body: { game_id: gameId, card_id: cardId },
  });
  const history = [];
  let resets = 0;
  let best = 0;
  let used = 0;

  for (let step = 1; step <= f.steps; step++) {
    if (obs.state === "WIN") break;
    if (obs.state === "GAME_OVER") {
      // ponytail: a death costs a reset, not the run — keep playing until the budget is spent.
      resets++;
      obs = await arc("/api/cmd/RESET", {
        key,
        cookies,
        body: { game_id: gameId, card_id: cardId, guid: obs.guid },
      });
      history.length = 0;
    }
    const grid = latestGrid(obs.frame);
    const prompt = buildFramePrompt({
      grid,
      asImage: !!f.image,
      state: obs.state,
      availableActions: obs.available_actions,
      levels: obs.levels_completed,
      winLevels: obs.win_levels,
      step,
      maxSteps: f.steps,
      history: history.slice(-8),
    });

    let reply = "";
    let note = "";
    try {
      reply = await askModel(
        f.model,
        prompt,
        120_000,
        f.image ? pngFromGrid(grid) : undefined,
      );
    } catch (e) {
      note = `model error: ${e instanceof Error ? e.message : e}`;
    }
    const act = parseAction(reply, obs.available_actions, step);
    const label =
      act.id === 6 ? `ACTION6(${act.x},${act.y})` : `ACTION${act.id}`;
    history.push(label);

    obs = await arc(`/api/cmd/ACTION${act.id}`, {
      key,
      cookies,
      body: {
        game_id: gameId,
        guid: obs.guid,
        ...(act.id === 6 ? { x: act.x, y: act.y } : {}),
        reasoning: {
          agent: "model-only",
          model: f.model,
          text: String(reply).slice(0, 4000),
        },
      },
    });
    used = step;
    best = Math.max(best, obs.levels_completed ?? 0);
    appendFileSync(
      logPath,
      `${JSON.stringify({ step, action: label, fallback: act.fallback || undefined, state: obs.state, levels_completed: obs.levels_completed, note: note || undefined })}\n`,
    );
    if (step % 10 === 0 || obs.state !== "NOT_FINISHED") {
      console.error(
        `    step ${step}/${f.steps} · ${label} · ${obs.state} · level ${obs.levels_completed}/${obs.win_levels}`,
      );
    }
  }
  return {
    game_id: gameId,
    state: obs.state,
    levels: obs.levels_completed,
    win_levels: obs.win_levels,
    best_level: best,
    actions: used,
    resets,
  };
}

// ---------- run ----------

async function main(f) {
  const key = apiKey();
  if (!f.model)
    throw new Error(
      "--model is required (any model id ada routes, e.g. claude-opus-4-8)",
    );

  const cookies = jar();
  const games = await arc("/api/games", { key, cookies, method: "GET" });
  let ids = f.games ?? games.map((g) => g.game_id);
  if (f.limit) ids = ids.slice(0, f.limit);
  if (!ids.length) throw new Error("no games to play");

  const mode = f.modelOnly ? "model-only" : "ada";
  const { card_id: cardId } = await arc("/api/scorecard/open", {
    key,
    cookies,
    body: {
      source_url: "https://github.com/black141312/ada",
      tags: [f.tag ?? "ada", mode, f.model].filter(Boolean),
    },
  });

  mkdirSync(f.out, { recursive: true });
  console.error(
    `scorecard ${cardId} · ${ids.length} game(s) · ${f.steps} actions each · ${mode} · ${f.model}`,
  );

  const results = [];
  for (const id of ids) {
    console.error(`\n  ${id}`);
    try {
      results.push(
        await (f.modelOnly ? playAsModel : playAsAgent)(
          id,
          f,
          key,
          cardId,
          cookies,
        ),
      );
    } catch (e) {
      console.error(`  ${id} failed: ${e instanceof Error ? e.message : e}`);
      results.push({ game_id: id, state: "ERROR", error: String(e) });
    }
    const last = results[results.length - 1];
    console.error(
      `  ${id} → ${last.state} · level ${last.best_level ?? "?"} · ${last.actions ?? 0} actions${last.note ? ` · ${last.note}` : ""}`,
    );
  }

  const summary = await arc("/api/scorecard/close", {
    key,
    cookies,
    body: { card_id: cardId },
  });
  writeFileSync(
    join(f.out, "summary.json"),
    `${JSON.stringify({ card_id: cardId, mode, model: f.model, results, summary }, null, 2)}\n`,
  );

  console.error(
    `\nscore ${summary.score} · levels ${summary.total_levels_completed} · actions ${summary.total_actions}`,
  );
  console.error(
    `wins: ${results.filter((r) => r.state === "WIN").length}/${results.length}`,
  );
  console.error(
    `scorecard: ${ARC}/scorecards/${cardId}\nsummary: ${join(f.out, "summary.json")}`,
  );
}

// ---------- compare ----------

// Fold one run into a comparable row. Pure given the file contents, so the selftest drives it with
// literals rather than a fixture tree.
export function summarizeRun(name, summary, stepsByGame) {
  const results = summary.results ?? [];
  let actions = 0;
  let resets = 0;
  let refused = 0;
  let inert = 0; // legal moves that changed nothing on the board
  for (const lines of Object.values(stepsByGame)) {
    for (const s of lines) {
      if (s.refused !== undefined) refused++;
      else if (s.action === "RESET") resets++;
      else {
        actions++;
        if (s.changed === 0) inert++;
      }
    }
  }
  const best = {};
  for (const r of results) best[r.game_id] = r.best_level ?? 0;
  return {
    name,
    mode: summary.mode ?? "?",
    model: summary.model ?? "?",
    games: results.length,
    wins: results.filter((r) => r.state === "WIN").length,
    levels: summary.summary?.total_levels_completed ?? 0,
    score: summary.summary?.score ?? 0,
    actions,
    resets,
    refused,
    inert,
    inertPct: actions ? Math.round((inert / actions) * 100) : 0,
    // Share of proposed moves the game rejected as illegal — a prompt/understanding signal,
    // not a game-difficulty one. Comparable across modes because neither spends budget on them.
    refusedPct:
      actions + refused ? Math.round((refused / (actions + refused)) * 100) : 0,
    best,
  };
}

function readRun(dir) {
  const summary = JSON.parse(readFileSync(join(dir, "summary.json"), "utf8"));
  const stepsByGame = {};
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const p = join(entry.parentPath ?? dir, entry.name, "steps.jsonl");
    if (!existsSync(p)) continue;
    stepsByGame[entry.name] = readFileSync(p, "utf8")
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l));
  }
  return summarizeRun(dir, summary, stepsByGame);
}

function compare(dirs) {
  if (!dirs.length)
    throw new Error("usage: arcagi3.mjs compare <run-dir> <run-dir> [...]");
  const rows = dirs.map(readRun);
  const cols = [
    ["run", (r) => r.name, 24],
    ["mode", (r) => r.mode, 11],
    ["model", (r) => r.model, 26], // fits "openai/gpt-5.6-luna-pro" without colliding with the next column
    ["wins", (r) => `${r.wins}/${r.games}`, 7],
    ["levels", (r) => String(r.levels), 8],
    ["actions", (r) => String(r.actions), 9],
    ["resets", (r) => String(r.resets), 8],
    ["illegal", (r) => `${r.refused} (${r.refusedPct}%)`, 12],
    ["inert", (r) => `${r.inert} (${r.inertPct}%)`, 12],
    ["score", (r) => String(r.score), 7],
  ];
  console.log(cols.map(([h, , w]) => h.padEnd(w)).join(""));
  for (const r of rows)
    console.log(cols.map(([, f, w]) => f(r).padEnd(w)).join(""));

  const games = [...new Set(rows.flatMap((r) => Object.keys(r.best)))].sort();
  if (games.length) {
    console.log("\nbest level reached per game");
    console.log(
      "game".padEnd(18) +
        rows
          // last path segment, not a blind slice — "runs/luna-agent" must not print as "uns/luna-agent"
          .map((r) =>
            (r.name.split(/[\\/]/).filter(Boolean).pop() ?? r.name).padStart(
              16,
            ),
          )
          .join(""),
    );
    for (const g of games) {
      console.log(
        g.padEnd(18) +
          rows.map((r) => String(r.best[g] ?? "-").padStart(16)).join(""),
      );
    }
  }
}

// ---------- selftest ----------

function runSelftest() {
  const a = parseArgs([
    "--model",
    "m",
    "--games",
    "x,y",
    "--steps",
    "50",
    "--limit",
    "2",
    "--out",
    "o",
    "--model-only",
  ]);
  assert.equal(a.model, "m");
  assert.deepEqual(a.games, ["x", "y"]);
  assert.equal(a.steps, 50);
  assert.equal(a.limit, 2);
  assert.equal(a.out, "o");
  assert.equal(a.modelOnly, true);
  assert.equal(parseArgs([]).modelOnly, undefined, "agent mode is the default");

  const grid = [
    [0, 1],
    [15, 3],
  ];
  assert.deepEqual(latestGrid(grid), grid, "bare grid passes through");
  assert.deepEqual(
    latestGrid([[[9]], grid]),
    grid,
    "stacked frames take the newest",
  );
  assert.deepEqual(latestGrid([]), []);
  assert.equal(renderGrid(grid), "01\nf3");

  assert.equal(
    countChanged([[1, 2]], [[1, 2]]),
    0,
    "identical frames changed nothing",
  );
  assert.equal(countChanged([[1, 2]], [[1, 3]]), 1, "one cell differs");
  assert.equal(countChanged([], [[1]]), 0, "empty frame is not a change");

  const obs = {
    frame: grid,
    state: "NOT_FINISHED",
    levels_completed: 1,
    win_levels: 3,
    available_actions: [1, 6],
  };
  const view = formatObs(obs, 4, 10);
  assert.ok(view.startsWith("01\nf3"), "frame first");
  assert.ok(
    view.includes("actions 4/10 (6 left)") && view.includes("ACTION6 <x> <y>"),
    "budget and legal actions shown",
  );
  assert.ok(
    /WIN — this game is solved/.test(
      formatObs({ ...obs, state: "WIN" }, 4, 10),
    ),
    "WIN is called out",
  );
  assert.ok(
    /GAME_OVER/.test(formatObs({ ...obs, state: "GAME_OVER" }, 4, 10)),
    "GAME_OVER offers RESET",
  );
  assert.ok(
    /BUDGET EXHAUSTED/.test(formatObs(obs, 10, 10)),
    "spent budget is called out",
  );

  const ap = buildAgentPrompt("ls20-abc", 200);
  assert.ok(
    !/\\/.test(ap),
    "no backslashes in the command path — a shell eats them as escapes",
  );
  assert.ok(
    ap.includes("ls20-abc") && ap.includes("200 actions"),
    "agent prompt names game and budget",
  );
  assert.ok(
    ap.includes("play ACTION6 12 34") && ap.includes("play RESET"),
    "agent prompt documents the CLI",
  );
  assert.ok(
    /nobody will tell you the rules/i.test(ap),
    "agent prompt sets the discovery task",
  );

  const png = pngFromGrid(
    [
      [1, 2],
      [3, 4],
    ],
    4,
  );
  assert.deepEqual(
    [...png.subarray(0, 8)],
    [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
    "PNG signature",
  );
  assert.equal(png.readUInt32BE(16), 8, "width = 2 cells x scale 4");
  assert.equal(png.readUInt32BE(20), 8, "height = 2 cells x scale 4");
  assert.ok(
    png.includes(Buffer.from("IHDR")) &&
      png.includes(Buffer.from("IDAT")) &&
      png.includes(Buffer.from("IEND")),
    "required chunks present",
  );
  assert.throws(() => pngFromGrid([]), /empty grid/);
  assert.ok(
    !buildFramePrompt({
      grid: [[1]],
      asImage: true,
      availableActions: [1],
    }).includes("0f"),
    "image prompt drops the hex grid",
  );
  assert.ok(
    buildFramePrompt({ grid: [[1]], availableActions: [1] }).includes(
      "hex digits",
    ),
    "text prompt keeps the hex grid",
  );

  const fp = buildFramePrompt({
    grid,
    state: "NOT_FINISHED",
    availableActions: [1, 6],
    step: 2,
    maxSteps: 9,
    history: ["ACTION1"],
  });
  assert.ok(
    fp.includes("01\nf3") && fp.includes("- ACTION1"),
    "frame prompt renders grid and legal actions",
  );
  assert.ok(!/- ACTION3/.test(fp), "frame prompt omits illegal actions");

  assert.deepEqual(parseAction("I'll go left.\nACTION3", [1, 3]), {
    id: 3,
    fallback: false,
  });
  assert.deepEqual(
    parseAction("ACTION1 first, then ACTION3", [1, 3]),
    { id: 3, fallback: false },
    "last action wins",
  );
  assert.deepEqual(parseAction("ACTION6 x=12 y=34", [6]), {
    id: 6,
    x: 12,
    y: 34,
    fallback: false,
  });
  assert.deepEqual(parseAction("ACTION6 (12, 34)", [6]), {
    id: 6,
    x: 12,
    y: 34,
    fallback: false,
  });
  assert.deepEqual(
    parseAction("ACTION6 12 34", [6]),
    { id: 6, x: 12, y: 34, fallback: false },
    "the CLI's own arg form parses",
  );
  assert.deepEqual(
    parseAction("ACTION6 x=99 y=70", [6]),
    { id: 6, x: 63, y: 63, fallback: false },
    "x/y clamped to the board",
  );
  assert.equal(
    parseAction("ACTION6", [6]).fallback,
    true,
    "ACTION6 without coords is rejected",
  );
  assert.equal(
    parseAction("ACTION4", [1, 2]).fallback,
    true,
    "illegal action is rejected",
  );
  assert.equal(
    parseAction("", [1, 2], 1).id,
    2,
    "empty reply rotates through legal actions",
  );
  assert.equal(parseAction(null, [1, 2], 2).id, 1);

  const run = summarizeRun(
    "runs/luna-agent",
    {
      mode: "ada",
      model: "gpt-5.6-luna",
      results: [
        { game_id: "ls20", state: "WIN", best_level: 7 },
        { game_id: "dc22", state: "GAME_OVER", best_level: 2 },
      ],
      summary: { score: 9, total_levels_completed: 9 },
    },
    {
      ls20: [
        { action: "ACTION1" },
        { action: "RESET" },
        { refused: "ACTION9" },
        { action: "ACTION3" },
      ],
      dc22: [{ action: "ACTION2" }, { refused: "ACTION6" }],
    },
  );
  assert.equal(run.wins, 1, "one WIN out of two games");
  assert.equal(run.games, 2);
  assert.equal(run.actions, 3, "RESET and refusals are not actions");
  assert.equal(run.resets, 1);
  assert.equal(run.refused, 2);
  assert.equal(run.refusedPct, 40, "2 refused of 5 proposed moves");
  assert.equal(
    run.inert,
    0,
    "steps with no `changed` field are not counted as inert",
  );
  assert.deepEqual(run.best, { ls20: 7, dc22: 2 });
  assert.equal(run.levels, 9);
  assert.equal(
    summarizeRun("empty", {}, {}).refusedPct,
    0,
    "no divide-by-zero on an empty run",
  );

  console.log("arcagi3 selftest OK");
}

const argv = process.argv.slice(2);
const fail = (e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
};

// Only dispatch when run directly. Everything above is exported, and without this guard an
// `import` of this file would start a real benchmark run as a side effect.
const runDirectly = process.argv[1] && resolve(process.argv[1]) === SELF;

if (runDirectly) {
  if (argv[0] === "play") await play(argv.slice(1)).catch(fail);
  else if (argv[0] === "compare") {
    try {
      compare(argv.slice(1));
    } catch (e) {
      fail(e);
    }
  } else {
    const flags = parseArgs(argv);
    if (flags.selftest) runSelftest();
    else await main(flags).catch(fail);
  }
}
