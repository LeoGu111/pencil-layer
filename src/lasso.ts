/**
 * Lasso selection helpers (pure, no DOM): hit-testing strokes against a freeform loop and the
 * move/scale transform applied to a selection.
 *
 * Coordinates are overlay space (x from content left, y from document top). Stroke points are
 * local (y relative to their anchor line top), so callers pass each stroke's line top as `offsetY`.
 */
import { pointInPolygon } from "./gestures";
import type { Point, Stroke } from "./model";
import type { BBox } from "./geometry";

export { pointInPolygon };

/** Scale limits for the resize handle. */
export const MIN_SCALE = 0.1;
export const MAX_SCALE = 10;
/** Smallest stroke width a scaled stroke may get (px). */
export const MIN_STROKE_SIZE = 0.3;

function boxOf(pts: readonly (readonly number[])[]): BBox {
	let minX = Infinity;
	let minY = Infinity;
	let maxX = -Infinity;
	let maxY = -Infinity;
	for (const p of pts) {
		if (p[0] < minX) minX = p[0];
		if (p[0] > maxX) maxX = p[0];
		if (p[1] < minY) minY = p[1];
		if (p[1] > maxY) maxY = p[1];
	}
	return { minX, minY, maxX, maxY };
}

/** Orientation of (a, b, c): > 0 counter-clockwise, < 0 clockwise, 0 collinear. */
function orient(ax: number, ay: number, bx: number, by: number, cx: number, cy: number): number {
	return (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
}

/** Do segments p1–p2 and q1–q2 intersect (touching counts)? */
export function segmentsIntersect(
	p1x: number,
	p1y: number,
	p2x: number,
	p2y: number,
	q1x: number,
	q1y: number,
	q2x: number,
	q2y: number,
): boolean {
	const d1 = orient(q1x, q1y, q2x, q2y, p1x, p1y);
	const d2 = orient(q1x, q1y, q2x, q2y, p2x, p2y);
	const d3 = orient(p1x, p1y, p2x, p2y, q1x, q1y);
	const d4 = orient(p1x, p1y, p2x, p2y, q2x, q2y);
	if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) return true;
	const on = (ax: number, ay: number, bx: number, by: number, cx: number, cy: number) =>
		Math.min(ax, bx) <= cx && cx <= Math.max(ax, bx) && Math.min(ay, by) <= cy && cy <= Math.max(ay, by);
	return (
		(d1 === 0 && on(q1x, q1y, q2x, q2y, p1x, p1y)) ||
		(d2 === 0 && on(q1x, q1y, q2x, q2y, p2x, p2y)) ||
		(d3 === 0 && on(p1x, p1y, p2x, p2y, q1x, q1y)) ||
		(d4 === 0 && on(p1x, p1y, p2x, p2y, q2x, q2y))
	);
}

/**
 * Touch rule: does any part of the stroke touch the lasso loop — ANY point inside the polygon, or ANY
 * segment crossing one of its edges (the loop is closed implicitly from its last point to its first)?
 * A small loop around the end of a long line selects the whole line. `offsetX/offsetY` translate
 * local stroke points into the lasso's space. Points and segments outside the lasso's bbox are
 * skipped cheaply; `lassoBox` may be passed in when already computed.
 */
export function strokeInLasso(
	points: readonly (readonly number[])[],
	lasso: readonly (readonly number[])[],
	offsetX = 0,
	offsetY = 0,
	lassoBox: BBox = boxOf(lasso),
): boolean {
	if (points.length === 0 || lasso.length < 3) return false;
	const b = lassoBox;
	// Any point inside (cheap bbox test first).
	for (const p of points) {
		const x = p[0] + offsetX;
		const y = p[1] + offsetY;
		if (x >= b.minX && x <= b.maxX && y >= b.minY && y <= b.maxY && pointInPolygon(x, y, lasso)) return true;
	}
	// No point inside: selected only if a segment crosses the loop (sparse points, e.g. a long line).
	const m = lasso.length;
	for (let i = 1; i < points.length; i++) {
		const ax = points[i - 1][0] + offsetX;
		const ay = points[i - 1][1] + offsetY;
		const bx = points[i][0] + offsetX;
		const by = points[i][1] + offsetY;
		if (Math.max(ax, bx) < b.minX || Math.min(ax, bx) > b.maxX || Math.max(ay, by) < b.minY || Math.min(ay, by) > b.maxY) continue;
		const sMinX = Math.min(ax, bx);
		const sMaxX = Math.max(ax, bx);
		const sMinY = Math.min(ay, by);
		const sMaxY = Math.max(ay, by);
		for (let j = 0, k = m - 1; j < m; k = j++) {
			const q1 = lasso[k];
			const q2 = lasso[j];
			if (Math.max(q1[0], q2[0]) < sMinX || Math.min(q1[0], q2[0]) > sMaxX) continue;
			if (Math.max(q1[1], q2[1]) < sMinY || Math.min(q1[1], q2[1]) > sMaxY) continue;
			if (segmentsIntersect(ax, ay, bx, by, q1[0], q1[1], q2[0], q2[1])) return true;
		}
	}
	return false;
}

