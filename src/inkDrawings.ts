/**
 * Public API support (`inkDrawings`, see api.ts): split a note's ink into DRAWINGS and lay each one
 * out for rendering to an image (e.g. so another plugin can ask a vision model to read handwritten
 * equations). Pure: no Obsidian / DOM imports (tested in tests/inkDrawings.test.ts); the canvas
 * part is in drawingPng.ts.
 *
 * - Every drawing space with pen ink is one drawing (points are already relative to the space top).
 * - Line-anchored ("margin") pen ink is clustered: each stroke is placed at its anchor line's top
 *   (`lineTop`, the live editor layout when the caller has it, else line × `lineHeight` — an
 *   approximation: real lines differ in height, wrapped lines are taller, and drawing spaces
 *   between lines are not counted) plus its own y. Two strokes join one drawing when their padded
 *   boxes are within `lineHeight` vertically AND within `3 × lineHeight` horizontally (transitively).
 *   A drawing is keyed by its FIRST (smallest) anchor line; `lines` lists all of them.
 * - Highlighter strokes are skipped (they are emphasis, not content). A stroke whose space id is
 *   unknown counts as line-anchored (as in `inkLinesOf`).
 * Line numbers are the same as `inkLinesOf` returns for the same ink and text.
 */
import type { Rect } from "./crop";
import { bbox } from "./geometry";
import type { RenderStroke } from "./inkRender";
import { InkFile, Stroke, resolveAnchor } from "./model";
import { blockEnds, displayLine } from "./spaces";

/** Fallback editor line height (px) when no live layout is available (16 px font × 1.5). */
export const APPROX_LINE_HEIGHT = 24;
/** White margin around the ink in a rendered drawing (CSS px, before scaling). */
export const DRAWING_PAD = 12;
/** Longest side (device px) of a rendered drawing. */
export const DRAWING_MAX_SIDE = 1500;
/** Largest upscale for small drawings (thin pens stay legible). */
export const DRAWING_MAX_SCALE = 4;

export interface DrawingLayout {
	/** Line the drawing is keyed by: the space's display line / the first anchor line of a margin cluster. */
	line: number;
	/** All lines the drawing hangs off (sorted, unique). A space: just its display line. */
	lines: number[];
	kind: "space" | "margin";
	/** Strokes with the y of their origin (`top`) in `region`'s coordinate system. */
	strokes: RenderStroke[];
	/** Area to render (ink bounds + DRAWING_PAD). */
	region: Rect;
}

export interface LayoutOptions {
	/** y of a line's top (0-based line) in one coordinate system for the whole note; null → fallback. */
	lineTop?: (line: number) => number | null | undefined;
	/** Line height for the fallback and the clustering gaps. Default APPROX_LINE_HEIGHT. */
	lineHeight?: number;
}

interface Box {
	minX: number;
	minY: number;
	maxX: number;
	maxY: number;
}

/** Box of a stroke's points (incl. half its width) shifted down by `top`; null if it has no points. */
function strokeBox(s: Stroke, top: number): Box | null {
	const b = bbox(s.points);
	if (!b) return null;
	const h = s.size / 2;
	return { minX: b.minX - h, minY: b.minY + top - h, maxX: b.maxX + h, maxY: b.maxY + top + h };
}

function union(a: Box, b: Box): Box {
	return { minX: Math.min(a.minX, b.minX), minY: Math.min(a.minY, b.minY), maxX: Math.max(a.maxX, b.maxX), maxY: Math.max(a.maxY, b.maxY) };
}

function padded(b: Box): Rect {
	return { x: b.minX - DRAWING_PAD, y: b.minY - DRAWING_PAD, w: b.maxX - b.minX + 2 * DRAWING_PAD, h: b.maxY - b.minY + 2 * DRAWING_PAD };
}

/** Gap between two intervals (0 if they overlap). */
const gap = (a0: number, a1: number, b0: number, b1: number): number => Math.max(0, Math.max(a0, b0) - Math.min(a1, b1));

/**
 * Cluster boxes: i and j join when their vertical gap ≤ `gapY` and horizontal gap ≤ `gapX`
 * (transitively). Returns a cluster id per box (ids are arbitrary but equal within a cluster).
 */
