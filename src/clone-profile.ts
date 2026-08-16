// Copy state out of the user's real Chrome profile into a profile ada is allowed to drive.
//
// READ THIS BEFORE EXPECTING LOGINS TO COME ALONG: on Chrome 127+ for Windows, cookies are sealed
// with app-bound encryption ("v20" values) instead of plain DPAPI ("v10"). A v20 cookie only
// decrypts for Chrome running against the profile it was written for; launch Chrome on a *copy* and
// it silently drops every one of them, leaving a same-sized database with the cookies vacuumed out.
// Measured here: a profile with 3879 v20 cookies and 4 li_at entries came back with 0 of each.
// So this script moves preferences, history and localStorage — not sessions. To automate a site you
// are logged into, log in once inside ada's own browser profile instead; sessions created there are
// sealed for that profile and persist. (And no, pointing --remote-debugging-port at the real profile
// dir is not a way around it: Chrome 136+ refuses to open the port at all, verified.)
//
// Run with: npm run browser:profile -- [profile] [--list]
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** The per-profile files that carry identity. Everything else Chrome will rebuild on first run. */
const FILES = [
  "Network/Cookies",
  "Cookies",
  "Preferences",
  "Secure Preferences",
  "Login Data",
  "Login Data For Account",
  "Web Data",
  "History",
];
/** Directories worth having: SPAs keep tokens in localStorage, not only in cookies. */
const DIRS = ["Local Storage", "Session Storage", "IndexedDB"];

function userDataDir(): string {
  if (process.env.ADA_CHROME_USER_DATA) return process.env.ADA_CHROME_USER_DATA;
  if (process.platform === "win32") return join(process.env.LOCALAPPDATA ?? "", "Google/Chrome/User Data");
  if (process.platform === "darwin") return join(homedir(), "Library/Application Support/Google/Chrome");
  return join(homedir(), ".config/google-chrome");
}

/** Chrome records a display name and signed-in email per profile directory in Local State. */
function profiles(root: string): { dir: string; who: string }[] {
  try {
    const state = JSON.parse(readFileSync(join(root, "Local State"), "utf8")) as {
      profile?: { info_cache?: Record<string, { name?: string; user_name?: string }> };
    };
    const cache = state.profile?.info_cache ?? {};
    return Object.entries(cache).map(([dir, v]) => ({ dir, who: [v.name, v.user_name].filter(Boolean).join(" — ") || "(unnamed)" }));
  } catch {
    return [];
  }
}

function main(): void {
  const root = userDataDir();
  if (!existsSync(root)) throw new Error(`no Chrome user data at ${root} — set ADA_CHROME_USER_DATA`);
  const args = process.argv.slice(2);
  const found = profiles(root);

  if (args.includes("--list") || !args.length) {
    console.log(`Chrome profiles in ${root}:\n`);
    for (const p of found) console.log(`  ${p.dir.padEnd(12)} ${p.who}`);
    console.log(`\nClone one with:  npm run browser:profile -- "Default"`);
    return;
  }

  const profile = args[0]!;
  const src = join(root, profile);
  if (!existsSync(src)) throw new Error(`no such profile directory: ${src} — run with --list`);
  const dest = process.env.ADA_BROWSER_PROFILE || join(homedir(), ".ada", "browser-profile");
  // The clone always presents as "Default" so ada never needs --profile-directory.
  const destProfile = join(dest, "Default");
  mkdirSync(join(destProfile, "Network"), { recursive: true });

  // Local State holds os_crypt.encrypted_key — without it Chrome cannot read the copied cookies.
  copyFileSync(join(root, "Local State"), join(dest, "Local State"));
  let copied = 0;
  let bytes = 0;
  let locked = false;
  for (const f of FILES) {
    const from = join(src, f);
    if (!existsSync(from)) continue;
    try {
      copyFileSync(from, join(destProfile, f));
      copied++;
      bytes += statSync(from).size;
    } catch (e) {
      // Chrome keeps some of these open; a locked file is a warning, not a failure.
      if (f.endsWith("Cookies")) locked = true;
      console.warn(`  skipped ${f}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  for (const d of DIRS) {
    const from = join(src, d);
    if (!existsSync(from)) continue;
    try {
      cpSync(from, join(destProfile, d), { recursive: true });
      copied++;
    } catch (e) {
      console.warn(`  skipped ${d}/: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  // Tell the user up front whether the cookies they just copied are the kind that survive.
  const jar = join(destProfile, "Network/Cookies");
  if (existsSync(jar)) {
    const raw = readFileSync(jar).toString("latin1");
    const v20 = (raw.match(/v20/g) ?? []).length;
    const v10 = (raw.match(/v10/g) ?? []).length;
    if (v20) {
      console.log(`\n${v20} of the copied cookies use app-bound encryption (v20) and ${v10} use v10.`);
      console.log(`Chrome will discard the v20 ones on first launch against this copy — those logins`);
      console.log(`will NOT carry over. Log in once in ada's browser instead; that session persists.`);
    }
  }
  console.log(`cloned ${profile} → ${dest} (${copied} items, ${(bytes / 1e6).toFixed(1)} MB of state)`);
  if (!existsSync(jar) || locked) {
    console.log(`\nWARNING: the cookie database was locked, so your logins did NOT come across.`);
    console.log(`Chrome holds an exclusive lock on it while running — even esentutl/VSS copies fail.`);
    console.log(`Quit Chrome completely (check the tray), then run this again.`);
  }
}

main();
