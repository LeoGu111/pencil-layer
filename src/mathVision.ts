/**
 * Optional online Vision-LLM math → LaTeX recognizer using Obsidian's `requestUrl` (bypasses iOS
 * WKWebView CORS) and rendering strokes onto an offscreen canvas. Falls back to the built-in offline
 * recognizer (`recognizeMathFromStrokes`) when provider is `"offline"` or no API key is set.
 */
import { Notice, requestUrl } from "obsidian";
import type { BBox } from "./geometry";
import type { Stroke } from "./model";
import { freeCanvas, renderInkCanvas } from "./screenshot";
import { cleanVisionLatexResponse, recognizeMathFromStrokes } from "./mathLatex";
import type { MathVisionProvider } from "./settings";

export interface VisionMathOptions {
	provider: MathVisionProvider;
	apiKey: string;
}

function strokesToPngBase64(strokes: readonly Stroke[], box: BBox): string {
	const pad = 18;
	const rect = {
		x: box.minX - pad,
		y: box.minY - pad,
		w: Math.max(40, box.maxX - box.minX + pad * 2),
		h: Math.max(40, box.maxY - box.minY + pad * 2),
	};
	const canvas = renderInkCanvas(
		{
			strokes: () => strokes.map((s) => ({ stroke: { ...s, color: "#000000" }, top: 0 })),
			background: "#ffffff",
			paint: { ink: "#000000", multiplyHighlighter: false, dark: false },
		},
		rect,
		2,
	);
	try {
		const url = canvas.toDataURL("image/png");
		return url.replace(/^data:image\/png;base64,/, "");
	} finally {
		freeCanvas(canvas);
	}
}

const PROMPT =
	"Transcribe this handwritten mathematical formula into clean LaTeX. Output ONLY the raw LaTeX expression without surrounding $ or $$ delimiters and without markdown code fences.";

async function callGemini(base64Png: string, apiKey: string): Promise<string> {
	const res = await requestUrl({
		url: `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${encodeURIComponent(apiKey)}`,
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			contents: [
				{
					parts: [
						{ text: PROMPT },
						{ inline_data: { mime_type: "image/png", data: base64Png } },
					],
				},
			],
			generationConfig: { temperature: 0 },
		}),
	});
	const json = res.json as { candidates?: { content?: { parts?: { text?: string }[] } }[] };
	const text = json?.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
	return cleanVisionLatexResponse(text);
}

async function callOpenAI(base64Png: string, apiKey: string): Promise<string> {
	const res = await requestUrl({
		url: "https://api.openai.com/v1/chat/completions",
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Authorization: `Bearer ${apiKey}`,
		},
		body: JSON.stringify({
			model: "gpt-4o-mini",
			temperature: 0,
			messages: [
				{
					role: "user",
					content: [
						{ type: "text", text: PROMPT },
						{ type: "image_url", image_url: { url: `data:image/png;base64,${base64Png}` } },
					],
				},
			],
		}),
	});
	const json = res.json as { choices?: { message?: { content?: string } }[] };
	const text = json?.choices?.[0]?.message?.content ?? "";
	return cleanVisionLatexResponse(text);
}

/**
 * Convert overlay-space strokes (with combined overlay bbox) into raw LaTeX. Uses configured Vision
 * API when enabled & key is present; otherwise runs the built-in offline recognizer immediately.
 */
export async function recognizeMathStrokes(
	overlayStrokes: readonly Stroke[],
	box: BBox,
	opts: VisionMathOptions,
): Promise<string> {
	const key = opts.apiKey.trim();
	if (opts.provider !== "offline" && key) {
		try {
			const png = strokesToPngBase64(overlayStrokes, box);
			const out = opts.provider === "gemini" ? await callGemini(png, key) : await callOpenAI(png, key);
			if (out) return out;
		} catch (err) {
			console.warn("[pencil-layer] Vision LaTeX request failed, falling back to offline recognizer", err);
			new Notice("Vision LaTeX API failed — using offline recognizer");
		}
	}
	return recognizeMathFromStrokes(overlayStrokes);
}
