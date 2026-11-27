/**
 * Pure placement planner for "tap anywhere to type" in an editor with freehand ink overlays.
 *
 * Obsidian / CodeMirror normally clamps clicks below the last line to `doc.length` (line 1 on a
 * blank or ink-only note — the top of the page) and clicks past the end of a short line to `line.to`.
 * When the user taps in open space with a finger (or mouse when not drawing), this planner inserts
 * just enough newlines (and non-breaking spaces past an explicit horizontal indent threshold) so
 * the cursor lands right where the user tapped.
 */

export interface TapLineInfo {
	/** 0-based overlay Y of the top of the tapped/last line. */
	top: number;
	/** 0-based overlay Y of the bottom of the tapped/last line. */
	bottom: number;
	/** Document offset at the end of the target line (`doc.length` when below the last line). */
	lineTo: number;
	/** Overlay X coordinate of the end of text on the target line (`0` for an empty line). */
	lineEndX: number;
}

export interface TapToTypeInput {
	docLength: number;
	/** Line height in overlay px (> 0). */
	lineHeight: number;
	/** Approximate monospace/body character width in overlay px (> 0). */
	charWidth: number;
	/** Overlay-space X of the tap (relative to the text left margin). */
	tapX: number;
	/** Overlay-space Y of the tap (relative to `documentTop`). */
	tapY: number;
	/** Geometry of the last document line (`doc.length`). */
	lastLine: TapLineInfo;
	/** Geometry of the existing line at `tapY`, when `tapY` is not below `lastLine`. */
	lineAtTap?: TapLineInfo;
}

export interface TapToTypePlan {
	/** Document offset where text should be inserted (if any). */
	from: number;
	/** Text to insert (`\n` / `\u00A0` padding), or `""` when no edit is needed. */
	insert: string;
	/** Resulting caret document offset. */
	anchor: number;
}

/** Past this many px horizontally, pad with non-breaking spaces instead of staying at column 0. */
export const TAP_HORIZONTAL_THRESHOLD_PX = 48;
export const TAP_MAX_EXTRA_LINES = 250;
export const TAP_MAX_EXTRA_COLS = 80;

/**
 * Use U+00A0 (NBSP) rather than ASCII space so CommonMark never turns padded lines into `<pre><code>`
 * indented code blocks while keeping leading position visible in Live Preview & Reading view.
 */
const NBSP = "\u00A0";

export interface TapPaddingRange {
	from: number;
	to: number;
	anchor: number;
}

const PURE_PADDING_RE = /^[\n\u00A0]+$/;

/** True when `slice` is solely tap-to-type padding (`\n` / NBSP) and nothing was typed after it on the line. */
export function isUnusedTapPadding(slice: string, restOfLine = ""): boolean {
	return slice.length > 0 && PURE_PADDING_RE.test(slice) && restOfLine.length === 0;
}

export function isPureTapPadding(slice: string): boolean {
	return slice.length > 0 && PURE_PADDING_RE.test(slice);
}

export function planTapToType(input: TapToTypeInput): TapToTypePlan | null {
	const lineH = input.lineHeight > 0 ? input.lineHeight : 24;
	const charW = input.charWidth > 0 ? input.charWidth : 8.5;

	// Case 1: Tapped cleanly below the last line of the note.
	if (input.tapY > input.lastLine.bottom + lineH * 0.4) {
		const extraLines = Math.min(
			TAP_MAX_EXTRA_LINES,
			Math.max(1, Math.round((input.tapY - input.lastLine.bottom) / lineH)),
		);
		const cols =
			input.tapX > TAP_HORIZONTAL_THRESHOLD_PX
				? Math.min(TAP_MAX_EXTRA_COLS, Math.max(0, Math.round(input.tapX / charW)))
				: 0;
		const insert = "\n".repeat(extraLines) + NBSP.repeat(cols);
		return {
			from: input.docLength,
			insert,
			anchor: input.docLength + insert.length,
		};
	}

	// Case 2: Tapped vertically on an existing line, well to the right of its current end.
	const line = input.lineAtTap;
	if (line && input.tapX > line.lineEndX + TAP_HORIZONTAL_THRESHOLD_PX) {
		const cols = Math.min(TAP_MAX_EXTRA_COLS, Math.max(1, Math.round((input.tapX - line.lineEndX) / charW)));
		const insert = NBSP.repeat(cols);
		return {
			from: line.lineTo,
			insert,
			anchor: line.lineTo + insert.length,
		};
	}

	return null;
}

/** Compute the caret insertion offset for programmatic inserts (e.g. converted LaTeX) at an overlay box. */
export function insertionPosForY(tapY: number, lastLine: TapLineInfo, lineHeight: number, lineToAtY: number, docLength: number): {
	prefixNewlines: number;
	from: number;
} {
	const lineH = lineHeight > 0 ? lineHeight : 24;
	if (tapY > lastLine.bottom + lineH * 0.4) {
		const prefixNewlines = Math.min(
			TAP_MAX_EXTRA_LINES,
			Math.max(1, Math.round((tapY - lastLine.bottom) / lineH)),
		);
		return { prefixNewlines, from: docLength };
	}
	return { prefixNewlines: 0, from: lineToAtY };
}
