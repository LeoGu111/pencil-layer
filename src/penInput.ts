/**
 * Pen hardware details that differ between platforms (pure, tested in tests/penInput.test.ts).
 *
 * - **Eraser end** (Surface Pen, Wacom and other Windows Ink / Android pens): Pointer Events report
 *   the eraser end as `pointerType: "pen"` with `button === 5` on pointerdown and bit 32 set in
 *   `buttons` while it touches. It erases while held, whatever tool is selected. (Apple Pencil has
 *   no eraser end; its double tap is handled separately.)
 * - **Barrel button** (`buttons & 2`): left alone — the pen still draws with the current tool; the
 *   right-click/context menu Windows derives from it is swallowed by the ink layer during a stroke.
 */

/** `PointerEvent.button` of the pen's eraser end. */
export const ERASER_BUTTON = 5;
/** `PointerEvent.buttons` bit of the pen's eraser end. */
export const ERASER_BUTTONS = 32;

export interface PenPointer {
	pointerType: string;
	button: number;
	buttons: number;
}

/** Is this the eraser end of a pen touching the screen? */
export function isPenEraser(e: PenPointer): boolean {
	return e.pointerType === "pen" && (e.button === ERASER_BUTTON || (e.buttons & ERASER_BUTTONS) !== 0);
}

/** The tool a pen press uses: the eraser end always erases, the tip uses the selected tool. */
export function toolForPress<T extends string>(e: PenPointer, selected: T): T | "eraser" {
	return isPenEraser(e) ? "eraser" : selected;
}
