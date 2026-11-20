import { describe, expect, it } from "vitest";
import { makeClip, pasteOrigin, placeClip } from "../src/clipboard";
import type { Point, Stroke } from "../src/model";

const s = (points: Point[], extra: Partial<Stroke> = {}) => ({ tool: "pen" as const, color: "ink", size: 1.6, points, ...extra });

describe("makeClip", () => {
	it("returns null for nothing", () => {
		expect(makeClip([])).toBeNull();
		expect(makeClip([{ stroke: s([]), top: 10 }])).toBeNull();
	});

	it("normalizes points to the bbox of all strokes (line tops applied) and keeps order + metadata", () => {
		const a = s([[10, 5, 0.5], [30, 15, 0.7]], { style: "dotted" });
		const b = s([[50, 0, 0.5], [60, 2, 0.5]], { tool: "highlighter", color: "#FFF01F", size: 12, shape: "line" });
		const clip = makeClip([
			{ stroke: a, top: 100 },
			{ stroke: b, top: 120 },
		])!;
		expect(clip.width).toBe(50);
		expect(clip.height).toBe(17); // y from 105 to 122
		expect(clip.strokes[0].points).toEqual([[0, 0, 0.5], [20, 10, 0.7]]);
		expect(clip.strokes[1].points).toEqual([[40, 15, 0.5], [50, 17, 0.5]]);
		expect(clip.strokes[0].style).toBe("dotted");
		expect(clip.strokes[1]).toMatchObject({ tool: "highlighter", color: "#FFF01F", size: 12, shape: "line" });
		expect("id" in clip.strokes[0]).toBe(false);
		expect("anchor" in clip.strokes[0]).toBe(false);
	});

	it("does not alias the source points", () => {
		const a = s([[1, 1, 0.5]]);
		const clip = makeClip([{ stroke: a, top: 0 }])!;
		clip.strokes[0].points[0][0] = 99;
		expect(a.points[0][0]).toBe(1);
	});
});

describe("pasteOrigin", () => {
	const clip = { width: 100, height: 40 };
	it("centers the clip on the point", () => {
		expect(pasteOrigin(clip, [300, 500], 700)).toEqual([250, 480]);
	});
	it("keeps the clip inside the content column and below the document top", () => {
		expect(pasteOrigin(clip, [10, 5], 700)).toEqual([0, 0]);
		expect(pasteOrigin(clip, [690, 500], 700)).toEqual([600, 480]);
	});
	it("left-aligns a clip wider than the column", () => {
		expect(pasteOrigin({ width: 900, height: 10 }, [400, 100], 700)[0]).toBe(0);
	});
	it("no horizontal clamp without a width", () => {
		expect(pasteOrigin(clip, [10, 100], 0)).toEqual([-40, 80]);
	});
});

describe("placeClip", () => {
	it("translates every point and keeps pressure", () => {
		const clip = makeClip([{ stroke: s([[10, 10, 0.3], [20, 30, 0.9]]), top: 0 }])!;
		const placed = placeClip(clip, [100, 200]);
		expect(placed[0].points).toEqual([[100, 200, 0.3], [110, 220, 0.9]]);
		expect(placed[0].stroke).toBe(clip.strokes[0]);
	});

	it("copy → paste round trip at the original center reproduces overlay points", () => {
		const a = s([[10, 5, 0.5], [30, 15, 0.5]]);
		const clip = makeClip([{ stroke: a, top: 100 }])!;
		const origin = pasteOrigin(clip, [20, 110], 700);
		expect(placeClip(clip, origin)[0].points).toEqual([[10, 105, 0.5], [30, 115, 0.5]]);
	});
});
