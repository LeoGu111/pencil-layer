import { parseRaw } from "./rawInk";
import { describe, expect, it } from "vitest";
import { ChangeSet, Text } from "@codemirror/state";
import {
	CHAR_ANCHOR,
	charAnchorAt,
	charNeedle,
	charOffset,
	charOrigin,
	charSized,
	nearChar,
	pickChar,
	refPoint,
	resolveCharPos,
	touches,
} from "../src/charAnchor";
import { Stroke, hashLine, mergeStrokes, parseInkFile, parseStroke, serializeInkFile, serializeStroke } from "../src/model";
import { selectInLasso, transformPoints, IDENTITY } from "../src/lasso";
import { findNth, normalizeWithMap, stripInline } from "../src/readingMap";

const LH = 24;

function stroke(over: Partial<Stroke> = {}): Stroke {
	return {
		id: "s1",
		tool: "pen",
		color: "ink",
		size: 1.6,
		style: "ball",
		anchor: { line: 2, hash: hashLine("The quick brown fox") },
		points: [
			[100, 4, 0.5],
			[160, 6, 0.5],
		],
		...over,
	};
}

describe("decision rule", () => {
	it("size: only units at most 2.5 line heights tall", () => {
		expect(charSized({ minX: 0, minY: 0, maxX: 600, maxY: 2.5 * LH }, LH)).toBe(true); // a long flat arrow
		expect(charSized({ minX: 0, minY: 0, maxX: 20, maxY: 2.5 * LH + 1 }, LH)).toBe(false); // a tall bracket
		expect(charSized({ minX: 0, minY: 0, maxX: 300, maxY: 300 }, LH)).toBe(false); // a diagram
	});

	it("reference point is the bbox center", () => {
		expect(refPoint({ minX: 10, minY: 20, maxX: 110, maxY: 40 })).toEqual([60, 30]);
	});

	it("over text: within 1 lh horizontally and 0.75 lh vertically of the character", () => {
		const char = [100, 50];
		expect(nearChar([105, 60], char, 18, LH)).toBe(true); // over the character
		expect(nearChar([100 + LH + LH, 60], char, 18, LH)).toBe(true); // 1 lh right of a 1-lh-wide char box
		expect(nearChar([100 + LH + LH + 1, 60], char, 18, LH)).toBe(false); // past the end of a short line
		expect(nearChar([105, 50 + 18 + 0.75 * LH], char, 18, LH)).toBe(true);
		expect(nearChar([105, 50 + 18 + 0.75 * LH + 1], char, 18, LH)).toBe(false); // in the gap below
		expect(nearChar([105, 50 - 0.75 * LH - 1], char, 18, LH)).toBe(false);
	});

	it("picks the nearest letter/digit, starting on the hit point's side", () => {
		const t = "- [ ] **bold** and  more";
		expect(pickChar(t, 9, false)).toBe(9); // "o" of bold
		expect(pickChar(t, 9, true)).toBe(8); // "b"
		expect(pickChar(t, 14, true)).toBe(15); // after "**": "a" (1 away) beats "d" (3 away)
		expect(pickChar(t, 18, false)).toBe(17); // in the double space: "d" of "and" is nearer than "m"
		expect(pickChar(t, 0, false)).toBe(8); // list/task markup skipped
		expect(pickChar("   ***   ", 4, false)).toBeNull();
		expect(pickChar("x" + " ".repeat(40), 30, false)).toBeNull(); // too far
		expect(pickChar("", 0, false)).toBeNull();
	});

	it("joining: bboxes touching within half a line height", () => {
		const a = { minX: 0, minY: 0, maxX: 50, maxY: 10 };
		expect(touches({ minX: 50 + 0.5 * LH, minY: 0, maxX: 70, maxY: 5 }, a, LH)).toBe(true);
		expect(touches({ minX: 50 + 0.5 * LH + 1, minY: 0, maxX: 70, maxY: 5 }, a, LH)).toBe(false);
		expect(CHAR_ANCHOR.joinMs).toBeGreaterThan(0);
	});
});

