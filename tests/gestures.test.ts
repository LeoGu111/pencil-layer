import { describe, expect, it } from "vitest";
import {
	COVERAGE,
	ScribbleRegion,
	ScribbleTarget,
	ScribbleTracker,
	Tap,
	canPair,
	convexHull,
	detectScribble,
	isDoubleTap,
	isTap,
	pointInPolygon,
	reversals1D,
	scribblePasses,
	scribbleTargets,
	strokeCoverage,
} from "../src/gestures";
import { XY, along, curve, cursive, letterM, letterW, noisy } from "./handdrawn";

// -------------------------------------------------------------------------------------------------
// Synthetic gestures
// -------------------------------------------------------------------------------------------------

/** Horizontal back-and-forth from x0..x1, progressing from y0 to y1 over `legs` legs. */
function zigzagH(x0: number, x1: number, y0: number, y1: number, legs: number, seed = 1): XY[] {
	const v: XY[] = [];
	for (let i = 0; i <= legs; i++) v.push([i % 2 === 0 ? x0 : x1, y0 + ((y1 - y0) * i) / legs]);
	return noisy(along(v, 2, seed), 1, 0.4, seed);
}

/** Vertical zigzag between y0..y1, progressing from x0 to x1. */
function zigzagV(y0: number, y1: number, x0: number, x1: number, legs: number, seed = 1): XY[] {
	const v: XY[] = [];
	for (let i = 0; i <= legs; i++) v.push([x0 + ((x1 - x0) * i) / legs, i % 2 === 0 ? y0 : y1]);
	return noisy(along(v, 2, seed), 0.8, 0.3, seed);
}

const target = (id: string, pts: XY[], size = 1.6) => ({ id, points: pts, size });
const rectOutline = (x: number, y: number, w: number, h: number, seed = 5) =>
	noisy(along([[x, y], [x + w, y], [x + w, y + h], [x, y + h], [x, y + 1]], 2, seed), 1, 0.4, seed);

function erasedBy(scribble: XY[], ms: number, targets: { id: string; points: XY[]; size: number }[]): string[] | null {
	const info = detectScribble(scribble, ms);
	if (!info) return null;
	return scribbleTargets(scribble, info, targets);
}

// -------------------------------------------------------------------------------------------------
// Double tap
// -------------------------------------------------------------------------------------------------

describe("double tap", () => {
	const tap = (x: number, y: number, downAt: number, dur = 60, move = 1): Tap => ({ x, y, downAt, upAt: downAt + dur, maxMove: move });

	it("recognizes taps", () => {
		expect(isTap(tap(0, 0, 0))).toBe(true);
		expect(isTap(tap(0, 0, 0, 250))).toBe(false); // too long
		expect(isTap(tap(0, 0, 0, 60, 8))).toBe(false); // moved
	});

	it("two quick taps at the same spot", () => {
		const a = tap(100, 100, 0);
		expect(isDoubleTap(a, tap(104, 103, 200))).toBe(true);
		expect(canPair(a, 104, 103, 200)).toBe(true);
	});

	it("rejects slow, distant or long taps", () => {
		const a = tap(100, 100, 0);
		expect(isDoubleTap(a, tap(100, 100, 60 + 400))).toBe(false); // gap 400 ms
		expect(isDoubleTap(a, tap(120, 100, 200))).toBe(false); // 20 px away
		expect(isDoubleTap(a, tap(100, 100, 200, 300))).toBe(false); // second is a press
		expect(isDoubleTap(tap(100, 100, 0, 60, 10), tap(100, 100, 200))).toBe(false); // first was a stroke
	});

	it("dots of handwriting (i, j, punctuation) far apart do not pair", () => {
		expect(isDoubleTap(tap(10, 10, 0), tap(40, 12, 250))).toBe(false);
	});
});

// -------------------------------------------------------------------------------------------------
// Scribble detection
// -------------------------------------------------------------------------------------------------

