# Ink Pages — design (Milestone 1, updated for M2 Stages A, B, B2, A3 toolbar, C, D, E, F, G, H1, I fix, K, L and M)

Obsidian community plugin (id `ink-pages`, name "Ink Pages"). Adds a GoodNotes-style ink
layer directly over notes in the Markdown editor (Live Preview and Source mode — both CodeMirror 6).

**Core interaction model (non-negotiable):**
- Apple Pencil (`pointerType === "pen"` / `Touch.touchType === "stylus"`) ALWAYS draws. No mode switch.
- Finger scrolls normally. Keyboard types normally. Editor focus/cursor must NOT change when the pen draws.
- Works on iPad (Obsidian mobile, WKWebView). `isDesktopOnly: false`. No Node/Electron APIs.
- Desktop: setting + toolbar toggle "Mouse draws" so it can be tested/used with a mouse/tablet.

## Data model

Sidecar file per note, stored in the vault at `<ink folder>/<note path>.json` (synced setting "Ink folder", default
`Attachments/Ink`; changing it offers to move the existing sidecars through the Vault API — `changeInkFolder` in main.ts;
lasso screenshots go to the "Screenshot folder" setting, default `Attachments/Screenshots`), i.e. by default `Attachments/Ink/<note path>.json` (e.g. note
`School/Physics/Lec 3.md` → `Attachments/Ink/School/Physics/Lec 3.md.json`; a visible folder because Obsidian Sync skips hidden folders — enable Sync "All other file types"). Read/written via
`app.vault.adapter`.

In memory (`model.ts`, unchanged by Stage G — every point is `[x, y, pressure]`):
```ts
interface InkFile { version: 1 | 2; contentWidth: number; strokes: Stroke[] }
interface Stroke {
  id: string;
  tool: "pen" | "highlighter";
  color: string;          // "ink" = theme text color (var(--text-normal)), else CSS color (Stage L: rendered theme-adaptively)
  size: number;           // width in px
  style?: "ball" | "dashed" | "dotted" | "notes"; // pens only (M2). Missing on a pen ⇒ "ball" (M1 files).
                          // "dotted" = Stage A legacy alias, renders as "dashed".
                          // Written for every pen stroke; never written for highlighters.
  anchor: { line: number; hash: string }; // 0-based line index + hash of that line's text at save time
  points: [number, number, number][]; // [x, y, pressure]; x rel. to content left, y rel. to anchor line top
  shape?: "line" | "arrow" | "rectangle" | "triangle" | "polygon" | "ellipse" | "circle" | "polyline"
        | "arc" | "parabola" | "curve";
                          // Stage B: set on strokes snapped by draw-and-hold. Shapes are ordinary
                          // strokes (densified clean outline, ~3 px spacing, constant pressure 0.5);
                          // `shape` is metadata only (rendering/erasing/lasso treat them like ink).
                          // Absent for freehand strokes; unknown values are dropped on load (so an
                          // older plugin loads "arc"/"parabola"/"curve" strokes as plain ink — same
                          // points, rendered with freehand smoothing instead of straight segments,
                          // indistinguishable at ~3 px spacing).
  text?: { ch: number; endLine: number; endCh: number };
                          // Stage C text highlight (highlighters only, see below). Persisted.
  textRange?: { from: number; to: number }; // Stage C, TRANSIENT (like `pos`): live doc range
  char?: { line: number; ch: number; dx: number; dy: number };
                          // Stage H: ink over typed text follows this character (never on text
                          // highlights). Persisted. See "Stage H — ink stays on its text" below.
  charPos?: number;       // Stage H, TRANSIENT (like `pos`): live position of that character
  space?: string;         // Stage K: drawn in this drawing space (points relative to the space's top)
}
// Stage K (optional; older files load with an empty list; Stage J `pages` convert to spaces):
interface InkFile { …; spaces?: InkSpace[] }
interface InkSpace { id: string; after: { line: number; hash: string } | "end"; height: number; pos?: number /* transient */ }
```

### On disk: version 2 (Stage G, compact)
Files are always **written** as `version: 2`. Each stroke has the same fields as above except
`points`, which is replaced by integer, delta-encoded channels:
```ts
interface DiskStroke {
  id, tool, color, size, style?, anchor,   // as in memory, same key order
  xy: number[];  // flat integers in TENTHS of a px: [x0, y0, dx1, dy1, dx2, dy2, ...]
                 // first point absolute, then the difference of consecutive QUANTIZED values
                 // (so error never accumulates: every point is within 0.05 px of the original)
  p?: number[];  // pressure in HUNDREDTHS, first absolute then deltas — only on notes-style
                 // freehand pens whose pressure isn't uniformly 0.5 (ballpoint, dashed, highlighters
                 // and shapes don't render pressure, so it's omitted; loads as 0.5)
  shape?: ShapeKind;
  text?: { ch, endLine, endCh };  // Stage C text highlights only
  char?: { line, ch, dx, dy };     // Stage H character anchor (last key; dx/dy rounded to 0.1 px)
}
```
Example — a ballpoint stroke through (1, 2), (3.14, 4.99), (2.96, 5.04):
`{"id":"…","tool":"pen","color":"ink","size":1.6,"style":"ball","anchor":{"line":2,"hash":"abc"},"xy":[10,20,21,30,-1,0]}`.
A notes stroke with pressures 0.12, 0.9, 0.41 adds `"p":[12,78,-49]`.
A text highlight (Stage C) adds e.g. `"text":{"ch":12,"endLine":5,"endCh":27}` after `xy`.
Ink over typed text (Stage H) ends with e.g. `"char":{"line":4,"ch":64,"dx":-458.9,"dy":-27}`
(follows character 64 of line 4; its points' origin is 458.9 px left of and 27 px above that
character's rect top-left). Older plugin versions ignore `char` (and drop it on their next save);
the line anchor and points stay valid, so the stroke just reverts to line anchoring there.

Size: a realistic page (34 strokes, ~2.5k points) is ~22 B/point in v1 and ~7 B/point in v2 (≈3.1×
smaller; `tests/model.test.ts` asserts ≥ 2.5×).

Compatibility: the loader detects the encoding **per stroke** (`xy` → v2, else v1 `points`
`[x,y,p][]` with p defaulting to 0.5), so v1 files load unchanged. Loading never writes: a v1
file is rewritten as v2 only on the next real save (no bulk migration). Serialization is a fixed
point after one save (`serialize(parse(serialize(x))) === serialize(x)`), so echo suppression
(byte comparison with the last written text) and the live-sync merge are unaffected; merge
compares strokes in their quantized disk encoding, so a full-precision in-memory stroke equals its
own reloaded copy. Repairs on load: `xy` decoding stops at the first non-numeric value; an odd
trailing value is ignored; from the first invalid/missing `p` entry on, pressure is 0.5; pressure is
clamped to [0, 1]. **Plugin versions before Stage G can't read v2 strokes** (they'd drop them as
invalid, back the file up and overwrite) — update every device together.
Lasso move/scale/recolor/duplicate never edits a stroke in place: the result is new strokes with
**new ids** (re-anchored to the line under their new top) replacing the old ones, so live-sync
merging by id treats an edit as "old id deleted + new id added" and survives concurrent remote edits.

### Anchoring (ink follows text)
- When a stroke finishes, anchor it to the document line under the stroke's topmost point
  (`view.lineBlockAtHeight`). If the stroke is below the end of the document, anchor to the last line.
  Point y-values are stored relative to that line block's `top`.
- During a session the anchor is held as a document **position** (line start) and mapped through every
  transaction's `changes.mapPos(pos, -1)`, so typing above a drawing moves the drawing down with its line.
- On save convert to `{line, hash}` (hash = short stable string hash of the line text).
- On load resolve: if line `line` exists and its hash matches → use it; else search outward up to ±200
  lines for the nearest line with matching hash (ignore hash matches for empty/whitespace-only lines);
  else clamp `line` to the document. Pure function, unit-tested.
- x is stored in px relative to the left edge of `.cm-content` text area. `contentWidth` recorded for
  later scaling (not used in M1). Users should keep "Readable line length" on so width matches across devices.

### Stage C — text highlights (highlighter snaps to typed text)
Pure logic in `textHighlight.ts` (tested), CM/DOM side in `textHighlightView.ts` (one
`TextHighlights` per ink view); inkView.ts only calls it from hook points marked `[Stage C]`.
- **Decision rule** (`classifyHighlight`, on lift and live while drawing; only with the setting
  `highlighterSnapText`, default on). `lh` = height of the visual line under the stroke's middle
  (max of `defaultLineHeight` and `coordsAtPos` there).
  - *one line*: start and end < 0.75 lh apart vertically, vertical extent ≤ 1.5 lh, at least as wide
    as tall, ≥ 8 px wide (scrubbing back and forth counts). Range = `posAtCoords` at (minX, median y)
    → (maxX, median y).
  - *several lines*: a top-to-bottom sweep — starts within 0.75 lh of its top, ends within 0.75 lh of
    its bottom (and ≥ 0.75 lh below its start), never retreats upward by > 0.5 lh from its lowest
    point so far, horizontal travel ≥ vertical extent (vertical margin lines, circles, zigzags stay
    freehand). Range = `posAtCoords` at the first point → the last point.
  - Then `snapRange`: an end inside a word goes to the nearer edge of that word (ties include the
    word — a stroke ending ⅓ into a word stops before it, ⅔ in includes it); whitespace and Markdown
    markup (`#*_~=>\`|+-`) are trimmed off both ends; a short stroke within one word selects it; no
    word → freehand.
  - Then the range is measured (below); it must give ≥ 1 row, and: one line → exactly one row, the
    stroke's median y within ½ lh of it, and ≥ 50% of the stroke's width over the row's text
    (strokes over blank lines, past the end of a short line or over drawings stay freehand); several
    lines → first/last point within ½ lh of the first/last row.
- **Stored** as a normal highlighter stroke plus `text: {ch, endLine, endCh}`: `anchor` is the line of
  the range start, `ch` the offset in it, `endLine`/`endCh` the end (resolved RELATIVE to where the
  anchor line resolves: end line = resolved line + `endLine − anchor.line`; offsets clamped into
  their lines). `points` keep the drawn freehand path (relative to the anchor line top) — only a
  fallback (other code paths, older plugin versions draw it as a freehand highlighter). Loading
  validates `text` (non-negative integers, end not before start; an empty range is valid); an
  invalid `text` is dropped, so the stroke loads as a freehand highlighter.
- **In session** the live range is `textRange` (transient, like `pos`), resolved together with `pos`
  (`TextHighlights.resolve`) and mapped through every transaction by `store.mapPositions` with
  `assoc` +1 for `from` and −1 for `to` (text typed at either edge stays outside; typed inside grows
  it; deleting the text collapses it to an empty range that renders nothing — it is kept so CM undo
  of the deletion at least doesn't turn it freehand). `clearPositions` clears it too. `beforeSave`
  first re-anchors text highlights from `textRange` (`anchor`, `text`, `pos` = start line), then the
  generic pos → anchor refresh runs.
- **Rendering**: in the render's measure READ phase every text highlight intersecting the viewport is
  measured: per document line of the (visible part of the) range, a DOM `Range` from
  `view.domAtPos(from, 1)` to `view.domAtPos(to, −1)` → `getClientRects()` → overlay space →
  `mergeRows` (fragments overlapping vertically by ≥ half merge into one row per visual line; rects
  taller than 2.5 default line heights — images, embeds — are ignored). The write phase draws one
  `<path>` of rounded rects (padding 1.5 × 1 px, radius 3) in the highlighter group (beneath pen
  ink, same color, `opacity .35`, multiply in light theme), relative to the anchor line top so the
  usual `translate(0 top)` and lasso drag transforms apply. Rows are re-measured on every render, so
  highlights reflow with the text (resize, wrapping, edits). Unmeasured (off-screen) ones aren't
  drawn. While drawing, the live highlighter path shows the snapped rects as soon as the stroke
  qualifies; on lift the live element gets the final rects, so there is no visual jump.
- **Eraser** (stroke mode): hit-tests the eraser segment against the padded rects (+ eraser radius).
- **Lasso**: selection uses proxies whose points sample each row's center line every ~4 px (same
  majority rule); the selection box uses the rects. **Recolor keeps a text highlight a text
  highlight** (new id). **Move / scale / duplicate / copy-paste detach it from the text**: it is
  converted to plain freehand highlighter strokes, one constant-width capsule per row (size = row
  height) at its current layout, then transformed like any stroke (one undo restores the text
  highlight). Screenshots/clipboard PNGs rasterize the same capsules.
