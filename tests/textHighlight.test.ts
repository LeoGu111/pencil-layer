import { parseRaw } from "./rawInk";
import { describe, expect, it } from "vitest";
import { ChangeSet, Text } from "@codemirror/state";
import {
	Row,
	TEXT_SNAP,
	classifyHighlight,
	coverage,
	mergeRows,
	resolveTextRange,
	rowsBox,
	rowsHitSegment,
	rowsPath,
	rowsSamplePoints,
	rowsToFreehand,
	snapRange,
	textAnchorOf,
} from "../src/textHighlight";
import { Stroke, hashLine, mergeStrokes, parseInkFile, resolveAnchor, serializeInkFile } from "../src/model";
import { strokeInLasso } from "../src/lasso";

const LH = 24;

/** Points along a polyline, every ~2 px, with a little vertical jitter. */
function path(...pts: [number, number][]): [number, number, number][] {
	const out: [number, number, number][] = [];
	for (let i = 0; i + 1 < pts.length; i++) {
		const [x0, y0] = pts[i];
		const [x1, y1] = pts[i + 1];
		const n = Math.max(1, Math.ceil(Math.hypot(x1 - x0, y1 - y0) / 2));
		for (let k = 0; k < n; k++) {
			const t = k / n;
			out.push([x0 + (x1 - x0) * t, y0 + (y1 - y0) * t + Math.sin(out.length) * 1.5, 0.5]);
		}
	}
	const last = pts[pts.length - 1];
	out.push([last[0], last[1], 0.5]);
	return out;
}

const doc = (s: string) => Text.of(s.split("\n"));
const slice = (d: Text, r: { from: number; to: number } | null) => (r ? d.sliceString(r.from, r.to) : null);

describe("classifyHighlight (decision rule)", () => {
	it("a horizontal stroke over one line is a single-line highlight", () => {
		expect(classifyHighlight(path([10, 12], [200, 14]), LH)).toBe("line");
		// right to left too
		expect(classifyHighlight(path([200, 14], [10, 10]), LH)).toBe("line");
		// slightly slanted
		expect(classifyHighlight(path([10, 5], [300, 5 + 0.6 * LH]), LH)).toBe("line");
		// scrubbing back and forth over a word
		expect(classifyHighlight(path([10, 12], [80, 14], [12, 10], [82, 13]), LH)).toBe("line");
	});

	it("tiny strokes and dots stay freehand", () => {
		expect(classifyHighlight([[0, 0, 0.5]], LH)).toBeNull();
		expect(classifyHighlight(path([0, 0], [5, 1]), LH)).toBeNull();
		expect(classifyHighlight(path([0, 0], [100, 0]), 0)).toBeNull();
	});

	it("a short steep stroke within one line height stays freehand (more vertical than horizontal)", () => {
		expect(classifyHighlight(path([0, 0], [10, 20]), LH)).toBeNull();
	});

	it("a top-to-bottom sweep over several lines is a multi-line highlight", () => {
		// along line 1, back to the start of line 2, along line 2
		expect(classifyHighlight(path([20, 12], [400, 12], [10, 36], [250, 36]), LH)).toBe("lines");
		// three lines that way
		expect(classifyHighlight(path([20, 12], [400, 12], [10, 36], [400, 36], [10, 60], [120, 60]), LH)).toBe("lines");
		// a diagonal drag from the start word down to the end word
		expect(classifyHighlight(path([300, 12], [60, 84]), LH)).toBe("lines");
	});

	it("vertical lines, circles, zigzags and bottom-to-top strokes stay freehand", () => {
		expect(classifyHighlight(path([50, 0], [52, 120]), LH)).toBeNull(); // margin line
		const circle: [number, number][] = [];
		for (let i = 0; i <= 32; i++) circle.push([100 + 60 * Math.cos((i / 32) * 2 * Math.PI), 60 + 50 * Math.sin((i / 32) * 2 * Math.PI)]);
		expect(classifyHighlight(path(...circle), LH)).toBeNull();
		expect(classifyHighlight(path([0, 0], [100, 40], [0, 80], [100, 40], [0, 0]), LH)).toBeNull();
		expect(classifyHighlight(path([20, 84], [300, 12]), LH)).toBeNull(); // bottom to top
	});

	it("multi-line strokes must start in the top row and end in the bottom row", () => {
		// starts low, rises to the top, then goes down
		expect(classifyHighlight(path([0, 40], [100, 0], [200, 80]), LH)).toBeNull();
		// goes down and comes back up before the end
		expect(classifyHighlight(path([0, 0], [100, 80], [200, 40]), LH)).toBeNull();
	});

	it("thresholds scale with the line height", () => {
		const s = path([0, 0], [200, 15]);
		expect(classifyHighlight(s, 24)).toBe("line"); // 15 < 18: one line
		expect(classifyHighlight(s, 16)).toBe("lines"); // 15 >= 12: a (diagonal) sweep to the next line
		const u = path([0, 0], [100, 45], [200, 0]); // a "V": too tall for one line, comes back up
		expect(classifyHighlight(u, 24)).toBeNull();
		expect(classifyHighlight(u, 60)).toBe("line");
		expect(TEXT_SNAP.maxSingleHeight).toBe(1.5);
	});
});

