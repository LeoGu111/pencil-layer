/**
 * Floating toolbar placement (M2 Stage A2). Pure, tested.
 *
 * The position is stored per device as fractions of the free range inside the leaf's content area
 * (`x` = left / (areaW − barW − 2·margin), likewise `y`), so it survives leaf resizes and the bar
 * changing size (expanded ↔ collapsed) — e.g. x = 0.5 stays centered. `null` = bottom-center.
 */
import type { ToolbarEdge, ToolbarPos } from "./settings";

export interface Size {
	w: number;
	h: number;
}

export interface Placement {
	left: number;
	top: number;
}

/** Gap kept between the bar and the edges of the area (px). */
export const FLOAT_MARGIN = 12;
/** Default distance from the bottom edge (px). */
export const FLOAT_BOTTOM = 20;

function clamp(v: number, lo: number, hi: number): number {
	return Math.min(Math.max(v, lo), Math.max(lo, hi));
}

/** Free range along one axis (≥ 0). */
function range(area: number, bar: number, margin: number): number {
	return Math.max(0, area - bar - 2 * margin);
}

/** Bar position (relative to the area's top-left), clamped inside the area. */
export function placeFloating(area: Size, bar: Size, pos: ToolbarPos | null, margin = FLOAT_MARGIN): Placement {
	const rx = range(area.w, bar.w, margin);
	const ry = range(area.h, bar.h, margin);
	if (!pos) {
		const top = area.h - bar.h - FLOAT_BOTTOM;
		return { left: margin + rx / 2, top: clamp(top, margin, margin + ry) };
	}
	return { left: margin + clamp(pos.x, 0, 1) * rx, top: margin + clamp(pos.y, 0, 1) * ry };
}

/** Stored position for a bar dragged to `left`/`top` (clamped into the area). */
export function toFloatPos(area: Size, bar: Size, left: number, top: number, margin = FLOAT_MARGIN): ToolbarPos {
	const rx = range(area.w, bar.w, margin);
	const ry = range(area.h, bar.h, margin);
	return {
		x: rx > 0 ? clamp((left - margin) / rx, 0, 1) : 0.5,
		y: ry > 0 ? clamp((top - margin) / ry, 0, 1) : 1,
	};
}

// -------------------------------------------------------------------------------------------------
// Orientation (Stage A3, Apple Markup style) and popover placement
// -------------------------------------------------------------------------------------------------

export type Orientation = "horizontal" | "vertical";
export type PopoverSide = "above" | "below" | "left" | "right";

/** Horizontal when docked at the top or bottom, vertical at the left or right. */
export function orientationOf(edge: ToolbarEdge): Orientation {
	return edge === "left" || edge === "right" ? "vertical" : "horizontal";
}

/** Hysteresis (px) before the docked edge changes while dragging (no flicker near a diagonal). */
export const EDGE_HYSTERESIS = 24;

/**
 * The area edge nearest to (x, y) (the drag pointer, area coordinates). While dragging, `current`
 * is kept unless another edge is closer by more than `hyst` px.
 */
export function nearestEdge(area: Size, x: number, y: number, current: ToolbarEdge | null, hyst = EDGE_HYSTERESIS): ToolbarEdge {
	const d: Record<ToolbarEdge, number> = { top: y, bottom: area.h - y, left: x, right: area.w - x };
	let best: ToolbarEdge = "bottom";
	for (const e of ["bottom", "top", "left", "right"] as const) if (d[e] < d[best]) best = e;
	if (current && current !== best && d[current] - d[best] <= hyst) return current;
	return best;
}

/** Rectangle relative to the area's top-left. */
export interface Rect {
	left: number;
	top: number;
	w: number;
	h: number;
}

/**
 * Side of the bar a popover opens on: toward the side of the area with more room — above/below for
 * a horizontal bar, left/right for a vertical one.
 */
export function popoverSide(orientation: Orientation, bar: Rect, area: Size): PopoverSide {
	if (orientation === "horizontal") return bar.top >= area.h - (bar.top + bar.h) ? "above" : "below";
	return bar.left >= area.w - (bar.left + bar.w) ? "left" : "right";
}

