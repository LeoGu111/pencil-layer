/**
 * Stage K — protected drawing spaces: pure rules (tested in tests/spaces.test.ts).
 *
 * A space is a block of empty room `height` px tall that sits right after a source line (a CM6
 * block widget in the editor, an in-flow block in Reading view / the PDF). Ink drawn in it is
 * stored relative to the space's top (`Stroke.space`), so the drawing is one rigid piece: text
 * edits around it move the whole space, never one stroke against another, and text never flows
 * under it.
 *
 * ## Where a space goes (`blockEnds`, `displayLine`)
 * A space anchored after line L is shown after the LAST line of the Markdown block holding L
 * (a paragraph's soft-wrapped lines, a fenced code block, a `$$` block, a table, a quote/callout,
 * the frontmatter; a list item with its continuation lines; headings, rules and blank lines are
 * one-line blocks). The PDF prints a block as one piece, so a space can only follow a whole block
 * — and the editor shows it exactly there too, so editor and PDF agree. Spaces at "end" follow the
 * note's last line, after the line-anchored spaces there.
 *
 * ## Which ink belongs to a space (`spaceAt`, `groupSpace`)
 * A drawn stroke belongs to the space its first point lies in. A group (lasso move/scale,
 * paste, duplicate) belongs to the space containing the centre of its bounding box (so a moved
 * drawing never splits between a space and the text around it). Ink below the end of the note
 * (and below every space there) goes into the last "end" space, grown to hold it, or a new one.
 *
 * ## Sizes (`grownHeight`, `resizedHeight`)
 * Drawing within `GROW_ZONE` px of a space's bottom grows it to `GROW_ROOM` px below the ink (like
 * GoodNotes extending its canvas), live while drawing. The resize handle sets any height, but never
 * less than `spaceMinHeight` of its ink. A space never shrinks on its own.
 */
import { InkSpace, LineSource, SPACE_INK_PAD, SPACE_MIN_HEIGHT, resolveAnchor, spaceMinHeight } from "./model";
import { PRINT_PAGE_CLEARANCE, printAreaHeight } from "./readingMap";

/** Printable height of one portrait A4 page at 100% with default margins, in editor pixels. */
export const A4_SPACE_HEIGHT = Math.floor(printAreaHeight({ pageSize: "A4" }) - PRINT_PAGE_CLEARANCE);

export function spaceSize(height: number, a4: boolean): Pick<InkSpace, "height" | "a4"> {
	return a4 ? { height: A4_SPACE_HEIGHT, a4: true } : { height };
}

/** Keep the stroke outline and bottom padding inside a fixed page. */
export function boundSpaceY(y: number, height: number, radius: number): number {
	return Math.max(radius, Math.min(height - SPACE_INK_PAD - radius, y));
}

/** Drawing closer than this to a space's bottom edge (px) grows it. */
export const GROW_ZONE = 40;
/** Room kept below the ink when a space grows (px). */
export const GROW_ROOM = 80;
/** "Add space": this fraction of the visible editor height, within [ADD_MIN, ADD_MAX]. */
export const ADD_FRACTION = 1 / 3;
export const ADD_MIN = 160;
export const ADD_MAX = 600;

// ---------------------------------------------------------------------------------------------
// Blocks
// ---------------------------------------------------------------------------------------------

