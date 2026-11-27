import { describe, expect, it } from "vitest";
import { buildWebHandoffPrompt } from "../src/aiAssistant";

describe("aiAssistant", () => {
	it("formats question and note context cleanly for Google AI Pro web handoff", () => {
		const text = buildWebHandoffPrompt("Explain Theorem 2", "Analysis", "Theorem 2: Every continuous function...");
		expect(text).toContain("Explain Theorem 2");
		expect(text).toContain("Note context (Analysis):");
		expect(text).toContain("Theorem 2: Every continuous function...");
	});

	it("omits context section when note is blank", () => {
		expect(buildWebHandoffPrompt("Hello", "Empty", "   ")).toBe("Hello");
	});
});