describe("detectScribble", () => {
	it("reversals1D with hysteresis ignores jitter", () => {
		expect(reversals1D([0, 10, 9.5, 10.2, 0, 10, 0], 5)).toEqual([3, 4, 5]);
		expect(reversals1D([0, 1, 0, 1, 0], 5)).toEqual([]);
	});

	it("horizontal back-and-forth scribble", () => {
		for (const seed of [1, 2, 3]) {
			const s = zigzagH(100, 180, 100, 120, 8, seed);
			const info = detectScribble(s, 800);
			expect(info).not.toBeNull();
			expect(info!.reversals.length).toBeGreaterThanOrEqual(7);
		}
	});

	it("tight vertical zigzag over a word", () => {
		expect(detectScribble(zigzagV(100, 124, 100, 140, 14), 1000)).not.toBeNull();
	});

	it("too slow → not a scribble", () => {
		expect(detectScribble(zigzagH(100, 180, 100, 120, 8), 2000)).toBeNull();
	});

	it("too few reversals → not a scribble", () => {
		expect(detectScribble(zigzagH(100, 180, 100, 120, 3), 400)).toBeNull();
	});

	it("normal handwriting is not a scribble (even when written fast)", () => {
		expect(detectScribble(noisy(letterM(0, 100), 0.5, 0.3), 450)).toBeNull();
		const mmm = [...letterM(0, 100), ...letterM(28, 100), ...letterM(56, 100)];
		expect(detectScribble(noisy(mmm, 0.5, 0.3), 1200)).toBeNull();
		expect(detectScribble(noisy(letterW(0, 100), 0.4, 0.2), 400)).toBeNull();
		const ww = [...letterW(0, 100), ...letterW(26, 100), ...letterW(52, 100)];
		expect(detectScribble(noisy(ww, 0.4, 0.2), 1000)).toBeNull();
		for (const seed of [1, 2, 3, 4, 5]) {
			expect(detectScribble(noisy(cursive(0, 100, 6, 18, seed), 0.6, 0.3, seed), 1400)).toBeNull();
		}
	});

	it("straight lines, circles and a single back-and-forth are not scribbles", () => {
		expect(detectScribble(along([[0, 0], [200, 0]]), 300)).toBeNull();
		expect(detectScribble(curve((t) => [100 + 50 * Math.cos(t), 100 + 50 * Math.sin(t)], 0, 2 * Math.PI), 500)).toBeNull();
		expect(detectScribble(along([[0, 0], [100, 0], [0, 5]]), 300)).toBeNull();
	});
});

// -------------------------------------------------------------------------------------------------
// Coverage rule
// -------------------------------------------------------------------------------------------------

