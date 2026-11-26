import { describe, expect, it } from "vitest";
import { buildPageGuideLayout, nextPageGuide, pageGuideMetrics, pageGuidePrintConfig } from "../src/pageGuides";

describe("pageGuides", () => {
	it("computes exact PDF-matching dimensions for A4 and A3 portrait/landscape", () => {
		const a4 = pageGuideMetrics("A4")!;
		const a3 = pageGuideMetrics("A3")!;
		const a4Land = pageGuideMetrics("A4-landscape")!;
		expect(a4.width).toBeGreaterThan(680);
		expect(a4.width).toBeLessThan(760);
		expect(a4.height).toBeGreaterThan(1000);
		expect(a4.height).toBeLessThan(1100);
		expect(a3.width).toBeGreaterThan(a4.width * 1.35);
		expect(a3.height).toBeGreaterThan(a4.height * 1.35);
		expect(a4Land.width).toBeGreaterThan(a4Land.height);
		expect(pageGuideMetrics("off")).toBeNull();
	});

	it("builds horizontal page breaks and overflow bounds when the editor is wider than the sheet", () => {
		const layout = buildPageGuideLayout("A4", 900, 2200)!;
		expect(layout.horizontalBreaks.length).toBeGreaterThanOrEqual(2);
		expect(layout.horizontalBreaks[0]).toBe(layout.metrics.height);
		expect(layout.horizontalBreaks[1]).toBe(layout.metrics.height * 2);
		expect(layout.overflowX).toBe(layout.metrics.width);
		expect(layout.overflowWidth).toBe(900 - layout.metrics.width);
		expect(layout.guideWidth).toBe(layout.metrics.width);
	});

	it("cycles cleanly through page formats and supplies print config fallbacks", () => {
		expect(nextPageGuide("off")).toBe("A4");
		expect(nextPageGuide("A4")).toBe("A4-landscape");
		expect(nextPageGuide("Letter")).toBe("off");
		expect(pageGuidePrintConfig("A3-landscape")).toEqual({ pageSize: "A3", landscape: true });
		expect(pageGuidePrintConfig("off")).toBeNull();
	});
});
