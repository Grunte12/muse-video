---
name: muse-tab
description: "Send one video prompt through the separate Muse Chrome. The command connects the VPN extension before opening Muse, saves the new mp4, then closes the Muse page and disconnects the VPN. Do not open muse.ai yourself, do not use the main Chrome, and do not call muse.ai from the agent process."
---

# Muse tab

`muse-tab send` is the whole video pipeline. It uses the separate Chrome at `~/.muse-tab/chrome`. The main Chrome is never used.

## Pipeline

1. Start that Chrome on a blank page if it is not already running.
2. Turn Urban VPN on in that Chrome.
3. Read the exit country from a probe page. Continue only when it differs from this Mac.
4. Open the Muse page.
5. If that page's exit country falls back to this Mac, close it, reconnect the VPN, confirm the country, then open Muse again.
6. Send the prompt once.
7. Save only the new mp4.
8. Close the Muse page, then disconnect the VPN.

`status` and `latest` only look. They do not start Chrome and they do not open Muse.

## Rules

- Run `muse-tab send`. Do not open muse.ai in any browser yourself.
- Never call `muse.ai` from Node, Python, or curl.
- Never pass a flag that skips the VPN check.
- Send at most once. If the result is uncertain, inspect the saved file. Do not send again.

```bash
muse-tab send --prompt "PROMPT" --download --wait 180 --json
```

Exit 0 means the new mp4 was saved. Exit 4 means no mp4 was saved before the wait ended. Exit 3 means the VPN route was not confirmed, so Muse was not left open.

`--country CC` or `MUSE_TAB_COUNTRY` adds a required exit country. Use it only when the owner named a country.
