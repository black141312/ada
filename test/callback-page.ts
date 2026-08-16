// The callback page: names the service, and never reflects a hostile error back as markup.
import assert from "node:assert/strict";
import { awaitCallback } from "../src/client/mcp-oauth.ts";

const { port } = await awaitCallback("st4te", "Google Calendar");
const base = `http://127.0.0.1:${port}/callback`;

const ok = await (await fetch(`${base}?code=abc&state=st4te`)).text();
assert.match(ok, /Connected to Google Calendar/, "names the service it connected");
assert.match(ok, /prefers-color-scheme/, "follows the browser theme");
console.log("success page  : names the service, theme-aware");

const { port: p2 } = await awaitCallback("st4te", "Notion");
const bad = await (await fetch(`http://127.0.0.1:${p2}/callback?error=${encodeURIComponent('<script>alert(1)</script>')}`)).text();
assert.ok(!bad.includes("<script>alert"), "THE ERROR MUST NOT BE REFLECTED AS MARKUP");
assert.match(bad, /&#60;script&#62;/, "it is shown escaped instead");
assert.match(bad, /Sign-in failed/, "and it says what happened");
console.log("failure page  : error escaped, not executed");
console.log("\ncallback page: branded, theme-aware, injection-safe");
// awaitCallback closes its listener 500ms after answering; exiting under a closing
// handle trips a libuv assertion on Windows. Let them finish.
await new Promise((r) => setTimeout(r, 900));
process.exit(0);
