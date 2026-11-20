/**
 * Stage L — page slices for drawing spaces taller than a printed page (pure, tested).
 *
 * Chromium can't break an empty block with an absolutely positioned drawing cleanly, so in print a
 * space taller than one printable page is replaced by page-sized slices: consecutive blocks, each
 * at most one page tall (`break-inside: avoid`), every slice after the first starting a new page
 * (`break-before: page`), each showing its band of the drawing (the ink clipped and offset). The
 * slices partition the drawing, so nothing is lost; a stroke crossing a cut shows in both slices,
 * clipped at the edge. Cuts prefer an empty horizontal band of the drawing near the page end, so
 * strokes aren't sliced through.
 *
 * Where the first slice may end depends on where the space starts on its page. The print layout is
 * not observable from the DOM (it's laid out continuously), so the export models pagination of its
 * own blocks (`Pager`): a page top is known at the start of the content, after a space block that
 * moved to the next page whole (it then starts a page) and at the top of every slice after the
 * first. Errors (text that moves for widows/orphans) only cost blank space: a first slice that
 * doesn't fit moves to the next page whole and the next slice still starts its own page.
 */

/** A vertical range of a drawing (px from the space top). */
export interface Band {
	from: number;
	to: number;
}

/** Vertical extents of strokes, widened by `pad` (a cut that close to a stroke counts as crossing it). */
export function padExtents(extents: readonly Band[], pad = 2): Band[] {
	return extents.filter((e) => Number.isFinite(e.from) && Number.isFinite(e.to) && e.to >= e.from).map((e) => ({ from: e.from - pad, to: e.to + pad }));
}

/** How many strokes a cut at y goes through. */
export function crossings(y: number, extents: readonly Band[]): number {
	let n = 0;
	for (const e of extents) if (e.from < y && y < e.to) n++;
	return n;
}

/**
 * Where to end a slice that starts at `start` and may reach `limit`: the cut in
 * [limit − window, limit] (and at least `minSlice` below `start`) that goes through the fewest
 * strokes, the lowest of equals. Candidates are `limit` and the stroke edges in the window (the
 * count only changes there). A stroke taller than the window (a frame, a long vertical line) is cut
 * wherever, so it doesn't change the choice: the cut still lands between rows of writing.
 */
export function chooseCut(start: number, limit: number, extents: readonly Band[], window: number, minSlice = 1): number {
	const lo = Math.max(limit - window, start + minSlice);
	if (lo >= limit) return limit;
	let best = limit;
	let bestN = crossings(limit, extents);
	if (bestN === 0) return limit;
	const cands: number[] = [];
	for (const e of extents) {
		if (e.from >= lo && e.from < limit) cands.push(e.from);
		if (e.to >= lo && e.to < limit) cands.push(e.to);
	}
	cands.sort((x, y) => y - x);
	for (const c of cands) {
		const n = crossings(c, extents);
		if (n < bestN) {
			best = c;
			bestN = n;
			if (n === 0) break;
		}
	}
	return best;
}

export interface SlicePlan {
	/** The slices, top to bottom, partitioning [0, height]. */
	slices: Band[];
	/** The first slice starts a new page (too little room left on the current one). */
	breakFirst: boolean;
}

export interface SliceOptions {
	/** Printable page height (layout px). */
	pageHeight: number;
	/** Room left on the page where the drawing starts (layout px). */
	firstRoom: number;
	/** How far above a page end a cut may move to cross fewer strokes (default ¼ page). */
	window?: number;
	/** Less room than this on the first page: start the drawing on a new page (default max(⅕ page, 96)). */
	minFirst?: number;
}

/** Slices of a drawing `height` px tall with strokes of vertical `extents` (padded; see the module comment). */
export function planSlices(height: number, extents: readonly Band[], o: SliceOptions): SlicePlan {
	const P = Math.max(1, o.pageHeight);
	const window = o.window ?? P / 4;
	const minFirst = o.minFirst ?? Math.max(P / 5, 96);
	const breakFirst = o.firstRoom < minFirst;
	let room = breakFirst ? P : Math.min(o.firstRoom, P);
	const slices: Band[] = [];
	let start = 0;
	const minSlice = Math.min(P / 4, 64);
	while (height - start > room + 0.5) {
		const c = chooseCut(start, start + room, extents, window, minSlice);
		slices.push({ from: start, to: c });
		start = c;
		room = P;
	}
	slices.push({ from: start, to: height });
	return { slices, breakFirst };
}

/** Bands of `slice` crossing it: is a stroke with vertical extent `e` visible in the slice? */
export function inSlice(e: Band, slice: Band): boolean {
	return e.to > slice.from && e.from < slice.to;
}

/** A model of the export's pagination of our own blocks (see the module comment). */
export class Pager {
	/** Layout y (px, continuous layout) known to be the top of a page. */
	private base: number;

	constructor(
		readonly pageHeight: number,
		top = 0,
	) {
		this.base = top;
	}

	/** Offset of layout y on its page. */
	phase(y: number): number {
		const P = this.pageHeight;
		const d = y - this.base;
		return ((d % P) + P) % P;
	}

	/** Room left on the page at layout y. */
	room(y: number): number {
		return this.pageHeight - this.phase(y);
	}

	/** A block that never breaks (`break-inside: avoid`) at y, h tall: moves to the next page if it doesn't fit. */
	avoid(y: number, h: number): void {
		if (h <= this.pageHeight && this.phase(y) > 0.5 && this.phase(y) + h > this.pageHeight + 0.5) this.base = y;
	}

	/** Layout y starts a new page (a forced break before it). */
	pageAt(y: number): void {
		this.base = y;
	}
}
