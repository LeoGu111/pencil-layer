import { describe, expect, it } from "vitest";
import {
	CurveBuilder,
	MIN_DISTANCE,
	OneEuroFilter2D,
	SMOOTHING_PARAMS,
	SPoint,
	StrokeSmoother,
	curvePath,
	finishPoints,
	findCorners,
	sampleCurve,
	smoothArc,
	simplifyRDP,
	thinPoints,
} from "../src/smoothing";
import { rng } from "./handdrawn";

type XY = [number, number];
interface Sample {
	x: number;
	y: number;
	t: number;
}

/** Sample a parametric path at `hz` with uniform ±jitter, optionally rounded to whole pixels. */
function sample(at: (t: number) => XY, dur: number, hz: number, jitter: number, quantize: boolean, seed = 5) {
	const r = rng(seed);
	const out: Sample[] = [];
	const truth: XY[] = [];
	const n = Math.round(dur * hz);
	for (let i = 0; i <= n; i++) {
		const t = i / hz;
		const [x, y] = at(t);
		truth.push([x, y]);
		let nx = x + (r() - 0.5) * 2 * jitter;
		let ny = y + (r() - 0.5) * 2 * jitter;
		if (quantize) {
			nx = Math.round(nx);
			ny = Math.round(ny);
		}
		out.push({ x: nx, y: ny, t: 1000 + t * 1000 });
	}
	return { out, truth };
}

/** Cursive loops ("eeee"): `rate` letters per second, ~16 px tall. */
const cursive = (rate: number) => (t: number): XY => [10 + 11 * t * rate - 5 * Math.cos(2 * Math.PI * rate * t), 20 + 8 * Math.sin(2 * Math.PI * rate * t)];

/** Minimum-jerk traversal of a polyline (a hand slows into corners), `segMs` per segment. */
function minJerk(vs: XY[], segMs: number): { at: (t: number) => XY; dur: number } {
	const T = segMs / 1000;
	return {
		dur: (vs.length - 1) * T,
		at: (t) => {
			const i = Math.min(vs.length - 2, Math.floor(t / T));
			const u = Math.min(1, Math.max(0, t / T - i));
			const s = 10 * u ** 3 - 15 * u ** 4 + 6 * u ** 5;
			return [vs[i][0] + (vs[i + 1][0] - vs[i][0]) * s, vs[i][1] + (vs[i + 1][1] - vs[i][1]) * s];
		},
	};
}

function smooth(samples: Sample[], level: keyof typeof SMOOTHING_PARAMS = "medium"): SPoint[] {
	const sm = new StrokeSmoother(SMOOTHING_PARAMS[level]);
	for (const s of samples) sm.push(s.x, s.y, 0.5, s.t);
	return finishPoints(sm.points, sm.tip);
}

function densify(pts: XY[], step = 0.2): XY[] {
	const out: XY[] = [pts[0]];
	for (let i = 1; i < pts.length; i++) {
		const [a, b] = [pts[i - 1], pts[i]];
		const n = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / step));
		for (let k = 1; k <= n; k++) out.push([a[0] + ((b[0] - a[0]) * k) / n, a[1] + ((b[1] - a[1]) * k) / n]);
	}
	return out;
}

function distTo(p: readonly number[], dense: XY[]): number {
	let m = Infinity;
	for (const q of dense) m = Math.min(m, (p[0] - q[0]) ** 2 + (p[1] - q[1]) ** 2);
	return Math.sqrt(m);
}

/** RMS distance of the rendered curve from the true path. */
function rmsError(curve: XY[], truth: XY[]): number {
	const d = densify(truth);
	let s = 0;
	for (const c of curve) s += distTo(c, d) ** 2;
	return Math.sqrt(s / curve.length);
}

