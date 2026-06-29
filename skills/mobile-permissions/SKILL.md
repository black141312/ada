---
name: mobile-permissions
description: Request and handle runtime permissions correctly across iOS and Android
category: mobile
---

# Mobile Permissions

Use this when a feature needs a sensitive capability (camera, location, mic, notifications, photos) and you must request, check, and gracefully handle the runtime permission.

1. Declare the permission up front: add it to `AndroidManifest.xml` and the matching `NSUsageDescription` (purpose string) keys in iOS `Info.plist` — both are required or the OS denies/rejects.
2. Check current status before requesting; if already granted, proceed without prompting again.
3. Request just-in-time, tied to the user action that needs it, and show a brief rationale first when the platform reports the user previously denied.
4. Handle every branch: granted, denied, and permanently-denied/"don't ask again" — for the last case route the user to system Settings.
5. Re-check status on screen resume (the user may have toggled it in Settings) and update the UI accordingly.
6. Gate the actual capability call behind a confirmed grant, and provide a degraded but functional fallback when denied.

## Rules
- Never request a permission at app launch with no context — request at the moment of use.
- A missing iOS usage-description string causes an immediate crash on request; always add the purpose key.
- Android 13+ needs runtime `POST_NOTIFICATIONS`; older targets don't — branch on API level.
- Treat permanent denial as terminal in-app: you cannot re-prompt, only deep-link to Settings.
- Request the narrowest scope that works (e.g. "while in use" location, not "always"); over-asking gets review rejections.
