// The transcript store, exercised on real folders that really get renamed.
//
// What this protects: a chat's memory used to live at `cwd/.ada/sessions`, so renaming the project
// emptied every conversation in it, silently. The store now sits in the home directory and is keyed
// by an id kept inside the project — so the rename below, which is the whole point, must not lose a
// single message.
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, renameSync, existsSync, readdirSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join, resolve, basename } from "node:path";
import { pathToFileURL } from "node:url";

const SRC = pathToFileURL(resolve("src/client/session.ts")).href;
// The module caches its directory on first use, which is right for a process and wrong for a test
// that moves the world underneath it. A fresh specifier gives each phase a fresh module.
let loads = 0;
const freshModule = () => import(`${SRC}?load=${++loads}`);

const root = mkdtempSync(join(tmpdir(), "ada-store-"));
const fakeHome = join(root, "home");
mkdirSync(fakeHome, { recursive: true });
process.env.HOME = fakeHome;
process.env.USERPROFILE = fakeHome; // os.homedir() reads this one on Windows
assert.equal(homedir(), fakeHome, "the test must not touch the real home directory");

// A project as it looked before the store existed: transcript inside the project folder.
const project = join(root, "my-project");
const legacyDir = join(project, ".ada", "sessions");
mkdirSync(legacyDir, { recursive: true });
const legacyFile = join(legacyDir, "2026-08-13T10-00-00-000Z-ab12.jsonl");
writeFileSync(
  legacyFile,
  [
    JSON.stringify({ role: "user", content: "the deploy key is in vault, remember that" }),
    JSON.stringify({ role: "assistant", content: "noted" }),
  ].join("\n") + "\n",
);

const origCwd = process.cwd();
process.chdir(project);

// --- phase 1: the old transcript is adopted, and old paths still resolve -------------------------
{
  const { list, resolveTranscript, Session } = await freshModule();
  const metas = list();
  assert.equal(metas.length, 1, "the transcript left in the project must be adopted, not abandoned");
  assert.ok(metas[0].file.startsWith(fakeHome), `adopted into the home store, got ${metas[0].file}`);
  assert.match(metas[0].title, /deploy key/, "and it is the same conversation, not an empty stand-in");
  assert.equal(existsSync(legacyFile), false, "moved, so a second run cannot adopt it twice");

  // The desktop app persisted the OLD absolute path per chat. It has to keep working.
  const found = resolveTranscript(legacyFile);
  assert.ok(found && existsSync(found), "a path recorded before the move still names the transcript");
  assert.equal(basename(found), basename(legacyFile));
  assert.equal(Session.open(legacyFile).load().length, 2, "and opening by that old path loads the messages");

  // A project id was written into the project, which is what will survive the rename.
  assert.ok(readFileSync(join(project, ".ada", "project-id"), "utf8").trim().length > 0);
}

// --- phase 2: rename the project — the memory has to come with it --------------------------------
const renamed = join(root, "my-project-renamed");
process.chdir(root); // Windows will not rename a directory that is the working directory
// ...and it can hold the handle for a moment after chdir returns, so EBUSY here means "not yet",
// not "never". Retrying is the test being patient with the OS, nothing to do with the store.
for (let i = 0; ; i++) {
  try {
    renameSync(project, renamed);
    break;
  } catch (e) {
    if (e.code !== "EBUSY" || i >= 100) throw e;
    await new Promise((r) => setTimeout(r, 50));
  }
}
process.chdir(renamed);
{
  const { list, Session } = await freshModule();
  const metas = list();
  assert.equal(metas.length, 1, "renaming the folder must not empty its chats — this is the bug");
  assert.match(metas[0].title, /deploy key/);
  assert.deepEqual(
    Session.open(metas[0].file).load().map((m) => m.content),
    ["the deploy key is in vault, remember that", "noted"],
    "every message, in order",
  );
}

// --- phase 3: a different project does not see it ------------------------------------------------
const other = join(root, "unrelated-project");
mkdirSync(other, { recursive: true });
process.chdir(other);
{
  const { list, Session } = await freshModule();
  assert.equal(list().length, 0, "one project's conversations must not leak into another's");
  // New sessions land in the store, not in the project folder.
  const s = Session.create();
  s.append({ role: "user", content: "hello" });
  assert.ok(s.file.startsWith(fakeHome), "new transcripts are written to the store");
  assert.equal(existsSync(join(other, ".ada", "sessions")), false, "and never back inside the project");
  assert.equal(list().length, 1);
}

// --- phase 4: a transcript that is genuinely gone reports gone, it does not invent one ------------
{
  process.chdir(renamed);
  const { resolveTranscript } = await freshModule();
  assert.equal(resolveTranscript(join(root, "nope", "never-existed.jsonl")), null);
  assert.equal(resolveTranscript(join(root, "notes.txt")), null, "only transcripts");
}

process.chdir(origCwd);
assert.ok(readdirSync(join(fakeHome, ".ada", "sessions")).length >= 2, "two projects, two stores");
console.log("ok");