/** Roughness: RMS second difference of the curve resampled every 1 px (jaggies, staircase). */
function roughness(curve: XY[]): number {
	const r: XY[] = [curve[0]];
	let acc = 0;
	for (let i = 1; i < curve.length; i++) {
		const [a, b] = [curve[i - 1], curve[i]];
		const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
		let pos = 1 - acc;
		while (pos <= L) {
			r.push([a[0] + ((b[0] - a[0]) * pos) / L, a[1] + ((b[1] - a[1]) * pos) / L]);
			pos += 1;
		}
		acc = (acc + L) % 1;
	}
	let s = 0;
	for (let i = 1; i < r.length - 1; i++) {
		s += (r[i][0] - (r[i - 1][0] + r[i + 1][0]) / 2) ** 2 + (r[i][1] - (r[i - 1][1] + r[i + 1][1]) / 2) ** 2;
	}
	return Math.sqrt(s / Math.max(1, r.length - 2));
}

describe("OneEuroFilter2D", () => {
	it("passes the first sample through and is deterministic given timestamps", () => {
		const { out } = sample(cursive(2), 1, 240, 1, false);
		const run = () => {
			const f = new OneEuroFilter2D(SMOOTHING_PARAMS.medium!);
			return out.map((s) => f.filter(s.x, s.y, s.t));
		};
		const a = run();
		expect(a[0]).toEqual([out[0].x, out[0].y]);
		expect(run()).toEqual(a);
	});

	it("holds still on constant input and tolerates duplicate / out-of-order timestamps", () => {
		const f = new OneEuroFilter2D(SMOOTHING_PARAMS.medium!);
		for (let i = 0; i < 20; i++) expect(f.filter(5, 7, 100)).toEqual([5, 7]);
		const p = f.filter(6, 7, 90);
		expect(p.every(Number.isFinite)).toBe(true);
	});

	it("removes jitter on a slow stroke (strong smoothing when slow)", () => {
		// 30 px/s horizontal line with ±1 px jitter at 240 Hz.
		const { out } = sample((t) => [30 * t, 0], 2, 240, 1, false);
		const f = new OneEuroFilter2D(SMOOTHING_PARAMS.medium!);
		const ys = out.map((s) => f.filter(s.x, s.y, s.t)[1]).slice(60);
		const rawStd = Math.sqrt(out.slice(60).reduce((a, s) => a + s.y * s.y, 0) / ys.length);
		const std = Math.sqrt(ys.reduce((a, y) => a + y * y, 0) / ys.length);
		expect(std).toBeLessThan(rawStd / 2);
		// The committed stroke (after the lift refinement) is flatter still.
		const curve = sampleCurve(smooth(out), 8).slice(20, -20);
		const cStd = Math.sqrt(curve.reduce((a, p) => a + p[1] * p[1], 0) / curve.length);
		expect(cStd).toBeLessThan(rawStd / 4);
	});

	it("has little lag when fast", () => {
		// 600 px/s: trailing lag ≈ 1/(2π·beta) ≈ 1.3 px for Medium.
		const f = new OneEuroFilter2D(SMOOTHING_PARAMS.medium!);
		let last: [number, number] = [0, 0];
		for (let i = 0; i <= 120; i++) last = f.filter(600 * (i / 240), 0, (i / 240) * 1000);
		expect(600 * 0.5 - last[0]).toBeLessThan(2);
		expect(600 * 0.5 - last[0]).toBeGreaterThan(0);
	});
});

