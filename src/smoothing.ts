/**
 * Smooth "liquid" ink (M2 Stage A2). Pure, no DOM / Obsidian imports.
 *
 * Pipeline for freehand strokes (pens of every style and the freehand highlighter; snapped shapes
 * bypass it):
 *  1. Input filter while drawing (`StrokeSmoother`): a 2-D One Euro filter on x/y driven by the real
 *     event timestamps (adaptive low-pass — strong smoothing when the pen is slow, where jitter and
 *     pixel quantization are visible, almost no lag when it is fast), followed by a min-distance
 *     filter. The raw pen position is always drawn as the stroke's tip, so the ink never trails the
 *     pen; on lift it becomes the stroke's last point.
 *  2. Curve rendering (`curvePath`, incrementally `CurveBuilder`): quadratic Béziers through the
 *     segment midpoints with the points as control points (= uniform quadratic B-spline). The curve
 *     stays inside the control polygon, so it never overshoots corners; the live and committed paths
 *     are built the same way and are prefix-stable (a new point only changes the last segment).
 *  3. On lift (`finishPoints`): append the lift point, a centered sub-pixel smoothing along the arc
 *     (σ = 1 px; removes leftover staircase the causal filter can't) and a light RDP simplification.
 *     Dashed strokes skip both so their dash pattern stays exactly where it was drawn.
 */

/** `[x, y, pressure]` (same shape as model.ts `Point`). */
export type SPoint = [number, number, number];

export type SmoothingLevel = "off" | "light" | "medium" | "strong";
export const SMOOTHING_LEVELS: readonly SmoothingLevel[] = ["off", "light", "medium", "strong"];

export interface OneEuroParams {
	/** Cutoff frequency (Hz) at zero speed: lower = smoother but laggier when slow. */
	minCutoff: number;
	/** Cutoff increase per px/s of speed: higher = less lag when fast. */
	beta: number;
	/** Cutoff (Hz) of the speed estimate. */
	dCutoff: number;
}

/**
 * Filter parameters per level (positions in CSS px, time in seconds — so `beta` is per px/s; the
 * steady-state trailing lag at high speed is ≈ 1/(2π·beta) px). Tuned on synthetic handwriting
 * (cursive loops at 0.3–6 letters/s and minimum-jerk zigzags, sampled at 120/240 Hz with ±0.5–1 px
 * jitter, with and without integer quantization): Medium cuts the excess 1-px roughness ~6× with a
 * mean lag ≈ 1 px; the raw tip hides the lag while drawing.
 */
export const SMOOTHING_PARAMS: Readonly<Record<SmoothingLevel, OneEuroParams | null>> = {
	off: null,
	light: { minCutoff: 3, beta: 0.3, dCutoff: 1 },
	medium: { minCutoff: 1.5, beta: 0.12, dCutoff: 1 },
	strong: { minCutoff: 0.8, beta: 0.05, dCutoff: 1 },
};

/** Filtered points closer than this to the previous kept point are dropped (px). */
export const MIN_DISTANCE = 0.5;
/** σ (px of arc length) of the centered smoothing applied on lift (imperceptible move, no jump). */
export const LIFT_SIGMA = 1;
/** RDP tolerance of the lift refinement (px). */
export const SIMPLIFY_TOLERANCE = 0.25;
/** …but never leaves a segment longer than this (px), so corners stay sharp. */
export const SIMPLIFY_MAX_SEGMENT = 3;
/** Dashed strokes: centerline points closer than this to the previous kept point are dropped (px). */
export const DASH_MIN_DISTANCE = 1.5;
/** Timestamps closer than this are treated as this far apart (s) — duplicate/zero-delta events. */
const MIN_DT = 0.001;
/** A gap longer than this (s) is clamped, so a pause doesn't make the next sample jump. */
const MAX_DT = 0.1;

function alpha(cutoff: number, dt: number): number {
	const tau = 1 / (2 * Math.PI * cutoff);
	return 1 / (1 + tau / dt);
}

