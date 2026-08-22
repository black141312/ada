// Which real Chrome profile the bridge drives. The extension is per-profile, so launching the wrong
// one gets a browser ada cannot reach — and it fails silently, by falling back to ada's own profile.
// Built against a fake User Data tree so the multi-profile cases are testable on any machine.
//   run: node --import tsx test/chrome-profiles.mjs
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = join(tmpdir(), `ada-profiles-${process.pid}`);
const EXT = join(root, "repo", "cos0", "extension");

/** Build a User Data tree: `withExt` profiles carry the ada bridge, the rest do not. */
function chrome(profiles, lastUsed) {
  rmSync(root, { recursive: true, force: true });
  mkdirSync(root, { recursive: true });
  const info = {};
  for (const [dir, name, withExt] of profiles) {
    mkdirSync(join(root, dir), { recursive: true });
    info[dir] = { name, user_name: `${name}@example.com` };
    const settings = withExt ? { abc: { path: EXT, manifest: { name: "ada bridge" } } } : { xyz: { path: "C:/other/ext", manifest: { name: "Some Other Thing" } } };
    writeFileSync(join(root, dir, "Secure Preferences"), JSON.stringify({ extensions: { settings } }));
  }
  writeFileSync(join(root, "Local State"), JSON.stringify({ profile: { info_cache: info, last_used: lastUsed } }));
  process.env.ADA_CHROME_USER_DATA = root;
}

const { listChromeProfiles, resolveChromeProfile, setChromeProfileChooser, lastUsedProfile } = await import("../src/client/chrome-profiles.ts");

try {
  // --- detection -----------------------------------------------------------------
  chrome(
    [
      ["Default", "Aditya", true],
      ["Profile 2", "epicthreadz", false],
      ["Profile 6", "adacodelabs", true],
    ],
    "Profile 2",
  );
  const all = listChromeProfiles(EXT);
  assert.equal(all.length, 3, "should see every profile, drivable or not");
  assert.deepEqual(
    all.filter((p) => p.hasExtension).map((p) => p.dir),
    ["Default", "Profile 6"],
    "only profiles carrying the extension are drivable",
  );
  assert.match(all[0].label, /Aditya/, "profiles are labelled by the name the user recognises, not the directory");
  assert.equal(lastUsedProfile(), "Profile 2");

  // --- one drivable profile: no question worth asking ----------------------------
  chrome([["Default", "Aditya", true], ["Profile 2", "epicthreadz", false]], "Profile 2");
  setChromeProfileChooser(async () => assert.fail("must not prompt when only one profile is drivable"));
  assert.equal((await resolveChromeProfile(EXT)).dir, "Default");

  // --- several drivable: ask ------------------------------------------------------
  chrome([["Default", "Aditya", true], ["Profile 6", "adacodelabs", true]], "Default");
  let offered = null;
  setChromeProfileChooser(async (choices) => {
    offered = choices.map((c) => c.dir);
    return "Profile 6";
  });
  assert.equal((await resolveChromeProfile(EXT)).dir, "Profile 6", "the user's pick wins");
  assert.deepEqual(offered, ["Default", "Profile 6"], "only drivable profiles are offered");

  // --- several drivable, nobody to ask (print mode, cron): last used, never a prompt
  setChromeProfileChooser(null);
  assert.equal((await resolveChromeProfile(EXT)).dir, "Default", "falls back to the profile chrome used last");

  // --- a saved choice is honoured, but only while it still carries the extension ---
  setChromeProfileChooser(async () => assert.fail("a valid saved choice must not re-prompt"));
  assert.equal((await resolveChromeProfile(EXT, "Profile 6")).dir, "Profile 6");

  chrome([["Default", "Aditya", true], ["Profile 6", "adacodelabs", false]], "Default");
  setChromeProfileChooser(null);
  assert.equal(
    (await resolveChromeProfile(EXT, "Profile 6")).dir,
    "Default",
    "a saved profile that lost the extension must be ignored, not launched into a browser ada cannot drive",
  );

  // --- nothing has it yet: open where the user actually works and side-load there --
  chrome([["Default", "Aditya", false], ["Profile 6", "adacodelabs", false]], "Profile 6");
  const none = await resolveChromeProfile(EXT);
  assert.equal(none.dir, "Profile 6", "with no extension anywhere, start the profile the user last used");
  assert.match(none.why, /no profile has the extension/);

  // --- an explicit env var beats all of it ----------------------------------------
  process.env.ADA_CHROME_PROFILE = "Profile 2";
  assert.equal((await resolveChromeProfile(EXT)).dir, "Profile 2");
  delete process.env.ADA_CHROME_PROFILE;

  console.log("ok");
} finally {
  rmSync(root, { recursive: true, force: true });
  delete process.env.ADA_CHROME_USER_DATA;
}
