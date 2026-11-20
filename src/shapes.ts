/**
 * Shape recognizer for "draw and hold" (GoodNotes-style snap to shape). Pure, no DOM.
 *
 *   recognizeShape(points) → ShapeSpec | null     run ONCE when the pen has been still for the hold delay
 *   adjustShape(spec, p0, q) → ShapeSpec          pen still down after the snap: reshape following the pen
 *   shapeToPoints(spec) → XY[]                    densified outline stored as an ordinary stroke
 *
 * Pipeline (all distances in px):
 *  1. Drop tiny input (bbox diagonal < minSize). Collapse the hold tail (the settling hook and drift
 *     recorded while the pen is held still) into one point, then resample the path at uniform
 *     arc-length spacing.
 *  2. Closure: if a point in the second half of the path comes back near the start, the path is a
 *     closed loop (overshoot past the start is trimmed).
 *  3. Corners: windowed turning angle (direction change across ±4% of the path) with non-max
 *     suppression. Curves turn gradually and produce no corners; polygon vertices turn sharply.
 *  4. Closed: < 3 corners → ellipse/circle if the fit residual is small; 3–8 corners → each side must be
 *     straight (line fit residual) → triangle / rectangle (incl. rotated; ~90° corners) / polygon;
 *     otherwise fall back to the ellipse test.
 *     Open, in this order: arrow (straight shaft to the farthest point, then 1–2 barbs bent back at
 *     the tip, each returning to the tip or not) → line (best-fit line of the path minus its end
 *     hooks, small deviation; checked before any corner logic; within 5° of horizontal/vertical →
 *     exact) → polyline (2–8 straight segments with sharp corners, no retracing; a corner within a
 *     hook's length of either end is cut off). A 2-segment polyline with a 75–105° corner becomes an
 *     exact right angle (graph axes; legs axis-aligned when within 10°). Last, smooth curves ≥ 40 px
 *     with limited total turning → arc, parabola (quadratic Bézier) or one cubic Bézier, the simplest
 *     that fits about as well as the best. Anything else (handwriting, waves, spirals) → null: the
 *     stroke stays as drawn. (Arrows are actually tried first, before the closure test.)
 */

export type XY = [number, number];

/**
 * Default hold delay (ms) before a still pen snaps the stroke to a shape (GoodNotes "draw and hold").
 * The caller (inkView) owns the timer; a user setting may override this value.
 */
export const SNAP_HOLD_MS = 500;

/** Polygon-like shape: closed (rectangle — vertices in order around it —, triangle, polygon) or open. */
export interface PolyShape<K extends "rectangle" | "triangle" | "polygon" | "polyline"> {
	kind: K;
	vertices: XY[];
	/**
	 * Polyline only: a right angle (3 vertices, legs exactly perpendicular — e.g. graph axes). Kept by
	 * `adjustShape` (it scales in the legs' frame so the corner stays 90°). Not persisted: the stroke
	 * is stored as an ordinary `shape: "polyline"`.
	 */
	rightAngle?: true;
}

/** Ellipse/circle; `rot` in radians; for a circle rx === ry. */
export interface RoundShape<K extends "ellipse" | "circle"> {
	kind: K;
	cx: number;
	cy: number;
	rx: number;
	ry: number;
	rot: number;
}

export type ShapeSpec =
	| { kind: "line"; a: XY; b: XY }
	/** Arrow from `a` to the tip `b`; `head` = barb length. */
	| { kind: "arrow"; a: XY; b: XY; head: number }
	| PolyShape<"rectangle">
	| PolyShape<"triangle">
	| PolyShape<"polygon">
	| PolyShape<"polyline">
	| RoundShape<"ellipse">
	| RoundShape<"circle">
	/** Circular arc: center, radius, start angle and signed sweep (rad; |sweep| < 2π). */
	| { kind: "arc"; cx: number; cy: number; r: number; start: number; sweep: number }
	/** Parabola segment as a quadratic Bézier (exact): start `a`, control `c`, end `b`. */
	| { kind: "parabola"; a: XY; c: XY; b: XY }
	/** Smooth curve as one cubic Bézier: start `a`, controls `c1`, `c2`, end `b`. */
	| { kind: "curve"; a: XY; c1: XY; c2: XY; b: XY };

/** Tuning constants (exported so they can be adjusted in one place and covered by tests). */
export const SHAPE_TUNING = {
	/** Minimum bbox diagonal of a stroke to be considered (px). Smaller = handwriting/dots. */
	minSize: 16,
	/** Resample spacing (px) and bounds on the sample count. */
	spacing: 2.5,
	minSamples: 32,
	maxSamples: 200,
	/** Closed if the path returns within max(closeMinPx, closeFrac × diag) of its start. */
	closeFrac: 0.2,
	closeMinPx: 8,
	/** Corner detection: window = cornerWindow × samples; minimum turning angle (deg). */
	cornerWindow: 0.04,
	cornerDeg: 40,
	/**
	 * Hold tail: the trailing points within clamp(holdTailFrac × diag, holdTailMinPx, holdTailMaxPx) of
	 * the last point (settling hook + drift while the pen is held for the snap) collapse into one point.
	 */
	holdTailFrac: 0.03,
	holdTailMinPx: 5,
	holdTailMaxPx: 9,
	/**
	 * Line: the core of the path (minus the hooks: ≤ lineStartTrimPx at the start where the pen lands,
	 * ≤ lineEndTrimPx at the end where it settles for the hold; each ≤ lineEndTrimFrac of the arc
	 * length) lies within max(min(lineDevPx, max(3, 8% of length)), lineDevFrac × length) of its best-fit line, its path
	 * length is ≤ lineLenRatio × chord, and the trimmed ends stay within lineEndDevFactor × that.
	 */
	lineLenRatio: 1.2,
	lineDevPx: 6,
	lineDevFrac: 0.045,
	lineStartTrimPx: 5,
	lineEndTrimPx: 12,
	lineEndTrimFrac: 0.08,
	lineEndDevFactor: 2,
	/**
	 * Arrow: barb length ≥ max(arrowMinBarbPx, arrowMinBarbFrac × shaft) and ≤ arrowMaxBarbFrac × shaft.
	 * Barbs longer than arrowShortBarbFrac × shaft (real small arrows have big heads) only count when
	 * the first barb returns to the tip — a "V" or check mark (one arm, no return) never does.
	 * Shaft ≥ arrowMinShaftPx; head path ≤ arrowMaxHeadPathFrac × shaft.
	 */
	arrowMinBarbPx: 9,
	arrowMinBarbFrac: 0.06,
	arrowMaxBarbFrac: 1,
	arrowShortBarbFrac: 0.5,
	arrowMinShaftPx: 16,
	arrowMaxHeadPathFrac: 4.5,
	/** A curl where the pen lands (≤ this arc length, ≤ 30% of the shaft) is cut off the shaft. */
	arrowStartTrimPx: 8,
	/** Arrow barb angle off the backward shaft direction (deg). */
	arrowMinDeg: 10,
	arrowMaxDeg: 80,
	/** Straight side: max deviation ≤ sideDevFrac × side + sideDevPx (and mean ≤ half of that). */
	sideDevFrac: 0.08,
	sideDevPx: 2.5,
	/** Ellipse fit: mean |r − 1| and max |r − 1| of the normalized radius. */
	ellipseMeanErr: 0.085,
	ellipseMaxErr: 0.3,
	/** Axes within this ratio → circle. */
	circleRatio: 0.9,
	/** Rectangle: every corner within 90° ± rectAngleTol (deg). */
	rectAngleTol: 22,
	/** Snap near-axis-aligned rectangles/ellipses (deg) and nearly horizontal/vertical lines (deg). */
	axisSnapDeg: 7,
	lineSnapDeg: 5,
	/**
	 * Right angle: a 2-segment open polyline whose corner is within 90° ± rightAngleTolDeg becomes an
	 * exact right angle; its legs are snapped to horizontal/vertical when within rightAngleAxisDeg.
	 */
	rightAngleTolDeg: 15,
	rightAngleAxisDeg: 10,
	/**
	 * Smooth curves (arc / parabola / cubic), tried last for open strokes without clean corners:
	 * the stroke minus ≤ curveStartTrimPx / curveEndTrimPx at its ends (landing / settling hook) must
	 * have a bbox diagonal ≥ curveMinSize (smaller = handwriting: "c", "u", "s"…), total turning
	 * ≤ curveMaxTurnDeg (spirals, waves, cursive turn more), and fit within max(curveDevPx,
	 * curveDevFrac × diagonal) (mean ≤ half of that; trimmed ends ≤ twice).
	 */
	curveMinSize: 40,
	curveStartTrimPx: 3,
	curveEndTrimPx: 6,
	curveMaxTurnDeg: 300,
	curveDevPx: 3,
	curveDevFrac: 0.03,
	/** Arc: sweep within [arcMinSweepDeg, arcMaxSweepDeg]; radius ≤ arcMaxRadiusFactor × diagonal. */
	arcMinSweepDeg: 20,
	arcMaxSweepDeg: 300,
	arcMaxRadiusFactor: 4,
	/**
	 * Several models fit → the simplest (arc, parabola, cubic) whose max deviation is within
	 * max(curveSlackPx, curveSlackFrac × diagonal) of the best one's (a cubic also absorbs some hand
	 * wobble, so it is always a little closer; only a clearly closer fit should win).
	 */
	curveSlackPx: 2,
	curveSlackFrac: 0.005,
	/** Polyline segments shorter than this fraction of the diagonal → not a clean polyline. */
	minSegFrac: 0.06,
	/** Polyline corners sharper than this (deg; 180 = going straight back) → handwriting, no snap. */
	maxPolylineTurnDeg: 155,
} as const;