describe("offset math", () => {
	it("origin = character top-left + offset; stays put when the character doesn't move", () => {
		// Drawn: line top 120 (overlay), character "q" at (37.25, 123.5).
		const off = charOffset([0, 120], [37.26, 123.5]);
		expect(off).toEqual({ dx: -37.3, dy: -3.5 });
		// Re-wrapped: the character moved to the next visual row at the start of the line.
		expect(charOrigin([0, 147.5], off)).toEqual([-37.3, 144]);
		// Same layout: back where it was drawn (within the 0.1 px quantization).
		const [x, y] = charOrigin([37.26, 123.5], off);
		expect(Math.abs(x - 0)).toBeLessThanOrEqual(0.05);
		expect(Math.abs(y - 120)).toBeLessThanOrEqual(0.05);
	});

	it("offsets have no -0", () => {
		expect(Object.is(charOffset([1.01, 0], [1, 0.04]).dy, 0)).toBe(true);
	});

	it("reading-view placement: the stroke keeps its position relative to the character", () => {
		// Editor: character at (200, 300), stroke origin at (0, 290) → points at origin + p.
		const off = charOffset([0, 290], [200, 300]);
		const p = [190, 2]; // a point 10 px left of the char, 8 px above its top
		// Reading view section: the character is at (40, 62) relative to the section.
		const [ox, oy] = charOrigin([40, 62], off);
		expect(ox + p[0]).toBeCloseTo(30);
		expect(oy + p[1]).toBeCloseTo(54);
	});

	it("inherit: a piece keeps following the character (charOffset of the piece origin vs the current char rect)", () => {
		const parent = charOffset([0, 100], [50, 104]); // char at (50, 104)
		// The parent now renders shifted: its origin is at (-30, 130) → char at origin - offset.
		const char = [-30 - parent.dx, 130 - parent.dy];
		expect(char).toEqual([20, 134]);
		const piece = charOffset([0, 120], char); // piece anchored to the line top 120
		expect(charOrigin(char, piece)).toEqual([0, 120]);
	});
});

describe("document positions", () => {
	const doc = Text.of(["# Title", "", "The quick brown fox", "jumps over"]);

	it("anchor ↔ position round trip, relative to the resolved line", () => {
		const pos = doc.line(3).from + 4; // "q"
		const a = charAnchorAt(doc, pos, { dx: -1, dy: -2 });
		expect(a).toEqual({ line: 2, ch: 4, dx: -1, dy: -2 });
		expect(resolveCharPos(doc, 2, 2, a)).toBe(pos);
		// Two lines inserted above: the anchor line resolved 2 lines lower, the char follows.
		const moved = Text.of(["# Title", "", "new", "new", "The quick brown fox", "jumps over"]);
		expect(resolveCharPos(moved, 4, 2, a)).toBe(moved.line(5).from + 4);
		// A char on the line below the anchor line keeps its distance.
		expect(resolveCharPos(doc, 2, 2, { line: 3, ch: 2 })).toBe(doc.line(4).from + 2);
		// Clamped into the document / onto the last character of a shorter line.
		expect(resolveCharPos(doc, 3, 2, { line: 3, ch: 2 })).toBe(doc.line(4).from + 2);
		expect(resolveCharPos(doc, 2, 2, { line: 2, ch: 99 })).toBe(doc.line(3).to - 1);
		expect(resolveCharPos(doc, 1, 1, { line: 1, ch: 5 })).toBe(doc.line(2).from); // empty line
	});

	it("typing before the character pushes it (assoc +1), typing after doesn't", () => {
		const pos = doc.line(3).from + 4;
		const before = ChangeSet.of({ from: pos, insert: "very " }, doc.length);
		expect(before.mapPos(pos, 1)).toBe(pos + 5);
		const after = ChangeSet.of({ from: pos + 1, insert: "x" }, doc.length);
		expect(after.mapPos(pos, 1)).toBe(pos);
	});
});

describe("serialization", () => {
	it("v2 round trip keeps the character anchor (offsets at 0.1 px), after the other fields", () => {
		const s = stroke({ char: { line: 2, ch: 4, dx: -37.26, dy: -3.44 }, charPos: 99, pos: 5 });
		const json = serializeInkFile({ version: 2, contentWidth: 700, strokes: [s] });
		expect(json).toContain('"char":{"line":2,"ch":4,"dx":-37.3,"dy":-3.4}}');
		expect(json).not.toContain("charPos");
		const back = parseInkFile(json).strokes[0];
		expect(back.char).toEqual({ line: 2, ch: 4, dx: -37.3, dy: -3.4 });
		expect(back.anchor).toEqual(s.anchor);
		expect(back.charPos).toBeUndefined();
		// Fixed point after one save.
		expect(serializeInkFile(parseInkFile(json))).toBe(json);
	});

	it("strokes without it (old files) load without it; invalid ones are dropped, the stroke stays", () => {
		expect(parseStroke(serializeStroke(stroke()))!.char).toBeUndefined();
		for (const bad of [{ line: -1, ch: 0, dx: 0, dy: 0 }, { line: 1, ch: 1.5, dx: 0, dy: 0 }, { line: 1, ch: 1, dx: "x", dy: 0 }, null, 7]) {
			const raw = { ...serializeStroke(stroke()), char: bad };
			const p = parseStroke(raw)!;
			expect(p).not.toBeNull();
			expect(p.char).toBeUndefined();
		}
	});

	it("never on a text highlight", () => {
		const hl = stroke({ tool: "highlighter", style: undefined, text: { ch: 0, endLine: 2, endCh: 3 }, char: { line: 2, ch: 1, dx: 0, dy: 0 } });
		expect(serializeStroke(hl).char).toBeUndefined();
		const raw = { ...serializeStroke(hl), char: { line: 2, ch: 1, dx: 0, dy: 0 } };
		expect(parseStroke(raw)!.char).toBeUndefined();
	});

	it("an older plugin (which drops unknown keys) still finds a valid line anchor and points", () => {
		const s = stroke({ char: { line: 2, ch: 4, dx: -37, dy: -3 } });
		const disk = parseRaw(serializeInkFile({ version: 2, contentWidth: 700, strokes: [s] }));
		delete disk.strokes[0].char; // what an older version keeps
		const old = parseInkFile(JSON.stringify(disk)).strokes[0];
		expect(old.anchor).toEqual(s.anchor);
		expect(old.points).toEqual(s.points);
	});
});

