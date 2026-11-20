/**
 * Stage D — pure mapping logic for ink in Reading view and PDF export (tested).
 *
 * The editor stores every stroke relative to the TOP of its anchor line (and x relative to the
 * content's left edge). Reading view lays the same Markdown out differently: blocks ("sections",
 * one per paragraph / list / heading / table / code block …) have their own heights and margins,
 * and blank lines between blocks collapse. So each section draws the ink of the lines it OWNS, in
 * an SVG of its own, at a y computed from the section's rendered layout:
 *
 * - `ownedRange`: a section owns its own lines plus the blank lines after it (up to the next
 *   section). The first section also owns everything above it. Ink anchored on a blank line drawn
 *   in "Add space" room therefore stays with the block above it.
 * - `lineTop`: the y (relative to the section's top) of a line's top. Lines inside the section
 *   come from measured marks (list items, table rows, `<br>`-separated paragraph lines …),
 *   interpolated proportionally between marks (the section's top is the mark of its first line,
 *   its bottom the mark of `lineEnd + 1`). Lines below the section continue at one line height
 *   per (blank) line, lines above it at one line height per line upwards.
 * - `reserveSpace`: blank lines collapse in Reading view, so ink drawn in blank lines would cover
 *   the next block. The section reserves room (a bottom margin, which collapses with the normal
 *   gap between blocks) for ink in its own trailing blank lines — at most as much as those blank
 *   lines take in the editor.
 * - PDF export renders the whole note in one container without section info: `alignBlocks`
 *   matches the rendered top-level blocks to the note's sections (metadata cache) by kind.
 * - Text highlights (Stage C) are located in the rendered text: `stripInline` turns the
 *   highlighted Markdown into display text, `normalizeWithMap` / `findNth` find it.
 */

/** A measured line position inside a section: `y` = top of source line `line`, relative to the section top. */
export interface LineMark {
	line: number;
	y: number;
}

export interface LineRange {
	from: number;
	to: number;
}

export const isBlank = (s: string | undefined): boolean => s === undefined || s.trim() === "";

/**
 * Lines a section owns (inclusive, 0-based): its own lines, the blank lines after it, and — for
 * the first section (`isFirst`, or when every line above is blank) — every line above it.
 * `nextStart` = first line of the next section when known (PDF export), else the run of blank
 * lines after `lineEnd` decides.
 */
export function ownedRange(lines: readonly string[], lineStart: number, lineEnd: number, opts: { nextStart?: number; isFirst?: boolean } = {}): LineRange {
	let from = lineStart;
	let first = opts.isFirst ?? false;
	if (!first) {
		first = true;
		for (let i = 0; i < lineStart && i < lines.length; i++) {
			if (!isBlank(lines[i])) {
				first = false;
				break;
			}
		}
	}
	if (first) from = 0;
	let to = lineEnd;
	if (opts.nextStart !== undefined) {
		to = Math.max(lineEnd, opts.nextStart - 1);
	} else {
		while (to + 1 < lines.length && isBlank(lines[to + 1])) to++;
	}
	// Ink anchored past the end of the document is clamped onto the last line by resolveAnchor.
	return { from, to: Math.max(to, lineEnd) };
}

/**
 * y of the top of source line `line`, relative to the section's top. `marks` are measured line tops
 * inside the section (any order; lines outside [lineStart, lineEnd] are ignored); `height` is the
 * section's rendered content height; `lineHeight` the height of one blank line below/above it.
 */
export function lineTop(line: number, marks: readonly LineMark[], lineStart: number, lineEnd: number, height: number, lineHeight: number): number {
	if (line < lineStart) return (line - lineStart) * lineHeight;
	if (line > lineEnd) return height + (line - lineEnd - 1) * lineHeight;
	const pts = new Map<number, number>();
	pts.set(lineStart, 0);
	for (const m of marks) {
		if (m.line > lineStart && m.line <= lineEnd && Number.isFinite(m.y)) pts.set(m.line, Math.min(Math.max(m.y, 0), height));
	}
	pts.set(lineEnd + 1, height);
	const sorted = [...pts.entries()].sort((a, b) => a[0] - b[0]);
	// Keep marks monotonic (a mis-measured mark must not fold the section back on itself).
	for (let i = 1; i < sorted.length; i++) if (sorted[i][1] < sorted[i - 1][1]) sorted[i][1] = sorted[i - 1][1];
	for (let i = 0; i + 1 < sorted.length; i++) {
		const [la, ya] = sorted[i];
		const [lb, yb] = sorted[i + 1];
		if (line >= la && line < lb) return ya + ((yb - ya) * (line - la)) / (lb - la);
	}
	return height;
}

