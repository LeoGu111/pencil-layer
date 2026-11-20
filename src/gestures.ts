/**
 * Pen gestures (pure, no DOM):
 *  - Double-tap (opt-in): two very quick pen taps at the same spot, away from fresh handwriting,
 *    toggle the eraser.
 *  - Scribble-to-erase (opt-in): a rapid back-and-forth zigzag erases the strokes it COVERS.
 *
 * Scribble erase is deliberately conservative (GoodNotes erased outlines when shading inside shapes,
 * and graph axes when drawing on graphs), but needs only about half a stroke scribbled over.
 * A stroke is erased only if ALL of these hold:
 *   1. about half of it is under the scribble: ≥ 45% of its length lies inside the region the
 *      scribble covers AND the inside part spans ≥ 45% of its extent along its main direction;
 *   2. it is scribbled OVER, not touched: ≥ 3 distinct legs cross it in their middle part (a
 *      crossing within 15% of a leg's ends is a turnaround — hatching reaching an outline), or
 *      ≥ 50% of its length lies deep inside the region (dots, marks between parallel legs);
 *   3. legs do not mostly turn around on it (more end-crossings than middle-crossings = outline);
 *   4. its bbox area is ≤ 4× the scribble's bbox area (never erase things much larger);
 *   5. it does not enclose the scribble (closed strokes containing ≥ 60% of the scribble = shading).
 * Strokes merely touched or crossed by a few legs, or under less than ~half, are kept (a long axis
 * running through a scribble is mostly outside it). If no stroke qualifies the scribble stays as
 * ordinary ink, so shading still works. `ScribbleTracker` runs one gesture from pen down to lift:
 * the live preview and the commit on lift share it, so they always agree (see there).
 *
 * The covered region is not the convex hull (that would swallow the curve above shading under a
 * parabola): it is the union of the convex hulls of every 3 consecutive legs of the zigzag,
 * rasterized on a small grid with a chamfer distance transform for depth queries.
 */

export type XY = [number, number];

// -------------------------------------------------------------------------------------------------
// Double tap (Stage E: opt-in and strict — the user's dotted i's used to trigger it)
// -------------------------------------------------------------------------------------------------

export const TAP = {
	/** A tap is a pen contact shorter than this (ms)… */
	maxMs: 120,
	/** …that moved less than this (px): nearly no movement. */
	maxMove: 3,
	/** Second tap must start within this time after the first ended (ms)… */
	maxGapMs: 280,
	/** …and within this distance of the first (px). */
	maxDist: 6,
} as const;

/**
 * Writing guard: a tap within `px` of ink that finished less than `ms` before it is part of
 * handwriting (an i/j dot, punctuation, an umlaut) and never counts toward a double tap.
 */
export const INK_GUARD = {
	px: 40,
	ms: 1500,
} as const;

export interface Tap {
	x: number;
	y: number;
	/** Timestamps (ms) of pointerdown / pointerup. */
	downAt: number;
	upAt: number;
	/** Largest distance from the down point during the contact (px). */
	maxMove: number;
}

/** Ink committed recently (overlay-space bbox and when it was finished, ms). */
export interface RecentInk {
	box: { minX: number; minY: number; maxX: number; maxY: number };
	at: number;
}

/** Was this pen contact a tap (very short and nearly motionless)? */
export function isTap(t: Tap): boolean {
	return t.upAt - t.downAt < TAP.maxMs && t.maxMove < TAP.maxMove;
}

/** Is (x, y) at time `t` within the writing guard of recently finished ink? */
export function nearRecentInk(x: number, y: number, t: number, recent: readonly RecentInk[]): boolean {
	for (const r of recent) {
		const age = t - r.at;
		if (age < 0 || age > INK_GUARD.ms) continue;
		const dx = Math.max(r.box.minX - x, 0, x - r.box.maxX);
		const dy = Math.max(r.box.minY - y, 0, y - r.box.maxY);
		if (Math.hypot(dx, dy) < INK_GUARD.px) return true;
	}
	return false;
}