describe("snapRange (word boundaries)", () => {
	const d = doc("The quick brown fox jumps\n\nover the lazy dog.\n- **bold** item");

	it("keeps exact word boundaries", () => {
		expect(slice(d, snapRange(d, 4, 15))).toBe("quick brown");
	});

	it("moves an end inside a word to the nearer edge", () => {
		// "fox" = 16..19: ending one char in drops it, two chars in includes it
		expect(slice(d, snapRange(d, 4, 17))).toBe("quick brown");
		expect(slice(d, snapRange(d, 4, 18))).toBe("quick brown fox");
		// starting one char into "quick" includes it, three chars in skips it
		expect(slice(d, snapRange(d, 5, 15))).toBe("quick brown");
		expect(slice(d, snapRange(d, 7, 15))).toBe("brown");
	});

	it("ties include the word", () => {
		// "brown" = 10..15; middle at 12.5 → offsets 12 (2 vs 3) and 13 (3 vs 2)
		expect(slice(d, snapRange(d, 4, 12))).toBe("quick");
		expect(slice(d, snapRange(d, 4, 13))).toBe("quick brown");
		// "jumps" = 20..25 (odd length 5): 22 is closer to the start, 23 to the end
		expect(slice(d, snapRange(d, 16, 22))).toBe("fox");
		expect(slice(d, snapRange(d, 16, 23))).toBe("fox jumps");
	});

	it("is order-independent and trims whitespace and markup", () => {
		expect(slice(d, snapRange(d, 15, 3))).toBe("quick brown");
		const l4 = d.line(4).from;
		expect(slice(d, snapRange(d, l4, l4 + 15))).toBe("bold** item");
		expect(slice(d, snapRange(d, l4, l4 + 10))).toBe("bold");
	});

	it("spans lines (blank lines included) and trims at both ends", () => {
		const from = 20; // "jumps"
		const to = d.line(3).from + 8; // "over the|"
		expect(slice(d, snapRange(d, from, to))).toBe("jumps\n\nover the");
	});

	it("a short stroke inside one word selects that word", () => {
		expect(slice(d, snapRange(d, 11, 13))).toBe("brown");
	});

	it("nothing to highlight → null", () => {
		expect(snapRange(d, d.line(2).from, d.line(2).from)).toBeNull(); // blank line
		const l4 = d.line(4).from;
		expect(snapRange(d, l4, l4 + 4)).toBeNull(); // "- **" markup only
		expect(snapRange(d, 3, 4)).toBeNull(); // a single space
	});

	it("handles apostrophes and unicode letters", () => {
		const e = doc("don't stop l’été 42x");
		expect(slice(e, snapRange(e, 1, 4))).toBe("don't");
		expect(slice(e, snapRange(e, 12, 15))).toBe("l’été");
		expect(slice(e, snapRange(e, 17, 19))).toBe("42x");
	});

	it("clamps out-of-document positions", () => {
		expect(slice(d, snapRange(d, -5, 3))).toBe("The");
		expect(slice(d, snapRange(d, d.length - 4, d.length + 10))).toBe("item");
	});
});

