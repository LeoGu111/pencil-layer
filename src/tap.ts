/**
 * Buttons that work with the Apple Pencil (Stage A3 item 6).
 *
 * Cause of "the Pencil only moves the hover highlight": every toolbar / popover / lasso-menu button
 * acted on `click` only — nothing handled the pen's own pointer events. `click` is synthesized by
 * WKWebView's tap gesture recognizer, and a Pencil (stylus) tap doesn't reliably get one: the
 * toolbar floats over the contenteditable editor, where iPadOS' Scribble / WebKit's stylus handling
 * claims stylus touches (the ink layer avoids that inside the scroller by cancelling stylus
 * touchstarts; the toolbar and menus didn't), and the bar also `preventDefault`s every
 * pointerdown. So the Pencil produced pointer events (hover, down, up) but never the `click` the
 * buttons waited for; fingers still got theirs.
 *
 * Fix (independent of which WebKit path eats the click): pen taps activate on `pointerup` (down +
 * up on the same element, little movement), and stylus touchstarts on our UI are cancelled so
 * Scribble never sees them. Touch and mouse keep using `click` (unchanged; their clicks carry the
 * user activation Safari needs for the clipboard). A `click` that follows a pen activation is
 * swallowed, so nothing fires twice (e.g. a desktop pen tablet that does get clicks).
 */

/** A pen press that moves farther than this (px) is not a tap. */
export const UI_TAP_MOVE = 12;
/** A click arriving this long (ms) after a pointerup activation belongs to the same press. */
export const CLICK_DEDUP_MS = 700;

/** Per-element tap state (pure: no DOM). */
export class TapGate {
	private press: { id: number; x: number; y: number; max: number } | null = null;
	private firedAt = -Infinity;

	/** Should a press of this pointer type activate on pointerup (rather than on click)? */
	static firesOnUp(pointerType: string): boolean {
		return pointerType === "pen";
	}

	down(pointerType: string, id: number, x: number, y: number): void {
		this.press = TapGate.firesOnUp(pointerType) ? { id, x, y, max: 0 } : null;
	}

	move(id: number, x: number, y: number): void {
		const p = this.press;
		if (p && p.id === id) p.max = Math.max(p.max, Math.hypot(x - p.x, y - p.y));
	}

	/** Pointer released at (x, y) at time `now`: true ⇒ activate. */
	up(id: number, x: number, y: number, now: number): boolean {
		const p = this.press;
		if (!p || p.id !== id) return false;
		this.press = null;
		if (Math.max(p.max, Math.hypot(x - p.x, y - p.y)) > UI_TAP_MOVE) return false;
		this.firedAt = now;
		return true;
	}

	cancel(id: number): void {
		if (this.press?.id === id) this.press = null;
	}

	/** A click at `now`: true ⇒ activate (it isn't the tail of a pen activation). */
	click(now: number): boolean {
		return now - this.firedAt > CLICK_DEDUP_MS;
	}
}

/**
 * Make `el` a button for pen, finger and mouse: `run` fires once per tap. Callers still
 * `preventDefault` pointerdown/mousedown themselves (focus).
 */
export function onTap(el: HTMLElement, run: () => void): void {
	const gate = new TapGate();
	el.addEventListener("pointerdown", (e) => gate.down(e.pointerType, e.pointerId, e.clientX, e.clientY));
	el.addEventListener("pointermove", (e) => gate.move(e.pointerId, e.clientX, e.clientY));
	el.addEventListener("pointercancel", (e) => gate.cancel(e.pointerId));
	el.addEventListener("pointerup", (e) => {
		if (!gate.up(e.pointerId, e.clientX, e.clientY, performance.now())) return;
		e.preventDefault();
		e.stopPropagation();
		run();
	});
	el.addEventListener("click", (e) => {
		e.preventDefault();
		e.stopPropagation();
		if (gate.click(performance.now())) run();
	});
}

/**
 * Cancel stylus touchstarts on toolbar UI: keeps iPadOS Scribble and text selection from claiming
 * Pencil presses on our buttons (the buttons then activate via `onTap`'s pointerup path).
 */
export function blockStylusTouch(el: HTMLElement): void {
	el.addEventListener(
		"touchstart",
		(e) => {
			for (let i = 0; i < e.changedTouches.length; i++) {
				if ((e.changedTouches[i] as Touch & { touchType?: string }).touchType === "stylus") {
					if (e.cancelable) e.preventDefault();
					return;
				}
			}
		},
		{ passive: false },
	);
}
