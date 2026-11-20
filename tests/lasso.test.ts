import { describe, expect, it } from "vitest";
import {
	IDENTITY,
	MAX_SCALE,
	MIN_SCALE,
	applyTransform,
	handleScale,
	hitSelection,
	isIdentity,
	scaledSize,
	selectInLasso,
	strokeInLasso,
	svgTransform,
	transformBox,
	transformPoints,
} from "../src/lasso";
import type { Point } from "../src/model";

const sq = [
	[0, 0],
	[100, 0],
	[100, 100],
	[0, 100],
];
const line = (x0: number, y0: number, x1: number, y1: number, n = 11): Point[] =>
	Array.from({ length: n }, (_, i) => [x0 + ((x1 - x0) * i) / (n - 1), y0 + ((y1 - y0) * i) / (n - 1), 0.5] as Point);

describe("lasso hit-testing (touch rule)", () => {
	it("fully inside / fully outside", () => {
		expect(strokeInLasso(line(10, 10, 90, 90), sq)).toBe(true);
		expect(strokeInLasso(line(110, 10, 190, 90), sq)).toBe(false);
	});

	it("selected when ANY point is inside, however few", () => {
		// x=60..160: 5 of 11 points inside (was NOT selected under the majority rule).
		expect(strokeInLasso(line(60, 50, 160, 50), sq)).toBe(true);
		// Only the first point inside.
		expect(strokeInLasso(line(95, 50, 395, 50), sq)).toBe(true);
		// A single-point stroke (dot) inside / outside.
		expect(strokeInLasso([[50, 50, 0.5]], sq)).toBe(true);
		expect(strokeInLasso([[150, 50, 0.5]], sq)).toBe(false);
	});

	it("a small loop around the end of a long line selects the whole line", () => {
		const long = line(0, 300, 1000, 300, 2); // just two points, far apart
		const loop = [
			[980, 290],
			[1010, 290],
			[1010, 310],
			[980, 310],
		];
		expect(strokeInLasso(long, loop)).toBe(true);
		expect(selectInLasso([{ points: long }], loop, () => 0)).toHaveLength(1);
	});

	it("selected when a segment crosses the loop even with no point inside", () => {
		// Two points on either side of the square: the segment crosses it.
		expect(strokeInLasso(line(-50, 50, 150, 50, 2), sq)).toBe(true);
		// A small loop around the middle of a sparse segment.
		const mid = [
			[490, 280],
			[510, 280],
			[510, 320],
			[490, 320],
		];
		expect(strokeInLasso(line(0, 300, 1000, 300, 2), mid)).toBe(true);
		// The lasso is an open polyline closed implicitly: crossing near its closing edge counts.
		const tri = [
			[0, 0],
			[100, 0],
			[100, 100],
		];
		expect(strokeInLasso(line(0, 60, 70, -10, 2), tri)).toBe(true);
	});

	it("near misses are not selected", () => {
		expect(strokeInLasso(line(-50, 101, 150, 101, 2), sq)).toBe(false);
		expect(strokeInLasso(line(101, -50, 101, 150, 30), sq)).toBe(false);
	});

	it("uses the stroke's line offset", () => {
		expect(strokeInLasso(line(10, 10, 90, 20), sq, 0, 500)).toBe(false);
		expect(strokeInLasso(line(10, -490, 90, -480), sq, 0, 500)).toBe(true);
		// Crossing test with the offset too.
		expect(strokeInLasso(line(-50, -450, 150, -450, 2), sq, 0, 500)).toBe(true);
	});

	it("works with a concave (freeform) loop", () => {
		// U-shaped lasso: the notch (40..60, 0..80) is outside.
		const u = [
			[0, 0],
			[40, 0],
			[40, 80],
			[60, 80],
			[60, 0],
			[100, 0],
			[100, 100],
			[0, 100],
		];
		expect(strokeInLasso(line(45, 10, 55, 60), u)).toBe(false);
		expect(strokeInLasso(line(10, 10, 30, 60), u)).toBe(true);
		// A stroke inside the notch that pokes into the U's arm is selected.
		expect(strokeInLasso(line(50, 40, 70, 40, 2), u)).toBe(true);
	});

	it("degenerate lassos select nothing", () => {
		expect(strokeInLasso(line(0, 0, 10, 10), [[0, 0], [10, 10]])).toBe(false);
		expect(strokeInLasso([], sq)).toBe(false);
	});

	it("selectInLasso picks pens and highlighters by touch, honouring each stroke's top", () => {
		const a = { id: "a", points: line(10, 10, 90, 10), top: 0 };
		const b = { id: "b", points: line(10, 10, 90, 10), top: 200 };
		const hl = { id: "hl", tool: "highlighter", points: line(20, -150, 80, -150), top: 200 };
		// Mostly outside, one end inside.
		const c = { id: "c", points: line(90, 50, 400, 50), top: 0 };
		const got = selectInLasso([a, b, hl, c], sq, (s) => s.top).map((s) => s.id);
		expect(got).toEqual(["a", "hl", "c"]);
	});

	it("selectInLasso only considers the candidates it is given (callers pre-filter by tool)", () => {
		const pen = { id: "p", tool: "pen", points: line(10, 10, 90, 10) };
		const hl = { id: "h", tool: "highlighter", points: line(10, 20, 90, 20) };
		const cands = [pen, hl].filter((s) => s.tool === "highlighter");
		expect(selectInLasso(cands, sq, () => 0).map((s) => s.id)).toEqual(["h"]);
	});

	it("is fast enough for a big note", () => {
		const strokes = Array.from({ length: 2000 }, (_, i) => ({ points: line(0, i * 10, 300, i * 10 + 5, 60) }));
		const loop = Array.from({ length: 400 }, (_, i) => {
			const t = (i / 400) * 2 * Math.PI;
			return [150 + 140 * Math.cos(t), 10000 + 140 * Math.sin(t)];
		});
		const t0 = performance.now();
		const got = selectInLasso(strokes, loop, () => 0);
		expect(performance.now() - t0).toBeLessThan(200);
		expect(got.length).toBeGreaterThan(20);
		expect(got.length).toBeLessThan(40);
	});
});

