import { describe, expect, it } from "vitest";
import {
	alignBlocks,
	countOccurrences,
	elementKind,
	findNth,
	lineTop,
	listItemLines,
	normalizeWithMap,
	normalizeWs,
	ownedRange,
	printAreaWidth,
	rangePieces,
	reserveSpace,
	sectionKind,
	stripInline,
	tableRowLines,
} from "../src/readingMap";
import { hashLine, parseInkFile, resolveAnchor } from "../src/model";
import { readFileSync } from "node:fs";

const DOC = [
	"# Title", // 0
	"", // 1
	"Para line A", // 2
	"Para line B", // 3
	"", // 4
	"", // 5
	"", // 6
	"- item 1", // 7
	"  continued", // 8
	"- item 2", // 9
	"    - nested", // 10
	"", // 11
	"| a | b |", // 12
	"|---|:-:|", // 13
	"| 1 | 2 |", // 14
	"", // 15
];

describe("ownedRange (strokes → sections)", () => {
	it("owns its lines plus the blank lines below", () => {
		expect(ownedRange(DOC, 2, 3)).toEqual({ from: 2, to: 6 });
		expect(ownedRange(DOC, 7, 10)).toEqual({ from: 7, to: 11 });
		expect(ownedRange(DOC, 12, 14)).toEqual({ from: 12, to: 15 });
	});
	it("the first section owns everything above it", () => {
		const doc = ["", "", "First", "", "Second"];
		expect(ownedRange(doc, 2, 2)).toEqual({ from: 0, to: 3 });
		expect(ownedRange(doc, 4, 4)).toEqual({ from: 4, to: 4 });
		expect(ownedRange(DOC, 0, 0)).toEqual({ from: 0, to: 1 });
	});
	it("uses the next section's start when known (PDF export)", () => {
		expect(ownedRange(DOC, 2, 3, { nextStart: 12 })).toEqual({ from: 2, to: 11 });
		expect(ownedRange(DOC, 7, 10, { nextStart: 16, isFirst: true })).toEqual({ from: 0, to: 15 });
	});
	it("partitions a document: every line has exactly one owner", () => {
		const sections = [
			[0, 0],
			[2, 3],
			[7, 10],
			[12, 14],
		];
		const owners = DOC.map((_, line) => sections.filter(([a, b]) => {
			const r = ownedRange(DOC, a, b);
			return line >= r.from && line <= r.to;
		}).length);
		expect(owners.every((n) => n === 1)).toBe(true);
	});
	it("a stroke resolved via its anchor lands in the right section", () => {
		const anchor = { line: 3, hash: hashLine("Para line B") };
		// Two lines inserted above: the anchor resolves by hash.
		const edited = ["x", "y", ...DOC];
		const line = resolveAnchor(edited, anchor);
		expect(line).toBe(5);
		const r = ownedRange(edited, 4, 5);
		expect(line >= r.from && line <= r.to).toBe(true);
	});
});

describe("lineTop (y-mapping)", () => {
	it("places the first line at the section top and interpolates proportionally without marks", () => {
		expect(lineTop(10, [], 10, 13, 100, 24)).toBe(0);
		expect(lineTop(11, [], 10, 13, 100, 24)).toBe(25);
		expect(lineTop(13, [], 10, 13, 100, 24)).toBe(75);
	});
	it("uses measured marks and interpolates between them", () => {
		const marks = [
			{ line: 12, y: 80 },
			{ line: 13, y: 90 },
		];
		expect(lineTop(12, marks, 10, 13, 120, 24)).toBe(80);
		expect(lineTop(11, marks, 10, 13, 120, 24)).toBe(40);
		expect(lineTop(13, marks, 10, 13, 120, 24)).toBe(90);
	});
	it("continues one line height per blank line below the section and above it", () => {
		expect(lineTop(14, [], 10, 13, 100, 24)).toBe(100);
		expect(lineTop(16, [], 10, 13, 100, 24)).toBe(148);
		expect(lineTop(8, [], 10, 13, 100, 24)).toBe(-48);
	});
	it("ignores marks outside the section and keeps the mapping monotonic", () => {
		const marks = [
			{ line: 2, y: 500 },
			{ line: 11, y: 60 },
			{ line: 12, y: 30 }, // mis-measured (above the previous mark)
		];
		expect(lineTop(12, marks, 10, 13, 100, 24)).toBe(60);
		expect(lineTop(13, marks, 10, 13, 100, 24)).toBe(80);
		// Marks are clamped into the section.
		expect(lineTop(11, [{ line: 11, y: 999 }], 10, 13, 100, 24)).toBe(100);
	});
	it("single-line section", () => {
		expect(lineTop(5, [], 5, 5, 40, 24)).toBe(0);
		expect(lineTop(6, [], 5, 5, 40, 24)).toBe(40);
	});
});

