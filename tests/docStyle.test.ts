import { describe, expect, it } from "vitest";
import { DOC_FONT_STACKS, docFontStack, inkYScale, otherStyle, scaleInkY, styleExportLabel } from "../src/docStyle";

describe("document-style export", () => {
	it("font stacks start with the classic word-processor fonts", () => {
		expect(docFontStack("serif")).toBe('"Times New Roman", Times, Georgia, serif');
		expect(docFontStack("sans")).toBe("Calibri, Aptos, Carlito, Arial, sans-serif");
		expect(docFontStack("bogus" as never)).toBe(DOC_FONT_STACKS.serif);
	});
	it("the extra export entry offers the style that isn't the default", () => {
		expect(otherStyle("themed")).toBe("document");
		expect(otherStyle("document")).toBe("themed");
		expect(styleExportLabel(otherStyle("themed"))).toBe("Export PDF (document style)");
		expect(styleExportLabel(otherStyle("document"))).toBe("Export PDF (themed style)");
	});
});

describe("ink against document-style text (vertical scale)", () => {
	it("scale = print line height / editor line height; 1 when unknown or close", () => {
		expect(inkYScale(18.4, 24)).toBeCloseTo(0.7667, 3);
		expect(inkYScale(18.4, 18.8)).toBe(1);
		expect(inkYScale(18.4, null)).toBe(1);
		expect(inkYScale(18.4, 0)).toBe(1);
		expect(inkYScale(0, 24)).toBe(1);
		expect(inkYScale(100, 1)).toBe(4);
	});
	it("character anchor: offsets inside the glyph box stay, the leading beyond it scales", () => {
		// Glyph box 18 px tall at top 0. An underline centered 19 px below the glyph top (translate
		// y −21, points centered at 40) only moves by the 1 px past the box × (r − 1).
		expect(scaleInkY(-21, 0, 40, 0.64, 18) + 40).toBeCloseTo(18 + 1 * 0.64, 6);
		// A mark through the glyph doesn't move at all.
		expect(scaleInkY(-30, 0, 40, 0.64, 18)).toBe(-30);
		// A mark above the text: its distance above the glyph top scales.
		expect(scaleInkY(-50, 0, 40, 0.5, 18) + 40).toBeCloseTo(-5, 6);
	});
	it("a line-anchored mark mid-line stays mid-line; nothing moves at scale 1", () => {
		// Line top at 100, mark centered 14 px into a 28.8 px editor line; print line 18.4 px.
		const r = inkYScale(18.4, 28.8);
		const y = scaleInkY(100, 100, 14, r);
		expect(y + 14 - 100).toBeCloseTo((14 * 18.4) / 28.8, 6);
		expect(scaleInkY(123, 100, 14, 1)).toBe(123);
	});
});
