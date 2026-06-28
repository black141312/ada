// Extensions: JS/TS in .ada/extensions/ (project) or ~/.ada/extensions/ (global). An entry can be
// a file (foo.ts) or a directory (package.json "main", else index.{ts,js,mjs}) — so `ada add`
// can clone/install whole packages. Each default-exports { name?, tools?, onStart? }.

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { registerTool, type Tool } from "./tools.ts";
import { addHook, type ToolHooks } from "./hooks.ts";

export interface Command {
  name: string;
  description?: string;
  run(args: string): string | void | Promise<string | void>;
}

export interface Extension {
  name?: string;
  tools?: Tool[];
  hooks?: ToolHooks;
  commands?: Command[];
  onStart?: () => void | Promise<void>;
}

const commands = new Map<string, Command>();
export function getCommands(): Map<string, Command> {
  return commands;
}

function extDirs(includeProject: boolean): string[] {
  const global = resolve(homedir(), ".ada", "extensions");
  return includeProject ? [resolve(process.cwd(), ".ada", "extensions"), global] : [global];
}

/** Resolve an entry (file or directory) to an importable module URL, or null. */
function entryUrl(full: string): string | null {
  try {
    if (statSync(full).isDirectory()) {
      const pkg = join(full, "package.json");
      if (existsSync(pkg)) {
        const main = (JSON.parse(readFileSync(pkg, "utf8")) as { main?: string }).main;
        if (main && existsSync(join(full, main))) return pathToFileURL(join(full, main)).href;
      }
      for (const idx of ["index.ts", "index.js", "index.mjs"]) {
        if (existsSync(join(full, idx))) return pathToFileURL(join(full, idx)).href;
      }
      return null;
    }
    return /\.(ts|js|mjs)$/.test(full) ? pathToFileURL(full).href : null;
  } catch {
    return null;
  }
}

export async function loadExtensions(includeProject: boolean): Promise<string[]> {
  const loaded: string[] = [];
  for (const dir of extDirs(includeProject)) {
    if (!existsSync(dir)) continue;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const e of entries) {
      const url = entryUrl(join(dir, e));
      if (!url) continue;
      try {
        const ext = ((await import(url)) as { default?: Extension }).default;
        if (!ext) continue;
        for (const t of ext.tools ?? []) registerTool(t);
        if (ext.hooks) addHook(ext.hooks);
        for (const c of ext.commands ?? []) commands.set(c.name, c);
        await ext.onStart?.();
        loaded.push(ext.name ?? e);
      } catch (err) {
        console.error(`extension ${e} failed: ${err instanceof Error ? err.message : err}`);
      }
    }
  }
  return loaded;
}
