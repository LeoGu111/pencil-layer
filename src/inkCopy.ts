/**
 * Public API support (see main.ts `api` / api.ts): which lines of a note have ink, and copying a
 * note's ink into another note whose text is a reorganized version of it. Pure: no Obsidian / DOM
 * imports (tested in tests/inkCopy.test.ts).
 *
 * Model of the copy: every piece of ink hangs off ONE source line — a line-anchored stroke its
 * resolved anchor line (`resolveAnchor`, as the editor does), a drawing space the line it is SHOWN
 * after (`blockEnds` / `displayLine`; "end" → the last line), a stroke in a space its space. The
 * caller maps those lines to destination lines (`lineMap`); each piece keeps its position relative
 * to its line / space top (points are copied unchanged). Unmapped (or out-of-range) pieces go to
 * the end of the destination.
 */
import { isWordChar } from "./charAnchor";
import { Anchor, CharAnchor, InkFile, InkSpace, INK_VERSION, Point, Stroke, TextAnchor, hashLine, newId, resolveAnchor } from "./model";
import { blockEnds, displayLine } from "./spaces";

/** A note's text as lines, split like CodeMirror (`\r\n`, `\r` or `\n`). Never empty. */
export function splitLines(text: string): string[] {
	return text.split(/\r\n?|\n/);
}

const nonEmpty = (lines: readonly string[]): readonly string[] => (lines.length > 0 ? lines : [""]);

/** Display line (0-based) of every space of `ink` in a note with `lines`, by space id. */
function spaceLines(ink: InkFile, lines: readonly string[]): Map<string, number> {
	const out = new Map<string, number>();
	const spaces = ink.spaces ?? [];
	if (spaces.length === 0) return out;
	const ends = blockEnds(lines);
	for (const sp of spaces) out.set(sp.id, displayLine(ends, sp.after === "end" ? null : resolveAnchor(lines, sp.after)));
	return out;
}

/**
 * 0-based lines of the note's text that ink is attached to, sorted, unique: the resolved anchor
 * line of every line-anchored stroke (a stroke whose space doesn't exist counts as line-anchored)
 * and the display line of every drawing space ("end" → the last line). Empty if there is no ink.
 */
export function inkLinesOf(ink: InkFile, text: readonly string[]): number[] {
	const lines = nonEmpty(text);
	const spaces = spaceLines(ink, lines);
	const set = new Set<number>(spaces.values());
	for (const s of ink.strokes) {
		if (s.space !== undefined && spaces.has(s.space)) continue;
		set.add(resolveAnchor(lines, s.anchor));
	}
	return [...set].sort((a, b) => a - b);
}

export interface InkCopyResult {
	/** The destination's new ink (fresh ids, anchors against the destination text, no transient fields). */
	ink: InkFile;
	strokes: number;
	spaces: number;
	/** Strokes and spaces that went to the end of the destination (line not in `lineMap`, or out of range). */
	unplaced: number;
}

/**
 * Occurrence of `needle` in `hay` to use: the `k`-th one if it exists, else the one nearest to
 * `near`. Only occurrences starting at index ≤ `maxStart`; with `whole`, only ones not touching a
 * letter/digit on either side. Null if none.
 */
function pickOccurrence(hay: string, needle: string, k: number, near: number, maxStart: number, whole: boolean): number | null {
	if (!needle) return null;
	const found: number[] = [];
	for (let i = hay.indexOf(needle); i >= 0 && i <= maxStart; i = hay.indexOf(needle, i + 1)) {
		if (whole && (isWordChar(hay[i - 1]) || isWordChar(hay[i + needle.length]))) continue;
		found.push(i);
	}
	if (found.length === 0) return null;
	if (k < found.length) return found[k];
	let best = found[0];
	for (const i of found) if (Math.abs(i - near) < Math.abs(best - near)) best = i;
	return best;
}

/** Number of (whole-word with `whole`) occurrences of `needle` in `hay` starting before `before`. */
function countBefore(hay: string, needle: string, before: number, whole: boolean): number {
	let n = 0;
	for (let i = hay.indexOf(needle); i >= 0 && i < before; i = hay.indexOf(needle, i + 1)) {
		if (whole && (isWordChar(hay[i - 1]) || isWordChar(hay[i + needle.length]))) continue;
		n++;
	}
	return n;
}

const clamp = (v: number, lo: number, hi: number): number => Math.min(Math.max(v, lo), hi);

/**
 * Stage C: re-find a text highlight's text on the destination. The source range is resolved as
 * `resolveTextRange` does (start on the resolved anchor line `srcLine`, end line relative to it,
 * offsets clamped); its text must be found starting on destination line `dstLine` (a multi-line
 * range must match across the following lines exactly). Null → drop `text` (freehand fallback).
 */
export function refindText(srcLines: readonly string[], srcLine: number, anchorLine: number, text: TextAnchor, dstLines: readonly string[], dstLine: number): TextAnchor | null {
	const n = srcLines.length;
	const a = clamp(srcLine, 0, n - 1);
	const b = clamp(Math.max(srcLine, srcLine + text.endLine - anchorLine), 0, n - 1);
	const from = clamp(text.ch, 0, srcLines[a].length);
	let to = clamp(text.endCh, 0, srcLines[b].length);
	if (a === b) to = Math.max(from, to);
	const needle = a === b ? srcLines[a].slice(from, to) : [srcLines[a].slice(from), ...srcLines.slice(a + 1, b), srcLines[b].slice(0, to)].join("\n");
	const line = dstLines[dstLine];
	// An empty range (its text was deleted) renders nothing; keep it empty.
	if (needle === "") return { ch: Math.min(from, line.length), endLine: dstLine, endCh: Math.min(from, line.length) };
	const rows = needle.split("\n").length;
	const hay = dstLines.slice(dstLine, dstLine + rows).join("\n");
	const k = countBefore(srcLines[a], needle.split("\n")[0], from, false);
	const at = pickOccurrence(hay, needle, rows === 1 ? k : 0, from, line.length, false);
	if (at === null) return null;
	if (rows === 1) return { ch: at, endLine: dstLine, endCh: at + needle.length };
	const last = needle.slice(needle.lastIndexOf("\n") + 1);
	return { ch: at, endLine: dstLine + rows - 1, endCh: last.length };
}

