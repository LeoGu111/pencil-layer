/**
 * Toolbar grip gestures (M2 Stage M). Pure, tested.
 *
 * One press on the 6-dot grip is exactly one of:
 * - **drag**: it moved ≥ `GRIP_DRAG_MOVE` px before a long-press fired → moves the toolbar (as before);
 * - **long-press**: touch or pen held ≥ `GRIP_LONG_PRESS_MS` without moving → snap-position menu.
 *   After it fires, the rest of the press (movement, release) is ignored: no drag, no collapse toggle;
 * - **tap**: released before either → toggles collapsed / expanded.
 * Mouse presses never long-press (the mouse uses right-click / `contextmenu` for the menu).
 */

/** A grip press that moves less than this (px) is not a drag. */
export const GRIP_DRAG_MOVE = 6;
/** Touch / pen hold (ms) on the grip that opens the snap-position menu. */
export const GRIP_LONG_PRESS_MS = 500;

export type GripPhase = "pending" | "drag" | "longpress";
export type GripResult = "tap" | "drag" | "longpress";

export class GripPress {
	phase: GripPhase = "pending";

	constructor(
		readonly pointerType: string,
		readonly x: number,
		readonly y: number,
		readonly t: number,
	) {}

	/** Can this press become a long-press? */
	get canLongPress(): boolean {
		return this.pointerType !== "mouse";
	}

	/** Pointer moved to (x, y): true ⇒ the drag starts now. */
	move(x: number, y: number): boolean {
		if (this.phase !== "pending") return false;
		if (Math.hypot(x - this.x, y - this.y) < GRIP_DRAG_MOVE) return false;
		this.phase = "drag";
		return true;
	}

	/** Long-press timer check at `now`: true ⇒ the long-press fires now (once). */
	hold(now: number): boolean {
		if (this.phase !== "pending" || !this.canLongPress || now - this.t < GRIP_LONG_PRESS_MS) return false;
		this.phase = "longpress";
		return true;
	}

	/** Released at (x, y) at `now`: what the press was. */
	up(x: number, y: number, now: number): GripResult {
		if (this.phase === "pending") {
			// The last stretch may have had no pointermove; a timer may also be late.
			if (this.move(x, y)) return "drag";
			if (this.hold(now)) return "longpress";
			return "tap";
		}
		return this.phase;
	}
}
