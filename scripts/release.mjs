#!/usr/bin/env node
// Cut a release: tag `main` with the package.json version and push it. The Release workflow
// (.github/workflows/release.yml) then publishes ada-agent to npm and creates the GitHub release.
//
// Run this AFTER you've bumped package.json + added a CHANGELOG entry and merged that to main.
//
//   npm run release              # tag v<version>, push, watch the publish
//   npm run release -- --no-watch
//
// Safe by construction: refuses unless you're on a clean `main`, the tag is new, and the version
// looks sane. The repo root is derived from this file's location, not the cwd (cwd can drift).

import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const REPO = "black141312/ada";
const noWatch = process.argv.includes("--no-watch");

const git = (...a) => execFileSync("git", ["-C", ROOT, ...a], { encoding: "utf8" }).trim();
const tryGit = (...a) => {
  try {
    return git(...a);
  } catch {
    return "";
  }
};
const die = (msg) => {
  console.error(`\x1b[31m✗ ${msg}\x1b[0m`);
  process.exit(1);
};
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

const version = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version;
if (!/^\d+\.\d+\.\d+/.test(version)) die(`package.json version "${version}" doesn't look like a release version.`);
const tag = `v${version}`;

// --- preflight ---
const branch = git("rev-parse", "--abbrev-ref", "HEAD");
if (branch !== "main") die(`releases are cut from main, but you're on "${branch}". Merge your branch to main first, then run this on main.`);
if (git("status", "--porcelain")) die("working tree is dirty — commit or stash first.");

git("fetch", "--tags", "--quiet", "origin");
if (tryGit("rev-parse", "-q", "--verify", `refs/tags/${tag}`)) die(`tag ${tag} already exists. Bump the version in package.json (and add a CHANGELOG entry) first.`);

if (!readFileSync(join(ROOT, "CHANGELOG.md"), "utf8").includes(`[${version}]`)) {
  console.warn(`\x1b[33m⚠ CHANGELOG.md has no [${version}] entry — releasing anyway.\x1b[0m`);
}

console.log(`Releasing \x1b[1m${tag}\x1b[0m from main…`);
git("pull", "--ff-only", "origin", "main");
git("tag", "-a", tag, "-m", `ada ${tag}`);
git("push", "origin", tag);
console.log(`\x1b[32m✓ pushed ${tag}\x1b[0m — the Release workflow is publishing ada-agent@${version}.`);

if (noWatch) {
  console.log(`Watch it: gh run watch --repo ${REPO}   ·   https://github.com/${REPO}/actions`);
  process.exit(0);
}
console.log("\nWatching the release run (Ctrl+C stops watching; the run keeps going)…\n");
sleep(4000); // give the tag push a moment to spawn the workflow run
const r = spawnSync("gh", ["run", "watch", "--repo", REPO, "--exit-status"], { stdio: "inherit" });
if (r.error) console.log(`(gh not available — check https://github.com/${REPO}/actions)`);
process.exit(r.status ?? 0);