describe("text anchors", () => {
	const d = doc("# Title\nalpha beta gamma\ndelta epsilon\nzeta");

	it("textAnchorOf: line of `from` + offsets", () => {
		const from = d.line(2).from + 6; // beta
		const to = d.line(3).from + 5; // delta|
		const t = textAnchorOf(d, { from, to });
		expect(t.anchor).toEqual({ line: 1, hash: hashLine("alpha beta gamma") });
		expect(t.text).toEqual({ ch: 6, endLine: 2, endCh: 5 });
		expect(t.lineFrom).toBe(d.line(2).from);
	});

	it("resolve ∘ anchor is the identity", () => {
		const r = { from: d.line(2).from + 6, to: d.line(3).from + 5 };
		const t = textAnchorOf(d, r);
		expect(resolveTextRange(d, t.anchor.line, t.anchor.line, t.text)).toEqual(r);
	});

	it("survives lines inserted above (anchor found by hash, end line keeps its distance)", () => {
		const r = { from: d.line(2).from + 6, to: d.line(3).from + 5 };
		const t = textAnchorOf(d, r);
		const edited = doc("new line\nanother\n# Title\nalpha beta gamma\ndelta epsilon\nzeta");
		const line = resolveAnchor({ count: edited.lines, get: (i) => edited.line(i + 1).text }, t.anchor);
		expect(line).toBe(3);
		const r2 = resolveTextRange(edited, line, t.anchor.line, t.text);
		expect(edited.sliceString(r2.from, r2.to)).toBe("beta gamma\ndelta");
	});

	it("clamps offsets into shortened lines and to the document end", () => {
		const short = doc("alpha\nzz");
		const r = resolveTextRange(short, 0, 0, { ch: 3, endLine: 5, endCh: 40 });
		expect(r).toEqual({ from: 3, to: short.length });
		// end before start (garbage) → empty at from
		expect(resolveTextRange(short, 1, 1, { ch: 5, endLine: 0, endCh: 0 })).toEqual({ from: 8, to: 8 });
	});

	it("maps through edits like CM6 does (from assoc +1, to assoc -1)", () => {
		const r = { from: d.line(2).from + 6, to: d.line(2).from + 10 }; // "beta"
		const map = (cs: ChangeSet) => {
			const from = cs.mapPos(r.from, 1);
			return { from, to: Math.max(from, cs.mapPos(r.to, -1)) };
		};
		// typing right before / right after the word stays outside the highlight
		const before = ChangeSet.of([{ from: r.from, insert: "XX" }], d.length);
		const after = ChangeSet.of([{ from: r.to, insert: "YY" }], d.length);
		const dd = before.apply(d);
		expect(slice(dd, map(before))).toBe("beta");
		expect(slice(after.apply(d), map(after))).toBe("beta");
		// typing inside grows it
		const inside = ChangeSet.of([{ from: r.from + 2, insert: "--" }], d.length);
		expect(slice(inside.apply(d), map(inside))).toBe("be--ta");
		// deleting the word collapses it
		const del = ChangeSet.of([{ from: r.from - 1, to: r.to + 1 }], d.length);
		const m = map(del);
		expect(m.to).toBe(m.from);
	});
});

