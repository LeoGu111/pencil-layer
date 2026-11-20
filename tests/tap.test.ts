import { describe, expect, it } from "vitest";
import { CLICK_DEDUP_MS, TapGate, UI_TAP_MOVE } from "../src/tap";

describe("TapGate (Pencil taps on toolbar buttons)", () => {
	it("a pen tap activates on pointerup", () => {
		const g = new TapGate();
		g.down("pen", 7, 100, 100);
		g.move(7, 101, 100);
		expect(g.up(7, 101, 101, 1000)).toBe(true);
	});

	it("…and the click that may follow is swallowed (fires once)", () => {
		const g = new TapGate();
		g.down("pen", 7, 0, 0);
		expect(g.up(7, 0, 0, 1000)).toBe(true);
		expect(g.click(1000 + 50)).toBe(false);
		// A later, separate click (e.g. keyboard) works again.
		expect(g.click(1000 + CLICK_DEDUP_MS + 1)).toBe(true);
	});

	it("a pen press that slides away is not a tap", () => {
		const g = new TapGate();
		g.down("pen", 1, 0, 0);
		g.move(1, UI_TAP_MOVE + 5, 0);
		expect(g.up(1, 2, 0, 10)).toBe(false);
		g.down("pen", 2, 0, 0);
		expect(g.up(2, 0, UI_TAP_MOVE + 1, 10)).toBe(false);
	});

	it("touch and mouse keep using click", () => {
		const g = new TapGate();
		g.down("touch", 3, 0, 0);
		expect(g.up(3, 0, 0, 10)).toBe(false);
		expect(g.click(20)).toBe(true);
		g.down("mouse", 1, 0, 0);
		expect(g.up(1, 0, 0, 30)).toBe(false);
		expect(g.click(40)).toBe(true);
	});

	it("cancel / other pointers don't activate", () => {
		const g = new TapGate();
		g.down("pen", 5, 0, 0);
		g.cancel(5);
		expect(g.up(5, 0, 0, 10)).toBe(false);
		g.down("pen", 6, 0, 0);
		expect(g.up(9, 0, 0, 10)).toBe(false);
	});
});
