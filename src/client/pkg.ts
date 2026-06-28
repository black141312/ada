// Extension package manager: `ada add <git-url | npm-package>` installs into .ada/extensions/
// as a directory the extension loader can import.

import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const EXT = resolve(process.cwd(), ".ada", "extensions");

export function addExtension(spec: string): void {
  mkdirSync(EXT, { recursive: true });

  if (spec.includes("://") || spec.startsWith("git@")) {
    const name = (spec.split("/").pop() ?? "ext").replace(/\.git$/, "");
    const r = spawnSync("git", ["clone", "--depth", "1", spec, join(EXT, name)], { stdio: "inherit" });
    if (r.status !== 0) throw new Error("git clone failed");
    console.log(`installed extension ${name} → .ada/extensions/${name}`);
    return;
  }

  // npm package: install into a self-contained dir + a re-export entry the loader imports.
  const pkgName = spec.replace(/@[^@/]+$/, ""); // drop a trailing @version
  const name = pkgName.replace(/^@/, "").replace(/\//g, "-");
  const dir = join(EXT, name);
  mkdirSync(dir, { recursive: true });
  const r = spawnSync("npm", ["install", spec, "--prefix", dir], { stdio: "inherit", shell: process.platform === "win32" });
  if (r.status !== 0) throw new Error("npm install failed");
  writeFileSync(join(dir, "index.mjs"), `export { default } from ${JSON.stringify(pkgName)};\n`);
  console.log(`installed extension ${name} (${pkgName}) → .ada/extensions/${name}`);
}

/** Self-update: ada runs from source, so update = git pull in the repo root. */
export function selfUpdate(): void {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", ".."); // src/client/pkg.ts → repo root
  const r = spawnSync("git", ["-C", root, "pull", "--ff-only"], { stdio: "inherit" });
  if (r.status !== 0) {
    console.error("self-update failed (is this a git checkout?)");
    process.exit(1);
  }
}
