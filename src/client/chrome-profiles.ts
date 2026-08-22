// Which of the user's real Chrome profiles ada can actually drive.
//
// The bridge extension is per-profile: it is loaded into one profile's Chrome, and only that
// profile's tabs are reachable through it. Launching Chrome with `--profile-directory=Default` and
// hoping was the old behaviour, and it is wrong twice over — the extension may not be in Default,
// and `--load-extension` is ignored outright when Chrome is already running, which for most people
// it always is. So: find the profiles that already carry the extension, and drive one of those.

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface ChromeProfile {
  /** Directory name Chrome knows it by — "Default", "Profile 6". What --profile-directory wants. */
  dir: string;
  /** What the user knows it by — "adacodelabs.com — admin@adacodelabs.com". */
  label: string;
  /** Is the ada bridge extension loaded in this profile? Only these are drivable. */
  hasExtension: boolean;
}

export function chromeUserDataDir(): string {
  if (process.env.ADA_CHROME_USER_DATA) return process.env.ADA_CHROME_USER_DATA;
  if (process.platform === "win32") return join(process.env.LOCALAPPDATA ?? "", "Google/Chrome/User Data");
  if (process.platform === "darwin") return join(homedir(), "Library/Application Support/Google/Chrome");
  return join(homedir(), ".config/google-chrome");
}

/** Unpacked extensions record their source directory, so the ada bridge is identifiable by path.
 *  Matched loosely (basename, case-insensitive) because the same extension folder can be reached
 *  through a symlink or a differently-cased drive letter and still be the same extension. */
function carriesExtension(profileDir: string, extDir: string): boolean {
  const want = extDir.replace(/\\/g, "/").toLowerCase();
  const tail = want.split("/").slice(-2).join("/"); // ".../cos0/extension"
  for (const file of ["Secure Preferences", "Preferences"]) {
    const p = join(profileDir, file);
    if (!existsSync(p)) continue;
    try {
      const j = JSON.parse(readFileSync(p, "utf8")) as {
        extensions?: { settings?: Record<string, { path?: string; manifest?: { name?: string } }> };
      };
      for (const e of Object.values(j.extensions?.settings ?? {})) {
        const path = (e.path ?? "").replace(/\\/g, "/").toLowerCase();
        if (path && (path === want || path.endsWith(tail))) return true;
        if (e.manifest?.name === "ada bridge") return true;
      }
    } catch {
      // A profile whose preferences we cannot parse simply does not advertise the extension.
    }
  }
  return false;
}

/** Every Chrome profile, with the name the user would recognise and whether ada can drive it. */
export function listChromeProfiles(extDir: string): ChromeProfile[] {
  const root = chromeUserDataDir();
  if (!existsSync(root)) return [];
  let cache: Record<string, { name?: string; user_name?: string }> = {};
  try {
    const state = JSON.parse(readFileSync(join(root, "Local State"), "utf8")) as {
      profile?: { info_cache?: typeof cache };
    };
    cache = state.profile?.info_cache ?? {};
  } catch {
    return [];
  }
  return Object.entries(cache)
    .filter(([dir]) => existsSync(join(root, dir)))
    .map(([dir, v]) => ({
      dir,
      label: [v.name, v.user_name].filter(Boolean).join(" — ") || dir,
      hasExtension: carriesExtension(join(root, dir), extDir),
    }));
}

/** The profile Chrome itself opened last — the best guess when several are drivable and nobody
 *  is around to be asked. */
export function lastUsedProfile(): string | null {
  try {
    const state = JSON.parse(readFileSync(join(chromeUserDataDir(), "Local State"), "utf8")) as { profile?: { last_used?: string } };
    return state.profile?.last_used ?? null;
  } catch {
    return null;
  }
}

/** Asked when more than one profile carries the extension and there is no saved choice. The CLI
 *  installs a real picker; anything non-interactive (print mode, serve, a cron run) leaves it unset
 *  and takes the last-used profile instead, rather than blocking on a prompt nobody can answer. */
export type ProfileChooser = (choices: ChromeProfile[]) => Promise<string | null>;
let chooser: ProfileChooser | null = null;
export function setChromeProfileChooser(fn: ProfileChooser | null): void {
  chooser = fn;
}

/** Which profile directory to launch. Explicit choices win, then the only drivable profile, then
 *  the user, then whatever Chrome used last. */
export async function resolveChromeProfile(extDir: string, saved?: string): Promise<{ dir: string; why: string }> {
  const env = process.env.ADA_CHROME_PROFILE;
  if (env) return { dir: env, why: "ADA_CHROME_PROFILE" };

  const all = listChromeProfiles(extDir);
  const drivable = all.filter((p) => p.hasExtension);

  // A saved choice only counts while that profile still carries the extension - otherwise ada would
  // keep launching a profile it cannot actually drive, and fall back silently every time.
  if (saved && drivable.some((p) => p.dir === saved)) return { dir: saved, why: "settings" };

  if (drivable.length === 1) return { dir: drivable[0]!.dir, why: "the only profile with the extension" };

  if (drivable.length > 1) {
    if (chooser) {
      const picked = await chooser(drivable);
      if (picked) return { dir: picked, why: "you picked it" };
    }
    const last = lastUsedProfile();
    const hit = drivable.find((p) => p.dir === last) ?? drivable[0]!;
    return { dir: hit.dir, why: chooser ? "last used" : "last used (nothing to prompt on)" };
  }

  // Nobody has it yet. Launch the profile the user actually works in and side-load there.
  return { dir: lastUsedProfile() ?? "Default", why: "no profile has the extension yet" };
}
