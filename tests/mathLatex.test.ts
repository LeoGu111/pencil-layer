import { describe, expect, it } from "vitest";
import type { Point, Stroke } from "../src/model";
import { cleanVisionLatexResponse, formatLatexFormula, recognizeMathFromStrokes } from "../src/mathLatex";

let seq = 0;
function mkStroke(pts: readonly [number, number][]): Stroke {
	return {
		id: `m${++seq}`,
		tool: "pen",
		color: "ink",
		size: 2,
		style: "ball",
		anchor: { line: 0, hash: "0" },
		points: pts.map(([x, y]): Point => [x, y, 0.5]),
	};
}

describe("mathLatex", () => {
	it("recognizes addition and equality (1 + 1 = 2)", () => {
		const oneA = mkStroke([[10, 20], [10, 60]]);
		const plusH = mkStroke([[28, 40], [52, 40]]);
		const plusV = mkStroke([[40, 28], [40, 52]]);
		const oneB = mkStroke([[70, 20], [70, 60]]);
		const eq1 = mkStroke([[88, 34], [114, 34]]);
		const eq2 = mkStroke([[88, 46], [114, 46]]);
		const two = mkStroke([[128, 28], [140, 20], [152, 28], [148, 40], [126, 60], [154, 60]]);

		expect(recognizeMathFromStrokes([oneA, plusH, plusV, oneB, eq1, eq2, two])).toBe("1 + 1 = 2");
	});

	it("recognizes a fraction (1 / 2 -> \\frac{1}{2})", () => {
		const num = mkStroke([[30, 10], [30, 34]]);
		const bar = mkStroke([[10, 46], [56, 46]]);
		const den = mkStroke([[20, 56], [32, 50], [44, 56], [40, 68], [18, 86], [46, 86]]);

		expect(recognizeMathFromStrokes([num, bar, den])).toBe("\\frac{1}{2}");
	});

	it("recognizes superscripts (x^2) and square roots (\\sqrt{x})", () => {
		const xA = mkStroke([[10, 30], [34, 64]]);
		const xB = mkStroke([[34, 30], [10, 64]]);
		const expTwo = mkStroke([[42, 16], [50, 10], [58, 16], [54, 24], [40, 34], [60, 34]]);
		expect(recognizeMathFromStrokes([xA, xB, expTwo])).toBe("x^2");

		const radical = mkStroke([[80, 44], [90, 66], [104, 16], [150, 16]]);
		const radX1 = mkStroke([[114, 32], [134, 60]]);
		const radX2 = mkStroke([[134, 32], [114, 60]]);
		expect(recognizeMathFromStrokes([radical, radX1, radX2])).toBe("\\sqrt{x}");
	});

	it("formats inline vs block delimiters and cleans vision responses", () => {
		expect(formatLatexFormula("x^2 + 1", "auto")).toBe("$x^2 + 1$");
		expect(formatLatexFormula("\\frac{1}{2}", "auto")).toBe("$$\n\\frac{1}{2}\n$$");
		expect(formatLatexFormula("\\frac{1}{2}", "inline")).toBe("$\\frac{1}{2}$");
		expect(cleanVisionLatexResponse("```latex\n$$a^2 + b^2 = c^2$$\n```")).toBe("a^2 + b^2 = c^2");
	});

	it("recognizes German handwriting variants (2-stroke 4, barred 7, \\pm, \\le)", () => {
		// 2-stroke '4': L-shape + vertical stem
		const fourL = mkStroke([[20, 10], [10, 36], [38, 36]]);
		const fourV = mkStroke([[30, 14], [30, 52]]);
		expect(recognizeMathFromStrokes([fourL, fourV])).toBe("4");

		// German barred '7': 7 + horizontal crossbar
		const sevenMain = mkStroke([[60, 10], [90, 10], [70, 52]]);
		const sevenBar = mkStroke([[66, 30], [88, 30]]);
		expect(recognizeMathFromStrokes([sevenMain, sevenBar])).toBe("7");

		// \pm: '+' over '-'
		const pmH1 = mkStroke([[110, 24], [134, 24]]);
		const pmV = mkStroke([[122, 12], [122, 36]]);
		const pmH2 = mkStroke([[110, 44], [134, 44]]);
		expect(recognizeMathFromStrokes([pmH1, pmV, pmH2])).toBe("\\pm");
	});
});
