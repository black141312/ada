// Install better-sqlite3's native binary for EVERY runtime this checkout is used from, and keep
// them side by side as `better_sqlite3-<abi>.node`.
//
// The problem this solves: one .node satisfies one Node ABI. The CLI runs on the system Node; the
// desktop app spawns the same agent under Electron's bundled Node (ELECTRON_RUN_AS_NODE=1), which
// has a different ABI. `npm install` builds for whichever ran it, so the other runtime dies with
// "NODE_MODULE_VERSION <x> … requires <y>" — and re-installing to fix that side breaks the first.
//
// src/server/sqlite-binding.ts then loads the copy matching the running ABI.
//
//   node scripts/sqlite-abi.mjs
//
// Safe to re-run, and safe when Electron isn't around: the Electron pass is skipped with a note
// rather than failing, so a CLI-only checkout still works.

import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const require_ = createRequire(import.meta.url);

function moduleRoot() {
  try {
    return dirname(require_.resolve("better-sqlite3/package.json"));
  } catch {
    return null;
  }
}

// Run from `postinstall` as well as by hand. A missing prebuild or an offline machine must never
// fail someone's `npm install` over this — it only costs them the second ABI, which is exactly the
// situation everyone was in before this script existed. Run directly, it still exits non-zero so a
// failure is visible.
//
// The `|| exit 0` on the postinstall script is not redundant with the handling below: the Dockerfile
// installs deps from package.json alone, before any sources are copied, so `npm ci` runs a
// postinstall pointing at a file that does not exist yet. node exits 1 before a single line here
// runs, and the whole image build fails.
const asPostinstall = process.env.npm_lifecycle_event === "postinstall";

const root = moduleRoot();
if (!root) {
  console.log("better-sqlite3 is not installed here — nothing to do.");
  process.exit(0);
}
const releaseDir = join(root, "build", "Release");
const built = join(releaseDir, "better_sqlite3.node");

/** Run prebuild-install inside better-sqlite3, then stash the result under its ABI number. */
function install(label, abi, args) {
  try {
    execFileSync(process.execPath, [require_.resolve("prebuild-install/bin.js"), ...args], {
      cwd: root,
      stdio: "pipe",
    });
  } catch (e) {
    const detail = `${e.stderr ?? ""}${e.stdout ?? ""}`;
    // Windows keeps a loaded .node locked, so this fails while the desktop app (or any `ada serve`)
    // is running — and prebuild-install's own message doesn't say which process to blame.
    if (/EBUSY|EPERM/.test(detail)) {
      throw new Error(`${label}: better_sqlite3.node is locked — close the Ada desktop app (and any running \`ada serve\`) and re-run.`);
    }
    throw new Error(`${label}: prebuild-install failed — ${detail.trim().split("\n").pop()}`);
  }
  if (!existsSync(built)) throw new Error(`${label}: prebuild-install produced no binary`);
  mkdirSync(releaseDir, { recursive: true });
  const dest = join(releaseDir, `better_sqlite3-${abi}.node`);
  copyFileSync(built, dest);
  console.log(`  ${label.padEnd(10)} ABI ${abi} -> ${dest.replace(root, "…")}`);
}

try {
  main();
} catch (e) {
  console.warn(`sqlite-abi: ${e.message}`);
  process.exit(asPostinstall ? 0 : 1);
}

function main() {
// 1. The system Node running this script.
console.log("installing better-sqlite3 binaries:");
install("node", process.versions.modules, []);

// 2. Electron, if a sibling app provides it. Its ABI is read from Electron itself rather than a
//    hardcoded table, so an Electron upgrade can't silently leave a stale mapping behind.
// Paths resolve relative to THIS file (cos0/scripts/), so the sibling app is two levels up.
const electronPkg = ["../../ada-app/node_modules/electron", "../node_modules/electron", "electron"]
  .map((p) => {
    try {
      return require_.resolve(`${p}/package.json`);
    } catch {
      return null;
    }
  })
  .find(Boolean);

if (!electronPkg) {
  console.log("  electron    not found beside this checkout — skipped (CLI-only tree)");
} else {
  const version = require_(electronPkg).version;
  const exe = join(dirname(electronPkg), "dist", process.platform === "win32" ? "electron.exe" : "electron");
  const abi = execFileSync(exe, ["-p", "process.versions.modules"], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
    encoding: "utf8",
  }).trim();
  install("electron", abi, ["--runtime", "electron", "--target", version]);
}

// Leave the default slot holding the system-Node build: anything that ignores the per-ABI copies
// (an old checkout, a stray tool) then behaves exactly as a plain `npm install` would.
install("node", process.versions.modules, []);
console.log("done — src/server/sqlite-binding.ts picks the matching one at runtime.");
}
