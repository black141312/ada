// The transcript store: adoption, path-independence, and finding orphans.
//
// What this protects: a chat's memory used to live at `cwd/.ada/sessions`, so renaming the project
// emptied every conversation in it, silently. The store now sits in the home directory, keyed by an
// id kept inside the project, so the folder can move without losing a message.
//
// A moved project is reproduced by its RESULT — same project id, different path — rather than by
// calling renameSync on a directory the OS has just been written into. Windows holds those handles
// for seconds at a time under load, and a test that fails on antivirus timing teaches nothing about
// the store. Same for a deleted project: an orphan is a breadcrumb pointing nowhere, and that is
// what gets built here.
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, copyFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join, resolve, basename, dirname } from "node:path";
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
}

// --- phase 2: the project reached at a new path — the memory comes with it ------------------------
// This is what a rename, a move, or a restore-from-backup leaves behind: the id file travels inside
// the folder, so the same conversations must be waiting at the new location.
const moved = join(root, "my-project-moved");
mkdirSync(join(moved, ".ada"), { recursive: true });
copyFileSync(join(project, ".ada", "project-id"), join(moved, ".ada", "project-id"));
assert.ok(readFileSync(join(moved, ".ada", "project-id"), "utf8").trim().length > 0, "the id is what travels");
process.chdir(moved);
{
  const { list, Session, stores } = await freshModule();
  const metas = list();
  assert.equal(metas.length, 1, "reaching the project by another path must not empty it — this is the bug");
  assert.match(metas[0].title, /deploy key/);
  assert.deepEqual(
    Session.open(metas[0].file).load().map((m) => m.content),
    ["the deploy key is in vault, remember that", "noted"],
    "every message, in order",
  );
  // The breadcrumb is rewritten each run, so the store now points at where the project actually is.
  // Without that, the next sweep would read the stale path and call a live store an orphan.
  const mine = stores().find((s) => s.dir === dirname(metas[0].file));
  assert.ok(mine, "the store is attributable");
  assert.equal(mine.project, resolve(moved), "and knows the CURRENT folder, not the one it was born in");
  assert.equal(mine.missing, false, "a project that merely moved is not an orphan");
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
process.chdir(moved);
{
  const { resolveTranscript } = await freshModule();
  assert.equal(resolveTranscript(join(root, "nope", "never-existed.jsonl")), null);
  assert.equal(resolveTranscript(join(root, "notes.txt")), null, "only transcripts");
}

// --- phase 5: orphans, and the refusal to guess at one --------------------------------------------
{
  const { stores, removeStore } = await freshModule();

  // A store left behind by a project folder that is gone — a deleted checkout, or one of the
  // throwaway run dirs a bench harness makes per run.
  const orphanDir = join(fakeHome, ".ada", "sessions", "11111111-2222-3333-4444-555555555555");
  mkdirSync(orphanDir, { recursive: true });
  writeFileSync(join(orphanDir, "project"), `${join(root, "deleted-project")}\n`);
  writeFileSync(join(orphanDir, "2026-01-01T00-00-00-000Z-dead.jsonl"), '{"role":"user","content":"throwaway"}\n');

  // A store from before breadcrumbs existed. Unknown is NOT gone: deleting this would be deleting
  // someone's history on a guess.
  const mystery = join(fakeHome, ".ada", "sessions", "99999999-8888-7777-6666-555555555555");
  mkdirSync(mystery, { recursive: true });
  writeFileSync(join(mystery, "2026-01-01T00-00-00-000Z-old1.jsonl"), '{"role":"user","content":"who knows"}\n');

  const all = stores();
  const orphans = all.filter((s) => s.missing);
  assert.equal(orphans.length, 1, "exactly the store whose folder is gone");
  assert.equal(orphans[0].dir, orphanDir);
  assert.equal(orphans[0].sessions, 1, "and it reports what would be lost");
  assert.equal(all.find((s) => s.dir === mystery).missing, false, "an unattributable store is never an orphan");
  assert.equal(all.find((s) => s.dir === mystery).project, null);

  removeStore(orphanDir);
  assert.equal(existsSync(orphanDir), false);
  assert.equal(existsSync(mystery), true, "pruning must leave the ones it cannot vouch for");
  assert.equal(stores().filter((s) => s.missing).length, 0);

  // Deleting is the one destructive call here, so it refuses anything that is not a store.
  assert.throws(() => removeStore(join(fakeHome, ".ada", "sessions")), /not a session store/, "not the root");
  assert.throws(() => removeStore(moved), /not a session store/, "not a project folder");
  assert.throws(() => removeStore(join(orphanDir, "sub", "deeper")), /not a session store/, "not a nested path");
  assert.ok(existsSync(moved));
}

process.chdir(origCwd);
assert.ok(readdirSync(join(fakeHome, ".ada", "sessions")).length >= 2, "two projects, two stores");
console.log("ok");