/** Drop entries older than the writing guard (keeps the list short). */
export function pruneRecentInk(recent: RecentInk[], now: number): RecentInk[] {
	return recent.filter((r) => now - r.at <= INK_GUARD.ms);
}

/** May this contact be held back as the first tap of a double tap? */
export function isFirstTap(t: Tap, recent: readonly RecentInk[] = []): boolean {
	return isTap(t) && !nearRecentInk(t.x, t.y, t.downAt, recent);
}

/** Could a contact starting at (x, y, downAt) be the second tap of a double tap after `first`? */
export function canPair(first: Tap, x: number, y: number, downAt: number, recent: readonly RecentInk[] = []): boolean {
	const gap = downAt - first.upAt;
	return (
		gap >= 0 &&
		gap <= TAP.maxGapMs &&
		Math.hypot(x - first.x, y - first.y) < TAP.maxDist &&
		!nearRecentInk(x, y, downAt, recent)
	);
}

/** Do two taps form a double tap (neither of them close to ink written just before)? */
export function isDoubleTap(first: Tap, second: Tap, recent: readonly RecentInk[] = []): boolean {
	return isFirstTap(first, recent) && isTap(second) && canPair(first, second.x, second.y, second.downAt, recent);
}

// -------------------------------------------------------------------------------------------------
// Scribble detection
// -------------------------------------------------------------------------------------------------

export const SCRIBBLE = {
	/** Minimum number of direction reversals (≥ 4 ⇒ at least 5 legs). */
	minReversals: 4,
	/** The whole gesture must take at most this long (ms). */
	maxDurationMs: 1500,
	/** Average time per leg must be at most this (ms): scribbles are fast. */
	maxLegMs: 200,
	/** Reversal hysteresis as a fraction of the extent along the reversal axis. */
	hysteresis: 0.35,
	/** Path length / bbox diagonal must be at least this (legs pile on top of each other). */
	minDensity: 3,
	/** Advance between legs / leg amplitude, when reversing along the long (principal) axis… */
	maxAdvanceMajor: 0.3,
	/** …and along the short axis (a zigzag progressing sideways — stricter: looks like "www"). */
	maxAdvanceMinor: 0.22,
	/** Fraction of reversals that must be sharp (a V or tight loop, not an arch like in "m"). */
	minSharpFrac: 0.6,
	/** Minimum leg amplitude (px). */
	minAmplitude: 6,
	/**
	 * Once recognized, the advance limit (kept from recognition) is relaxed by this factor
	 * (hysteresis: a scribble hovering at the limit must not flicker off and on).
	 */
	latchSlack: 1.1,
} as const;

export const COVERAGE = {
	/** Fraction of a stroke's length that must lie inside the scribble region (depth ≥ 0)… */
	minInside: 0.45,
	/** …and it must be scribbled OVER: crossed mid-leg by at least this many distinct legs… */
	minPasses: 3,
	/** …(a crossing within this fraction of either end of a leg is a turnaround, e.g. shading
	 * reaching an outline, and does not count)… */
	passEndFrac: 0.15,
	/** …or else lie deep inside: this fraction of its length ≥ edgeMargin px from the boundary
	 * (dots, tiny marks and lines parallel to the legs, which legs pass beside, not across). */
	minInterior: 0.5,
	/** Dilation (px) of the region for the quick reject and `covered`. */
	dilate: 4,
	/** Depth (px) a point needs to count as "deep inside" (outlines at the edge of shading are not). */
	edgeMargin: 6,
	/** Target bbox area must be ≤ this × scribble bbox area. */
	maxAreaRatio: 4,
	/** A closed stroke enclosing at least this fraction of the scribble's points is a container. */
	containerFrac: 0.6,
} as const;