describe("scribble coverage rule", () => {
	it("erases a word that the scribble covers", () => {
		const word = noisy(cursive(110, 120, 3, 14, 2), 0.4, 0.2, 2); // ~x 110..150, y 106..120
		const scribble = zigzagH(95, 175, 98, 128, 10);
		expect(erasedBy(scribble, 900, [target("word", word)])).toEqual(["word"]);
	});

	it("erases several small strokes under the scribble, keeps a neighbour outside", () => {
		const a = along([[110, 105], [120, 118]]);
		const b = along([[130, 118], [140, 104]]);
		const outside = along([[220, 105], [240, 118]]);
		const got = erasedBy(zigzagH(100, 160, 98, 126, 10), 900, [target("a", a), target("b", b), target("out", outside)]);
		expect(got?.sort()).toEqual(["a", "b"]);
	});

	it("shading inside a rectangle (single closed outline) keeps the outline", () => {
		const rect = rectOutline(100, 100, 200, 100);
		// Hatching edge to edge, even overshooting the outline by ~2 px.
		const shading = zigzagH(98, 302, 102, 198, 16, 4);
		const info = detectScribble(shading, 1300);
		expect(info).not.toBeNull(); // it IS a fast zigzag…
		expect(scribbleTargets(shading, info!, [target("rect", rect)])).toEqual([]); // …but the outline survives
	});

	it("shading inside a rectangle drawn as 4 separate lines keeps every side", () => {
		const sides = [
			along([[100, 100], [300, 100]]),
			along([[300, 100], [300, 200]]),
			along([[300, 200], [100, 200]]),
			along([[100, 200], [100, 100]]),
		].map((p, i) => target(`side${i}`, noisy(p, 0.8, 0.3, i + 1)));
		for (const seed of [1, 2, 3]) {
			const shading = zigzagH(101, 299, 101, 199, 16, seed);
			expect(erasedBy(shading, 1300, sides) ?? []).toEqual([]);
		}
	});

	it("vertical hatching inside a triangle keeps its sides", () => {
		const tri = noisy(along([[100, 300], [300, 300], [200, 120], [100, 299]]), 0.8, 0.3);
		// Legs from the base up to the slanted sides.
		const v: XY[] = [];
		const legs = 18;
		for (let i = 0; i <= legs; i++) {
			const x = 110 + (180 * i) / legs;
			const top = 300 - 180 * (1 - Math.abs(x - 200) / 100);
			v.push([x, i % 2 === 0 ? 299 : top + 1]);
		}
		const shading = noisy(along(v), 0.6, 0.3);
		expect(erasedBy(shading, 1400, [target("tri", tri)]) ?? []).toEqual([]);
	});

	it("shading under a concave curve keeps the curve (region follows the legs, not the hull)", () => {
		const f = (x: number) => 232 - ((x - 200) * (x - 200)) / 50; // hill: higher at the ends
		const crv = curve((t) => [t, f(t)], 160, 240, 80);
		const v: XY[] = [];
		const legs = 16;
		for (let i = 0; i <= legs; i++) {
			const x = 161 + (78 * i) / legs;
			v.push([x, i % 2 === 0 ? 270 : f(x) + 1]);
		}
		const shading = noisy(along(v), 0.5, 0.2);
		expect(erasedBy(shading, 1200, [target("curve", crv)]) ?? []).toEqual([]);
	});

	it("scribbling across graph axes keeps the axes, erases the small mark under it", () => {
		const xAxis = along([[50, 300], [450, 300]]);
		const yAxis = along([[50, 50], [50, 300]]);
		const mark = along([[210, 290], [225, 310]]);
		const scribble = zigzagH(195, 245, 280, 320, 10);
		const got = erasedBy(scribble, 900, [target("x", xAxis), target("y", yAxis), target("mark", mark)]);
		expect(got).toEqual(["mark"]);
	});

	it("an L-shaped axes stroke through the scribble survives", () => {
		const axes = along([[60, 40], [60, 200], [260, 200]]);
		const scribble = zigzagH(50, 110, 180, 220, 10);
		expect(erasedBy(scribble, 900, [target("axes", axes)]) ?? []).toEqual([]);
	});

	it("never erases strokes much larger than the scribble", () => {
		// A big zigzag-ish stroke that happens to lie mostly inside: area rule.
		const big = along([[0, 0], [400, 0], [400, 300]]);
		const scribble = zigzagH(100, 140, 100, 120, 8);
		expect(erasedBy(scribble, 700, [target("big", big)]) ?? []).toEqual([]);
	});

	it("a circle enclosing shading is kept even when shading reaches its edge", () => {
		const circle = curve((t) => [200 + 60 * Math.cos(t), 200 + 60 * Math.sin(t)], 0, 2 * Math.PI, 120);
		const v: XY[] = [];
		const legs = 14;
		for (let i = 0; i <= legs; i++) {
			const y = 150 + (100 * i) / legs;
			const half = Math.sqrt(Math.max(0, 60 * 60 - (y - 200) ** 2));
			v.push([i % 2 === 0 ? 200 - half - 2 : 200 + half + 2, y]);
		}
		const shading = noisy(along(v), 0.5, 0.2);
		expect(erasedBy(shading, 1200, [target("circle", circle)]) ?? []).toEqual([]);
	});

	it("a small circle scribbled over completely is erased", () => {
		const circle = curve((t) => [130 + 10 * Math.cos(t), 112 + 8 * Math.sin(t)], 0, 2 * Math.PI, 40);
		expect(erasedBy(zigzagH(105, 160, 95, 130, 10), 900, [target("c", circle)])).toEqual(["c"]);
	});
});

describe("region / geometry helpers", () => {
	it("convexHull of a square with interior points", () => {
		const h = convexHull([[0, 0], [10, 0], [10, 10], [0, 10], [5, 5], [3, 7]]);
		expect(h).toHaveLength(4);
	});

	it("pointInPolygon", () => {
		const sq: XY[] = [[0, 0], [10, 0], [10, 10], [0, 10]];
		expect(pointInPolygon(5, 5, sq)).toBe(true);
		expect(pointInPolygon(15, 5, sq)).toBe(false);
	});

	it("depth is positive inside, negative outside, ~0 at the edge", () => {
		const s = zigzagH(100, 200, 100, 140, 12);
		const info = detectScribble(s, 900)!;
		const r = new ScribbleRegion(s, info);
		expect(r.depth(150, 120)).toBeGreaterThan(10);
		expect(r.depth(150, 170)).toBeLessThan(-20);
		expect(Math.abs(r.depth(100, 120))).toBeLessThan(COVERAGE.edgeMargin);
		expect(r.depth(-1000, -1000)).toBe(-Infinity);
		const cov = strokeCoverage(r, along([[120, 110], [180, 130]]));
		expect(cov.covered).toBe(1);
		expect(cov.interior).toBeGreaterThan(0.8);
	});
});

