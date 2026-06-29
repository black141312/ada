// Layered settings: global (~/.ada/settings.json) merged with project (.ada/settings.json),
// project winning. Also the project-trust list — project files are only loaded for trusted dirs.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

export type PermAction = "allow" | "ask" | "deny";
export interface PermRule {
  tool?: string; // glob over the tool name (e.g. "bash", "web_*"); omit = any tool
  pattern?: string; // glob/substring over the call summary (args); omit = any
  action: PermAction;
}

export interface Settings {
  model?: string;
  reasoning?: "low" | "medium" | "high";
  autoApprove?: boolean;
  compactAt?: number;
  trustedDirs?: string[];
  keybindings?: { interrupt?: string };
  protectedPaths?: string[];
  confirmDestructive?: boolean;
  permissions?: PermRule[]; // per-tool allow/ask/deny rules; last match wins
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

function globMatch(pat: string, s: string): boolean {
  const re = new RegExp(`^${pat.split("*").map((p) => p.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`, "i");
  return re.test(s);
}

/** Evaluate the configured permission rules for a tool call. null = no matching rule (use defaults). */
export function permissionFor(toolName: string, summary: string): PermAction | null {
  const rules = loadSettings(isTrusted(process.cwd())).permissions ?? [];
  let result: PermAction | null = null;
  for (const r of rules) {
    const toolOk = !r.tool || r.tool === toolName || globMatch(r.tool, toolName);
    const patOk = !r.pattern || summary.toLowerCase().includes(r.pattern.toLowerCase()) || globMatch(r.pattern, summary);
    if (toolOk && patOk) result = r.action; // last match wins
  }
  return result;
}

export function addTrust(dir: string): void {
  const g = readJson(GLOBAL);
  const dirs = new Set(g.trustedDirs ?? []);
  dirs.add(dir);
  writeGlobal({ ...g, trustedDirs: [...dirs] });
}
