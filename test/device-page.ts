// The device sign-in page offers exactly the social providers that have creds in env — a button for
// a provider Better Auth never registered would 500 on click.
import assert from "node:assert/strict";

for (const k of ["GITHUB_CLIENT_ID", "GITHUB_CLIENT_SECRET", "GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"]) delete process.env[k];
const { devicePage } = await import("../src/server/index.ts");

const none = devicePage();
assert.ok(!none.includes("data-provider"), "no creds → no sign-in buttons");
assert.match(none, /No sign-in provider is configured/, "and it says so");

process.env.GITHUB_CLIENT_ID = "id";
process.env.GITHUB_CLIENT_SECRET = "secret";
const gh = devicePage();
assert.match(gh, /data-provider="github"/, "GitHub creds → GitHub button");
assert.ok(!gh.includes('data-provider="google"'), "half-configured Google must not get a button");

process.env.GOOGLE_CLIENT_ID = "id";
process.env.GOOGLE_CLIENT_SECRET = "secret";
const both = devicePage();
assert.match(both, /data-provider="github"/);
assert.match(both, /data-provider="google"/, "Google creds → Google button");
assert.match(both, /Continue with Google/, "labelled for a human");

console.log("device page: buttons follow the configured providers (github, google)");
process.exit(0);