export interface ScribbleInfo {
	/** Indices into the input points where the direction reversed. */
	reversals: number[];
	/** Leg boundaries `[startIdx, endIdx]` (consecutive legs share a reversal index). */
	legs: [number, number][];
	/** Unit vector of the reversal axis. */
	axis: XY;
	/** Whether the reversal axis is the principal (long) axis. */
	major: boolean;
	box: { minX: number; minY: number; maxX: number; maxY: number };
	/** Mean amplitude of the inner legs along the reversal axis (px). */
	amp: number;
}

function principalAngle(pts: readonly (readonly number[])[]): number {
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
	return 0.5 * Math.atan2(2 * sxy, sxx - syy);
}

/** Reversal indices of a 1-D signal with hysteresis `h` (index of each turning extreme). */
export function reversals1D(v: readonly number[], h: number): number[] {
	const out: number[] = [];
	if (v.length < 3) return out;
	let dir = 0;
	let hi = v[0];
	let hiIdx = 0;
	let lo = v[0];
	let loIdx = 0;
	for (let i = 1; i < v.length; i++) {
		const x = v[i];
		if (dir >= 0) {
			if (x > hi) {
				hi = x;
				hiIdx = i;
			}
		}
		if (dir <= 0) {
			if (x < lo) {
				lo = x;
				loIdx = i;
			}
		}
		if (dir === 0) {
			if (x - lo >= h) {
				dir = 1;
				hi = x;
				hiIdx = i;
			} else if (hi - x >= h) {
				dir = -1;
				lo = x;
				loIdx = i;
			}
		} else if (dir === 1 && hi - x >= h) {
			out.push(hiIdx);
			dir = -1;
			lo = x;
			loIdx = i;
		} else if (dir === -1 && x - lo >= h) {
			out.push(loIdx);
			dir = 1;
			hi = x;
			hiIdx = i;
		}
	}
	return out;
}

function pathLen(pts: readonly (readonly number[])[]): number {
	let L = 0;
	for (let i = 1; i < pts.length; i++) L += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
	return L;
}