// -------------------------------------------------------------------------------------------------
// Small vector helpers
// -------------------------------------------------------------------------------------------------

const dist = (a: readonly number[], b: readonly number[]): number => Math.hypot(a[0] - b[0], a[1] - b[1]);
const DEG = Math.PI / 180;

function pathLength(pts: readonly XY[]): number {
	let L = 0;
	for (let i = 1; i < pts.length; i++) L += dist(pts[i - 1], pts[i]);
	return L;
}

/** Perpendicular distance from p to the infinite line through a, b (distance to a if a == b). */
function lineDist(p: XY, a: XY, b: XY): number {
	const dx = b[0] - a[0];
	const dy = b[1] - a[1];
	const len = Math.hypot(dx, dy);
	if (len === 0) return dist(p, a);
	return Math.abs((p[0] - a[0]) * dy - (p[1] - a[1]) * dx) / len;
}

/** Unsigned angle (deg, 0..180) between two direction vectors. */
function turnDeg(ux: number, uy: number, vx: number, vy: number): number {
	const lu = Math.hypot(ux, uy);
	const lv = Math.hypot(vx, vy);
	if (lu === 0 || lv === 0) return 0;
	const c = Math.max(-1, Math.min(1, (ux * vx + uy * vy) / (lu * lv)));
	return Math.acos(c) / DEG;
}

function rotate(p: XY, ang: number, about: XY = [0, 0]): XY {
	const c = Math.cos(ang);
	const s = Math.sin(ang);
	const x = p[0] - about[0];
	const y = p[1] - about[1];
	return [about[0] + x * c - y * s, about[1] + x * s + y * c];
}

/** Principal axes: centroid, angle of the major axis, variances along major/minor. */
function pca(pts: readonly XY[]): { cx: number; cy: number; angle: number; l1: number; l2: number } {
	let cx = 0;
	let cy = 0;
	for (const p of pts) {
		cx += p[0];
		cy += p[1];
	}
	cx /= pts.length;
	cy /= pts.length;
	let sxx = 0;
	let syy = 0;
	let sxy = 0;
	for (const p of pts) {
		const x = p[0] - cx;
		const y = p[1] - cy;
		sxx += x * x;
		syy += y * y;
		sxy += x * y;
	}
	sxx /= pts.length;
	syy /= pts.length;
	sxy /= pts.length;
	const angle = 0.5 * Math.atan2(2 * sxy, sxx - syy);
	const tr = sxx + syy;
	const det = Math.sqrt(Math.max(0, ((sxx - syy) / 2) ** 2 + sxy * sxy));
	return { cx, cy, angle, l1: tr / 2 + det, l2: Math.max(0, tr / 2 - det) };
}

function percentile(sorted: readonly number[], q: number): number {
	if (sorted.length === 0) return 0;
	const i = Math.min(sorted.length - 1, Math.max(0, Math.round(q * (sorted.length - 1))));
	return sorted[i];
}

/** Resample a polyline to `n` points at uniform arc-length spacing (first/last kept). */
export function resample(pts: readonly XY[], n: number): XY[] {
	if (pts.length === 0) return [];
	if (pts.length === 1 || n < 2) return [[pts[0][0], pts[0][1]]];
	const L = pathLength(pts);
	if (L === 0) return [[pts[0][0], pts[0][1]]];
	const step = L / (n - 1);
	const out: XY[] = [[pts[0][0], pts[0][1]]];
	let target = step;
	let walked = 0;
	for (let i = 1; i < pts.length && out.length < n - 1; i++) {
		const a = pts[i - 1];
		const b = pts[i];
		const seg = dist(a, b);
		while (seg > 0 && walked + seg >= target && out.length < n - 1) {
			const t = (target - walked) / seg;
			out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
			target += step;
		}
		walked += seg;
	}
	const last = pts[pts.length - 1];
	out.push([last[0], last[1]]);
	return out;
}

function dedupe(raw: readonly (readonly number[])[]): XY[] {
	const out: XY[] = [];
	for (const p of raw) {
		if (!Number.isFinite(p[0]) || !Number.isFinite(p[1])) continue;
		const last = out[out.length - 1];
		if (last && last[0] === p[0] && last[1] === p[1]) continue;
		out.push([p[0], p[1]]);
	}
	return out;
}

function bboxOf(pts: readonly XY[]): { minX: number; minY: number; maxX: number; maxY: number } {
	let minX = Infinity;
	let minY = Infinity;
	let maxX = -Infinity;
	let maxY = -Infinity;
	for (const p of pts) {
		minX = Math.min(minX, p[0]);
		maxX = Math.max(maxX, p[0]);
		minY = Math.min(minY, p[1]);
		maxY = Math.max(maxY, p[1]);
	}
	return { minX, minY, maxX, maxY };
}

// -------------------------------------------------------------------------------------------------
// Corners / fits
// -------------------------------------------------------------------------------------------------

/**
 * Sharp-turn indices of a uniformly resampled path. `closed`: indices wrap around.
 * Turning angle at i = angle between (p[i] − p[i−k]) and (p[i+k] − p[i]).
 */
export function findCorners(pts: readonly XY[], closed: boolean): number[] {
	const n = pts.length;
	const k = Math.max(2, Math.round(n * SHAPE_TUNING.cornerWindow));
	if (n < 2 * k + 1) return [];
	const at = (i: number) => pts[((i % n) + n) % n];
	const turn = new Array<number>(n).fill(0);
	const lo = closed ? 0 : k;
	const hi = closed ? n - 1 : n - 1 - k;
	for (let i = lo; i <= hi; i++) {
		const a = at(i - k);
		const b = at(i);
		const c = at(i + k);
		turn[i] = turnDeg(b[0] - a[0], b[1] - a[1], c[0] - b[0], c[1] - b[1]);
	}
	const cands: number[] = [];
	for (let i = lo; i <= hi; i++) {
		if (turn[i] < SHAPE_TUNING.cornerDeg) continue;
		let isMax = true;
		for (let d = -k; d <= k && isMax; d++) {
			if (d === 0) continue;
			const j = i + d;
			if (!closed && (j < lo || j > hi)) continue;
			const jj = ((j % n) + n) % n;
			// Strictly greater neighbours win; ties go to the earlier index.
			if (turn[jj] > turn[i] || (turn[jj] === turn[i] && d < 0)) isMax = false;
		}
		if (isMax) cands.push(i);
	}
	cands.sort((a, b) => turn[b] - turn[a]);
	const accepted: number[] = [];
	const sep = (a: number, b: number) => {
		const d = Math.abs(a - b);
		return closed ? Math.min(d, n - d) : d;
	};
	for (const c of cands) if (accepted.every((a) => sep(a, c) >= 2 * k)) accepted.push(c);
	return accepted.sort((a, b) => a - b);
}

/** Least-squares line through points: a point on it and a unit direction. */
function fitLine(pts: readonly XY[]): { p: XY; d: XY } {
	const f = pca(pts);
	return { p: [f.cx, f.cy], d: [Math.cos(f.angle), Math.sin(f.angle)] };
}

function intersect(l1: { p: XY; d: XY }, l2: { p: XY; d: XY }): XY | null {
	const cross = l1.d[0] * l2.d[1] - l1.d[1] * l2.d[0];
	if (Math.abs(cross) < Math.sin(12 * DEG)) return null;
	const dx = l2.p[0] - l1.p[0];
	const dy = l2.p[1] - l1.p[1];
	const t = (dx * l2.d[1] - dy * l2.d[0]) / cross;
	return [l1.p[0] + l1.d[0] * t, l1.p[1] + l1.d[1] * t];
}

/** Is the run of points between two vertices straight enough to be one side/segment? */
function straight(run: readonly XY[], a: XY, b: XY): boolean {
	const len = dist(a, b);
	if (len === 0) return false;
	const tol = SHAPE_TUNING.sideDevFrac * len + SHAPE_TUNING.sideDevPx;
	let max = 0;
	let sum = 0;
	for (const p of run) {
		const d = lineDist(p, a, b);
		max = Math.max(max, d);
		sum += d;
	}
	return max <= tol && sum / Math.max(1, run.length) <= tol / 2;
}

interface EllipseFit {
	cx: number;
	cy: number;
	rx: number;
	ry: number;
	rot: number;
	meanErr: number;
	maxErr: number;
}