describe("StrokeSmoother", () => {
	it("keeps filtered points at least MIN_DISTANCE apart and tracks the raw tip", () => {
		const { out } = sample(cursive(1), 1, 240, 0.8, false);
		const sm = new StrokeSmoother(SMOOTHING_PARAMS.medium);
		for (const s of out) sm.push(s.x, s.y, 0.5, s.t);
		for (let i = 1; i < sm.points.length; i++) {
			const [a, b] = [sm.points[i - 1], sm.points[i]];
			expect(Math.hypot(b[0] - a[0], b[1] - a[1])).toBeGreaterThanOrEqual(MIN_DISTANCE);
		}
		const lastRaw = out[out.length - 1];
		expect(sm.tip).toEqual([lastRaw.x, lastRaw.y, 0.5]);
		expect(sm.livePoints()[sm.livePoints().length - 1]).toEqual(sm.tip);
	});

	it("Off = no filtering (raw points, only min-distance thinning)", () => {
		const sm = new StrokeSmoother(SMOOTHING_PARAMS.off);
		sm.push(0, 0, 0.5, 0);
		sm.push(0.2, 0, 0.5, 4);
		sm.push(3, 1, 0.5, 8);
		expect(sm.points).toEqual([
			[0, 0, 0.5],
			[3, 1, 0.5],
		]);
	});

	const cases: [string, (t: number) => XY, number][] = [
		["slow cursive", cursive(1), 3],
		["medium cursive", cursive(3), 1.5],
		["fast cursive", cursive(6), 0.8],
	];
	const variants: [string, number, number, boolean][] = [
		["240 Hz ±0.5", 240, 0.5, false],
		["240 Hz ±1", 240, 1, false],
		["120 Hz ±0.5", 120, 0.5, false],
		["240 Hz integer-quantized", 240, 0.3, true],
		["120 Hz integer-quantized, no jitter", 120, 0, true],
	];
	for (const [name, at, dur] of cases) {
		for (const [vname, hz, jitter, quant] of variants) {
			it(`${name}, ${vname}: smoother than raw and still on the path`, () => {
				const { out, truth } = sample(at, dur, hz, jitter, quant);
				const raw = sampleCurve(out.map((s) => [s.x, s.y]), 6) as XY[];
				const smooth3 = sampleCurve(smooth(out), 6) as XY[];
				const truthRough = roughness(densify(truth));
				// Excess roughness over the true path (jitter / staircase) at least halved...
				expect(roughness(smooth3) - truthRough).toBeLessThan(Math.max(0.03, (roughness(raw) - truthRough) / 2));
				// ...while staying close to the true path.
				expect(rmsError(smooth3, truth)).toBeLessThan(0.8);
			});
		}
	}

	it("a slow integer-quantized diagonal (pixel staircase) comes out straight", () => {
		// 20 px/s at 240 Hz, coordinates rounded to whole pixels: a staircase of 1 px steps.
		const { out } = sample((t) => [20 * t, 7 * t], 4, 240, 0, true);
		const pts = smooth(out);
		const curve = sampleCurve(pts, 8);
		// Perpendicular distance to the true line y = 0.35 x, away from the ends.
		const dev = curve.slice(10, -10).map(([x, y]) => Math.abs(y - 0.35 * x) / Math.hypot(1, 0.35));
		const rms = Math.sqrt(dev.reduce((a, d) => a + d * d, 0) / dev.length);
		expect(rms).toBeLessThan(0.1);
		expect(roughness(curve as XY[])).toBeLessThan(0.02);
		// Raw input for comparison: 1 px steps.
		const raw = sampleCurve(out.map((s) => [s.x, s.y]), 8);
		expect(roughness(raw as XY[])).toBeGreaterThan(0.1);
	});

	it("live → committed: the lift refinement moves the ink by a fraction of a pixel (no visible jump)", () => {
		for (const rate of [1, 3, 6]) {
			const { out } = sample(cursive(rate), 1.5, 240, 0.8, false);
			const sm = new StrokeSmoother(SMOOTHING_PARAMS.medium);
			for (const s of out) sm.push(s.x, s.y, 0.5, s.t);
			const live = sampleCurve(sm.livePoints(), 8) as XY[];
			const committed = sampleCurve(finishPoints(sm.points, sm.tip), 8) as XY[];
			const d = densify(live, 0.1);
			const worst = Math.max(...committed.map((p) => distTo(p, d)));
			expect(worst).toBeLessThan(0.6);
		}
	});

	it("keeps the corners of a 'v' / 'z' (no overshoot, little rounding)", () => {
		const v: XY[] = [
			[0, 0],
			[6, 14],
			[12, 0],
			[22, 0],
			[12, 14],
			[22, 14],
		];
		// Several jitter seeds: the corner must survive every realization, not one lucky draw.
		for (const segMs of [100, 250])
		for (const seed of [1, 2, 3, 4, 5, 7, 9]) {
			const path = minJerk(v, segMs);
			const { out } = sample(path.at, path.dur, 240, 0.5, false, seed);
			const curve = sampleCurve(smooth(out), 8);
			const ys = curve.map((p) => p[1]);
			// No overshoot beyond the drawn extent (convex hull property), allowing for the jitter.
			expect(Math.max(...ys)).toBeLessThan(14 + 0.6);
			expect(Math.min(...ys)).toBeGreaterThan(-0.6);
			// Each corner is still reached closely.
			for (const c of v.slice(1, -1)) expect(distTo(c, curve as XY[])).toBeLessThan(1.2);
		}
	});
});

