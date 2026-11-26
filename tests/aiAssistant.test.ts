import { describe, expect, it } from "vitest";
import { buildWebHandoffPrompt } from "../src/aiAssistant";

describe("aiAssistant", () => {
	it("formats question and note context cleanly for Google AI Pro web handoff", () => {
		const text = buildWebHandoffPrompt("Erkläre Satz 2", "Analysis", "Satz 2: Jede stetige Funktion...");
		expect(text).toContain("Erkläre Satz 2");
		expect(text).toContain("Notiz-Kontext (Analysis):");
		expect(text).toContain("Satz 2: Jede stetige Funktion...");
	});

	it("omits context section when note is blank", () => {
		expect(buildWebHandoffPrompt("Hallo", "Leer", "   ")).toBe("Hallo");
	});
});