/**
 * 2-D One Euro filter (Casiez et al., CHI 2012) with one shared, speed-dependent cutoff for both
 * axes (isotropic: no direction-dependent distortion). Deterministic given the timestamps.
 */
export class OneEuroFilter2D {
	private x = 0;
	private y = 0;
	private dx = 0;
	private dy = 0;
	private t = 0;
	private started = false;

	constructor(private readonly p: OneEuroParams) {}

	reset(): void {
		this.started = false;
	}

	/** Filter one sample; `tMs` is the event timestamp in milliseconds. */
	filter(x: number, y: number, tMs: number): [number, number] {
		if (!this.started) {
			this.started = true;
			this.x = x;
			this.y = y;
			this.dx = 0;
			this.dy = 0;
			this.t = tMs;
			return [x, y];
		}
		const dt = Math.min(Math.max((tMs - this.t) / 1000, MIN_DT), MAX_DT);
		this.t = Math.max(this.t, tMs);
		const ad = alpha(this.p.dCutoff, dt);
		this.dx += ad * ((x - this.x) / dt - this.dx);
		this.dy += ad * ((y - this.y) / dt - this.dy);
		const speed = Math.hypot(this.dx, this.dy);
		const a = alpha(this.p.minCutoff + this.p.beta * speed, dt);
		this.x += a * (x - this.x);
		this.y += a * (y - this.y);
		return [this.x, this.y];
	}
}

/**
 * Input side of one freehand stroke: filtered, distance-thinned points plus the latest raw position
 * (the tip). `points` only ever grows (prefix-stable), which the incremental renderer relies on.
 */
export class StrokeSmoother {
	readonly points: SPoint[] = [];
	private readonly filter: OneEuroFilter2D | null;
	private rawTip: SPoint | null = null;

	constructor(
		params: OneEuroParams | null,
		private readonly minDistance = MIN_DISTANCE,
	) {
		this.filter = params ? new OneEuroFilter2D(params) : null;
	}

	/** Add a raw sample; returns true when a filtered point was appended to `points`. */
	push(x: number, y: number, pressure: number, tMs: number): boolean {
		this.rawTip = [x, y, pressure];
		const [fx, fy] = this.filter ? this.filter.filter(x, y, tMs) : [x, y];
		const last = this.points[this.points.length - 1];
		if (last && Math.hypot(fx - last[0], fy - last[1]) < this.minDistance) return false;
		this.points.push([fx, fy, pressure]);
		return true;
	}

	/** The latest raw pen position (drawn as the stroke's tip), or null before the first sample. */
	get tip(): SPoint | null {
		return this.rawTip;
	}

	/** Points to draw right now: the filtered points plus the raw tip. */
	livePoints(): SPoint[] {
		return withTip(this.points, this.rawTip);
	}
}

/** `points` + `tip` unless the tip coincides with the last point. */
export function withTip(points: readonly SPoint[], tip: SPoint | null): SPoint[] {
	const out = points.slice();
	const last = out[out.length - 1];
	if (tip && (!last || last[0] !== tip[0] || last[1] !== tip[1])) out.push(tip);
	return out;
}

/** Squared distance from p to segment a-b. */
function distSqToSegment(p: readonly number[], a: readonly number[], b: readonly number[]): number {
	const dx = b[0] - a[0];
	const dy = b[1] - a[1];
	const lenSq = dx * dx + dy * dy;
	let t = lenSq === 0 ? 0 : ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / lenSq;
	t = Math.max(0, Math.min(1, t));
	const cx = a[0] + t * dx - p[0];
	const cy = a[1] + t * dy - p[1];
	return cx * cx + cy * cy;
}

/**
 * Ramer–Douglas–Peucker simplification (iterative; keeps first and last point). With `maxSegment`,
 * original points are kept so that no remaining segment is longer than that (the midpoint curve
 * cuts a corner by up to ~¼ of the adjacent segment lengths, so long segments would round "v"/"z").
 */