// -------------------------------------------------------------------------------------------------
// Calibration (iPad feedback: "I need less scribble touching the shape"; erase must not cancel)
// -------------------------------------------------------------------------------------------------

/**
 * Vertical zigzag whose BODY (middle of the first leg → middle of the last leg) spans x0..x1 — what
 * "the scribble covers X% of the word" means (the slanted first/last legs only half-cover).
 */
function zigzagBody(y0: number, y1: number, x0: number, x1: number, legs: number, seed = 1): XY[] {
	const p = (x1 - x0) / legs;
	return zigzagV(y0, y1, x0 - p / 2, x1 + p / 2, legs, seed);
}

/** A cursive word starting at x0 (y ≈ 106..120), with its x range. */
function word(seed: number, x0 = 110): { pts: XY[]; minX: number; maxX: number } {
	const pts = noisy(cursive(x0, 120, 3 + (seed % 3), 14, seed), 0.4, 0.2, seed);
	return { pts, minX: Math.min(...pts.map((p) => p[0])), maxX: Math.max(...pts.map((p) => p[0])) };
}

/** Scribble the middle `f` of [minX, maxX], with horizontal legs (H) or vertical legs (V). */
function scribbleOver(minX: number, maxX: number, f: number, kind: "H" | "V", seed: number): XY[] {
	const w = (maxX - minX) * f;
	const c = (minX + maxX) / 2;
	return kind === "H"
		? zigzagH(c - w / 2, c + w / 2, 102, 124, 9, seed)
		: zigzagBody(100, 126, c - w / 2, c + w / 2, Math.max(6, Math.round(w / 5)), seed);
}

/**
 * Feed a stroke to a tracker the way the live preview does (every `everyMs`), then lift. Returns
 * every preview's ids and the ids erased on lift.
 */
function simulate(stroke: XY[], totalMs: number, targets: readonly ScribbleTarget[], everyMs = 120) {
	const tr = new ScribbleTracker();
	const previews: string[][] = [];
	for (let t = everyMs; t < totalMs; t += everyMs) {
		const n = Math.max(1, Math.round((stroke.length * t) / totalMs));
		previews.push([...tr.update(stroke.slice(0, n), t, () => targets)].sort());
	}
	const erased = [...tr.update(stroke, totalMs, () => targets)].sort();
	return { previews, erased, engaged: tr.engaged };
}

