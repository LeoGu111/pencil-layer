import { describe, expect, it } from "vitest";
import { resolvePencilAction, resolvePencilGesture, sanitizePencilGestureAction } from "../src/pencilGestures";

describe("pencilGestures (Apple Pencil double-tap & squeeze)", () => {
	it("follows iPadOS system preferences when set to system", () => {
		expect(resolvePencilGesture({ kind: "doubleTap", preferredAction: "switchEraser", platform: "ios" }, "system", "palette", "pen", null)).toEqual({ tool: "eraser" });
		expect(resolvePencilGesture({ kind: "squeeze", preferredAction: "showContextualPalette", platform: "ios" }, "eraser", "system", "pen", null)).toEqual({ palette: true });
		expect(resolvePencilGesture({ kind: "squeeze", preferredAction: "switchPrevious", platform: "ios" }, "eraser", "system", "eraser", "highlighter")).toEqual({ tool: "highlighter" });
	});

	it("respects disabled/shortcut system settings", () => {
		expect(resolvePencilAction("eraser", "ignore", "pen", null)).toEqual({});
		expect(resolvePencilAction("palette", "runSystemShortcut", "pen", null)).toEqual({});
	});

	it("applies explicit plugin actions and ignores non-iOS platform events", () => {
		expect(resolvePencilGesture({ kind: "squeeze", platform: "ios" }, "eraser", "undo", "pen", null)).toEqual({ undo: true });
		expect(resolvePencilGesture({ kind: "doubleTap", platform: "ios" }, "eraser", "palette", "eraser", "highlighter")).toEqual({ tool: "highlighter" });
		expect(resolvePencilGesture({ kind: "squeeze", platform: "desktop" }, "eraser", "palette", "pen", null)).toEqual({});
		expect(sanitizePencilGestureAction("unknown", "palette")).toBe("palette");
	});
});