/** Ellipse from principal axes + trimmed extents; residual = normalized radius deviation. */
function fitEllipse(pts: readonly XY[]): EllipseFit {
	const f = pca(pts);
	const e1: XY = [Math.cos(f.angle), Math.sin(f.angle)];
	const e2: XY = [-e1[1], e1[0]];
	const us: number[] = [];
	const vs: number[] = [];
	for (const p of pts) {
		const x = p[0] - f.cx;
		const y = p[1] - f.cy;
		us.push(x * e1[0] + y * e1[1]);
		vs.push(x * e2[0] + y * e2[1]);
	}
	const su = [...us].sort((a, b) => a - b);
	const sv = [...vs].sort((a, b) => a - b);
	const u0 = percentile(su, 0.01);
	const u1 = percentile(su, 0.99);
	const v0 = percentile(sv, 0.01);
	const v1 = percentile(sv, 0.99);
	const rx = Math.max((u1 - u0) / 2, 1e-6);
	const ry = Math.max((v1 - v0) / 2, 1e-6);
	const cu = (u0 + u1) / 2;
	const cv = (v0 + v1) / 2;
	let sum = 0;
	let max = 0;
	for (let i = 0; i < us.length; i++) {
		const r = Math.hypot((us[i] - cu) / rx, (vs[i] - cv) / ry);
		const e = Math.abs(r - 1);
		sum += e;
		max = Math.max(max, e);
	}
	return {
		cx: f.cx + cu * e1[0] + cv * e2[0],
		cy: f.cy + cu * e1[1] + cv * e2[1],
		rx,
		ry,
		rot: f.angle,
		meanErr: sum / us.length,
		maxErr: max,
	};
}

/** Snap an angle (rad) to the nearest multiple of 90° if within `tolDeg`; result in (−π/2, π/2]. */
function snapAxis(angle: number, tolDeg: number): number {
	let a = angle;
	while (a > Math.PI / 2) a -= Math.PI;
	while (a <= -Math.PI / 2) a += Math.PI;
	const quarter = Math.round(a / (Math.PI / 2)) * (Math.PI / 2);
	return Math.abs(a - quarter) <= tolDeg * DEG ? quarter : a;
}

function ellipseSpec(e: EllipseFit): ShapeSpec | null {
	const T = SHAPE_TUNING;
	if (e.meanErr > T.ellipseMeanErr || e.maxErr > T.ellipseMaxErr) return null;
	if (Math.min(e.rx, e.ry) < 3) return null;
	if (Math.min(e.rx, e.ry) / Math.max(e.rx, e.ry) >= T.circleRatio) {
		const r = (e.rx + e.ry) / 2;
		return { kind: "circle", cx: e.cx, cy: e.cy, rx: r, ry: r, rot: 0 };
	}
	let rot = snapAxis(e.rot, T.axisSnapDeg);
	let { rx, ry } = e;
	if (Math.abs(Math.abs(rot) - Math.PI / 2) < 1e-9) {
		// Vertical major axis: express as an axis-aligned ellipse.
		rot = 0;
		[rx, ry] = [ry, rx];
	}
	return { kind: "ellipse", cx: e.cx, cy: e.cy, rx, ry, rot };
}

// -------------------------------------------------------------------------------------------------
// Recognition
// -------------------------------------------------------------------------------------------------

/**
 * Recognize a clean shape in a hand-drawn stroke (points `[x, y, ...]`, any extra fields ignored).
 * Returns null when not confident — the caller keeps the stroke as drawn.
 */
export function recognizeShape(raw: readonly (readonly number[])[]): ShapeSpec | null {
	const T = SHAPE_TUNING;
	const pts = dedupe(raw);
	if (pts.length < 2) return null;
	const box = bboxOf(pts);
	const diag = Math.hypot(box.maxX - box.minX, box.maxY - box.minY);
	if (diag < T.minSize) return null;
	const trimmed = trimHoldTail(pts, diag);
	const L = pathLength(trimmed);
	const n = Math.min(T.maxSamples, Math.max(T.minSamples, Math.round(L / T.spacing)));
	const r = resample(trimmed, n);

	// Arrow before the closure test: a big head's barb can end near a short shaft's start.
	const arrow = asArrow(r);
	if (arrow) return arrow;
	const cut = findClosure(r, diag);
	if (cut >= 0) return recognizeClosed(r.slice(0, cut + 1), diag);
	return recognizeOpen(r, diag);
}

/**
 * Collapse the hold tail: while the pen is held still for the snap it keeps reporting points (a small
 * settling hook plus drift within the hold tolerance). They add path length and move the end point,
 * so the trailing points within a small radius of the last point are replaced by their centroid.
 */
export function trimHoldTail(pts: readonly XY[], diag: number): XY[] {
	const T = SHAPE_TUNING;
	const R = Math.min(T.holdTailMaxPx, Math.max(T.holdTailMinPx, T.holdTailFrac * diag));
	const last = pts[pts.length - 1];
	let i = pts.length - 1;
	while (i > 0 && dist(pts[i - 1], last) <= R) i--;
	if (i === 0 || i === pts.length - 1) return pts.slice();
	let cx = 0;
	let cy = 0;
	for (let j = i; j < pts.length; j++) {
		cx += pts[j][0];
		cy += pts[j][1];
	}
	const m = pts.length - i;
	return [...pts.slice(0, i), [cx / m, cy / m]];
}

/** Index where a path returns to its start (closed loop), or −1 for an open path. */
function findClosure(r: readonly XY[], diag: number): number {
	const T = SHAPE_TUNING;
	const n = r.length;
	const thr = Math.max(T.closeMinPx, T.closeFrac * diag);
	// The end must be well away from the start somewhere in between (excludes there-and-back lines).
	let far = 0;
	for (const p of r) far = Math.max(far, dist(p, r[0]));
	if (far < 2 * thr) return -1;
	let best = -1;
	let bestD = Infinity;
	for (let i = Math.floor(n * 0.5); i < n; i++) {
		const d = dist(r[i], r[0]);
		if (d < bestD) {
			bestD = d;
			best = i;
		}
	}
	return bestD <= thr ? best : -1;
}

function recognizeClosed(loopIn: readonly XY[], diag: number): ShapeSpec | null {
	// Drop the closing point if it (nearly) duplicates the start.
	let loop = loopIn.slice();
	while (loop.length > 3 && dist(loop[loop.length - 1], loop[0]) < SHAPE_TUNING.spacing) loop = loop.slice(0, -1);
	if (loop.length < 8) return null;
	const ell = fitEllipse(loop);
	const corners = findCorners(loop, true);
	if (corners.length >= 3 && corners.length <= 8) {
		const poly = fitPolygon(loop, corners, diag);
		if (poly) return poly;
	}
	return ellipseSpec(ell);
}

function fitPolygon(loop: readonly XY[], corners: readonly number[], diag: number): ShapeSpec | null {
	const T = SHAPE_TUNING;
	const n = loop.length;
	const m = corners.length;
	const k = Math.max(2, Math.round(n * T.cornerWindow));
	const lines: { p: XY; d: XY }[] = [];
	for (let j = 0; j < m; j++) {
		const s = corners[j];
		const e = corners[(j + 1) % m];
		const run: XY[] = [];
		const count = (e - s + n) % n || n;
		for (let t = 0; t <= count; t++) run.push(loop[(s + t) % n]);
		const a = loop[s];
		const b = loop[e];
		if (dist(a, b) < Math.max(6, 0.08 * diag)) return null;
		if (!straight(run, a, b)) return null;
		// Fit the side on its middle part (corners are rounded by hand).
		const trim = Math.min(Math.floor(run.length * 0.15), k);
		const mid = run.slice(trim, run.length - trim);
		lines.push(fitLine(mid.length >= 2 ? mid : run));
	}
	const vertices: XY[] = [];
	for (let j = 0; j < m; j++) {
		const corner = loop[corners[j]];
		const v = intersect(lines[(j - 1 + m) % m], lines[j]);
		vertices.push(v && dist(v, corner) <= 0.25 * diag ? v : [corner[0], corner[1]]);
	}
	if (m === 3) return { kind: "triangle", vertices };
	if (m === 4) {
		const rect = asRectangle(vertices);
		if (rect) return rect;
	}
	return { kind: "polygon", vertices };
}

