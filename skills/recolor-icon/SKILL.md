---
name: recolor-icon
description: Recolour an app icon toward a target colour while keeping its shading, texture and marks, and write it as .png, .ico or .icns. Use when the user wants a blue/green/any-colour version of an app icon, a tinted icon for a second account, a custom icon for an Android launcher or iOS Shortcut, or matching icons for a set of apps. Triggers on "recolour the icon", "make the icon blue", "tint this icon", "icon for the work copy", "extract the icon from the exe".
license: MIT
---

# recolor-icon

Recolours an icon so a set of copies reads as one family that differs only by hue. Two treatments, picked automatically from the icon itself:

- **hue** for colourful icons: every pixel keeps its lightness and relative chroma; only the hue rotates so the dominant colour lands on the target. Shadows, texture and near-white marks survive.
- **ramp** for grayscale icons (a black knot on white, a white ghost on black): the field is detected from the icon's outer edge and mapped exactly to the target colour, the mark to white. A dark field gets a third stop below it so outlines darker than the field stay darker.

## How to run it

MCP tool, if the `dupe` server is connected:

```json
{ "name": "recolor_icon", "arguments": { "input": "/path/app.icns", "output": "/path/app-work.icns", "color": "blue" } }
```

CLI, from this plugin's root (Node 20+):

```bash
node <plugin-root>/bin/dupe.js icon "C:\Program Files\App\App.exe" app-work.ico --color blue
node <plugin-root>/bin/dupe.js icon icon.png icon-green.png --color green
node <plugin-root>/bin/dupe.js icon icon.icns icon-work.icns --color "#1b91e3" --treatment ramp-dark
node <plugin-root>/bin/dupe.js colors
```

Inputs: `.png`, `.ico`, `.icns` (PNG-encoded sizes), or a Windows `.exe`/`.dll` (largest icon is read from its resources). Output format follows the extension. The browser version of the same pipeline is at https://hktitan.github.io/dupe/ and works on phones.

## Process

1. Find the real icon. On Windows the app's `.exe` is the best source (Store apps ship only tiny PNGs in `assets/`); on macOS `Contents/Resources/*.icns` named by `CFBundleIconFile`; on Linux the largest PNG under `/usr/share/icons/hicolor/*/apps/`.
2. Default to `auto` treatment. Override only if the result is wrong: `hue` when the icon is colourful but was read as gray, `ramp-light` for a dark mark on a light field, `ramp-dark` for a light mark on a dark field.
3. Report the treatment used and the field lightness the tool prints, so the user can judge why it chose what it chose.
4. For a family of icons, use the same colour for the same meaning across apps ("blue means work"), and the palette names for consistency: blue, green, purple, amber, red, teal, pink, gray all share one OKLCH lightness and chroma.

## Gotchas

- Do not hand-write hue rotations in RGB or HSL; the tool works in OKLCH so lightness is preserved. RGB rotation darkens shadows and turns cream marks grey.
- `.icns` files with only JPEG2000 or RLE payloads have no PNG sizes; render the icon to PNG first (on macOS: `sips -s format png icon.icns --out icon.png`).
- Windows Explorer only reliably loads PNG-compressed `.ico` entries at 256 px; the writer already emits DIBs for every smaller size. Don't "optimise" that.