describe("rows", () => {
	const frag = (left: number, top: number, right: number, bottom: number): Row => ({ left, top, right, bottom });

	it("mergeRows unions fragments per visual line and drops junk", () => {
		const rows = mergeRows([
			frag(100, 30, 180, 48), // second visual line
			frag(0, 2, 60, 20),
			frag(58, 0, 90, 22), // bold span on line 1, slightly taller
			frag(0, 30, 40, 48),
			frag(10, 10, 10.2, 12), // zero width
			frag(0, 50, 300, 250), // an embed
		], 60);
		expect(rows).toEqual([frag(0, 0, 90, 22), frag(0, 30, 180, 48)]);
	});

	it("rowsPath draws one closed rounded rect per row, relative to the line top", () => {
		const d = rowsPath([frag(0, 100, 50, 120), frag(0, 124, 30, 144)], 100);
		expect(d.match(/M/g)?.length).toBe(2);
		expect(d.match(/Z/g)?.length).toBe(2);
		expect(d.startsWith("M1.5 -1H")).toBe(true); // padded by 1.5/1, radius 3
		expect(rowsPath([])).toBe("");
	});

	it("rowsBox is the padded union", () => {
		expect(rowsBox([frag(0, 0, 10, 10), frag(5, 20, 50, 30)])).toEqual({ minX: -1.5, minY: -1, maxX: 51.5, maxY: 31 });
		expect(rowsBox([])).toBeNull();
	});

	it("eraser hit test against rects", () => {
		const rows = [frag(100, 100, 200, 120)];
		expect(rowsHitSegment(rows, 150, 50, 150, 150, 0)).toBe(true); // crosses
		expect(rowsHitSegment(rows, 150, 110, 150, 110, 0)).toBe(true); // a point inside
		expect(rowsHitSegment(rows, 150, 80, 150, 90, 10)).toBe(true); // within radius above (pad 1)
		expect(rowsHitSegment(rows, 150, 60, 150, 80, 10)).toBe(false);
		expect(rowsHitSegment(rows, 0, 0, 90, 90, 5)).toBe(false); // diagonal passing the corner
		expect(rowsHitSegment(rows, 50, 110, 250, 110, 0)).toBe(true); // passes through horizontally
	});

	it("coverage of a stroke's horizontal extent", () => {
		const rows = [frag(0, 0, 100, 20)];
		expect(coverage(rows, 0, 100)).toBe(1);
		expect(coverage(rows, 50, 150)).toBe(0.5);
		expect(coverage(rows, 200, 300)).toBe(0);
		expect(coverage([frag(0, 0, 60, 20), frag(40, 30, 100, 50)], 0, 200)).toBe(0.5); // overlap counted once
	});

	it("sample points stand in for the rects in the lasso touch rule", () => {
		const rows = [frag(100, 100, 200, 120)];
		const pts = rowsSamplePoints(rows, 100);
		expect(pts.every((p) => p[1] === 10)).toBe(true);
		expect(pts[0][0]).toBe(100);
		expect(pts[pts.length - 1][0]).toBe(200);
		const loop = [
			[90, 90],
			[210, 90],
			[210, 130],
			[90, 130],
		];
		expect(strokeInLasso(pts, loop, 0, 100)).toBe(true);
		const half = [
			[90, 90],
			[140, 90],
			[140, 130],
			[90, 130],
		];
		expect(strokeInLasso(pts, half, 0, 100)).toBe(true); // touch rule: any part inside selects
		const away = [
			[300, 90],
			[400, 90],
			[400, 130],
			[300, 130],
		];
		expect(strokeInLasso(pts, away, 0, 100)).toBe(false);
	});

	it("rowsToFreehand: one capsule per row spanning the padded rect", () => {
		const parts = rowsToFreehand([frag(100, 100, 200, 120), frag(0, 124, 10, 144)], 100);
		expect(parts).toHaveLength(2);
		expect(parts[0].size).toBe(22);
		const p0 = parts[0].points;
		expect(p0[0]).toEqual([98.5 + 11, 10, 0.5]);
		expect(p0[p0.length - 1][0]).toBeCloseTo(201.5 - 11);
		// narrower than tall: a single dot
		expect(parts[1].points.every((p) => p[0] === parts[1].points[0][0])).toBe(true);
	});
});

