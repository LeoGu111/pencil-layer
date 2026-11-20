/**
 * Stage H — ink drawn over typed text stays on that text: the pure part (no DOM / CodeMirror view).
 *
 * A stroke (or a group of strokes moved / pasted together: a "unit") drawn over text records the
 * character nearest the middle of its bounding box (`Stroke.char`, see model.ts `CharAnchor`), and
 * is then placed relative to where that character is laid out — in the editor when lines re-wrap
 * at another pane width, in Reading view and in the PDF export — instead of relative to its line's
 * top. One character is enough: the editor, Reading view and the PDF use the same font, so text
 * around the character keeps its spacing; what changes between layouts is where (which visual row,
 * which x) the character lands. A second character couldn't help when the two characters end up
 * on different rows (the ink can't be bent), and stretching ink between them on one row would only
 * distort it.
 *
 * Decision rule (`CHAR_ANCHOR`, multiples of the line height `lh` unless noted):
 *  - Size: the unit's bbox (of its points) is at most `maxHeight` = 2.5 lh tall — an arrow,
 *    underline, circle or note over one or two lines of text. Taller ink (diagrams, brackets
 *    spanning a paragraph, long connectors) keeps pure line anchoring, so a big drawing never
 *    jumps around with one word.
 *  - Over text: the character found under the bbox center (nearest letter/digit on that line,
 *    within `search` characters) must be within `maxGapX` = 1 lh horizontally and `maxGapY` =
 *    0.75 lh vertically of the center. The center is probed as is and ½ lh above/below (ink drawn
 *    just above a sentence has its center in the gap or the blank line above it); the qualifying
 *    character nearest the center wins. It must be plain text (not inside a widget). Ink in the
 *    margins, past the end of a short line, or in blank "Add space" room keeps line anchoring.
 *  - Joining: a small stroke whose bbox (padded by `joinPad` = 0.5 lh) touches a character-anchored
 *    stroke finished less than `joinMs` ago follows the SAME character (an arrow head drawn after
 *    its shaft, the letters of a word written over text) — so it moves rigidly with it.
 *  - Groups (lasso move/scale, duplicate, paste): the rule runs once on the group's bbox; if it
 *    qualifies every stroke follows the group's character, otherwise none does.
 *  - Precise-eraser pieces (and a recolored stroke) inherit their stroke's character.
 */
import type { BBox } from "./geometry";
import type { CharAnchor } from "./model";
import type { DocLike } from "./textHighlight";
import { countOccurrences, normalizeWithMap, stripInline } from "./readingMap";

export type XY = [number, number];

export const CHAR_ANCHOR = {
	/** A unit taller than this (line heights) is never character-anchored. */
	maxHeight: 2.5,
	/** The bbox center must be within this distance (line heights) of the character, horizontally… */
	maxGapX: 1,
	/** …and vertically. */
	maxGapY: 0.75,
	/** Characters searched on either side of the hit position for a letter/digit. */
	search: 24,
	/** Joining: a stroke touching a character-anchored stroke finished less than this ago (ms)… */
	joinMs: 2500,
	/** …with its bbox padded by this (line heights). */
	joinPad: 0.5,
} as const;

/** A letter or digit: characters that render as themselves (never Markdown markup). */
export function isWordChar(c: string | undefined): boolean {
	return c !== undefined && /[\p{L}\p{N}]/u.test(c);
}

/** Size rule: may a unit with this bbox (points, stroke width ignored) be character-anchored? */
export function charSized(box: BBox, lh: number): boolean {
	return Number.isFinite(box.minY) && box.maxY - box.minY <= CHAR_ANCHOR.maxHeight * lh;
}

/** Reference point of a unit: its bbox center. */
export function refPoint(box: BBox): XY {
	return [(box.minX + box.maxX) / 2, (box.minY + box.maxY) / 2];
}

/**
 * The anchor character of a line for a hit at boundary offset `at` (from `posAtCoords`): the
 * nearest letter/digit, starting with the character on the side of the hit point (`before`: the
 * point lies left of the boundary, i.e. over character `at - 1`). Null when there is none within
 * `max` characters (whitespace / markup only).
 */
