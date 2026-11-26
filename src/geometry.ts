/**
 * Pure geometry helpers: stroke → SVG path, bounding boxes and eraser hit-testing.
 *
 * Coordinates: stroke points are in the stroke's LOCAL space (x relative to content left,
 * y relative to the anchor line top). Callers that work in overlay space pass the anchor
 * line's offset (`offsetX`, `offsetY`), which is simply added to every point.
 */
import { getStroke } from "perfect-freehand";
import { penStyleOf } from "./model";
import type { Point, Stroke } from "./model";
import { tiltWidthMultiplier } from "./penInput";
import { DASH_MIN_DISTANCE, curvePath, fmt, polylinePath, thinPoints } from "./smoothing";

export interface PathOptions {
	/** Added to every x (default 0). */
	offsetX?: number;
	/** Added to every y — typically the anchor line block's top (default 0). */
	offsetY?: number;
	/** Pass `false` while the stroke is still being drawn (in-progress rendering). Default true. */
	last?: boolean;
}

type StrokeShape = Pick<Stroke, "tool" | "size" | "points" | "style"> & { shape?: Stroke["shape"]; tilts?: Stroke["tilts"] };

/** Turn a perfect-freehand outline polygon into a smooth closed SVG path (quadratic midpoints). */
export function outlineToPath(outline: number[][]): string {
	const len = outline.length;
	if (len === 0) return "";
	if (len < 3) {
		return "M" + outline.map((p) => `${fmt(p[0])} ${fmt(p[1])}`).join(" L") + " Z";
	}
	let d = `M${fmt(outline[0][0])} ${fmt(outline[0][1])} Q`;
	for (let i = 0; i < len; i++) {
		const a = outline[i];
		const b = outline[(i + 1) % len];
		d += `${fmt(a[0])} ${fmt(a[1])} ${fmt((a[0] + b[0]) / 2)} ${fmt((a[1] + b[1]) / 2)} `;
	}
	return d + "Z";
}

/**
 * Is this stroke drawn as a stroked centerline (ballpoint / dashed pen) rather than a filled
 * perfect-freehand outline (Notes-style pen, highlighter)?
 */
export function isCenterline(stroke: Pick<Stroke, "tool" | "style" | "tilts">): boolean {
	const style = penStyleOf(stroke);
	if (style === "dashed" || style === "dotted") return true;
	if (style !== "ball") return false;
	return !(stroke.tilts && stroke.tilts.some((t) => tiltWidthMultiplier(t, "ball", stroke.tool) > 1.01));
}

/** Is this a dashed pen stroke? (Legacy "dotted" strokes render dashed too.) */
export function isDashed(stroke: Pick<Stroke, "tool" | "style">): boolean {
	const style = penStyleOf(stroke);
	return style === "dashed" || style === "dotted";
}

/** Visible dash and gap lengths (px) of the dashed pen at its default 1.6 px width (GoodNotes-like). */
export const DASH_LENGTH = 7;
export const DASH_GAP = 5;
const DASH_BASE_WIDTH = 1.6;

/**
 * `stroke-dasharray` of a dashed stroke: fixed screen-space dash/gap (scaled up only for wider pens),
 * with round caps, so the drawn dash is `DASH_LENGTH` and the gap `DASH_GAP`. The pattern starts at
 * the stroke's first point (dashoffset 0) and depends only on the path geometry, never on speed.
 */
export function dashArray(stroke: Pick<Stroke, "tool" | "style" | "size">): string | null {
	if (!isDashed(stroke)) return null;
	const k = Math.max(1, stroke.size / DASH_BASE_WIDTH);
	return `${fmt(Math.max(0.5, DASH_LENGTH * k - stroke.size))} ${fmt(DASH_GAP * k + stroke.size)}`;
}

/**
 * Centerline path of a ballpoint / dashed stroke: a smooth quadratic-midpoint curve (`curvePath`),
 * or straight segments for snapped shapes (already clean; corners must stay sharp). Dashed strokes
 * first drop points closer than 1.5 px (`thinPoints`) so jitter can't add path length. A single
 * point yields a zero-length segment, which round caps render as a dot.
 */
export function centerlinePath(
	stroke: Pick<Stroke, "tool" | "style" | "points"> & { shape?: Stroke["shape"] },
	offsetX = 0,
	offsetY = 0,
): string {
	const pts = stroke.points;
	if (pts.length === 0) return "";
	if (stroke.shape) return polylinePath(pts, offsetX, offsetY);
	if (pts.length === 1) return polylinePath(pts, offsetX, offsetY);
	return curvePath(isDashed(stroke) ? thinPoints(pts, DASH_MIN_DISTANCE) : pts, offsetX, offsetY);
}

