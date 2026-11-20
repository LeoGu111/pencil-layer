/**
 * Screenshot crop math (pure): the rendered "stage" region around a selection, the initial crop,
 * dragging crop edges/corners/body, render scale and output pixel rectangles, file naming.
 *
 * Rects are in overlay space (CSS px; x from content left, y from document top) unless noted.
 */
import type { BBox } from "./geometry";

export interface Rect {
	x: number;
	y: number;
	w: number;
	h: number;
}

/** Which part of the crop frame is dragged. */
export type CropHandle = "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw" | "move";
export const CROP_HANDLES: readonly CropHandle[] = ["n", "s", "e", "w", "ne", "nw", "se", "sw"];

/** Smallest crop side (CSS px). */
export const MIN_CROP = 24;
/** Padding around the selection for the initial crop. */
export const CROP_PAD = 16;
/** Device-pixel ratio range for the output. */
export const MIN_RENDER_SCALE = 2;
export const MAX_RENDER_SCALE = 3;
/**
 * Max pixels of one rendered canvas. iOS WebKit refuses canvases above 16,777,216 px (and the total
 * canvas memory is limited), so stay well below.
 */
export const MAX_CANVAS_PIXELS = 10_000_000;

export function rectFromBox(b: BBox): Rect {
	return { x: b.minX, y: b.minY, w: b.maxX - b.minX, h: b.maxY - b.minY };
}

/** Intersection of two rects (w/h may be 0 when they don't overlap). */
export function intersect(a: Rect, b: Rect): Rect {
	const x = Math.max(a.x, b.x);
	const y = Math.max(a.y, b.y);
	const r = Math.min(a.x + a.w, b.x + b.w);
	const bt = Math.min(a.y + a.h, b.y + b.h);
	return { x, y, w: Math.max(0, r - x), h: Math.max(0, bt - y) };
}

/**
 * The region rendered in the screenshot modal: the selection plus room to grow the crop — the full
 * text column (`column`, e.g. x 0..content width) horizontally and a generous margin vertically —
 * clipped to `limits` (what can be rendered: scroller width × document height).
 */
export function stageRect(sel: Rect, column: { x: number; w: number }, limits: Rect, vMargin = 200): Rect {
	const m = Math.max(vMargin, sel.h * 0.5);
	const x0 = Math.min(sel.x - CROP_PAD * 2, column.x);
	const x1 = Math.max(sel.x + sel.w + CROP_PAD * 2, column.x + column.w);
	const r = intersect({ x: x0, y: sel.y - m, w: x1 - x0, h: sel.h + 2 * m }, limits);
	return r.w > 0 && r.h > 0 ? r : { ...sel };
}

/** Initial crop: the selection bbox + padding, inside the stage. */
export function initialCrop(sel: Rect, stage: Rect, pad = CROP_PAD): Rect {
	const r = intersect({ x: sel.x - pad, y: sel.y - pad, w: sel.w + 2 * pad, h: sel.h + 2 * pad }, stage);
	return r.w >= 1 && r.h >= 1 ? r : { ...stage };
}

/**
 * Crop after dragging `handle` by (dx, dy) from `start`. Edges stop at the stage bounds and at the
 * minimum size (the opposite edge never moves); "move" translates, clamped inside the stage.
 */
export function dragCrop(start: Rect, handle: CropHandle, dx: number, dy: number, stage: Rect, minSize = MIN_CROP): Rect {
	const min = Math.min(minSize, stage.w, stage.h);
	if (handle === "move") {
		const x = Math.min(Math.max(start.x + dx, stage.x), stage.x + stage.w - start.w);
		const y = Math.min(Math.max(start.y + dy, stage.y), stage.y + stage.h - start.h);
		return { x, y, w: start.w, h: start.h };
	}
	let l = start.x;
	let t = start.y;
	let r = start.x + start.w;
	let b = start.y + start.h;
	if (handle.includes("w")) l = Math.min(Math.max(l + dx, stage.x), r - min);
	if (handle.includes("e")) r = Math.max(Math.min(r + dx, stage.x + stage.w), l + min);
	if (handle.includes("n")) t = Math.min(Math.max(t + dy, stage.y), b - min);
	if (handle.includes("s")) b = Math.max(Math.min(b + dy, stage.y + stage.h), t + min);
	return { x: l, y: t, w: r - l, h: b - t };
}

/**
 * Pixels per CSS px for rendering a `w`×`h` region: the device pixel ratio clamped to 2–3, reduced
 * if the canvas would exceed `maxPixels`.
 */
export function renderScale(dpr: number, w: number, h: number, maxPixels = MAX_CANVAS_PIXELS): number {
	let s = Math.min(MAX_RENDER_SCALE, Math.max(MIN_RENDER_SCALE, Number.isFinite(dpr) ? dpr : 1));
	const area = Math.max(1, w) * Math.max(1, h);
	if (area * s * s > maxPixels) s = Math.sqrt(maxPixels / area);
	return s;
}

/** Source rectangle (integer canvas pixels) of `crop` inside a stage canvas rendered at `scale`. */
export function cropPixels(crop: Rect, stage: Rect, scale: number): { sx: number; sy: number; sw: number; sh: number } {
	const W = Math.round(stage.w * scale);
	const H = Math.round(stage.h * scale);
	const sx = Math.min(Math.max(0, Math.round((crop.x - stage.x) * scale)), Math.max(0, W - 1));
	const sy = Math.min(Math.max(0, Math.round((crop.y - stage.y) * scale)), Math.max(0, H - 1));
	const sw = Math.max(1, Math.min(W - sx, Math.round(crop.w * scale)));
	const sh = Math.max(1, Math.min(H - sy, Math.round(crop.h * scale)));
	return { sx, sy, sw, sh };
}

/** Uniform scale that fits a `w`×`h` stage into the available box (never upscales beyond `max`). */
export function fitScale(w: number, h: number, availW: number, availH: number, max = 1.5): number {
	if (w <= 0 || h <= 0 || availW <= 0 || availH <= 0) return 1;
	return Math.min(max, availW / w, availH / h);
}

/** Characters that break Obsidian file names or wiki links. */
const BAD_NAME = /[\\/:*?"<>|#^[\]]/g;

/** `<note basename> <YYYY-MM-DD HHmmss>.png` (local time). */
export function screenshotName(noteBase: string, d: Date): string {
	const two = (n: number) => String(n).padStart(2, "0");
	const stamp = `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}${two(d.getMinutes())}${two(d.getSeconds())}`;
	const base = noteBase.replace(BAD_NAME, "-").replace(/\s+/g, " ").trim() || "Ink";
	return `${base} ${stamp}.png`;
}

/** "a.png" → "a 2.png" (n ≥ 2) for de-duplicating file names. */
export function withSuffix(name: string, n: number): string {
	if (n < 2) return name;
	const dot = name.lastIndexOf(".");
	return dot > 0 ? `${name.slice(0, dot)} ${n}${name.slice(dot)}` : `${name} ${n}`;
}

/**
 * Text to insert for an embed at the cursor: on its own line — a newline before it when there is
 * text before the cursor on that line, and after it when text follows.
 */
export function embedInsertion(beforeOnLine: string, afterOnLine: string, link: string): string {
	return `${beforeOnLine.trim() ? "\n" : ""}${link}${afterOnLine.trim() ? "\n" : ""}`;
}
