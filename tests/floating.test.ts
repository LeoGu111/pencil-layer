import { describe, expect, it } from "vitest";
import { EDGE_HYSTERESIS, FLOAT_BOTTOM, FLOAT_MARGIN, nearestEdge, orientationOf, placeFloating, placePopover, popoverSide, toFloatPos } from "../src/floating";

const area = { w: 800, h: 600 };
const bar = { w: 400, h: 46 };

describe("placeFloating", () => {
	it("defaults to bottom-center", () => {
		const p = placeFloating(area, bar, null);
		expect(p.left).toBe(200);
		expect(p.top).toBe(600 - 46 - FLOAT_BOTTOM);
	});

	it("maps stored fractions into the free range, clamped inside the area", () => {
		expect(placeFloating(area, bar, { x: 0, y: 0 })).toEqual({ left: FLOAT_MARGIN, top: FLOAT_MARGIN });
		expect(placeFloating(area, bar, { x: 1, y: 1 })).toEqual({ left: 800 - 400 - FLOAT_MARGIN, top: 600 - 46 - FLOAT_MARGIN });
		expect(placeFloating(area, bar, { x: 5, y: -3 })).toEqual({ left: 800 - 400 - FLOAT_MARGIN, top: FLOAT_MARGIN });
	});

	it("a bar wider than the area sticks to the margin instead of going negative", () => {
		const p = placeFloating({ w: 300, h: 600 }, bar, { x: 0.7, y: 0.5 });
		expect(p.left).toBe(FLOAT_MARGIN);
		expect(placeFloating({ w: 300, h: 30 }, bar, null).top).toBe(FLOAT_MARGIN);
	});

	it("survives resizes and collapse: a centered bar stays centered", () => {
		const pos = toFloatPos(area, bar, 200, 300);
		expect(pos.x).toBeCloseTo(0.5);
		const collapsed = { w: 52, h: 52 };
		const p = placeFloating({ w: 1000, h: 700 }, collapsed, pos);
		expect(p.left + collapsed.w / 2).toBeCloseTo(500);
	});
});

describe("toFloatPos", () => {
	it("round-trips with placeFloating and clamps drags outside the area", () => {
		const pos = toFloatPos(area, bar, 100, 250);
		const p = placeFloating(area, bar, pos);
		expect(p.left).toBeCloseTo(100);
		expect(p.top).toBeCloseTo(250);
		expect(toFloatPos(area, bar, -500, 5000)).toEqual({ x: 0, y: 1 });
	});

	it("no free range ⇒ centered horizontally, bottom vertically", () => {
		expect(toFloatPos({ w: 100, h: 40 }, bar, 0, 0)).toEqual({ x: 0.5, y: 1 });
	});
});

describe("orientation (Apple Markup style)", () => {
	it("horizontal at top/bottom, vertical at left/right", () => {
		expect(orientationOf("bottom")).toBe("horizontal");
		expect(orientationOf("top")).toBe("horizontal");
		expect(orientationOf("left")).toBe("vertical");
		expect(orientationOf("right")).toBe("vertical");
	});

	it("nearestEdge picks the closest edge of the area", () => {
		const a = { w: 1000, h: 700 };
		expect(nearestEdge(a, 500, 680, null)).toBe("bottom");
		expect(nearestEdge(a, 500, 20, null)).toBe("top");
		expect(nearestEdge(a, 15, 350, null)).toBe("left");
		expect(nearestEdge(a, 990, 350, null)).toBe("right");
		// Center of a landscape area: closer to top/bottom than to the sides.
		expect(nearestEdge(a, 500, 330, null)).toBe("top");
	});

	it("keeps the current edge within the hysteresis band (no flicker near a corner)", () => {
		const a = { w: 1000, h: 700 };
		// Near the bottom-left corner: left is 10 px closer than bottom.
		expect(nearestEdge(a, 40, 650, "bottom")).toBe("bottom");
		expect(nearestEdge(a, 40, 650, null)).toBe("left");
		// Far enough into the left side: switches.
		expect(nearestEdge(a, 20, 600, "bottom", EDGE_HYSTERESIS)).toBe("left");
	});
});

describe("popover placement", () => {
	const area = { w: 1000, h: 700 };
	const pop = { w: 240, h: 300 };

	it("opens toward the side with more room", () => {
		expect(popoverSide("horizontal", { left: 300, top: 630, w: 400, h: 50 }, area)).toBe("above");
		expect(popoverSide("horizontal", { left: 300, top: 20, w: 400, h: 50 }, area)).toBe("below");
		expect(popoverSide("vertical", { left: 12, top: 100, w: 50, h: 500 }, area)).toBe("right");
		expect(popoverSide("vertical", { left: 938, top: 100, w: 50, h: 500 }, area)).toBe("left");
	});

	it("is centered on its button along the bar and clamped inside the area", () => {
		const bar = { left: 300, top: 630, w: 400, h: 50 };
		const btn = { left: 500, top: 634, w: 42, h: 42 };
		expect(placePopover("above", bar, btn, pop, area)).toEqual({ left: 521 - 120, top: 630 - 8 - 300 });
		// Button at the far right: clamped to the area's right margin.
		expect(placePopover("above", bar, { ...btn, left: 960 }, pop, area).left).toBe(1000 - 8 - 240);
		const vbar = { left: 12, top: 100, w: 50, h: 500 };
		const vbtn = { left: 16, top: 120, w: 42, h: 42 };
		expect(placePopover("right", vbar, vbtn, pop, area)).toEqual({ left: 12 + 50 + 8, top: 8 });
		expect(placePopover("left", { ...vbar, left: 938 }, { ...vbtn, top: 500 }, pop, area)).toEqual({ left: 938 - 8 - 240, top: 521 - 150 });
		// Too tall for the area: pinned to the top margin.
		expect(placePopover("below", { ...bar, top: 20 }, btn, { w: 240, h: 900 }, area).top).toBe(8);
	});
});