describe("reserveSpace", () => {
	it("reserves room (a bottom margin) for ink in trailing blank lines, up to their editor height", () => {
		// 3 blank lines of 24 px below a 50 px block; ink reaches 110 → 60 px + 4 px clearance.
		expect(reserveSpace(110, 50, 3, 24)).toBe(64);
		// Ink far below the blank lines (it covered the next text in the editor too) is capped.
		expect(reserveSpace(1000, 50, 3, 24)).toBe(72 + 4);
		// A slight overflow gives a small margin, which collapses into the normal paragraph gap.
		expect(reserveSpace(58, 50, 3, 24)).toBe(12);
	});
	it("reserves nothing for ink inside the block or without blank lines", () => {
		expect(reserveSpace(40, 50, 3, 24)).toBe(0);
		expect(reserveSpace(200, 50, 0, 24)).toBe(0);
		expect(reserveSpace(-Infinity, 50, 3, 24)).toBe(0);
	});
	it("[Stage I] the note's last section reserves room for ALL ink below the end of the note", () => {
		expect(reserveSpace(1000, 50, 3, 24, { atEnd: true })).toBe(950 + 4);
		expect(reserveSpace(200, 50, 0, 24, { atEnd: true })).toBe(154);
		expect(reserveSpace(40, 50, 0, 24, { atEnd: true })).toBe(0);
		expect(reserveSpace(-Infinity, 50, 2, 24, { atEnd: true })).toBe(0);
	});
	it("[Stage I] regression: a drawing below the end of the note gets its full height", () => {
		// Synthetic stand-in for a real export bug: a drawing (45 strokes on the last two blank lines,
		// ~285 px below the last text line) was cut off after 2 blank lines' worth of room.
		const dir = `${__dirname}/fixtures/end-drawing`;
		const lines = readFileSync(`${dir}/Sample Note.md`, "utf8").split(/\r?\n/);
		const ink = parseInkFile(readFileSync(`${dir}/Sample Note.md.json`, "utf8"));
		// The last section is the `$R = …$` paragraph (line 25); it owns the blank lines after it.
		const range = ownedRange(lines, 25, 25, { nextStart: lines.length });
		expect(range).toEqual({ from: 25, to: lines.length - 1 });
		const lh = 24;
		const height = 24;
		let inkBottom = -Infinity;
		for (const s of ink.strokes) {
			const line = resolveAnchor(lines, s.anchor);
			if (line < range.from) continue;
			const y = lineTop(line, [], 25, 25, height, lh);
			inkBottom = Math.max(inkBottom, y + Math.max(...s.points.map((p) => p[1])) + s.size / 2);
		}
		expect(inkBottom).toBeGreaterThan(250);
		const trailing = range.to - 25;
		// Before: capped at the blank lines (the drawing was cut off).
		expect(reserveSpace(inkBottom, height, trailing, lh)).toBe(trailing * lh + 4);
		// Now: the whole drawing gets room.
		const gap = reserveSpace(inkBottom, height, trailing, lh, { atEnd: range.to >= lines.length - 1 });
		expect(height + gap).toBeGreaterThanOrEqual(inkBottom);
	});
});

describe("printAreaWidth (PDF export layout width)", () => {
	it("Letter portrait, default 1 cm margins, 100%", () => {
		expect(printAreaWidth({ pageSize: "Letter", landscape: false, margin: "0", downscalePercent: 100 })).toBeCloseTo(816 - 2 * 37.795, 2);
		expect(printAreaWidth(null)).toBeCloseTo(740.41, 1);
	});
	it("page size, orientation, margins and downscale", () => {
		expect(printAreaWidth({ pageSize: "A4", margin: "1" })).toBeCloseTo(8.27 * 96, 2);
		expect(printAreaWidth({ pageSize: "A4", landscape: true, margin: "2" })).toBeCloseTo(11.69 * 96, 2);
		expect(printAreaWidth({ pageSize: "Letter", margin: "1", downscalePercent: 50 })).toBeCloseTo(1632, 2);
		expect(printAreaWidth({ pageSize: "Nope", margin: "1" })).toBeCloseTo(816, 2);
	});
});

