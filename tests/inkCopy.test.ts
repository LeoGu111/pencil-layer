/** Public API: inkLines / copyInk remapping (src/inkCopy.ts). */
import { describe, expect, it } from "vitest";
import { InkFile, InkSpace, Stroke, hashLine, parseInkFile, serializeInkFile } from "../src/model";
import { copyInkData, inkLinesOf, refindChar, refindText, splitLines } from "../src/inkCopy";

const anchor = (lines: string[], line: number) => ({ line, hash: hashLine(lines[line]) });

function stroke(id: string, lines: string[], line: number, extra: Partial<Stroke> = {}): Stroke {
	return {
		id,
		tool: "pen",
		color: "ink",
		size: 1.6,
		style: "ball",
		anchor: anchor(lines, line),
		points: [
			[10, 5, 0.5],
			[20, 15, 0.5],
		],
		...extra,
	};
}

function ink(strokes: Stroke[], spaces: InkSpace[] = []): InkFile {
	return { version: 2, contentWidth: 700, strokes, spaces };
}

let n = 0;
const ids = () => `n${++n}`;

const SRC = [
	"# Lecture", // 0
	"", // 1
	"Alpha beta gamma", // 2
	"continued paragraph", // 3
	"", // 4
	"- item one", // 5
	"- item two", // 6
	"", // 7
	"Last line here", // 8
];
const DST = [
	"# Lecture (organized)", // 0
	"", // 1
	"## Items", // 2
	"- item two", // 3
	"- item one", // 4
	"", // 5
	"Intro: Alpha beta gamma", // 6
	"continued paragraph", // 7
	"", // 8
	"Last line here", // 9
	"Appendix", // 10
];

describe("splitLines", () => {
	it("splits like CodeMirror", () => {
		expect(splitLines("a\r\nb\rc\nd")).toEqual(["a", "b", "c", "d"]);
		expect(splitLines("")).toEqual([""]);
	});
});

describe("inkLinesOf", () => {
	it("is empty without ink", () => {
		expect(inkLinesOf(ink([]), SRC)).toEqual([]);
	});

	it("resolves stroke anchors and space display lines, sorted and unique", () => {
		// Stroke saved at line 2, but the text moved down by one: resolveAnchor finds it by hash.
		const moved = ["new top", ...SRC];
		const s1 = stroke("a", SRC, 2);
		const s2 = stroke("b", SRC, 8);
		const s3 = stroke("c", SRC, 8);
		const spaces: InkSpace[] = [
			{ id: "k1", after: anchor(SRC, 2), height: 100 }, // shown after the paragraph's end (line 3)
			{ id: "k2", after: "end", height: 100 },
		];
		const inSpace = stroke("d", SRC, 0, { space: "k1" });
		expect(inkLinesOf(ink([s1, s2, s3, inSpace], spaces), SRC)).toEqual([2, 3, 8]);
		expect(inkLinesOf(ink([s1, s2, s3, inSpace], spaces), moved)).toEqual([3, 4, 9]);
	});

	it("counts a stroke whose space is unknown as line-anchored", () => {
		expect(inkLinesOf(ink([stroke("a", SRC, 5, { space: "gone" })]), SRC)).toEqual([5]);
	});
});