export function simplifyRDP<T extends readonly number[]>(points: readonly T[], tolerance: number, maxSegment = Infinity): T[] {
	const n = points.length;
	if (n <= 2 || tolerance <= 0) return points.slice();
	const keep = new Uint8Array(n);
	keep[0] = 1;
	keep[n - 1] = 1;
	const tolSq = tolerance * tolerance;
	const stack: [number, number][] = [[0, n - 1]];
	while (stack.length) {
		const [i, j] = stack.pop()!;
		let maxD = -1;
		let idx = -1;
		for (let k = i + 1; k < j; k++) {
			const d = distSqToSegment(points[k], points[i], points[j]);
			if (d > maxD) {
				maxD = d;
				idx = k;
			}
		}
		if (idx !== -1 && maxD > tolSq) {
			keep[idx] = 1;
			stack.push([i, idx], [idx, j]);
		}
	}
	if (Number.isFinite(maxSegment)) {
		let prev = 0;
		for (let k = 1; k < n; k++) {
			if (!keep[k]) continue;
			// Re-add skipped points so consecutive kept points stay within maxSegment.
			let from = prev;
			for (let m = prev + 1; m < k; m++) {
				const a = points[from];
				const next = points[m + 1];
				if (Math.hypot(next[0] - a[0], next[1] - a[1]) > maxSegment) {
					keep[m] = 1;
					from = m;
				}
			}
			prev = k;
		}
	}
	const out: T[] = [];
	for (let k = 0; k < n; k++) if (keep[k]) out.push(points[k]);
	return out;
}

/** Arc-length half-window (px) over which the turning angle is measured for corner detection. */
export const CORNER_WINDOW = 2;
/** Turning angle (rad, ≈ 60°) over ±CORNER_WINDOW above which a point is a corner. */
export const CORNER_ANGLE = Math.PI / 3;

/**
 * Indices of sharp corners (the "v" of a v, the turns of a z): points where the direction turns by
 * more than `angle` between the chord from `window` px of arc before and the chord to `window` px
 * after, keeping only the local maximum of each run. Pixel-staircase residue and the gentle turns
 * of handwriting stay well below the threshold at this scale.
 */
export function findCorners(points: readonly (readonly number[])[], window = CORNER_WINDOW, angle = CORNER_ANGLE): number[] {
	const n = points.length;
	if (n < 3) return [];
	const s = new Float64Array(n);
	for (let i = 1; i < n; i++) s[i] = s[i - 1] + Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1]);
	const turn = new Float64Array(n);
	let a = 0;
	let b = 0;
	for (let i = 1; i < n - 1; i++) {
		while (a + 1 < i && s[i] - s[a + 1] >= window) a++;
		if (b < i) b = i;
		while (b < n - 1 && s[b] - s[i] < window) b++;
		if (s[i] - s[a] < window || s[b] - s[i] < window) continue;
		const ux = points[i][0] - points[a][0];
		const uy = points[i][1] - points[a][1];
		const vx = points[b][0] - points[i][0];
		const vy = points[b][1] - points[i][1];
		turn[i] = Math.abs(Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy));
	}
	const out: number[] = [];
	for (let i = 1; i < n - 1; i++) {
		if (turn[i] <= angle) continue;
		// Local maximum within the window (ties go to the first).
		let isMax = true;
		for (let j = i - 1; j >= 1 && s[i] - s[j] < window; j--) if (turn[j] >= turn[i]) isMax = false;
		for (let j = i + 1; j < n - 1 && s[j] - s[i] < window; j++) if (turn[j] > turn[i]) isMax = false;
		if (isMax) out.push(i);
	}
	return out;
}

/**
 * Centered Gaussian smoothing along arc length (σ in px), only possible once the stroke is complete
 * (it looks ahead). Removes what a causal filter can't at low speed — e.g. the residue of a pixel
 * staircase from integer-quantized input — while moving points only by fractions of a pixel. The
 * window is kept symmetric and shrinks towards the ends and towards sharp corners (`findCorners`),
 * so the end points and corners stay fixed: the stroke doesn't shorten and a "v" stays a "v".
 */