export function pickChar(text: string, at: number, before: boolean, max: number = CHAR_ANCHOR.search): number | null {
	// Outward from the hit: the character on the point's side first, then alternating.
	const a = before ? at - 1 : at;
	const b = before ? at : at - 1;
	const dir = a > b ? 1 : -1;
	for (let d = 0; d <= max; d++) {
		for (const i of [a + dir * d, b - dir * d]) {
			if (i >= 0 && i < text.length && isWordChar(text[i])) return i;
		}
	}
	return null;
}

/**
 * Over-text rule: is `ref` close enough to the character whose rect has top-left `char` (x, y)
 * and height `h` (its width is taken as up to one line height)?
 */
export function nearChar(ref: readonly number[], char: readonly number[], h: number, lh: number): boolean {
	const gx = Math.max(0, char[0] - ref[0], ref[0] - (char[0] + lh));
	const gy = Math.max(0, char[1] - ref[1], ref[1] - (char[1] + h));
	return gx <= CHAR_ANCHOR.maxGapX * lh && gy <= CHAR_ANCHOR.maxGapY * lh;
}

/** Joining rule: does `box` touch `other` (padded by `joinPad` line heights)? */
export function touches(box: BBox, other: BBox, lh: number): boolean {
	const p = CHAR_ANCHOR.joinPad * lh;
	return box.minX <= other.maxX + p && box.maxX >= other.minX - p && box.minY <= other.maxY + p && box.maxY >= other.minY - p;
}

const r1 = (v: number): number => Math.round(v * 10) / 10 + 0;

/** Offset stored for a stroke whose points' origin is at `origin` while its character's rect top-left is at `char`. */
export function charOffset(origin: readonly number[], char: readonly number[]): { dx: number; dy: number } {
	return { dx: r1(origin[0] - char[0]), dy: r1(origin[1] - char[1]) };
}

/** Where a stroke's points' origin goes when its character's rect top-left is at `char`. */
export function charOrigin(char: readonly number[], off: Pick<CharAnchor, "dx" | "dy">): XY {
	return [char[0] + off.dx, char[1] + off.dy];
}

// ---------------------------------------------------------------------------------------------
// Document positions
// ---------------------------------------------------------------------------------------------

/** Persisted (line-relative) form of a live character position. */
export function charAnchorAt(doc: DocLike, charPos: number, off: Pick<CharAnchor, "dx" | "dy">): CharAnchor {
	const line = doc.lineAt(Math.min(Math.max(charPos, 0), doc.length));
	return { line: line.number - 1, ch: charPos - line.from, dx: off.dx, dy: off.dy };
}

/**
 * Document position of a character anchor whose stroke's line anchor resolved to 0-based `line`
 * (the saved anchor line was `anchorLine`): the character's line keeps its distance to the anchor
 * line; the offset is clamped into the line (onto its last character if past the end).
 */
export function resolveCharPos(doc: DocLike, line: number, anchorLine: number, c: Pick<CharAnchor, "line" | "ch">): number {
	const n = Math.min(Math.max(line + c.line - anchorLine, 0), doc.lines - 1);
	const l = doc.line(n + 1);
	const len = l.to - l.from;
	return l.from + Math.max(0, Math.min(c.ch, len - 1));
}

// ---------------------------------------------------------------------------------------------
// Reading view / PDF: the character in the rendered text
// ---------------------------------------------------------------------------------------------

/**
 * How to find character `ch` of source line `line` in a section's rendered text (the section
 * starts at source line `lineStart`), with the Stage C source→display matching: the word around
 * the character (a run of letters/digits, displayed as is) is the needle; it is the `k`-th
 * occurrence in the section's normalized display text (k = occurrences in the display text of the
 * source before it); the character is `offset` characters into it. Null if the character isn't a
 * letter/digit or lies outside the section.
 */
export function charNeedle(lines: readonly string[], lineStart: number, line: number, ch: number): { needle: string; k: number; offset: number } | null {
	if (line < lineStart || line >= lines.length) return null;
	const src = lines[line];
	if (!isWordChar(src[ch])) return null;
	let a = ch;
	while (a > 0 && isWordChar(src[a - 1])) a--;
	let b = ch + 1;
	while (b < src.length && isWordChar(src[b])) b++;
	const needle = src.slice(a, b);
	let prefix = "";
	for (let l = lineStart; l < line; l++) prefix += stripInline(lines[l], true) + " ";
	prefix += stripInline(src.slice(0, a), true);
	const k = countOccurrences(normalizeWithMap(prefix).text, needle);
	return { needle, k, offset: ch - a };
}
