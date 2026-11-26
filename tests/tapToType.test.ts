import { describe, expect, it } from "vitest";
import { insertionPosForY, planTapToType } from "../src/tapToType";

describe("tapToType", () => {
	const lastLine = { top: 0, bottom: 24, lineTo: 0, lineEndX: 0 };

	it("extends an empty note with newlines when tapping below line 1 instead of jumping to top", () => {
		const plan = planTapToType({
			docLength: 0,
			lineHeight: 24,
			charWidth: 8,
			tapX: 12,
			tapY: 264,
			lastLine,
		});
		expect(plan).toEqual({
			from: 0,
			insert: "\n".repeat(10),
			anchor: 10,
		});
	});

	it("pads horizontally with NBSP when tapping well past the left edge below existing text", () => {
		const plan = planTapToType({
			docLength: 10,
			lineHeight: 24,
			charWidth: 8,
			tapX: 160,
			tapY: 120,
			lastLine: { top: 24, bottom: 48, lineTo: 10, lineEndX: 40 },
		});
		expect(plan).not.toBeNull();
		expect(plan!.insert.startsWith("\n".repeat(3))).toBe(true);
		expect(plan!.insert.slice(3)).toBe("\u00A0".repeat(20));
		expect(plan!.anchor).toBe(10 + 23);
	});

	it("pads an existing short line horizontally when tapping to its right", () => {
		const plan = planTapToType({
			docLength: 20,
			lineHeight: 24,
			charWidth: 10,
			tapX: 180,
			tapY: 12,
			lastLine: { top: 24, bottom: 48, lineTo: 20, lineEndX: 0 },
			lineAtTap: { top: 0, bottom: 24, lineTo: 6, lineEndX: 60 },
		});
		expect(plan).toEqual({
			from: 6,
			insert: "\u00A0".repeat(12),
			anchor: 18,
		});
	});

	it("returns null when tapping directly inside existing text", () => {
		const plan = planTapToType({
			docLength: 20,
			lineHeight: 24,
			charWidth: 8,
			tapX: 40,
			tapY: 12,
			lastLine: { top: 24, bottom: 48, lineTo: 20, lineEndX: 0 },
			lineAtTap: { top: 0, bottom: 24, lineTo: 12, lineEndX: 90 },
		});
		expect(plan).toBeNull();
	});

	it("computes formula LaTeX insertion newlines when written below text", () => {
		expect(insertionPosForY(168, { top: 0, bottom: 24, lineTo: 5, lineEndX: 40 }, 24, 5, 5)).toEqual({
			prefixNewlines: 6,
			from: 5,
		});
		expect(insertionPosForY(12, { top: 24, bottom: 48, lineTo: 15, lineEndX: 0 }, 24, 7, 15)).toEqual({
			prefixNewlines: 0,
			from: 7,
		});
	});
});