/**
 * Gap (px) a section needs below its content so that ink in its trailing blank lines doesn't cover
 * the next block; applied as the section's bottom margin, so it collapses with the normal gap
 * between blocks (a gap smaller than the paragraph margin changes nothing). `inkBottom` = lowest
 * ink y (section coordinates) of strokes anchored inside the owned range; `trailingBlank` = number
 * of owned blank lines after `lineEnd`. Ink below those blank lines (it overlapped the next text in
 * the editor too) reserves nothing. `pad` = clearance between ink and the next block. 0 = none.
 *
 * `atEnd` (Stage I): the section owns the last line of the note. Below it the editor has no next
 * text, only the drawing room past the end of the document, so ALL of its ink gets room — with or
 * without blank lines, uncapped. (Before Stage I a drawing below the end of the note got at most
 * its blank lines' height; the rest overflowed the print container, was clipped by the print
 * layout's `body { overflow: auto }` and never paginated — the user's export ended mid-drawing.)
 * The caller applies it as PADDING, not a margin: a margin adjoining a page break is truncated.
 */
export function reserveSpace(inkBottom: number, height: number, trailingBlank: number, lineHeight: number, opts: { pad?: number; atEnd?: boolean } = {}): number {
	const pad = opts.pad ?? 4;
	if (!Number.isFinite(inkBottom)) return 0;
	if (!opts.atEnd && trailingBlank <= 0) return 0;
	const limit = opts.atEnd ? Infinity : height + trailingBlank * lineHeight;
	const need = Math.min(inkBottom, limit) - height;
	return need > 0.5 ? Math.ceil(need + pad) : 0;
}

// ---------------------------------------------------------------------------------------------
// Source line structure (to match measured elements)
// ---------------------------------------------------------------------------------------------

const LIST_ITEM = /^\s*(?:>\s*)*(?:[-*+]|\d+[.)])(?:\s|$)/;
const TABLE_SEP = /^\s*\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)*\|?\s*$/;

/** Source lines (0-based) in [start, end] that begin a list item, in order (one `<li>` each). */
export function listItemLines(lines: readonly string[], start: number, end: number): number[] {
	const out: number[] = [];
	for (let i = start; i <= end && i < lines.length; i++) if (LIST_ITEM.test(lines[i])) out.push(i);
	return out;
}

/** Source lines in [start, end] that are table rows (not the `|---|` separator), in order (one `<tr>` each). */
export function tableRowLines(lines: readonly string[], start: number, end: number): number[] {
	const out: number[] = [];
	for (let i = start; i <= end && i < lines.length; i++) if (!isBlank(lines[i]) && !TABLE_SEP.test(lines[i])) out.push(i);
	return out;
}

// ---------------------------------------------------------------------------------------------
// PDF export: rendered blocks ↔ sections
// ---------------------------------------------------------------------------------------------

export type BlockKind =
	| "heading"
	| "paragraph"
	| "list"
	| "code"
	| "blockquote"
	| "callout"
	| "table"
	| "hr"
	| "math"
	| "html"
	| "yaml"
	| "footnotes"
	| "comment"
	| "title"
	| "other";

/** Obsidian metadata-cache section type → kind. */
export function sectionKind(type: string): BlockKind {
	switch (type) {
		case "heading":
		case "paragraph":
		case "list":
		case "code":
		case "blockquote":
		case "callout":
		case "table":
		case "math":
		case "html":
		case "yaml":
		case "comment":
			return type;
		case "thematicBreak":
			return "hr";
		case "footnoteDefinition":
			return "footnotes";
		default:
			return "other";
	}
}