/** True when every point has the same pressure (mouse, or a device without pressure). */
function constantPressure(points: readonly Point[]): boolean {
	for (let i = 1; i < points.length; i++) if (points[i][2] !== points[0][2]) return false;
	return true;
}

/**
 * Subdivide long segments caused by very fast stylus movement so `perfect-freehand` always gets
 * dense samples and never pinches, twists, or breaks into disconnected segments. Uses Catmull-Rom
 * interpolation along the stroke with linear pressure/tilt blending.
 */
export function densifyPoints(
	points: readonly Point[],
	maxStep = 6,
	tilts?: readonly number[],
): { points: Point[]; tilts?: number[] } {
	const n = points.length;
	if (n < 2 || maxStep <= 0) {
		return { points: points.slice(), ...(tilts ? { tilts: tilts.slice() } : {}) };
	}
	let needsSplit = false;
	const maxSq = maxStep * maxStep;
	for (let i = 1; i < n; i++) {
		const dx = points[i][0] - points[i - 1][0];
		const dy = points[i][1] - points[i - 1][1];
		if (dx * dx + dy * dy > maxSq) {
			needsSplit = true;
			break;
		}
	}
	if (!needsSplit) {
		return { points: points.slice(), ...(tilts ? { tilts: tilts.slice() } : {}) };
	}
	const outPts: Point[] = [points[0]];
	const outTilts: number[] | undefined = tilts ? [tilts[0] ?? 0] : undefined;
	for (let i = 1; i < n; i++) {
		const p1 = points[i - 1];
		const p2 = points[i];
		const dist = Math.hypot(p2[0] - p1[0], p2[1] - p1[1]);
		if (dist > maxStep) {
			const steps = Math.min(48, Math.ceil(dist / maxStep));
			const p0 = points[Math.max(0, i - 2)];
			const p3 = points[Math.min(n - 1, i + 1)];
			const t1 = tilts?.[i - 1] ?? 0;
			const t2 = tilts?.[i] ?? 0;
			for (let k = 1; k < steps; k++) {
				const t = k / steps;
				const t2s = t * t;
				const t3s = t2s * t;
				// Centripetal-safe Catmull-Rom clamped near chord to prevent overshoot on huge jumps.
				const crX =
					0.5 *
					(2 * p1[0] +
						(-p0[0] + p2[0]) * t +
						(2 * p0[0] - 5 * p1[0] + 4 * p2[0] - p3[0]) * t2s +
						(-p0[0] + 3 * p1[0] - 3 * p2[0] + p3[0]) * t3s);
				const crY =
					0.5 *
					(2 * p1[1] +
						(-p0[1] + p2[1]) * t +
						(2 * p0[1] - 5 * p1[1] + 4 * p2[1] - p3[1]) * t2s +
						(-p0[1] + 3 * p1[1] - 3 * p2[1] + p3[1]) * t3s);
				const linX = p1[0] + (p2[0] - p1[0]) * t;
				const linY = p1[1] + (p2[1] - p1[1]) * t;
				const dev = Math.hypot(crX - linX, crY - linY);
				const maxDev = dist * 0.25;
				const blend = dev > maxDev && dev > 0 ? maxDev / dev : 1;
				const x = linX + (crX - linX) * blend;
				const y = linY + (crY - linY) * blend;
				const p = p1[2] + (p2[2] - p1[2]) * t;
				outPts.push([x, y, p]);
				if (outTilts) outTilts.push(t1 + (t2 - t1) * t);
			}
		}
		outPts.push(p2);
		if (outTilts) outTilts.push(tilts![i] ?? 0);
	}
	return { points: outPts, ...(outTilts ? { tilts: outTilts } : {}) };
}

/**
 * Stroke → SVG path `d`.
 * - Ballpoint / dashed pen (`isCenterline`): a smooth centerline (`centerlinePath`), to be rendered
 *   STROKED with `stroke-width = size`, round caps/joins (and `dashArray` for dashed), `fill: none`.
 * - Notes-style pen: perfect-freehand outline with pressure/velocity thinning and soft taper,
 *   simulating pressure when the input has none. Rendered FILLED.
 * - Highlighter: constant-width perfect-freehand outline, rendered FILLED.
 * Returns "" for a stroke with no points.
 */