function boxOf(pts: readonly (readonly number[])[]) {
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

/**
 * Is this pen stroke a scribble-to-erase gesture? `points` are `[x, y, ...]` in drawing order,
 * `durationMs` the time from pen down to now/up. Returns details for `scribbleTargets`, or null.
 */
export function detectScribble(points: readonly (readonly number[])[], durationMs: number): ScribbleInfo | null {
	if (durationMs > SCRIBBLE.maxDurationMs) return null;
	const info = scribbleShape(points);
	if (!info || durationMs / info.legs.length > SCRIBBLE.maxLegMs) return null;
	return info;
}

/**
 * The time-independent half of `detectScribble`: does this path have a scribble's shape (enough
 * sharp reversals, dense, little advance per leg)? Used alone to keep checking a gesture that was
 * already recognized, so scribbling on past the time limits never cancels it.
 */
export function scribbleShape(points: readonly (readonly number[])[], maxAdvance?: number): ScribbleInfo | null {
	const S = SCRIBBLE;
	if (points.length < 10) return null;
	const box = boxOf(points);
	const diag = Math.hypot(box.maxX - box.minX, box.maxY - box.minY);
	if (diag < 8 || pathLen(points) / diag < S.minDensity) return null;

	const ang = principalAngle(points);
	const axes: { axis: XY; major: boolean }[] = [
		{ axis: [Math.cos(ang), Math.sin(ang)], major: true },
		{ axis: [-Math.sin(ang), Math.cos(ang)], major: false },
	];
	let best: { axis: XY; major: boolean; rev: number[]; proj: number[] } | null = null;
	for (const a of axes) {
		const proj = points.map((p) => p[0] * a.axis[0] + p[1] * a.axis[1]);
		let lo = Infinity;
		let hi = -Infinity;
		for (const x of proj) {
			lo = Math.min(lo, x);
			hi = Math.max(hi, x);
		}
		const h = Math.max(S.minAmplitude, S.hysteresis * (hi - lo));
		const rev = reversals1D(proj, h);
		if (!best || rev.length > best.rev.length) best = { ...a, rev, proj };
	}
	if (!best || best.rev.length < S.minReversals) return null;
	const { axis, major, rev, proj } = best;
	const perpAxis: XY = [-axis[1], axis[0]];
	const perp = points.map((p) => p[0] * perpAxis[0] + p[1] * perpAxis[1]);

	const bounds = [0, ...rev, points.length - 1];
	const legs: [number, number][] = [];
	for (let i = 0; i + 1 < bounds.length; i++) legs.push([bounds[i], bounds[i + 1]]);

	// Amplitude of the inner legs (the first/last legs are often partial).
	const inner = legs.length > 2 ? legs.slice(1, -1) : legs;
	const amp = inner.reduce((s, [a, b]) => s + Math.abs(proj[b] - proj[a]), 0) / inner.length;
	if (amp < S.minAmplitude) return null;

	// Advance per leg along the perpendicular axis (centers of the inner legs: the first and last
	// legs are partial — the last one is still being drawn while previewing, its center wanders).
	const centers = inner.map(([a, b]) => {
		let s = 0;
		for (let i = a; i <= b; i++) s += perp[i];
		return s / (b - a + 1);
	});
	const advance = (Math.max(...centers) - Math.min(...centers)) / Math.max(1, inner.length - 1);
	if (advance / amp > (maxAdvance ?? (major ? S.maxAdvanceMajor : S.maxAdvanceMinor))) return null;

	// Sharp reversals: near the turning extreme (within 20% of the amplitude) the path stays narrow.
	let sharp = 0;
	for (const r of rev) {
		const ext = proj[r];
		const near = (i: number) => Math.abs(proj[i] - ext) <= 0.2 * amp;
		let lo = r;
		let hi = r;
		while (lo > 0 && near(lo - 1)) lo--;
		while (hi < points.length - 1 && near(hi + 1)) hi++;
		let pMin = Infinity;
		let pMax = -Infinity;
		for (let i = lo; i <= hi; i++) {
			pMin = Math.min(pMin, perp[i]);
			pMax = Math.max(pMax, perp[i]);
		}
		if (pMax - pMin <= 0.3 * amp) sharp++;
	}
	if (sharp / rev.length < S.minSharpFrac) return null;

	return { reversals: rev, legs, axis, major, box, amp };
}

// -------------------------------------------------------------------------------------------------
// Covered region
// -------------------------------------------------------------------------------------------------

/** Convex hull (monotone chain), counter-clockwise, no repeated end point. */
export function convexHull(pts: readonly (readonly number[])[]): XY[] {
	const p = pts.map((q): XY => [q[0], q[1]]).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
	if (p.length < 3) return p;
	const cross = (o: XY, a: XY, b: XY) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
	const lower: XY[] = [];
	for (const q of p) {
		while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], q) <= 0) lower.pop();
		lower.push(q);
	}
	const upper: XY[] = [];
	for (let i = p.length - 1; i >= 0; i--) {
		const q = p[i];
		while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], q) <= 0) upper.pop();
		upper.push(q);
	}
	return lower.slice(0, -1).concat(upper.slice(0, -1));
}

/**
 * The area a scribble covers, as a raster with signed depth (px): positive inside (distance to the
 * boundary), negative outside (distance to the region). Cheap to build (a few thousand cells).
 */
export class ScribbleRegion {
	readonly cell: number;
	private readonly x0: number;
	private readonly y0: number;
	private readonly w: number;
	private readonly h: number;
	/** Signed depth per cell (px). */
	private readonly depthMap: Float32Array;

