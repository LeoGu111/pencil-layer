/**
 * Stage C — highlighter snaps to typed text: the pure part (no DOM / CodeMirror view).
 *
 *  - `classifyHighlight`: is a finished (or in-progress) highlighter stroke a text-highlight
 *    gesture? (mostly horizontal over ONE visual line, or a top-to-bottom sweep over several)
 *  - `snapRange`: snap a document range to word boundaries.
 *  - `textAnchorOf` / `resolveTextRange`: the persisted, line-relative anchor of a range.
 *  - `mergeRows`, `rowsPath`, `rowsHitSegment`, …: the per-visual-line rectangles a highlight is
 *    drawn as (measured by textHighlightView.ts from DOM ranges), as an SVG path, hit tests, and
 *    their conversion to freehand strokes / lasso sample points.
 *
 * Coordinates are overlay space (x from content left, y from document top) unless noted.
 */
import { hashLine } from "./model";
import type { Anchor, Point, TextAnchor, TextRange } from "./model";
import type { BBox } from "./geometry";
import { fmt } from "./smoothing";

/** The subset of CodeMirror's `Text` used here (1-based lines, like CM). */
export interface DocLike {
	readonly length: number;
	readonly lines: number;
	line(n: number): { from: number; to: number; text: string; number: number };
	lineAt(pos: number): { from: number; to: number; text: string; number: number };
	sliceString(from: number, to?: number): string;
}

/** Tunables of the decision rule (multiples of the line height unless noted). */
export const TEXT_SNAP = {
	/** Minimum horizontal extent of a stroke (px). */
	minWidth: 8,
	/** A single-line highlight's vertical extent fits within this many line heights. */
	maxSingleHeight: 1.5,
	/**
	 * Start and end closer than this vertically ⇒ one line. Multi-line: the stroke must start/end
	 * within this distance of its top/bottom.
	 */
	edgeSlack: 0.75,
	/** Multi-line: the stroke may never go back up by more than this (from its lowest point so far). */
	maxRetreat: 0.5,
	/** Single line: at least this fraction of the stroke's width must lie over the measured text. */
	minCoverage: 0.5,
} as const;

export type HighlightKind = "line" | "lines";

/**
 * Decision rule. `lineHeight` is the height of a visual text line under the stroke.
 *  - "line": the vertical extent fits within ~1.5 line heights, start and end are at about the
 *    same height (< 0.75 line heights apart) and the stroke is at least as wide as it is tall
 *    (mostly horizontal). Scrubbing back and forth over a line counts.
 *  - "lines": a top-to-bottom sweep over consecutive lines: starts near its top, ends near its
 *    bottom (≥ 0.75 line heights lower), never goes back up by more than half a line (noise
 *    tolerant: measured from the lowest point so far), and moves horizontally at least as much as
 *    vertically (so a vertical margin line, a circle or a zigzag stays freehand).
 *  - null: anything else (stays a freehand highlighter stroke).
 * Whether there is actually text under the stroke is checked by the caller against the measured
 * rows (`coverage`).
 */
export function classifyHighlight(points: readonly (readonly number[])[], lineHeight: number): HighlightKind | null {
	const n = points.length;
	if (n < 2 || !(lineHeight > 0)) return null;
	let minX = Infinity;
	let maxX = -Infinity;
	let minY = Infinity;
	let maxY = -Infinity;
	let travelX = 0;
	let retreat = 0;
	for (let i = 0; i < n; i++) {
		const [x, y] = points[i];
		minX = Math.min(minX, x);
		maxX = Math.max(maxX, x);
		minY = Math.min(minY, y);
		maxY = Math.max(maxY, y);
		retreat = Math.max(retreat, maxY - y);
		if (i > 0) travelX += Math.abs(x - points[i - 1][0]);
	}
	const w = maxX - minX;
	const h = maxY - minY;
	if (w < TEXT_SNAP.minWidth) return null;
	const first = points[0];
	const last = points[n - 1];
	const slack = TEXT_SNAP.edgeSlack * lineHeight;
	if (Math.abs(last[1] - first[1]) < slack) {
		return h <= TEXT_SNAP.maxSingleHeight * lineHeight && w >= h ? "line" : null;
	}
	if (first[1] - minY > slack || maxY - last[1] > slack) return null;
	if (retreat > TEXT_SNAP.maxRetreat * lineHeight) return null;
	if (travelX < h) return null;
	return "lines";
}

