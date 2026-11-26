import { describe, expect, it } from "vitest";
import {
	bbox,
	distSqPointSegment,
	distSqSegmentSegment,
	hitTestStroke,
	hitTestStrokeSegment,
	centerlinePath,
	dashArray,
	isCenterline,
	isDashed,
	outlineToPath,
	strokeToPath,
} from "../src/geometry";
import type { Point } from "../src/model";

const line: Point[] = Array.from({ length: 11 }, (_, i) => [i * 10, 50, 0.5] as Point);
/** Notes-style (perfect-freehand outline) pen. */
const pen = { tool: "pen" as const, size: 4, style: "notes" as const, points: line };
const ball = { tool: "pen" as const, size: 1.6, style: "ball" as const, points: line };
const hl = { tool: "highlighter" as const, size: 12, points: line };

const pathNumbers = (d: string) => (d.match(/-?\d+(\.\d+)?/g) ?? []).map(Number);

describe("strokeToPath", () => {
	it("produces a closed, non-empty path", () => {
		const d = strokeToPath(pen);
		expect(d.startsWith("M")).toBe(true);
		expect(d.endsWith("Z")).toBe(true);
		expect(pathNumbers(d).every(Number.isFinite)).toBe(true);
	});

	it("returns empty for no points", () => {
		expect(strokeToPath({ ...pen, points: [] })).toBe("");
	});

	it("renders a single dot", () => {
		expect(strokeToPath({ ...pen, points: [[5, 5, 0.5]] }).length).toBeGreaterThan(0);
	});

	it("applies the offset", () => {
		const base = bbox(pathNumbers(strokeToPath(pen)).reduce<number[][]>((acc, n, i, arr) => {
			if (i % 2 === 0) acc.push([n, arr[i + 1]]);
			return acc;
		}, []))!;
		const moved = bbox(pathNumbers(strokeToPath(pen, { offsetX: 100, offsetY: 1000 })).reduce<number[][]>((acc, n, i, arr) => {
			if (i % 2 === 0) acc.push([n, arr[i + 1]]);
			return acc;
		}, []))!;
		expect(moved.minY - base.minY).toBeCloseTo(1000, 0);
		expect(moved.minX - base.minX).toBeCloseTo(100, 0);
	});

	it("highlighter is constant width regardless of pressure", () => {
		const varying: Point[] = line.map((p, i) => [p[0], p[1], i % 2 ? 0.1 : 1] as Point);
		const a = strokeToPath({ ...hl, points: varying });
		const b = strokeToPath({ ...hl, points: line.map((p) => [p[0], p[1], 0.5] as Point) });
		expect(a).toBe(b);
	});

	it("notes pen varies width with pressure", () => {
		const varying = strokeToPath({ ...pen, points: line.map((p, i) => [p[0], p[1], i % 2 ? 0.1 : 1] as Point) });
		const flat = strokeToPath({ ...pen, points: line.map((p) => [p[0], p[1], 0.7] as Point) });
		expect(varying).not.toBe(flat);
	});

	it("ballpoint is an open smooth centerline (quadratic midpoint curve)", () => {
		const d = strokeToPath(ball);
		expect(d.endsWith("Z")).toBe(false);
		expect(d.startsWith("M0 50 L5 50 Q10 50 15 50 Q20 50 25 50")).toBe(true);
		expect(d.endsWith("L100 50")).toBe(true);
		// Pressure has no effect on a ballpoint.
		expect(strokeToPath({ ...ball, points: line.map((p, i) => [p[0], p[1], i % 2 ? 0.1 : 1] as Point) })).toBe(d);
		expect(strokeToPath(ball, { offsetX: 1, offsetY: 2 }).startsWith("M1 52 L6 52 Q11 52")).toBe(true);
	});

	it("snapped shapes keep straight segments (sharp corners)", () => {
		const sq: Point[] = [[0, 0, 0.5], [10, 0, 0.5], [10, 10, 0.5]];
		expect(strokeToPath({ ...ball, points: sq, shape: "polyline" as const })).toBe("M0 0 L10 0 L10 10");
	});

	it("pens without a style (M1 strokes) render as ballpoint", () => {
		const legacy = { tool: "pen" as const, size: 3.5, points: line };
		expect(isCenterline(legacy)).toBe(true);
		expect(strokeToPath(legacy)).toBe(strokeToPath(ball));
	});

	it("dashed uses a fixed screen-space dash pattern (7 px dash, 5 px gap with round caps)", () => {
		const dashed = { ...ball, style: "dashed" as const };
		expect(isCenterline(dashed)).toBe(true);
		expect(isDashed(dashed)).toBe(true);
		expect(dashArray(dashed)).toBe("5.4 6.6");
		// Wider pens scale the pattern; thinner keep the base pattern.
		expect(dashArray({ ...dashed, size: 3.2 })).toBe("10.8 13.2");
		expect(dashArray({ ...dashed, size: 1 })).toBe("6 6");
		expect(dashArray(ball)).toBeNull();
		expect(dashArray(hl)).toBeNull();
	});

	it("legacy dotted strokes render exactly like dashed", () => {
		const dotted = { ...ball, style: "dotted" as const };
		const dashed = { ...ball, style: "dashed" as const };
		expect(isDashed(dotted)).toBe(true);
		expect(dashArray(dotted)).toBe(dashArray(dashed));
		expect(strokeToPath(dotted)).toBe(strokeToPath(dashed));
	});

	it("dashed drops sub-1.5 px jitter points so path length (and dash density) is speed-independent", () => {
		// The same 100 px line, drawn slowly (dense, zigzag jitter) vs fast (sparse).
		const slow: Point[] = Array.from({ length: 401 }, (_, i) => [i * 0.25, 50 + (i % 2 ? 0.4 : -0.4), 0.5] as Point);
		const fast: Point[] = Array.from({ length: 11 }, (_, i) => [i * 10, 50, 0.5] as Point);
		const len = (d: string) => {
			const pts = sampleCurveFromPath(d);
			let l = 0;
			for (let i = 1; i < pts.length; i++) l += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
			return l;
		};
		const lSlow = len(strokeToPath({ ...ball, style: "dashed", points: slow }));
		const lFast = len(strokeToPath({ ...ball, style: "dashed", points: fast }));
		expect(Math.abs(lSlow - lFast) / lFast).toBeLessThan(0.02);
		// A ballpoint keeps every point (only dashed thins).
		expect(len(strokeToPath({ ...ball, points: slow }))).toBeGreaterThan(lSlow);
	});

	it("highlighter and notes pens are filled outlines", () => {
		expect(isCenterline(hl)).toBe(false);
		expect(isCenterline(pen)).toBe(false);
		expect(isCenterline({ tool: "highlighter", style: "ball" })).toBe(false);
		expect(isCenterline({ tool: "pen", style: "pencil" })).toBe(false);
	});

	it("tilted ballpoint strokes become variable-width filled outlines while dashed stays centerline", () => {
		const tilts = line.map((_, i) => (i > 4 ? 0.8 : 0.1));
		expect(isCenterline({ ...ball, tilts })).toBe(false);
		expect(isCenterline({ ...ball, style: "dashed", tilts })).toBe(true);
		const tiltedPath = strokeToPath({ ...ball, tilts });
		expect(tiltedPath.endsWith("Z")).toBe(true);
		expect(tiltedPath).not.toBe(strokeToPath(ball));
	});
});