/**
 * Strokes selected by a lasso loop (touch rule, see `strokeInLasso`) among `strokes` — the caller
 * passes the candidates (e.g. pre-filtered by tool). `topOf(s)` returns the overlay y of the stroke's
 * anchor line; `leftOf(s)` (optional, default 0) the overlay x of its points' origin (Stage H:
 * character-anchored ink may be shifted sideways). Strokes whose bbox misses the lasso's bbox are
 * skipped cheaply.
 */
export function selectInLasso<S extends Pick<Stroke, "points">>(
	strokes: readonly S[],
	lasso: readonly (readonly number[])[],
	topOf: (s: S) => number,
	leftOf?: (s: S) => number,
): S[] {
	if (lasso.length < 3) return [];
	const box = boxOf(lasso);
	const out: S[] = [];
	for (const s of strokes) {
		if (s.points.length === 0) continue;
		const top = topOf(s);
		const left = leftOf ? leftOf(s) : 0;
		const sb = boxOf(s.points);
		if (sb.maxX + left < box.minX || sb.minX + left > box.maxX || sb.maxY + top < box.minY || sb.minY + top > box.maxY) continue;
		if (strokeInLasso(s.points, lasso, left, top, box)) out.push(s);
	}
	return out;
}

/** Move + uniform scale about an origin: p' = o + (p − o)·scale + (dx, dy). */
export interface SelectionTransform {
	dx: number;
	dy: number;
	scale: number;
	/** Scale origin (overlay space). */
	ox: number;
	oy: number;
}

export const IDENTITY: SelectionTransform = { dx: 0, dy: 0, scale: 1, ox: 0, oy: 0 };

export function isIdentity(t: SelectionTransform): boolean {
	return t.dx === 0 && t.dy === 0 && t.scale === 1;
}

export function applyTransform(x: number, y: number, t: SelectionTransform): [number, number] {
	return [t.ox + (x - t.ox) * t.scale + t.dx, t.oy + (y - t.oy) * t.scale + t.dy];
}

/**
 * Transform a stroke's local points (anchor line top = `offsetY`) into OVERLAY-space points.
 * Pressure is kept. The caller re-anchors the result (see `reanchorPoints`).
 */
export function transformPoints(points: readonly Point[], offsetY: number, t: SelectionTransform, offsetX = 0): Point[] {
	return points.map((p): Point => {
		const [x, y] = applyTransform(p[0] + offsetX, p[1] + offsetY, t);
		return [x, y, p[2]];
	});
}

/** Stroke width after scaling (strokes get thicker/thinner with the selection). */
export function scaledSize(size: number, t: SelectionTransform): number {
	return Math.max(MIN_STROKE_SIZE, Math.round(size * t.scale * 100) / 100);
}

/**
 * Uniform scale for the bottom-right resize handle: `origin` is the fixed (top-left) corner,
 * `start` where the handle was grabbed, `current` the pointer. Projection of the drag onto the
 * origin→handle diagonal, clamped to [MIN_SCALE, MAX_SCALE].
 */
export function handleScale(origin: readonly number[], start: readonly number[], current: readonly number[]): number {
	const vx = start[0] - origin[0];
	const vy = start[1] - origin[1];
	const len2 = vx * vx + vy * vy;
	if (len2 < 1) return 1;
	const s = ((current[0] - origin[0]) * vx + (current[1] - origin[1]) * vy) / len2;
	return Math.min(MAX_SCALE, Math.max(MIN_SCALE, s));
}

/** Bounding box of the transformed bbox (uniform scale keeps it axis-aligned). */
export function transformBox(b: BBox, t: SelectionTransform): BBox {
	const [x0, y0] = applyTransform(b.minX, b.minY, t);
	const [x1, y1] = applyTransform(b.maxX, b.maxY, t);
	return { minX: Math.min(x0, x1), minY: Math.min(y0, y1), maxX: Math.max(x0, x1), maxY: Math.max(y0, y1) };
}

export type SelectionHit = "handle" | "inside" | null;

/**
 * What a pointer at (x, y) hits on a selection box: the resize handle (bottom-right corner,
 * within `handleRadius`), the inside of the box (padded by `pad`), or nothing.
 */
export function hitSelection(b: BBox, x: number, y: number, handleRadius: number, pad = 0): SelectionHit {
	if (Math.hypot(x - b.maxX, y - b.maxY) <= handleRadius) return "handle";
	if (x >= b.minX - pad && x <= b.maxX + pad && y >= b.minY - pad && y <= b.maxY + pad) return "inside";
	return null;
}

/** SVG transform string for a selection transform (applied before the per-stroke line offset). */
export function svgTransform(t: SelectionTransform): string {
	if (isIdentity(t)) return "";
	const f = (n: number) => (Math.round(n * 1000) / 1000).toString();
	if (t.scale === 1) return `translate(${f(t.dx)} ${f(t.dy)}) `;
	return `translate(${f(t.ox + t.dx)} ${f(t.oy + t.dy)}) scale(${f(t.scale)}) translate(${f(-t.ox)} ${f(-t.oy)}) `;
}
