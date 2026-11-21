# Pencil Layer

Handwrite, sketch, and highlight right on top of your Markdown notes with a stylus. The pen draws, your finger scrolls, and the keyboard keeps typing. There is no mode to switch.

Pencil Layer adds a transparent ink layer over the editor (Live Preview and Source mode). Ink is attached to the lines of your note, so it moves with the text when you type above it. It shows up in Reading view and in PDF exports, and it is saved in small JSON files next to your notes. Your Markdown is never modified by ink.


- [Features](#features)
- [Installation](#installation)
- [Getting started](#getting-started)
- [Guide](#guide)
  - [The toolbar](#the-toolbar)
  - [Pen](#pen)
  - [Highlighter](#highlighter)
  - [Eraser](#eraser)
  - [Lasso and its menu](#lasso-and-its-menu)
  - [Shapes (draw and hold)](#shapes-draw-and-hold)
  - [Scribble to erase and double-tap](#scribble-to-erase-and-double-tap)
  - [Drawing spaces](#drawing-spaces)
  - [Ink and text together](#ink-and-text-together)
  - [Screenshots](#screenshots)
  - [Reading view and PDF export](#reading-view-and-pdf-export)
  - [Dark mode](#dark-mode)
  - [Desktop: mouse, Select tool and keyboard shortcuts](#desktop-mouse-select-tool-and-keyboard-shortcuts)
  - [Commands](#commands)
- [Settings reference](#settings-reference)
- [Where your ink is stored and how sync works](#where-your-ink-is-stored-and-how-sync-works)
- [Platform support](#platform-support)
- [Known limitations](#known-limitations)
- [FAQ and troubleshooting](#faq-and-troubleshooting)
- [For plugin developers](#for-plugin-developers)
- [Development](#development)
- [License](#license)

## Features

- **The pen always draws, the finger always scrolls.** An Apple Pencil, Surface Pen or other active stylus draws. Touch scrolls and taps as usual. The keyboard keeps typing at the cursor, and drawing never moves the cursor or takes focus.
- **Ink follows your text.** Strokes are anchored to the line they were drawn on, and ink drawn over words stays on those words when the paragraph re-wraps.
- **Floating toolbar.** It has undo and redo, pen, eraser, highlighter and lasso, pen presets and colors, and a ⋯ menu. You can drag it to any edge, collapse it, or snap it to a preset position.
- **Pen.** Thin, dashed and thick presets, seven colors, a constant-width ballpoint or pressure-sensitive feel, and adjustable smoothing.
- **Highlighter.** Four neon colors in two widths. It snaps to typed text, so a sweep over a sentence becomes a clean highlight that reflows with the text. It also has an optional straight-line mode.
- **Eraser.** Erases whole strokes, or only the part you touch (precise mode, three sizes). It can be limited to the highlighter. A pen's eraser end (Surface Pen, many Wacom pens) erases while you hold it.
- **Lasso.** Select ink, then move, resize, copy, cut, paste, duplicate, delete, recolor or screenshot it, or turn it into a drawing space.
- **Shapes.** Draw and hold to snap a stroke to a line, arrow, rectangle, triangle, polygon, ellipse or circle, right angle, polyline, arc, parabola or smooth curve. Keep the pen down to adjust it.
- **Scribble to erase** and **double-tap to toggle the eraser** (both optional).
- **Drawing spaces.** Protected blank areas between paragraphs for diagrams. They grow as you draw near the bottom, can be resized, and move with their paragraph. Drawing below the end of a note creates one automatically.
- **Reading view and PDF export.** Ink renders in Reading view and in Obsidian's "Export to PDF". You can export with or without ink, and tall drawings are split cleanly across pages on white paper.
- **Document-style PDFs.** One tap exports a note that looks like a plain word-processor document (Times New Roman or Calibri at 12 pt, black headings, simple tables), whatever your theme. Handy for handing in homework.
- **Dark-mode-aware ink.** Black ink turns light in dark themes, and white ink turns dark in light themes. PDFs always print dark ink on white paper.
- **Screenshots** of a selection, with or without the text underneath. You can share them, copy them, save them to the vault or insert them into the note.
- **Desktop Select tool.** Rearrange ink with the mouse, with keyboard shortcuts.
- **Sync-friendly storage.** One JSON sidecar per note in a folder you choose (default `Attachments/Ink`). Ink drawn on another device appears live while a note is open.

## Installation

Pencil Layer is installed like any other community plugin. The steps are the same on iPad, iPhone, Android, Mac, Windows and Linux. It needs Obsidian 1.8.7 or newer.

### Step 0: turn on community plugins (first time only)

1. Open **Settings** (the gear icon; on iPad/iPhone, open the left sidebar and tap the gear).
2. Go to **Community plugins**.
3. If you see **Restricted mode is on**, tap **Turn on community plugins**.

### Option A: from Community plugins (once Pencil Layer is listed)

1. **Settings → Community plugins → Browse**.
2. Search for **Pencil Layer** and tap it.
3. Tap **Install**, then **Enable**.

Updates appear under **Settings → Community plugins → Check for updates**.

### Option B: with BRAT (works right now, recommended until it's listed)

[BRAT](https://github.com/TfTHacker/obsidian42-brat) installs plugins straight from GitHub and keeps them updated.

1. **Settings → Community plugins → Browse**, search for **BRAT**, then **Install** and **Enable**.
2. Go to **Settings → BRAT** (under "Community plugins" in the settings sidebar) and tap **Add beta plugin**.
3. Paste `standw7/pencil-layer` as the repository, keep "latest version", and tap **Add plugin**.
4. Go back to **Settings → Community plugins** and make sure **Pencil Layer** is switched on.

BRAT checks for new versions when Obsidian starts, so you get updates automatically.

### Option C: manual install (desktop)

1. Download `main.js`, `manifest.json` and `styles.css` from the latest [release](https://github.com/standw7/pencil-layer/releases/latest).
2. In your vault folder, open the hidden `.obsidian/plugins/` folder and create a folder named `pencil-layer` inside it (on macOS press Cmd+Shift+. in Finder to show hidden folders; on Windows enable "Hidden items" in File Explorer's View menu).
3. Put the three files in `<your vault>/.obsidian/plugins/pencil-layer/`.
4. Restart Obsidian, then enable **Pencil Layer** under **Settings → Community plugins**.

Manual installs don't update themselves; repeat these steps for each new release. On iPad/iPhone, use Option A or B instead, since the hidden plugin folder is hard to reach in the Files app.

### Using it on several devices

Install the plugin on each device (or let Obsidian Sync sync your plugins: **Settings → Sync → Installed community plugins**). Keep every device on the same version, since an older version can drop newer data when it saves.

## Getting started

1. Open a note in the editor (Live Preview or Source mode). The floating toolbar appears at the bottom of the note.
2. **Write with your pen** anywhere on the note. Scroll with your finger. Type with the keyboard as usual, because the cursor stays where it was.
3. Pick a tool on the toolbar. **Tap the active tool again** to open its options.
4. Use **Undo / Redo** on the toolbar for ink. Editor undo (Ctrl/Cmd+Z) undoes text.

On a computer without a pen, open the toolbar's **⋯ → Mouse draws** to draw with the mouse. Otherwise the mouse reads and selects ink (see [Desktop](#desktop-mouse-select-tool-and-keyboard-shortcuts)).

## Guide

### The toolbar

```
( grip | undo  redo | pen  eraser  highlighter  lasso | presets & colors | ⋯ )
```

- **Move it** by dragging the grip (the dotted handle). Near the left or right edge it turns vertical, and near the top or bottom it turns horizontal.
- **Tap the grip** to collapse the bar to undo/redo and tools, and tap again to expand it. When it is collapsed, tapping the active pen or highlighter opens a popover with its presets and colors.
- **Hold the grip** (pen or finger, half a second) or **right-click it** to snap the bar to Top center, Bottom center, Left middle, Right middle, or a corner.
- **Tool popovers.** The first tap selects a tool. A tap on the already-active tool opens its options.
- **⋯ menu:**
  - Add drawing space
  - Hide ink / Show ink
  - Include ink in PDF export (toggle)
  - Export PDF with ink / Export PDF without ink
  - Export PDF (document style), or Export PDF (themed style) when your default export style is Document
  - Mouse draws (desktop only)
  - Move toolbar to bottom center (when it has been moved)
- The toolbar's position, edge and collapsed state are saved per device. The toolbar is hidden in Reading view. To hide it entirely, use the ribbon icon (pencil), the **Toggle ink toolbar** command, or the settings.

### Pen

- **Presets:** Thin (about 0.3 mm), Dashed, and Thick (about 0.5 mm). You can change the widths in the settings.
- **Colors:** Black, Red, Blue, Orange, Purple, Green and Coral. "Black" is the theme's text color: black in light themes and light in dark themes.
- **Pen popover:**
  - **Feel:** *Ballpoint* (constant width) or *Fountain pen* (pressure and speed vary the width, with soft tapered ends). Dashed is always ballpoint.
  - **Smoothing:** Off, Light, Medium (default) or Strong. It filters jitter while you write. Lines are always drawn as smooth curves.
  - **Snap to shape (draw and hold)** on or off, and **Hold for** 0.3, 0.5, 0.8 or 1.2 s.

### Highlighter

- **Colors:** neon green, yellow, purple and blue. **Width:** Normal (about half a text line) or Wide (about a full line).
- **Snap to text** (on by default) makes a highlight over typed text snap to the words. A sweep over one line, or a top-to-bottom sweep over several lines, becomes a clean highlight of that text. It reflows when the text wraps and stays with the words when you type before or inside it. Strokes over blank space, drawings or the ends of lines stay freehand.
- **Straight line** draws a straight highlight from where you start, snapped to horizontal within a few degrees.
- Highlights are drawn under pen ink.

### Eraser

- **Whole stroke** (default) deletes any stroke the eraser touches.
- **Precise** erases only the part you touch, with sizes Small, Medium or Large. A stroke cut in the middle becomes two strokes.
- **Erase highlighter only** leaves pen ink alone.
- **Eraser end of the pen** (Surface Pen, many Wacom/Windows Ink pens) erases while held, whatever tool is selected.
- One eraser drag is one undo step.
- The eraser popover also has the two quick-switch options: **Double-tap with the Pencil tip** and **Scribbling over ink** (see below).

### Lasso and its menu

Pick the lasso and draw a loop around ink. Every stroke the loop touches is selected, including a long line whose end you circled. The lasso popover can limit selection to **Both**, **Pen** or **Highlighter**.

With a selection:
- **Drag inside it** (pen, finger or mouse) to move it. **Drag the handle** at the bottom right to resize it, including stroke widths.
- **Tap it** to show or hide the menu. Tap outside, or switch tools, to deselect.
- **Menu:**
  - **Copy** and **Cut** put the ink on Pencil Layer's clipboard. A PNG also goes to the system clipboard when possible.
  - **Duplicate** and **Delete**
  - **Color ▸** recolors the selection.
  - **Screenshot** opens the [screenshot](#screenshots) dialog.
  - **Make drawing space** turns line-anchored ink into a [drawing space](#drawing-spaces) exactly where it is. It is shown when the selection has ink outside a space.
- **Paste:** with the lasso tool and copied ink, tap on empty space, or hold the pen still for half a second, then choose **Paste**. The ink is pasted centered on that spot and selected.

The ink clipboard lasts for the session and works across notes.

### Shapes (draw and hold)

Draw a shape and **keep the pen still** at the end (0.5 s by default). The stroke snaps to a clean shape:

- line (snapped to horizontal or vertical within 5°), arrow, polyline, right angle (for example, graph axes drawn in one stroke)
- rectangle, triangle, polygon (up to 8 sides), ellipse or circle
- smooth arc, parabola or curve (for graphs; large strokes only, so handwriting stays as written)

**While the pen stays down** you can adjust the shape. A line or arrow end follows the pen, and closed shapes scale from the opposite corner. Lift to keep it. Handwriting, check marks and "V"s are not turned into shapes. Snapping applies to the pen only and can be turned off in the pen popover or in the settings.

### Scribble to erase and double-tap

- **Scribble to erase** (off by default): scribble quickly back and forth over strokes to erase them. It is conservative. A stroke is erased only when about half of it is scribbled over, and outlines around shading or axes running through it are kept. While you scribble, the strokes about to be erased fade. If nothing qualifies, the scribble stays as ink. One scribble is one undo step.
- **Double-tap toggles eraser** (off by default): two very quick taps with the pen tip at the same spot switch between the current tool and the eraser, and the taps leave no dots. Taps next to ink you wrote in the last 1.5 s never count, so dotting an *i* doesn't switch tools. The **Toggle eraser** command does the same; you can assign it a hotkey.

### Drawing spaces

A drawing space is a protected blank area after a paragraph, made for diagrams. Text never flows under it, its drawing is one rigid piece that never gets squished, and it moves with its paragraph.

- **Add one:** use **⋯ → Add drawing space**, or the command **Add drawing space below cursor line**. The space goes after the paragraph (or list item, table, code block…) that has the cursor. No text is inserted.
- **Draw below the end of the note:** a stroke that starts below the last line automatically creates a space there, or grows the last one.
- **Grow:** draw near the bottom of a space (within about 40 px) and it grows while you draw, pushing the text below down. The stroke and the growth are one undo step.
- **Resize:** drag the grip centered on the space's bottom edge (pen, finger or mouse). It can't shrink smaller than its drawing.
- **The ⋯ button** at a space's top right has:
  - **Copy** / **Cut** the space with its drawing. Paste it with Ctrl/Cmd+V (or Paste on iPad) in the editor, or with the command **Paste drawing below cursor line**.
  - **Clear ink**
  - **Delete space** (asks first if it has ink; undo brings it back)
- **Make drawing space** (lasso menu) converts an existing loose drawing into a space without moving it.
- Blank lines directly below a space belong to it: drawing there grows the space.
- **Typing below a drawing at the end of the note:** tap or click below it, or press ↓ on the last line, and a new line opens under the drawing.
- **Moving drawings with text:** select text that includes a drawing space and cut and paste it. The drawing moves with the text, like an inline image, and editor undo undoes both together.

### Ink and text together

- Ink anchored to a line moves with that line when you type or delete above it. If the line itself is edited or moved, the ink finds it again by its content.
- Ink drawn over words (an arrow pointing at a word, a circle around a term) stays on those words when the paragraph re-wraps at another window width.
- Keep **Readable line length** on (Obsidian's Editor settings) so drawings line up the same way on every device.

### Screenshots

Choose **Screenshot** in the lasso menu to open a dialog with a crop frame around the selection:
- **Include text** (on by default) renders the typed text under the ink. If the text can't be rendered on a device, the screenshot falls back to ink only and says so.
- **Share** (where supported), **Copy image**, **Save to vault**, **Insert into note**, or **Discard**.
- Saved images go to the **Screenshot folder** setting (default `Attachments/Screenshots`), named `<note name> <date time>.png`. **Insert into note** embeds the image on its own line at the cursor.

### Reading view and PDF export

- Ink shows in **Reading view**, placed next to the same blocks as in the editor. Drawings below a paragraph get room so they don't cover the next block.
- **Export to PDF:** Obsidian's own **Export to PDF** includes ink when **Include ink in PDF export** is on (the default, per device). For a single export, use **⋯ → Export PDF with ink / without ink** or the commands of the same name. They don't change the toggle.
- **Document style:** **⋯ → Export PDF (document style)** (or the command **Export to PDF (document style)**) exports this one note like a plain Word document: white page, black text in a classic font at 12 pt with 1.15 line spacing, plain black headings, black underlined links, thin black table borders, code in a monospace font on light grey, callouts and quotes as simple boxes without colors or icons, tags as plain text, thin grey horizontal rules, `==highlights==` in light yellow, and math in black at the text size. It ignores your theme and CSS snippets for that export only; your notes and Obsidian look unchanged. Ink follows the **Include ink in PDF export** toggle and is placed against the document-style text, so marks over words stay on their words. Pick the font (Serif = Times New Roman, Sans = Calibri) under **Document style font**. If you want every export to look like this, set **Default export style** to **Document**: Obsidian's own Export to PDF and the with/without-ink entries then use it, and the menu offers **Export PDF (themed style)** instead.
- PDFs are always **white paper with dark ink**, whatever your theme. Drawing spaces taller than a page are split between rows of writing, never through them, and a space that doesn't fit at the bottom of a page moves to the next page.

### Dark mode

Stored colors never change; what is painted follows the theme. "Black" ink (and other near-black colors) is drawn in the theme's text color in dark themes, and near-white ink turns dark in light themes. Colored ink and highlighters keep their color. Switching themes recolors ink instantly. PDFs and screenshots use the right colors for their background.

### Desktop: mouse, Select tool and keyboard shortcuts

On a computer the mouse reads by default, and the toolbar is the **slim** bar: Undo, Redo, **Select**, Show/Hide ink, ⋯.

- **Pens always draw.** The first time a pen (Surface Pen, Wacom…) touches a note, that device switches to the full drawing toolbar. The setting **Pen on this device** controls this.
- **Mouse draws** (⋯ menu, settings, or the **Toggle mouse draws** command) makes the left mouse button draw and shows the full toolbar.
- **Select tool** (slim bar, or the **Toggle select tool** command) lets the mouse rearrange ink:
  - **Click a stroke** to select it (and drag to move it). **Drag on empty space** to select with a rectangle, or with a freeform loop (choose in the Select popover).
  - Drag the selection to move it, or drag its handle to resize it. The same menu as the lasso appears.
  - **Right-click** on empty space to paste copied ink.
  - **Click empty space** (without dragging) to leave Select and put the text cursor there.
  - In the Select popover: Rectangle / Freeform, Selects Both / Pen / Highlighter, and **Done — back to the text cursor**.
- **Keyboard shortcuts** (desktop, when ink is selected and the note's editor has focus; Mod = Cmd on macOS, Ctrl elsewhere):

  | Key | Action |
  | --- | --- |
  | Esc | Deselect (press again to leave Select) |
  | Delete / Backspace | Delete the selected ink |
  | Mod+C / Mod+X | Copy / cut the selected ink |
  | Mod+D | Duplicate the selected ink |
  | Mod+V | Paste ink (while Select is active and ink was copied) |

  Without an ink selection, every key does what Obsidian normally does.

### Commands

All commands are in the command palette, and none has a default hotkey. You can assign hotkeys under **Settings → Hotkeys**.

| Command | What it does |
| --- | --- |
| Toggle ink toolbar | Show or hide the toolbar on this device |
| Show/hide ink | Hide ink without deleting it |
| Undo ink / Redo ink | Ink history of the current note |
| Add drawing space below cursor line | New drawing space after the cursor's block |
| Paste drawing below cursor line | Paste a copied/cut drawing space |
| Select pen / highlighter / eraser / lasso | Switch tools |
| Toggle eraser | Current tool ↔ eraser |
| Export to PDF with ink / without ink | One-off PDF export |
| Export to PDF (document style) / (themed style) | One-off PDF export in that style (ink per the toggle) |
| Toggle select tool (mouse selects ink) | Desktop, slim toolbar |
| Toggle mouse draws | Desktop |

## Settings reference

"Synced" settings are stored in the plugin's `data.json` and follow your vault to other devices. "This device" settings are kept per device.

| Setting | Default | Scope | Description |
| --- | --- | --- | --- |
| Show ink toolbar on this device | On | This device | The floating toolbar. |
| Show ink | On | Synced | Hide ink without deleting it. |
| Include ink in PDF export | On | This device | Whether Obsidian's own "Export to PDF" draws ink. |
| Default export style | Themed | Synced | Themed (looks like Obsidian) or Document (plain word-processor look) for Obsidian's own export and "Export PDF with / without ink". |
| Document style font | Serif | Synced | Serif (Times New Roman, Times, Georgia) or Sans (Calibri, Aptos, Carlito, Arial) for document-style PDFs. |
| Mouse draws | Off | This device, desktop | Draw with the left mouse button. |
| Pen on this device | Off (turns on when a pen is used) | This device, desktop | Full drawing toolbar for a pen even when the mouse doesn't draw. |
| Pen feel | Ballpoint | Synced | Ballpoint or Fountain pen (pressure-sensitive). |
| Smoothing | Medium | Synced | Off, Light, Medium, Strong. |
| Thin / Dashed / Thick width (px) | 1.6 / 1.6 / 2.7 | Synced | Widths of the pen presets, used for new strokes. |
| Snap to shape | On | Synced | Draw and hold to snap to a shape. |
| Hold delay (ms) | 500 | Synced | How long to hold still before snapping (200–1500). |
| Double-tap toggles eraser | Off | Synced | Two quick pen-tip taps switch to or from the eraser. |
| Scribble to erase | Off | Synced | Scribble over strokes to erase them. |
| Eraser | Whole stroke | This device | Whole stroke or Precise. |
| Precise eraser size | Medium | This device | Small, Medium or Large. |
| Erase highlighter only | Off | This device | The eraser skips pen ink. |
| Straight-line highlighter | Off | This device | The highlighter draws straight lines. |
| Snap to text (highlighter popover) | On | This device | Highlights over typed text snap to the words. |
| Select tool (mouse) | Rectangle | This device, desktop | Rectangle or freeform selection. |
| Lasso selects | Pen and highlighter | This device | Which ink the lasso and Select tool pick up. |
| Ink folder | `Attachments/Ink` | Synced | Where ink files are stored (see below). |
| Screenshot folder | `Attachments/Screenshots` | Synced | Where saved screenshots go. |

The current tool, pen preset, colors and highlighter width are remembered too (synced).

## Where your ink is stored and how sync works

- Each note with ink has one **sidecar file**: `<ink folder>/<path of the note>.json`. For example, `Courses/Physics/Week 3.md` → `Attachments/Ink/Courses/Physics/Week 3.md.json`. Your Markdown files are never changed by ink. The one exception is that **Make drawing space** may remove blank lines it replaces, as one editor undo step.
- Renaming or moving a note moves its ink file. Deleting a note deletes its ink file, and deleting a folder moves its ink folder to the trash.
- **Changing the ink folder:** enter a new folder under **Settings → Pencil Layer → Files → Ink folder** and press **Change**. You can **move the existing ink files** there (recommended), or switch without moving, in which case old ink stays in the old folder and isn't shown. Pick a visible folder (not starting with `.`), because hidden folders are not indexed or synced.
- **Sync:** ink files are ordinary vault files, so any sync (Obsidian Sync, iCloud, Dropbox, Syncthing, git…) carries them. With **Obsidian Sync**, enable **Sync → "All other file types"** so the `.json` files are included. When another device's ink arrives while a note is open, it is merged in live. Strokes are merged one by one, so drawing on two devices at once doesn't lose either side's ink.
- The ink folder setting is synced. If you change it, let sync finish on every device before drawing there.
- Undo history is per note and per session (not saved).
- A damaged ink file is never overwritten silently: its original is backed up next to it as `.json.bak` before the next save.

## Platform support

| Platform | Status |
| --- | --- |
| iPad with Apple Pencil | Primary platform, tested |
| iPhone | Tested (finger scrolls; Apple Pencil where supported) |
| macOS | Tested (mouse, trackpad, Select tool) |
| Windows with a pen (Surface Pen, Wacom…) | Should work, less tested. Pen tip draws, eraser end erases, touch scrolls. |
| Android tablets with a stylus | Should work, less tested |
| Linux | Should work with mouse or tablet, less tested |

**Windows tips:**
- If holding the pen still to snap a shape shows the right-click ring, you can turn off **Press and hold to right-click** under Windows Settings → Bluetooth & devices → Pen & Windows Ink. The plugin already ignores that right-click during strokes.
- The barrel button has no special function; the pen keeps drawing with the current tool.

## Known limitations

- Ink is placed by line in the editor. **Reading view and PDF** place it by block, so inside complex blocks (callouts, tables, embeds, images inside paragraphs) ink can sit a few pixels differently. Drawing spaces are always exact.
- A drawing space can't go inside a paragraph, table, code block or callout. It follows the block.
- Loose (line-anchored) ink that crosses a page break in a PDF breaks wherever the browser breaks the block. Use a drawing space for diagrams you want to print.
- Width matters: keep **Readable line length** on so ink lines up across devices and window sizes. With it off, ink stays at its pixel position while the text re-wraps.
- PDF export on iPad/iPhone has been tested less than on desktop.
- In a document-style PDF the text is usually smaller and more tightly spaced than in the editor, but ink keeps the size you drew it at. Marks follow their words and lines, yet a big circle around a phrase can overlap the line above or below it. The Sans font is closer in width to Obsidian's default font.
- Undo history is not kept after closing a note or Obsidian.
- Older versions of the plugin on another device may show drawing-space ink in the wrong place, so update every device.
- Ink is not searchable text (no handwriting recognition).

## FAQ and troubleshooting

**My finger draws / my pen scrolls.**
Only pens draw (and the mouse when *Mouse draws* is on). If a finger draws, your device may report it as a pen. On Windows, if the pen scrolls the page instead of drawing, make sure the pen hovers over the note briefly before touching, and report it as an issue.

**The toolbar disappeared.**
Use the ribbon pencil icon or the **Toggle ink toolbar** command. If it's off-screen, hold or right-click the grip and choose a position, or use **⋯ → Move toolbar to bottom center**. The toolbar never shows in Reading view.

**I see the slim toolbar on my computer but want to draw.**
Use a pen (it switches automatically), turn on **Pen on this device**, or turn on **Mouse draws**.

**My ink isn't on my other device.**
Check that your sync includes the ink folder (for Obsidian Sync: "All other file types") and that both devices use the same **Ink folder** setting. Also update the plugin on both devices.

**The ink is in the wrong place after I edited the note on another app.**
Ink finds its line again by the line's content. If a line was rewritten completely, its ink stays near the old position. Select the ink with the lasso and move it.

**The PDF has no ink.**
Check **Include ink in PDF export** (per device), or use **⋯ → Export PDF with ink**.

**I erased by accident.**
Use **Undo** on the toolbar (ink undo is separate from text undo).

**Can I move my ink to another folder?**
Yes. Use **Settings → Pencil Layer → Files → Ink folder → Change → Move ink and switch**.

**Does it work with Canvas or PDFs?**
No. It works on Markdown notes in the editor, with read-only display in Reading view and PDF export.

## For plugin developers

Pencil Layer exposes a small API at `app.plugins.plugins["pencil-layer"].api` (type `PencilLayerApi`, see `src/api.ts`). It can list the lines of a note that carry ink, copy ink to a reorganized copy of a note, and render a note's drawings to PNG images.

## Development

```sh
npm install
npm run dev      # watch build (main.js)
npm test         # unit tests (vitest)
npm run lint     # eslint-plugin-obsidianmd
npm run build    # type-check + production build
```

Design notes are in [`docs/DESIGN.md`](docs/DESIGN.md). To release, run `npm version <x.y.z>` (this updates `manifest.json` and `versions.json`), then push the commit and the tag `x.y.z` without a `v` prefix. The release workflow builds the plugin and attaches `main.js`, `manifest.json` and `styles.css` to a GitHub release.

## License

[MIT](LICENSE) © 2026 standw7