	constructor(points: readonly (readonly number[])[], info: Pick<ScribbleInfo, "legs" | "box">, margin = 16) {
		const { box } = info;
		const area = Math.max(1, (box.maxX - box.minX + 2 * margin) * (box.maxY - box.minY + 2 * margin));
		// ≤ ~40k cells, ≥ 1.5 px.
		this.cell = Math.max(1.5, Math.sqrt(area / 40000));
		this.x0 = box.minX - margin;
		this.y0 = box.minY - margin;
		this.w = Math.ceil((box.maxX - box.minX + 2 * margin) / this.cell) + 1;
		this.h = Math.ceil((box.maxY - box.minY + 2 * margin) / this.cell) + 1;
		const inside = new Uint8Array(this.w * this.h);

		const legs = info.legs.length > 0 ? info.legs : [[0, points.length - 1] as [number, number]];
		const span = Math.min(3, legs.length);
		for (let k = 0; k + span <= legs.length; k++) {
			const from = legs[k][0];
			const to = legs[k + span - 1][1];
			this.fill(inside, convexHull(points.slice(from, to + 1)));
		}
		this.depthMap = this.signedDistance(inside);
	}

	/** Scanline-fill a convex polygon into the mask (cell centers inside). */
	private fill(mask: Uint8Array, hull: readonly XY[]): void {
		if (hull.length < 3) return;
		let minY = Infinity;
		let maxY = -Infinity;
		for (const p of hull) {
			minY = Math.min(minY, p[1]);
			maxY = Math.max(maxY, p[1]);
		}
		const r0 = Math.max(0, Math.ceil((minY - this.y0) / this.cell - 0.5));
		const r1 = Math.min(this.h - 1, Math.floor((maxY - this.y0) / this.cell - 0.5));
		for (let r = r0; r <= r1; r++) {
			const y = this.y0 + (r + 0.5) * this.cell;
			let xl = Infinity;
			let xr = -Infinity;
			for (let i = 0; i < hull.length; i++) {
				const a = hull[i];
				const b = hull[(i + 1) % hull.length];
				if ((a[1] <= y && b[1] >= y) || (b[1] <= y && a[1] >= y)) {
					const x = a[1] === b[1] ? Math.min(a[0], b[0]) : a[0] + ((y - a[1]) * (b[0] - a[0])) / (b[1] - a[1]);
					const x2 = a[1] === b[1] ? Math.max(a[0], b[0]) : x;
					xl = Math.min(xl, x);
					xr = Math.max(xr, x2);
				}
			}
			if (xl > xr) continue;
			const c0 = Math.max(0, Math.ceil((xl - this.x0) / this.cell - 0.5));
			const c1 = Math.min(this.w - 1, Math.floor((xr - this.x0) / this.cell - 0.5));
			for (let c = c0; c <= c1; c++) mask[r * this.w + c] = 1;
		}
	}

	/** Two-pass chamfer (3-4) distance transform, inside and outside; result in px, signed. */
	private signedDistance(mask: Uint8Array): Float32Array {
		const { w, h } = this;
		const dist = (target: number): Float32Array => {
			// Distance (in cells) from each cell whose mask != target to the nearest cell with mask == target.
			const INF = 1e9;
			const d = new Float32Array(w * h);
			for (let i = 0; i < d.length; i++) d[i] = mask[i] === target ? 0 : INF;
			for (let r = 0; r < h; r++) {
				for (let c = 0; c < w; c++) {
					const i = r * w + c;
					let v = d[i];
					if (c > 0) v = Math.min(v, d[i - 1] + 1);
					if (r > 0) {
						v = Math.min(v, d[i - w] + 1);
						if (c > 0) v = Math.min(v, d[i - w - 1] + 1.4142);
						if (c < w - 1) v = Math.min(v, d[i - w + 1] + 1.4142);
					}
					d[i] = v;
				}
			}
			for (let r = h - 1; r >= 0; r--) {
				for (let c = w - 1; c >= 0; c--) {
					const i = r * w + c;
					let v = d[i];
					if (c < w - 1) v = Math.min(v, d[i + 1] + 1);
					if (r < h - 1) {
						v = Math.min(v, d[i + w] + 1);
						if (c < w - 1) v = Math.min(v, d[i + w + 1] + 1.4142);
						if (c > 0) v = Math.min(v, d[i + w - 1] + 1.4142);
					}
					d[i] = v;
				}
			}
			return d;
		};
		const toOutside = dist(0); // for inside cells: distance to nearest outside cell
		const toInside = dist(1); // for outside cells: distance to nearest inside cell
		const out = new Float32Array(w * h);
		for (let i = 0; i < out.length; i++) {
			// Cell-center distances; the boundary lies half a cell between the two cells.
			out[i] = mask[i] ? (toOutside[i] - 0.5) * this.cell : -(toInside[i] - 0.5) * this.cell;
		}
		return out;
	}