describe("selection transforms", () => {
	it("identity", () => {
		expect(isIdentity(IDENTITY)).toBe(true);
		expect(applyTransform(3, 4, IDENTITY)).toEqual([3, 4]);
		expect(svgTransform(IDENTITY)).toBe("");
	});

	it("move", () => {
		const t = { dx: 10, dy: -5, scale: 1, ox: 0, oy: 0 };
		expect(transformPoints([[1, 2, 0.3]], 100, t)).toEqual([[11, 97, 0.3]]);
		expect(svgTransform(t).trim()).toBe("translate(10 -5)");
	});

	it("scale about the origin corner, then move; stroke width scales too", () => {
		const t = { dx: 0, dy: 0, scale: 2, ox: 10, oy: 10 };
		expect(applyTransform(10, 10, t)).toEqual([10, 10]);
		expect(applyTransform(20, 15, t)).toEqual([30, 20]);
		expect(scaledSize(1.6, t)).toBeCloseTo(3.2);
		expect(scaledSize(1, { ...t, scale: 0.1 })).toBe(0.3); // clamped
		expect(transformBox({ minX: 10, minY: 10, maxX: 20, maxY: 30 }, t)).toEqual({ minX: 10, minY: 10, maxX: 30, maxY: 50 });
	});

	it("svgTransform matches applyTransform", () => {
		const t = { dx: 7, dy: 3, scale: 1.5, ox: 40, oy: 20 };
		// translate(ox+dx, oy+dy) scale(s) translate(-ox, -oy) applied to (x, y):
		const [x, y] = [100, 60];
		const viaSvg = [(x - t.ox) * t.scale + t.ox + t.dx, (y - t.oy) * t.scale + t.oy + t.dy];
		expect(applyTransform(x, y, t)).toEqual(viaSvg);
		expect(svgTransform(t)).toContain("scale(1.5)");
	});

	it("handleScale projects the drag on the diagonal and clamps", () => {
		expect(handleScale([0, 0], [100, 100], [200, 200])).toBeCloseTo(2);
		expect(handleScale([0, 0], [100, 100], [50, 50])).toBeCloseTo(0.5);
		expect(handleScale([0, 0], [100, 0], [150, 999])).toBeCloseTo(1.5);
		expect(handleScale([0, 0], [100, 100], [-50, -50])).toBe(MIN_SCALE);
		expect(handleScale([0, 0], [10, 10], [1e5, 1e5])).toBe(MAX_SCALE);
		expect(handleScale([0, 0], [0, 0], [10, 10])).toBe(1);
	});

	it("hitSelection: handle, inside, outside", () => {
		const b = { minX: 0, minY: 0, maxX: 100, maxY: 50 };
		expect(hitSelection(b, 104, 53, 12)).toBe("handle");
		expect(hitSelection(b, 50, 25, 12)).toBe("inside");
		expect(hitSelection(b, 104, 25, 12, 6)).toBe("inside");
		expect(hitSelection(b, 150, 25, 12, 6)).toBeNull();
	});
});