/** Four vertices with ~90° corners → a clean (possibly rotated) rectangle. */
function asRectangle(v: readonly XY[]): ShapeSpec | null {
	const T = SHAPE_TUNING;
	for (let j = 0; j < 4; j++) {
		const a = v[(j + 3) % 4];
		const b = v[j];
		const c = v[(j + 1) % 4];
		const ang = turnDeg(a[0] - b[0], a[1] - b[1], c[0] - b[0], c[1] - b[1]);
		if (Math.abs(ang - 90) > T.rectAngleTol) return null;
	}
	// Average edge direction modulo 90° (via 4θ), snapped to the axes when close.
	let sx = 0;
	let sy = 0;
	for (let j = 0; j < 4; j++) {
		const a = v[j];
		const b = v[(j + 1) % 4];
		const phi = Math.atan2(b[1] - a[1], b[0] - a[0]);
		sx += Math.cos(4 * phi);
		sy += Math.sin(4 * phi);
	}
	let theta = Math.atan2(sy, sx) / 4; // (−45°, 45°]
	if (Math.abs(theta) <= T.axisSnapDeg * DEG) theta = 0;
	const local = v.map((p) => rotate(p, -theta));
	const xs = local.map((p) => p[0]).sort((a, b) => a - b);
	const ys = local.map((p) => p[1]).sort((a, b) => a - b);
	const x0 = (xs[0] + xs[1]) / 2;
	const x1 = (xs[2] + xs[3]) / 2;
	const y0 = (ys[0] + ys[1]) / 2;
	const y1 = (ys[2] + ys[3]) / 2;
	const corners: XY[] = [
		[x0, y0],
		[x1, y0],
		[x1, y1],
		[x0, y1],
	];
	return { kind: "rectangle", vertices: corners.map((p) => rotate(p, theta)) };
}

function recognizeOpen(r: readonly XY[], diag: number): ShapeSpec | null {
	// (Arrows were tried first, in recognizeShape: the hook-tolerant line test would otherwise swallow
	// a short head.) Line before polyline: a near-straight stroke must never fall through to the corner logic.
	const line = asLine(r);
	if (line) return line;
	const poly = asPolyline(r, diag);
	if (poly) return poly;
	// Last: smooth curves (arc / parabola / cubic). Strict fit + size + total-turning limits keep
	// handwriting out.
	return asCurve(r);
}

/** 2–8 straight segments with sharp corners (no retracing) → polyline; 2 segments at ~90° → right angle. */
function asPolyline(rIn: readonly XY[], diag: number): ShapeSpec | null {
	let r = rIn;
	const T = SHAPE_TUNING;
	let corners = findCorners(r, false);
	// A "corner" within a hook's length of either end is the pen landing or the settling hook before
	// the hold (what the hold-tail trim leaves of it), not a vertex: cut it off.
	const hook = Math.min(T.lineEndTrimPx, T.lineEndTrimFrac * pathLength(r));
	if (corners.length >= 2 && pathLength(r.slice(corners[corners.length - 1])) <= hook) {
		r = r.slice(0, corners[corners.length - 1] + 1);
		corners = corners.slice(0, -1);
	}
	if (corners.length >= 2 && pathLength(r.slice(0, corners[0] + 1)) <= hook) {
		const c0 = corners[0];
		r = r.slice(c0);
		corners = corners.slice(1).map((c) => c - c0);
	}
	if (corners.length === 0 || corners.length > 7) return null;
	const idx = [0, ...corners, r.length - 1];
	const verts = idx.map((i) => r[i]);
	for (let j = 0; j + 1 < idx.length; j++) {
		if (!straight(r.slice(idx[j], idx[j + 1] + 1), verts[j], verts[j + 1])) return null;
		if (dist(verts[j], verts[j + 1]) < Math.max(8, T.minSegFrac * diag)) return null;
	}
	// Retracing a segment (a ~180° turn, like the stems of a printed "m") is handwriting, not a shape.
	for (let j = 1; j + 1 < verts.length; j++) {
		const a = verts[j - 1];
		const b = verts[j];
		const c = verts[j + 1];
		if (turnDeg(b[0] - a[0], b[1] - a[1], c[0] - b[0], c[1] - b[1]) > T.maxPolylineTurnDeg) return null;
	}
	if (verts.length === 3) {
		const right = asRightAngle(r, idx[1]);
		if (right) return right;
	}
	return { kind: "polyline", vertices: verts.map((p): XY => [p[0], p[1]]) };
}

/**
 * Two straight legs meeting at ~90° (graph axes, an "L" in any orientation, a "V" opened ~90°) →
 * exact right angle. Each leg is fitted on its middle part (the corner is rounded or overshot by
 * hand, the ends hook); the corner is the intersection of the two fits. The frame angle is the
 * length-weighted mean of the two legs' directions (each leg's direction implies one for the frame),
 * snapped to the axes within rightAngleAxisDeg. Leg lengths: projection of the start (leg 1) and of
 * the farthest point (leg 2) onto the legs. Null when the corner is not within 90° ± rightAngleTolDeg.
 */
function asRightAngle(r: readonly XY[], c: number): ShapeSpec | null {
	const T = SHAPE_TUNING;
	const n = r.length;
	const k = Math.max(2, Math.round(n * T.cornerWindow));
	const legFit = (from: number, to: number): { p: XY; d: XY } | null => {
		const m = to - from;
		const trimCorner = Math.max(k, Math.floor(0.15 * m));
		const trimEnd = Math.floor(0.08 * m);
		const run = from === 0 ? r.slice(trimEnd, to - trimCorner + 1) : r.slice(from + trimCorner, to - trimEnd + 1);
		return run.length >= 3 ? fitLine(run) : null;
	};
	const f1 = legFit(0, c);
	const f2 = legFit(c, n - 1);
	if (!f1 || !f2) return null;
	const cand = intersect(f1, f2);
	const rough: XY = cand && dist(cand, r[c]) <= 0.25 * dist(r[0], r[n - 1]) ? cand : [r[c][0], r[c][1]];
	// Leg directions pointing away from the corner.
	const orient = (d: XY, toward: XY): XY =>
		(toward[0] - rough[0]) * d[0] + (toward[1] - rough[1]) * d[1] < 0 ? [-d[0], -d[1]] : d;
	const d1 = orient(f1.d, r[0]);
	const d2 = orient(f2.d, r[n - 1]);
	const ang = turnDeg(d1[0], d1[1], d2[0], d2[1]);
	if (Math.abs(ang - 90) > T.rightAngleTolDeg) return null;
	// σ: leg 2 is leg 1 turned by +90° or −90°.
	const sigma = d1[0] * d2[1] - d1[1] * d2[0] >= 0 ? 1 : -1;
	const w1 = dist(r[0], rough);
	const w2 = dist(r[n - 1], rough);
	const th1 = Math.atan2(d1[1], d1[0]);
	const th2 = Math.atan2(d2[1], d2[0]) - (sigma * Math.PI) / 2;
	let theta = Math.atan2(w1 * Math.sin(th1) + w2 * Math.sin(th2), w1 * Math.cos(th1) + w2 * Math.cos(th2));
	theta = snapAxisFull(theta, T.rightAngleAxisDeg);
	const e1: XY = Number.isInteger(theta / (Math.PI / 2))
		? [Math.round(Math.cos(theta)), Math.round(Math.sin(theta))] // exact axis directions
		: [Math.cos(theta), Math.sin(theta)];
	const e2: XY = sigma > 0 ? [-e1[1], e1[0]] : [e1[1], -e1[0]];
	// Final corner: each clean leg passes through the centroid of its drawn middle part (so a tilted
	// or overshot leg is placed where it was mostly drawn, not where it met the other leg).
	const corner = intersect({ p: f1.p, d: e1 }, { p: f2.p, d: e2 }) ?? rough;
	const proj = (p: XY, e: XY) => (p[0] - corner[0]) * e[0] + (p[1] - corner[1]) * e[1];
	const len1 = proj(r[0], e1);
	let len2 = 0;
	for (let i = c; i < n; i++) len2 = Math.max(len2, proj(r[i], e2));
	if (len1 < T.minSize * 0.5 || len2 < T.minSize * 0.5) return null;
	// On an axis only the moving coordinate changes (exactly horizontal/vertical legs).
	const at = (e: XY, len: number): XY => [
		e[0] === 0 ? corner[0] : corner[0] + e[0] * len,
		e[1] === 0 ? corner[1] : corner[1] + e[1] * len,
	];
	return { kind: "polyline", vertices: [at(e1, len1), [corner[0], corner[1]], at(e2, len2)], rightAngle: true };
}

// -------------------------------------------------------------------------------------------------
// Smooth curves: arc, parabola, cubic
// -------------------------------------------------------------------------------------------------

/** Error stats of a fit: max and mean distance of the core, max distance of the trimmed ends. */
interface FitErr {
	max: number;
	mean: number;
	rms: number;
	ends: number;
}

function errStats(core: readonly XY[], ends: readonly XY[], d: (p: XY) => number): FitErr {
	let max = 0;
	let sum = 0;
	let sq = 0;
	for (const p of core) {
		const e = d(p);
		max = Math.max(max, e);
		sum += e;
		sq += e * e;
	}
	let endMax = 0;
	for (const p of ends) endMax = Math.max(endMax, d(p));
	return { max, mean: sum / core.length, rms: Math.sqrt(sq / core.length), ends: endMax };
}

const fitOk = (e: FitErr, tol: number) => e.max <= tol && e.mean <= tol / 2 && e.ends <= 2 * tol;

