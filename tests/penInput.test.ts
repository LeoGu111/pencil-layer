import { describe, expect, it } from "vitest";
import { isPenEraser, toolForPress } from "../src/penInput";

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