export function clusterBoxes(boxes: readonly Box[], gapY: number, gapX: number): number[] {
	const parent = boxes.map((_, i) => i);
	const find = (i: number): number => {
		while (parent[i] !== i) {
			parent[i] = parent[parent[i]];
			i = parent[i];
		}
		return i;
	};
	const order = boxes.map((_, i) => i).sort((a, b) => boxes[a].minY - boxes[b].minY);
	for (let k = 0; k < order.length; k++) {
		const a = boxes[order[k]];
		for (let m = k + 1; m < order.length; m++) {
			const b = boxes[order[m]];
			if (b.minY > a.maxY + gapY) break; // sorted by minY: nothing further down is closer
			if (gap(a.minY, a.maxY, b.minY, b.maxY) <= gapY && gap(a.minX, a.maxX, b.minX, b.maxX) <= gapX) {
				const ra = find(order[k]);
				const rb = find(order[m]);
				if (ra !== rb) parent[rb] = ra;
			}
		}
	}
	return boxes.map((_, i) => find(i));
}

/** The note's drawings (see the module docs), sorted by line (spaces before margin ink on a tie). */
export function layoutDrawings(ink: InkFile, text: readonly string[], opts: LayoutOptions = {}): DrawingLayout[] {
	const lines = text.length > 0 ? text : [""];
	const lh = opts.lineHeight && opts.lineHeight > 0 ? opts.lineHeight : APPROX_LINE_HEIGHT;
	const out: DrawingLayout[] = [];

	// Spaces.
	const spaces = ink.spaces ?? [];
	const spaceIds = new Set(spaces.map((s) => s.id));
	const ends = spaces.length > 0 ? blockEnds(lines) : null;
	for (const sp of spaces) {
		let box: Box | null = null;
		const strokes: RenderStroke[] = [];
		for (const s of ink.strokes) {
			if (s.space !== sp.id || s.tool === "highlighter") continue;
			const b = strokeBox(s, 0);
			if (!b) continue;
			box = box ? union(box, b) : b;
			strokes.push({ stroke: s, top: 0 });
		}
		if (!box) continue;
		const line = displayLine(ends!, sp.after === "end" ? null : resolveAnchor(lines, sp.after));
		out.push({ line, lines: [line], kind: "space", strokes, region: padded(box) });
	}

	// Margin ink.
	const items: { stroke: Stroke; line: number; top: number; box: Box }[] = [];
	const tops = new Map<number, number>();
	const topOf = (line: number): number => {
		let t = tops.get(line);
		if (t === undefined) {
			const live = opts.lineTop?.(line);
			t = typeof live === "number" && Number.isFinite(live) ? live : line * lh;
			tops.set(line, t);
		}
		return t;
	};
	for (const s of ink.strokes) {
		if (s.tool === "highlighter") continue;
		if (s.space !== undefined && spaceIds.has(s.space)) continue;
		const line = resolveAnchor(lines, s.anchor);
		const top = topOf(line);
		const box = strokeBox(s, top);
		if (box) items.push({ stroke: s, line, top, box });
	}
	const ids = clusterBoxes(
		items.map((i) => i.box),
		lh,
		3 * lh,
	);
	const clusters = new Map<number, typeof items>();
	items.forEach((it, i) => {
		const c = clusters.get(ids[i]);
		if (c) c.push(it);
		else clusters.set(ids[i], [it]);
	});
	for (const members of clusters.values()) {
		let box = members[0].box;
		for (const m of members) box = union(box, m.box);
		const ls = [...new Set(members.map((m) => m.line))].sort((a, b) => a - b);
		out.push({
			line: ls[0],
			lines: ls,
			kind: "margin",
			strokes: members.map((m) => ({ stroke: m.stroke, top: m.top })),
			region: padded(box),
		});
	}

	out.sort((a, b) => a.line - b.line || (a.kind === b.kind ? a.region.y - b.region.y : a.kind === "space" ? -1 : 1));
	return out;
}

/**
 * Pixels per CSS px for rendering a `w`×`h` region: the long side becomes at most `maxSide`, and
 * small drawings are upscaled at most `maxScale`×.
 */
export function drawingScale(w: number, h: number, maxSide = DRAWING_MAX_SIDE, maxScale = DRAWING_MAX_SCALE): number {
	const long = Math.max(w, h, 1);
	return Math.min(maxScale, maxSide / long);
}
