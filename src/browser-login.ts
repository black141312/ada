// Open ada's own browser, visibly, at one or more sign-in pages so the user can log in by hand ONCE.
//
// Why this exists: there is no way to drive the user's real Chrome profile. Verified on Chrome 151:
//   --remote-debugging-port  → port silently never opens on the default data dir
//   --remote-debugging-pipe  → "DevTools remote debugging requires a non-default data directory"
//   copying the profile      → Chrome drops every app-bound (v20) cookie on first launch
// So ada keeps its own profile. Sessions created inside it are sealed for it and persist across
// runs indefinitely — this is a one-time cost per site, not a per-run cost.
//
// Run with: npm run browser:login -- linkedin.com github.com mail.google.com
import { browserAction, tabAction } from "./client/browser.ts";

const sites = process.argv.slice(2);
if (!sites.length) {
  console.log(`Usage: npm run browser:login -- <site> [site...]\n`);
  console.log(`Opens each site in ada's browser so you can sign in once. Example:`);
  console.log(`  npm run browser:login -- linkedin.com github.com x.com`);
  process.exit(0);
}

// A visible window is the whole point here — never let the headless default win.
process.env.ADA_BROWSER_HEADLESS = "0";

const url = (s: string): string => (/^https?:\/\//i.test(s) ? s : `https://${s}`);

for (const [i, site] of sites.entries()) {
  if (i > 0) await tabAction("tab_new");
  const r = await browserAction("open", { url: url(site) });
  console.log(`  ${r.text.split("\n")[0]}`);
}

console.log(`\n${sites.length} tab(s) open in ada's browser.`);
console.log(`Sign into each one. Your credentials go into the browser, never through ada.`);
console.log(`These sessions persist in ~/.ada/browser-profile — you will not have to do this again.`);
console.log(`Leave the window open or close it; either way the cookies are saved.`);