describe("centerlinePath", () => {
	it("renders a single point as a zero-length segment (round cap ⇒ dot)", () => {
		expect(centerlinePath({ ...ball, points: [[5, 6, 0.5]] })).toBe("M5 6 L5 6");
		expect(centerlinePath({ ...ball, points: [] })).toBe("");
	});
});

/** Polyline approximation of an M/L/Q path (Q sampled). */
function sampleCurveFromPath(d: string): [number, number][] {
	const out: [number, number][] = [];
	const tokens = d.match(/[MLQ]|-?\d+(\.\d+)?/g) ?? [];
	let i = 0;
	let cur: [number, number] = [0, 0];
	while (i < tokens.length) {
		const c = tokens[i++];
		if (c === "M" || c === "L") {
			cur = [Number(tokens[i++]), Number(tokens[i++])];
			out.push(cur);
		} else if (c === "Q") {
			const cx = Number(tokens[i++]);
			const cy = Number(tokens[i++]);
			const e: [number, number] = [Number(tokens[i++]), Number(tokens[i++])];
			for (let k = 1; k <= 8; k++) {
				const t = k / 8;
				const u = 1 - t;
				out.push([u * u * cur[0] + 2 * u * t * cx + t * t * e[0], u * u * cur[1] + 2 * u * t * cy + t * t * e[1]]);
			}
			cur = e;
		}
	}
	return out;
}