export function smoothArc(points: readonly SPoint[], sigma: number): SPoint[] {
	const n = points.length;
	if (n < 3 || sigma <= 0) return points.slice();
	const s = new Float64Array(n);
	for (let i = 1; i < n; i++) s[i] = s[i - 1] + Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1]);
	// Anchors: the ends and every corner. Smoothing windows never cross one.
	const anchors = [0, ...findCorners(points), n - 1];
	const out: SPoint[] = [points[0]];
	const inv = 1 / (2 * sigma * sigma);
	let k = 0;
	for (let i = 1; i < n - 1; i++) {
		while (anchors[k + 1] < i) k++;
		if (anchors[k + 1] === i) {
			out.push(points[i]);
			continue;
		}
		const r = Math.min(2.5 * sigma, s[i] - s[anchors[k]], s[anchors[k + 1]] - s[i]);
		let wx = 0;
		let wy = 0;
		let w = 0;
		for (let j = i; j >= 0 && s[i] - s[j] <= r; j--) {
			const g = Math.exp(-((s[i] - s[j]) ** 2) * inv);
			wx += g * points[j][0];
			wy += g * points[j][1];
			w += g;
		}
		for (let j = i + 1; j < n && s[j] - s[i] <= r; j++) {
			const g = Math.exp(-((s[j] - s[i]) ** 2) * inv);
			wx += g * points[j][0];
			wy += g * points[j][1];
			w += g;
		}
		out.push([wx / w, wy / w, points[i][2]]);
	}
	out.push(points[n - 1]);
	return out;
}

/**
 * Final points of a freehand stroke on lift: the filtered points plus the raw lift position (so
 * the stroke ends exactly where the pen did — the same tip the live stroke showed), then a light
 * RDP pass unless `keepAll` (dashed strokes keep every point so their pattern doesn't move).
 */
export function finishPoints(
	points: readonly SPoint[],
	tip: SPoint | null,
	keepAll = false,
	sigma = LIFT_SIGMA,
	tolerance = SIMPLIFY_TOLERANCE,
	maxSegment = SIMPLIFY_MAX_SEGMENT,
): SPoint[] {
	const all = withTip(points, tip);
	return keepAll ? all : simplifyRDP(smoothArc(all, sigma), tolerance, maxSegment);
}

/** Format a number for path data: 2 decimals, no trailing zeros. */
export function fmt(n: number): string {
	return (Math.round(n * 100) / 100).toString();
}

/**
 * Drop points closer than `minDist` to the previous kept point (the last point is always kept).
 * Prefix-stable apart from the last point. Used for dashed strokes, so raw jitter can't add path
 * length (which would make the dash pattern denser on slow strokes).
 */
export function thinPoints<T extends readonly number[]>(points: readonly T[], minDist: number): T[] {
	if (points.length <= 2 || minDist <= 0) return points.slice();
	const out: T[] = [points[0]];
	const minSq = minDist * minDist;
	for (let i = 1; i < points.length - 1; i++) {
		const p = points[i];
		const q = out[out.length - 1];
		const dx = p[0] - q[0];
		const dy = p[1] - q[1];
		if (dx * dx + dy * dy >= minSq) out.push(p);
	}
	// The stroke always ends at its last point (exactly like the live stroke's tip).
	const last = points[points.length - 1];
	const q = out[out.length - 1];
	if (last[0] !== q[0] || last[1] !== q[1]) out.push(last);
	return out;
}

/** Straight segments through every point (snapped shapes, lasso loop). One point ⇒ a dot. */
export function polylinePath(points: readonly (readonly number[])[], offsetX = 0, offsetY = 0): string {
	if (points.length === 0) return "";
	const xy = (p: readonly number[]) => `${fmt(p[0] + offsetX)} ${fmt(p[1] + offsetY)}`;
	let d = `M${xy(points[0])}`;
	if (points.length === 1) return d + ` L${xy(points[0])}`;
	for (let i = 1; i < points.length; i++) d += ` L${xy(points[i])}`;
	return d;
}

