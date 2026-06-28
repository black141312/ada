// Layered settings: global (~/.ada/settings.json) merged with project (.ada/settings.json),
// project winning. Also the project-trust list — project files are only loaded for trusted dirs.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

export interface Settings {
  model?: string;
  reasoning?: "low" | "medium" | "high";
  autoApprove?: boolean;
  compactAt?: number;
  trustedDirs?: string[];
  keybindings?: { interrupt?: string };
  protectedPaths?: string[];
  confirmDestructive?: boolean;
}

const GLOBAL = join(homedir(), ".ada", "settings.json");
const PROJECT = resolve(process.cwd(), ".ada", "settings.json");

function readJson(p: string): Settings {
  try {
    return JSON.parse(readFileSync(p, "utf8")) as Settings;
  } catch {
    return {};
  }
}

function writeGlobal(s: Settings): void {
  try {
    mkdirSync(dirname(GLOBAL), { recursive: true });
    writeFileSync(GLOBAL, JSON.stringify(s, null, 2), "utf8");
  } catch {
    /* best-effort */
  }
}

/** Global settings, with project settings merged in (project overrides) when trusted. */
export function loadSettings(includeProject: boolean): Settings {
  const g = readJson(GLOBAL);
  return includeProject ? { ...g, ...readJson(PROJECT) } : g;
}

export function isTrusted(dir: string): boolean {
  return (readJson(GLOBAL).trustedDirs ?? []).includes(dir);
}

export function addTrust(dir: string): void {
  const g = readJson(GLOBAL);
  const dirs = new Set(g.trustedDirs ?? []);
  dirs.add(dir);
  writeGlobal({ ...g, trustedDirs: [...dirs] });
}