describe("findCorners (lift refinement never smooths across a corner)", () => {
	it("finds the corners of a 'z' and pins them in smoothArc", () => {
		const z = densifyPts([
			[0, 0],
			[20, 0],
			[0, 14],
			[20, 14],
		]);
		const corners = findCorners(z);
		expect(corners.length).toBe(2);
		const at = corners.map((i) => z[i]);
		expect(Math.hypot(at[0][0] - 20, at[0][1])).toBeLessThan(0.6);
		expect(Math.hypot(at[1][0], at[1][1] - 14)).toBeLessThan(0.6);
		const sm = smoothArc(z, 1);
		for (const i of corners) expect(sm[i]).toEqual(z[i]);
	});

	it("finds no corners in round handwriting, a pixel staircase or a straight line", () => {
		// Circle of radius 6 px (a small "o"), sampled every 0.5 px.
		const o: SPoint[] = Array.from({ length: 76 }, (_, i) => {
			const a = (i / 75) * 2 * Math.PI;
			return [6 * Math.cos(a), 6 * Math.sin(a), 0.5];
		});
		expect(findCorners(o)).toEqual([]);
		const stairs: SPoint[] = Array.from({ length: 60 }, (_, i) => [Math.ceil(i / 2), Math.floor(i / 2), 0.5]);
		expect(findCorners(stairs)).toEqual([]);
		const straight: SPoint[] = Array.from({ length: 30 }, (_, i) => [i, 0, 0.5]);
		expect(findCorners(straight)).toEqual([]);
		expect(findCorners([[0, 0, 0.5], [1, 1, 0.5]])).toEqual([]);
	});
});

/** Polyline → points every `step` px. */
function densifyPts(vs: XY[], step = 0.5): SPoint[] {
	return densify(vs, step).map(([x, y]) => [x, y, 0.5]);
}

describe("curves", () => {
	const pts: SPoint[] = Array.from({ length: 30 }, (_, i) => [i * 2, Math.sin(i / 3) * 10, 0.5]);

	it("CurveBuilder (incremental, live) builds exactly what curvePath (committed) renders", () => {
		const b = new CurveBuilder();
		for (let n = 1; n <= pts.length; n++) {
			b.push(pts[n - 1]);
			expect(b.path()).toBe(curvePath(pts.slice(0, n)));
		}
		// With a tip: identical to the committed path of points + tip.
		const tip: SPoint = [61, 3, 0.5];
		expect(b.path(tip)).toBe(curvePath([...pts, tip]));
	});

	it("is prefix-stable: appending a point only changes the last segment", () => {
		const a = curvePath(pts.slice(0, 20));
		const b = curvePath(pts.slice(0, 21));
		const stable = a.slice(0, a.lastIndexOf(" L"));
		expect(b.startsWith(stable)).toBe(true);
	});

	it("uses quadratic curves, never straight segments between samples", () => {
		const d = curvePath(pts);
		expect((d.match(/L/g) ?? []).length).toBe(2); // first half-segment + final point
		expect((d.match(/Q/g) ?? []).length).toBe(pts.length - 2);
	});

	it("passes near the input (within half a segment) and stays inside its hull", () => {
		const curve = sampleCurve(pts, 8);
		for (const p of pts) expect(distTo(p, curve as XY[])).toBeLessThan(2);
		const ys = curve.map((p) => p[1]);
		expect(Math.max(...ys)).toBeLessThanOrEqual(Math.max(...pts.map((p) => p[1])) + 1e-9);
	});

	it("offsets and degenerate inputs", () => {
		expect(curvePath([])).toBe("");
		expect(curvePath([[1, 2, 0.5]])).toBe("M1 2 L1 2");
		expect(curvePath([[0, 0], [4, 0]], 1, 2)).toBe("M1 2 L3 2 L5 2");
		const b = new CurveBuilder();
		expect(b.path([3, 4, 0.5])).toBe("M3 4 L3 4");
	});
});