/**
 * Popover position (area coordinates): next to the bar on `side`, centered on the anchor button
 * along the bar, clamped inside the area (`margin` from its edges).
 */
export function placePopover(side: PopoverSide, bar: Rect, anchor: Rect, pop: Size, area: Size, gap = 8, margin = 8): Placement {
	const clampX = (v: number) => clamp(v, margin, area.w - margin - pop.w);
	const clampY = (v: number) => clamp(v, margin, area.h - margin - pop.h);
	switch (side) {
		case "above":
			return { left: clampX(anchor.left + anchor.w / 2 - pop.w / 2), top: clampY(bar.top - gap - pop.h) };
		case "below":
			return { left: clampX(anchor.left + anchor.w / 2 - pop.w / 2), top: clampY(bar.top + bar.h + gap) };
		case "left":
			return { left: clampX(bar.left - gap - pop.w), top: clampY(anchor.top + anchor.h / 2 - pop.h / 2) };
		case "right":
			return { left: clampX(bar.left + bar.w + gap), top: clampY(anchor.top + anchor.h / 2 - pop.h / 2) };
	}
}

// -------------------------------------------------------------------------------------------------
// Snap presets (Stage M): right-click / long-press the grip
// -------------------------------------------------------------------------------------------------

export type SnapPreset = "top" | "bottom" | "left" | "right" | "top-left" | "top-right" | "bottom-left" | "bottom-right";

export const SNAP_PRESETS: { key: SnapPreset; label: string; icon: string }[] = [
	{ key: "top", label: "Top center", icon: "panel-top" },
	{ key: "bottom", label: "Bottom center", icon: "panel-bottom" },
	{ key: "left", label: "Left middle", icon: "panel-left" },
	{ key: "right", label: "Right middle", icon: "panel-right" },
	{ key: "top-left", label: "Top left", icon: "arrow-up-left" },
	{ key: "top-right", label: "Top right", icon: "arrow-up-right" },
	{ key: "bottom-left", label: "Bottom left", icon: "arrow-down-left" },
	{ key: "bottom-right", label: "Bottom right", icon: "arrow-down-right" },
];

/**
 * Stored position + docked edge for a preset. Top/bottom → horizontal, left/right → vertical;
 * corners dock to their top/bottom edge (horizontal), as `nearestEdge` does for a corner point
 * (ties go to bottom/top). Bottom center is `null`, the default position (FLOAT_BOTTOM offset).
 */
export function snapPreset(key: SnapPreset): { pos: ToolbarPos | null; edge: ToolbarEdge } {
	switch (key) {
		case "top":
			return { pos: { x: 0.5, y: 0 }, edge: "top" };
		case "bottom":
			return { pos: null, edge: "bottom" };
		case "left":
			return { pos: { x: 0, y: 0.5 }, edge: "left" };
		case "right":
			return { pos: { x: 1, y: 0.5 }, edge: "right" };
		case "top-left":
			return { pos: { x: 0, y: 0 }, edge: "top" };
		case "top-right":
			return { pos: { x: 1, y: 0 }, edge: "top" };
		case "bottom-left":
			return { pos: { x: 0, y: 1 }, edge: "bottom" };
		case "bottom-right":
			return { pos: { x: 1, y: 1 }, edge: "bottom" };
	}
}

/** The preset the toolbar currently sits at, if any (the menu's check mark). */
export function currentSnapPreset(pos: ToolbarPos | null, edge: ToolbarEdge, eps = 0.01): SnapPreset | null {
	for (const { key } of SNAP_PRESETS) {
		const p = snapPreset(key);
		if (p.edge !== edge) continue;
		if (!p.pos) {
			if (!pos) return key;
		} else if (pos && Math.abs(pos.x - p.pos.x) <= eps && Math.abs(pos.y - p.pos.y) <= eps) {
			return key;
		}
	}
	return null;
}
