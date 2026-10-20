---
name: muse-video
description: "Muse Video: generate one video through the separate Muse Chrome. Requests share one queue and run one at a time. Connect the VPN before opening Muse, save the new mp4, and disconnect the VPN when the queue is empty. Do not open muse.ai yourself, do not use the main Chrome, and do not call muse.ai from the agent process."
---

# Muse Video

`muse-video send` is the whole video pipeline. It uses the separate Chrome at `~/.muse-video/chrome`. The main Chrome is never used.

## Pipeline

1. Start that Chrome on a blank page if it is not already running.
2. Turn Urban VPN on in that Chrome.
3. Read the exit country from a probe page. Continue only when it differs from this Mac.
4. Open one Muse tab for this job. Other jobs wait in the same queue.
5. If that page's exit country falls back to this Mac before the prompt is sent, reconnect the VPN, then close and reopen only this tab. During generation, reconnect without closing the tab.
6. Attach the mode's images, then send once. frame-to-video attaches the first frame, then the last frame if given. reference-to-video attaches only the reference images. text-to-video attaches nothing.
7. Save only the new mp4.
8. Close this job's Muse tab. Disconnect the VPN only when no job is left in the queue.

`status` and `latest` only look. They do not start Chrome and they do not open Muse. `status` also lists the queue.

## Rules

- Call LinkHub tool `muse-video.send`. `muse-video.status` and `muse-video.latest` only look. Do not open muse.ai yourself and do not run a shell command when that tool is listed.
- If LinkHub does not list `muse-video.send`, run `muse-video send --prompt "PROMPT" --download --wait 180 --json` once. Do not open a browser.
- Never call `muse.ai` from Node, Python, or curl.
- Never pass a flag that skips the VPN check.
- Send at most once per video. If the result is uncertain, inspect the saved file. Do not send that video again.
- Several agents may call `muse-video.send` at the same time. Those calls wait in one queue and run one after another on one Muse tab.

Call `send` with `mode`:

- `text-to-video`: prompt only.
- `frame-to-video`: `firstFrame` is required. `lastFrame` is optional. Do not put a reference image in `firstFrame`.
- `reference-to-video`: `references` is a list of image paths. One reference image is valid and is not a start frame.

`download` defaults to true and `wait` defaults to 180 seconds. `ok: true` in the result means the mp4 was saved.

If the MCP tool is not listed, the same pipeline is:

```bash
muse-video send --prompt "PROMPT" --download --wait 180 --json
```

`--country CC` or `MUSE_TAB_COUNTRY` adds a required exit country. Use it only when the owner named a country.