const LIST_ITEM = /^\s*(?:[-*+]|\d+[.)])(?:\s|$)/;
const HEADING = /^\s{0,3}#{1,6}(?:\s|$)/;
const FENCE = /^\s*(```+|~~~+)/;
const HR = /^\s{0,3}(?:(?:-\s*){3,}|(?:\*\s*){3,}|(?:_\s*){3,})$/;
const QUOTE = /^\s*>/;
const TABLE = /^\s*\|/;
const blank = (s: string): boolean => s.trim() === "";

function count(src: LineSource): number {
	return Array.isArray(src) ? src.length : (src as { count: number }).count;
}
function at(src: LineSource, i: number): string {
	return Array.isArray(src) ? (src as readonly string[])[i] : (src as { get(i: number): string }).get(i);
}

/** Does line `t` start a block of its own (so it can't continue a paragraph or list item)? */
function startsBlock(t: string): boolean {
	return HEADING.test(t) || FENCE.test(t) || QUOTE.test(t) || TABLE.test(t) || HR.test(t) || LIST_ITEM.test(t) || t.trim().startsWith("$$");
}

/**
 * For every source line: the last line of the Markdown block holding it (see the module docs).
 * O(lines). An unclosed fence / `$$` block runs to the end of the note.
 */
export function blockEnds(src: LineSource): Int32Array {
	const n = count(src);
	const end = new Int32Array(n);
	const fill = (from: number, to: number) => {
		for (let k = from; k <= to; k++) end[k] = to;
	};
	let i = 0;
	if (n > 0 && at(src, 0).trim() === "---") {
		let j = 1;
		while (j < n && !/^(---|\.\.\.)$/.test(at(src, j).trim())) j++;
		if (j < n) {
			fill(0, j);
			i = j + 1;
		}
	}
	while (i < n) {
		const t = at(src, i);
		const tr = t.trim();
		let j = i;
		if (blank(t)) {
			end[i] = i;
			i++;
			continue;
		}
		const f = FENCE.exec(t);
		if (f) {
			const mark = f[1];
			j = i + 1;
			while (j < n && !at(src, j).trim().startsWith(mark)) j++;
			j = Math.min(j, n - 1);
		} else if (tr.startsWith("$$") && !(tr.length > 2 && tr.endsWith("$$"))) {
			j = i + 1;
			while (j < n && !at(src, j).trim().endsWith("$$")) j++;
			j = Math.min(j, n - 1);
		} else if (HEADING.test(t) || HR.test(t) || tr.startsWith("$$")) {
			j = i;
		} else if (QUOTE.test(t)) {
			while (j + 1 < n && QUOTE.test(at(src, j + 1))) j++;
		} else if (TABLE.test(t)) {
			while (j + 1 < n && TABLE.test(at(src, j + 1))) j++;
		} else {
			// A paragraph, or a list item with its continuation lines (not the next item).
			while (j + 1 < n) {
				const nx = at(src, j + 1);
				if (blank(nx) || startsBlock(nx)) break;
				j++;
			}
		}
		fill(i, j);
		i = j + 1;
	}
	return end;
}

/** The line a space anchored after `line` is shown after (null = "end" → the last line). */
export function displayLine(ends: ArrayLike<number>, line: number | null): number {
	const n = ends.length;
	if (n === 0) return 0;
	if (line === null) return n - 1;
	const l = Math.min(Math.max(0, Math.floor(line)), n - 1);
	return ends[l];
}

/** A space placed: its display line, in document order (spaces after one line keep list order; "end" last). */
export interface SpaceSlot {
	id: string;
	/** Line it is shown after. */
	line: number;
	/** Anchored at the note's end. */
	end: boolean;
	height: number;
}

/**
 * Display lines of every space, sorted by line; at one line, line-anchored spaces first (in list
 * order), then "end" spaces (list order). Anchors are resolved with `resolveAnchor` (hash search,
 * else clamped) unless `lineOf` gives the live line.
 */
export function spaceSlots(src: LineSource, spaces: readonly InkSpace[], ends?: ArrayLike<number>, lineOf?: (s: InkSpace) => number | undefined): SpaceSlot[] {
	const e = ends ?? blockEnds(src);
	const out = spaces.map((sp, i) => {
		const isEnd = sp.after === "end";
		const anchored = isEnd ? null : (lineOf?.(sp) ?? resolveAnchor(src, sp.after as { line: number; hash: string }));
		return { slot: { id: sp.id, line: displayLine(e, anchored), end: isEnd, height: sp.height }, i };
	});
	out.sort((a, b) => a.slot.line - b.slot.line || Number(a.slot.end) - Number(b.slot.end) || a.i - b.i);
	return out.map((o) => o.slot);
}

// ---------------------------------------------------------------------------------------------
// Ink → space
// ---------------------------------------------------------------------------------------------

/** A space as laid out (overlay / document coordinates). */
export interface SpaceRect {
	id: string;
	top: number;
	height: number;
}

/** The space whose room [top, top + height) contains y, or null. */
export function spaceAt(rects: readonly SpaceRect[], y: number): SpaceRect | null {
	for (const r of rects) if (y >= r.top && y < r.top + r.height) return r;
	return null;
}

/**
 * The space a group of strokes (overlay points) joins: the one containing the centre of the
 * group's bounding box, or null.
 */
export function groupSpace(rects: readonly SpaceRect[], strokes: readonly (readonly (readonly number[])[])[]): SpaceRect | null {
	let minY = Infinity;
	let maxY = -Infinity;
	for (const pts of strokes) {
		for (const p of pts) {
			if (p[1] < minY) minY = p[1];
			if (p[1] > maxY) maxY = p[1];
		}
	}
	if (!Number.isFinite(minY)) return null;
	return spaceAt(rects, (minY + maxY) / 2);
}

/**
 * Height after ink reaching `inkBottom` px below the space top was drawn / moved into it: drawing
 * within GROW_ZONE of the bottom (or past it) grows the space to GROW_ROOM below the ink; it never
 * shrinks and always holds its ink.
 */
export function grownHeight(height: number, inkBottom: number): number {
	if (!Number.isFinite(inkBottom)) return height;
	let h = Math.max(height, spaceMinHeight(inkBottom));
	if (inkBottom > height - GROW_ZONE) h = Math.max(h, Math.ceil(inkBottom + GROW_ROOM));
	return h;
}

/** Resize handle: the requested height, but never less than the space's ink needs (whole px). */
export function resizedHeight(requested: number, inkBottom: number): number {
	const min = Number.isFinite(inkBottom) ? spaceMinHeight(inkBottom) : SPACE_MIN_HEIGHT;
	return Math.max(min, Math.round(Number.isFinite(requested) ? requested : min));
}

/** "Add space": default height for an editor `visible` px tall. */
export function defaultSpaceHeight(visible: number): number {
	const v = Number.isFinite(visible) && visible > 0 ? visible : 900;
	return Math.round(Math.min(ADD_MAX, Math.max(ADD_MIN, v * ADD_FRACTION)));
}

/**
 * Ink drawn below the end of the note (below every space there): the "end" space to put it in —
 * the last space shown after the last line, if it is an "end" space (`extend`) — and the height
 * it then needs, or a new "end" space starting at `docBottom`. `inkTop`/`inkBottom` are document y.
 */
export function endSpacePlan(
	last: { id: string; top: number; height: number; end: boolean; a4?: true } | null,
	docBottom: number,
	inkBottom: number,
	a4 = false,
): { extend: string | null; top: number; height: number } {
	const top = last ? last.top + last.height : docBottom;
	if (a4) return { extend: null, top, height: A4_SPACE_HEIGHT };
	if (last?.a4) return { extend: null, top, height: grownHeight(SPACE_MIN_HEIGHT, inkBottom - top) };
	if (last && last.end) return { extend: last.id, top: last.top, height: grownHeight(last.height, inkBottom - last.top) };
	return { extend: null, top: docBottom, height: grownHeight(SPACE_MIN_HEIGHT, inkBottom - docBottom) };
}

// ---------------------------------------------------------------------------------------------
// "Make drawing space" (lasso action)
// ---------------------------------------------------------------------------------------------

/** One source line as laid out in the editor (document y; `bottom` includes widgets after it). */
export interface LaidLine {
	top: number;
	bottom: number;
	blank: boolean;
	/** A space may follow this line (it is the last line of its block). */
	end: boolean;
	/** Ink that is NOT being converted is anchored to it (it must not be deleted). */
	pinned: boolean;
}

export interface MakeSpacePlan {
	/** 0-based line the space follows. */
	after: number;
	/** Blank lines to delete (inclusive, 0-based), or null. */
	del: [number, number] | null;
	/** Document y of the space's top (= bottom of `after`, unchanged by the deletion below it). */
	top: number;
	/** Space height: the ink's bottom − top + padding. */
	height: number;
}

/** Ink may start this far above a line's bottom and still count as below it (px). */
export const MAKE_SLACK = 6;

/**
 * Turn ink spanning [inkTop, inkBottom] (document y) into a space without moving it: the space
 * follows the last block-ending line whose bottom is at or above the ink's top (+ MAKE_SLACK), so
 * the ink keeps its place exactly (points become relative to that line's bottom). Blank lines right
 * below it that the ink covers are deleted (the space replaces them), except: lines that other ink
 * is anchored to, and — when text follows — the last blank line if the line above the space is text
 * (deleting it would merge the two blocks into one paragraph). Ink above the first line: the space
 * follows the first block-ending line (the ink then reaches above it).
 */
export function planMakeSpace(lines: readonly LaidLine[], inkTop: number, inkBottom: number): MakeSpacePlan | null {
	const n = lines.length;
	if (n === 0) return null;
	let after = -1;
	for (let l = 0; l < n; l++) if (lines[l].end && lines[l].bottom <= inkTop + MAKE_SLACK) after = l;
	if (after < 0) {
		after = lines.findIndex((x) => x.end);
		if (after < 0) after = n - 1;
	}
	const top = lines[after].bottom;
	const first = after + 1;
	let last = after;
	for (let l = first; l < n; l++) {
		const x = lines[l];
		if (!x.blank || x.pinned || x.top >= inkBottom) break;
		last = l;
	}
	if (last >= first && last + 1 < n && !lines[last + 1].blank && !lines[after].blank) last--; // keep one blank line
	const del: [number, number] | null = last >= first ? [first, last] : null;
	return { after, del, top, height: spaceMinHeight(inkBottom - top) };
}

// ---------------------------------------------------------------------------------------------
// Reading view / PDF placement
// ---------------------------------------------------------------------------------------------

/**
 * Where a space shown after line `line` goes in a rendered section spanning [lineStart, lineEnd]
 * (owning lines up to `ownedTo`): "end" = an in-flow block appended after the section's content,
 * whose top must be at the section mapping's y of line `line + 1` (blank lines after the block
 * count one line height each, like line-anchored ink); `item` = inside list item `index` (the space
 * follows an item in the middle of a list). Null if the section doesn't own the line.
 */
export function readingPlacement(line: number, lineStart: number, lineEnd: number, ownedFrom: number, ownedTo: number, itemLines: readonly number[] | null, itemEnds?: ArrayLike<number>): { kind: "end" } | { kind: "item"; index: number } | null {
	if (line < ownedFrom || line > ownedTo) return null;
	if (line >= lineStart && line < lineEnd && itemLines && itemLines.length > 0) {
		// The item whose block ends at `line`.
		for (let i = itemLines.length - 1; i >= 0; i--) {
			if (itemLines[i] <= line) {
				const itemEnd = itemEnds ? itemEnds[itemLines[i]] : line;
				if (itemEnd === line) return { kind: "item", index: i };
				break;
			}
		}
	}
	return { kind: "end" };
}

/**
 * Section-relative y shift for line-anchored ink on line `line` caused by spaces appended at the
 * section's end (they push the blank lines after the section's content down). `slots` = this
 * section's appended spaces (display line + height).
 */
export function shiftBelowSpaces(line: number, slots: readonly { line: number; height: number }[]): number {
	let s = 0;
	for (const x of slots) if (x.line < line) s += x.height;
	return s;
}


// ---------------------------------------------------------------------------------------------
// Typing below a space; moving a space (Copy/Cut → Paste)
// ---------------------------------------------------------------------------------------------

/**
 * Text to insert after line `text` so the cursor lands BELOW a space shown after it and the new
 * text stays below: a blank line first unless the line is already blank (a line typed straight
 * after a paragraph line would join its block, and the space would jump below the new text).
 */
export function openBelowInsert(text: string): string {
	return blank(text) ? "\n" : "\n\n";
}

/**
 * Enter at the end of this line should open a fresh block below its spaces (`openBelowInsert`):
 * a plain paragraph line. Lists, quotes/callouts, tables, headings, fences and `$$` lines keep the
 * editor's own Enter (list/quote continuation stays in the block, which is right; the others are
 * blocks of their own, so the space doesn't move anyway).
 */
export function enterOpensBelow(text: string): boolean {
	return !blank(text) && !startsBlock(text);
}

/**
 * What a Copy/Cut of a space writes to the system clipboard as text. Pasting exactly this text into
 * a note (while the plugin's space clip is set) pastes the drawing space instead; pasted anywhere
 * else it is a readable label.
 */
export const SPACE_CLIP_TEXT = "[Pencil Layer drawing]";

export function isSpaceClipText(text: string | null | undefined): boolean {
	return !!text && text.trim() === SPACE_CLIP_TEXT;
}

/**
 * Is a space shown at `at` (end of the line `lineFrom..at` it follows) inside the text selection
 * [from, to]? Like an inline image: when the selection crosses it, or covers that whole line.
 */
export function spaceInRange(at: number, lineFrom: number, from: number, to: number): boolean {
	if (from >= to) return false;
	return from <= at && to >= at && (to > at || from <= lineFrom);
}

/** Clipboard text equality, ignoring line-ending style and trailing whitespace. */
export function sameClipText(a: string | null | undefined, b: string | null | undefined): boolean {
	if (a == null || b == null) return false;
	const n = (s: string) => s.replace(/\r\n?/g, "\n").trimEnd();
	return n(a) === n(b);
}

// ---------------------------------------------------------------------------------------------
// Blank lines next to a drawing space (2026-11-19): a drawing that started on blank lines just
// above a space joins it; a stroke started on blank lines just below a space grows it.
// ---------------------------------------------------------------------------------------------

/**
 * The blank lines directly above a space shown after line `line` (0-based; `line` itself
 * included): `first..line`, and the text line `after` before them (a block end, so a space may
 * follow it). Null if `line` is not blank, the run starts the note, or `after` isn't a block end.
 */
export function blankRunAbove(blank: (l: number) => boolean, ends: ArrayLike<number>, line: number): { after: number; first: number } | null {
	if (line < 0 || line >= ends.length || !blank(line)) return null;
	let first = line;
	while (first > 0 && blank(first - 1)) first--;
	const after = first - 1;
	if (after < 0 || ends[after] !== after) return null;
	return { after, first };
}

/**
 * The blank lines directly below a space shown after line `line` (0-based) in a note of `n`
 * lines: `first..last`; `toEnd` = they run to the note's end. Null if the next line isn't blank.
 */
export function blankRunBelow(blank: (l: number) => boolean, n: number, line: number): { first: number; last: number; toEnd: boolean } | null {
	const first = line + 1;
	if (line < 0 || first >= n || !blank(first)) return null;
	let last = first;
	while (last + 1 < n && blank(last + 1)) last++;
	return { first, last, toEnd: last === n - 1 };
}
