import { describe, expect, it } from "vitest";
import { MenuState, menuForSelection, placeMenu } from "../src/menu";

const vis = { minX: 0, minY: 1000, maxX: 800, maxY: 1600 };
const menu = { width: 300, height: 50 };

describe("placeMenu", () => {
	it("prefers above, centered on the target", () => {
		const p = placeMenu({ minX: 300, minY: 1200, maxX: 500, maxY: 1300 }, menu, vis);
		expect(p).toEqual({ left: 250, top: 1140, side: "above" });
	});

	it("goes below when there is no room above", () => {
		const p = placeMenu({ minX: 300, minY: 1020, maxX: 500, maxY: 1300 }, menu, vis);
		expect(p.side).toBe("below");
		expect(p.top).toBe(1310);
	});

	it("pins inside the visible area when neither side fits", () => {
		const p = placeMenu({ minX: 300, minY: 900, maxX: 500, maxY: 1700 }, menu, vis);
		expect(p.side).toBe("over");
		expect(p.top).toBe(1008);
	});

	it("clamps horizontally into the visible area", () => {
		expect(placeMenu({ minX: 0, minY: 1300, maxX: 20, maxY: 1310 }, menu, vis).left).toBe(8);
		expect(placeMenu({ minX: 780, minY: 1300, maxX: 800, maxY: 1310 }, menu, vis).left).toBe(492);
	});

	it("menu wider than the visible area sticks to the left margin", () => {
		expect(placeMenu({ minX: 100, minY: 1300, maxX: 120, maxY: 1310 }, { width: 900, height: 50 }, vis).left).toBe(8);
	});

	it("point target (paste) works", () => {
		const p = placeMenu({ minX: 400, minY: 1300, maxX: 400, maxY: 1300 }, { width: 100, height: 40 }, vis);
		expect(p).toEqual({ left: 350, top: 1250, side: "above" });
	});
});

describe("menuForSelection (selection menu is always shown)", () => {
	it("opens the selection menu whenever a selection exists (e.g. after a drag or a tap)", () => {
		expect(menuForSelection(null, true)).toEqual({ kind: "selection", colors: false });
		const paste: MenuState = { kind: "paste", at: [1, 2] };
		expect(menuForSelection(paste, true)).toEqual({ kind: "selection", colors: false });
	});

	it("keeps the current selection menu (a tap no longer toggles it off; color submenu stays open)", () => {
		const m: MenuState = { kind: "selection", colors: true };
		expect(menuForSelection(m, true)).toBe(m);
	});

	it("goes away when the selection is cleared; a Paste menu is unaffected", () => {
		expect(menuForSelection({ kind: "selection", colors: false }, false)).toBeNull();
		const paste: MenuState = { kind: "paste", at: [1, 2] };
		expect(menuForSelection(paste, false)).toBe(paste);
		expect(menuForSelection(null, false)).toBeNull();
	});
});
