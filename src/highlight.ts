/**
 * Straight-line highlighter (M2 Stage E option). Pure, tested.
 *
 * With "Straight line" on, a highlighter stroke is the segment from where the pen went down to
 * where it is now (live) / was lifted, snapped to horizontal when within a few degrees (the usual
 * case: highlighting a line of text). Stored like a shape: densified points at constant pressure.
 */
import type { Point } from "./model";

/** Snap to horizontal when the line is within this many degrees of it. */
export const STRAIGHT_SNAP_DEG = 6;
/** Point spacing of the stored line (px). */
export const STRAIGHT_SPACING = 3;

/** Points of a straight highlighter stroke from `start` to `end`. */
export function straightLine(start: readonly number[], end: readonly number[], snapDeg = STRAIGHT_SNAP_DEG): Point[] {
	const [x0, y0] = start;
	let [x1, y1] = end;
	const dx = x1 - x0;
	const dy = y1 - y0;
	const ang = Math.abs((Math.atan2(dy, dx) * 180) / Math.PI);
	if (Math.min(ang, 180 - ang) <= snapDeg) y1 = y0;
	const len = Math.hypot(x1 - x0, y1 - y0);
	const n = Math.max(1, Math.ceil(len / STRAIGHT_SPACING));
	const out: Point[] = [];
	for (let i = 0; i <= n; i++) {
		const t = i / n;
		out.push([x0 + (x1 - x0) * t, y0 + (y1 - y0) * t, 0.5]);
	}
	return out;
}
