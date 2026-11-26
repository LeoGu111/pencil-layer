import { describe, expect, it } from "vitest";
import {
	nearestGuideEdge,
	projectToEdge,
	projectToInfiniteEdge,
	rulerEdges,
	rulerGeometry,
	snapGuideAngle,
	twoFingerGuideTransform,
} from "../src/geometryGuide";

describe("geometryGuide (straight ruler & multi-touch)", () => {
	it("snaps angles magnetically to standard angles (0, 30, 45, 60, 90...)", () => {
		expect(snapGuideAngle(1.8)).toBe(0);
		expect(snapGuideAngle(358.5)).toBe(0);
		expect(snapGuideAngle(43.2)).toBe(45);
		expect(snapGuideAngle(91.5)).toBe(90);
		expect(snapGuideAngle(22)).toBe(22);
	});

	it("builds two parallel horizontal edges for a 0° ruler and snaps nearby strokes", () => {
		const geom = rulerGeometry([200, 100], 0, 100, 20);
		expect(geom.edges.length).toBe(2);
		expect(geom.corners[0]).toEqual([100, 80]);
		expect(geom.corners[1]).toEqual([300, 80]);
		expect(geom.corners[2]).toEqual([300, 120]);
		expect(geom.corners[3]).toEqual([100, 120]);

		const edges = rulerEdges([200, 100], 0, 100, 20);
		const snapped = nearestGuideEdge([180, 74], edges, 12);
		expect(snapped).not.toBeNull();
		expect(projectToEdge([180, 74], snapped!)).toEqual([180, 80]);
		// Unclamped projection lets strokes extend cleanly past either end of the ruler.
		expect(projectToInfiniteEdge([450, 74], snapped!)).toEqual([450, 80]);
		expect(projectToInfiniteEdge([20, 92], snapped!)).toEqual([20, 80]);
	});

	it("computes two-finger drag and rotation transforms with angle snapping", () => {
		const tf = twoFingerGuideTransform(
			[100, 100],
			0,
			[80, 100],
			[120, 100],
			[110, 80],
			[110, 120],
			3,
		);
		// Midpoint moved from (100, 100) to (110, 100), rotated +90°
		expect(tf.origin[0]).toBeCloseTo(110, 4);
		expect(tf.origin[1]).toBeCloseTo(100, 4);
		expect(tf.angle).toBe(90);
		expect(tf.scaleRatio).toBeCloseTo(1, 4);
	});
});