describe("copyInkData", () => {
	it("maps line-anchored strokes to their destination lines with fresh ids and dst hashes", () => {
		const src = ink([stroke("a", SRC, 5), stroke("b", SRC, 6)]);
		const before = serializeInkFile(src);
		const res = copyInkData(src, SRC, DST, new Map([[5, 4], [6, 3]]), ids);
		expect(res.strokes).toBe(2);
		expect(res.unplaced).toBe(0);
		const [a, b] = res.ink.strokes;
		expect(a.anchor).toEqual(anchor(DST, 4));
		expect(b.anchor).toEqual(anchor(DST, 3));
		expect(a.id).not.toBe("a");
		expect(b.id).not.toBe("b");
		expect(a.id).not.toBe(b.id);
		expect(a.points).toEqual(src.strokes[0].points);
		expect(a.points).not.toBe(src.strokes[0].points);
		expect(res.ink.contentWidth).toBe(700);
		expect(serializeInkFile(src)).toBe(before); // src untouched
	});

	it("sends unmapped / out-of-range ink to the end and counts it", () => {
		const src = ink([stroke("a", SRC, 2), stroke("b", SRC, 5), stroke("c", SRC, 8)]);
		const res = copyInkData(src, SRC, DST, new Map([[5, 99], [8, 9]]), ids);
		expect(res.unplaced).toBe(2);
		expect(res.ink.strokes.map((s) => s.anchor.line)).toEqual([10, 10, 9]);
		expect(res.ink.strokes[0].anchor).toEqual(anchor(DST, 10));
	});

	it("rejects non-integer and negative mappings", () => {
		const src = ink([stroke("a", SRC, 2), stroke("b", SRC, 5)]);
		const res = copyInkData(src, SRC, DST, new Map([[2, 1.5], [5, -1]]), ids);
		expect(res.unplaced).toBe(2);
	});

	it("maps spaces by their display line and rewires their strokes", () => {
		const spaces: InkSpace[] = [
			{ id: "k1", after: anchor(SRC, 2), height: 150 }, // display line 3
			{ id: "k2", after: "end", height: 120 }, // display line 8
			{ id: "k3", after: anchor(SRC, 5), height: 90 }, // display line 5, unmapped
		];
		const src = ink([stroke("a", SRC, 2, { space: "k1" }), stroke("b", SRC, 8, { space: "k2" }), stroke("c", SRC, 5, { space: "k3" }), stroke("d", SRC, 8)], spaces);
		const lines = inkLinesOf(src, SRC);
		expect(lines).toEqual([3, 5, 8]);
		const res = copyInkData(src, SRC, DST, new Map([[3, 6], [8, 7]]), ids);
		expect(res.spaces).toBe(3);
		const [s1, s2, s3] = res.ink.spaces!;
		expect(s1.after).toEqual(anchor(DST, 6));
		expect(s1.height).toBe(150);
		// An "end" space mapped to a line that isn't the end of dst becomes a line space.
		expect(s2.after).toEqual(anchor(DST, 7));
		expect(s3.after).toBe("end");
		expect(new Set(res.ink.spaces!.map((s) => s.id)).size).toBe(3);
		expect(res.ink.spaces!.some((s) => ["k1", "k2", "k3"].includes(s.id))).toBe(false);
		const [a, b, c, d] = res.ink.strokes;
		expect(a.space).toBe(s1.id);
		expect(a.anchor).toEqual(anchor(DST, 6));
		expect(b.space).toBe(s2.id);
		expect(c.space).toBe(s3.id);
		expect(c.anchor).toEqual(anchor(DST, 10)); // end space → last line
		expect(d.space).toBeUndefined();
		expect(d.anchor).toEqual(anchor(DST, 7));
		// unplaced: space k3 and its stroke
		expect(res.unplaced).toBe(2);
		// The copy round-trips through the sidecar format (stroke space ids resolve).
		const back = parseInkFile(serializeInkFile(res.ink));
		expect(back.strokes.map((s) => s.space)).toEqual([s1.id, s2.id, s3.id, undefined]);
	});

	it("keeps an end space at the end when it maps into dst's last block", () => {
		const src = ink([], [{ id: "k", after: "end", height: 100 }]);
		// DST lines 9-10 are one paragraph: after line 9 is after the note's end.
		for (const to of [9, 10]) expect(copyInkData(src, SRC, DST, new Map([[8, to]]), ids).ink.spaces![0].after).toBe("end");
		const res = copyInkData(src, SRC, DST, new Map([[8, 10]]), ids);
		expect(res.unplaced).toBe(0);
	});

	it("drops a stroke's unknown space id (line-anchored fallback)", () => {
		const res = copyInkData(ink([stroke("a", SRC, 5, { space: "gone" })]), SRC, DST, new Map([[5, 4]]), ids);
		expect(res.ink.strokes[0].space).toBeUndefined();
		expect(res.ink.strokes[0].anchor.line).toBe(4);
	});

	it("never carries transient fields", () => {
		const s = stroke("a", SRC, 2, { pos: 12, charPos: 14, char: { line: 2, ch: 6, dx: -3, dy: -2 } });
		const sp: InkSpace = { id: "k", after: anchor(SRC, 2), height: 80, pos: 3 };
		const res = copyInkData(ink([s], [sp]), SRC, DST, new Map([[2, 6], [3, 7]]), ids);
		expect(res.ink.strokes[0].pos).toBeUndefined();
		expect(res.ink.strokes[0].charPos).toBeUndefined();
		expect(res.ink.strokes[0].textRange).toBeUndefined();
		expect(res.ink.spaces![0].pos).toBeUndefined();
	});

	describe("character anchors (Stage H)", () => {
		it("keeps the anchor on the same word in the mapped line", () => {
			// "beta" at ch 6..10 in SRC[2]; char 7 = "e". DST[6] = "Intro: Alpha beta gamma" → beta at 13.
			const s = stroke("a", SRC, 2, { char: { line: 2, ch: 7, dx: -40, dy: -12 } });
			const res = copyInkData(ink([s]), SRC, DST, new Map([[2, 6]]), ids);
			expect(res.ink.strokes[0].char).toEqual({ line: 6, ch: 14, dx: -40, dy: -12 });
		});

		it("drops it when the word isn't on the mapped line", () => {
			const s = stroke("a", SRC, 2, { char: { line: 2, ch: 7, dx: -40, dy: -12 } });
			const res = copyInkData(ink([s]), SRC, DST, new Map([[2, 7]]), ids);
			expect(res.ink.strokes[0].char).toBeUndefined();
			expect(res.ink.strokes[0].anchor.line).toBe(7);
		});

		it("matches whole words only and prefers the same occurrence", () => {
			const src = ["the cat and the dog"]; // second "the" at 12
			const dst = ["bathe: the cat, the dog"]; // whole-word "the" at 7 and 16
			expect(refindChar(src, 0, { line: 0, ch: 13, dx: 0, dy: 0 }, dst, 0)).toEqual({ line: 0, ch: 17, dx: 0, dy: 0 });
			expect(refindChar(src, 0, { line: 0, ch: 0, dx: 0, dy: 0 }, dst, 0)).toEqual({ line: 0, ch: 7, dx: 0, dy: 0 });
			expect(refindChar(["cat"], 0, { line: 0, ch: 1, dx: 0, dy: 0 }, ["concatenate"], 0)).toBeNull();
		});

		it("clamps the offset onto the last character like resolveCharPos", () => {
			expect(refindChar(["end."], 0, { line: 0, ch: 99, dx: 1, dy: 2 }, ["the end."], 0)).toEqual({ line: 0, ch: 7, dx: 1, dy: 2 });
		});

		it("follows a character on another line than the anchor", () => {
			// Anchor line 2, character on line 3 ("paragraph" at 10).
			const s = stroke("a", SRC, 2, { char: { line: 3, ch: 12, dx: 0, dy: 0 } });
			const res = copyInkData(ink([s]), SRC, DST, new Map([[2, 6]]), ids);
			expect(res.ink.strokes[0].char).toEqual({ line: 7, ch: 12, dx: 0, dy: 0 });
		});
	});

	describe("text highlights (Stage C)", () => {
		const hl = (text: Stroke["text"], line = 2): Stroke => stroke("h", SRC, line, { tool: "highlighter", style: undefined, size: 12, text });

		it("re-finds the highlighted text on the mapped line", () => {
			const res = copyInkData(ink([hl({ ch: 6, endLine: 2, endCh: 10 })]), SRC, DST, new Map([[2, 6]]), ids);
			expect(res.ink.strokes[0].text).toEqual({ ch: 13, endLine: 6, endCh: 17 });
			expect(res.ink.strokes[0].anchor).toEqual(anchor(DST, 6));
		});

		it("drops it when the text isn't there", () => {
			const res = copyInkData(ink([hl({ ch: 6, endLine: 2, endCh: 10 })]), SRC, DST, new Map([[2, 9]]), ids);
			expect(res.ink.strokes[0].text).toBeUndefined();
			expect(res.ink.strokes[0].points).toEqual(hl(undefined).points);
		});

		it("re-finds a multi-line highlight starting on the mapped line", () => {
			// "gamma\ncontinued" from SRC[2] ch 11 to SRC[3] ch 9.
			const res = copyInkData(ink([hl({ ch: 11, endLine: 3, endCh: 9 })]), SRC, DST, new Map([[2, 6]]), ids);
			expect(res.ink.strokes[0].text).toEqual({ ch: 18, endLine: 7, endCh: 9 });
		});

		it("resolves the end line relative to a moved anchor", () => {
			const moved = ["intro", ...SRC]; // saved at 2/3, now at 3/4
			expect(refindText(moved, 3, 2, { ch: 11, endLine: 3, endCh: 9 }, DST, 6)).toEqual({ ch: 18, endLine: 7, endCh: 9 });
		});

		it("prefers the same occurrence", () => {
			expect(refindText(["a b a b"], 0, 0, { ch: 4, endLine: 0, endCh: 5 }, ["x a b a b"], 0)).toEqual({ ch: 6, endLine: 0, endCh: 7 });
		});
	});
});
