import { describe, expect, it } from "vitest";
import { SPACE_CLIP_TEXT, blankRunAbove, blankRunBelow, blockEnds, enterOpensBelow, isSpaceClipText, openBelowInsert } from "../src/spaces";

describe("openBelowInsert", () => {
	it("adds a blank separator after text so new text starts its own block", () => {
		expect(openBelowInsert("some text")).toBe("\n\n");
		expect(openBelowInsert("   ")).toBe("\n");
		expect(openBelowInsert("")).toBe("\n");
	});
	it("keeps the space after the original line once text is typed below", () => {
		const lines = ["para", "", "typed below"]; // "para" + "\n\n" + typed text
		expect(blockEnds(lines)[0]).toBe(0);
	});
});

describe("enterOpensBelow", () => {
	it("only for plain paragraph lines", () => {
		expect(enterOpensBelow("A paragraph")).toBe(true);
		expect(enterOpensBelow("- item")).toBe(false);
		expect(enterOpensBelow("> [!def] x")).toBe(false);
		expect(enterOpensBelow("## Heading")).toBe(false);
		expect(enterOpensBelow("| a | b |")).toBe(false);
		expect(enterOpensBelow("$$")).toBe(false);
		expect(enterOpensBelow("")).toBe(false);
	});
});

describe("space clip text", () => {
	it("recognizes only the exact label (whitespace-trimmed)", () => {
		expect(isSpaceClipText(SPACE_CLIP_TEXT)).toBe(true);
		expect(isSpaceClipText(` ${SPACE_CLIP_TEXT}\n`)).toBe(true);
		expect(isSpaceClipText("hello")).toBe(false);
		expect(isSpaceClipText(null)).toBe(false);
	});
});

import { sameClipText, spaceInRange } from "../src/spaces";

describe("spaceInRange", () => {
	// line "abc" at 10..13, space shown at 13
	it("selection crossing the space includes it", () => {
		expect(spaceInRange(13, 10, 11, 20)).toBe(true);
		expect(spaceInRange(13, 10, 13, 14)).toBe(true);
	});
	it("selecting the whole line before it includes it", () => {
		expect(spaceInRange(13, 10, 10, 13)).toBe(true);
	});
	it("partial line or empty selection does not", () => {
		expect(spaceInRange(13, 10, 11, 13)).toBe(false);
		expect(spaceInRange(13, 10, 13, 13)).toBe(false);
		expect(spaceInRange(13, 10, 14, 30)).toBe(false);
		expect(spaceInRange(13, 10, 0, 12)).toBe(false);
	});
});

describe("sameClipText", () => {
	it("ignores CRLF and trailing whitespace", () => {
		expect(sameClipText("a\r\nb\n", "a\nb")).toBe(true);
		expect(sameClipText("a", "b")).toBe(false);
		expect(sameClipText(null, "a")).toBe(false);
	});
});

describe("blank runs next to a space", () => {
	const mk = (lines: string[]) => {
		const blank = (l: number) => lines[l].trim() === "";
		const ends = blockEnds(lines);
		return { blank, ends };
	};
	it("finds the blank lines above a space shown after a blank line", () => {
		const lines = ["text", "", "", ""];
		const { blank, ends } = mk(lines);
		expect(blankRunAbove(blank, ends, 3)).toEqual({ after: 0, first: 1 });
	});
	it("none when the space follows text, or the note starts blank", () => {
		const { blank, ends } = mk(["text", "", "more"]);
		expect(blankRunAbove(blank, ends, 0)).toBeNull();
		const b = mk(["", "", "x"]);
		expect(blankRunAbove(b.blank, b.ends, 1)).toBeNull();
	});
	it("finds the blank lines below, and whether they reach the end", () => {
		const lines = ["a", "", "", "b", "", ""];
		const blank = (l: number) => lines[l].trim() === "";
		expect(blankRunBelow(blank, lines.length, 0)).toEqual({ first: 1, last: 2, toEnd: false });
		expect(blankRunBelow(blank, lines.length, 3)).toEqual({ first: 4, last: 5, toEnd: true });
		expect(blankRunBelow(blank, lines.length, 2)).toBeNull();
		expect(blankRunBelow(blank, lines.length, 5)).toBeNull();
	});
});