- Scribble-to-erase uses the stored (drawn) points of a text highlight, not its rects.

### Stage H — ink drawn over text stays on that text (character anchor)
Reported: an arrow drawn over a sentence drifted in Reading view (and a long line that
re-wraps at another pane width leaves line-anchored ink behind). Pure rule + math in
`charAnchor.ts` (tested), CM side in `charAnchorView.ts` (`CharAnchors`, one per ink view; inkView.ts
calls it from hook points marked `[Stage H]`), Reading view / PDF in `readingView.ts`.
- **Model.** `char: {line, ch, dx, dy}`: the stroke follows character `ch` of line `line` (saved
  0-based, resolved RELATIVE to where the line anchor resolves, like Stage C's `endLine`; `ch`
  clamped onto the line's last character). Placement: the stroke's points' origin (local (0, 0))
  goes to the character's rect top-left + (dx, dy) — `view.coordsAtPos(charPos, 1)` in the editor,
  the character's DOM `Range` client rect in Reading view / PDF (both the font box of that glyph, so
  they agree). Points stay relative to (content left, anchor line top) exactly as before: without
  the field (older versions, or no measurement yet) the stroke is where it was drawn.
  **One character, not two:** editor, Reading view and PDF share the font, so text around the
  character keeps its spacing; what differs between layouts is where (row, x) the character lands.
  If two characters of one stroke end up on different rows, no rigid placement can follow both, and
  stretching ink between them on one row would only distort it.
- **Which strokes (decision rule, `CHAR_ANCHOR`, lh = `defaultLineHeight`):** a *unit* — a finished
  stroke, or a group committed together — qualifies when (1) its points' bbox is ≤ 2.5 lh tall
  (arrows, underlines, circles, short notes over one or two lines; diagrams, brackets spanning a
  paragraph and long connectors never qualify, so a big drawing doesn't jump around with a word);
  (2) a letter/digit (`pickChar`: nearest to the hit, ≤ 24 characters away; markup and whitespace
  are skipped) found by `posAtCoords` at the bbox center — probed as is and ½ lh above/below, since
  ink drawn just above a sentence has its center in the gap or blank line above it — lies within
  1 lh horizontally and 0.75 lh vertically of the center (closest qualifying probe wins), is plain
  text (a DOM text node, not inside a `contenteditable=false` widget: Live Preview tables, embeds)
  and its rect is ≤ 2 lh tall. Ink in the margins, past the end of a short line, in a drawing space
  (Stage K), and text highlights (they have their own `text` range) keep pure line anchoring.
  **Joining:** a small stroke whose bbox (padded ½ lh) touches the character-anchored stroke
  finished < 2.5 s before follows the SAME character (arrow head after its shaft, letters of a word
  written over text), so multi-stroke marks move rigidly.
- **In session** `charPos` (transient) is resolved with `pos` (`resolvePositionsIn`) and mapped
  through every transaction by `store.mapPositions` with assoc +1 (text typed right before the
  character pushes it, and the ink, along); `clearPositions` clears it; `beforeSave` refreshes
  `char.line/ch` from it after the line anchors (`CharAnchors.refreshAnchors`). Deleting the
  character leaves the position at the deletion point (the ink follows whatever text is there).
- **Editor rendering.** Every placement goes through `InkView.place(s)` = (0, line top) + the
  stroke's cached *shift*. In the render's measure READ phase `CharAnchors.measure` calls
  `coordsAtPos` for the character of each character-anchored stroke inside CM's viewport — but only
  if the layout may have changed since its last measurement (a generation counter bumped on doc,
  geometry, height or selection changes — Live Preview reveals markup on the cursor's line; a pure
  scroll measures only strokes not measured yet). The shift (relative to the line-anchored
  placement) is cached per stroke, so ink outside the viewport keeps its last placement and new
  strokes start at (0, 0). The SVG transform becomes `translate(x top)`; every consumer of the
  rendered offset honors x too (eraser hit tests and precise pieces, scribble candidates, lasso
  selection via `selectInLasso(…, leftOf)`, selection box, drag preview, `transformPoints(…,
  offsetX)`, copy/screenshot rasterization, desktop click hit-test).
- **Reading view / PDF.** A character-anchored stroke is drawn by the section owning its
  *character's* line. The character is located with the Stage C source→display matching applied
  to the word around it (`charNeedle`: the run of letters/digits containing it is the needle — it
  displays unchanged —, its k-th occurrence in the section's normalized rendered text, k counted in
  the stripped source before it, + the offset in the word); a one-character DOM `Range` gives its
  rect; the stroke is drawn at `translate(rect + (dx, dy))` relative to the section SVG. Not found
  (math, unusual markup) → the Stage D section mapping (`yOf(anchor line)`, x = 0). The section's
  rendered text is collected once per drawing and shared with Stage C highlights. The PDF export
  goes through the same `drawSection`, at the printed width, so ink follows the text there too.
- **Edits.** Lasso move/scale, duplicate and paste re-run the rule on the new strokes **as one unit**
  (`anchorGroup`: the group's bbox; qualifying → every stroke follows the group's one character,
  with its own offset; else none): moving an arrow onto another word re-anchors it there, moving it
  into the margin drops the character anchor, and a moved diagram never fragments. Precise-eraser
  pieces and recolored strokes **inherit** their stroke's character (`CharAnchors.inherit`: same
  `charPos`, offset recomputed from the stroke's current placement), so a cut arrow stays together.
  Live-sync merge: `char.line/ch` shift with edits like the anchor and don't count as content; its
  presence and offsets do (a device without Stage H that dropped it → the remote version wins).
- **Known limits.** Ink spanning a wrap point can't follow both halves (it moves with its one
  character and may overhang the content edge after re-wrapping). Several separate strokes drawn
  over text more than 2.5 s apart (e.g. a box drawn side by side over a paragraph whose flat edges
  are short enough) anchor independently. Live Preview widgets (tables, embeds) never anchor.

## Public API (for other plugins)
Other plugins (e.g. one that writes a reorganized copy of a note as a NEW
note) can carry the ink along without knowing the sidecar format:
`app.plugins.plugins["ink-pages"].api` (type `InkPagesApi` in `src/api.ts`; glue there, pure
remapping in `src/inkCopy.ts`, tests `tests/inkCopy.test.ts`).
```ts
interface InkPagesApi {
  version: 1;
  inkLines(file: TFile): Promise<number[]>;
  copyInk(src: TFile, dst: TFile, lineMap: ReadonlyMap<number, number>): Promise<{ strokes: number; spaces: number; unplaced: number }>;
  // Added later within version 1: callers must check `typeof api.inkDrawings === "function"`.
  inkDrawings(file: TFile): Promise<InkDrawing[]>;
}
interface InkDrawing {
  line: number;            // like inkLines: space display line / first anchor line of a margin cluster
  lines: number[];         // every line the drawing hangs off (all in inkLines)
  kind: "space" | "margin";
  png: string;             // base64 PNG, no data: prefix
  width: number; height: number; // PNG pixels
}
```
- **`inkLines`**: the 0-based lines of the note's current text (the open editor's text if it is
  open, else the file) that ink hangs off, sorted and unique: the resolved anchor line
  (`resolveAnchor`) of every line-anchored stroke (incl. a stroke whose space id is unknown) and
  the display line (`blockEnds`/`displayLine`) of every drawing space ("end" → the last line).
  Strokes in a known space don't count separately (they move with their space).
- **`copyInk`**: replaces dst's ink with a copy of src's. `lineMap` maps the lines `inkLines(src)`
  returned to dst lines. Every stroke/space gets a new id (strokes in a copied space point to the
  new space id); anchors are `{line, hash}` of the mapped dst line; points (x and y relative to the
  line / space top) and space heights are unchanged; dst gets src's `contentWidth`. A space maps
  via the line it is shown after and is anchored to the mapped line; an "end" space whose mapped
  line is in dst's last block stays "end". Stage H `char`: kept only if the anchored character's
  word (whole word, same occurrence index, else the nearest; non-letters: the character itself) is
  found on the mapped character line (the anchor's mapped line, or for a character on another line
  the mapping of that line, else the same distance); else dropped (plain line anchoring). Stage C
  `text`: the highlighted text must be found starting on the mapped line (multi-line: exactly across
  the following lines); else dropped (the drawn `points` show as a freehand highlighter). Ink whose
  line is not in `lineMap` or maps outside dst goes to the end (spaces → "end" spaces, strokes →
  dst's last line) and is counted in `unplaced` (a space and each stroke in it count separately).
- **`inkDrawings`** (pure layout `src/inkDrawings.ts`, canvas `src/drawingPng.ts`, tests
  `tests/inkDrawings.test.ts`): the note's ink as images, e.g. for a vision model to read
  handwritten equations. Highlighters are skipped. Each drawing space with pen ink is one drawing
  (points are space-relative). Line-anchored pen ink (incl. strokes whose space id is unknown) is
  clustered: every stroke's box (points + half its width) is placed at its resolved anchor line's
  top; boxes within one line height vertically and three line heights horizontally join
  (transitively); a cluster is keyed by its smallest anchor line. **Line tops:** if the note is open
  in an editor (and its doc has the same line count as the text used), the real CM layout —
  `lineBlockAt(line.from).top`, exactly what the overlay's `lineTop` uses (so spaces and wrapped
  lines between the lines count); otherwise `line × 24 px` (APPROX_LINE_HEIGHT: 16 px × 1.5), which
  ignores wrapped lines, headings and drawing spaces between the lines (a multi-line cluster's
  vertical spacing is then approximate; single-line clusters and spaces are exact). Stage H
  character shifts are ignored (ink is drawn at its line-relative points). Rendering: white
  background, `drawInk` with paper colors (`PAPER_INK` for "ink" / near-white), cropped to the
  ink bounds + 12 px, scaled so the long side is ≤ 1500 px (upscale ≤ 4×), DOM canvas →
  `toDataURL` (iOS-safe), canvas freed afterwards. Sorted by `line` (a space before margin ink).
