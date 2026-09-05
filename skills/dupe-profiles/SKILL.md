---
name: dupe-profiles
description: Build, list, open and remove isolated, colour-coded profiles of desktop apps (Claude, ChatGPT, Grok Bot, Slack, VS Code, Chrome, or any Electron app by path) on macOS, Windows or Linux. Use when the user wants a second copy of an app for another account, a "work" and "personal" version of an app, separate logins side by side, or a different icon colour per account. Triggers on "work profile", "second instance", "two accounts", "clone the app", "separate Claude for work", "Claude Work", "duplicate app".
license: MIT
---

# dupe profiles

`dupe` turns one installed app into several profiles. Each profile has its own data directory (so its own login), its own launcher and Dock/Start Menu entry, and the app's icon recoloured so the copies are distinguishable at a glance. The stock app is untouched and remains the default profile.

## How to run it

Prefer the MCP tools if the `dupe` server is connected: `list_apps`, `add_profile`, `remove_profile`, `rebuild_profiles`, `open_profile`, `recolor_icon`, `palette`. They return structured JSON.

Otherwise use the CLI from this plugin's root with Node 20+, no install needed:

```bash
node <plugin-root>/bin/dupe.js list
node <plugin-root>/bin/dupe.js add claude work
node <plugin-root>/bin/dupe.js add claude client-a --color green --label "Claude · Acme"
node <plugin-root>/bin/dupe.js add "/Applications/Slack.app" personal
node <plugin-root>/bin/dupe.js remove claude work            # keeps data; add --purge to delete it
node <plugin-root>/bin/dupe.js rebuild                        # after the stock app updated (macOS needs this)
node <plugin-root>/bin/dupe.js open claude work
node <plugin-root>/bin/dupe.js ui                             # the browser interface, connected to this computer
```

If `dupe` is installed globally (`npm install -g @hktitan/dupe`), the command is just `dupe`.

## Process

1. **Look before building.** Run `list_apps` (or `dupe list`). It says which presets are installed and where, and which profiles already exist. Do not guess paths; if the app isn't a preset, pass its path.
2. **Name the profile from the user's words.** "work", "personal", "client-a", "acme". Names are slugged (lowercase, hyphens). The label defaults to "<App> <Profile>"; set `label` when the user gave one.
3. **Colour.** The first profile of an app is blue (Stephen Wu's "blue means work"); each further one takes the next palette colour automatically. Only pass `color` when the user asked for one. Accept palette names (blue, green, purple, amber, red, teal, pink, gray) or a hex.
4. **Build**, then tell the user exactly what was made: label, where the launcher/bundle is, and the hint the tool returns (pin from Start Menu on Windows; Launchpad/Dock on macOS; app launcher on Linux).
5. **After a stock-app update on macOS**, run `rebuild_profiles`. Windows and Linux profiles run the stock binary in place and pick updates up automatically.

## What isolation means here

Profiles are separated by Chromium's `--user-data-dir` plus whatever the preset pins: ChatGPT's `CODEX_HOME`, Grok Bot's `SAND_DATA_ROOT`, VS Code/Cursor's `--extensions-dir`. Anything an app stores elsewhere (a keychain item, a global daemon) is shared. Say so if the user asks about a guarantee.

## When not to use it

- Android or iOS: nothing can be built. Point the user at `docs/android.md` (work profile via Shelter, OEM app cloning) and `docs/ios.md` (isolated Home Screen web apps) in this plugin.
- Apps that are not Electron or Chromium based will not honour the flag. The tool still builds a launcher, but the profile will share data; warn the user first.
- Only run `remove_profile` with `purge: true` when the user explicitly wants that profile's data gone.

## Platform notes

- **Windows**: needs the .NET Framework `csc.exe` (present on every Windows 10/11). Store (MSIX) installs of Claude and ChatGPT are supported; the launcher resolves the package at launch. The launcher process stays alive next to the app to give it a separate taskbar identity.
- **macOS**: clones the bundle (APFS copy-on-write), re-signs ad hoc, drops quarantine. Profiles are frozen snapshots of the stock app; rebuild after updates.
- **Linux**: writes a `.desktop` entry with `--class` so the dock separates the windows. If the icon is only SVG, `rsvg-convert`, `inkscape` or ImageMagick must be present, or pass `--icon some.png`.