/** Total absolute turning (deg) of a path, measured on ~20 chords so hand jitter doesn't add up. */
function totalTurning(r: readonly XY[]): number {
	const step = Math.max(1, Math.round(r.length / 20));
	const pts: XY[] = [];
	for (let i = 0; i < r.length; i += step) pts.push(r[i]);
	if (pts[pts.length - 1] !== r[r.length - 1]) pts.push(r[r.length - 1]);
	let sum = 0;
	for (let i = 1; i + 1 < pts.length; i++) {
		const a = pts[i - 1];
		const b = pts[i];
		const c = pts[i + 1];
		sum += turnDeg(b[0] - a[0], b[1] - a[1], c[0] - b[0], c[1] - b[1]);
	}
	return sum;
}

/** Solve a 3×3 linear system (Cramer); null when singular. */
function solve3(m: number[][], v: number[]): [number, number, number] | null {
	const det = (a: number[][]) =>
		a[0][0] * (a[1][1] * a[2][2] - a[1][2] * a[2][1]) -
		a[0][1] * (a[1][0] * a[2][2] - a[1][2] * a[2][0]) +
		a[0][2] * (a[1][0] * a[2][1] - a[1][1] * a[2][0]);
	const D = det(m);
	if (!Number.isFinite(D) || Math.abs(D) < 1e-12) return null;
	const col = (j: number) => m.map((row, i) => row.map((x, k) => (k === j ? v[i] : x)));
	return [det(col(0)) / D, det(col(1)) / D, det(col(2)) / D];
}

/**
 * Open smooth stroke → arc, parabola or (fallback) one cubic Bézier. Fitted on the core (the path
 * minus the landing / settling hooks); the shape runs from the core's start to its end.
 */
function asCurve(r: readonly XY[]): ShapeSpec | null {
	const T = SHAPE_TUNING;
	const n = r.length;
	let s0 = 0;
	let walked = 0;
	while (s0 < n - 1 && walked + dist(r[s0], r[s0 + 1]) <= T.curveStartTrimPx) {
		walked += dist(r[s0], r[s0 + 1]);
		s0++;
	}
	let s1 = n - 1;
	walked = 0;
	while (s1 > s0 && walked + dist(r[s1], r[s1 - 1]) <= T.curveEndTrimPx) {
		walked += dist(r[s1], r[s1 - 1]);
		s1--;
	}
	if (s1 - s0 < 8) return null;
	const core = r.slice(s0, s1 + 1);
	const ends = [...r.slice(0, s0), ...r.slice(s1 + 1)];
	const box = bboxOf(core);
	const size = Math.hypot(box.maxX - box.minX, box.maxY - box.minY);
	if (size < T.curveMinSize) return null;
	if (totalTurning(core) > T.curveMaxTurnDeg) return null;
	const tol = Math.max(T.curveDevPx, T.curveDevFrac * size);

	// Every model that fits is a candidate; the simplest one (arc, then parabola, then cubic) wins
	// unless a more flexible one is clearly closer.
	const arc = fitArc(core, ends, size);
	const cands = [arc && fitOk(arc.err, tol) ? arc : null, fitParabola(core, ends, tol), fitCubic(core, ends, tol)].filter(
		(c): c is { spec: ShapeSpec; err: FitErr } => c !== null,
	);
	if (cands.length === 0) return null;
	const best = Math.min(...cands.map((c) => c.err.max));
	const slack = Math.max(T.curveSlackPx, T.curveSlackFrac * size);
	return (cands.find((c) => c.err.max <= best + slack) ?? cands[0]).spec;
}

function fitArc(core: readonly XY[], ends: readonly XY[], size: number): { spec: ShapeSpec; err: FitErr } | null {
	const T = SHAPE_TUNING;
	// Kåsa algebraic circle fit: x² + y² + D x + E y + F = 0 (centered for conditioning).
	let mx = 0;
	let my = 0;
	for (const p of core) {
		mx += p[0];
		my += p[1];
	}
	mx /= core.length;
	my /= core.length;
	let sxx = 0, sxy = 0, syy = 0, sx = 0, sy = 0, sxz = 0, syz = 0, sz = 0;
	for (const p of core) {
		const x = p[0] - mx;
		const y = p[1] - my;
		const z = x * x + y * y;
		sxx += x * x;
		sxy += x * y;
		syy += y * y;
		sx += x;
		sy += y;
		sxz += x * z;
		syz += y * z;
		sz += z;
	}
	const sol = solve3(
		[
			[sxx, sxy, sx],
			[sxy, syy, sy],
			[sx, sy, core.length],
		],
		[-sxz, -syz, -sz],
	);
	if (!sol) return null;
	const [D, E, F] = sol;
	let cx = mx - D / 2;
	let cy = my - E / 2;
	const R2 = (D * D + E * E) / 4 - F;
	if (!(R2 > 0)) return null;
	let R = Math.sqrt(R2);
	// Refine geometrically (Gauss–Newton on Σ (|p − c| − R)²): the algebraic fit is biased on short arcs.
	for (let iter = 0; iter < 5; iter++) {
		const M = [
			[0, 0, 0],
			[0, 0, 0],
			[0, 0, 0],
		];
		const g = [0, 0, 0];
		for (const p of core) {
			const dx = p[0] - cx;
			const dy = p[1] - cy;
			const d = Math.hypot(dx, dy) || 1e-9;
			const J = [-dx / d, -dy / d, -1];
			const res = d - R;
			for (let a = 0; a < 3; a++) {
				g[a] -= J[a] * res;
				for (let b = 0; b < 3; b++) M[a][b] += J[a] * J[b];
			}
		}
		const step = solve3(M, g);
		if (!step) break;
		cx += step[0];
		cy += step[1];
		R += step[2];
		if (Math.hypot(step[0], step[1], step[2]) < 1e-3) break;
	}
	if (!(R > 0) || !Number.isFinite(cx + cy + R)) return null;
	if (R > T.arcMaxRadiusFactor * size) return null;
	// Unwrapped angle along the path: must progress one way (no back and forth).
	let ang = Math.atan2(core[0][1] - cy, core[0][0] - cx);
	const start = ang;
	let total = 0;
	for (let i = 1; i < core.length; i++) {
		let d = Math.atan2(core[i][1] - cy, core[i][0] - cx) - Math.atan2(core[i - 1][1] - cy, core[i - 1][0] - cx);
		if (d > Math.PI) d -= 2 * Math.PI;
		if (d < -Math.PI) d += 2 * Math.PI;
		ang += d;
		total += Math.abs(d);
	}
	const sweep = ang - start;
	const back = (total - Math.abs(sweep)) / 2;
	if (back > 0.1 * Math.abs(sweep) + 3 * DEG) return null;
	const sw = Math.abs(sweep) / DEG;
	if (sw < T.arcMinSweepDeg || sw > T.arcMaxSweepDeg) return null;
	const err = errStats(core, ends, (p) => Math.abs(Math.hypot(p[0] - cx, p[1] - cy) - R));
	return { spec: { kind: "arc", cx, cy, r: R, start, sweep }, err };
}

/** Coordinate frame for a parabola fit; the axis frames (0°, 90°) are exact (no trig round-off). */
function frameOf(theta: number | "x" | "y"): { to: (p: XY) => XY; from: (p: XY) => XY } {
	if (theta === "x") return { to: (p) => [p[0], p[1]], from: (p) => [p[0], p[1]] };
	if (theta === "y") return { to: (p) => [p[1], -p[0]], from: (p) => [-p[1], p[0]] };
	return { to: (p) => rotate(p, -theta), from: (p) => rotate(p, theta) };
}

/**
 * Parabola v = αu² + βu + γ in a frame where u runs one way along the stroke (a function graph).
 * Frames tried: horizontal axis-of-u ("x": opening up/down), vertical ("y": opening sideways), then
 * the principal axes. An axis frame that fits wins (graph parabolas are axis-aligned); otherwise the
 * best rotated one. Error = vertical residual over √(1 + slope²) (≈ perpendicular distance).
 */
