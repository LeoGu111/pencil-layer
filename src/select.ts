/**
 * Stage F — ink selection on the Mac (pure, tested): rectangle selection, click hit-testing and
 * keyboard routing for the desktop Select tool. No DOM / Obsidian imports.
 *
 * Coordinates are overlay space (x from content left, y from document top); stroke points are local
 * to their anchor line, whose overlay top the caller passes (`topOf`) — as in lasso.ts.
 */
import { hitTestStrokeSegment } from "./geometry";
import { selectInLasso } from "./lasso";
import type { Stroke, Tool } from "./model";

type XY = [number, number];

/** A drag shorter than this (px) is a click, not a rectangle / lasso. */
export const CLICK_MOVE = 4;
/** Click hit-test tolerance (px, added to half the stroke width). */
export const CLICK_TOLERANCE = 5;

/** The rectangle spanned by two corners as a closed polygon (clockwise from the top-left). */
export function rectPolygon(a: readonly number[], b: readonly number[]): XY[] {
	const x0 = Math.min(a[0], b[0]);
	const x1 = Math.max(a[0], b[0]);
	const y0 = Math.min(a[1], b[1]);
	const y1 = Math.max(a[1], b[1]);
	return [
		[x0, y0],
		[x1, y0],
		[x1, y1],
		[x0, y1],
	];
}

/**
 * Strokes touching the rectangle a–b (lasso touch rule: any point inside, or any segment crossing
 * it — a long line passing through the rectangle is selected).
 */
export function selectInRect<S extends Pick<Stroke, "points">>(
	strokes: readonly S[],
	a: readonly number[],
	b: readonly number[],
	topOf: (s: S) => number,
): S[] {
	return selectInLasso(strokes, rectPolygon(a, b), topOf);
}

/** Is (x, y) within `tol` px of the stroke's centerline (plus half its width)? */
export function strokeNear(s: Pick<Stroke, "points" | "size" | "tool" | "style">, top: number, x: number, y: number, tol = CLICK_TOLERANCE): boolean {
	return hitTestStrokeSegment(s, x, y, x, y, tol, 0, top);
}

/**
 * The stroke a click selects: the topmost one that `hit` accepts. Pen ink is drawn above
 * highlighter ink, so pens win; within a layer the later (higher in z-order) stroke wins.
 */
export function pickTopmost<S extends { tool: Tool }>(strokes: readonly S[], hit: (s: S) => boolean): S | null {
	for (const layer of ["pen", "highlighter"] as const) {
		for (let i = strokes.length - 1; i >= 0; i--) {
			const s = strokes[i];
			if (s.tool === layer && hit(s)) return s;
		}
	}
	return null;
}

// -------------------------------------------------------------------------------------------------
// Keyboard routing
// -------------------------------------------------------------------------------------------------

export type InkKeyAction = "deselect" | "exit-select" | "delete" | "copy" | "cut" | "paste" | "duplicate";

export interface KeyInput {
	key: string;
	/** Cmd on macOS, Ctrl elsewhere. */
	mod: boolean;
	/** The other of Cmd/Ctrl (e.g. Ctrl on macOS): never ours. */
	otherMod: boolean;
	shift: boolean;
	alt: boolean;
	/** IME composition in progress. */
	composing: boolean;
	repeat: boolean;
}

export interface KeyContext {
	/** The active leaf's ink view has an ink selection. */
	hasSelection: boolean;
	/** The desktop Select tool is active in that leaf. */
	selectActive: boolean;
	/** The plugin-internal ink clipboard holds strokes. */
	clipboardFull: boolean;
	/**
	 * Where focus is: "editor" (the active leaf's editor or nothing focusable — body), or "other"
	 * (an input, a modal, another pane's editor, a sidebar…). Keys aimed elsewhere are never ours.
	 */
	focus: "editor" | "other";
}

/**
 * What a keydown does to the ink — `null` lets Obsidian handle it normally. Only acts while an ink
 * selection exists (paste: Select active and the ink clipboard non-empty); plain typing is never
 * taken: Escape, Delete/Backspace and Mod+C/X/V/D only.
 */
export function routeInkKey(k: KeyInput, ctx: KeyContext): InkKeyAction | null {
	if (k.composing || ctx.focus !== "editor") return null;
	if (k.otherMod || k.alt) return null;
	const key = k.key.length === 1 ? k.key.toLowerCase() : k.key;
	if (!k.mod) {
		if (k.shift) return null;
		if (key === "Escape") {
			if (ctx.hasSelection) return "deselect";
			// A second Escape leaves the Select tool (the key still reaches Obsidian: see caller).
			return ctx.selectActive ? "exit-select" : null;
		}
		if ((key === "Delete" || key === "Backspace") && ctx.hasSelection) return "delete";
		return null;
	}
	if (k.shift) return null;
	if (ctx.hasSelection) {
		if (key === "c") return "copy";
		if (key === "x") return "cut";
		if (key === "d") return k.repeat ? null : "duplicate";
	}
	if (key === "v" && ctx.selectActive && ctx.clipboardFull) return k.repeat ? null : "paste";
	return null;
}

/** Does the action consume the key (preventDefault + stop)? Leaving Select lets Escape through. */
export function consumesKey(action: InkKeyAction): boolean {
	return action !== "exit-select";
}

// -------------------------------------------------------------------------------------------------
// Mouse presses (Stage H: a click on empty space leaves Select for the text cursor)
// -------------------------------------------------------------------------------------------------

/** What is under a Select-tool press (the context menu / toolbar never reach the tool). */
export type DeskTarget = "handle" | "selection" | "stroke" | "empty";

/**
 * What a Select-tool mouse press does:
 * - `pass`: not ours — the press reaches Obsidian (right-click with nothing to paste, other buttons);
 * - `paste-menu`: right-click on empty space with ink on the clipboard;
 * - `scale` / `move`: drag the selection's handle / the selection;
 * - `select-stroke`: select the stroke under the pointer (and drag it if the mouse moves);
 * - `region`: start a rectangle / freeform loop; its release decides (`deskRegionRelease`).
 */
export type DeskPress = "pass" | "paste-menu" | "scale" | "move" | "select-stroke" | "region";

export function deskPress(target: DeskTarget, button: number, clipboardFull: boolean): DeskPress {
	if (button === 2) {
		// The selection keeps its own menu; empty space offers Paste instead of the text menu.
		return target === "empty" && clipboardFull ? "paste-menu" : "pass";
	}
	if (button !== 0) return "pass";
	if (target === "handle") return "scale";
	if (target === "selection") return "move";
	if (target === "stroke") return "select-stroke";
	return "region";
}

/**
 * The release of a `region` press: a drag (≥ CLICK_MOVE px) selects what the rectangle / loop
 * touches; a click deselects, turns Select off and puts the text cursor there (Stage H).
 */
export function deskRegionRelease(maxMove: number): "region" | "exit-to-text" {
	return maxMove < CLICK_MOVE ? "exit-to-text" : "region";
}