describe("finishPoints / simplifyRDP / thinPoints", () => {
	it("ends exactly at the lift point and simplifies collinear runs, keeping segments ≤ 3 px", () => {
		const line: SPoint[] = Array.from({ length: 41 }, (_, i) => [i * 0.5, 0, 0.5]);
		const out = finishPoints(line, [21, 0, 0.5]);
		expect(out[0]).toEqual([0, 0, 0.5]);
		expect(out[out.length - 1]).toEqual([21, 0, 0.5]);
		expect(out.length).toBeLessThan(line.length / 3);
		for (let i = 1; i < out.length; i++) expect(out[i][0] - out[i - 1][0]).toBeLessThanOrEqual(3);
	});

	it("dashed strokes keep every point (the dash pattern must not move on lift)", () => {
		const line: SPoint[] = Array.from({ length: 10 }, (_, i) => [i, 0, 0.5]);
		expect(finishPoints(line, [10, 0, 0.5], true)).toEqual([...line, [10, 0, 0.5]]);
		expect(finishPoints(line, [9, 0, 0.5], true)).toEqual(line);
	});

	it("smoothArc keeps the ends, flattens a staircase, and leaves straight lines alone", () => {
		const stairs: SPoint[] = [];
		for (let i = 0; i <= 40; i++) stairs.push([i, Math.floor(i / 3), 0.5]);
		const sm = smoothArc(stairs, 1);
		expect(sm[0]).toEqual(stairs[0]);
		expect(sm[sm.length - 1]).toEqual(stairs[stairs.length - 1]);
		const straight: SPoint[] = Array.from({ length: 20 }, (_, i) => [i, 2 * i, 0.5]);
		smoothArc(straight, 1).forEach((p, i) => {
			expect(p[0]).toBeCloseTo(straight[i][0], 9);
			expect(p[1]).toBeCloseTo(straight[i][1], 9);
		});
		expect(smoothArc(stairs, 0)).toEqual(stairs);
	});

	it("RDP keeps the corner of an L", () => {
		const l: XY[] = [
			[0, 0],
			[1, 0],
			[2, 0],
			[2, 1],
			[2, 2],
		];
		expect(simplifyRDP(l, 0.25)).toEqual([
			[0, 0],
			[2, 0],
			[2, 2],
		]);
	});

	it("thinPoints drops close points, always keeps the ends, and is prefix-stable", () => {
		const pts: XY[] = Array.from({ length: 50 }, (_, i) => [i * 0.4, (i % 2) * 0.3]);
		const t = thinPoints(pts, 1.5);
		expect(t[0]).toEqual(pts[0]);
		expect(t[t.length - 1]).toEqual(pts[pts.length - 1]);
		for (let i = 1; i < t.length - 1; i++) expect(Math.hypot(t[i][0] - t[i - 1][0], t[i][1] - t[i - 1][1])).toBeGreaterThanOrEqual(1.5);
		const t2 = thinPoints(pts.slice(0, 30), 1.5);
		expect(t.slice(0, t2.length - 1)).toEqual(t2.slice(0, -1));
	});
});