/** Kind of a rendered block from its (first) element's tag name and classes. */
export function elementKind(tag: string, classes: readonly string[]): BlockKind {
	const t = tag.toUpperCase();
	const has = (c: string) => classes.includes(c);
	if (has("frontmatter") || has("mod-frontmatter")) return "yaml";
	if (has("callout")) return "callout";
	if (has("footnotes")) return "footnotes";
	if (has("math") || has("math-block")) return "math";
	if (has("table-wrapper")) return "table";
	if (/^H[1-6]$/.test(t)) return "heading";
	switch (t) {
		case "P":
			return "paragraph";
		case "UL":
		case "OL":
			return "list";
		case "PRE":
			return "code";
		case "BLOCKQUOTE":
			return "blockquote";
		case "TABLE":
			return "table";
		case "HR":
			return "hr";
		case "SECTION":
			return "footnotes";
		default:
			return "other";
	}
}

function matchScore(s: BlockKind, e: BlockKind): number {
	if (s === "comment" || e === "title") return 0;
	if (s === e) return 3;
	if (s === "html" || e === "other") return 1;
	if ((s === "math" && e === "paragraph") || (s === "paragraph" && e === "math")) return 1;
	if ((s === "callout" && e === "blockquote") || (s === "blockquote" && e === "callout")) return 2;
	return 0;
}

/**
 * Match rendered blocks to sections, both in document order (an LCS by kind: sections may render
 * nothing — comments, link definitions — and some blocks have no section — the export's title).
 * Returns for every element the index of its section, or -1.
 */
export function alignBlocks(sections: readonly BlockKind[], elements: readonly BlockKind[]): number[] {
	const n = sections.length;
	const m = elements.length;
	// dp[i][j] = best score matching sections[i..] with elements[j..].
	const dp: Float64Array[] = [];
	for (let i = 0; i <= n; i++) dp.push(new Float64Array(m + 1));
	for (let i = n - 1; i >= 0; i--) {
		for (let j = m - 1; j >= 0; j--) {
			const sc = matchScore(sections[i], elements[j]);
			let best = Math.max(dp[i + 1][j], dp[i][j + 1]);
			if (sc > 0) best = Math.max(best, sc + dp[i + 1][j + 1]);
			dp[i][j] = best;
		}
	}
	const out = new Array<number>(m).fill(-1);
	let i = 0;
	let j = 0;
	while (i < n && j < m) {
		const sc = matchScore(sections[i], elements[j]);
		if (sc > 0 && dp[i][j] === sc + dp[i + 1][j + 1]) {
			out[j] = i;
			i++;
			j++;
		} else if (dp[i][j] === dp[i + 1][j]) {
			i++;
		} else {
			j++;
		}
	}
	return out;
}

/** Page sizes of Obsidian's PDF export (inches, portrait). */
const PAGE_INCHES: Record<string, [number, number]> = {
	A3: [11.69, 16.54],
	A4: [8.27, 11.69],
	A5: [5.83, 8.27],
	Legal: [8.5, 14],
	Letter: [8.5, 11],
	Tabloid: [11, 17],
};
/** Electron's default printToPDF margin (1 cm) in CSS px. */
const DEFAULT_MARGIN_PX = (96 / 2.54) * 1;

/**
 * CSS width (px) of the printable area of Obsidian's PDF export, from its saved export settings
 * (`vault.getConfig("pdfExportSettings")`: pageSize, landscape, margin "0" default / "1" none /
 * "2" minimal, downscalePercent). The export lays the note out in a hidden 1-px-wide window, so the
 * ink must be measured at this width to match the printed layout.
 */
export function printAreaWidth(cfg: unknown): number {
	const p = pageSpec(cfg);
	return (p.width - 2 * p.margin) / p.downscale;
}

/**
 * [Stage L] CSS height (layout px) of one printed page's printable area, inferred like
 * `printAreaWidth` (page size, orientation, margins, downscale).
 */
export function printAreaHeight(cfg: unknown): number {
	const p = pageSpec(cfg);
	return (p.height - 2 * p.margin) / p.downscale;
}

/** [Stage I] The exported page: full size and margin (CSS px at 96 dpi), downscale factor, file-name title. */
export interface PageSpec {
	width: number;
	height: number;
	/** Margin on every side (Electron's default 1 cm, or 0 for "none"/"minimal"). */
	margin: number;
	/** downscalePercent / 100, clamped to [0.1, 2]. */
	downscale: number;
	/** The export prints the note's name as a title above the content. */
	includeName: boolean;
}

