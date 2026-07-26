// ask_user in an editor session: the agent asks, the front-end answers over HTTP, the turn resumes.
// Before this existed, serve installed no asker at all and every question came back
// "(no interactive session)" — so the agent silently decided for the user.
//   run: node --import tsx test/serve-question.mjs
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

const { QuestionRegistry } = await import(pathToFileURL(resolve("src/client/agent-server.ts")).href);
const { tools, setAsker } = await import(pathToFileURL(resolve("src/client/tools.ts")).href);
const askUser = tools.find((t) => t.name === "ask_user");

// --- with no asker installed (headless), the agent is told to decide for itself ---
setAsker(null);
const none = await askUser.run({ question: "pptx or page?" });
assert.ok(none.isError, "no asker should be an error result");
assert.match(none.output, /no interactive session/);

// --- the serve wiring: asker -> question frame -> /answer -> resolved ---
const q = new QuestionRegistry();
const frames = [];
setAsker(async (question, options) => {
  const { id, promise } = q.wait();
  frames.push({ type: "question", id, question, options: options ?? [] });
  return promise;
});

const pending = askUser.run({ question: "Which format?", options: ["A .pptx deck", "An HTML page"] });
await new Promise((r) => setTimeout(r, 10));
assert.equal(frames.length, 1, "a question frame should have been emitted");
const f = frames[0];
assert.equal(f.question, "Which format?");
assert.deepEqual(f.options, ["A .pptx deck", "An HTML page"]);
assert.ok(f.id, "the frame needs an id to answer by");

assert.equal(q.settle("bogus-id", "x"), false, "an unknown id must not settle anything");
assert.equal(q.settle(f.id, "An HTML page"), true, "the real id should settle");
const answered = await pending;
assert.ok(!answered.isError, answered.output);
assert.match(answered.output, /User answered: An HTML page/);
assert.equal(q.settle(f.id, "again"), false, "a settled question must not settle twice");

// --- an aborted turn must not leave the agent parked forever ---
const q2 = new QuestionRegistry();
setAsker(async (question) => {
  const { promise } = q2.wait();
  return promise;
});
const parked = askUser.run({ question: "still there?" });
await new Promise((r) => setTimeout(r, 10));
assert.equal(q2.abortAll(), 1, "abortAll should release the parked question");
const released = await parked;
assert.match(released.output, /gave no answer/);

setAsker(null);
console.log("ok");