describe("outlineToPath", () => {
	it("handles tiny outlines", () => {
		expect(outlineToPath([])).toBe("");
		expect(outlineToPath([[1, 2]])).toBe("M1 2 Z");
	});
});

describe("bbox", () => {
	it("computes bounds", () => {
		expect(bbox([[1, 5, 0.5], [-3, 2, 0.5], [4, -1, 0.5]])).toEqual({ minX: -3, minY: -1, maxX: 4, maxY: 5 });
	});
	it("is null for empty", () => {
		expect(bbox([])).toBeNull();
	});
});

describe("distance helpers", () => {
	it("point to segment", () => {
		expect(distSqPointSegment(5, 3, 0, 0, 10, 0)).toBe(9);
		expect(distSqPointSegment(-3, 4, 0, 0, 10, 0)).toBe(25); // beyond the end
		expect(distSqPointSegment(1, 1, 0, 0, 0, 0)).toBe(2); // degenerate segment
	});
	it("segment to segment", () => {
		expect(distSqSegmentSegment(0, 0, 10, 10, 0, 10, 10, 0)).toBe(0); // crossing
		expect(distSqSegmentSegment(0, 0, 10, 0, 0, 5, 10, 5)).toBe(25); // parallel
	});
});

describe("hitTestStroke", () => {
	it("hits near the stroke, including between points", () => {
		expect(hitTestStroke(pen, 55, 52, 5)).toBe(true);
		expect(hitTestStroke(pen, 0, 50, 1)).toBe(true);
	});

	it("misses far away", () => {
		expect(hitTestStroke(pen, 55, 80, 10)).toBe(false);
		expect(hitTestStroke(pen, 200, 50, 10)).toBe(false);
	});

	it("accounts for stroke width", () => {
		// 7px away: miss with radius 4 + half-width 2 = 6; hit with a 12px wide highlighter (4 + 6 = 10).
		expect(hitTestStroke(pen, 50, 57, 4)).toBe(false);
		expect(hitTestStroke(hl, 50, 57, 4)).toBe(true);
	});

	it("uses the anchor offset", () => {
		// Stroke local y=50, anchor line at overlay y=300 → stroke is at overlay y=350.
		expect(hitTestStroke(pen, 50, 50, 5, 0, 300)).toBe(false);
		expect(hitTestStroke(pen, 50, 350, 5, 0, 300)).toBe(true);
		expect(hitTestStroke(pen, 70, 350, 5, 20, 300)).toBe(true);
	});

	it("handles single-point and empty strokes", () => {
		const dot = { tool: "pen" as const, size: 2, points: [[10, 10, 0.5]] as Point[] };
		expect(hitTestStroke(dot, 12, 12, 3)).toBe(true);
		expect(hitTestStroke(dot, 20, 20, 3)).toBe(false);
		expect(hitTestStroke({ ...dot, points: [] }, 10, 10, 100)).toBe(false);
	});

	it("segment hit test catches fast eraser swipes across a stroke", () => {
		// Eraser jumps from above to below the line between two events.
		expect(hitTestStroke(pen, 50, 0, 5)).toBe(false);
		expect(hitTestStroke(pen, 50, 100, 5)).toBe(false);
		expect(hitTestStrokeSegment(pen, 50, 0, 50, 100, 5)).toBe(true);
		expect(hitTestStrokeSegment(pen, 500, 0, 500, 100, 5)).toBe(false);
	});
});
