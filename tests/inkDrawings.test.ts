/** Public API: inkDrawings layout / clustering (src/inkDrawings.ts). */
import { describe, expect, it } from "vitest";
import { InkFile, InkSpace, Point, Stroke, hashLine } from "../src/model";
import { inkLinesOf } from "../src/inkCopy";
import { APPROX_LINE_HEIGHT, DRAWING_PAD, clusterBoxes, drawingScale, layoutDrawings } from "../src/inkDrawings";

const LINES = ["# Title", "", "text a", "text b", "", "text c", "", "", "", "", "", "text d", "", "end"];
const anchor = (line: number) => ({ line, hash: hashLine(LINES[line]) });

let n = 0;
function stroke(line: number, points: Point[], extra: Partial<Stroke> = {}): Stroke {
	return { id: `s${++n}`, tool: "pen", color: "ink", size: 2, style: "ball", anchor: anchor(line), points, ...extra };
}
const seg = (x0: number, y0: number, x1: number, y1: number): Point[] => [
	[x0, y0, 0.5],
	[x1, y1, 0.5],
];
const ink = (strokes: Stroke[], spaces: InkSpace[] = []): InkFile => ({ version: 2, contentWidth: 700, strokes, spaces });

describe("clusterBoxes", () => {
	const box = (minX: number, minY: number, maxX: number, maxY: number) => ({ minX, minY, maxX, maxY });
	it("joins overlapping and near boxes transitively, keeps far ones apart", () => {
		const ids = clusterBoxes([box(0, 0, 10, 10), box(5, 30, 15, 40), box(0, 60, 10, 70), box(0, 200, 10, 210), box(500, 0, 510, 10)], 24, 72);
		expect(ids[0]).toBe(ids[1]);
		expect(ids[1]).toBe(ids[2]);
		expect(ids[3]).not.toBe(ids[0]);
		expect(ids[4]).not.toBe(ids[0]);
	});
	it("handles empty input", () => {
		expect(clusterBoxes([], 24, 72)).toEqual([]);
	});
});

describe("layoutDrawings", () => {
	it("clusters margin ink on adjacent lines into one drawing keyed by its first line", () => {
		const a = stroke(2, seg(10, 2, 60, 18));
		const b = stroke(3, seg(12, 4, 80, 20));
		const far = stroke(11, seg(10, 2, 40, 18));
		const out = layoutDrawings(ink([a, b, far]), LINES);
		expect(out.map((d) => [d.kind, d.line, d.lines])).toEqual([
			["margin", 2, [2, 3]],
			["margin", 11, [11]],
		]);
		// Fallback layout: line × APPROX_LINE_HEIGHT.
		const d = out[0];
		expect(d.strokes.map((s) => s.top)).toEqual([2 * APPROX_LINE_HEIGHT, 3 * APPROX_LINE_HEIGHT]);
		expect(d.region.x).toBe(10 - 1 - DRAWING_PAD);
		expect(d.region.y).toBe(2 * APPROX_LINE_HEIGHT + 2 - 1 - DRAWING_PAD);
		expect(d.region.w).toBe(80 + 1 - (10 - 1) + 2 * DRAWING_PAD);
		expect(d.region.y + d.region.h).toBe(3 * APPROX_LINE_HEIGHT + 20 + 1 + DRAWING_PAD);
	});

	it("uses live line tops when given (and they decide the clustering)", () => {
		const a = stroke(2, seg(10, 2, 60, 18));
		const b = stroke(3, seg(12, 4, 80, 20));
		// Line 3 is 300 px below line 2 (e.g. a tall space in between): two drawings.
		const out = layoutDrawings(ink([a, b]), LINES, { lineTop: (l) => (l === 3 ? 400 : l * 30) });
		expect(out.map((d) => d.lines)).toEqual([[2], [3]]);
		expect(out[1].strokes[0].top).toBe(400);
	});

	it("keeps side-by-side ink far apart horizontally as separate drawings", () => {
		const out = layoutDrawings(ink([stroke(5, seg(0, 2, 40, 18)), stroke(5, seg(400, 2, 440, 18))]), LINES);
		expect(out).toHaveLength(2);
		expect(out.every((d) => d.line === 5)).toBe(true);
	});

	it("one drawing per space with pen ink, keyed by its display line; highlighters skipped", () => {
		const spaces: InkSpace[] = [
			{ id: "sp1", after: anchor(5), height: 200 },
			{ id: "sp2", after: anchor(11), height: 200 },
			{ id: "sp3", after: "end", height: 200 },
		];
		const s1 = stroke(5, seg(10, 10, 100, 90), { space: "sp1" });
		const s2 = stroke(5, seg(10, 100, 50, 150), { space: "sp1" });
		const hl = stroke(11, seg(0, 0, 100, 10), { space: "sp2", tool: "highlighter", style: undefined });
		const s3 = stroke(13, seg(5, 5, 20, 20), { space: "sp3" });
		const out = layoutDrawings(ink([s1, s2, hl, s3], spaces), LINES);
		expect(out.map((d) => [d.kind, d.line, d.strokes.length])).toEqual([
			["space", 5, 2],
			["space", 13, 1],
		]);
		expect(out[0].strokes.every((s) => s.top === 0)).toBe(true);
		expect(out[0].region.y).toBe(10 - 1 - DRAWING_PAD);
	});

	it("a stroke in an unknown space counts as margin ink; lines match inkLinesOf", () => {
		const spaces: InkSpace[] = [{ id: "sp1", after: anchor(2), height: 100 }];
		const strokes = [
			stroke(2, seg(10, 10, 50, 50), { space: "sp1" }),
			stroke(3, seg(0, 0, 10, 10), { space: "gone" }),
			stroke(11, seg(0, 0, 10, 10)),
			stroke(13, seg(0, 0, 10, 10), { tool: "highlighter", style: undefined }),
		];
		const data = ink(strokes, spaces);
		const out = layoutDrawings(data, LINES);
		const lines = inkLinesOf(data, LINES);
		for (const d of out) for (const l of d.lines) expect(lines).toContain(l);
		expect(out.map((d) => [d.kind, d.line])).toEqual([
			["space", 3],
			["margin", 3],
			["margin", 11],
		]);
	});

	it("resolves moved anchors like the editor", () => {
		const s = stroke(5, seg(0, 0, 10, 10));
		s.anchor = { line: 2, hash: hashLine("text c") }; // saved at line 2, text now on line 5
		expect(layoutDrawings(ink([s]), LINES)[0].line).toBe(5);
	});

	it("empty ink → no drawings", () => {
		expect(layoutDrawings(ink([]), LINES)).toEqual([]);
		expect(layoutDrawings(ink([]), [])).toEqual([]);
	});
});

describe("drawingScale", () => {
	it("caps the long side and the upscale", () => {
		expect(drawingScale(3000, 500)).toBeCloseTo(0.5);
		expect(drawingScale(100, 50)).toBe(4);
		expect(drawingScale(750, 200)).toBe(2);
		expect(drawingScale(0, 0)).toBe(4);
	});
});