function fitParabola(core: readonly XY[], ends: readonly XY[], tol: number): { spec: ShapeSpec; err: FitErr } | null {
	const f = pca(core);
	const frames: (number | "x" | "y")[] = ["x", "y", f.angle, f.angle + Math.PI / 2];
	let best: { spec: ShapeSpec; err: FitErr } | null = null;
	for (const [i, th] of frames.entries()) {
		const fr = frameOf(th);
		const uv = core.map(fr.to);
		const n = uv.length;
		const u0 = uv[0][0];
		const u1 = uv[n - 1][0];
		const range = Math.abs(u1 - u0);
		if (range < 1e-6) continue;
		// u must progress one way (allow jitter).
		const sgn = Math.sign(u1 - u0);
		let back = 0;
		let lo = Infinity;
		let hi = -Infinity;
		for (let k = 1; k < n; k++) back += Math.max(0, -sgn * (uv[k][0] - uv[k - 1][0]));
		for (const p of uv) {
			lo = Math.min(lo, p[0]);
			hi = Math.max(hi, p[0]);
		}
		if (back > 0.04 * range + 4 || hi - lo > 1.1 * range + 4) continue;
		// Least squares in centered u.
		const um = (u0 + u1) / 2;
		let s0 = 0, s1 = 0, s2 = 0, s3 = 0, s4 = 0, t0 = 0, t1 = 0, t2 = 0;
		for (const [u, v] of uv) {
			const x = u - um;
			s0 += 1;
			s1 += x;
			s2 += x * x;
			s3 += x * x * x;
			s4 += x * x * x * x;
			t0 += v;
			t1 += x * v;
			t2 += x * x * v;
		}
		const sol = solve3(
			[
				[s4, s3, s2],
				[s3, s2, s1],
				[s2, s1, s0],
			],
			[t2, t1, t0],
		);
		if (!sol) continue;
		const [A, B, C] = sol;
		const val = (u: number) => A * (u - um) ** 2 + B * (u - um) + C;
		const slope = (u: number) => 2 * A * (u - um) + B;
		const dist2 = (p: XY) => {
			const [u, v] = fr.to(p);
			return Math.abs(v - val(u)) / Math.sqrt(1 + slope(u) ** 2);
		};
		const err = errStats(core, ends, dist2);
		if (!fitOk(err, tol)) continue;
		// Quadratic Bézier of the segment u0..u1 (exact): control at the tangents' intersection.
		const ctrl: XY = [(u0 + u1) / 2, val(u0) + (slope(u0) * (u1 - u0)) / 2];
		const spec: ShapeSpec = { kind: "parabola", a: fr.from([u0, val(u0)]), c: fr.from(ctrl), b: fr.from([u1, val(u1)]) };
		if (!best || err.rms < best.err.rms) best = { spec, err };
		// Axis frames come first: if one of them fits, don't look at rotated frames.
		if (i === 1 && best) break;
	}
	return best;
}

function bez(ps: readonly XY[], t: number): XY {
	// de Casteljau
	let pts = ps.map((p): XY => [p[0], p[1]]);
	while (pts.length > 1) {
		const next: XY[] = [];
		for (let i = 0; i + 1 < pts.length; i++)
			next.push([pts[i][0] + (pts[i + 1][0] - pts[i][0]) * t, pts[i][1] + (pts[i + 1][1] - pts[i][1]) * t]);
		pts = next;
	}
	return pts[0];
}

/**
 * One cubic Bézier through the core's end points, least-squares inner control points with
 * chord-length parameters refined by a few Newton steps (Schneider). Null if it doesn't fit.
 */
function fitCubic(core: readonly XY[], ends: readonly XY[], tol: number): { spec: ShapeSpec; err: FitErr } | null {
	const n = core.length;
	const P0 = core[0];
	const P3 = core[n - 1];
	const ts: number[] = [0];
	for (let i = 1; i < n; i++) ts.push(ts[i - 1] + dist(core[i - 1], core[i]));
	const L = ts[n - 1];
	if (L <= 0) return null;
	for (let i = 0; i < n; i++) ts[i] /= L;
	let c1: XY = P0;
	let c2: XY = P3;
	for (let iter = 0; iter < 6; iter++) {
		// Solve for c1, c2: Σ (B(t) − p)² with B = b0 P0 + b1 c1 + b2 c2 + b3 P3.
		let a11 = 0, a12 = 0, a22 = 0;
		const r1: XY = [0, 0];
		const r2: XY = [0, 0];
		for (let i = 0; i < n; i++) {
			const t = ts[i];
			const mt = 1 - t;
			const b0 = mt * mt * mt;
			const b1 = 3 * mt * mt * t;
			const b2 = 3 * mt * t * t;
			const b3 = t * t * t;
			a11 += b1 * b1;
			a12 += b1 * b2;
			a22 += b2 * b2;
			for (const k of [0, 1] as const) {
				const rest = core[i][k] - b0 * P0[k] - b3 * P3[k];
				r1[k] += b1 * rest;
				r2[k] += b2 * rest;
			}
		}
		const det = a11 * a22 - a12 * a12;
		if (Math.abs(det) < 1e-12) return null;
		c1 = [(r1[0] * a22 - r2[0] * a12) / det, (r1[1] * a22 - r2[1] * a12) / det];
		c2 = [(a11 * r2[0] - a12 * r1[0]) / det, (a11 * r2[1] - a12 * r1[1]) / det];
		// Newton step on each parameter: minimize |B(t) − p|.
		const P = [P0, c1, c2, P3];
		const d1 = [0, 1, 2].map((i): XY => [3 * (P[i + 1][0] - P[i][0]), 3 * (P[i + 1][1] - P[i][1])]);
		const d2 = [0, 1].map((i): XY => [2 * (d1[i + 1][0] - d1[i][0]), 2 * (d1[i + 1][1] - d1[i][1])]);
		for (let i = 1; i < n - 1; i++) {
			const t = ts[i];
			const q = bez(P, t);
			const q1 = bez(d1, t);
			const q2 = bez(d2, t);
			const ex = q[0] - core[i][0];
			const ey = q[1] - core[i][1];
			const num = ex * q1[0] + ey * q1[1];
			const den = q1[0] * q1[0] + q1[1] * q1[1] + ex * q2[0] + ey * q2[1];
			if (Math.abs(den) > 1e-12) ts[i] = Math.min(1, Math.max(0, t - num / den));
		}
	}
	const P: XY[] = [P0, c1, c2, P3];
	// Error: distance to the nearest point of the densified curve (robust to parameter drift).
	const dense: XY[] = [];
	for (let i = 0; i <= 200; i++) dense.push(bez(P, i / 200));
	const near = (p: XY) => {
		let m = Infinity;
		for (let i = 1; i < dense.length; i++) {
			const a = dense[i - 1];
			const b = dense[i];
			const dx = b[0] - a[0];
			const dy = b[1] - a[1];
			const l2 = dx * dx + dy * dy;
			const t = l2 > 0 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2)) : 0;
			m = Math.min(m, Math.hypot(p[0] - a[0] - dx * t, p[1] - a[1] - dy * t));
		}
		return m;
	};
	const err = errStats(core, ends, near);
	if (!fitOk(err, tol)) return null;
	// The clean curve must not turn more than the stroke (no loops/cusps from wild control points).
	if (totalTurning(dense) > SHAPE_TUNING.curveMaxTurnDeg) return null;
	return { spec: { kind: "curve", a: [P0[0], P0[1]], c1, c2, b: [P3[0], P3[1]] }, err };
}

/**
 * Near-straight open stroke → line. Hand-drawn lines bow slightly, jitter, and hook at either end
 * (pen landing / settling for the hold), so the test is on the best-fit line of the path's core with
 * looser bounds for the short end parts. Ends: projections of the first point and of the farthest
 * point onto the fit (a hook bending back does not shorten the line).
 */
function asLine(r: readonly XY[]): ShapeSpec | null {
	const T = SHAPE_TUNING;
	const n = r.length;
	const chord = dist(r[0], r[n - 1]);
	if (chord < T.minSize * 0.8) return null;
	const L = pathLength(r);
	const trimStart = Math.min(T.lineStartTrimPx, T.lineEndTrimFrac * L);
	const trimEnd = Math.min(T.lineEndTrimPx, T.lineEndTrimFrac * L);
	let s0 = 0;
	let walked = 0;
	while (s0 < n - 1 && walked + dist(r[s0], r[s0 + 1]) <= trimStart) {
		walked += dist(r[s0], r[s0 + 1]);
		s0++;
	}
	let s1 = n - 1;
	walked = 0;
	while (s1 > s0 && walked + dist(r[s1], r[s1 - 1]) <= trimEnd) {
		walked += dist(r[s1], r[s1 - 1]);
		s1--;
	}
	if (s1 - s0 < 4) return null;
	const core = r.slice(s0, s1 + 1);
	const coreChord = dist(core[0], core[core.length - 1]);
	if (coreChord < T.minSize * 0.6 || pathLength(core) > T.lineLenRatio * coreChord) return null;
	const fit = fitLine(core);
	const tol = Math.max(Math.min(T.lineDevPx, Math.max(3, 0.08 * chord)), T.lineDevFrac * chord);
	const off = (p: XY) => Math.abs((p[0] - fit.p[0]) * fit.d[1] - (p[1] - fit.p[1]) * fit.d[0]);
	for (let i = 0; i < n; i++) {
		const inCore = i >= s0 && i <= s1;
		if (off(r[i]) > (inCore ? tol : T.lineEndDevFactor * tol)) return null;
	}
	// Orient the fit from the start towards the end.
	let d = fit.d;
	if ((r[n - 1][0] - r[0][0]) * d[0] + (r[n - 1][1] - r[0][1]) * d[1] < 0) d = [-d[0], -d[1]];
	const t = (p: XY) => (p[0] - fit.p[0]) * d[0] + (p[1] - fit.p[1]) * d[1];
	const t0 = t(r[0]);
	let t1 = -Infinity;
	for (const p of r) t1 = Math.max(t1, t(p));
	const len = t1 - t0;
	if (len < T.minSize * 0.8) return null;
	const a: XY = [fit.p[0] + d[0] * t0, fit.p[1] + d[1] * t0];
	const ang = snapAxisFull(Math.atan2(d[1], d[0]), T.lineSnapDeg);
	return { kind: "line", a, b: [a[0] + Math.cos(ang) * len, a[1] + Math.sin(ang) * len] };
}