describe("text highlight persistence", () => {
	const hl = (over: Partial<Stroke> = {}): Stroke => ({
		id: "t1",
		tool: "highlighter",
		color: "#FFF01F",
		size: 12,
		anchor: { line: 3, hash: "abc" },
		points: [
			[10, 5, 0.5],
			[80.04, 6, 0.5],
		],
		text: { ch: 4, endLine: 4, endCh: 7 },
		...over,
	});

	it("serializes `text` in v2 and round-trips; transient fields are dropped", () => {
		const s = hl({ textRange: { from: 40, to: 70 }, pos: 36 });
		const json = serializeInkFile({ version: 2, contentWidth: 700, strokes: [s] });
		const raw = parseRaw(json);
		expect(raw.version).toBe(2);
		expect(raw.strokes[0].text).toEqual({ ch: 4, endLine: 4, endCh: 7 });
		expect(raw.strokes[0].textRange).toBeUndefined();
		expect(raw.strokes[0].pos).toBeUndefined();
		expect(Object.keys(raw.strokes[0])).toEqual(["id", "tool", "color", "size", "anchor", "xy", "text"]);
		const back = parseInkFile(json).strokes[0];
		expect(back.text).toEqual({ ch: 4, endLine: 4, endCh: 7 });
		expect(back.textRange).toBeUndefined();
		expect(serializeInkFile(parseInkFile(json))).toBe(json); // fixed point
	});

	it("an empty range (deleted text) is kept as a text highlight", () => {
		const json = serializeInkFile({ version: 2, contentWidth: 0, strokes: [hl({ text: { ch: 4, endLine: 3, endCh: 4 } })] });
		expect(parseInkFile(json).strokes[0].text).toEqual({ ch: 4, endLine: 3, endCh: 4 });
	});

	it("invalid text anchors are dropped (the stroke loads as a freehand highlighter)", () => {
		const base = parseRaw(serializeInkFile({ version: 2, contentWidth: 0, strokes: [hl()] }));
		for (const text of [null, 5, {}, { ch: -1, endLine: 4, endCh: 1 }, { ch: 1.5, endLine: 4, endCh: 2 }, { ch: 1, endLine: 2, endCh: 2 }, { ch: 5, endLine: 3, endCh: 4 }, { ch: "1", endLine: 4, endCh: 2 }]) {
			const s = parseInkFile(JSON.stringify({ ...base, strokes: [{ ...base.strokes[0], text }] })).strokes[0];
			expect(s).toBeDefined();
			expect(s.text).toBeUndefined();
			expect(s.tool).toBe("highlighter");
		}
	});

	it("text is ignored on pens (and never written for them)", () => {
		const pen: Stroke = { ...hl(), tool: "pen", style: "ball" };
		const raw = parseRaw(serializeInkFile({ version: 2, contentWidth: 0, strokes: [pen] }));
		expect(raw.strokes[0].text).toBeUndefined();
		const loaded = parseInkFile(JSON.stringify({ version: 2, contentWidth: 0, strokes: [{ ...raw.strokes[0], text: { ch: 1, endLine: 4, endCh: 2 } }] }));
		expect(loaded.strokes[0].text).toBeUndefined();
	});

	it("v1-style files with text load too", () => {
		const v1 = JSON.stringify({ version: 1, contentWidth: 0, strokes: [{ id: "a", tool: "highlighter", color: "#FFF01F", size: 12, anchor: { line: 0, hash: "x" }, points: [[0, 0, 0.5], [9, 0, 0.5]], text: { ch: 0, endLine: 0, endCh: 3 } }] });
		expect(parseInkFile(v1).strokes[0].text).toEqual({ ch: 0, endLine: 0, endCh: 3 });
	});

	it("live-sync merge: text offsets changed by edits don't count as a content change", () => {
		const local = hl({ textRange: { from: 1, to: 9 } });
		const remote = parseInkFile(serializeInkFile({ version: 2, contentWidth: 0, strokes: [hl({ text: { ch: 9, endLine: 5, endCh: 1 }, anchor: { line: 2, hash: "q" } })] })).strokes;
		expect(remote[0].text).toEqual({ ch: 9, endLine: 5, endCh: 1 });
		const merged = mergeStrokes([local], [local], remote);
		expect(merged).toHaveLength(1);
		expect(merged[0]).toBe(local); // same object: keeps its live range
	});

	it("live-sync merge: a remote text highlight is added; a locally erased one stays erased", () => {
		const a = hl({ id: "a" });
		const b = hl({ id: "b" });
		const remote = parseInkFile(serializeInkFile({ version: 2, contentWidth: 0, strokes: [a, b] })).strokes;
		const merged = mergeStrokes([a], [], remote); // a erased locally, b new remotely
		expect(merged.map((s) => s.id)).toEqual(["b"]);
		expect(merged[0].text).toEqual(b.text);
		expect(merged[0].textRange).toBeUndefined(); // resolved by the view from its anchor
	});

	it("a text highlight differs in content from the same freehand stroke", () => {
		const freehand = hl({ text: undefined });
		const remote = parseInkFile(serializeInkFile({ version: 2, contentWidth: 0, strokes: [hl()] })).strokes;
		expect(mergeStrokes([freehand], [freehand], remote)[0]).not.toBe(freehand);
	});
});