// ---------------------------------------------------------------------------------------------
// Word snapping
// ---------------------------------------------------------------------------------------------

const WORD = /[\p{L}\p{N}_]/u;
/** Characters trimmed off both ends of a snapped range: whitespace and Markdown markup. */
const TRIM = /[\s#*_~=>`|+-]/u;

function isWordAt(text: string, i: number): boolean {
	if (i < 0 || i >= text.length) return false;
	const c = text[i];
	if (WORD.test(c)) return true;
	// Apostrophes inside a word (don't, l’été).
	return (c === "'" || c === "’") && i > 0 && WORD.test(text[i - 1]) && i + 1 < text.length && WORD.test(text[i + 1]);
}

/** The word around line offset `i` ([start, end) in the line), or null if `i` touches no word. */
function wordAround(text: string, i: number): [number, number] | null {
	let k = isWordAt(text, i) ? i : isWordAt(text, i - 1) ? i - 1 : -1;
	if (k < 0) return null;
	let s = k;
	while (isWordAt(text, s - 1)) s--;
	let e = k + 1;
	while (isWordAt(text, e)) e++;
	return [s, e];
}

/** Snap one end: a position inside a word goes to that word's nearer boundary (ties include the word). */
function snapEdge(doc: DocLike, pos: number, side: "start" | "end"): number {
	const line = doc.lineAt(pos);
	const i = pos - line.from;
	if (!(isWordAt(line.text, i - 1) && isWordAt(line.text, i))) return pos;
	const w = wordAround(line.text, i)!;
	const toStart = i - w[0];
	const toEnd = w[1] - i;
	const useStart = side === "start" ? toStart <= toEnd : toStart < toEnd;
	return line.from + (useStart ? w[0] : w[1]);
}

/** Trim whitespace/markup off both ends of [from, to). */
function trim(doc: DocLike, from: number, to: number): [number, number] {
	const s = doc.sliceString(from, to);
	let a = 0;
	let b = s.length;
	while (a < b && TRIM.test(s[a])) a++;
	while (b > a && TRIM.test(s[b - 1])) b--;
	return [from + a, from + b];
}

/**
 * Snap a document range to word boundaries: each end inside a word moves to the nearer edge of
 * that word (so a stroke ending a third into a word stops before it, two thirds in includes it),
 * then whitespace and Markdown markup are trimmed off both ends. If that leaves nothing (a short
 * stroke within one word), the word under the middle of the range is used. Null when there is
 * no word at all (blank space, markup only).
 */
export function snapRange(doc: DocLike, from: number, to: number): TextRange | null {
	if (to < from) [from, to] = [to, from];
	from = Math.max(0, Math.min(from, doc.length));
	to = Math.max(0, Math.min(to, doc.length));
	let [a, b] = trim(doc, snapEdge(doc, from, "start"), snapEdge(doc, to, "end"));
	if (a < b) return { from: a, to: b };
	// The character in the middle of the range must be part of a word.
	const mid = Math.floor((from + Math.max(from, to - 1)) / 2);
	const line = doc.lineAt(mid);
	if (!isWordAt(line.text, mid - line.from)) return null;
	const w = wordAround(line.text, mid - line.from);
	if (!w) return null;
	[a, b] = [line.from + w[0], line.from + w[1]];
	return a < b ? { from: a, to: b } : null;
}

// ---------------------------------------------------------------------------------------------
// Anchors
// ---------------------------------------------------------------------------------------------

/** Persisted anchor of a range: the line of `from` + offsets (see `TextAnchor`). */
export function textAnchorOf(doc: DocLike, range: TextRange): { anchor: Anchor; text: TextAnchor; lineFrom: number } {
	const a = doc.lineAt(Math.max(0, Math.min(range.from, doc.length)));
	const b = doc.lineAt(Math.max(0, Math.min(Math.max(range.to, range.from), doc.length)));
	return {
		anchor: { line: a.number - 1, hash: hashLine(a.text) },
		text: { ch: range.from - a.from, endLine: b.number - 1, endCh: range.to - b.from },
		lineFrom: a.from,
	};
}

/**
 * Document range of a text anchor whose anchor line resolved to 0-based `line` (the saved anchor
 * line was `anchorLine`): the end line keeps its distance to the start line; offsets are clamped
 * into their lines. May be empty (from === to) when the text no longer exists.
 */
export function resolveTextRange(doc: DocLike, line: number, anchorLine: number, text: TextAnchor): TextRange {
	const clampLine = (i: number) => Math.min(Math.max(i, 0), doc.lines - 1);
	const start = doc.line(clampLine(line) + 1);
	const end = doc.line(clampLine(Math.max(line, line + text.endLine - anchorLine)) + 1);
	const from = start.from + Math.min(Math.max(text.ch, 0), start.text.length);
	const to = end.from + Math.min(Math.max(text.endCh, 0), end.text.length);
	return { from, to: Math.max(from, to) };
}

// ---------------------------------------------------------------------------------------------
// Rows (per visual line rectangles)
// ---------------------------------------------------------------------------------------------

/** An axis-aligned rectangle (overlay space). */
export interface Row {
	left: number;
	top: number;
	right: number;
	bottom: number;
}

/** Padding around the measured text rects (px) and corner radius of the drawn rects. */
export const ROW_PAD_X = 1.5;
export const ROW_PAD_Y = 1;
export const ROW_RADIUS = 3;

/**
 * Merge text fragment rects (e.g. `Range.getClientRects()` converted to overlay space) into one
 * rect per visual line: rects that overlap vertically by at least half of the smaller height
 * belong to the same row (their union). Empty/degenerate rects and rects taller than
 * `maxHeight` (images, embeds, block widgets) are ignored. Rows are sorted top to bottom.
 */
export function mergeRows(rects: readonly Row[], maxHeight = Infinity): Row[] {
	const ok = rects
		.filter((r) => r.right - r.left > 0.5 && r.bottom - r.top > 0.5 && r.bottom - r.top <= maxHeight)
		.slice()
		.sort((a, b) => a.top - b.top || a.left - b.left);
	const rows: Row[] = [];
	for (const r of ok) {
		const row = rows.find((q) => {
			const overlap = Math.min(q.bottom, r.bottom) - Math.max(q.top, r.top);
			return overlap >= 0.5 * Math.min(q.bottom - q.top, r.bottom - r.top);
		});
		if (row) {
			row.left = Math.min(row.left, r.left);
			row.right = Math.max(row.right, r.right);
			row.top = Math.min(row.top, r.top);
			row.bottom = Math.max(row.bottom, r.bottom);
		} else {
			rows.push({ ...r });
		}
	}
	return rows.sort((a, b) => a.top - b.top);
}

/** Rows grown by the drawing padding. */
function padded(r: Row): Row {
	return { left: r.left - ROW_PAD_X, top: r.top - ROW_PAD_Y, right: r.right + ROW_PAD_X, bottom: r.bottom + ROW_PAD_Y };
}

/** SVG path of rounded rects, one per row, shifted by `-offsetY` (to be translated by the line top). */
export function rowsPath(rows: readonly Row[], offsetY = 0): string {
	let d = "";
	for (const raw of rows) {
		const r = padded(raw);
		const x = r.left;
		const y = r.top - offsetY;
		const w = r.right - r.left;
		const h = r.bottom - r.top;
		const k = Math.min(ROW_RADIUS, w / 2, h / 2);
		d +=
			`M${fmt(x + k)} ${fmt(y)}H${fmt(x + w - k)}A${fmt(k)} ${fmt(k)} 0 0 1 ${fmt(x + w)} ${fmt(y + k)}` +
			`V${fmt(y + h - k)}A${fmt(k)} ${fmt(k)} 0 0 1 ${fmt(x + w - k)} ${fmt(y + h)}` +
			`H${fmt(x + k)}A${fmt(k)} ${fmt(k)} 0 0 1 ${fmt(x)} ${fmt(y + h - k)}` +
			`V${fmt(y + k)}A${fmt(k)} ${fmt(k)} 0 0 1 ${fmt(x + k)} ${fmt(y)}Z`;
	}
	return d;
}

/** Bounding box of the (padded) rows, or null. */
export function rowsBox(rows: readonly Row[]): BBox | null {
	if (rows.length === 0) return null;
	const b: BBox = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
	for (const raw of rows) {
		const r = padded(raw);
		b.minX = Math.min(b.minX, r.left);
		b.minY = Math.min(b.minY, r.top);
		b.maxX = Math.max(b.maxX, r.right);
		b.maxY = Math.max(b.maxY, r.bottom);
	}
	return b;
}

/** Does segment (x1,y1)-(x2,y2) pass within `radius` of a rect? (Liang–Barsky against the grown rect.) */
function segmentHitsRect(r: Row, x1: number, y1: number, x2: number, y2: number, radius: number): boolean {
	const minX = r.left - radius;
	const maxX = r.right + radius;
	const minY = r.top - radius;
	const maxY = r.bottom + radius;
	const dx = x2 - x1;
	const dy = y2 - y1;
	let t0 = 0;
	let t1 = 1;
	const clip = (p: number, q: number): boolean => {
		if (p === 0) return q >= 0;
		const t = q / p;
		if (p < 0) {
			if (t > t1) return false;
			if (t > t0) t0 = t;
		} else {
			if (t < t0) return false;
			if (t < t1) t1 = t;
		}
		return true;
	};
	return clip(-dx, x1 - minX) && clip(dx, maxX - x1) && clip(-dy, y1 - minY) && clip(dy, maxY - y1) && t0 <= t1;
}

/** Eraser hit test: does the eraser segment pass within `radius` of any (padded) row? */
export function rowsHitSegment(rows: readonly Row[], x1: number, y1: number, x2: number, y2: number, radius: number): boolean {
	return rows.some((r) => segmentHitsRect(padded(r), x1, y1, x2, y2, radius));
}

/**
 * Fraction of the horizontal extent [minX, maxX] that lies over the rows (union of their
 * x-intervals). 1 for a zero-width extent inside a row.
 */
export function coverage(rows: readonly Row[], minX: number, maxX: number): number {
	const ivs = rows
		.map((r): [number, number] => [Math.max(r.left, minX), Math.min(r.right, maxX)])
		.filter(([a, b]) => b >= a)
		.sort((a, b) => a[0] - b[0]);
	let covered = 0;
	let end = -Infinity;
	for (const [a, b] of ivs) {
		const s = Math.max(a, end);
		if (b > s) covered += b - s;
		end = Math.max(end, b);
	}
	const w = maxX - minX;
	if (w <= 0) return ivs.length > 0 ? 1 : 0;
	return covered / w;
}

/** Sample spacing (px) of the points that stand in for a row (lasso, freehand conversion). */
const SAMPLE_STEP = 4;

/** Points along a row's horizontal center line, from `x0` to `x1` (inclusive), every ~4 px. */
function centerLine(x0: number, x1: number, y: number): Point[] {
	const n = Math.max(1, Math.ceil((x1 - x0) / SAMPLE_STEP));
	const out: Point[] = [];
	for (let i = 0; i <= n; i++) out.push([x0 + ((x1 - x0) * i) / n, y, 0.5]);
	return out;
}

/**
 * Points standing in for the highlight's area (lasso majority rule): each row's center line,
 * sampled every ~4 px, relative to `offsetY` (the stroke's line top).
 */
export function rowsSamplePoints(rows: readonly Row[], offsetY = 0): Point[] {
	const out: Point[] = [];
	for (const r of rows) out.push(...centerLine(r.left, r.right, (r.top + r.bottom) / 2 - offsetY));
	return out;
}

/**
 * Freehand equivalent of a text highlight: one constant-width highlighter capsule per row (size =
 * padded row height, centered, spanning the padded row), points relative to `offsetY`. Used when
 * a text highlight is moved/scaled/duplicated/copied by the lasso or rasterized.
 */
export function rowsToFreehand(rows: readonly Row[], offsetY = 0): { size: number; points: Point[] }[] {
	return rows.map((raw) => {
		const r = padded(raw);
		const h = r.bottom - r.top;
		const cy = (r.top + r.bottom) / 2 - offsetY;
		const x0 = r.left + h / 2;
		const x1 = Math.max(x0, r.right - h / 2);
		return { size: h, points: centerLine(x0, x1, cy) };
	});
}
