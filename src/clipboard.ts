/**
 * Plugin-internal ink clipboard (pure, no DOM): Copy/Cut turn a lasso selection into an
 * anchor-free `InkClip`; Paste places it at a point (in any note) and the caller re-anchors each
 * stroke to the line under its new top, like any new stroke.
 *
 * Coordinates: overlay space (x from content left, y from document top). Clip points are relative
 * to the clip's top-left corner (the bbox of all point coordinates, stroke width ignored).
 */
import type { Point, Stroke } from "./model";

export type XY = [number, number];

/** A stroke without identity or anchor: what is kept on the clipboard. */
export type ClipStroke = Pick<Stroke, "tool" | "color" | "size" | "style" | "shape"> & { points: Point[] };

export interface InkClip {
	/** In z-order (first = bottom-most). */
	strokes: ClipStroke[];
	/** Size of the points' bounding box. */
	width: number;
	height: number;
}

/**
 * Build a clip from strokes with their anchor line tops (overlay y of each stroke's line).
 * Returns null for an empty selection. Strokes keep their order; ids/anchors are dropped.
 */
export function makeClip(items: readonly { stroke: Pick<Stroke, "tool" | "color" | "size" | "style" | "shape" | "points">; top: number }[]): InkClip | null {
	let minX = Infinity;
	let minY = Infinity;
	let maxX = -Infinity;
	let maxY = -Infinity;
	for (const { stroke, top } of items) {
		for (const p of stroke.points) {
			minX = Math.min(minX, p[0]);
			maxX = Math.max(maxX, p[0]);
			minY = Math.min(minY, p[1] + top);
			maxY = Math.max(maxY, p[1] + top);
		}
	}
	if (!Number.isFinite(minX)) return null;
	const strokes = items
		.filter(({ stroke }) => stroke.points.length > 0)
		.map(({ stroke: s, top }): ClipStroke => ({
			tool: s.tool,
			color: s.color,
			size: s.size,
			...(s.style ? { style: s.style } : {}),
			...(s.shape ? { shape: s.shape } : {}),
			points: s.points.map((p): Point => [p[0] - minX, p[1] + top - minY, p[2]]),
		}));
	return { strokes, width: maxX - minX, height: maxY - minY };
}

/**
 * Top-left corner (overlay space) for pasting `clip` at `at`: centered on the point, then kept
 * inside the content column horizontally (left-aligned when wider than the column) and below the
 * document top. `contentWidth` ≤ 0 or non-finite disables the horizontal clamp.
 */
export function pasteOrigin(clip: Pick<InkClip, "width" | "height">, at: readonly number[], contentWidth: number): XY {
	let x = at[0] - clip.width / 2;
	let y = at[1] - clip.height / 2;
	if (Number.isFinite(contentWidth) && contentWidth > 0) {
		if (clip.width >= contentWidth) x = 0;
		else x = Math.min(Math.max(x, 0), contentWidth - clip.width);
	}
	y = Math.max(y, 0);
	return [x, y];
}

/** Overlay-space points of every clip stroke when its top-left corner is at `origin`. */
export function placeClip(clip: InkClip, origin: readonly number[]): { stroke: ClipStroke; points: Point[] }[] {
	return clip.strokes.map((stroke) => ({
		stroke,
		points: stroke.points.map((p): Point => [p[0] + origin[0], p[1] + origin[1], p[2]]),
	}));
}