	/** Signed depth (px) at a point: > 0 inside, < 0 outside. Far outside the grid → −Infinity. */
	depth(x: number, y: number): number {
		const c = Math.floor((x - this.x0) / this.cell);
		const r = Math.floor((y - this.y0) / this.cell);
		if (c < 0 || r < 0 || c >= this.w || r >= this.h) return -Infinity;
		return this.depthMap[r * this.w + c];
	}
}

export interface Coverage {
	/** Fraction of the stroke's length within the dilated region. */
	covered: number;
	/** Fraction of the stroke's length inside the region (depth ≥ 0). */
	inside: number;
	/**
	 * Extent of the inside part along the stroke's main direction, as a fraction of the stroke's
	 * extent (a scribble over the left 40% of a word has span ≈ 0.4, however loopy the letters are).
	 */
	span: number;
	/** Fraction of the stroke's length deep inside the region. */
	interior: number;
}

/** How much of a polyline (`[x, y, ...]` points, same space as the region) the region covers. */
export function strokeCoverage(region: ScribbleRegion, pts: readonly (readonly number[])[]): Coverage {
	const C = COVERAGE;
	const at = (x: number, y: number): Coverage => {
		const d = region.depth(x, y);
		const inside = d >= 0 ? 1 : 0;
		return { covered: d >= -C.dilate ? 1 : 0, inside, span: inside, interior: d >= C.edgeMargin ? 1 : 0 };
	};
	if (pts.length === 0) return { covered: 0, inside: 0, span: 0, interior: 0 };
	if (pts.length === 1) return at(pts[0][0], pts[0][1]);
	const ang = principalAngle(pts);
	const ux = Math.cos(ang);
	const uy = Math.sin(ang);
	let pMin = Infinity;
	let pMax = -Infinity;
	let inMin = Infinity;
	let inMax = -Infinity;
	let total = 0;
	let covered = 0;
	let inside = 0;
	let interior = 0;
	for (let i = 1; i < pts.length; i++) {
		const a = pts[i - 1];
		const b = pts[i];
		const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
		if (len === 0) continue;
		const m = Math.max(1, Math.ceil(len / region.cell));
		const piece = len / m;
		for (let j = 0; j < m; j++) {
			const t = (j + 0.5) / m;
			const x = a[0] + (b[0] - a[0]) * t;
			const y = a[1] + (b[1] - a[1]) * t;
			const d = region.depth(x, y);
			const proj = x * ux + y * uy;
			pMin = Math.min(pMin, proj);
			pMax = Math.max(pMax, proj);
			total += piece;
			if (d >= -C.dilate) covered += piece;
			if (d >= 0) {
				inside += piece;
				inMin = Math.min(inMin, proj);
				inMax = Math.max(inMax, proj);
			}
			if (d >= C.edgeMargin) interior += piece;
		}
	}
	if (total === 0) return at(pts[0][0], pts[0][1]);
	const extent = pMax - pMin;
	const span = inMax < inMin ? 0 : extent < 1 ? 1 : Math.min(1, (inMax - inMin) / extent);
	return { covered: covered / total, inside: inside / total, span, interior: interior / total };
}

/** Parameter t ∈ [0, 1] along a→b where it crosses segment p→q, or −1. */
function crossT(a: readonly number[], b: readonly number[], p: readonly number[], q: readonly number[]): number {
	const rx = b[0] - a[0];
	const ry = b[1] - a[1];
	const sx = q[0] - p[0];
	const sy = q[1] - p[1];
	const den = rx * sy - ry * sx;
	if (den === 0) return -1;
	const wx = p[0] - a[0];
	const wy = p[1] - a[1];
	const t = (wx * sy - wy * sx) / den;
	const u = (wx * ry - wy * rx) / den;
	return t >= 0 && t <= 1 && u >= 0 && u <= 1 ? t : -1;
}

