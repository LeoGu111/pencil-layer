/**
 * Ink → 2D canvas (screenshot, clipboard PNG). Uses the same path data as the SVG overlay
 * (`strokeToPath`, `dashArray`) via Path2D, so it never taints the canvas (no SVG images involved).
 */
import { dashArray, isCenterline, strokeToPath } from "./geometry";
import type { Stroke } from "./model";
import type { Rect } from "./crop";
import { resolvedInkColor } from "./inkColor"; // [Stage L]

export interface RenderStroke {
	stroke: Stroke;
	/** Overlay y of the stroke's anchor line top. */
	top: number;
}

export interface InkPaint {
	/** Resolved CSS color for the "ink" color token. */
	ink: string;
	/** Light theme: highlighters multiply (like the overlay's mix-blend-mode). */
	multiplyHighlighter: boolean;
	/** [Stage L] Dark theme: near-black ink renders as `ink`, near-white keeps its color (inkColor.ts). */
	dark?: boolean;
}

/** Highlighter opacity (matches styles.css). */
const HIGHLIGHTER_ALPHA = 0.35;

function parseDash(dash: string | null): number[] {
	if (!dash) return [];
	return dash
		.split(/[\s,]+/)
		.map(Number)
		.filter((n) => Number.isFinite(n));
}

/**
 * Draw strokes into `ctx` so that overlay-space `region` maps to the canvas at `scale` pixels per
 * CSS px. Highlighters go beneath pens (like the overlay); each group keeps its order.
 */
export function drawInk(ctx: CanvasRenderingContext2D, items: readonly RenderStroke[], region: Rect, scale: number, paint: InkPaint): void {
	const groups = [items.filter((i) => i.stroke.tool === "highlighter"), items.filter((i) => i.stroke.tool !== "highlighter")];
	for (const group of groups) {
		for (const { stroke: s, top } of group) {
			const d = strokeToPath(s);
			if (!d) continue;
			let path: Path2D;
			try {
				path = new Path2D(d);
			} catch {
				continue;
			}
			const color = resolvedInkColor(s.color, !!paint.dark, paint.ink, s.tool);
			ctx.save();
			ctx.setTransform(scale, 0, 0, scale, -region.x * scale, (top - region.y) * scale);
			if (s.tool === "highlighter") {
				ctx.globalAlpha = HIGHLIGHTER_ALPHA;
				if (paint.multiplyHighlighter) ctx.globalCompositeOperation = "multiply";
			}
			if (isCenterline(s)) {
				ctx.strokeStyle = color;
				ctx.lineWidth = s.size;
				ctx.lineCap = "round";
				ctx.lineJoin = "round";
				ctx.setLineDash(parseDash(dashArray(s)));
				ctx.stroke(path);
			} else {
				ctx.fillStyle = color;
				ctx.fill(path);
			}
			ctx.restore();
		}
	}
}
