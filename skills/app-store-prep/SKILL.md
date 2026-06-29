---
name: app-store-prep
description: Prepare a store listing and run the release-build checklist before submission
category: mobile
---

# App Store Prep

Use this when readying a mobile app for App Store / Google Play submission: building the signed release artifact and assembling the metadata a reviewer needs.

1. Bump the version: set a human-facing version name and increment the build/version code (each upload must be unique and monotonically increasing).
2. Produce a signed release build — iOS archive (`.ipa`) with the correct distribution profile, Android `.aab` signed with the upload key — using release config, not debug.
3. Strip debug artifacts: remove logging, test endpoints, and unused permissions; confirm release flags (minify/shrink, no debuggable) and crash reporting are on.
4. Assemble store assets: icon, screenshots per required device size, a privacy policy URL, and the data-collection / privacy questionnaire (App Privacy / Data safety).
5. Write the listing: title, subtitle, description, keywords, category, age rating, and accurate "what's new" notes.
6. Run a final pre-submit pass on a real device from the release artifact, then upload, fill review notes (and demo credentials if login is required), and submit.

## Rules
- Keep signing keys/keystores backed up and out of version control; losing the Android upload key blocks future updates.
- Every store upload needs a higher build number than the last — reusing one is rejected.
- Match declared permissions and privacy answers to actual behavior; mismatches are the top rejection cause.
- Provide working demo/login credentials in review notes for any gated feature, or review will fail.
- Test the release (not debug) build on a physical device — debug-only crashes and ProGuard/R8 stripping surface here.
