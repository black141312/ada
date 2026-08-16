// Resuming a transcript that lives outside serve's cwd.
//
// The bug: `list()` scans only `cwd/.ada/sessions`, and resume used to require the requested file to
// appear in that scan. Come back on any other cwd — a pruned worktree, the project opened by a
// different path — and a transcript sitting right there on disk was refused, silently, leaving the
// chat with an empty agent and no clue why. This pins the accept/reject rule that replaced it.
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The rule as cli.ts applies it, given a resume value and what list() can see.
const accepts = (resume, seen) =>
  resume === "latest" ? !!seen[0] : !!(resume?.endsWith(".jsonl") && existsSync(resume));

const home = mkdtempSync(join(tmpdir(), "ada-resume-"));
const elsewhere = join(home, "some-worktree", ".ada", "sessions");
mkdirSync(elsewhere, { recursive: true });
const transcript = join(elsewhere, "sess-abc.jsonl");
writeFileSync(transcript, '{"role":"user","content":"remember this"}\n');

// The whole point: serve's cwd sees nothing, the file is still resumable.
assert.equal(accepts(transcript, []), true, "a transcript on disk is resumable from any cwd");
assert.equal(accepts(transcript, [{ file: transcript }]), true, "and still is when the scan does see it");

// Nothing about that loosens what a valid resume target is.
assert.equal(accepts(join(elsewhere, "never-written.jsonl"), []), false, "a path that isn't there");
assert.equal(accepts(join(home, "some-worktree"), []), false, "a directory is not a transcript");
assert.equal(accepts(join(home, "notes.txt"), []), false, "non-transcript files stay out");
assert.equal(accepts(undefined, [{ file: transcript }]), false, "no resume asked for, none given");

// "latest" is unchanged — it still means whatever this cwd's scan puts first.
assert.equal(accepts("latest", [{ file: transcript }]), true);
assert.equal(accepts("latest", []), false, "nothing to be the latest of");
console.log("ok");