describe("scribble calibration: how much scribble is enough", () => {
	const seeds = [1, 2, 3, 4, 5, 6, 7, 8];

	it("a word: 40% scribbled → kept, 60% and 100% → erased (both scribble directions)", () => {
		for (const seed of seeds) {
			const w = word(seed);
			const t = [target("w", w.pts)];
			for (const kind of ["H", "V"] as const) {
				expect(erasedBy(scribbleOver(w.minX, w.maxX, 0.4, kind, seed), 900, t) ?? [], `40% ${kind} seed ${seed}`).toEqual([]);
				for (const f of [0.6, 1]) {
					const got = erasedBy(scribbleOver(w.minX, w.maxX, f, kind, seed), 900, t);
					if (got === null) continue; // a few synthetic V zigzags aren't recognized at all (detector, see below)
					expect(got, `${f * 100}% ${kind} seed ${seed}`).toEqual(["w"]);
				}
			}
		}
	});

	it("most synthetic 60% / 100% scribbles over a word are recognized (sanity for the test above)", () => {
		let n = 0;
		for (const seed of seeds) {
			const w = word(seed);
			for (const f of [0.6, 1])
				for (const kind of ["H", "V"] as const) if (erasedBy(scribbleOver(w.minX, w.maxX, f, kind, seed), 900, [target("w", w.pts)])?.length) n++;
		}
		expect(n).toBeGreaterThanOrEqual(26); // of 32
	});

	it("a short stroke (30 px): 40% → kept, 60% and 100% → erased", () => {
		for (const seed of seeds) {
			const short = [target("s", noisy(along([[100, 110], [130, 112]]), 0.5, 0.2, seed))];
			const s = (f: number) => zigzagBody(98, 124, 115 - 15 * f, 115 + 15 * f, Math.max(6, Math.round((30 * f) / 3)), seed);
			expect(erasedBy(s(0.4), 800, short) ?? [], `seed ${seed}`).toEqual([]);
			expect(erasedBy(s(0.6), 800, short), `seed ${seed}`).toEqual(["s"]);
			expect(erasedBy(s(1), 800, short), `seed ${seed}`).toEqual(["s"]);
		}
	});

	it("a long line (300 px): scribbling its middle 20% or 40% keeps it, 60% erases it", () => {
		for (const seed of [1, 2, 3, 4]) {
			const line = [target("line", noisy(along([[50, 200], [350, 200]]), 0.8, 0.3, seed))];
			const s = (f: number) => zigzagBody(185, 215, 200 - 150 * f, 200 + 150 * f, Math.round((300 * f) / 5), seed);
			expect(erasedBy(s(0.2), 1400, line) ?? []).toEqual([]);
			expect(erasedBy(s(0.4), 1400, line) ?? []).toEqual([]);
			expect(erasedBy(s(0.6), 1400, line)).toEqual(["line"]);
		}
	});

	it("passes: legs crossing in their middle count, turnarounds on an outline do not", () => {
		const s = zigzagBody(100, 126, 110, 150, 8);
		const info = detectScribble(s, 700)!;
		expect(scribblePasses(s, info.legs, along([[100, 113], [160, 113]])).mid).toBeGreaterThanOrEqual(7);
		// A line along the bottom turnarounds (like hatching reaching and overshooting an outline).
		const edge = scribblePasses(s, info.legs, along([[100, 125], [160, 125]]));
		expect(edge.mid).toBe(0);
		expect(edge.ends).toBeGreaterThan(0);
	});

	it("the bbox guard is relaxed with the coverage (≤ 4× the scribble's area), still rejects much larger", () => {
		// A word with a tall ascender ("..l..") scribbled at x-height over 65% of its width: its bbox
		// is ~2.15× the scribble's, so the old 2× guard kept it.
		const a = cursive(110, 120, 2, 14, 1);
		const end = a[a.length - 1];
		const asc = along([end, [end[0] + 4, end[1] - 40], [end[0] + 8, end[1]]], 1.5);
		const pts = noisy([...a, ...asc, ...cursive(end[0] + 8, 120, 2, 14, 11)], 0.4, 0.2, 1);
		const minX = Math.min(...pts.map((p) => p[0]));
		const maxX = Math.max(...pts.map((p) => p[0]));
		const w = (maxX - minX) * 0.65;
		const c = (minX + maxX) / 2;
		const s = zigzagBody(100, 126, c - w / 2, c + w / 2, Math.round(w / 5), 1);
		const sb = detectScribble(s, 900)!.box;
		const minY = Math.min(...pts.map((p) => p[1]));
		const maxY = Math.max(...pts.map((p) => p[1]));
		const ratio = ((maxX - minX + 1.6) * (maxY - minY + 1.6)) / ((sb.maxX - sb.minX) * (sb.maxY - sb.minY));
		expect(ratio).toBeGreaterThan(2);
		expect(erasedBy(s, 900, [target("wl", pts)])).toEqual(["wl"]);
		const huge = along([[0, 0], [400, 0], [400, 300]]);
		expect(erasedBy(zigzagH(100, 140, 100, 120, 8), 700, [target("big", huge)]) ?? []).toEqual([]);
	});
});