export interface Passes {
	/** Legs crossing the polyline in their middle part (scribbled over it). */
	mid: number;
	/** Legs crossing it only near an end (turned around on it, like hatching up to an outline). */
	ends: number;
}

/**
 * How many distinct legs of the scribble cross a polyline in their MIDDLE part — "how many times
 * the scribble went over it". Each leg is taken as its chord (start → end of the leg), so the
 * hand's jitter along a line parallel to a leg does not count as crossings; crossings within
 * `passEndFrac` of a leg's ends are turnarounds (hatching that reaches an outline) and are ignored.
 */
export function scribblePasses(
	scribble: readonly (readonly number[])[],
	legs: readonly (readonly [number, number])[],
	pts: readonly (readonly number[])[],
): Passes {
	const out: Passes = { mid: 0, ends: 0 };
	if (pts.length < 2) return out;
	const tb = boxOf(pts);
	const lo = COVERAGE.passEndFrac;
	for (const [ia, ib] of legs) {
		const a = scribble[ia];
		const b = scribble[ib];
		if (Math.max(a[0], b[0]) < tb.minX || Math.min(a[0], b[0]) > tb.maxX) continue;
		if (Math.max(a[1], b[1]) < tb.minY || Math.min(a[1], b[1]) > tb.maxY) continue;
		let mid = false;
		let end = false;
		for (let i = 1; i < pts.length && !mid; i++) {
			const t = crossT(a, b, pts[i - 1], pts[i]);
			if (t < 0) continue;
			if (t >= lo && t <= 1 - lo) mid = true;
			else end = true;
		}
		if (mid) out.mid++;
		else if (end) out.ends++;
	}
	return out;
}

/** Even-odd point in polygon. */
export function pointInPolygon(x: number, y: number, poly: readonly (readonly number[])[]): boolean {
	let inside = false;
	for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
		const xi = poly[i][0];
		const yi = poly[i][1];
		const xj = poly[j][0];
		const yj = poly[j][1];
		if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
	}
	return inside;
}

export interface ScribbleTarget {
	id: string;
	/** Points in the same coordinate space as the scribble. */
	points: readonly (readonly number[])[];
	/** Stroke width (px). */
	size: number;
}

/**
 * Ids of the strokes a scribble erases under the coverage rule (see file header). `region` may be
 * passed in when already built (e.g. for live preview).
 */
export function scribbleTargets(
	scribble: readonly (readonly number[])[],
	info: ScribbleInfo,
	targets: readonly ScribbleTarget[],
	region: ScribbleRegion = new ScribbleRegion(scribble, info),
): string[] {
	const C = COVERAGE;
	const sb = info.box;
	const sArea = Math.max(1, (sb.maxX - sb.minX) * (sb.maxY - sb.minY));
	const pad = C.dilate;
	const out: string[] = [];
	for (const t of targets) {
		if (t.points.length === 0) continue;
		const tb = boxOf(t.points);
		const half = t.size / 2;
		// Quick reject: no overlap with the (dilated) scribble bbox.
		if (tb.maxX + half < sb.minX - pad || tb.minX - half > sb.maxX + pad) continue;
		if (tb.maxY + half < sb.minY - pad || tb.minY - half > sb.maxY + pad) continue;
		const tArea = (tb.maxX - tb.minX + t.size) * (tb.maxY - tb.minY + t.size);
		if (tArea > C.maxAreaRatio * sArea) continue;
		const cov = strokeCoverage(region, t.points);
		if (Math.min(cov.inside, cov.span) < C.minInside) continue;
		const passes = scribblePasses(scribble, info.legs, t.points);
		if (passes.ends > passes.mid) continue;
		if (passes.mid < C.minPasses && cov.interior < C.minInterior) continue;
		if (isContainer(t.points, tb, scribble)) continue;
		out.push(t.id);
	}
	return out;
}