- **Store paths only.** Both notes go through `InkStore.load`; if src is open in an editor its
  anchors are first refreshed from the live positions (`touch` + `flush` → `beforeSave`; nothing is
  written when unchanged — src's ink content is never modified). dst is changed with ONE
  `editSpaces` step (remove all its spaces/strokes, add the copies: undoable in dst like any ink
  edit), then `setContentWidth` and `flush`. Open views of dst get the `layout` change and resolve
  the new strokes' positions (inkView resolves unresolved positions on `layout` as on `sync`).

## Rendering
- CM6 `ViewPlugin` registered via `registerEditorExtension`. It owns an absolutely-positioned SVG overlay
  placed so that its (0,0) is at the top-left of the document content (use `view.documentTop`,
  `contentDOM` rects, measured inside `view.requestMeasure`). Overlay scrolls with the content,
  `pointer-events: none`, sits above text. Height = `view.contentHeight` + room below.
- Re-render on `docChanged`, `geometryChanged`, `viewportChanged`, `heightChanged`. Only render strokes whose
  line is near the viewport (cheap culling) — must stay smooth with hundreds of strokes.
- Pen styles (M2, `geometry.ts`):
  - `ball` (default) / `dashed` (legacy `dotted` = dashed): smooth centerline — quadratic Béziers
    through the segment midpoints (`curvePath`, uniform quadratic B-spline: stays inside the control
    polygon, so no overshoot), rendered **stroked** (`fill: none`, `stroke-width = size`, round
    caps/joins). Constant width, pressure ignored. Snapped shapes use straight segments
    (`polylinePath`) so their corners stay sharp.
  - Dashed (M2 Stage A2, GoodNotes-like): fixed screen-space pattern, 7 px dash / 5 px gap at 1.6 px
    (`dashArray`: round caps, so the array is `dash − size, gap + size`; scaled up only for wider pens),
    `stroke-dashoffset` 0 at the stroke start. To make the pattern independent of pen speed, the dashed
    centerline first drops points closer than 1.5 px to the previous kept point (`thinPoints`), so slow
    jittery strokes don't gain path length; dashed strokes also skip the lift refinement, so the pattern
    never moves on lift.
  - `notes` (Apple Notes-style, opt-in via the "Pen feel" setting; Thin/Thick only): `perfect-freehand`
    outline (thinning .6, smoothing .5, streamline .35, tapered ends, `simulatePressure` when all points
    share one pressure, e.g. mouse), rendered filled.
  - Highlighter: `perfect-freehand` constant-width outline, filled, `opacity: .35`, rendered beneath pen
    strokes (separate `<g>`), `mix-blend-mode: multiply` in light theme.
- Pen widths (on-screen, matching GoodNotes at ~5.5 px/mm): Thin 1.6 px (0.3 mm), Dashed 1.6 px,
  Thick 2.7 px (0.5 mm) — editable in settings. Highlighter: normal 12 px, wide 22 px.
- **Smoothing (M2 Stage A2, `smoothing.ts`, pure + tested)** for every freehand stroke (all pen styles
  and the highlighter; snapped shapes bypass it):
  1. Input filter while drawing (`StrokeSmoother`): 2-D One Euro filter on x/y with the real event
     timestamps (coalesced events included; dt clamped to 1–100 ms), then a 0.5 px min-distance filter.
     Setting **Smoothing** Off / Light / Medium (default) / Strong (synced) → `SMOOTHING_PARAMS`
     (minCutoff Hz / beta per px/s: light 3/0.3, medium 1.5/0.12, strong 0.8/0.05; dCutoff 1; Off = no
     filter). The raw pen position is always drawn as the stroke's tip, so the ink never trails the pen.
  2. Live rendering uses the same midpoint curve, built incrementally (`CurveBuilder`, prefix-stable,
     O(1) per point) — identical to `curvePath` for the same points.
  3. On lift (`finishPoints`): append the lift point, centered Gaussian smoothing along the arc
     (σ = 1 px; removes staircase residue the causal filter can't) that never crosses a sharp corner
     (`findCorners`: turn > 60° over ±2 px of arc; corners and ends stay fixed, so "v"/"z" stay crisp),
     then RDP simplify (0.25 px, but no segment longer than 3 px so the midpoint curve can't cut
     corners). Moves the ink by a fraction of a pixel: no visible jump between live and committed.
- The note must have room to draw past the end: add bottom padding (~50vh) to the content when the plugin
  is active.
- Each editor view needs to know which file it shows: use `editorInfoField` from `obsidian`
  (`view.state.field(editorInfoField).file`). Handle the same editor switching files (reload ink).

## Input
- Listen on `view.scrollDOM` in **capture** phase:
  - `touchstart`/`touchmove` (non-passive): if any touch has `touchType === "stylus"` → `preventDefault()`
    (blocks scrolling, text selection, caret moves, and iPadOS Scribble).
  - `pointerdown` with `pointerType === "pen"` (or `"mouse"` when Mouse draws is on, primary button) →
    `preventDefault()`, `stopPropagation()`, `setPointerCapture`, start stroke. Finger (`"touch"`) is ignored
    entirely so it scrolls natively.
  - `pointermove`: use `getCoalescedEvents()` when available for smooth lines; pressure from
    `e.pressure` (fallback 0.5 when 0 for mouse). Live-render the in-progress stroke with rAF batching.
  - `pointerup`/`pointercancel`: finish → anchor → push to undo stack → schedule save.
  - Also suppress `mousedown`/`click` compat events that follow a pen stroke so the cursor doesn't move.
- Never blur or refocus the editor. The keyboard must keep typing at the existing cursor mid-lecture.
- Eraser tool (Stage E options, per device; a gray circle shows the eraser while erasing):
  - **Whole stroke** (default): while dragging, delete any stroke with a point (or segment) within
    10 px of the pointer segment. Live; the drag is one undo step (batch id).
  - **Precise**: erase only the part touched, eraser radius S/M/L = 5/10/20 px (+ stroke half-width).
    `erase.ts` (pure, tested) cuts each touched stroke's current pieces with every new eraser segment
    (only stroke segments near the eraser are subdivided into ≤ 1 px samples, pressure interpolated;
    untouched points stay identical; crumbs < 1 px dropped). While dragging the originals are hidden
    and the pieces drawn live; on lift ONE `replaceStrokes` op replaces every cut stroke by its pieces
    (new ids, re-anchored to the line under their top; pieces of a snapped shape get `shape:
    "polyline"` so they keep straight segments). Note: all pieces take the z-position of the first
    cut stroke (store rule).
  - **Erase highlighter only**: pen strokes are skipped (both modes).

### Stage B gestures (inkView.ts; pure logic in shapes.ts, gestures.ts, lasso.ts)
- **Snap to shape (draw and hold, pen tool only, setting on by default):** while drawing, if the pen
  stays within 4 px for the hold delay (default `SNAP_HOLD_MS` = 500 ms in shapes.ts, overridable by
  the pen-popover setting), `recognizeShape` runs ONCE on the points so far (a timer re-checks stillness; nothing
  heavy per pointermove). Recognizer: collapse the hold tail (the settling hook + drift recorded while
  the pen is held, within ~5–9 px of the last point, → one point; without this, a straight line plus
  hold failed the line test) → resample → **arrow** (tried before the closure test: a big head's barb
  can end near a short shaft's start) → closure test → windowed turning-angle corners → closed:
  ellipse/circle (principal axes + residual) or triangle / rectangle (incl. rotated, ~90° corners,
  snapped to axes within 7°) / polygon ≤ 8 with straight-side residual checks; open, in order:
  **arrow**: tip = first arrival near the point farthest from the start (else that farthest point
  itself); straight shaft (≥ 16 px; a landing curl ≤ min(8 px, 30%) is cut off if needed) up to where
  the pen first turns back (normally the tip; for a ">" head drawn shaft → back-barb → tip → barb,
  the shaft ends just before the tip and must aim at it); then 1–2 barbs: excursions from the tip
  bent back 10–80° off the shaft (tiny excursions < the minimum barb — the rounded loop / overshoot at
  the tip, an end hook — are ignored), each returning to the tip or not — "shaft → barb → back →
  other barb → back", "shaft → barb → back", "shaft → hook"; two barbs on opposite sides; the barb's
  stroke on the tip side is straight beyond 40% of its length; head never past the tip; barb ≤ 100%
  of the shaft, head path ≤ 4.5× shaft. Big heads (barb > 50% of the shaft — typical hand-drawn small
  arrows, 25–55 px, have barbs at 50–70%) only count when the first barb returns to the tip: that,
  not the size ratio, tells an arrow from a "V" or check mark (one arm, never returning). Regression
  fixture: tests/fixtures/sample-arrows.v2.json (10 hand-drawn iPad arrows + a dot and a tick) → clean arrow
  with two symmetric barbs (length = mean drawn barb); **line** (core
  of the path minus small end hooks within max(min(6 px, 8%), 4.5%) of its best-fit line, checked
  before any corner logic; snaps to exactly horizontal/vertical within `lineSnapDeg` = 5° — diagonals
  are untouched); **polyline** (2–8 straight segments, sharp corners, no retracing; a "corner" within
  min(12 px, 8% of the path) of either end is the landing/settling hook and is cut off);
  **right angle** (graph axes drawn as one stroke, └ ┘ ┌ ┐ in either direction, any leg ratio): a
  2-segment polyline whose corner is within 90° ± `rightAngleTolDeg` (15° → 75–105°) becomes two
  exactly perpendicular legs. Each leg is fitted on its middle part (corner rounding/overshoot and end
  hooks excluded); the frame angle is the length-weighted mean of both legs' directions, snapped to the
  axes within `rightAngleAxisDeg` = 10° (then legs are exactly horizontal/vertical); each clean leg
  passes through the centroid of its drawn middle part (so an overshoot doesn't move the corner); leg
  lengths = projection of the start / farthest point. Outside 75–105° the 2-segment polyline keeps its
  drawn angle. Decision: the rule is orientation-free, so a "V" opened ~90° becomes an exact right
  angle rotated 45° (symmetric), and a held check mark (~75–80°) also squares up — both were already
  polylines, never arrows. Stored as an ordinary `shape: "polyline"` (no new enum value, so older
  plugin versions read it unchanged); the in-memory `ShapeSpec` carries `rightAngle: true` for the
  adjust step. **Smooth curves** (for graphs; tried last, for open strokes that are not
  arrow/line/polyline): the stroke minus ≤ 3 px at the start and ≤ 6 px at the end (landing curl,
  settling hook) must have a bbox diagonal ≥ `curveMinSize` = 40 px (handwritten "c", "u", "n", "s",
  "e" are smaller) and total turning ≤ 300° (measured on ~20 chords; spirals, waves and cursive turn
  more). Three models, each must fit within tol = max(3 px, 3% of the diagonal) (max; mean ≤ tol/2;
  trimmed ends ≤ 2·tol): **arc** — circle fit (algebraic Kåsa, refined by Gauss–Newton), angle
  progressing one way, sweep 20–300°, radius ≤ 4× diagonal → `{cx, cy, r, start, sweep}`;
  **parabola** — v = αu² + βu + γ in a frame where u runs one way along the stroke; the exact
  axis frames (opening up/down, then sideways) are tried first and win if they fit, else the
  principal-axis frames (rotated parabola) → stored as an exact quadratic Bézier `{a, c, b}`;
  **curve** — one cubic Bézier through the trimmed ends, least-squares inner control points with
  Newton reparameterization (exponential growth/decay, S-curves, sigmoids) → `{a, c1, c2, b}`. The
  simplest model (arc, parabola, curve) whose max deviation is within max(2 px, 0.5% of the
  diagonal) of the best one's wins (a cubic absorbs some hand wobble, so it is always a bit closer).
  Line wins over a slight arc (the line test runs first). Stored as `shape: "arc" | "parabola" |
  "curve"`. Known limits: a small "n" or a wavy line can still become a zigzag polyline
  (pre-existing polyline behavior, not changed). Not confident (handwriting) → stroke stays as drawn.
  "V", "Y", check marks and handwriting are tested not to become arrows. After a snap, while the pen stays down,
  `adjustShape` reshapes on every frame: line/arrow end follows the pen; closed shapes/polylines scale
  in their own frame from the bbox corner opposite the pen (circle uniformly; a right angle scales in
  its legs' frame, so it stays exactly 90° and axis-aligned); an arc follows the pen by a similarity
  (rotate + uniform scale) about its start, so it stays circular with the same sweep; a parabola /
  curve scales per axis about its start (graph-like stretch; an axis-aligned parabola stays
  axis-aligned; if the pen started level with the start on one axis, that axis takes the other
  axis' factor). Lift → stored with `shape`.
- **Lasso tool:** the pen draws a dashed loop; on lift every candidate stroke (pens and highlighters;
  the caller passes the candidates, so it can pre-filter by tool) that the loop TOUCHES is selected
  (`selectInLasso`, touch rule): any of its points inside the loop or any of its segments crossing
  the loop's edges (closed implicitly) — a small loop around the end of a long line selects the whole
  line. Bbox prefilters per stroke, per point and per segment keep it cheap. Selection UI: dashed accent
  box with a resize handle (bottom-right) and the context menu (below). Drag inside (pen, mouse, or
  finger — a finger touch starting on the selection `preventDefault`s its touchstart so it drags
  instead of scrolling) → move; drag the handle → uniform scale incl. stroke width. While dragging only
  SVG transforms change; on lift one `replaceStrokes` op commits. A press on the selection that moves
  < 6 px is a **tap**: it toggles the menu and changes nothing. Tap outside (pen: new tiny lasso;
  finger: quick tap) or switching tools deselects. **Stage E filter** (lasso popover, per device):
  select pen / highlighter / both — applied in `inkView.finishLasso` before `selectInLasso` runs.
- **Lasso context menu (Stage B2, GoodNotes-style):** one rounded menu (HTML `.pl-menu` inside
  `scrollDOM`, scrolls with the note; presses `preventDefault` so focus never moves) opens
  automatically after a lasso selection and on a tap on the selection; hidden while dragging, closed
  after a move/scale. Items: **Copy, Cut, Duplicate, Delete, Color ▸** (submenu: pen palette for pens,
  highlighter palette if only highlighters are selected; Back), **Screenshot**, and (Stage K) **Make
  drawing space** when the selection has line-anchored ink. Placement
  (`menu.ts placeMenu`, pure): above the selection if it fits in the visible scroller area, else below,
  else pinned inside the visible area; horizontally centered and clamped. Placed once per
  target/content, not re-placed while scrolling.
- **Clipboard (Stage B2):** Copy/Cut store an anchor-free `InkClip` (`clipboard.ts makeClip`:
  strokes in z-order with points relative to the clip's bbox, no ids/anchors) on the plugin —
  in memory, session-only, shared by all notes. Best effort, Copy/Cut also write a PNG of the
  selection (theme background, 2×) to the system clipboard (`ClipboardItem` with a Blob promise so it
  starts inside the tap, as Safari requires); failures are only logged. With the lasso tool and a
  non-empty clipboard, a pen **tap on empty space** (when nothing was selected and no menu was open —
  otherwise the tap just dismisses) or a pen **long-press** (500 ms, < 6 px) shows a **Paste** menu at
  that point. Paste centers the clip on the point, clamped into the content column and below the
  document top (`pasteOrigin`), gives every stroke a new id and re-anchors it to the line under its
  top (like a new stroke), inserts all as ONE `replaceStrokes` op (undoable) and selects them. Cut =
  copy + one `removeStrokes` op.
- **Screenshot (Stage B2, `screenshot.ts`, crop math in `crop.ts`):** Obsidian Modal. The *stage*
  (rendered region) is the selection plus the full text column horizontally and ≥ 200 px vertically,
  clipped to the scroller width × document height; the crop frame starts at the selection bbox +
  16 px and has 8 handles (44 px touch targets) + body drag (`dragCrop`: clamped to the stage, min
  24 px, opposite edge fixed). Rendered at clamp(devicePixelRatio, 2, 3)× (reduced so a canvas stays
  ≤ 10 M px for iOS). Composite = theme background → text layer (optional) → highlighters (α .35,
  `multiply` in light theme) → pens; ink is drawn with Path2D from the same `strokeToPath`/`dashArray`
  as the overlay (never taints). **Include text** (default on): `html-to-image` `toSvg` clones
  `.cm-content` with inlined computed styles + used web fonts, shifted so the stage corner is at the
  SVG origin (src-less CM `cm-widgetBuffer` images and broken images are filtered out), drawn into a
  canvas. Only lines inside CM's rendered viewport exist in the DOM (fine for a visible selection).
  If the canvas is tainted (WebKit), stays blank although the region has text (retried once), or
  takes > 10 s → ink only, toggle disabled, notice in the modal. The output PNG is pre-rendered after
  every crop/toggle change so Share/Copy can run inside the tap. Actions (unsupported ones hidden):
  **Share / Save to Photos** (`navigator.share({files})`, only if `navigator.canShare` accepts a PNG
  file), **Copy image** (`ClipboardItem`), **Save to vault** (`Attachments/Screenshots/<note basename>
  <YYYY-MM-DD HHmmss>.png`, " 2" suffix on collision, Vault API `createBinary` + `createFolder`),
  **Insert into note** (save, then `!` + `fileManager.generateMarkdownLink` inserted at the editor's
  cursor on its own line via a CM transaction — no `focus()`, no scroll; the caret ends after the
  embed), **Discard**. The modal restores the editor focus/selection on close.
- **Pencil-tip double-tap (setting, default OFF since Stage E — dotted i's triggered it):** two pen
  contacts each < 120 ms and < 3 px movement, the second starting < 280 ms after the first ended and
  < 6 px away → toggle current tool ↔ eraser. **Writing guard:** a tap within 40 px of ink finished
  in the last 1.5 s (InkView keeps a short `recentInk` list of committed stroke bboxes) is
  handwriting — it is committed at once and can never start or complete a double tap (`gestures.ts`
  `isFirstTap`/`canPair`/`isDoubleTap`; `tests/doubletap.test.ts` replays i/j/ü/colon/ellipsis
  sequences). A first tap is held back (its dot is drawn live but not stored) until the pairing window
  passes; a second tap discards both — no dots, no undo entries. In the eraser, erasing starts only once the contact is
  clearly not a tap, so double-tapping in the eraser doesn't erase what's under it. Command "Toggle
  eraser" (no default hotkey) does the same.
- **Scribble to erase (opt-in, default off):** `detectScribble` — ≥ 4 hysteresis reversals along the
  principal or minor axis, ≤ 1.5 s, ≤ 200 ms/leg, path/diag ≥ 3, small advance per (inner) leg, ≥ 60%
  sharp turns. Coverage rule (calibrated on iPad feedback: "I need less scribble touching the shape"):
  a stroke is erased when about **half** of it is scribbled over — ≥ 45% of its length inside the
  covered region (union of convex hulls of every 3 consecutive legs, rasterized with a distance
  transform) AND that inside part spanning ≥ 45% of its extent along its main direction (so loopy
  letters don't count double) — AND it is scribbled *over*: ≥ 3 legs cross it in their middle 70%
  (each leg taken as its chord, so jitter along a parallel line doesn't count), or ≥ 50% of it lies
  ≥ 6 px deep inside (dots, marks between parallel legs). Legs that cross it only near their ends are
  turnarounds — hatching reaching (or overshooting) an outline — and never count; a stroke crossed
  more at leg ends than in leg middles is kept. Bbox area ≤ 4× the scribble's (was 2×, relaxed with
  the coverage: 0.7 → ~0.5 per dimension); closed strokes enclosing the scribble are kept. Examples:
  scribbling 60% of a word or a short stroke erases it, 40% keeps it; a 300 px line/axis needs ~135 px
  of scribble along it (40% keeps it); shading in a box, under a curve or across graph axes — even
  overshooting the outline by 8 px — keeps every outline (crossed only at turnarounds).
  **One gesture, one decision:** a `ScribbleTracker` per pen stroke drives both the live preview
  (candidates fade to 30%, throttled to every 120 ms) and the commit on lift, on the same points. The
  time limits gate only the start; once recognized, the stroke stays a scribble for as long as the
  whole stroke keeps a scribble's shape (`scribbleShape`, advance limit fixed at recognition + 10%),
  and candidates only accumulate — scribbling longer or over more strokes adds, never cancels. (The
  old commit re-ran `detectScribble` on the whole stroke at lift: past 1.5 s, or once the scribble got
  wider than tall and fell under the stricter sideways advance limit, it said "not a scribble" and the
  previewed erase silently didn't happen.) Erase is one undo step; if nothing qualifies the scribble
  stays as ink.

## Stage D — ink in Reading view and PDF export
Pure mapping in `readingMap.ts` (tested), DOM/Obsidian side in `readingView.ts` (`ReadingInk`,
installed from main.ts). The editor overlay is untouched; Reading view has its own rendering via
`registerMarkdownPostProcessor`.
- **Per-section SVGs.** Reading view post-processes each rendered section (paragraph, list,
  heading, table, code block, callout …) with `ctx.getSectionInfo(el)` = `{text, lineStart,
  lineEnd}`. Each section that owns ink gets one absolutely positioned SVG (`.pl-reading-ink`,
  `overflow: visible`, `pointer-events: none`, z-index 5; the section gets `position: relative`) —
  ink overflowing the block is never clipped. Highlighters in a group beneath the pens (opacity
  .35 per path), whole SVG `mix-blend-mode: multiply` in light themes (as the overlay); pen paths
  from the same `strokeToPath` / `dashArray` as the editor. x = section left (= content left, which
  matches `.cm-content` with readable line length). Anchors resolve with `resolveAnchor` against
  the section info's text (cached per stroke and text).
- **Strokes → sections (`ownedRange`).** A section owns its own lines plus the blank lines below
  it (up to the next non-blank line); the first section also owns everything above it. So ink
  drawn in blank lines below a block stays with the block above it, and every line has exactly one owner.
- **y-mapping (`lineTop`).** Within a section, line tops come from measured marks: list items
  (`<li>` ↔ item lines in order; `data-line` as a fallback), table rows (`<tr>` ↔ non-separator
  lines), `<br>`-separated paragraph lines (top of the first content after each `<br>`), code
  block content (top/bottom of `<code>` ↔ first/last code line). The section top is the mark of
  `lineStart`, its content bottom the mark of `lineEnd + 1`; lines between marks are interpolated
  proportionally (so a callout or a wrapped paragraph spreads its lines over its height). Below the
  section: content bottom + one line height per (blank) line; above it (first section): one line
  height per line upwards. Marks are clamped and kept monotonic. Within a line, stroke y is used as
  is (no scaling: reading and editor text share font size/line height).
- **Room for ink in collapsed blank lines (`reserveSpace`).** Blank lines collapse in Reading view,
  so ink drawn in them would cover the next block. The section's bottom margin is raised to the
  ink's bottom (+ 4 px), at most to the editor height of its own trailing blank lines (ink further
  down already covered the next text in the editor). A margin (not a spacer) collapses with the
  normal paragraph gap, so small overflows (underlines, descenders) change nothing.
- **Ink below the end of the note (Stage I fix).** The section owning the note's last line
  (`reserveSpace(…, {atEnd})`) reserves room for ALL of its ink, uncapped and also without blank
  lines — below the end of the document the editor has drawing room (the ~50vh bottom padding), not
  text. That room is an empty in-flow spacer (`.pl-reading-room`, inside the section, after its
  content, sized so its bottom = ink bottom + 2 px), not a margin or padding: in print a margin
  adjoining a page break is truncated, and Chromium moved a block with a large bottom padding to the
  next page whole. In print the preview's own bottom padding is dropped when the spacer exists
  (`:has`), so a drawing ending near a page bottom adds no blank page.
  *Root cause of a broken export* (synthetic regression fixture: tests/fixtures/end-drawing, strokes
  anchored to the last blank lines, reaching ~285 px below the last text line): only the 2 trailing blank lines' height
  (52 px) was reserved, the rest of the drawing overflowed the export container, and Obsidian's
  print CSS (`html, body { overflow: auto; height: auto }`) makes `body` a scroll container that
  clips overflow and paginates only the in-flow height — so the drawing was cut at the end of the
  content and the PDF had one page. On iOS the page area below the clipped body shows the theme's
  (Origami: cream) background, the "cream rectangle". Reproduced in headless desktop Obsidian
  (clipped, 1 page); fixed there (whole drawing; flows onto page 2 when it crosses a page end).
  Also fixed: a missing `}` in styles.css nested every Stage D rule under the desk-select menu
  rule, so none of them applied (inline styles masked it).
- **Text highlights (Stage C)**: exact. Per section line of the range, the source slice is turned
  into display text (`stripInline`: links → text, embeds/comments dropped, `* _ == ~~ \``
  markers and leading block markers removed), whitespace-normalized, and found in the section's
  rendered text (text nodes, index-mapped) — the k-th occurrence, k = occurrences in the section's
  source before it. A DOM `Range` over it → `getClientRects` → `mergeRows` → the editor's rounded
  rects (`rowsPath`). Pieces in other sections are drawn by those sections; if the owner finds
  nothing (math, unusual markup) it draws the stored freehand points instead.
- **Keeping in sync.** Sections are registered (a `MarkdownRenderChild` per section, removed on
  unload) and re-laid out: on resize (ResizeObserver: images loading, width changes, re-attach
  after Reading view's virtualization), when any section of the same note is (re-)rendered (line
  numbers shift after edits in another pane), on every store change of the note (`observeAll` —
  drawing/undo in an editor pane, live sync; the reading view never subscribes, so it never becomes
  the position owner), on settings changes (`refreshAll`) and on `css-change` (theme). The store
  loads the note's ink on demand. "Show ink" off removes the SVGs and margins. Reading views open
  when the plugin loads are re-rendered once (`previewMode.rerender(true)`). Embeds/hover
  previews (`.markdown-embed`) are skipped.
- **PDF export.** Obsidian's export (desktop: a hidden 1 px-wide popout window; mobile: a `.print`
  div in the main document) renders the whole note into ONE `.markdown-preview-view` inside
  `.print`, wraps every top-level block in a `<div>` (`<hr>` unwrapped, optional file-name `<h1>`
  first) and runs the post-processors ONCE on the container with `getSectionInfo: () => null`,
  awaiting returned promises. So the post-processor (when `el.parentElement` is `.print`) returns
  a promise that waits for the embeds/other post-processors and images, reads the note
  (`cachedRead`) and its ink, then matches the blocks to the metadata cache's sections by kind
  (`alignBlocks`, an LCS: comments render nothing, the title has no section, callout ≈
  blockquote, math ≈ paragraph) and draws each `<div>` block like a Reading view section, with
  `ownedRange` bounded by the next matched block. **Width:** the hidden window is 1 px wide, so
  before measuring, `.print` is set to the printed width — `printAreaWidth(vault.getConfig(
  "pdfExportSettings"))` (page size, orientation, margins: default 1 cm / none / minimal,
  downscale) — and restored afterwards. Chromium fragments the SVG across page breaks correctly.
  In print, "ink" is a literal `#1a1a1a` (and `--pl-ink` is dark under `.print` / `@media print`),
  highlighters multiply. Export ignores "Show ink"; it only follows:
- **Include ink in PDF export** (per device, `includeInkInPdf`, default on): ⋯ menu item and a
  settings toggle; off → the post-processor does nothing in print. It is the default used by
  Obsidian's own export.
- **One-shot exports (Stage H):** ⋯ menu entries **Export PDF with ink** / **Export PDF without
  ink** (right below the toggle; desktop and mobile, slim and full bar; shown when
  `workspace:export-pdf` exists) and the commands **Export to PDF with / without ink** apply to that
  export only — the toggle is never changed. `exportPdf.ts PdfExporter` (state logic pure in
  `exportOnce.ts`, tested) arms an override, makes the toolbar's leaf active (no focus) and runs
  `workspace:export-pdf`. That export is asynchronous: its dialog (a Modal) → on desktop "Export"
  awaits a native save dialog (cancelling it leaves the dialog open) → the dialog closes → the hidden
  render runs our print post-processor once, which calls `printOptions()` (was `printIncludesInk()`) = `take`: the override
  if pending, else the toggle, and always consumes it. The dialog is watched with a
  MutationObserver on `<body>` (`.modal-container` added/removed): while it is open the override
  waits (fallback expiry 30 min); when it closes (Export or Cancel) the override survives only a
  15 s grace period for the render to start; a new dialog opening after ours closed (cancel →
  plain export) drops it at once; no dialog seen within 2 s counts as closed. So after a cancel
  the next plain export uses the toggle again.
- **Stage H**: character-anchored ink (see "Stage H — ink stays on its text") is placed at its
  character's rendered rect instead, by the section owning the character's line; this mapping is
  its fallback.
- Known limits: placement is approximate where the editor and Reading view differ a lot inside a
  block (Live Preview widgets such as tables/embeds anchor ink to their first line; images inside
  paragraphs; callouts interpolate). Ink is positioned relative to its section, so it follows its
  block, but ink spanning several blocks can drift where blocks change height. Mobile export
  (iPad) is untested: its print width is assumed to follow the same settings.

## Stage K — protected drawing spaces (page view retired)
Feedback after Stage J: page view did not work well (text hung into the page gaps); drawings in a
dedicated space moved around, overlapped and got squished; a drawing made into a space should be
protected; page breaks are not needed, only correct formatting when exported.
**Root causes.** CM6 can't really be paginated (Stage I's sheets were overlays behind text that
kept its own flow). And "Add space" inserted blank lines: every stroke anchored to *its own* line,
so when line heights or gaps changed (Live Preview styling, re-measuring off-screen lines, edits)
the strokes of one drawing moved by different amounts — squished, and saved that way once the user
edited while it was squished.

Pure rules in `spaces.ts` (tests: `tests/spaces.test.ts`), model/merge in `model.ts`, undo in
`store.ts`, editor in `spaceView.ts` + inkView.ts hooks marked `[Stage K]`, Reading view / PDF in
`readingView.ts`.

- **Retired.** Page view (sheets, page gaps, page numbers), "+ Add page", blank pages between
  pages, manual page breaks, Shift+Enter / Backspace keymaps, their ⋯ entries, settings toggle and
  commands, `pages.ts`, `pageView.ts`, the page-view export (forced breaks, block placement, ink
  split across sheets). A stored `pageView` setting is ignored. The PDF export is the Stage D one,
  plus spaces.
- **Sidecar format** (markdown is never modified by a space; v2 stays v2):
  ```json
  {"version":2,"contentWidth":700,"strokes":[ …,
     {"id":"s9","tool":"pen","color":"ink","size":1.6,"style":"ball","anchor":{"line":4,"hash":"1i69oqu"},"xy":[2500,900,…],"space":"k1"}],
   "spaces":[{"id":"k1","after":{"line":4,"hash":"1i69oqu"},"height":334},{"id":"k2","after":"end","height":221}]}
  ```
  `spaces` is written only when non-empty; invalid/duplicate entries are dropped on load and heights
  are clamped to [48, 50000] whole px. A stroke's `space` is its last key; its points are relative
  to (content left, the space's top), so the drawing is ONE rigid piece that moves with its space.
  Its `anchor` stays a valid line anchor (the space's line; the last line for "end" spaces): older
  plugin versions ignore `spaces`/`space` (no crash; they drop them on their next save) and draw
  that ink line-anchored — misplaced, but present. A stroke whose space id is unknown falls back
  the same way. On load every space is grown to hold its ink (`fitSpacesToInk`: lowest point + half
  the pen width + 8 px), so a space can never cut its drawing. Notes with only spaces keep their
  sidecar (`isEmptyInk`).
- **Old Stage J files convert on load** (`parseInkFile`): each page in `pages` becomes a space with
  the same id and anchor ("end" stays "end"), one printable page tall at the note's editor width
  (`legacyPageHeight`: Letter, 1 cm margins, `contentWidth` or 700 → 1012 px; grown to its ink),
  and ink with `page: id` gets `space: id` (its page-relative points are space-relative as they
  are). Ink on an unknown page falls back to its line anchor; `breaks` are dropped. The file is
  rewritten in the new form on the next save.
- **Where a space shows (`blockEnds`, `displayLine`).** A space anchored after line L sits after
  the LAST line of the Markdown block holding L: a paragraph's soft lines, a fenced code block, a
  `$$` block, a table, a quote/callout, the frontmatter; a list item with its continuation lines
  (the next item, nested or not, is its own block); headings, rules and blank lines are one-line
  blocks. The PDF prints a block as one piece, so a space can't split one — and the editor shows it
  at the same place, so they agree. "end" spaces follow the last line, after the line-anchored ones
  there; several spaces at one line keep their list order (`spaceSlots`). In session the anchor is
  a live position mapped through every edit with assoc −1 (like `Stroke.pos`); on load
  `resolveAnchor` (hash search ±200 lines, else clamp). So deleting the line a space hangs off
  moves the space to the nearest line, with its drawing intact.
- **Editor (`spaceView.ts`).** Each space is a CM6 block widget (`.pl-space`, exactly `height` px,
  no margin/border in the box model — a faint inset outline and tint show the room) at the end of
  its display line (`side` = its order). Text flows around it and can never go under it. The
  widgets come from a `StateField` that re-places them *in the same transaction* as every edit (it
  maps its own copy of the positions and recomputes `blockEnds`), so there is never a frame where
  text and a space overlap and no extra dispatch while typing. The ink view feeds it the note's
  spaces (`setSpaces`) on load, on every store change (add/remove/resize, undo/redo, live sync) and
  for live heights while drawing / resizing. A space's top is read from CM's block structure
  (`spaceLayout`: the line block of its line includes the widgets after it, each with its own top
  — `BlockInfo.widget`), and space ink is placed at exactly that top (`InkView.lineTop`), so ink
  and space can't disagree. Hiding ink keeps the spaces (the layout never changes).
- **Which ink belongs to a space.** A drawn stroke belongs to the space its FIRST point lies in
  (`spaceAt`: [top, top + height)); no Stage C text snapping or Stage H character anchor there. A
  group — lasso move/scale, duplicate, paste — joins the space containing the centre of its
  bounding box (`groupSpace`), as one piece, or none (then the usual line / character anchoring):
  moving ink into a space puts it in, moving it out re-anchors it to the line under its top, and a
  moved drawing never splits between a space and the text around it. Precise-eraser pieces and
  recolored copies stay in their stroke's space. Copy, screenshots, hit tests, selection box and
  culling all go through `place()`, which returns the space's top for space ink.
- **Growing and resizing.** Drawing within `GROW_ZONE` = 40 px of a space's bottom (or past it)
  grows the space live, while the pen is down, to `GROW_ROOM` = 80 px below the ink (`grownHeight`;
  like GoodNotes extending its canvas) — the text below moves down, the stroke being drawn doesn't
  move (the space's top doesn't change). On lift the stroke and the new height are ONE undo step
  (undo shrinks the space back). Ink moved/pasted/duplicated into a space grows it the same way
  (`commitStrokes`). The resize handle (a grip centred on the bottom edge, 80 × 40 px target; pen,
  finger or mouse; `touch-action: none`, a finger drag resizes instead of scrolling) sets any
  height live and commits one undo step on release, but never less than the ink needs
  (`resizedHeight`). A space never shrinks on its own.
- **Ink below the end of the note** (and below every space there): a stroke starting more than
  12 px below the last line's block (`END_SPACE_SLACK`, so an underline of the last line stays line
  ink) goes into the last "end" space, grown to hold it, or a new "end" space starting at the end of
  the note (`endSpacePlan`) — one undo step with the stroke.
- **Add space** (⋯ menu "Add drawing space", command "Add drawing space below cursor line"): a
  space after the cursor's line (its block), `defaultSpaceHeight` = ⅓ of the editor height within
  [160, 600] px. No text is inserted; the cursor, the selection and the focus don't change. One
  ink undo step.
- **Space menu.** A "⋯" button at each space's top right opens **Clear ink** (removes its strokes;
  one undo step) and **Delete space** (asks first when it has ink — Obsidian modal "Delete space" /
  Cancel; the space and its ink are one undo step, undo restores both at their z-positions).
  Controls are HTML in a layer inside the scroller (`.pl-space-ctls`, outside the editable
  content, like the lasso menu): presses `preventDefault` + `stopPropagation` (CM never sees them —
  no caret move, no focus change, no iPad keyboard), stylus touchstarts are cancelled
  (`blockStylusTouch`), buttons activate through `tap.ts onTap` (Pencil on pointerup), and the ink
  view ignores events on them (`isUiTarget`). Elements persist per space id (the handle keeps its
  pointer capture while the space grows under it).
- **"Make drawing space"** (lasso menu, shown when the selection has ink that is not in a space and
  not a text highlight) repairs existing line-anchored drawings, e.g. a drawing
  below the end of the note: the selected strokes become a space exactly where they are on screen
  (`planMakeSpace`): the space follows the last block-ending line whose bottom is at or above the
  ink's top (+ 6 px slack), its points become relative to that line's bottom (so nothing moves), and
  its height is the ink's bottom + 8 px. Blank lines right below that line which the ink covers are
  deleted — the space replaces them — except lines other ink is anchored to and, when text follows,
  the last blank line if the line above the space is text (else the two blocks would merge into one
  paragraph). The markdown change is one CM transaction (Cmd+Z undoes it); the ink change is one
  ink undo step. Text highlights and character anchors are not converted (character anchors are
  dropped: ink in a space is rigid). Nothing is converted automatically on load.
- **Undo/redo.** Store op `space`: spaces `removed` / `added` / `resized` together with strokes
  `before` (removed) / `after` (inserted) — `editSpaces` (add space, delete space with its ink,
  resize, stroke + growth, Make drawing space, a group moved into a space). Spaces held in the undo
  stacks keep their positions mapped (`allSpaces`).
- **Live sync.** `mergeSpaces` = the merge by id (`mergeById`; local additions kept, local
  deletions stay deleted, remote additions/deletions apply; a switch between "end" and a line
  anchor takes the remote version) with the HEIGHT merged field-wise against the base (`mergedHeight`:
  the side that changed it wins, remote if both did), so a local unsaved resize survives a remote
  edit. Which space a stroke is in counts as stroke content. Undo entries that no longer apply are
  pruned like stroke ops.
- **Reading view / PDF (`readingView.ts`).** A space is an in-flow block of exactly its height
  (`.pl-reading-space`, `position: relative`) with its ink in an SVG at its top-left (same paths
  and colors as the editor), drawn by the section owning its display line (`ownedRange`). After the
  section's last line, or one of the blank lines below it: appended after the section's content
  (before the Stage I room spacer), moved to where the editor has it — the section mapping's y of
  the next line (`lineTop`: content bottom + one line height per blank line, as line-anchored ink
  uses), by padding above it when it sits higher, or a negative top margin that collapses with the
  paragraph's bottom margin when it sits lower. After a list item in the middle of a list
  (`readingPlacement`): inside that `<li>`, before its nested list, so the items below move down as
  in the editor. Line-anchored ink on blank lines after appended spaces moves down by their heights
  (`shiftBelowSpaces`). Strokes in known spaces are drawn only by their space. Spaces show with
  "Show ink" off too, and print with or without ink, so the layout never changes. In print a space
  up to one printable page tall gets `break-inside: avoid` (its drawing is never cut by a page
  break; a taller one is cut into page slices, see Stage L), and the preview's bottom padding is dropped when the
  note has spaces (no trailing blank page). A section that isn't rendered (leaf in editing mode,
  hidden tab) is not laid out: measurements there are garbage and a block placed from them would
  stay wrong; the ResizeObserver lays it out when it is shown.
- **Verified** (headless Obsidian, throwaway profile, `app.emulateMobile(true)`, 1180×820 and
  820×1180, Pencil = CDP pen pointer events, export through Obsidian's own print-to-PDF without
  the save dialog, PDF → PNG): Add space below the cursor's paragraph (no text inserted, focus and
  cursor unchanged), draw in it (ink gets `space`); drawing past the bottom grows the space live
  (206 → 334 px) and keeps the stroke; the handle resizes (+120 px) and clamps at the ink (275 px =
  ink bottom 266.8 + pad); typing three lines above, deleting them, and deleting the paragraph the
  space hangs off all move the drawing rigidly (identical stroke offsets inside the space, no text
  line overlapping it); ⋯ → Delete space asks, deletes space + ink, ink undo restores both; lasso
  move out of a space → line ink, duplicate → line ink, move back in → space ink, precise eraser
  pieces stay in the space; drawing below the end of the note creates an "end" space, a second
  stroke further down grows it, two undos remove both; "Make drawing space" on a sample
  drawing (57 strokes below the end) keeps every stroke at the same place relative to
  the text (0.0 px), deletes one covered trailing blank line, makes one 267 px space; the Stage J
  Legacy file (a blank page after a paragraph, an "end" page, a manual break) loads as two spaces
  with their ink and saves without `pages`/`breaks`/`page`; Reading view and PDF place each space's
  ink at the same offset from its top as the editor (sample drawing: −2.1 px in both; Spaces note: 40 / 30
  px in both, a space inside a list item in the `<li>`), the whole sample drawing prints on page 1,
  a space taller than what's left of a page moves whole to the next page.
- **Known limits.** Relative to the text ABOVE it, a space can sit a few px differently in Reading
  view / PDF than in Live Preview, because Live Preview and Reading view space blocks differently
  (sample: 8 px); the drawing itself is never distorted and never overlaps text. A space can't go
  inside a paragraph, table, code block or callout (it follows the block). Ink anchored by older
  versions to blank "Add space" lines stays line-anchored until converted with "Make drawing
  space". Devices running a pre-Stage K plugin show space ink line-anchored (and drop `spaces` when
  they save): update every device together. Mobile (iPad) PDF export is untested here (desktop
  export only).

### Blank lines next to a drawing space (2026-11-19)

Seen in practice: a note's trailing blank lines were drawn on, then the pen went
below the end and an "end" space was made — the drawing ended up split between line-anchored ink
(on the blank lines) and the space. Now (inkView "Blank lines next to a space"):

- **Absorb above.** When a stroke goes into a space (or a new "end" space) shown after blank
  lines that carry line-anchored ink, or a stroke starts on such blank lines and reaches
  `CROSS_INTO` px into the space below, the space is replaced by one shown right after the text
  line before the blank run (`blankRunAbove`): the blank lines' ink, the old space's ink (shifted
  by the run's height) and the new stroke go into it, at the same place on screen. No text
  changes: the blank lines now show BELOW the drawing (room to type under it), so the note grows
  by their height. One ink op (one undo restores the split state exactly). Repair of an existing
  split drawing: draw anything in the space (and erase it).
- **Grow from below.** A stroke started on ink-free blank lines directly below a space
  (`blankRunBelow`) belongs to that space and grows it (pushing the blank lines down); ink below
  the note's end grows the last space when only ink-free blank lines follow it.

### Typing below a drawing; moving a drawing (2026-11-19)
- **Below a drawing that ends the note** there was no text line, so a tap put the caret above the drawing and Enter kept the drawing (an "end" space) under the new text. Now a finger tap / mouse click below it, ↓ on the last line, or Enter at the end of a plain paragraph line followed by a drawing calls `openBelow`: "end" spaces there are first pinned to that line (one ink undo step), then a blank separator + new line is inserted (`openBelowInsert`) so the typed text starts its own block and the space stays above it. List/quote/heading/etc. lines keep the editor's Enter (`enterOpensBelow`).
- **Copy / Cut** in a space's "⋯" menu put the space (height + space-relative ink) on a plugin clipboard (`host.spaceClip`, session only) and the label `SPACE_CLIP_TEXT` on the system clipboard. A paste of exactly that label in the editor (⌘V, iOS Paste; capture listener on contentDOM, before CM/Obsidian) inserts the space after the caret line's block with fresh ids (one ink undo step); the command "Paste drawing below cursor line" does the same. Cut removes the original without the delete confirmation.
- **Drawings move with selected text, like an inline image.** A space is "in" the editor selection when the selection crosses it or covers the whole line it follows (`spaceInRange`); it is then highlighted (`.pl-space.is-selected`, via the widget's `selected` flag — the field rebuilds only when the selected set changes). Editor Copy/Cut (capture listeners) put those spaces on `spaceClip` with the selected text and each one's line offset (`rel`); Cut also removes them. Pasting that same text (`sameClipText`) lets the editor insert it, then re-adds the spaces after the matching pasted lines. Cut and Paste attach a `spaceMove` effect to the editor's own transaction (`expectSpaceMove` + `transactionExtender`; `invertedEffects` stores the inverse), so ⌘Z / ⌘⇧Z undo and redo the text and its drawings together.

## Stage L — PDF page slices, white paper, theme-adaptive ink
- **Page slices (`printSlices.ts`, pure + tested; `paginateSpaces` in readingView.ts).** Chromium
  can't fragment an empty block with an absolutely positioned drawing cleanly, so after the export's
  ink is laid out (still at the printed width) every space taller than one printable page
  (`printAreaHeight(cfg) − 2`, from `pdfExportSettings` like `printAreaWidth`) is replaced by
  slices: blocks of `overflow: hidden`, `break-inside: avoid`, each with an SVG of the strokes whose
  vertical extent intersects it, offset by −slice top. Slices after the first get
  `break-before: page`; the first carries the block's top pad and fills the room left on its page
  minus 24 px safety, or (less than max(⅕ page, 96 px) left) the drawing starts on the next page. The
  replacement has the block's total height, so nothing else in the continuous layout moves. The cut
  (`chooseCut`) is the point in [limit − ¼ page, limit] crossing the fewest padded stroke extents
  (the lowest of equals), so a frame or long vertical line doesn't stop it from cutting between rows
  of writing; a stroke crossing a cut shows clipped in both slices. Where a space starts on its page
  is modelled (`Pager`): the first page starts at the top of the `.print` root; a non-breaking space
  that doesn't fit starts a page; the last slice of a split space starts a page. Text pushed by
  widows/orphans isn't modelled: an error only costs blank space (a first slice that doesn't fit
  moves to the next page whole; the next slice still starts its own page).
- **White paper.** `.print` (and `@media print` html/body) force a white background
  (`--background-primary` too); ink SVGs and space blocks are transparent there. The PDF never shows
  the note/theme background (verified with a colored-background snippet in light and dark theme).
- **Theme-adaptive ink (`inkColor.ts`, pure + tested).** Stored colors never change. `classifyColor`:
  "ink"; near-black = gray (max−min channel ≤ 40) with max channel ≤ 72; near-white = gray with min
  channel ≥ 215; everything else keeps its color, highlighters always do. On screen `inkColor` returns
  `var(--pl-ink, var(--text-normal))`, `var(--pl-dark-ink, <color>)`, `var(--pl-light-ink, <color>)`;
  styles.css sets `--pl-dark-ink` on `body.theme-dark` and `--pl-light-ink` on `body.theme-light` to
  `var(--text-normal)`, so a theme switch (body class) recolors the editor overlay, Reading view,
  spaces and the toolbar swatches (`cssColor`) live without re-rendering. Paper (`inkColor(…,
  "paper")`, the PDF post-processor) is literal: black-ish/white-ish/"ink" → `#1a1a1a`; `.print`
  also resets the variables (iPad renders the export inside the themed main document). Canvas
  exports (screenshot, clipboard PNG) resolve with `resolvedInkColor` (theme flag + probed text color).
- **Verified** (headless Obsidian, throwaway profile, desktop export through Obsidian's own
  print-to-PDF without dialogs, PDF → PNG): a drawing-only note with a 2900 px space (Letter, 1 cm)
  prints on 4 pages, every cut between rows (none through writing), no row lost or doubled, the
  frame stroke clipped on each page; a sample note with a 1700 px space mid-note prints the text,
  the space across pages 1–3 and the rest of the note after it on page 3; A4 landscape / no margins
  splits at its own page height. Light and dark theme with a colored note background: pure white
  pages, black ink (stored `#000`, `#fff` and "ink" all `#1a1a1a`). Dark editor/Reading view: "ink" and `#000`
  render `rgb(218,218,218)`, `#fff` stays white; switching to light without reopening: `#000` black,
  `#fff` dark; swatches follow.
- **Known limits.** Line-anchored ink (not in a space) that crosses a page end still breaks wherever
  Chromium breaks the block (Stage D behavior). Line ink on blank lines below a split space in the same
  section is placed by the continuous layout (off by the blank space before a forced break). Text color
  in a dark-theme iPad export depends on Obsidian's own print styles (only the background and ink are forced).

## Document-style PDF export (docStyle.ts)
Request: an export that looks like a plain Word document for handing in homework, because the
Obsidian theme (Origami, snippets) is "a little much" on paper. The themed export stays as it was.
- **Entry points.** ⋯ menu (below "Export PDF with / without ink"): the style that is *not* the
  default — **Export PDF (document style)**, or **Export PDF (themed style)** when the default is
  Document (`otherStyle`, `styleExportLabel`). Commands **Export to PDF (document style)** /
  **(themed style)**. Settings (synced): **Default export style** (`defaultExportStyle`, themed |
  document; used by Obsidian's own export and the with/without-ink entries) and **Document style
  font** (`docExportFont`, serif | sans → `DOC_FONT_STACKS`: `"Times New Roman", Times, Georgia,
  serif` / `Calibri, Aptos, Carlito, Arial, sans-serif`).
- **One-shot override.** The Stage H override now carries an `ExportChoice` `{include?, style?}`;
  `take(o, defaults, now)` returns the effective `{include, style}` (unset fields from the toggle /
  default style) and consumes it, so "document style" applies to that export only and ink follows the
  toggle. `PdfExporter.run(choice)`, `takeOptions()`; the host's `printOptions()` replaces
  `printIncludesInk()`.
- **Styling.** The print post-processor (`applyStyle`, synchronously, before anything is measured
  and even when there is no ink) adds `pl-doc-style` to the export's `.print` root and sets
  `--pl-doc-font` inline. Never removed: the root is printed after the post-processors resolve and
  then discarded. styles.css rules start with `:is(#pl-doc-style, .print.pl-doc-style)` — it matches
  by the class but has id specificity, which beats any class-based theme/snippet rule (!important
  against !important). Root: theme variables reset (text, headings, links, tags, code, callouts,
  `--font-text`), black 12 pt / 1.15. Everything inside except MathJax (`mjx-container` and below) and
  our ink/space blocks: black text, document font, inherited size/line height, no backgrounds, shadows,
  borders, filters, `-webkit-text-fill-color` (gradient-text headings) or text transforms. Then:
  headings bold black 18/15/13/12 pt (h5/h6 italic), no theme ::before/::after ornaments; `p` 0 0 8 pt;
  black list markers; native grey checkboxes; links black underlined (no external icon); tags plain;
  `mark` #fff59d; code monospace (`Consolas, "Courier New"`) on #f2f2f2; tables collapsed 1 px black;
  blockquotes and callouts 1 px grey boxes, no icon/fold; `hr` 1 px #a6a6a6; `mjx-container` black at
  100 % (overrides snippets enlarging math).
- **Ink against document-style text.** Ink is laid out after `applyStyle`, so block heights, line
  marks and character rects are those of the document text (same `drawSection` path as the themed
  export; spaces and page slices unchanged). Text rows are usually much shorter than the editor's
  (12 pt × 1.15 = 18.4 px vs e.g. 24–29 px), while ink keeps its drawn size, so the *distance* of a
  stroke from its anchor is scaled (`inkYScale` = container line height / the editor's CM
  `defaultLineHeight` — the note's open editor, else any; 1 when unknown or within 5 %; `scaleInkY`,
  pure + tested): the stroke's vertical center moves to `anchorTop + r × offset`, rigidly. For a
  character anchor only the part of the offset outside the glyph's rect is scaled (the glyph box is
  the font box, about equal in both), so an underline just below a word stays just below it; for a
  line anchor the offset from the line top scales (a mark mid-line stays mid-line). x is not scaled
  (the anchor character is the one nearest the stroke's center). Themed exports use r = 1.
- **Fix found on the way (both styles).** Obsidian's `.markdown-preview-view` reserves a scrollbar
  gutter on screen (`scrollbar-gutter: stable`, 12 px on desktop) that print media doesn't have, so the
  text measured for the export was 12 px narrower than printed: a paragraph that rewrapped put
  character-anchored ink a word off. styles.css drops the gutter/scrollbar under `.print`.
- **Verified** (headless Obsidian 1.15, throwaway profile and vault, a loud test theme with colored
  gradient headings, colored backgrounds, striped purple tables, dark code blocks, pill tags, and a
  snippet enlarging math to 150 %; desktop export through Obsidian's dialog with the save dialog
  stubbed, Letter, PDF → PNG): document style prints plain black text in Liberation Serif /
  Liberation Sans (the metric-compatible fallbacks on Linux), black headings, plain tables/callouts/
  quote, grey code box, yellow highlight, black math at text size; themed output unchanged. Ink: an
  ellipse over a highlighted phrase, underlines (char-anchored), a circle around inline math and
  a check mark beside a table row (line-anchored), and a drawing space with a graph all land on their
  text/places; the space moves whole to page 2 as before. Default style = Document makes Obsidian's
  own export plain; switching back makes it themed again.
- **Known limits.** Ink is not resized: a large circle around a phrase is relatively bigger next to
  12 pt text and may overlap the rows above/below; ink drawn in the leading between two editor rows
  lands right at the next row in print. A word that barely fits a printed line (sub-pixel) can wrap
  differently on screen and in print, shifting character-anchored ink on the rows after it (seen once
  with the Sans font). Mobile (iPad) document-style export is untested here; it uses the same
  `.print` root and styles.

## Toolbar (M2 Stage A2 floating capsule; A3 orientation/collapse/pencil; E tool popovers; M grip)
One per Markdown leaf, absolutely positioned inside `.workspace-leaf-content` (below the view header),
floating over the note at the **bottom-center** by default. A capsule (border-radius = thickness/2) with a
translucent blurred background (`backdrop-filter: blur(20px) saturate(170%)` over a `color-mix` of
`--background-primary`, opaque fallback without backdrop-filter; theme variables, darker shadow in dark
theme) and circular buttons (36 px; ≥ 40 px on mobile):
`grip · Undo/Redo · Pen, Eraser, Highlighter, Lasso · options area · ⋯` (no collapse button since Stage M).
Pen options → presets Thin / Dashed / Thick (circular line samples) + color strip (ink, #FF0000,
#03468F, #F59A23, #93419C, #007355, #F65353; circular swatches, 4 visible, rest by scroll with snap);
Highlighter → normal/wide + neon colors (#39FF14, #FFF01F, #BC13FE, #1F51FF); Eraser, Lasso → a caption
with the current mode (tapping it opens the tool's popover).
- **Fixed size (A3):** the options area is `--pl-opt-len` (3 presets + 4 swatches) for every tool, so
  switching tools never resizes the bar; it only shrinks (strip scrolls) when the leaf is too small.
- **Orientation (A3, Apple Markup):** horizontal when docked nearest the top/bottom edge of the leaf,
  vertical (`data-orient="vertical"`, column layout, strip scrolls vertically) nearest the left/right
  edge. While dragging, `nearestEdge` (pointer position, 24 px hysteresis) switches it live and the bar
  is re-positioned so the grip stays under the pointer. Edge + position are stored per device.
- **Drag** by the grip (pen, finger or mouse; pointer capture). Position is stored **per device** as
  fractions of the free range inside the leaf (`floating.ts`, pure + tested), re-clamped on leaf/bar
  resize (ResizeObserver). **Gesture isolation (A3):** the grip cancels + stops its touchstart, and from
  the grip press until the drag ends every touch event is cancelled and stopped in the *document capture
  phase*, so Obsidian mobile's swipe gestures (sidebars, pull-down) don't see it. `touch-action: none`
  on the bar (the strip keeps `pan-x`/`pan-y`). Gestures elsewhere are untouched.
- **Grip gestures (Stage M, `grip.ts GripPress`, pure + tested):** one grip press is exactly one of
  *drag* (moved ≥ 6 px first → moves the bar, as above), *long-press* (touch or pen held 500 ms without
  moving → snap menu; the rest of the press is inert: no drag, no toggle) or *tap* (released before
  either → collapse/expand; with the snap menu open a tap only closes it). Mouse: left click = tap,
  right-click (`contextmenu`, default prevented) = snap menu; the mouse never long-presses. The drag
  guards (touch events cancelled in the document capture phase) run for every grip press, so a
  long-press never reaches Obsidian's gestures; the grip has `-webkit-touch-callout/user-select: none`.
- **Snap menu (Stage M):** a popover anchored at the grip, "Move toolbar to": Top center, Bottom
  center, Left middle, Right middle, Top left, Top right, Bottom left, Bottom right
  (`floating.ts SNAP_PRESETS/snapPreset`, tested). It stores `toolbarPos` + `toolbarEdge` (per device):
  top/bottom → horizontal, left/right → vertical, corners → their top/bottom edge (horizontal), which
  is what `nearestEdge` picks at a corner point (ties go to bottom/top). Bottom center = `null` (the
  default position). The current preset is checked (`currentSnapPreset`). The ⋯ "Move toolbar to
  bottom center" entry stays.
- **Collapse (A3, Stage M):** collapsed = grip + undo/redo + tool buttons (no options, no ⋯); toggled
  by tapping the grip. Tapping the active tool opens its popover; for **pen** and **highlighter** the
  popover then also *hosts the bar's options area* (presets / widths + color swatches) right under its
  title — the same live `.pl-options` element moved into the popover (`is-hosted`: column layout, all
  colors wrapped in rows, no scrolling strip) and moved back when the popover closes, so swatch
  rendering is shared and nothing is lost by collapsing. The highlighter's segmented Width row is
  omitted while hosted (the width buttons are right above). Eraser/lasso show only a caption inline,
  whose information the popover already contains. Expanded popovers are unchanged (no duplication).
  Collapsed state is per device.
- **Tool popovers (Stage E):** the first tap on a tool selects it; a tap on the **active** tool opens
  (or closes) its settings popover (`settings.ts toolTap`; replaces A2's "re-tap the eraser → previous
  tool"). Popovers (and ⋯) open toward the side of the leaf with more room — above/below a horizontal
  bar, left/right of a vertical one (`popoverSide`) — centered on their button and clamped inside the
  leaf (`placePopover`); max-height = leaf, scrolls. Contents (segmented controls + switches):
  - Eraser: Whole stroke / Precise; size S/M/L (precise); Erase highlighter only; switch-to-eraser by
    Pencil double-tap (on/off) and by scribbling (on/off).
  - Pen: feel Ballpoint / Apple Notes; smoothing Off/Light/Medium/Strong; Snap to shape on/off + hold
    0.3 / 0.5 / 0.8 / 1.2 s (any 200–1500 ms value in the settings tab).
  - Highlighter: Straight line on/off (`highlight.ts straightLine`: start → pen, snapped to horizontal
    within 6°, densified at 3 px, no smoothing); width Normal/Wide. *Snap to text* is stored
    (`highlighterSnapText`, default on) but **not shown** until Stage C implements it.
  - Lasso: selects Both / Pen / Highlighter.
- **Pencil taps (A3):** every toolbar, popover and lasso-menu button activates through `tap.ts onTap`:
  pen presses fire on `pointerup` (same element, < 12 px movement) because WKWebView doesn't give the
  Pencil a reliable `click` (the bar floats over the contenteditable editor, where Scribble / WebKit's
  stylus handling claims stylus touches); stylus touchstarts on our UI are cancelled
  (`blockStylusTouch`). Touch and mouse keep using `click`; a click right after a pen activation is
  swallowed (no double fire).
- Hidden in Reading view (CSS on `[data-mode="preview"]`). Never steals editor focus: every press
  `preventDefault`s pointerdown/mousedown; touchmove on the bar (except the color strip) is cancelled so
  the note beneath never scrolls.

Settings (`settings.ts`, pure + tested) are split:
- **Synced** (`data.json`): tool, pen preset/color, highlighter color/width, pen feel, pen widths, ink visible,
  snap to shape (on) + hold delay (500 ms, 200–1500), double-tap toggles eraser (off), scribble to erase
  (off), highlighter snaps to text (`highlighterSnapText`, on; Stage C — toggle in the highlighter popover),
  default export style (`defaultExportStyle`, themed) and document style font (`docExportFont`, serif),
  `settingsVersion` (2). Migration to v2 (once, then saved): `doubleTapEraser` → false and a hold
  delay of exactly 450 ms (the old default) → 500 ms.
- **Per device** (`app.saveLocalStorage("ink-pages:device")`, fallback `window.localStorage`):
  toolbar visible (default **shown** everywhere since Stage F — the slim Select bar on desktop; before it the
  desktop default was hidden), toolbar position (null = bottom-center),
  docked edge (bottom) and collapsed state, mouse draws (desktop only), and the Stage E tool options:
  eraser mode (stroke) / size (M) / highlighter only (off), straight highlighter (off), highlighter snap
  to text (on, no effect yet), lasso filter (both), include ink in PDF export (on, Stage D), Stage F select mode (`rect` | `lasso`, rect) and
  `localVersion` (2). Migration to local v2 (Stage F, desktop only, persisted once on load): a stored
  `toolbarVisible: false` without `localVersion` is dropped → shown. Every local save wrote all keys, so
  that `false` was almost always the old hidden-on-desktop default, not a choice — and it hid the old
  drawing toolbar, not the slim one. Hiding it again afterwards sticks; mobile values are untouched.
  Synced also holds **smoothing** (medium). Stage A's
  `dotted` preset / width are migrated to `dashed` on load.
  M1's `toolbarVisible`/`mouseDraws`/`penSize`/`highlighterSize` keys are removed from `data.json` on load.
Ribbon icon + command toggle the toolbar. Commands: undo/redo ink, select pen/highlighter/eraser/lasso,
toggle eraser (no default hotkey), add drawing space below cursor line (Stage K), show/hide ink, toggle mouse draws (desktop), toggle select tool
(desktop, Stage F; no default hotkey), export to PDF with / without ink (Stage D; one-shot since Stage H), export to PDF (document style / themed style).

## Stage F — ink selection on the Mac (desktop Select tool)
The Mac is for reading; Stage F lets it rearrange existing ink (select, move, resize, delete,
duplicate, recolor, copy/cut/paste, screenshot) without drawing or erasing. Nothing changes on the iPad
(the Select tool is desktop-only: `Platform.isMobile` never gets the slim bar).
- **Slim toolbar:** on desktop with "Mouse draws" **off**, the floating bar is `is-slim`:
  `grip · Undo/Redo · Select · Show/Hide ink · ⋯` (pen/eraser/highlighter/lasso and the
  options area are `.pl-full-only`, hidden). Same fixed size (no options area at all), drag,
  orientation, grip tap / snap menu, collapse (collapsed = undo/redo + Select) and popovers as the full bar. With
  "Mouse draws" on, the full drawing toolbar appears instead (and Select switches off). Shown by default.
- **Select is a session toggle** (`main.ts deskSelecting`, not persisted — after a restart the mouse
  is normal until Select is picked). First tap turns it on; a tap on the active Select opens its
  popover (Stage E pattern): **Rectangle / Freeform**, selects Both / Pen / Highlighter (the Stage E
  lasso filter, shared), a shortcut hint and **"Done — back to the text cursor"**. Turning it off
  deselects. Escape with nothing selected also leaves Select (the key still reaches Obsidian).
- **Stage H — Select never traps the user.** A **click on empty space** (press + release < 4 px, no
  stroke under the pointer, not on the selection/handle/menu) deselects, turns Select off and puts
  the text cursor there: `posAtCoords` of the press → `dispatch({selection})`, leaf made active,
  editor focused, so typing works at once (`inkView exitSelectToText`). Decisions are pure in
  `select.ts` (`deskPress`: handle → scale, selection → move, stroke → select it, empty → region,
  right-click on empty + ink clipboard → Paste, else pass; `deskRegionRelease`: < CLICK_MOVE →
  exit-to-text, else region; tested). A click on a stroke still selects it, a drag on empty space
  still selects by rectangle/freeform, right-click Paste is unchanged. Select also switches off
  (dropping its selection) when "Mouse draws" is toggled, when ink is hidden, and when a leaf opens
  another note (`main.ts shownFiles`, TFile identity — a rename is not a switch; activating another
  pane is not either). Esc: first deselects, second leaves Select. **Visible state:** Select on =
  solid accent button + accent ring around the bar (`.is-selecting`), and its tooltip says "click
  empty space in the note to type again".
- **Mouse (inkView `onDeskSelectDown`, only while Select is active and ink is shown; Stage H changed
  the empty-space click, see above):** every primary
  press is `preventDefault` + `stopPropagation`ed in the scroller's capture phase (no caret move, no
  text selection, no focus change; the follow-up compat mouse events are swallowed as for "Mouse
  draws"), except on the scroller's own scrollbar. Press on the selection → move / handle → scale
  (exactly the lasso drag). Press on a stroke (`select.ts pickTopmost` + `strokeNear`: within 5 px of
  the centerline plus half the width; pens above highlighters, later above earlier; text highlights hit
  their rects) → that stroke is selected and the same press drags it if the mouse moves (desktop
  convention), so a click selects it. Press elsewhere → a dashed **rectangle** (`rectPolygon`, start →
  current corner) or a freeform loop; on release the same code as the lasso runs (`finishLasso`: Stage E
  filter, Stage C text-highlight proxies, `selectInLasso` touch rule — a rectangle crossing only the
  middle of a sparse line selects it) and the context menu appears. A click (< 4 px) on empty space
  leaves Select for the text cursor (Stage H; before: it only deselected); **right-click** on empty space opens the Paste menu when the
  ink clipboard holds strokes (and suppresses Obsidian's text context menu). A press with Select active
  blurs focus held outside this editor (e.g. the search box) so the keyboard reaches the selection.
- **Cursor feedback:** while Select is active the note shows an arrow (`.pl-desk-select`), `pointer`
  over a stroke, `move` inside the selection, `nwse-resize` over the handle (hover hit-test once per frame).
- **Selection, menu, move/scale, Copy/Cut/Duplicate/Delete/Color/Screenshot and undo are the lasso's**
  (unchanged code). One selection at a time: a desktop selection clears the others and makes its leaf
  active (no focus). Edits go through the store, so they save to the sidecar and live-sync to the iPad.
- **Keyboard (`inkKeys.ts`, decision pure in `select.ts routeInkKey`, tested; desktop only — also for a
  lasso selection made with "Mouse draws"; never installed on mobile):** acts only on the
  ACTIVE Markdown leaf's ink view and only when focus is in that editor or nowhere (body) — never in an
  input, a modal or another pane. With an ink selection: **Escape** deselects, **Delete/Backspace**
  delete it, **Mod+C / Mod+X / Mod+D** copy / cut / duplicate it (Mod = Cmd on macOS, Ctrl elsewhere;
  Shift/Alt/the other modifier and IME composition never match). **Mod+V** pastes ink (at the mouse if it
  is over the note, else mid-view) only when Select is active and the ink clipboard is non-empty. Plain
  typing is never taken. Everything else, and every key without a selection, is Obsidian's. Two entry
  points: an Obsidian keymap `Scope` pushed only while a selection exists or Select is active (Obsidian's
  keymap runs first in the window capture phase and would otherwise run hotkeys bound to the same keys —
  Mod+D is "Delete paragraph"); its single catch-all handler returns `false` for our keys and
  `undefined` for the rest, which Obsidian passes on to the parent scope. Plus a window capture-phase
  listener for keys the keymap doesn't see (skips defaultPrevented events).

## Persistence
- Store per open file: in-memory model shared by all views of that file (keyed by path).
- Debounced save (800 ms) after changes; flush on plugin unload and when the view switches files.
- Create parent folders as needed (`adapter.mkdir`). Empty ink → delete sidecar.
- `vault.on("rename")` → move sidecar; `vault.on("delete")` → delete sidecar.
- Undo/redo stacks are per file, in-memory only (Stage K adds a `space` op: drawing spaces added /
  removed / resized together with stroke changes). Ops: `add`, `erase` (eraser drags / scribble erase
  merge into one op via a batch id), `replace` (Stage B: `before`/`after` snapshots of the affected
  strokes with their indices; the new strokes take the z-position of the first removed one; undo =
  remove `after`, restore `before`; redo the inverse). After a live-sync merge, history items that no
  longer apply are pruned item-wise (items an op would remove must be on the canvas; items it would
  restore must not have their id on the canvas).
- **Live sync (M2):** `vault.on("modify"|"create"|"delete")` for `Attachments/Ink/**.json` → if the note
  is loaded, `store.reloadFromDisk(note)` (queued after any in-flight save). Content equal to what we
  last wrote is an echo and ignored. Otherwise a three-way merge by stroke id (`mergeStrokes`, base =
  last saved/loaded content): local deletions since the last save stay deleted, local unsaved additions
  are kept, remote additions/deletions apply; identical strokes keep their local object (live `pos`,
  `textRange`, `charPos`; a text highlight's `text` offsets and a character anchor's `line`/`ch`, like
  the anchor, don't count as content).
  Unsaved local changes are written back (debounced); a clean merge writes nothing. Undo/redo entries
  that no longer apply are dropped. New remote strokes resolve anchors against the current doc.
  Malformed external content (e.g. half-synced) is ignored until the next event.

## Out of scope for M1
Reading view rendering, text-snapping highlighter, export. (Live mirroring via Obsidian Sync was
added in M2 Stage A; lasso/shapes/gestures in Stage B; text-snapping highlighter is Stage C;
Reading view + PDF export is Stage D.)

## Project layout
```
manifest.json  package.json  tsconfig.json  esbuild.config.mjs  styles.css
src/main.ts            plugin entry, settings, commands, toolbar wiring, vault events
src/model.ts           types, hashing, anchor resolve, serialization, merge  (pure, tested)
src/settings.ts        settings defaults/sanitize, palettes, stroke params   (pure, tested)
src/geometry.ts        erase hit-test, stroke → svg path helpers       (pure, tested)
src/shapes.ts          shape recognizer, densify, post-snap adjust      (pure, tested)
src/gestures.ts        double tap, scribble detector + coverage region (pure, tested)
src/lasso.ts           lasso hit-testing (touch rule), move/scale       (pure, tested)
src/clipboard.ts       ink clipboard: copy → clip, paste placement      (pure, tested)
src/menu.ts            context menu placement                           (pure, tested)
src/crop.ts            screenshot stage/crop math, scale, file naming   (pure, tested)
src/textHighlight.ts   Stage C: decision rule, word snap, text anchors, rows (pure, tested)
src/textHighlightView.ts Stage C: posAtCoords/DOM-range measuring, rendering, lasso/eraser glue
src/charAnchor.ts      Stage H: character-anchor rule, offset math, positions, reading lookup (pure, tested)
src/charAnchorView.ts  Stage H: anchoring new strokes, coordsAtPos measuring/caching in the editor
src/inkRender.ts       strokes → 2D canvas (Path2D)
src/screenshot.ts      text rasterization (html-to-image), screenshot modal, PNG save/copy/share
src/store.ts           per-file ink store: load/save/debounce/undo-redo (adapter injected, tested)
src/vaultAdapter.ts    InkAdapter over the Vault API; ensureFolder
src/inkView.ts         CM6 ViewPlugin: overlay, input, rendering
src/toolbar.ts         floating toolbar DOM (capsule, orientation, drag, collapse, tool popovers, snap menu)
src/floating.ts        toolbar placement / clamping / edge+orientation / popover side+placement / snap presets (pure, tested)
src/grip.ts            grip press classification: tap / drag / long-press (pure, tested)
src/erase.ts           precise eraser: split strokes along the eraser path (pure, tested)
src/highlight.ts       straight-line highlighter points                 (pure, tested)
src/tap.ts             pen-safe button activation (pointerup for Pencil, click otherwise; TapGate tested)
src/select.ts          Stage F: rectangle selection, click hit-test, keyboard routing; Stage H: press/click decisions (pure, tested)
src/inkKeys.ts         Stage F: keyboard shortcuts for an ink selection (keymap scope + capture listener)
src/smoothing.ts       One Euro filter, midpoint curves, lift refinement   (pure, tested)
src/readingMap.ts      Stage D: strokes → sections, y-mapping, PDF block alignment, text lookup (pure, tested)
src/readingView.ts     Stage D: Reading view / PDF export post-processor, per-section SVGs
src/exportOnce.ts      Stage H: one-shot PDF export override state (pure, tested)
src/exportPdf.ts       Stage H: one-shot export commands/menu runner (watches Obsidian's export dialog)
src/docStyle.ts        Document-style PDF export: styles, fonts, labels, ink y-scale (pure, tested)
src/spaces.ts          Stage K: drawing spaces — block placement, ink → space, growth/resize, Make drawing space, reading placement (pure, tested)
src/inkCopy.ts         Public API: ink lines of a note, copy ink to a reorganized note (pure, tested)
src/api.ts             Public API (`plugin.api`, type InkPagesApi): Obsidian glue over inkCopy + store
src/inkDrawings.ts     Public API: split ink into drawings (spaces, clustered margin ink) + layout (pure, tested)
src/drawingPng.ts      Public API: render one drawing to a base64 PNG (DOM canvas)
src/spaceView.ts       Stage K: space block widgets (StateField), layout lookup, ⋯ menu + resize handle
src/printSlices.ts     Stage L: page slices for tall spaces in print, cut choice, pagination model (pure, tested)
src/inkColor.ts        Stage L: theme-adaptive ink colors (screen CSS variables / paper / canvas) (pure, tested)
tests/*.test.ts        vitest
```
Build: esbuild → `main.js` (format cjs, externals: obsidian, electron, @codemirror/*, @lezer/*).
Bundled runtime deps: `perfect-freehand`, `html-to-image` (pure DOM, no Node APIs).
`npm run build` (tsc --noEmit + esbuild production), `npm test` (vitest run).

## Windows / Android pens (Surface Pen, Wacom, S Pen)
Pure rules in `penInput.ts` (tests: `tests/penInput.test.ts`), wiring in inkView.ts / main.ts.
- **Pens always draw**, on desktop too, whatever "Mouse draws" says (`pointerType === "pen"`).
  The first pen press on a desktop device sets the per-device `penDevice` setting, so the full
  drawing toolbar shows instead of the slim Select bar (Settings → "Pen on this device").
- **Eraser end** (`button === 5` on pointerdown / `buttons & 32`): erases while held, with the
  current eraser options, whatever tool is selected; it never counts toward a double tap.
- **Barrel button**: no special meaning; the pen keeps drawing with the current tool.
- **No page panning on a pen drag.** Chromium pans on pen drags unless `touch-action` forbids it,
  and `touch-action` can't tell pens from fingers. A hovering pen (pointermove without contact)
  adds `.pl-pen-near` (`touch-action: none`) to the scroller; a finger pointerdown or the pen
  leaving removes it, so fingers keep scrolling. Not on iOS (stylus touches are cancelled there).
- **Windows "press and hold to right-click"**: holding the pen still (hold-to-snap shapes) makes
  Windows send a context menu on lift; the ink layer swallows compat mouse events and
  `contextmenu` during a stroke and for `SUPPRESS_MS` after it.