describe("scribble calibration: shading and graphs never erase", () => {
	it("hatching in a box that overshoots the outline (0–8 px) keeps every side, dense or sparse", () => {
		const sides = [
			along([[100, 100], [300, 100]]),
			along([[300, 100], [300, 200]]),
			along([[300, 200], [100, 200]]),
			along([[100, 200], [100, 100]]),
		].map((p, i) => target(`side${i}`, noisy(p, 0.8, 0.3, i + 1)));
		const rect = target("rect", rectOutline(100, 100, 200, 100));
		for (const over of [0, 2, 5, 8]) {
			for (const legs of [16, 40]) {
				const shading = zigzagH(100 - over, 300 + over, 101, 199, legs, 3);
				expect(simulate(shading, 1400, [...sides, rect]).erased, `over ${over} legs ${legs}`).toEqual([]);
			}
		}
	});

	it("vertical hatching in a small box (scribble ≈ box) keeps the box", () => {
		for (const over of [0, 3, 6]) {
			const box = target("box", rectOutline(100, 100, 40, 30));
			const shading = zigzagV(100 - over, 130 + over, 101, 139, 12, over + 1);
			expect(simulate(shading, 900, [box]).erased, `over ${over}`).toEqual([]);
		}
	});

	it("cross-hatching on a graph keeps the axes and the curve, even overshooting the axes", () => {
		const yAxis = target("y", noisy(along([[50, 40], [50, 300]]), 0.6, 0.3, 1));
		const xAxis = target("x", noisy(along([[50, 300], [450, 300]]), 0.6, 0.3, 2));
		const f = (x: number) => 300 - 150 * Math.sin(((x - 50) / 400) * Math.PI);
		const crv = target("curve", curve((t) => [t, f(t)], 50, 450, 160));
		// Vertical hatching from below the x-axis (overshoot 6 px) up to the curve.
		const v: XY[] = [];
		for (let i = 0; i <= 20; i++) {
			const x = 150 + (100 * i) / 20;
			v.push([x, i % 2 === 0 ? 306 : f(x) + 2]);
		}
		const hatch1 = noisy(along(v), 0.6, 0.3, 4);
		// Horizontal hatching from left of the y-axis (overshooting it) across, under the curve.
		const hatch2 = zigzagH(44, 120, 250, 296, 16, 5);
		for (const h of [hatch1, hatch2]) expect(simulate(h, 1400, [xAxis, yAxis, crv]).erased).toEqual([]);
	});

	it("a scribble clearly on an axis does erase it (scribbling most of a short axis)", () => {
		const yAxis = target("y", noisy(along([[50, 100], [50, 200]]), 0.6, 0.3, 1));
		expect(erasedBy(zigzagH(35, 65, 110, 190, 24), 1300, [yAxis])).toEqual(["y"]);
	});
});

