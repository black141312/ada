// Self-check for the TUI composer's line editing + bracketed paste. Run: npx tsx test/tui-keys.mjs
import assert from "node:assert";
import { Tui } from "../src/client/tui.ts";

const tui = new Tui();
const pending = tui.readLine(); // puts the composer in "line" mode (no raw stdin needed)
const key = (s) => tui.key(s);

key("hello");
key("\x1b[D");
key("\x1b[D"); // cursor two left
key("X");
assert.equal(tui.buf, "helXlo"); // insert-at-cursor

key("\x01"); // Ctrl+A home
key("\x0b"); // Ctrl+K kill to end
assert.equal(tui.buf, "");

key("abc def");
key("\x17"); // Ctrl+W deletes the last word
assert.equal(tui.buf, "abc ");

key("\x1b[200~one\r\ntwo\x1b[201~"); // bracketed paste, split across no chunks, CRLF normalized
assert.equal(tui.buf, "abc one\ntwo");

// Paste split across data chunks
key("\x1b[200~ mid");
key("dle\x1b[201~");
assert.equal(tui.buf, "abc one\ntwo middle");

key("\r"); // submit
assert.equal(await pending, "abc one\ntwo middle");
console.log("ok");
process.stdout.write("\x1b[0m\n");