describe("merge (live sync)", () => {
	it("character line/ch shifts don't count (local object kept); offsets and presence do (remote wins)", () => {
		const base = stroke({ char: { line: 2, ch: 4, dx: -37, dy: -3 } });
		const local: Stroke = { ...base, char: { line: 3, ch: 9, dx: -37, dy: -3 }, charPos: 42 };
		const remoteSame = parseStroke(serializeStroke(base))!;
		const out = mergeStrokes([base], [local], [remoteSame]);
		expect(out[0]).toBe(local);
		expect(out[0].charPos).toBe(42);
		const remoteNoChar = parseStroke(serializeStroke(stroke()))!;
		expect(mergeStrokes([base], [local], [remoteNoChar])[0]).toBe(remoteNoChar);
		const remoteOther = parseStroke(serializeStroke(stroke({ char: { line: 2, ch: 4, dx: -12, dy: -3 } })))!;
		expect(mergeStrokes([base], [local], [remoteOther])[0]).toBe(remoteOther);
	});
});

describe("Reading view: source → display character", () => {
	const lines = ["Intro line", "", "Some **bold** text with [a link](http://x.y) and bold again", "- item one", "- the bold item"];

	const locate = (lineStart: number, rendered: string, line: number, ch: number): string | null => {
		const n = charNeedle(lines, lineStart, line, ch);
		if (!n) return null;
		const hay = normalizeWithMap(rendered);
		const at = findNth(hay.text, n.needle, n.k);
		return at < 0 ? null : hay.text.slice(at, at + n.needle.length) + "@" + (at + n.offset);
	};

	it("finds the word around the character, the right occurrence, and the offset", () => {
		const rendered = stripInline(lines[2], true);
		expect(rendered).toBe("Some bold text with a link and bold again");
		const second = lines[2].lastIndexOf("bold") + 2; // "l" of the 2nd "bold"
		expect(locate(2, rendered, 2, second)).toBe(`bold@${rendered.lastIndexOf("bold") + 2}`);
		const first = lines[2].indexOf("bold");
		expect(locate(2, rendered, 2, first)).toBe(`bold@${rendered.indexOf("bold")}`);
		expect(locate(2, rendered, 2, lines[2].indexOf("link") + 3)).toBe(`link@${rendered.indexOf("link") + 3}`);
	});

	it("counts occurrences from the section start (list sections, block markers stripped)", () => {
		const rendered = "item one\nthe bold item";
		const ch = lines[4].indexOf("item") + 1;
		const n = charNeedle(lines, 3, 4, ch)!;
		expect(n).toEqual({ needle: "item", k: 1, offset: 1 });
		expect(locate(3, rendered, 4, ch)).toBe(`item@${normalizeWithMap(rendered).text.lastIndexOf("item") + 1}`);
	});

	it("null for markup, whitespace or lines outside the section", () => {
		expect(charNeedle(lines, 2, 2, 5)).toBeNull(); // "*"
		expect(charNeedle(lines, 2, 2, 4)).toBeNull(); // " "
		expect(charNeedle(lines, 3, 2, 0)).toBeNull(); // above the section
	});
});

describe("lasso with shifted (character-anchored) ink", () => {
	it("selectInLasso honors leftOf; transformPoints honors offsetX", () => {
		const s = { points: [[0, 0, 0.5], [10, 0, 0.5]] as [number, number, number][] };
		const loop = [[95, -5], [125, -5], [125, 5], [95, 5]];
		expect(selectInLasso([s], loop, () => 0)).toEqual([]);
		expect(selectInLasso([s], loop, () => 0, () => 100)).toEqual([s]);
		expect(transformPoints(s.points, 20, IDENTITY, 100)).toEqual([
			[100, 20, 0.5],
			[110, 20, 0.5],
		]);
	});
});