/** Snap a full direction angle (rad, any range) to 0/90/180/270° when within `tolDeg`. */
function snapAxisFull(angle: number, tolDeg: number): number {
	const quarter = Math.round(angle / (Math.PI / 2)) * (Math.PI / 2);
	return Math.abs(angle - quarter) <= tolDeg * DEG ? quarter : angle;
}

/**
 * Arrow: a straight shaft from the start to the tip (the point farthest from the start), followed by
 * a head of 1–2 barbs. Each barb is an excursion away from the tip, bent back arrowMinDeg..arrowMaxDeg
 * off the backward shaft direction; it may return to the tip (the user's way: shaft → barb → back →
 * other barb → back) or end there (shaft → hook). Two barbs must be on opposite sides of the shaft,
 * and the head never reaches past the tip. Result: a clean arrow with two symmetric barbs (see
 * `arrowBarbs`) whose length is the mean drawn barb length.
 */
function asArrow(r: readonly XY[]): ShapeSpec | null {
	const n = r.length;
	const tail = r[0];
	let far = 0;
	for (let i = 1; i < n; i++) far = Math.max(far, dist(tail, r[i]));
	// Tip: the FIRST arrival near the farthest distance (returns from a barb come back to about the
	// same place and may land a little farther out), then on to that local maximum.
	const near = far - Math.max(6, 0.04 * far);
	let first = 1;
	while (first < n - 1 && dist(tail, r[first]) < near) first++;
	while (first < n - 1 && dist(tail, r[first + 1]) >= dist(tail, r[first])) first++;
	// A ">" head drawn after the shaft puts the tip a little beyond the shaft end: also try the
	// farthest point itself as the tip.
	let farIdx = 1;
	for (let i = 1; i < n; i++) if (dist(tail, r[i]) > dist(tail, r[farIdx])) farIdx = i;
	return arrowAt(r, first) ?? (farIdx !== first ? arrowAt(r, farIdx) : null);
}

/** `asArrow` with the tip at index `tipIdx`. */
function arrowAt(r: readonly XY[], tipIdx: number): ShapeSpec | null {
	const T = SHAPE_TUNING;
	const n = r.length;
	const tail = r[0];
	if (tipIdx >= n - 2 || dist(tail, r[tipIdx]) < T.arrowMinShaftPx) return null;
	const tip = r[tipIdx];

	// Shaft end: where the pen first turns back. Normally the tip itself; a ">" head drawn
	// shaft → back-barb → tip → other barb has its first barb BEFORE the tip.
	const S0 = dist(tail, tip);
	const d0: XY = [(tip[0] - tail[0]) / S0, (tip[1] - tail[1]) / S0];
	// (Retreats before 40% of the way are the landing curl, not a shaft end.)
	const backThr = Math.max(2, 0.06 * S0);
	let e = tipIdx;
	let bestP = -Infinity;
	let bestI = 0;
	for (let i = 0; i <= tipIdx; i++) {
		const pr = (r[i][0] - tail[0]) * d0[0] + (r[i][1] - tail[1]) * d0[1];
		if (pr > bestP) {
			bestP = pr;
			bestI = i;
		} else if (pr < bestP - backThr && bestP >= 0.4 * S0) {
			e = bestI;
			break;
		}
	}
	// Straight shaft from the start to its end; the start may curl where the pen lands (trimmed then).
	let s0 = 0;
	if (e < 2) return null;
	if (!straight(r.slice(0, e + 1), r[0], r[e])) {
		const trim = Math.min(T.arrowStartTrimPx, 0.3 * pathLength(r.slice(0, e + 1)));
		let w = 0;
		while (s0 < e - 2 && w + dist(r[s0], r[s0 + 1]) <= trim) {
			w += dist(r[s0], r[s0 + 1]);
			s0++;
		}
		if (s0 === 0 || !straight(r.slice(s0, e + 1), r[s0], r[e])) return null;
	}
	const start = r[s0];
	const S = dist(start, tip);
	if (S < T.arrowMinShaftPx) return null;
	const dir: XY = [(tip[0] - start[0]) / S, (tip[1] - start[1]) / S];
	if (e < tipIdx) {
		// ">" head: the shaft ends near the tip and aims at it.
		const sx = r[e][0] - start[0];
		const sy = r[e][1] - start[1];
		if (Math.hypot(sx, sy) < 0.5 * S || turnDeg(sx, sy, dir[0], dir[1]) > 20) return null;
	}

	// Head extent relative to the tip.
	let maxD = 0;
	let headLen = 0;
	for (let i = e + 1; i < n; i++) {
		const vx = r[i][0] - tip[0];
		const vy = r[i][1] - tip[1];
		if (vx * dir[0] + vy * dir[1] > 0.1 * S + 3) return null; // past the tip
		maxD = Math.max(maxD, Math.hypot(vx, vy));
		headLen += dist(r[i - 1], r[i]);
	}
	const minBarb = Math.max(T.arrowMinBarbPx, T.arrowMinBarbFrac * S);
	if (maxD < minBarb || maxD > T.arrowMaxBarbFrac * S || headLen > T.arrowMaxHeadPathFrac * S) return null;

	// Excursions away from the tip (beyond `thr`), each with its apex (farthest point). Tiny ones (the
	// tip's rounded loop / overshoot, a little hook at the end) are ignored.
	const thr = Math.max(4, 0.35 * maxD);
	interface Excursion {
		from: number;
		apex: number;
		to: number;
		returned: boolean;
	}
	const all: Excursion[] = [];
	let cur: Excursion | null = null;
	for (let i = e + 1; i < n; i++) {
		const d = dist(r[i], tip);
		if (d > thr) {
			if (!cur) cur = { from: i, apex: i, to: i, returned: false };
			else if (d > dist(r[cur.apex], tip)) cur.apex = i;
			cur.to = i;
		} else if (cur) {
			cur.returned = true;
			all.push(cur);
			cur = null;
		}
	}
	if (cur) all.push(cur);
	const excursions = all.filter((ex) => dist(r[ex.apex], tip) >= minBarb);
	if (excursions.length < 1 || excursions.length > 2) return null;
	// A long head is only an arrow head when drawn barb → back to the tip (tells it from a V or a
	// check mark, whose second arm never comes back).
	if (maxD > T.arrowShortBarbFrac * S && !excursions[0].returned) return null;

	let sum = 0;
	const sides: number[] = [];
	for (const ex of excursions) {
		const apex = r[ex.apex];
		const vx = apex[0] - tip[0];
		const vy = apex[1] - tip[1];
		const len = Math.hypot(vx, vy);
		const back = turnDeg(-dir[0], -dir[1], vx, vy);
		if (back < T.arrowMinDeg || back > T.arrowMaxDeg) return null;
		// The barb's stroke on the tip side (outward after the tip; inward for a barb drawn before
		// the tip) is straight beyond the rounded loop at the tip — not a curl or a letter loop.
		const [i0, i1] = ex.from <= tipIdx ? [ex.apex, ex.to] : [ex.from, ex.apex];
		for (let i = i0; i <= i1; i++) {
			if (dist(r[i], tip) < 0.4 * len) continue;
			if (lineDist(r[i], tip, apex) > Math.max(4, 0.25 * len)) return null;
		}
		sides.push(Math.sign(vx * dir[1] - vy * dir[0]));
		sum += len;
	}
	if (sides.length === 2 && sides[0] === sides[1]) return null;
	const head = Math.min(Math.max(sum / excursions.length, 6), T.arrowMaxBarbFrac * S);
	return { kind: "arrow", a: [start[0], start[1]], b: [tip[0], tip[1]], head };
}

// -------------------------------------------------------------------------------------------------
// Densify / adjust
// -------------------------------------------------------------------------------------------------

function densifySegment(out: XY[], a: XY, b: XY, step: number): void {
	const len = dist(a, b);
	const m = Math.max(1, Math.ceil(len / step));
	for (let i = 1; i <= m; i++) out.push([a[0] + ((b[0] - a[0]) * i) / m, a[1] + ((b[1] - a[1]) * i) / m]);
}

/** Barb end points of an arrow (±28° off the backward shaft direction). */
export function arrowBarbs(a: XY, b: XY, head: number): [XY, XY] {
	const ang = Math.atan2(a[1] - b[1], a[0] - b[0]);
	const spread = 28 * DEG;
	return [
		[b[0] + Math.cos(ang + spread) * head, b[1] + Math.sin(ang + spread) * head],
		[b[0] + Math.cos(ang - spread) * head, b[1] + Math.sin(ang - spread) * head],
	];
}

/**
 * Densified points of a shape (spacing ≈ `step` px, corners exact). Closed shapes end on their
 * first point. An arrow is one continuous path: shaft, barb 1 and back, barb 2.
 */
