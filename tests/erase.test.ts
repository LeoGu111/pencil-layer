import { describe, expect, it } from "vitest";
import type { Point } from "../src/model";
import { erasePiece, erasePieces, segSegDistSq } from "../src/erase";

/** Horizontal line from x0 to x1 at y, one point every `every` px. */
function hline(x0: number, x1: number, y: number, every = 5): Point[] {
	const out: Point[] = [];
	for (let x = x0; x <= x1; x += every) out.push([x, y, 0.5]);
	return out;
}

const xs = (p: Point[]) => p.map((q) => q[0]);

describe("segSegDistSq", () => {
	it("is 0 for crossing segments and the gap otherwise", () => {
		expect(segSegDistSq(0, 0, 10, 0, 5, -5, 5, 5)).toBe(0);
		expect(segSegDistSq(0, 0, 10, 0, 0, 3, 10, 3)).toBeCloseTo(9);
		expect(segSegDistSq(0, 0, 10, 0, 13, 4, 20, 4)).toBeCloseTo(25);
	});
});

describe("erasePiece", () => {
	const line = hline(0, 100, 50);

	it("returns null when the eraser doesn't reach the stroke", () => {
		expect(erasePiece(line, [50, 80, 60, 80], 10)).toBeNull();
		expect(erasePiece(line, [500, 50, 600, 50], 10)).toBeNull();
	});

	it("a vertical swipe through the middle splits the line in two at the eraser's edge", () => {
		const r = erasePiece(line, [50, 0, 50, 100], 10)!;
		expect(r).toHaveLength(2);
		const [left, right] = r;
		expect(left[0][0]).toBe(0);
		expect(Math.max(...xs(left))).toBeGreaterThan(38.9);
		expect(Math.max(...xs(left))).toBeLessThanOrEqual(40);
		expect(Math.min(...xs(right))).toBeGreaterThanOrEqual(60);
		expect(Math.min(...xs(right))).toBeLessThan(61.1);
		expect(right[right.length - 1][0]).toBe(100);
		// Untouched points are the original ones.
		expect(left[1]).toBe(line[1]);
	});

	it("stroke width widens the reach", () => {
		const r = erasePiece(line, [50, 0, 50, 100], 10 + 3)!;
		expect(Math.max(...xs(r[0]))).toBeLessThanOrEqual(37);
	});

	it("erasing an end shortens the stroke; erasing all of it leaves nothing", () => {
		const r = erasePiece(line, [100, 30, 100, 70], 10)!;
		expect(r).toHaveLength(1);
		expect(Math.max(...xs(r[0]))).toBeLessThanOrEqual(90);
		expect(r[0][0][0]).toBe(0);
		expect(erasePiece(line, [-20, 50, 120, 50], 10)).toEqual([]);
	});

	it("a dot is erased whole or not at all", () => {
		const dot: Point[] = [[10, 10, 0.5]];
		expect(erasePiece(dot, [12, 12, 12, 12], 5)).toEqual([]);
		expect(erasePiece(dot, [30, 30, 30, 30], 5)).toBeNull();
	});

	it("interpolates pressure in subdivided segments", () => {
		const s: Point[] = [
			[0, 0, 0],
			[100, 0, 1],
		];
		const r = erasePiece(s, [50, -20, 50, 20], 10)!;
		expect(r).toHaveLength(2);
		const lastLeft = r[0][r[0].length - 1];
		expect(lastLeft[2]).toBeCloseTo(lastLeft[0] / 100, 5);
	});

	it("crumbs shorter than a pixel are dropped", () => {
		const s: Point[] = [
			[0, 0, 0.5],
			[20, 0, 0.5],
		];
		// Eraser covers x ∈ (−∞, 19.5]: what's left is < 1 px.
		expect(erasePiece(s, [-30, 0, 9.5, 0], 10)).toEqual([]);
	});
});

describe("erasePieces (incremental drag)", () => {
	it("feeds successive eraser segments through the current pieces", () => {
		let pieces: Point[][] = [hline(0, 200, 0)];
		// Two separate swipes across the line → three pieces.
		pieces = erasePieces(pieces, [50, -30, 50, 30], 5) ?? pieces;
		expect(pieces).toHaveLength(2);
		pieces = erasePieces(pieces, [150, -30, 150, 30], 5) ?? pieces;
		expect(pieces).toHaveLength(3);
		// A segment far away changes nothing.
		expect(erasePieces(pieces, [0, 100, 200, 100], 5)).toBeNull();
		// Scrub along the whole line → gone.
		expect(erasePieces(pieces, [-10, 0, 210, 0], 5)).toEqual([]);
	});

	it("a diagonal eraser drag across a curve cuts it once", () => {
		const curve: Point[] = [];
		for (let i = 0; i <= 60; i++) curve.push([i * 3, 40 * Math.sin(i / 10), 0.5]);
		const r = erasePieces([curve], [60, -60, 120, 60], 4);
		expect(r).not.toBeNull();
		expect(r!.length).toBe(2);
	});
});