/** A closed stroke (ends meet) that encloses most of the scribble — e.g. an outline being shaded. */
function isContainer(
	pts: readonly (readonly number[])[],
	tb: { minX: number; minY: number; maxX: number; maxY: number },
	scribble: readonly (readonly number[])[],
): boolean {
	if (pts.length < 8) return false;
	const diag = Math.hypot(tb.maxX - tb.minX, tb.maxY - tb.minY);
	const a = pts[0];
	const b = pts[pts.length - 1];
	if (Math.hypot(a[0] - b[0], a[1] - b[1]) > Math.max(6, 0.2 * diag)) return false;
	let inside = 0;
	let n = 0;
	const step = Math.max(1, Math.floor(scribble.length / 200));
	for (let i = 0; i < scribble.length; i += step) {
		n++;
		if (pointInPolygon(scribble[i][0], scribble[i][1], pts)) inside++;
	}
	return n > 0 && inside / n >= COVERAGE.containerFrac;
}

// -------------------------------------------------------------------------------------------------
// One scribble gesture, from pen down to lift (live preview == commit)
// -------------------------------------------------------------------------------------------------

/**
 * Tracks one pen stroke as a possible scribble. Feed it the stroke so far (throttled, for the live
 * preview) and once more on lift; what it returns on lift is exactly what gets erased, and the
 * preview always shows exactly what it returned last.
 *
 * - **Latching.** The time limits of `detectScribble` (≤ 1.5 s, ≤ 200 ms per leg) only gate the
 *   START of the gesture. Once recognized, the stroke stays a scribble however long the user keeps
 *   going, as long as the whole stroke still has a scribble's shape (`scribbleShape` — the same
 *   thresholds as detection, minus time). That keeps handwriting whose first letters happen to
 *   look like a zigzag ("mm…") from erasing: the whole word no longer has the shape. The advance
 *   limit stays the one in force at recognition (+10% hysteresis): a scribble over a word starts
 *   taller than wide (limit 0.3) and turns wider than tall as it goes on, which used to switch it
 *   to the stricter sideways limit (0.22) and cancel it.
 * - **Monotonic.** While the gesture holds, candidates only accumulate: every update adds the
 *   strokes the coverage rule accepts for the scribble so far and none is dropped, so continuing to
 *   scribble (longer, or over more strokes) can only add candidates.
 */
export class ScribbleTracker {
	/** Advance limit in force when the gesture was recognized (null: not yet). */
	private latched: number | null = null;
	private valid = false;
	private readonly hits = new Set<string>();
	private static readonly NONE: ReadonlySet<string> = new Set();

	/** Is the stroke (so far) a scribble gesture? */
	get engaged(): boolean {
		return this.valid;
	}

	/** Ids to erase if the pen lifted now (fade them while drawing). */
	get ids(): ReadonlySet<string> {
		return this.valid ? this.hits : ScribbleTracker.NONE;
	}

	/**
	 * Re-evaluate with the stroke so far (`elapsedMs` since pen down). `candidates(box)` lists the
	 * strokes near the scribble's bbox. Returns the ids to erase if the pen lifted now.
	 */
	update(
		points: readonly (readonly number[])[],
		elapsedMs: number,
		candidates: (box: ScribbleInfo["box"]) => readonly ScribbleTarget[],
	): ReadonlySet<string> {
		let info: ScribbleInfo | null;
		if (this.latched !== null) {
			info = scribbleShape(points, this.latched);
		} else {
			info = detectScribble(points, elapsedMs);
			if (info) this.latched = SCRIBBLE.latchSlack * (info.major ? SCRIBBLE.maxAdvanceMajor : SCRIBBLE.maxAdvanceMinor);
		}
		this.valid = info !== null;
		if (info) for (const id of scribbleTargets(points, info, candidates(info.box))) this.hits.add(id);
		return this.ids;
	}
}
