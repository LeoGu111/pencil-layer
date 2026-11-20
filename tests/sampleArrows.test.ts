import { readFileSync } from "fs";
import { describe, expect, it } from "vitest";
import { parseInkFile } from "../src/model";
import { ShapeSpec, recognizeShape } from "../src/shapes";
import { rng } from "./handdrawn";

/**
 * Hand-drawn strokes recorded on an iPad (v2 sidecar, raw coordinates only): ten small arrows
 * (~25–55 px) drawn shaft → tip → barb → back → barb, often with a landing curl, a slightly curved
 * shaft, a big head, rounded loops at the tip, or the head drawn as a ">" after the shaft; plus a dot
 * and a tiny tick.
 */
const ink = parseInkFile(readFileSync(`${__dirname}/fixtures/sample-arrows.v2.json`, "utf8"));
const strokes = ink.strokes.map((s) => ({ id: s.id, pts: s.points.map((p): [number, number] => [p[0], p[1]]) }));
const diag = (pts: [number, number][]) => {
	const xs = pts.map((p) => p[0]);
	const ys = pts.map((p) => p[1]);
	return Math.hypot(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));
};
const arrows = strokes.filter((s) => diag(s.pts) >= 16);
const specks = strokes.filter((s) => diag(s.pts) < 16);

describe("sample hand-drawn arrows (draw and hold)", () => {
	it("the fixture has 10 arrows and 2 specks", () => {
		expect(arrows).toHaveLength(10);
		expect(specks).toHaveLength(2);
	});

	it("every arrow is recognized as an arrow (points as recorded; the end is the hold point)", () => {
		for (const { id, pts } of arrows) {
			const s = recognizeShape(pts);
			expect(s?.kind, id).toBe("arrow");
			const a = s as Extract<ShapeSpec, { kind: "arrow" }>;
			// These arrows all point right: tip near the rightmost point, start at the left end.
			const maxX = Math.max(...pts.map((p) => p[0]));
			const minX = Math.min(...pts.map((p) => p[0]));
			expect(maxX - a.b[0], `${id} tip (the tip loop may overshoot)`).toBeLessThanOrEqual(6);
			expect(a.a[0] - minX, `${id} start`).toBeLessThanOrEqual(6);
			expect(a.head, `${id} head`).toBeGreaterThan(6);
		}
	});

	it("…also with the drift recorded while the pen is held", () => {
		for (const { id, pts } of arrows) {
			for (const seed of [1, 2, 3]) {
				const rand = rng(seed);
				const last = pts[pts.length - 1];
				const held = [...pts];
				for (let i = 0; i < 30; i++) held.push([last[0] + (rand() - 0.5) * 3, last[1] + (rand() - 0.5) * 3]);
				expect(recognizeShape(held)?.kind, `${id} seed ${seed}`).toBe("arrow");
			}
		}
	});

	it("the dot and the tick do not snap", () => {
		for (const { pts } of specks) expect(recognizeShape(pts)).toBeNull();
	});
});
