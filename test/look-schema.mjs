// The browser tool's game surface: `look` is advertised, coordinates and hold are in the schema,
// and the description teaches the look → act → look loop. Offline — schema only.
// run: node --import tsx test/look-schema.mjs
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

const { tools } = await import(pathToFileURL(resolve("src/client/tools.ts")).href);
const browser = tools.find((t) => t.name === "browser");
assert.ok(browser, "no browser tool");

const p = browser.parameters.properties;
assert.ok(p.action.enum.includes("look"), "look missing from action enum");
assert.ok(p.x && p.y, "x/y coordinate params missing");
assert.ok(p.hold, "hold param missing");
assert.match(browser.description, /look/i, "description must explain look");
assert.match(browser.description, /look.*act.*look|look, act, look/i, "description must teach the play loop");

console.log("look-schema: ok");
