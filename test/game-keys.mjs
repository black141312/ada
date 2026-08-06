// Key mapping for game input: named keys, single printable characters, and rejection of the
// rest. Pure — no browser needed. run: node --import tsx test/game-keys.mjs
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

const { keyParams } = await import(pathToFileURL(resolve("src/client/browser.ts")).href);

// named keys still work, case-insensitively
assert.deepEqual(keyParams("Enter"), { key: "Enter", code: "Enter", keyCode: 13, text: "\r" });
assert.deepEqual(keyParams("arrowleft"), { key: "ArrowLeft", code: "ArrowLeft", keyCode: 37 });

// space by name and by character — games lean on it
assert.deepEqual(keyParams("space"), { key: " ", code: "Space", keyCode: 32, text: " " });
assert.deepEqual(keyParams(" "), { key: " ", code: "Space", keyCode: 32, text: " " });

// single letters (WASD) and digits go through with proper CDP codes
assert.deepEqual(keyParams("w"), { key: "w", code: "KeyW", keyCode: 87, text: "w" });
assert.deepEqual(keyParams("A"), { key: "A", code: "KeyA", keyCode: 65, text: "A" });
assert.deepEqual(keyParams("5"), { key: "5", code: "Digit5", keyCode: 53, text: "5" });

// punctuation types as text even without a Key* code
assert.equal(keyParams("+").text, "+");

// junk is rejected with the supported list in the message
assert.throws(() => keyParams("SuperKey"), /unsupported key/);
assert.throws(() => keyParams(""), /unsupported key/);

console.log("game-keys: ok");