describe("scribble gesture tracking: preview == commit", () => {
	/** Back-and-forth over the same area, progressing down and back up (scribbling "harder"). */
	function longScribble(x0: number, x1: number, y0: number, y1: number, legs: number, seed = 1): XY[] {
		const v: XY[] = [];
		for (let i = 0; i <= legs; i++) {
			const k = i % 20;
			const y = y0 + ((y1 - y0) * (k <= 10 ? k : 20 - k)) / 10;
			v.push([i % 2 === 0 ? x0 : x1, y]);
		}
		return noisy(along(v, 2, seed), 1, 0.4, seed);
	}

	it("the detector alone gives up after 1.5 s (why the old commit cancelled the previewed erase)", () => {
		const s = longScribble(95, 175, 98, 128, 30);
		expect(detectScribble(s.slice(0, Math.round(s.length * 0.4)), 1080)).not.toBeNull();
		expect(detectScribble(s, 2700)).toBeNull();
	});

	it("a scribble lasting > 1.5 s still erases what it covers on lift", () => {
		for (const seed of [1, 2, 3]) {
			const w = word(seed);
			const s = longScribble(w.minX - 8, w.maxX + 8, 98, 128, 30, seed);
			const r = simulate(s, 2700, [target("w", w.pts)]);
			expect(r.engaged).toBe(true);
			expect(r.erased).toEqual(["w"]);
		}
	});

	it("extending the scribble over more strokes adds them (3 words, ~2.7 s)", () => {
		const ws = [word(1, 110), word(2, 180), word(3, 250)];
		const s = zigzagBody(100, 126, 110, ws[2].maxX, 60, 2);
		const r = simulate(s, 2700, ws.map((w, i) => target(`w${i}`, w.pts)));
		expect(r.erased).toEqual(["w0", "w1", "w2"]);
		// The first word already showed as fading early on.
		expect(r.previews[Math.floor(r.previews.length / 3)]).toContain("w0");
	});

	it("candidates only accumulate, and lift erases a superset of every preview (many gestures)", () => {
		const cases: { s: XY[]; ms: number; t: ScribbleTarget[] }[] = [];
		for (const seed of [1, 2, 3, 4]) {
			const w = word(seed);
			for (const f of [0.4, 0.6, 1])
				for (const kind of ["H", "V"] as const) cases.push({ s: scribbleOver(w.minX, w.maxX, f, kind, seed), ms: 900, t: [target("w", w.pts)] });
			cases.push({ s: longScribble(w.minX, w.maxX, 98, 128, 30, seed), ms: 2700, t: [target("w", w.pts)] });
		}
		const ws = [word(1, 110), word(2, 180), word(3, 250)].map((w, i) => target(`w${i}`, w.pts));
		cases.push({ s: zigzagBody(100, 126, 110, 300, 60), ms: 2700, t: ws });
		for (const c of cases) {
			const r = simulate(c.s, c.ms, c.t, 60);
			let prev: string[] = [];
			for (const p of [...r.previews, r.erased]) {
				for (const id of prev) expect(p).toContain(id);
				prev = p;
			}
		}
	});

	it("lift with nothing new since the last preview erases exactly what is shown", () => {
		const w = word(2);
		const s = scribbleOver(w.minX, w.maxX, 0.7, "H", 2);
		const tr = new ScribbleTracker();
		const shown = [...tr.update(s, 800, () => [target("w", w.pts)])];
		const erased = [...tr.update(s, 900, () => [target("w", w.pts)])];
		expect(shown).toEqual(["w"]);
		expect(erased).toEqual(shown);
	});

	it("shading previews never show the outline as a candidate at any point", () => {
		const circle = target("circle", curve((t) => [200 + 60 * Math.cos(t), 200 + 60 * Math.sin(t)], 0, 2 * Math.PI, 120));
		const v: XY[] = [];
		for (let i = 0; i <= 14; i++) {
			const y = 150 + (100 * i) / 14;
			const half = Math.sqrt(Math.max(0, 60 * 60 - (y - 200) ** 2));
			v.push([i % 2 === 0 ? 200 - half - 2 : 200 + half + 2, y]);
		}
		const r = simulate(noisy(along(v), 0.5, 0.2), 1200, [circle], 40);
		for (const p of r.previews) expect(p).toEqual([]);
		expect(r.erased).toEqual([]);
	});
});

describe("scribble gesture tracking: handwriting never engages", () => {
	/** Ink already on the page under the writing (it would be erased if writing engaged). */
	const under = [target("a", along([[0, 95], [120, 95]])), target("b", noisy(cursive(0, 100, 5, 16, 9), 0.4, 0.2, 9))];

	const samples: [string, XY[], number][] = [
		["m", noisy(letterM(0, 100), 0.5, 0.3), 450],
		["w", noisy(letterW(0, 100), 0.4, 0.2), 400],
		["mm", noisy([...letterM(0, 100), ...letterM(28, 100)], 0.5, 0.3), 800],
		["mmm", noisy([...letterM(0, 100), ...letterM(28, 100), ...letterM(56, 100)], 0.5, 0.3), 1200],
		["mmmmm", noisy([0, 1, 2, 3, 4].flatMap((k) => letterM(k * 28, 100)), 0.5, 0.3), 2000],
		["www", noisy([...letterW(0, 100), ...letterW(26, 100), ...letterW(52, 100)], 0.4, 0.2), 1000],
		...[1, 2, 3, 4, 5].map((seed): [string, XY[], number] => [`cursive ${seed}`, noisy(cursive(0, 100, 6, 18, seed), 0.6, 0.3, seed), 1400]),
		// Dense small writing (x-height 7–8 px), written fast.
		["small mmmm", noisy([0, 1, 2, 3].flatMap((k) => letterM(k * 11, 100, 8, 10)), 0.3, 0.15), 900],
		["small www", noisy([0, 1, 2].flatMap((k) => letterW(k * 10, 100, 7, 9)), 0.3, 0.15), 700],
		...[1, 2, 3].map((seed): [string, XY[], number] => [`small cursive ${seed}`, noisy(cursive(0, 100, 10, 7, seed), 0.3, 0.15, seed), 1300]),
	];

	for (const [name, pts, ms] of samples) {
		it(`${name}: no prefix is a scribble, nothing erased`, () => {
			const r = simulate(pts, ms, under, 40);
			expect(r.engaged).toBe(false);
			expect(r.erased).toEqual([]);
		});
	}
});
