import { describe, expect, it } from "vitest";
import {
	PinchActivation,
	ZOOM_MAX,
	ZOOM_MIN,
	clampZoom,
	distanceBetween,
	formatZoomPercent,
	midpoint,
	pinchScale,
	scrollForZoomAnchor,
	wheelZoomFactor,
} from "../src/zoom";

describe("zoom helpers", () => {
	it("clamps zoom values cleanly inside bounds", () => {
		expect(clampZoom(0.1)).toBe(ZOOM_MIN);
		expect(clampZoom(10)).toBe(ZOOM_MAX);
		expect(clampZoom(1.5)).toBe(1.5);
		expect(clampZoom(NaN)).toBe(1);
	});

	it("scales proportionally during a pinch gesture", () => {
		expect(pinchScale(1, 100, 150)).toBe(1.5);
		expect(pinchScale(1, 100, 20)).toBe(ZOOM_MIN);
		expect(pinchScale(2, 100, 300)).toBe(ZOOM_MAX);
	});

	it("anchors the scroll offset to the pinch midpoint", () => {
		// Document point at scroll=100 + focal=200 = 300 -> after 2x zoom is at 600 -> scroll = 600 - 200 = 400.
		expect(scrollForZoomAnchor(100, 200, 2)).toBe(400);
		// Midpoint also panned right by 20px -> scroll shifts left by 20px to 380.
		expect(scrollForZoomAnchor(100, 200, 2, 220)).toBe(380);
		expect(scrollForZoomAnchor(0, 0, 0.5, 50)).toBe(0);
	});

	it("deadbands tiny finger spacing jitter before activating pinch zoom", () => {
		const act = new PinchActivation(200, 0.03);
		expect(act.ratio(204)).toBe(1);
		expect(act.active).toBe(false);
		// Crossing 3% rebases cleanly at 1.0 with no jump.
		expect(act.ratio(210)).toBe(1);
		expect(act.active).toBe(true);
		expect(act.ratio(315)).toBeCloseTo(1.5, 5);
	});

	it("computes geometry and wheel factors cleanly", () => {
		expect(distanceBetween({ x: 0, y: 0 }, { x: 3, y: 4 })).toBe(5);
		expect(midpoint({ x: 10, y: 20 }, { x: 30, y: 60 })).toEqual({ x: 20, y: 40 });
		expect(wheelZoomFactor(-50)).toBeGreaterThan(1);
		expect(wheelZoomFactor(50)).toBeLessThan(1);
		expect(formatZoomPercent(1.246)).toBe("125%");
	});
});