describe("source structure", () => {
	it("finds list item lines (incl. nested, numbered, tasks)", () => {
		expect(listItemLines(DOC, 7, 10)).toEqual([7, 9, 10]);
		expect(listItemLines(["1. a", "2) b", "- [ ] c", "text", "* d", "+ e"], 0, 5)).toEqual([0, 1, 2, 4, 5]);
	});
	it("finds table rows (skipping the separator)", () => {
		expect(tableRowLines(DOC, 12, 14)).toEqual([12, 14]);
		expect(tableRowLines(["a | b", "--- | ---", "1 | 2", "3 | 4"], 0, 3)).toEqual([0, 2, 3]);
	});
});

describe("alignBlocks (PDF export)", () => {
	it("matches blocks 1:1 by kind", () => {
		const s = ["heading", "paragraph", "list", "table"].map(sectionKind);
		const e = [elementKind("H1", []), elementKind("P", []), elementKind("UL", []), elementKind("TABLE", [])];
		expect(alignBlocks(s, e)).toEqual([0, 1, 2, 3]);
	});
	it("skips sections without output and blocks without a section", () => {
		const s = ["yaml", "paragraph", "comment", "code", "thematicBreak", "paragraph"].map(sectionKind);
		const e = ["title", elementKind("PRE", ["frontmatter"]), elementKind("P", []), elementKind("PRE", []), elementKind("HR", []), elementKind("P", [])] as const;
		expect(alignBlocks(s, [...e])).toEqual([-1, 0, 1, 3, 4, 5]);
	});
	it("tolerates kind mismatches (callout vs blockquote, math in a paragraph)", () => {
		const s = ["callout", "math", "paragraph"].map(sectionKind);
		const e = [elementKind("BLOCKQUOTE", []), elementKind("P", []), elementKind("P", [])];
		expect(alignBlocks(s, e)).toEqual([0, 1, 2]);
	});
	it("element kinds", () => {
		expect(elementKind("DIV", ["callout"])).toBe("callout");
		expect(elementKind("H3", [])).toBe("heading");
		expect(elementKind("OL", [])).toBe("list");
		expect(elementKind("SECTION", ["footnotes"])).toBe("footnotes");
		expect(elementKind("DIV", ["math", "math-block"])).toBe("math");
		expect(sectionKind("footnoteDefinition")).toBe("footnotes");
		expect(sectionKind("thematicBreak")).toBe("hr");
	});
});

describe("text highlight lookup", () => {
	it("strips inline markdown to display text", () => {
		expect(stripInline("some **bold** and *it* ==hl== ~~x~~ `code`")).toBe("some bold and it hl x code");
		expect(stripInline("see [[Note|alias]] and [[Other]] and [t](http://x)")).toBe("see alias and Other and t");
		expect(stripInline("- [ ] task text", true)).toBe("task text");
		expect(stripInline("## Heading", true)).toBe("Heading");
		expect(stripInline("> quoted", true)).toBe("quoted");
		expect(stripInline("snake_case _em_")).toBe("snake_case em");
		expect(stripInline("a ![[img.png]] b")).toBe("a  b");
	});
	it("normalizes whitespace with an index map", () => {
		const { text, map } = normalizeWithMap("  a \n b");
		expect(text).toBe("a b");
		expect(map).toEqual([2, 3, 6]);
		expect(normalizeWs(" x  y ")).toBe("x y");
	});
	it("finds the k-th occurrence", () => {
		expect(countOccurrences("the cat the dog the", "the")).toBe(3);
		expect(findNth("the cat the dog", "the", 1)).toBe(8);
		expect(findNth("the cat the dog", "the", 5)).toBe(8);
		expect(findNth("abc", "x", 0)).toBe(-1);
	});
	it("splits a range into per-line pieces", () => {
		const lines = ["hello world", "second", "third line"];
		expect(rangePieces(lines, 0, 6, 2, 5)).toEqual([
			{ line: 0, from: 6, to: 11 },
			{ line: 1, from: 0, to: 6 },
			{ line: 2, from: 0, to: 5 },
		]);
		expect(rangePieces(lines, 0, 3, 0, 3)).toEqual([]);
		expect(rangePieces(lines, 1, 0, 1, 99)).toEqual([{ line: 1, from: 0, to: 6 }]);
	});
});
