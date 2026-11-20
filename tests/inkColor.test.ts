import { describe, expect, it } from "vitest";
import { PAPER_INK, classifyColor, inkColor, parseRgb, resolvedInkColor } from "../src/inkColor";
import { HIGHLIGHTER_COLORS, PEN_COLORS } from "../src/settings";

describe("parseRgb", () => {
	it("parses hex, rgb() and names", () => {
		expect(parseRgb("#000")).toEqual([0, 0, 0]);
		expect(parseRgb("#fFf8")).toEqual([255, 255, 255]);
		expect(parseRgb("#03468F")).toEqual([3, 70, 143]);
		expect(parseRgb("#11223344")).toEqual([17, 34, 51]);
		expect(parseRgb("rgb(10, 20, 30)")).toEqual([10, 20, 30]);
		expect(parseRgb("rgba(250 250 250 / 0.5)")).toEqual([250, 250, 250]);
		expect(parseRgb("Black")).toEqual([0, 0, 0]);
		expect(parseRgb("hotpink")).toBeNull();
		expect(parseRgb("var(--x)")).toBeNull();
	});
});

describe("classifyColor", () => {
	it("ink token, near-black, near-white, others", () => {
		expect(classifyColor("ink")).toBe("ink");
		for (const c of ["#000000", "#1a1a1a", "#222", "#333333", "black", "#2b2a33"]) expect(classifyColor(c)).toBe("dark");
		for (const c of ["#ffffff", "#fff", "#f5f5f5", "#eeeeee", "white", "#fafaf0"]) expect(classifyColor(c)).toBe("light");
		// Colors with a hue keep it, however dark or light; mid grays stay.
		for (const c of ["#03468F", "#FF0000", "#000080", "#3a0000", "#808080", "#FFF01F", "#ffc0c0", "nonsense"]) expect(classifyColor(c)).toBe("other");
	});
	it("the palette: only the default pen color adapts", () => {
		expect(PEN_COLORS.map((c) => classifyColor(c.value))).toEqual(["ink", "other", "other", "other", "other", "other", "other"]);
		expect(HIGHLIGHTER_COLORS.every((c) => classifyColor(c.value) === "other")).toBe(true);
	});
});

describe("inkColor", () => {
	it("screen: CSS variables that follow the theme, with the stroke's own color as fallback", () => {
		expect(inkColor("ink", "screen")).toBe("var(--pl-ink, var(--text-normal))");
		expect(inkColor("#000000", "screen")).toBe("var(--pl-dark-ink, #000000)");
		expect(inkColor("#ffffff", "screen")).toBe("var(--pl-light-ink, #ffffff)");
		expect(inkColor("#FF0000", "screen")).toBe("#FF0000");
	});
	it("paper: literal, black ink on white whatever the theme", () => {
		expect(inkColor("ink", "paper")).toBe(PAPER_INK);
		expect(inkColor("#000", "paper")).toBe(PAPER_INK);
		expect(inkColor("#fff", "paper")).toBe(PAPER_INK);
		expect(inkColor("#93419C", "paper")).toBe("#93419C");
	});
	it("highlighters keep their color", () => {
		expect(inkColor("#ffffff", "screen", "highlighter")).toBe("#ffffff");
		expect(inkColor("#111111", "paper", "highlighter")).toBe("#111111");
		expect(inkColor("#39FF14", "screen", "highlighter")).toBe("#39FF14");
	});
	it("never changes the stored color (pure)", () => {
		const s = { color: "#000000" };
		inkColor(s.color, "screen");
		expect(s.color).toBe("#000000");
	});
});

describe("resolvedInkColor (canvas)", () => {
	const fgDark = "rgb(218, 218, 218)";
	const fgLight = "rgb(34, 34, 34)";
	it("dark theme: black-ish → foreground, white stays", () => {
		expect(resolvedInkColor("ink", true, fgDark)).toBe(fgDark);
		expect(resolvedInkColor("#000", true, fgDark)).toBe(fgDark);
		expect(resolvedInkColor("#fff", true, fgDark)).toBe("#fff");
		expect(resolvedInkColor("#FF0000", true, fgDark)).toBe("#FF0000");
	});
	it("light theme: white-ish → foreground, black stays", () => {
		expect(resolvedInkColor("ink", false, fgLight)).toBe(fgLight);
		expect(resolvedInkColor("#000", false, fgLight)).toBe("#000");
		expect(resolvedInkColor("#fff", false, fgLight)).toBe(fgLight);
		expect(resolvedInkColor("#fff", false, fgLight, "highlighter")).toBe("#fff");
	});
});
