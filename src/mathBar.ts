/**
 * Pure layout & document-insertion planners for the floating Formula bar (`.pl-math-bar`).
 *
 * Keeps DOM geometry and insertion decisions testable without Obsidian/CodeMirror runtime state:
 * - `planMathBarTop`: places `.pl-math-bar` below `.view-header` and clear of `.inline-title` (and
 *   clear of the active formula strokes when possible).
 * - `planMathInsertion`: inserts converted LaTeX cleanly on a new line when written below text or
 *   inside a drawing space, or at the active cursor when placed on/near the target line.
 */
import type { BBox } from "./geometry";
import { TAP_MAX_EXTRA_LINES } from "./tapToType";

export interface VerticalBand {
	top: number;
	bottom: number;
}

export interface MathBarLayoutInput {
	leafHeight: number;
	barHeight: number;
	/** Bottom of `:scope > .view-header` relative to `.workspace-leaf-content` (0 when absent). */
	headerBottom: number;
	/** Visible `.inline-title` band relative to `.workspace-leaf-content`, or null when hidden/absent. */
	inlineTitle: VerticalBand | null;
	/** Active handwritten formula band relative to `.workspace-leaf-content`, if known. */
	formulaRect?: VerticalBand | null;
	gap?: number;
	margin?: number;
}

/**
 * Compute `.pl-math-bar` `top` (px inside `.workspace-leaf-content`) so it clears `.view-header`
 * and never overlaps a visible `.inline-title`.
 */
export function planMathBarTop(input: MathBarLayoutInput): number {
	const gap = input.gap ?? 8;
	const margin = input.margin ?? 12;
	const barH = Math.max(0, input.barHeight);
	const minTop = input.headerBottom > 0 ? input.headerBottom + gap : margin;
	const maxTop = input.leafHeight > 0 ? Math.max(minTop, input.leafHeight - barH - margin) : Infinity;

	let top = minTop;
	const title = input.inlineTitle;
	if (title && title.bottom > input.headerBottom && (input.leafHeight <= 0 || title.top < input.leafHeight)) {
		const fitsAboveTitle = minTop + barH + gap <= title.top;
		if (!fitsAboveTitle) {
			top = Math.max(top, Math.ceil(title.bottom) + gap);
		}
	}

	const formula = input.formulaRect;
	if (formula && top + barH + gap > formula.top && top < formula.bottom + gap) {
		const belowFormula = Math.ceil(formula.bottom) + gap;
		if (belowFormula <= maxTop) {
			top = belowFormula;
		}
	}

	return Math.min(top, maxTop);
}

export interface MathInsertionLine {
	number: number;
	from: number;
	to: number;
	text: string;
	/** Text-only top in overlay coordinates (excludes trailing SpaceWidgets). */
	top: number;
	/** Text-only bottom in overlay coordinates (excludes trailing SpaceWidgets). */
	bottom: number;
}

export interface MathInsertionInput {
	formatted: string;
	docLength: number;
	lineHeight: number;
	box: BBox;
	lastLine: MathInsertionLine;
	/** Text line at `midY` (or `lastLine` when `midY` is below `lastLine`). */
	lineAtY: MathInsertionLine;
	cursor: {
		head: number;
		line: MathInsertionLine;
		hasFocus: boolean;
	};
	/** True when the formula was written inside a `SpaceWidget` drawing area. */
	inSpace?: boolean;
}

export interface MathInsertionPlan {
	from: number;
	insert: string;
	anchor: number;
}

function inlineBlockAround(before: string, after: string, formatted: string, isBlock: boolean): { leading: string; trailing: string } {
	if (isBlock) {
		return {
			leading: before.trim().length > 0 ? "\n" : "",
			trailing: after.trim().length > 0 ? "\n" : "",
		};
	}
	return {
		leading: before.length > 0 && !/\s$/.test(before) ? " " : "",
		trailing: after.length > 0 && !/^\s/.test(after) ? " " : "",
	};
}

/**
 * Plan where and how to insert converted LaTeX (`$...$` or `$$...$$`) into the note.
 *
 * Priority:
 * 1. Explicit cursor inside a line (when focused or close to the formula), or on an empty line
 *    close to the formula's Y position, or on the target line when the formula aligns vertically
 *    with that line.
 * 2. Below the last text line (or inside an end `SpaceWidget`): always starts on a new line
 *    rather than appending inline to the end of the preceding paragraph.
 * 3. Below an intermediate non-empty line (e.g. paragraph spacing or an anchored `SpaceWidget`):
 *    starts on a new line after that line instead of appending `" $...$"` inline.
 * 4. Vertically aligned with `lineAtY`: inline after text (with space) or on a new line for `$$`.
 */
export function planMathInsertion(input: MathInsertionInput): MathInsertionPlan {
	const lineH = input.lineHeight > 0 ? input.lineHeight : 24;
	const midY = (input.box.minY + input.box.maxY) / 2;
	const isBlock = input.formatted.startsWith("$$");

	const cursorLine = input.cursor.line;
	const cursorMidY = (cursorLine.top + cursorLine.bottom) / 2;
	const cursorNearFormula = Math.abs(midY - cursorMidY) <= lineH * 1.5;
	const cursorStrictMidLine = input.cursor.head > cursorLine.from && input.cursor.head < cursorLine.to;
	const cursorEmptyLineNear = cursorLine.text.trim().length === 0 && cursorNearFormula;
	const cursorOnAlignedLine =
		input.cursor.hasFocus &&
		cursorLine.number === input.lineAtY.number &&
		midY <= cursorLine.bottom &&
		input.box.minY < cursorLine.bottom;

	if ((cursorStrictMidLine && (input.cursor.hasFocus || cursorNearFormula)) || cursorEmptyLineNear || cursorOnAlignedLine) {
		const offset = Math.max(0, Math.min(cursorLine.text.length, input.cursor.head - cursorLine.from));
		const before = cursorLine.text.slice(0, offset);
		const after = cursorLine.text.slice(offset);
		const { leading, trailing } = inlineBlockAround(before, after, input.formatted, isBlock);
		const insert = `${leading}${input.formatted}${trailing}`;
		return {
			from: input.cursor.head,
			insert,
			anchor: input.cursor.head + leading.length + input.formatted.length,
		};
	}

	const last = input.lastLine;
	const belowLastLine =
		midY > last.bottom + lineH * 0.4 ||
		(last.text.trim().length > 0 && (midY > last.bottom || input.box.minY >= last.bottom));

	if (belowLastLine) {
		const rawNewlines = Math.round((midY - last.bottom) / lineH);
		const minNewlines = midY > last.bottom + lineH * 0.4 || last.text.trim().length > 0 ? 1 : 0;
		const prefixNewlines = input.inSpace
			? minNewlines
			: Math.min(TAP_MAX_EXTRA_LINES, Math.max(minNewlines, rawNewlines));
		const insert = `${"\n".repeat(prefixNewlines)}${input.formatted}`;
		return {
			from: input.docLength,
			insert,
			anchor: input.docLength + insert.length,
		};
	}

	const line = input.lineAtY;
	const drawnBelowLineText = line.text.trim().length > 0 && (midY > line.bottom || input.box.minY >= line.bottom - 2);
	const leading =
		drawnBelowLineText
			? "\n"
			: line.text.trim().length > 0 && isBlock
				? "\n"
				: line.text.length > 0
					? " "
					: "";
	const insert = `${leading}${input.formatted}`;
	return {
		from: line.to,
		insert,
		anchor: line.to + insert.length,
	};
}