export function strokeToPath(stroke: StrokeShape, opts: PathOptions = {}): string {
	const { offsetX = 0, offsetY = 0, last = true } = opts;
	if (stroke.points.length === 0) return "";
	if (isCenterline(stroke)) return centerlinePath(stroke, offsetX, offsetY);
	const style = penStyleOf(stroke);
	const rawTilts = stroke.tilts;
	const hasTilt =
		!stroke.shape &&
		!!rawTilts &&
		rawTilts.length > 0 &&
		rawTilts.some((t) => tiltWidthMultiplier(t, style, stroke.tool) > 1.01);

	const dense = stroke.shape
		? { points: stroke.points, tilts: rawTilts }
		: densifyPoints(stroke.points, Math.max(4, Math.min(8, stroke.size * 2.5)), hasTilt ? rawTilts : undefined);
	const dPts = dense.points;
	const tilts = dense.tilts;

	if (hasTilt && tilts) {
		const usePressure = stroke.tool === "pen" && (style === "notes" || style === "pencil" || style === "calligraphy");
		const uniform = constantPressure(dPts);
		// Keep thinning bounded so upright/fast segments never pinch to sub-pixel fragments.
		const thinning = style === "calligraphy" ? 0.7 : style === "marker" ? 0.25 : 0.65;
		const baseMul = style === "marker" ? 1.85 : style === "calligraphy" ? 1.4 : 1;
		const factors = dPts.map((p, i) => {
			const pFactor = usePressure && !uniform ? 1 + (style === "calligraphy" ? 0.55 : 0.45) * (2 * Math.max(0.15, p[2]) - 1) : 1;
			const tFactor = tiltWidthMultiplier(tilts[i] ?? 0, style, stroke.tool);
			return Math.max(0.55, pFactor * tFactor);
		});
		let maxFactor = 1;
		for (const f of factors) if (f > maxFactor) maxFactor = f;
		const effSize = (stroke.size * baseMul * maxFactor) / (1 + thinning);
		const pts = dPts.map((p, i) => {
			const norm = (factors[i] / maxFactor) * (1 + thinning);
			const effP = Math.max(0.18, Math.min(1, 0.5 + (norm - 1) / (2 * thinning)));
			return [p[0] + offsetX, p[1] + offsetY, effP];
		});
		const taper = usePressure ? stroke.size * (style === "pencil" ? 1.8 : style === "calligraphy" ? 3.5 : 3) : false;
		return outlineToPath(
			getStroke(pts, {
				size: effSize,
				thinning,
				smoothing: 0.5,
				streamline: 0.3,
				simulatePressure: false,
				last,
				start: { cap: true, ...(taper ? { taper } : {}) },
				end: { cap: true, ...(taper ? { taper } : {}) },
			}),
		);
	}

	const pts = dPts.map((p) => [p[0] + offsetX, p[1] + offsetY, Math.max(0.18, p[2])]);
	if (stroke.tool === "highlighter") {
		return outlineToPath(
			getStroke(pts, {
				size: stroke.size,
				thinning: 0,
				smoothing: 0.5,
				streamline: 0.3,
				simulatePressure: false,
				last,
				start: { cap: true },
				end: { cap: true },
			}),
		);
	}
	if (style === "marker") {
		return outlineToPath(
			getStroke(pts, {
				size: stroke.size * 1.9,
				thinning: 0.14,
				smoothing: 0.6,
				streamline: 0.4,
				simulatePressure: false,
				last,
				start: { cap: true, taper: stroke.size * 1.2 },
				end: { cap: true, taper: stroke.size * 1.2 },
			}),
		);
	}
	if (style === "calligraphy") {
		return outlineToPath(
			getStroke(pts, {
				size: stroke.size * 1.45,
				thinning: 0.72,
				smoothing: 0.45,
				streamline: 0.35,
				simulatePressure: constantPressure(stroke.points),
				last,
				start: { cap: false, taper: stroke.size * 3.5 },
				end: { cap: false, taper: stroke.size * 3.5 },
			}),
		);
	}
	if (style === "pencil") {
		return outlineToPath(
			getStroke(pts, {
				size: stroke.size,
				thinning: 0.5,
				smoothing: 0.5,
				streamline: 0.3,
				simulatePressure: constantPressure(stroke.points),
				last,
				start: { cap: true, taper: stroke.size * 1.8 },
				end: { cap: true, taper: stroke.size * 1.8 },
			}),
		);
	}
	// Notes-style pen.
	return outlineToPath(
		getStroke(pts, {
			size: stroke.size,
			thinning: 0.55,
			smoothing: 0.5,
			streamline: 0.3,
			simulatePressure: constantPressure(stroke.points),
			last,
			start: { cap: true, taper: stroke.size * 3 },
			end: { cap: true, taper: stroke.size * 3 },
		}),
	);
}

