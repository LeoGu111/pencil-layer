import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Point, Stroke } from "../src/model";

interface MockRequestUrlArg {
	url: string;
	method?: string;
	headers?: Record<string, string>;
	body?: string;
}

const mockRequestUrl = vi.fn<(req: MockRequestUrlArg) => Promise<{ status: number; json: unknown }>>();

vi.mock("obsidian", () => ({
	Notice: class {
		constructor(_message?: string) {}
	},
	Platform: { isIosApp: true },
	requestUrl: (req: MockRequestUrlArg) => mockRequestUrl(req),
}));

vi.mock("../src/screenshot", () => ({
	renderInkCanvas: () => ({ toDataURL: () => "data:image/png;base64,ZmFrZQ==" }),
	freeCanvas: () => {},
}));

import { recognizeMathStrokes } from "../src/mathVision";

function sampleOneStroke(): Stroke[] {
	return [
		{
			id: "s1",
			tool: "pen",
			color: "ink",
			size: 2,
			style: "ball",
			anchor: { line: 0, hash: "0" },
			points: [
				[10, 20, 0.5],
				[10, 60, 0.5],
			].map(([x, y, p]): Point => [x, y, p]),
		},
	];
}

const SAMPLE_BOX = { minX: 10, minY: 20, maxX: 10, maxY: 60 };

describe("mathVision", () => {
	beforeEach(() => {
		mockRequestUrl.mockReset();
	});

	it("strictly respects provider === 'offline' even when geminiApiKey is set", async () => {
		const resOnlyGemini = await recognizeMathStrokes(sampleOneStroke(), SAMPLE_BOX, {
			provider: "offline",
			apiKey: "",
			geminiApiKey: "AIza-gemini-secret",
		});

		expect(mockRequestUrl).not.toHaveBeenCalled();
		expect(resOnlyGemini).toEqual({ tex: "1", usedVision: false });

		const resBoth = await recognizeMathStrokes(sampleOneStroke(), SAMPLE_BOX, {
			provider: "offline",
			apiKey: "sk-openai-secret",
			geminiApiKey: "AIza-gemini-secret",
		});

		expect(mockRequestUrl).not.toHaveBeenCalled();
		expect(resBoth).toEqual({ tex: "1", usedVision: false });
	});

	it("prefers geminiApiKey over mathApiKey when provider === 'gemini' and never leaks an OpenAI key", async () => {
		mockRequestUrl.mockResolvedValue({
			status: 200,
			json: { candidates: [{ content: { parts: [{ text: "x^2" }] } }] },
		});

		const res = await recognizeMathStrokes(sampleOneStroke(), SAMPLE_BOX, {
			provider: "gemini",
			apiKey: "sk-openai-leftover",
			geminiApiKey: "AIza-gemini-secret",
		});

		expect(res).toEqual({ tex: "x^2", usedVision: true });
		expect(mockRequestUrl).toHaveBeenCalledTimes(1);
		const req = mockRequestUrl.mock.calls[0]?.[0];
		expect(req?.url).toContain("key=AIza-gemini-secret");
		expect(req?.url).not.toContain("sk-openai-leftover");
	});

	it("does not send an OpenAI sk- key in mathApiKey to Gemini when geminiApiKey is empty", async () => {
		const res = await recognizeMathStrokes(sampleOneStroke(), SAMPLE_BOX, {
			provider: "gemini",
			apiKey: "sk-openai-leftover",
			geminiApiKey: "",
		});

		expect(mockRequestUrl).not.toHaveBeenCalled();
		expect(res).toEqual({ tex: "1", usedVision: false });
	});

	it("uses mathApiKey for Gemini when provider === 'gemini' and geminiApiKey is empty", async () => {
		mockRequestUrl.mockResolvedValue({
			status: 200,
			json: { candidates: [{ content: { parts: [{ text: "y = x" }] } }] },
		});

		const res = await recognizeMathStrokes(sampleOneStroke(), SAMPLE_BOX, {
			provider: "gemini",
			apiKey: "AIza-math-gemini",
			geminiApiKey: "",
		});

		expect(res).toEqual({ tex: "y = x", usedVision: true });
		expect(mockRequestUrl).toHaveBeenCalledTimes(1);
		expect(mockRequestUrl.mock.calls[0]?.[0]?.url).toContain("key=AIza-math-gemini");
	});

	it("uses only mathApiKey for OpenAI and ignores geminiApiKey", async () => {
		mockRequestUrl.mockResolvedValue({
			status: 200,
			json: { choices: [{ message: { content: "a + b" } }] },
		});

		const res = await recognizeMathStrokes(sampleOneStroke(), SAMPLE_BOX, {
			provider: "openai",
			apiKey: "sk-openai-secret",
			geminiApiKey: "AIza-gemini-secret",
		});

		expect(res).toEqual({ tex: "a + b", usedVision: true });
		expect(mockRequestUrl).toHaveBeenCalledTimes(1);
		const req = mockRequestUrl.mock.calls[0]?.[0];
		expect(req?.url).toBe("https://api.openai.com/v1/chat/completions");
		expect(req?.headers?.Authorization).toBe("Bearer sk-openai-secret");

		mockRequestUrl.mockReset();
		const noKey = await recognizeMathStrokes(sampleOneStroke(), SAMPLE_BOX, {
			provider: "openai",
			apiKey: "",
			geminiApiKey: "AIza-gemini-secret",
		});
		expect(mockRequestUrl).not.toHaveBeenCalled();
		expect(noKey).toEqual({ tex: "1", usedVision: false });
	});
});
