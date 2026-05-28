# feat: add sharing tunnel and word cloud

## Summary

This commit adds two user-facing features:

- A host sharing flow powered by Cloudflare Quick Tunnel.
- A new live activity type: word cloud.

## Sharing Tunnel

- Added backend APIs to start, stop, and inspect a Cloudflare Quick Tunnel.
- The host live page starts the tunnel automatically when hosting begins.
- The host UI now exposes a single "Share Link" action.
- The share dialog shows a QR code, the generated Cloudflare URL, and a copy button.
- The dialog can be closed with the top-right close button or by clicking outside the dialog.
- Added fallback lookup for `cloudflared.exe` in common WinGet install locations.

## Word Cloud

- Added `word_cloud` as a supported activity type.
- Word cloud activities do not use options or correct answers.
- Participants submit free text directly as word cloud entries.
- A participant can submit multiple entries for the same word cloud activity.
- Word cloud results update live through the existing WebSocket summary flow.
- The result view only renders the live word cloud, without response counts or response details.
- Host controls hide result visibility and participant detail toggles for word cloud activities.

## Validation

- `bun run typecheck` passes.

## Notes

- The app must be restarted after installing `cloudflared` or changing `CLOUDFLARED_PATH`.
- `bun run build` may still fail in the current sandbox due to Windows filesystem access restrictions unrelated to this feature.