export function shapeToPoints(spec: ShapeSpec, step = 3): XY[] {
	const out: XY[] = [];
	switch (spec.kind) {
		case "line":
			out.push([spec.a[0], spec.a[1]]);
			densifySegment(out, spec.a, spec.b, step);
			return out;
		case "arrow": {
			const [h1, h2] = arrowBarbs(spec.a, spec.b, spec.head);
			out.push([spec.a[0], spec.a[1]]);
			densifySegment(out, spec.a, spec.b, step);
			densifySegment(out, spec.b, h1, step);
			densifySegment(out, h1, spec.b, step);
			densifySegment(out, spec.b, h2, step);
			return out;
		}
		case "polyline":
		case "rectangle":
		case "triangle":
		case "polygon": {
			const v = spec.vertices;
			out.push([v[0][0], v[0][1]]);
			for (let i = 1; i < v.length; i++) densifySegment(out, v[i - 1], v[i], step);
			if (spec.kind !== "polyline") densifySegment(out, v[v.length - 1], v[0], step);
			return out;
		}
		case "arc": {
			const m = Math.min(360, Math.max(8, Math.ceil((Math.abs(spec.sweep) * spec.r) / step)));
			for (let i = 0; i <= m; i++) {
				const t = spec.start + (spec.sweep * i) / m;
				out.push([spec.cx + spec.r * Math.cos(t), spec.cy + spec.r * Math.sin(t)]);
			}
			return out;
		}
		case "parabola":
		case "curve": {
			const P: XY[] = spec.kind === "parabola" ? [spec.a, spec.c, spec.b] : [spec.a, spec.c1, spec.c2, spec.b];
			const m = Math.min(400, Math.max(8, Math.ceil(pathLength(P) / step)));
			out.push([P[0][0], P[0][1]]);
			for (let i = 1; i < m; i++) out.push(bez(P, i / m));
			const last = P[P.length - 1];
			out.push([last[0], last[1]]);
			return out;
		}
		case "ellipse":
		case "circle": {
			const { cx, cy, rx, ry, rot } = spec;
			const per = Math.PI * (3 * (rx + ry) - Math.sqrt((3 * rx + ry) * (rx + 3 * ry)));
			const m = Math.min(360, Math.max(24, Math.ceil(per / step)));
			const c = Math.cos(rot);
			const s = Math.sin(rot);
			for (let i = 0; i <= m; i++) {
				const t = (i / m) * 2 * Math.PI;
				const x = rx * Math.cos(t);
				const y = ry * Math.sin(t);
				out.push([cx + x * c - y * s, cy + x * s + y * c]);
			}
			return out;
		}
	}
}

/** Orientation of a shape's own frame (rad): rectangle edge / ellipse axis; 0 otherwise. */
function frameAngle(spec: ShapeSpec): number {
	if (spec.kind === "rectangle") {
		const [a, b] = spec.vertices;
		return Math.atan2(b[1] - a[1], b[0] - a[0]);
	}
	if (spec.kind === "ellipse") return spec.rot;
	if (spec.kind === "polyline" && spec.rightAngle && spec.vertices.length === 3) {
		// The legs' own frame (reduced to (−45°, 45°]), so per-axis scaling keeps the corner at 90°.
		const [a, b] = spec.vertices;
		const t = Math.atan2(a[1] - b[1], a[0] - b[0]);
		return t - Math.round(t / (Math.PI / 2)) * (Math.PI / 2);
	}
	return 0;
}

/** Minimum |scale| while adjusting, so a shape never collapses to nothing. */
const MIN_ADJUST_SCALE = 0.05;

/**
 * Reshape a snapped shape while the pen stays down (GoodNotes): `p0` = pen position at the snap,
 * `q` = current pen position. Lines/arrows: the end nearest the pen follows it (other end fixed).
 * Closed shapes and polylines: scaled in their own frame relative to the bbox corner opposite the
 * pen (circles uniformly; ellipses/rectangles may change aspect). Pure: `spec` is not modified.
 */
export function adjustShape(spec: ShapeSpec, p0: XY, q: XY): ShapeSpec {
	if (spec.kind === "line" || spec.kind === "arrow") {
		const moveB = dist(p0, spec.b) <= dist(p0, spec.a);
		const off: XY = moveB ? [spec.b[0] - p0[0], spec.b[1] - p0[1]] : [spec.a[0] - p0[0], spec.a[1] - p0[1]];
		const end: XY = [q[0] + off[0], q[1] + off[1]];
		return moveB ? { ...spec, a: [spec.a[0], spec.a[1]], b: end } : { ...spec, a: end, b: [spec.b[0], spec.b[1]] };
	}
	if (spec.kind === "arc") {
		// Similarity about the arc's start (rotate + scale as one complex factor ρ): the end follows the
		// pen, the arc stays circular with the same sweep.
		const S: XY = [spec.cx + spec.r * Math.cos(spec.start), spec.cy + spec.r * Math.sin(spec.start)];
		const ux = p0[0] - S[0];
		const uy = p0[1] - S[1];
		const den = ux * ux + uy * uy;
		if (den < 16) return { ...spec };
		const vx = q[0] - S[0];
		const vy = q[1] - S[1];
		let re = (vx * ux + vy * uy) / den;
		let im = (vy * ux - vx * uy) / den;
		const mag = Math.hypot(re, im);
		if (mag < MIN_ADJUST_SCALE) {
			re = mag > 0 ? (re / mag) * MIN_ADJUST_SCALE : MIN_ADJUST_SCALE;
			im = mag > 0 ? (im / mag) * MIN_ADJUST_SCALE : 0;
		}
		const zx = spec.cx - S[0];
		const zy = spec.cy - S[1];
		return {
			...spec,
			cx: S[0] + zx * re - zy * im,
			cy: S[1] + zx * im + zy * re,
			r: spec.r * Math.hypot(re, im),
			start: spec.start + Math.atan2(im, re),
		};
	}
	if (spec.kind === "parabola" || spec.kind === "curve") {
		// Per-axis scale about the start (graph-like stretch; an axis-aligned parabola stays one). An
		// axis on which the pen started level with the start uses the other axis' factor.
		const A = spec.a;
		const raw = (i: 0 | 1) => (Math.abs(p0[i] - A[i]) < 4 ? null : (q[i] - A[i]) / (p0[i] - A[i]));
		const clamp = (s: number) => (Math.abs(s) < MIN_ADJUST_SCALE ? (s < 0 ? -MIN_ADJUST_SCALE : MIN_ADJUST_SCALE) : s);
		const rx = raw(0);
		const ry = raw(1);
		const sx = clamp(rx ?? (ry !== null ? Math.abs(ry) : 1));
		const sy = clamp(ry ?? (rx !== null ? Math.abs(rx) : 1));
		const map = (p: XY): XY => [A[0] + (p[0] - A[0]) * sx, A[1] + (p[1] - A[1]) * sy];
		if (spec.kind === "parabola") return { kind: "parabola", a: [A[0], A[1]], c: map(spec.c), b: map(spec.b) };
		return { kind: "curve", a: [A[0], A[1]], c1: map(spec.c1), c2: map(spec.c2), b: map(spec.b) };
	}
	const theta = frameAngle(spec);
	const toLocal = (p: XY) => rotate(p, -theta);
	const toWorld = (p: XY) => rotate(p, theta);
	// Local bbox of the shape itself.
	let pts: XY[];
	if (spec.kind === "ellipse" || spec.kind === "circle") {
		const c = toLocal([spec.cx, spec.cy]);
		pts = [
			[c[0] - spec.rx, c[1] - spec.ry],
			[c[0] + spec.rx, c[1] + spec.ry],
		];
	} else {
		pts = spec.vertices.map(toLocal);
	}
	const b = bboxOf(pts);
	const l0 = toLocal(p0);
	const lq = toLocal(q);
	const cxm = (b.minX + b.maxX) / 2;
	const cym = (b.minY + b.maxY) / 2;
	const A: XY = [l0[0] < cxm ? b.maxX : b.minX, l0[1] < cym ? b.maxY : b.minY];
	const axisScale = (i: 0 | 1) => {
		const den = l0[i] - A[i];
		if (Math.abs(den) < 4) return 1;
		const s = (lq[i] - A[i]) / den;
		return Math.abs(s) < MIN_ADJUST_SCALE ? (s < 0 ? -MIN_ADJUST_SCALE : MIN_ADJUST_SCALE) : s;
	};
	let sx = axisScale(0);
	let sy = axisScale(1);
	if (spec.kind === "circle") {
		const s = Math.max(Math.abs(sx), Math.abs(sy));
		sx = sx < 0 ? -s : s;
		sy = sy < 0 ? -s : s;
	}
	const map = (p: XY): XY => toWorld([A[0] + (p[0] - A[0]) * sx, A[1] + (p[1] - A[1]) * sy]);
	if (spec.kind === "ellipse" || spec.kind === "circle") {
		const c = map(toLocal([spec.cx, spec.cy]));
		return { ...spec, cx: c[0], cy: c[1], rx: spec.rx * Math.abs(sx), ry: spec.ry * Math.abs(sy) };
	}
	return { ...spec, vertices: spec.vertices.map((v) => map(toLocal(v))) };
}
