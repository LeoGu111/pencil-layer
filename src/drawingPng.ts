/**
 * Public API support (`inkDrawings`): render one laid-out drawing (inkDrawings.ts) to a PNG —
 * white background, ink in paper colors ("ink" / near-white → near-black, like the PDF export),
 * same stroke rendering as the screenshot / clipboard (inkRender.ts `drawInk`). Uses a DOM canvas
 * (works on iOS, where OffscreenCanvas support is spotty); the canvas is released right after.
 */
import { DrawingLayout, drawingScale } from "./inkDrawings";
import { PAPER_INK } from "./inkColor";
import { drawInk } from "./inkRender";

export interface DrawingPng {
	/** Base64 PNG data (no `data:` prefix). */
	png: string;
	width: number;
	height: number;
}

export function renderDrawingPng(d: DrawingLayout): DrawingPng | null {
	const scale = drawingScale(d.region.w, d.region.h);
	const c = createEl("canvas");
	c.width = Math.max(1, Math.round(d.region.w * scale));
	c.height = Math.max(1, Math.round(d.region.h * scale));
	try {
		const ctx = c.getContext("2d");
		if (!ctx) return null;
		ctx.fillStyle = "#ffffff";
		ctx.fillRect(0, 0, c.width, c.height);
		drawInk(ctx, d.strokes, d.region, scale, { ink: PAPER_INK, multiplyHighlighter: false, dark: false });
		const url = c.toDataURL("image/png");
		const comma = url.indexOf(",");
		if (!url.startsWith("data:image/png") || comma < 0) return null;
		return { png: url.slice(comma + 1), width: c.width, height: c.height };
	} finally {
		// iOS keeps a tight total canvas memory budget.
		c.width = 0;
		c.height = 0;
	}
}