export interface BBox {
	minX: number;
	minY: number;
	maxX: number;
	maxY: number;
}

/** Bounding box of points (pressure ignored). `null` for an empty list. */
export function bbox(points: readonly Point[] | readonly number[][]): BBox | null {
	if (points.length === 0) return null;
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
	return { minX, minY, maxX, maxY };
}

/** Squared distance from point (px,py) to segment (ax,ay)-(bx,by). */
export function distSqPointSegment(
	px: number,
	py: number,
	ax: number,
	ay: number,
	bx: number,
	by: number,
): number {
	const dx = bx - ax;
	const dy = by - ay;
	const lenSq = dx * dx + dy * dy;
	let t = lenSq === 0 ? 0 : ((px - ax) * dx + (py - ay) * dy) / lenSq;
	t = Math.max(0, Math.min(1, t));
	const cx = ax + t * dx - px;
	const cy = ay + t * dy - py;
	return cx * cx + cy * cy;
}

function segmentsIntersect(
	ax: number, ay: number, bx: number, by: number,
	cx: number, cy: number, dx: number, dy: number,
): boolean {
	const cross = (ox: number, oy: number, px: number, py: number, qx: number, qy: number) =>
		(px - ox) * (qy - oy) - (py - oy) * (qx - ox);
	const d1 = cross(cx, cy, dx, dy, ax, ay);
	const d2 = cross(cx, cy, dx, dy, bx, by);
	const d3 = cross(ax, ay, bx, by, cx, cy);
	const d4 = cross(ax, ay, bx, by, dx, dy);
	return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
}

/** Squared distance between segments AB and CD. */
export function distSqSegmentSegment(
	ax: number, ay: number, bx: number, by: number,
	cx: number, cy: number, dx: number, dy: number,
): number {
	if (segmentsIntersect(ax, ay, bx, by, cx, cy, dx, dy)) return 0;
	return Math.min(
		distSqPointSegment(ax, ay, cx, cy, dx, dy),
		distSqPointSegment(bx, by, cx, cy, dx, dy),
		distSqPointSegment(cx, cy, ax, ay, bx, by),
		distSqPointSegment(dx, dy, ax, ay, bx, by),
	);
}

/**
 * Eraser hit test: is (x, y) — in overlay space — within `radius` of any segment of the stroke
 * (half the stroke width is added to the radius)? `offsetX/offsetY` translate the stroke's local
 * points into overlay space (usually the anchor line's top for Y).
 */
export function hitTestStroke(
	stroke: StrokeShape,
	x: number,
	y: number,
	radius: number,
	offsetX = 0,
	offsetY = 0,
): boolean {
	return hitTestStrokeSegment(stroke, x, y, x, y, radius, offsetX, offsetY);
}

/**
 * Like `hitTestStroke` but for the eraser path segment (x1,y1)-(x2,y2), so fast eraser drags
 * between two pointermove events don't skip strokes. All coordinates in overlay space.
 */
export function hitTestStrokeSegment(
	stroke: StrokeShape,
	x1: number,
	y1: number,
	x2: number,
	y2: number,
	radius: number,
	offsetX = 0,
	offsetY = 0,
): boolean {
	const pts = stroke.points;
	if (pts.length === 0) return false;
	const r = radius + stroke.size / 2;
	const rSq = r * r;
	// Work in local stroke space.
	const ax = x1 - offsetX;
	const ay = y1 - offsetY;
	const bx = x2 - offsetX;
	const by = y2 - offsetY;

	const box = bbox(pts)!;
	if (
		Math.max(ax, bx) < box.minX - r ||
		Math.min(ax, bx) > box.maxX + r ||
		Math.max(ay, by) < box.minY - r ||
		Math.min(ay, by) > box.maxY + r
	) {
		return false;
	}

	if (pts.length === 1) {
		return distSqPointSegment(pts[0][0], pts[0][1], ax, ay, bx, by) <= rSq;
	}
	for (let i = 1; i < pts.length; i++) {
		const p = pts[i - 1];
		const q = pts[i];
		if (distSqSegmentSegment(p[0], p[1], q[0], q[1], ax, ay, bx, by) <= rSq) return true;
	}
	return false;
}
