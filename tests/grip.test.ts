import { describe, expect, it } from "vitest";
import { GRIP_DRAG_MOVE, GRIP_LONG_PRESS_MS, GripPress } from "../src/grip";
import { SNAP_PRESETS, currentSnapPreset, nearestEdge, orientationOf, placeFloating, snapPreset } from "../src/floating";

describe("GripPress (Stage M: tap vs drag vs long-press)", () => {
	it("a quick press without movement is a tap", () => {
		const p = new GripPress("pen", 100, 100, 0);
		expect(p.move(101, 102)).toBe(false);
		expect(p.hold(200)).toBe(false);
		expect(p.up(102, 101, 250)).toBe("tap");
	});

	it("moving past the threshold starts a drag (once); the release is a drag", () => {
		const p = new GripPress("touch", 100, 100, 0);
		expect(p.move(100 + GRIP_DRAG_MOVE, 100)).toBe(true);
		expect(p.move(150, 100)).toBe(false);
		expect(p.hold(GRIP_LONG_PRESS_MS + 100)).toBe(false);
		expect(p.up(150, 100, 2000)).toBe("drag");
	});

	it("a held still press long-presses once; later movement and release are inert", () => {
		const p = new GripPress("pen", 100, 100, 0);
		expect(p.hold(GRIP_LONG_PRESS_MS - 1)).toBe(false);
		expect(p.hold(GRIP_LONG_PRESS_MS)).toBe(true);
		expect(p.hold(GRIP_LONG_PRESS_MS + 50)).toBe(false);
		expect(p.move(300, 300)).toBe(false);
		expect(p.phase).toBe("longpress");
		expect(p.up(300, 300, 900)).toBe("longpress");
	});

	it("a drag before the timer prevents the long-press", () => {
		const p = new GripPress("touch", 0, 0, 0);
		p.move(20, 0);
		expect(p.hold(1000)).toBe(false);
		expect(p.phase).toBe("drag");
	});

	it("a release far away without pointermoves still counts as a drag", () => {
		expect(new GripPress("pen", 0, 0, 0).up(40, 0, 100)).toBe("drag");
	});

	it("a late timer: a still release after the delay is a long-press, not a tap", () => {
		expect(new GripPress("touch", 0, 0, 0).up(1, 1, GRIP_LONG_PRESS_MS + 10)).toBe("longpress");
	});

	it("the mouse never long-presses (it uses right-click)", () => {
		const p = new GripPress("mouse", 0, 0, 0);
		expect(p.canLongPress).toBe(false);
		expect(p.hold(5000)).toBe(false);
		expect(p.up(0, 0, 5000)).toBe("tap");
	});
});

describe("snap presets (Stage M)", () => {
	const area = { w: 1180, h: 760 };

	it("has the 8 presets", () => {
		expect(SNAP_PRESETS.map((p) => p.key)).toEqual([
			"top",
			"bottom",
			"left",
			"right",
			"top-left",
			"top-right",
			"bottom-left",
			"bottom-right",
		]);
	});

	it("top/bottom are horizontal, left/right vertical, corners horizontal", () => {
		expect(orientationOf(snapPreset("top").edge)).toBe("horizontal");
		expect(orientationOf(snapPreset("bottom").edge)).toBe("horizontal");
		expect(orientationOf(snapPreset("left").edge)).toBe("vertical");
		expect(orientationOf(snapPreset("right").edge)).toBe("vertical");
		for (const k of ["top-left", "top-right", "bottom-left", "bottom-right"] as const) {
			expect(orientationOf(snapPreset(k).edge)).toBe("horizontal");
		}
	});

	it("corner edges agree with nearestEdge at the corner point", () => {
		const pts = { "top-left": [0, 0], "top-right": [area.w, 0], "bottom-left": [0, area.h], "bottom-right": [area.w, area.h] } as const;
		for (const [k, [x, y]] of Object.entries(pts)) {
			expect(nearestEdge(area, x, y, null)).toBe(snapPreset(k as keyof typeof pts).edge);
		}
	});

	it("places the bar where the name says", () => {
		const h = { w: 500, h: 50 };
		const v = { w: 50, h: 400 };
		const top = placeFloating(area, h, snapPreset("top").pos);
		expect(top.left + h.w / 2).toBeCloseTo(area.w / 2);
		expect(top.top).toBe(12);
		const bottom = placeFloating(area, h, snapPreset("bottom").pos);
		expect(bottom.left + h.w / 2).toBeCloseTo(area.w / 2);
		expect(bottom.top + h.h).toBeGreaterThan(area.h - 40);
		const left = placeFloating(area, v, snapPreset("left").pos);
		expect(left.left).toBe(12);
		expect(left.top + v.h / 2).toBeCloseTo(area.h / 2);
		const right = placeFloating(area, v, snapPreset("right").pos);
		expect(right.left + v.w).toBe(area.w - 12);
		const br = placeFloating(area, h, snapPreset("bottom-right").pos);
		expect(br).toEqual({ left: area.w - h.w - 12, top: area.h - h.h - 12 });
		expect(placeFloating(area, h, snapPreset("top-left").pos)).toEqual({ left: 12, top: 12 });
	});

	it("currentSnapPreset recognises each preset and nothing else", () => {
		for (const { key } of SNAP_PRESETS) {
			const { pos, edge } = snapPreset(key);
			expect(currentSnapPreset(pos, edge)).toBe(key);
		}
		expect(currentSnapPreset({ x: 0.3, y: 0.7 }, "bottom")).toBeNull();
		expect(currentSnapPreset({ x: 0.5, y: 0 }, "left")).toBeNull();
		expect(currentSnapPreset(null, "top")).toBeNull();
	});
});
