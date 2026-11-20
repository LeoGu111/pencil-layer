import { describe, expect, it } from "vitest";
import {
	cropPixels,
	dragCrop,
	embedInsertion,
	fitScale,
	initialCrop,
	intersect,
	renderScale,
	screenshotName,
	stageRect,
	withSuffix,
} from "../src/crop";

const stage = { x: 0, y: 0, w: 400, h: 300 };

describe("stage / initial crop", () => {
	it("stage spans the text column and a vertical margin, clipped to the limits", () => {
		const sel = { x: 100, y: 500, w: 100, h: 50 };
		const st = stageRect(sel, { x: 0, w: 700 }, { x: -40, y: 0, w: 800, h: 5000 });
		expect(st).toEqual({ x: 0, y: 300, w: 700, h: 450 });
	});
	it("stage is clipped at the document top", () => {
		const st = stageRect({ x: 100, y: 50, w: 100, h: 50 }, { x: 0, w: 700 }, { x: -40, y: 0, w: 800, h: 5000 });
		expect(st.y).toBe(0);
		expect(st.h).toBe(300);
	});
	it("a selection wider than the column widens the stage", () => {
		const st = stageRect({ x: -30, y: 500, w: 780, h: 50 }, { x: 0, w: 700 }, { x: -40, y: 0, w: 800, h: 5000 });
		expect(st.x).toBe(-40);
		expect(st.x + st.w).toBe(760);
	});
	it("initial crop = selection + padding, inside the stage", () => {
		expect(initialCrop({ x: 100, y: 100, w: 50, h: 40 }, stage)).toEqual({ x: 84, y: 84, w: 82, h: 72 });
		expect(initialCrop({ x: 5, y: 5, w: 50, h: 40 }, stage)).toEqual({ x: 0, y: 0, w: 71, h: 61 });
	});
	it("intersect of disjoint rects is empty", () => {
		expect(intersect({ x: 0, y: 0, w: 10, h: 10 }, { x: 20, y: 20, w: 5, h: 5 })).toMatchObject({ w: 0, h: 0 });
	});
});

describe("dragCrop", () => {
	const c = { x: 100, y: 100, w: 100, h: 80 };
	it("edges move only their side", () => {
		expect(dragCrop(c, "e", 30, 99, stage)).toEqual({ x: 100, y: 100, w: 130, h: 80 });
		expect(dragCrop(c, "w", -30, 99, stage)).toEqual({ x: 70, y: 100, w: 130, h: 80 });
		expect(dragCrop(c, "n", 5, -20, stage)).toEqual({ x: 100, y: 80, w: 100, h: 100 });
		expect(dragCrop(c, "s", 5, 20, stage)).toEqual({ x: 100, y: 100, w: 100, h: 100 });
	});
	it("corners move two sides", () => {
		expect(dragCrop(c, "nw", -10, -10, stage)).toEqual({ x: 90, y: 90, w: 110, h: 90 });
		expect(dragCrop(c, "se", 10, 10, stage)).toEqual({ x: 100, y: 100, w: 110, h: 90 });
	});
	it("clamps to the stage", () => {
		expect(dragCrop(c, "nw", -500, -500, stage)).toEqual({ x: 0, y: 0, w: 200, h: 180 });
		expect(dragCrop(c, "se", 500, 500, stage)).toEqual({ x: 100, y: 100, w: 300, h: 200 });
	});
	it("never inverts: stops at the minimum size, opposite edge fixed", () => {
		expect(dragCrop(c, "e", -500, 0, stage)).toEqual({ x: 100, y: 100, w: 24, h: 80 });
		expect(dragCrop(c, "n", 0, 500, stage)).toEqual({ x: 100, y: 156, w: 100, h: 24 });
	});
	it("move translates and stays inside", () => {
		expect(dragCrop(c, "move", 10, -5, stage)).toEqual({ x: 110, y: 95, w: 100, h: 80 });
		expect(dragCrop(c, "move", 1000, 1000, stage)).toEqual({ x: 300, y: 220, w: 100, h: 80 });
		expect(dragCrop(c, "move", -1000, -1000, stage)).toEqual({ x: 0, y: 0, w: 100, h: 80 });
	});
});

describe("render scale / pixels", () => {
	it("clamps the DPR to 2–3", () => {
		expect(renderScale(1, 100, 100)).toBe(2);
		expect(renderScale(2, 100, 100)).toBe(2);
		expect(renderScale(2.5, 100, 100)).toBe(2.5);
		expect(renderScale(4, 100, 100)).toBe(3);
		expect(renderScale(NaN, 100, 100)).toBe(2);
	});
	it("reduces the scale for huge regions", () => {
		const s = renderScale(3, 2000, 4000, 10_000_000);
		expect(2000 * 4000 * s * s).toBeLessThanOrEqual(10_000_001);
		expect(s).toBeLessThan(2);
	});
	it("crop → source pixels", () => {
		expect(cropPixels({ x: 10, y: 20, w: 50, h: 40 }, { x: 0, y: 10, w: 100, h: 100 }, 2)).toEqual({ sx: 20, sy: 20, sw: 100, sh: 80 });
	});
	it("source pixels stay inside the canvas", () => {
		const p = cropPixels({ x: 90, y: 90, w: 50, h: 50 }, { x: 0, y: 0, w: 100, h: 100 }, 3);
		expect(p.sx + p.sw).toBeLessThanOrEqual(300);
		expect(p.sy + p.sh).toBeLessThanOrEqual(300);
	});
	it("fitScale", () => {
		expect(fitScale(800, 400, 400, 400)).toBe(0.5);
		expect(fitScale(100, 100, 1000, 1000)).toBe(1.5);
	});
});

describe("naming / embed", () => {
	it("screenshot name uses the note basename and a local timestamp", () => {
		expect(screenshotName("Lec 3", new Date(2026, 10, 16, 9, 5, 7))).toBe("Lec 3 2026-11-16 090507.png");
	});
	it("strips characters that break links", () => {
		expect(screenshotName("a#b[c]|d", new Date(2026, 0, 1, 0, 0, 0))).toBe("a-b-c--d 2026-01-01 000000.png");
		expect(screenshotName("  ", new Date(2026, 0, 1, 0, 0, 0))).toBe("Ink 2026-01-01 000000.png");
	});
	it("withSuffix", () => {
		expect(withSuffix("a b.png", 1)).toBe("a b.png");
		expect(withSuffix("a b.png", 2)).toBe("a b 2.png");
		expect(withSuffix("noext", 3)).toBe("noext 3");
	});
	it("embedInsertion puts the embed on its own line", () => {
		expect(embedInsertion("", "", "![[x.png]]")).toBe("![[x.png]]");
		expect(embedInsertion("Some text", "", "![[x.png]]")).toBe("\n![[x.png]]");
		expect(embedInsertion("Some", " text", "![[x.png]]")).toBe("\n![[x.png]]\n");
	});
});
