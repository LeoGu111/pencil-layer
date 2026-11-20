/**
 * Placement of the lasso context menu (pure): above the target if there is room in the visible
 * area, else below it, else pinned inside the visible area (over the target). Horizontally
 * centered on the target and clamped into the visible area.
 *
 * All boxes share one coordinate space (the menu's positioning container).
 */
import type { BBox } from "./geometry";

export type MenuSide = "above" | "below" | "over";

export interface MenuPlacement {
	left: number;
	top: number;
	side: MenuSide;
}

export function placeMenu(
	target: BBox,
	menu: { width: number; height: number },
	visible: BBox,
	gap = 10,
	margin = 8,
): MenuPlacement {
	const w = menu.width;
	const h = menu.height;
	const minLeft = visible.minX + margin;
	const maxLeft = visible.maxX - margin - w;
	let left = (target.minX + target.maxX) / 2 - w / 2;
	left = maxLeft < minLeft ? minLeft : Math.min(Math.max(left, minLeft), maxLeft);

	const minTop = visible.minY + margin;
	const maxTop = visible.maxY - margin - h;
	const above = target.minY - gap - h;
	if (above >= minTop && above <= maxTop) return { left, top: above, side: "above" };
	const below = target.maxY + gap;
	if (below >= minTop && below <= maxTop) return { left, top: below, side: "below" };
	// No room on either side (selection taller than the screen, or scrolled half out of view):
	// pin it to the visible edge nearest to the target's top.
	const top = maxTop < minTop ? minTop : Math.min(Math.max(target.minY + margin, minTop), maxTop);
	return { left, top, side: "over" };
}

/** The context menu: actions for the selection (optionally its color submenu), or Paste at a point. */
export type MenuState = { kind: "selection"; colors: boolean } | { kind: "paste"; at: [number, number] };

/**
 * The menu that should be shown for the current selection state (Stage A2: the selection menu is
 * always shown while a selection exists — dragging/resizing only hides it while the pointer is
 * down, which the renderer handles). Returns `current` itself when nothing changes.
 * - selection exists: keep a selection menu (incl. an open color submenu), otherwise open one;
 * - no selection: a selection menu goes away, a Paste menu stays.
 */
export function menuForSelection(current: MenuState | null, hasSelection: boolean): MenuState | null {
	if (hasSelection) return current?.kind === "selection" ? current : { kind: "selection", colors: false };
	return current?.kind === "selection" ? null : current;
}