/**
 * Stage H: re-find a character anchor's character on destination line `dstCharLine`. The source
 * character is resolved as `resolveCharPos` does (its line relative to the resolved anchor line,
 * `ch` clamped onto the line's last character). A letter/digit is found by the word around it
 * (whole word, its k-th occurrence like Reading view's `charNeedle`, else the nearest), anything
 * else by the character itself. Null → drop `char` (plain line anchoring).
 */
export function refindChar(srcLines: readonly string[], srcCharLine: number, char: CharAnchor, dstLines: readonly string[], dstCharLine: number): CharAnchor | null {
	const text = srcLines[srcCharLine] ?? "";
	if (text.length === 0 || dstCharLine < 0 || dstCharLine >= dstLines.length) return null;
	const ch = clamp(char.ch, 0, text.length - 1);
	let a = ch;
	let b = ch + 1;
	const word = isWordChar(text[ch]);
	if (word) {
		while (a > 0 && isWordChar(text[a - 1])) a--;
		while (b < text.length && isWordChar(text[b])) b++;
	}
	const needle = text.slice(a, b);
	const k = countBefore(text, needle, a, word);
	const hay = dstLines[dstCharLine];
	const at = pickOccurrence(hay, needle, k, a, hay.length, word);
	if (at === null) return null;
	return { line: dstCharLine, ch: at + (ch - a), dx: char.dx, dy: char.dy };
}

/**
 * Copy all ink of a source note (`src`, text `srcText`) for a destination note with text `dstText`.
 * `lineMap`: source line (as returned by `inkLinesOf`) → destination line. See the module docs and
 * `InkPagesApi.copyInk`. `makeId` is injectable for tests. The source ink is not modified.
 */
export function copyInkData(
	src: InkFile,
	srcText: readonly string[],
	dstText: readonly string[],
	lineMap: ReadonlyMap<number, number>,
	makeId: () => string = newId,
): InkCopyResult {
	const srcLines = nonEmpty(srcText);
	const dstLines = nonEmpty(dstText);
	const last = dstLines.length - 1;
	const mapLine = (line: number): number | null => {
		const v = lineMap.get(line);
		return typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= last ? v : null;
	};
	const anchorAt = (line: number): Anchor => ({ line, hash: hashLine(dstLines[line]) });
	const dstEnds = blockEnds(dstLines);
	let unplaced = 0;

	// Spaces: by the line they are shown after.
	const srcSpaceLines = spaceLines(src, srcLines);
	const spaceMap = new Map<string, { id: string; line: number; unplaced: boolean }>();
	const spaces: InkSpace[] = [];
	for (const sp of src.spaces ?? []) {
		const m = mapLine(srcSpaceLines.get(sp.id)!);
		const id = makeId();
		let after: InkSpace["after"];
		if (m === null) {
			after = "end";
			unplaced++;
		} else if (sp.after === "end" && dstEnds[m] === last) {
			after = "end"; // still the note's end: keep it there (after the line-anchored spaces)
		} else {
			after = anchorAt(m);
		}
		spaces.push({ id, after, height: sp.height, ...(sp.a4 ? { a4: true } : {}) });
		spaceMap.set(sp.id, { id, line: after === "end" ? last : m!, unplaced: m === null });
	}

	const strokes: Stroke[] = [];
	for (const s of src.strokes) {
		const out: Stroke = {
			id: makeId(),
			tool: s.tool,
			color: s.color,
			size: s.size,
			...(s.style !== undefined ? { style: s.style } : {}),
			anchor: { line: 0, hash: "" },
			points: s.points.map((p): Point => [p[0], p[1], p[2]]),
			...(s.shape !== undefined ? { shape: s.shape } : {}),
		};
		const sp = s.space !== undefined ? spaceMap.get(s.space) : undefined;
		if (sp) {
			// Ink in a space: rigid with its space (no text / character anchors there).
			out.space = sp.id;
			out.anchor = anchorAt(sp.line);
			if (sp.unplaced) unplaced++;
			strokes.push(out);
			continue;
		}
		const srcLine = resolveAnchor(srcLines, s.anchor);
		let m = mapLine(srcLine);
		if (m === null) {
			m = last;
			unplaced++;
		}
		out.anchor = anchorAt(m);
		if (s.text && s.tool === "highlighter") {
			const text = refindText(srcLines, srcLine, s.anchor.line, s.text, dstLines, m);
			if (text) out.text = text;
		} else if (s.char) {
			const srcCharLine = clamp(srcLine + s.char.line - s.anchor.line, 0, srcLines.length - 1);
			const delta = srcCharLine - srcLine;
			const dstCharLine = delta === 0 ? m : (mapLine(srcCharLine) ?? m + delta);
			const char = refindChar(srcLines, srcCharLine, s.char, dstLines, dstCharLine);
			if (char) out.char = char;
		}
		strokes.push(out);
	}

	return {
		ink: { version: INK_VERSION, contentWidth: src.contentWidth, strokes, spaces },
		strokes: strokes.length,
		spaces: spaces.length,
		unplaced,
	};
}
