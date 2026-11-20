import { describe, expect, it } from "vitest";
import { Band, Pager, chooseCut, crossings, inSlice, padExtents, planSlices } from "../src/printSlices";
import { printAreaHeight, printAreaWidth } from "../src/readingMap";

const P = 1000;

/** Slices partition [0, height] without gaps or overlaps, each at most `max` tall. */
function checkPartition(slices: Band[], height: number, firstMax: number, max: number): void {
	expect(slices[0].from).toBe(0);
	expect(slices[slices.length - 1].to).toBe(height);
	slices.forEach((s, i) => {
		expect(s.to).toBeGreaterThan(s.from);
		expect(s.to - s.from).toBeLessThanOrEqual((i === 0 ? firstMax : max) + 1e-9);
		if (i > 0) expect(s.from).toBe(slices[i - 1].to);
	});
}

describe("printAreaHeight", () => {
	it("from the export settings, like printAreaWidth", () => {
		const cm = 96 / 2.54;
		expect(printAreaHeight({ pageSize: "Letter", margin: "0" })).toBeCloseTo(11 * 96 - 2 * cm);
		expect(printAreaHeight({ pageSize: "Letter", margin: "1" })).toBeCloseTo(11 * 96);
		expect(printAreaHeight({ pageSize: "A4", landscape: true, margin: "2" })).toBeCloseTo(8.27 * 96);
		expect(printAreaHeight({ pageSize: "Letter", margin: "1", downscalePercent: 50 })).toBeCloseTo(11 * 96 * 2);
		expect(printAreaHeight(null)).toBeCloseTo(printAreaHeight({ pageSize: "Letter" }));
		expect(printAreaWidth({ pageSize: "Letter", margin: "1" })).toBeCloseTo(8.5 * 96);
	});
});

describe("padExtents / crossings", () => {
	it("pads and drops invalid extents", () => {
		expect(padExtents([{ from: 50, to: 60 }, { from: NaN, to: 1 }, { from: 5, to: 2 }], 1)).toEqual([{ from: 49, to: 61 }]);
	});
	it("counts strokes strictly crossing y", () => {
		const e = [{ from: 0, to: 10 }, { from: 5, to: 20 }];
		expect(crossings(7, e)).toBe(2);
		expect(crossings(10, e)).toBe(1);
		expect(crossings(25, e)).toBe(0);
	});
});

describe("chooseCut", () => {
	const group = [{ from: 900, to: 1100 }];
	it("no stroke at the limit: cut there", () => {
		expect(chooseCut(0, 800, group, 250)).toBe(800);
		expect(chooseCut(0, 900, group, 250)).toBe(900);
	});
	it("a stroke crossing the limit: cut just above it when near", () => {
		expect(chooseCut(0, 1000, group, 250)).toBe(900);
	});
	it("too far above (or a too short slice): hard cut at the limit", () => {
		expect(chooseCut(0, 1000, [{ from: 600, to: 1100 }], 250)).toBe(1000);
		expect(chooseCut(880, 1000, group, 250, 64)).toBe(1000);
	});
	it("a stroke spanning everything (a frame) doesn't stop it from cutting between rows", () => {
		const e = [{ from: 0, to: 3000 }, { from: 820, to: 900 }, { from: 940, to: 1020 }];
		expect(chooseCut(0, 1000, e, 250)).toBe(940);
	});
	it("no empty point: the fewest crossings, lowest of equals", () => {
		const e = [{ from: 700, to: 1100 }, { from: 850, to: 1050 }, { from: 950, to: 1010 }];
		// 1000 crosses 3; 950 crosses 2; 850 crosses 1.
		expect(chooseCut(0, 1000, e, 250)).toBe(850);
	});
});

describe("planSlices", () => {
	it("a ~3-page drawing from the top of a page: page-sized slices", () => {
		const plan = planSlices(2900, [], { pageHeight: P, firstRoom: P });
		expect(plan.breakFirst).toBe(false);
		expect(plan.slices).toEqual([
			{ from: 0, to: 1000 },
			{ from: 1000, to: 2000 },
			{ from: 2000, to: 2900 },
		]);
	});
	it("starts mid-page: the first slice fills what is left", () => {
		const plan = planSlices(2500, [], { pageHeight: P, firstRoom: 400 });
		expect(plan.slices.map((s) => s.to - s.from)).toEqual([400, 1000, 1000, 100]);
		checkPartition(plan.slices, 2500, 400, P);
	});
	it("too little room left: the drawing starts on the next page", () => {
		const plan = planSlices(1500, [], { pageHeight: P, firstRoom: 120 });
		expect(plan.breakFirst).toBe(true);
		expect(plan.slices).toEqual([
			{ from: 0, to: 1000 },
			{ from: 1000, to: 1500 },
		]);
	});
	it("cuts in empty bands near the page end, never through a stroke that can be avoided", () => {
		// Handwriting rows every 120 px (80 px tall), a big figure 1700–2300.
		const rows: Band[] = [];
		for (let y = 20; y < 1600; y += 120) rows.push({ from: y, to: y + 80 });
		rows.push({ from: 1700, to: 2300 });
		rows.push({ from: 0, to: 2600 }); // a frame around the whole drawing
		const bands = padExtents(rows);
		const plan = planSlices(2600, bands, { pageHeight: P, firstRoom: P });
		checkPartition(plan.slices, 2600, P, P);
		const cuts = plan.slices.slice(1).map((s) => s.from);
		// First cut: above the row 980–1060 (band from 978).
		expect(cuts[0]).toBe(978);
		// Second cut (limit 1978 is inside the figure, whose top 1698 is too far up): hard cut.
		expect(cuts[1]).toBe(1978);
		// The first cut goes through the frame only.
		expect(crossings(cuts[0], bands)).toBe(1);
	});
	it("a crossing stroke shows in both slices", () => {
		const plan = planSlices(2000, [{ from: 0, to: 2000 }], { pageHeight: P, firstRoom: P });
		expect(plan.slices.length).toBe(2);
		const stroke = { from: 900, to: 1100 };
		expect(plan.slices.filter((s) => inSlice(stroke, s)).length).toBe(2);
		expect(inSlice({ from: 1000, to: 1010 }, plan.slices[0])).toBe(false);
	});
	it("a drawing that fits the first room is one slice", () => {
		expect(planSlices(300, [], { pageHeight: P, firstRoom: 500 }).slices).toEqual([{ from: 0, to: 300 }]);
	});
});

describe("Pager", () => {
	it("phases and room from a known page top", () => {
		const p = new Pager(P, 100);
		expect(p.phase(100)).toBe(0);
		expect(p.phase(1350)).toBe(250);
		expect(p.room(1350)).toBe(750);
		expect(p.phase(50)).toBe(950);
	});
	it("a non-breaking block that doesn't fit moves to the next page and starts it", () => {
		const p = new Pager(P, 0);
		p.avoid(800, 300); // pushed: 800 becomes a page top
		expect(p.phase(800)).toBe(0);
		expect(p.phase(1200)).toBe(400);
		p.avoid(1300, 200); // fits
		expect(p.phase(1300)).toBe(500);
	});
	it("forced breaks set the page top", () => {
		const p = new Pager(P, 0);
		p.pageAt(1234);
		expect(p.phase(1234)).toBe(0);
		expect(p.room(1300)).toBe(934);
	});
});
