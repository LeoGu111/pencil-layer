/**
 * Precise eraser (M2 Stage E). Pure, tested.
 *
 * The eraser is a disc of radius `radius` dragged along a path; every part of a stroke whose
 * centerline comes within `radius + strokeWidth / 2` of the eraser path is erased (so the visible
 * ink under the disc goes, like GoodNotes' "erase partially"). A stroke is cut where the eraser
 * crossed it; the surviving runs become separate polylines. The caller turns each run into a NEW
 * stroke (new id, re-anchored) and commits all of a drag's changes as ONE `replaceStrokes` op.
 *
 * Splitting is incremental: the caller keeps the current pieces of each touched stroke and feeds
 * every new eraser segment (previous → current pen position) through `erasePieces`, so the cost per
 * pointermove is proportional to the ink near that segment, not to the whole eraser path.
 *
 * Only segments of the stroke that come near the eraser segment are subdivided (into ≤ `step` px
 * samples, pressure interpolated); everything else keeps its original points, so untouched parts of
 * a piece are bit-identical to the original stroke.
 */
import type { Point } from "./model";

/** Eraser segment (x1, y1) → (x2, y2) in the same coordinate space as the points. */
export type EraserSegment = readonly [number, number, number, number];

/** Sampling step (px) where a stroke segment comes near the eraser. */
export const ERASE_STEP = 1;
/** Pieces shorter than this (px of arc length) are dropped (crumbs at the cut). */
export const MIN_PIECE_LENGTH = 1;

function distSqPointSeg(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
	const dx = bx - ax;
	const dy = by - ay;
	const len = dx * dx + dy * dy;
	let t = len > 0 ? ((px - ax) * dx + (py - ay) * dy) / len : 0;
	t = t < 0 ? 0 : t > 1 ? 1 : t;
	const x = ax + t * dx - px;
	const y = ay + t * dy - py;
	return x * x + y * y;
}

function cross(ax: number, ay: number, bx: number, by: number, cx: number, cy: number): number {
	return (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
}

/** Do segments ab and cd properly intersect? */
function segmentsCross(
	ax: number,
	ay: number,
	bx: number,
	by: number,
	cx: number,
	cy: number,
	dx: number,
	dy: number,
): boolean {
	const d1 = cross(cx, cy, dx, dy, ax, ay);
	const d2 = cross(cx, cy, dx, dy, bx, by);
	const d3 = cross(ax, ay, bx, by, cx, cy);
	const d4 = cross(ax, ay, bx, by, dx, dy);
	return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
}

/** Squared distance between segments ab and cd. */
export function segSegDistSq(
	ax: number,
	ay: number,
	bx: number,
	by: number,
	cx: number,
	cy: number,
	dx: number,
	dy: number,
): number {
	if (segmentsCross(ax, ay, bx, by, cx, cy, dx, dy)) return 0;
	return Math.min(
		distSqPointSeg(ax, ay, cx, cy, dx, dy),
		distSqPointSeg(bx, by, cx, cy, dx, dy),
		distSqPointSeg(cx, cy, ax, ay, bx, by),
		distSqPointSeg(dx, dy, ax, ay, bx, by),
	);
}

function arcLength(pts: readonly Point[]): number {
	let len = 0;
	for (let i = 1; i < pts.length; i++) len += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
	return len;
}

/**
 * Erase the parts of one polyline within `reach` (= eraser radius + stroke half-width) of the eraser
 * segment. Returns `null` when nothing was erased (keep the piece as it is), otherwise the surviving
 * runs (possibly none).
 */
export function erasePiece(points: readonly Point[], seg: EraserSegment, reach: number, step = ERASE_STEP): Point[][] | null {
	if (points.length === 0) return null;
	const [ex1, ey1, ex2, ey2] = seg;
	const reachSq = reach * reach;
	// Quick reject on bounding boxes.
	let minX = Infinity;
	let minY = Infinity;
	let maxX = -Infinity;
	let maxY = -Infinity;
	for (const p of points) {
		if (p[0] < minX) minX = p[0];
		if (p[0] > maxX) maxX = p[0];
		if (p[1] < minY) minY = p[1];
		if (p[1] > maxY) maxY = p[1];
	}
	if (
		Math.max(ex1, ex2) < minX - reach ||
		Math.min(ex1, ex2) > maxX + reach ||
		Math.max(ey1, ey2) < minY - reach ||
		Math.min(ey1, ey2) > maxY + reach
	) {
		return null;
	}
	const inside = (x: number, y: number) => distSqPointSeg(x, y, ex1, ey1, ex2, ey2) < reachSq;

	if (points.length === 1) {
		return inside(points[0][0], points[0][1]) ? [] : null;
	}

	const pieces: Point[][] = [];
	let cur: Point[] = [];
	let erased = false;
	const close = () => {
		if (cur.length >= 2 && arcLength(cur) >= MIN_PIECE_LENGTH) pieces.push(cur);
		cur = [];
	};
	const visit = (p: Point) => {
		if (inside(p[0], p[1])) {
			erased = true;
			close();
		} else {
			cur.push(p);
		}
	};

	visit(points[0]);
	for (let i = 1; i < points.length; i++) {
		const a = points[i - 1];
		const b = points[i];
		const near = segSegDistSq(a[0], a[1], b[0], b[1], ex1, ey1, ex2, ey2) < reachSq;
		if (near) {
			const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
			const n = Math.max(1, Math.ceil(len / step));
			for (let k = 1; k < n; k++) {
				const t = k / n;
				visit([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]);
			}
		}
		visit(b);
	}
	if (!erased) return null;
	close();
	return pieces;
}

/**
 * Apply one eraser segment to the current pieces of a stroke. Returns `null` if no piece changed,
 * otherwise the new list of pieces (empty = the stroke is completely erased).
 */
export function erasePieces(pieces: readonly (readonly Point[])[], seg: EraserSegment, reach: number, step = ERASE_STEP): Point[][] | null {
	let changed = false;
	const out: Point[][] = [];
	for (const piece of pieces) {
		const r = erasePiece(piece, seg, reach, step);
		if (r === null) {
			out.push(piece as Point[]);
		} else {
			changed = true;
			out.push(...r);
		}
	}
	return changed ? out : null;
}