/**
 * Incremental smooth centerline: `M p0 L m(0,1) Q p1 m(1,2) Q p2 m(2,3) … L p(n-1)`, where m(i,j)
 * is the midpoint of p_i and p_j. Every `Q` segment before the last one is final once the next
 * point is known, so appending only extends a cached prefix (O(1) per point while drawing).
 * `curvePath` produces exactly the same string for the same points.
 */
export class CurveBuilder {
	private prefix = "";
	private readonly pts: (readonly number[])[] = [];

	constructor(
		private readonly offsetX = 0,
		private readonly offsetY = 0,
	) {}

	get length(): number {
		return this.pts.length;
	}

	push(p: readonly number[]): void {
		const pts = this.pts;
		pts.push(p);
		const n = pts.length;
		const xy = (x: number, y: number) => `${fmt(x + this.offsetX)} ${fmt(y + this.offsetY)}`;
		if (n === 1) {
			this.prefix = `M${xy(p[0], p[1])}`;
		} else if (n === 2) {
			const a = pts[0];
			this.prefix += ` L${xy((a[0] + p[0]) / 2, (a[1] + p[1]) / 2)}`;
		} else {
			// The segment controlled by the previous point is now final.
			const c = pts[n - 2];
			this.prefix += ` Q${xy(c[0], c[1])} ${xy((c[0] + p[0]) / 2, (c[1] + p[1]) / 2)}`;
		}
	}

	/** Path through the pushed points (and an optional extra, un-cached final point). */
	path(tip?: readonly number[] | null): string {
		const pts = this.pts;
		const n = pts.length;
		const xy = (x: number, y: number) => `${fmt(x + this.offsetX)} ${fmt(y + this.offsetY)}`;
		if (tip) {
			if (n === 0) return `M${xy(tip[0], tip[1])} L${xy(tip[0], tip[1])}`;
			const last = pts[n - 1];
			if (last[0] === tip[0] && last[1] === tip[1]) return this.path(null);
			if (n === 1) return `${this.prefix} L${xy(tip[0], tip[1])}`;
			return `${this.prefix} Q${xy(last[0], last[1])} ${xy((last[0] + tip[0]) / 2, (last[1] + tip[1]) / 2)} L${xy(tip[0], tip[1])}`;
		}
		if (n === 0) return "";
		const last = pts[n - 1];
		if (n === 1) return `${this.prefix} L${xy(last[0], last[1])}`;
		return `${this.prefix} L${xy(last[0], last[1])}`;
	}
}

/** Smooth centerline through the points (quadratic midpoint curve; see `CurveBuilder`). */
export function curvePath(points: readonly (readonly number[])[], offsetX = 0, offsetY = 0): string {
	const b = new CurveBuilder(offsetX, offsetY);
	for (const p of points) b.push(p);
	return b.path();
}

/**
 * Sample the curve `curvePath` draws (for tests and analysis): the polyline approximation with
 * `perSegment` samples per quadratic piece.
 */
export function sampleCurve(points: readonly (readonly number[])[], perSegment = 8): [number, number][] {
	const n = points.length;
	if (n === 0) return [];
	if (n === 1) return [[points[0][0], points[0][1]]];
	const mid = (a: readonly number[], b: readonly number[]): [number, number] => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
	const out: [number, number][] = [[points[0][0], points[0][1]]];
	let start = mid(points[0], points[1]);
	out.push(start);
	for (let i = 1; i < n - 1; i++) {
		const c = points[i];
		const end = mid(c, points[i + 1]);
		for (let k = 1; k <= perSegment; k++) {
			const t = k / perSegment;
			const u = 1 - t;
			out.push([u * u * start[0] + 2 * u * t * c[0] + t * t * end[0], u * u * start[1] + 2 * u * t * c[1] + t * t * end[1]]);
		}
		start = end;
	}
	out.push([points[n - 1][0], points[n - 1][1]]);
	return out;
}