/** [Stage I] Page geometry from Obsidian's saved PDF export settings (fallback Letter, portrait, 1 cm). */
export function pageSpec(cfg: unknown): PageSpec {
	const c = (cfg && typeof cfg === "object" ? cfg : {}) as Record<string, unknown>;
	const size = PAGE_INCHES[typeof c.pageSize === "string" ? c.pageSize : ""] ?? PAGE_INCHES.Letter;
	const landscape = c.landscape === true;
	const pct = typeof c.downscalePercent === "number" && Number.isFinite(c.downscalePercent) ? c.downscalePercent : 100;
	return {
		width: (landscape ? size[1] : size[0]) * 96,
		height: (landscape ? size[0] : size[1]) * 96,
		margin: c.margin === "1" || c.margin === "2" ? 0 : DEFAULT_MARGIN_PX,
		downscale: Math.min(Math.max(pct / 100, 0.1), 2),
		includeName: c.includeName !== false,
	};
}

// ---------------------------------------------------------------------------------------------
// Text highlights: source range → rendered text
// ---------------------------------------------------------------------------------------------

/**
 * Display text of inline Markdown (approximate): links/wikilinks → their text, embeds and
 * comments dropped, emphasis/highlight/strike/code markers removed, leading block markers
 * (heading, quote, list, task) removed when `lineStart`.
 */
export function stripInline(s: string, lineStart = false): string {
	let t = s;
	if (lineStart) t = t.replace(/^\s*(?:>\s*)*(?:#{1,6}\s+|(?:[-*+]|\d+[.)])\s+(?:\[.\]\s+)?)?/, "");
	t = t
		.replace(/%%.*?%%/g, "")
		.replace(/!\[\[[^\]]*\]\]/g, "")
		.replace(/!\[[^\]]*\]\([^)]*\)/g, "")
		.replace(/\[\[([^\]|]*)\|([^\]]*)\]\]/g, "$2")
		.replace(/\[\[([^\]]*)\]\]/g, "$1")
		.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
		.replace(/(\*+|==|~~|`+)/g, "")
		.replace(/(^|[^\p{L}\p{N}])_+|_+(?=[^\p{L}\p{N}]|$)/gu, "$1");
	return t;
}

/** Collapse whitespace runs to one space; `map[i]` = index in `s` of normalized char i. */
export function normalizeWithMap(s: string): { text: string; map: number[] } {
	let text = "";
	const map: number[] = [];
	let space = false;
	for (let i = 0; i < s.length; i++) {
		const c = s[i];
		if (/\s/.test(c)) {
			if (space || text.length === 0) continue;
			space = true;
			text += " ";
			map.push(i);
		} else {
			space = false;
			text += c;
			map.push(i);
		}
	}
	return { text, map };
}

export const normalizeWs = (s: string): string => normalizeWithMap(s).text.trim();

/** Number of (non-overlapping) occurrences of `needle` in `hay`. */
export function countOccurrences(hay: string, needle: string): number {
	if (!needle) return 0;
	let n = 0;
	for (let i = hay.indexOf(needle); i >= 0; i = hay.indexOf(needle, i + needle.length)) n++;
	return n;
}

/** Index of the k-th (0-based) occurrence of `needle` in `hay`; the last one if there are fewer; -1 if none. */
export function findNth(hay: string, needle: string, k: number): number {
	if (!needle) return -1;
	let last = -1;
	let n = 0;
	for (let i = hay.indexOf(needle); i >= 0; i = hay.indexOf(needle, i + needle.length)) {
		if (n === k) return i;
		last = i;
		n++;
	}
	return last;
}

/**
 * Per source line, the [startCh, endCh) pieces of a text highlight starting at (line, ch) and
 * ending at (endLine, endCh), clamped to the lines. Empty pieces are dropped.
 */
export function rangePieces(lines: readonly string[], line: number, ch: number, endLine: number, endCh: number): { line: number; from: number; to: number }[] {
	const out: { line: number; from: number; to: number }[] = [];
	const last = Math.min(endLine, lines.length - 1);
	for (let l = Math.max(0, line); l <= last; l++) {
		const len = lines[l].length;
		const from = l === line ? Math.min(Math.max(ch, 0), len) : 0;
		const to = l === endLine ? Math.min(Math.max(endCh, 0), len) : len;
		if (to > from) out.push({ line: l, from, to });
	}
	return out;
}
