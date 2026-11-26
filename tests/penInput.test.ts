import { describe, expect, it } from "vitest";
import { isPenEraser, pointerTilt, pointerTiltAngleDeg, resampleTilts, tiltWidthMultiplier, toolForPress } from "../src/penInput";

const ev = (pointerType: string, button: number, buttons: number) => ({ pointerType, button, buttons });

describe("pen eraser end (Surface Pen / Windows Ink)", () => {
	it("pointerdown of the eraser end: button 5, buttons 32", () => {
		expect(isPenEraser(ev("pen", 5, 32))).toBe(true);
		expect(toolForPress(ev("pen", 5, 32), "pen")).toBe("eraser");
		expect(toolForPress(ev("pen", 5, 32), "lasso")).toBe("eraser");
	});
	it("eraser bit held (e.g. reported with another button)", () => {
		expect(isPenEraser(ev("pen", 0, 32))).toBe(true);
		expect(isPenEraser(ev("pen", -1, 33))).toBe(true);
	});
	it("the pen tip and the barrel button keep the selected tool", () => {
		expect(toolForPress(ev("pen", 0, 1), "highlighter")).toBe("highlighter");
		expect(toolForPress(ev("pen", 2, 2), "pen")).toBe("pen");
		expect(toolForPress(ev("pen", 0, 3), "lasso")).toBe("lasso");
	});
	it("only pens have an eraser end", () => {
		expect(isPenEraser(ev("mouse", 5, 32))).toBe(false);
		expect(isPenEraser(ev("touch", 0, 32))).toBe(false);
	});
});

describe("stylus tilt (Apple Pencil Neigung)", () => {
	it("computes tilt angle from altitudeAngle or tiltX/tiltY for pens only", () => {
		expect(pointerTiltAngleDeg({ pointerType: "mouse", tiltX: 60, tiltY: 0 })).toBe(0);
		expect(pointerTiltAngleDeg({ pointerType: "pen", tiltX: 0, tiltY: 0 })).toBe(0);
		expect(pointerTiltAngleDeg({ pointerType: "pen", tiltX: 45, tiltY: 0 })).toBeCloseTo(45, 3);
		expect(pointerTiltAngleDeg({ pointerType: "pen", altitudeAngle: Math.PI / 6 })).toBeCloseTo(60, 3);
		expect(pointerTilt({ pointerType: "pen", tiltX: 45, tiltY: 0 })).toBeCloseTo(0.5, 3);
	});

	it("keeps normal upright writing at 1x width and widens tilted strokes", () => {
		expect(tiltWidthMultiplier(20 / 90, "ball", "pen")).toBe(1);
		expect(tiltWidthMultiplier(35 / 90, "ball", "pen")).toBe(1);
		expect(tiltWidthMultiplier(70 / 90, "ball", "pen")).toBeGreaterThan(2.5);
		expect(tiltWidthMultiplier(70 / 90, "pencil", "pen")).toBeGreaterThan(3.5);
		expect(tiltWidthMultiplier(70 / 90, "dashed", "pen")).toBe(1);
		expect(tiltWidthMultiplier(70 / 90, undefined, "highlighter")).toBeGreaterThan(1.5);
	});

	it("resamples tilt onto finalized stroke points and omits upright strokes", () => {
		const pts: [number, number, number][] = [[0, 0, 0.5], [50, 0, 0.5], [100, 0, 0.5]];
		expect(resampleTilts([{ x: 0, y: 0, tilt: 0.2 }, { x: 100, y: 0, tilt: 0.2 }], pts, "ball", "pen")).toBeUndefined();
		const tilts = resampleTilts(
			[{ x: 0, y: 0, tilt: 0.2 }, { x: 100, y: 0, tilt: 0.8 }],
			pts,
			"ball",
			"pen",
		);
		expect(tilts).toEqual([0.2, 0.5, 0.8]);
	});
});
