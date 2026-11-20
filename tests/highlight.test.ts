import { describe, expect, it } from "vitest";
import { STRAIGHT_SPACING, straightLine } from "../src/highlight";

describe("straightLine (straight highlighter)", () => {
	it("snaps nearly horizontal lines to horizontal", () => {
		const pts = straightLine([10, 50], [210, 60]); // ~2.9°
		expect(pts[0]).toEqual([10, 50, 0.5]);
		expect(pts[pts.length - 1]).toEqual([210, 50, 0.5]);
		expect(pts.every((p) => p[1] === 50)).toBe(true);
	});

	it("keeps steeper lines as drawn, densified evenly", () => {
		const pts = straightLine([0, 0], [100, 40]);
		expect(pts[pts.length - 1][0]).toBeCloseTo(100);
		expect(pts[pts.length - 1][1]).toBeCloseTo(40);
		for (let i = 1; i < pts.length; i++) {
			expect(Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1])).toBeLessThanOrEqual(STRAIGHT_SPACING + 1e-9);
		}
	});

	it("works right-to-left and for a zero-length press", () => {
		const rtl = straightLine([200, 20], [20, 25]);
		expect(rtl[rtl.length - 1]).toEqual([20, 20, 0.5]);
		expect(straightLine([5, 5], [5, 5])).toHaveLength(2);
	});
});
