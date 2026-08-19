// Layered settings: global (~/.ada/settings.json) merged with project (.ada/settings.json),
// project winning. Also the project-trust list — project files are only loaded for trusted dirs.

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

export type PermAction = "allow" | "ask" | "deny";
export interface PermRule {
  tool?: string; // glob over the tool name (e.g. "bash", "web_*"); omit = any tool
  pattern?: string; // glob/substring over the call summary (args); omit = any
  action: PermAction;
}

export interface Settings {
  backendUrl?: string; // which ada-server the client talks to (a hosted server / Cloudflare Worker); env ADA_BACKEND_URL overrides
  backendKey?: string; // bearer/seat key for that backend
  model?: string;
  subagentModel?: string; // model for spawn_agent / background_task; unset = same as the main model
  strategy?: string; // orchestration architecture every session starts in (auto | react | single | plan | toolsmith | rlm); --strategy still wins for one run
  browseModel?: string; // model that drives the browser for the `browse` tool; unset = Sonnet 4.6 (see browse.ts)
  reasoning?: "low" | "medium" | "high";
  autoApprove?: boolean;
  compactAt?: number;
  verify?: string; // command run after a turn that edited files (e.g. "npm run typecheck"); failures are fed back to the model. Env ADA_VERIFY overrides. Unset = LSP diagnostics on the edited files.
  trustedDirs?: string[];
  keybindings?: { interrupt?: string };
  protectedPaths?: string[];
  confirmDestructive?: boolean;
  permissions?: PermRule[]; // per-tool allow/ask/deny rules; last match wins
  agents?: Record<string, { description?: string; prompt?: string; permissions?: PermRule[] }>; // named agent profiles
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
    // Owner-only: settings.json can hold `backendKey` (a seat/bearer key). This is an in-place write,
    // so writeFileSync's mode is ignored for a pre-existing file — chmod explicitly to fix 0644 leftovers.
    mkdirSync(dirname(GLOBAL), { recursive: true, mode: 0o700 });
    writeFileSync(GLOBAL, JSON.stringify(s, null, 2), { encoding: "utf8", mode: 0o600 });
    try {
      chmodSync(GLOBAL, 0o600);
    } catch {
      /* best-effort (no-op on Windows) */
    }
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

// A named agent's permission rules override the configured ones while it's active.
let activeAgentPerms: PermRule[] | null = null;
export function setActiveAgentPermissions(rules: PermRule[] | null): void {
  activeAgentPerms = rules;
}

// Org policy pushed by an enterprise backend (fetched from /v1/policy at startup). Merged
// restrictive-wins: an org "deny" beats any local "allow"; an org "ask" upgrades a local "allow".
// A local "deny" always stands — the org can tighten a user's setup, never loosen it.
let orgPerms: PermRule[] | null = null;
export function setOrgPermissions(rules: PermRule[] | null): void {
  orgPerms = rules?.length ? rules : null;
}

function evalRules(rules: PermRule[], toolName: string, summary: string): PermAction | null {
  let result: PermAction | null = null;
  for (const r of rules) {
    const toolOk = !r.tool || r.tool === toolName || globMatch(r.tool, toolName);
    const patOk = !r.pattern || summary.toLowerCase().includes(r.pattern.toLowerCase()) || globMatch(r.pattern, summary);
    if (toolOk && patOk) result = r.action; // last match wins
  }
  return result;
}

const STRICTNESS: Record<PermAction, number> = { allow: 0, ask: 1, deny: 2 };

/** Evaluate the configured permission rules for a tool call. null = no matching rule (use defaults). */
export function permissionFor(toolName: string, summary: string): PermAction | null {
  const local = evalRules(activeAgentPerms ?? loadSettings(isTrusted(process.cwd())).permissions ?? [], toolName, summary);
  if (!orgPerms) return local;
  const org = evalRules(orgPerms, toolName, summary);
  if (org === null) return local;
  if (local === null) return org === "allow" ? null : org; // org can't LOOSEN the default gating, only tighten
  return STRICTNESS[org] > STRICTNESS[local] ? org : local;
}

/** Merge a patch into GLOBAL settings and persist (used by /connect). */
export function setGlobal(patch: Partial<Settings>): void {
  writeGlobal({ ...readJson(GLOBAL), ...patch });
}

export function addTrust(dir: string): void {
  const g = readJson(GLOBAL);
  const dirs = new Set(g.trustedDirs ?? []);
  dirs.add(dir);
  writeGlobal({ ...g, trustedDirs: [...dirs] });
}

/**
 * Every folder of the current workspace: the working directory first, then any the IDE added
 * (ADA_EXTRA_DIRS). One definition, because the agent's prompt and the search tool have to agree
 * about which folders exist — if they drift, the model is told about a folder it cannot search.
 */
export function workspaceDirs(): string[] {
  const raw = process.env.ADA_EXTRA_DIRS?.trim();
  const extra = raw ? raw.split(process.platform === "win32" ? ";" : ":").filter(Boolean) : [];
  const seen = new Set<string>();
  return [process.cwd(), ...extra].filter((d) => {
    const key = resolve(d).toLowerCase();
    if (seen.has(key)) return false; // adding the folder you are already in must not double it
    seen.add(key);
    return true;
  });
}

/**
 * Create a project's `.ada/` and make its CACHES self-ignoring.
 *
 * Ada writes into whatever repo you open, and the search index alone is over a megabyte. Without
 * this those files show up as `?? .ada/` in the user's own project — noise in every `git status`,
 * and one `git add .` away from a binary blob in someone's history.
 *
 * A `.gitignore` INSIDE the directory ignores it wherever it lands, without touching the repo's own
 * .gitignore. Deliberately not a blanket `*`: memory/ and skills/ are meant to be committed and
 * shared with the team, so only the machine-generated caches are listed.
 */
export function ensureAdaDir(dir: string): string {
  mkdirSync(dir, { recursive: true });
  const f = join(dir, ".gitignore");
  if (!existsSync(f)) {
    try {
      writeFileSync(
        f,
        [
          "# Written by ada. These are local caches — rebuilt on demand, never worth committing.",
          "# memory/ and skills/ are NOT listed: those are yours, and meant to be shared.",
          "# This file ignores itself so an untouched .ada leaves `git status` completely clean;",
          "# ada rewrites it whenever the folder is missing one, so nothing is lost by not tracking it.",
          ".gitignore",
          "brain.json",
          "index.json",
          "index.vec",
          "graph.db",
          "jobs.json",
          "sessions/",
          "tmp/",
          "worktrees/",
          "",
        ].join("\n"),
      );
    } catch {
      /* read-only checkout — the caches still work, they are just visible to git */
    }
  } else {
    // An install from before jobs.json existed already has this file, and ensureAdaDir only writes
    // it when absent — so those projects would start showing `?? .ada/jobs.json`, the exact noise
    // this whole helper exists to prevent. Append rather than rewrite: the file may be hand-edited.
    try {
      const cur = readFileSync(f, "utf8");
      if (!/^jobs\.json$/m.test(cur)) writeFileSync(f, `${cur.endsWith("\n") ? cur : `${cur}\n`}jobs.json\n`);
    } catch {
      /* read-only checkout — the caches still work, they are just visible to git */
    }
  }
  return dir;
}
