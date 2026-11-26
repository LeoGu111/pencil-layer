/**
 * Stage C — highlighter snaps to typed text: the CodeMirror/DOM side. One `TextHighlights` per
 * ink view; inkView.ts calls it from a few clearly marked hook points ("[Stage C]").
 *
 * - Snapping (`snapStroke`, `livePath`): `view.posAtCoords` at the stroke's ends → `snapRange`
 *   (word boundaries) → measured rows; the decision rule is `classifyHighlight` plus a check that
 *   the stroke really lies over the measured text.
 * - Measuring (`measure`, from the render's measure READ phase): for each text highlight in the
 *   viewport, DOM `Range.getClientRects()` per document line (only the visible part), merged into
 *   one rect per visual line (`mergeRows`). Rows are in overlay space and recomputed on every
 *   render, so highlights reflow with the text.
 * - Rendering (`applyPath`): one `<path>` of rounded rects per highlight in the highlighter group
 *   (beneath pen ink, same color/opacity/blend as freehand highlighter strokes), expressed
 *   relative to the stroke's line top so the view's `translate(0 top)` (and lasso drag
 *   transforms) apply unchanged.
 * - Eraser / lasso hit-test against the rows; lasso move/scale/duplicate/copy and screenshots use
 *   `asFreehand` (one highlighter capsule per row); recolor keeps the text highlight.
 */
import type { EditorView } from "@codemirror/view";
import type { Text } from "@codemirror/state";
import { Point, Stroke, newId, resolveAnchor } from "./model";
import type { BBox } from "./geometry";
import {
	Row,
	TEXT_SNAP,
	classifyHighlight,
	coverage,
	mergeRows,
	resolveTextRange,
	rowsBox,
	rowsHitSegment,
	rowsPath,
	rowsSamplePoints,
	rowsToFreehand,
	snapRange,
	textAnchorOf,
} from "./textHighlight";
import type { TextRange } from "./model";

/** Rects taller than this many default line heights are not text (images, embeds, widgets). */
const MAX_ROW_LINES = 2.5;

export interface Origin {
	/** Client coordinates of the overlay's (0,0), and the view's CSS scale. */
	x: number;
	y: number;
	sx: number;
	sy: number;
}

/** Client position of the overlay origin (same as InkView.readGeometry: content left + padding, documentTop). */
export function overlayOrigin(view: EditorView): Origin {
	const cd = view.contentDOM;
	const cs = getComputedStyle(cd);
	const padL = parseFloat(cs.paddingLeft) || 0;
	const padT = parseFloat(cs.paddingTop) || 0;
	const rect = cd.getBoundingClientRect();
	const sx = cd.offsetWidth > 0 && rect.width > 0 ? rect.width / cd.offsetWidth : (view.scaleX || 1);
	const sy = cd.offsetHeight > 0 && rect.height > 0 ? rect.height / cd.offsetHeight : (view.scaleY || 1);
	const y = Math.abs(sy - (view.scaleY || 1)) > 0.005 ? rect.top + padT * sy : view.documentTop;
	return { x: rect.left + padL * sx, y, sx, sy };
}

/** Rows (overlay space) of the visible part of a range, from DOM ranges per document line. */
function measureRange(view: EditorView, range: TextRange, o: Origin): Row[] {
	const doc = view.state.doc;
	const rects: Row[] = [];
	const dr = view.dom.ownerDocument.createRange();
	for (const vr of view.visibleRanges) {
		let pos = Math.max(range.from, vr.from);
		const end = Math.min(range.to, vr.to);
		while (pos < end) {
			const line = doc.lineAt(pos);
			const b = Math.min(end, line.to);
			if (b > pos) {
				try {
					const s = view.domAtPos(pos, 1);
					const e = view.domAtPos(b, -1);
					dr.setStart(s.node, s.offset);
					dr.setEnd(e.node, e.offset);
					const list = dr.getClientRects();
					for (let i = 0; i < list.length; i++) {
						const r = list[i];
						rects.push({
							left: (r.left - o.x) / o.sx,
							right: (r.right - o.x) / o.sx,
							top: (r.top - o.y) / o.sy,
							bottom: (r.bottom - o.y) / o.sy,
						});
					}
				} catch {
					/* position not in the DOM (e.g. inside a widget): skip */
				}
			}
			pos = line.to + 1;
		}
	}
	return mergeRows(rects, view.defaultLineHeight * MAX_ROW_LINES);
}

export interface TextSnap {
	range: TextRange;
	rows: Row[];
}

export class TextHighlights {
	/** Rows of each text highlight measured in the last render (overlay space). */
	private rows = new Map<Stroke, Row[]>();
	private readonly proxyOf = new Map<Stroke, Stroke>();

	constructor(private readonly view: EditorView) {}

	// -------------------------------------------------------------------------------------------
	// Snapping
	// -------------------------------------------------------------------------------------------

	/** Decide whether overlay-space highlighter points snap to text; returns the range + rows. */
	snap(points: readonly Point[]): TextSnap | null {
		const view = this.view;
		if (points.length < 2) return null;
		let minX = Infinity;
		let maxX = -Infinity;
		for (const p of points) {
			minX = Math.min(minX, p[0]);
			maxX = Math.max(maxX, p[0]);
		}
		const ys = points.map((p) => p[1]).sort((a, b) => a - b);
		const cy = ys[Math.floor(ys.length / 2)];
		const o = overlayOrigin(view);
		const posAt = (x: number, y: number) => view.posAtCoords({ x: o.x + x * o.sx, y: o.y + y * o.sy }, false);
		const doc = view.state.doc;
		let lh = view.defaultLineHeight;
		const c = view.coordsAtPos(posAt((minX + maxX) / 2, cy));
		if (c) lh = Math.max(lh, (c.bottom - c.top) / o.sy);

		const kind = classifyHighlight(points, lh);
		if (!kind) return null;
		const first = points[0];
		const last = points[points.length - 1];
		const [a, b] = kind === "line" ? [posAt(minX, cy), posAt(maxX, cy)] : [posAt(first[0], first[1]), posAt(last[0], last[1])];
		const range = snapRange(doc, a, b);
		if (!range) return null;
		const rows = measureRange(view, range, o);
		if (rows.length === 0) return null;
		const near = (r: Row, y: number) => y >= r.top - lh / 2 && y <= r.bottom + lh / 2;
		if (kind === "line") {
			// Exactly one visual line, under the stroke, and the stroke mostly over its text.
			if (rows.length !== 1 || !near(rows[0], cy)) return null;
			if (coverage(rows, minX, maxX) < TEXT_SNAP.minCoverage) return null;
		} else if (!near(rows[0], first[1]) || !near(rows[rows.length - 1], last[1])) {
			return null;
		}
		return { range, rows };
	}

	/** Live preview while drawing: the snapped rects (overlay space), or null to draw freehand. */
	livePath(points: readonly Point[]): string | null {
		const s = this.snap(points);
		return s ? rowsPath(s.rows) : null;
	}

	/**
	 * On lift: a text-highlight stroke for these overlay-space points (new id, anchored to the line
	 * of the range start, transient `pos`/`textRange` set) and its final path in overlay space, or
	 * null when the stroke stays freehand. `points` keep the drawn path (fallback geometry).
	 */
	snapStroke(points: readonly Point[], props: Pick<Stroke, "color" | "size">): { stroke: Stroke; d: string } | null {
		const snap = this.snap(points);
		if (!snap) return null;
		const view = this.view;
		const { anchor, text, lineFrom } = textAnchorOf(view.state.doc, snap.range);
		const top = view.lineBlockAt(lineFrom).top;
		const stroke: Stroke = {
			id: newId(),
			tool: "highlighter",
			color: props.color,
			size: props.size,
			anchor,
			points: points.map((p): Point => [p[0], p[1] - top, p[2]]),
			text,
			textRange: { ...snap.range },
			pos: lineFrom,
		};
		this.rows.set(stroke, snap.rows);
		return { stroke, d: rowsPath(snap.rows) };
	}

	// -------------------------------------------------------------------------------------------
	// Anchors
	// -------------------------------------------------------------------------------------------

	/** Resolve a text highlight's `textRange` (and `pos`) against `doc` if it has none yet. */
	resolve(s: Stroke, doc: Text): void {
		if (!s.text || s.textRange) return;
		const line =
			s.pos !== undefined
				? doc.lineAt(Math.min(Math.max(s.pos, 0), doc.length)).number - 1
				: resolveAnchor({ count: doc.lines, get: (i: number) => doc.line(i + 1).text }, s.anchor);
		s.textRange = resolveTextRange(doc, line, s.anchor.line, s.text);
		s.pos ??= doc.line(line + 1).from;
	}

	/**
	 * Before save: text highlights re-anchor to the line of their range start (`anchor`, `text`,
	 * and `pos` = that line's start). Run BEFORE the generic pos → anchor refresh.
	 */
	refreshAnchors(strokes: readonly Stroke[], doc: Text): void {
		for (const s of strokes) {
			if (!s.text) continue;
			this.resolve(s, doc);
			const r = s.textRange!;
			const clamp = (p: number) => Math.min(Math.max(p, 0), doc.length);
			const t = textAnchorOf(doc, { from: clamp(r.from), to: clamp(r.to) });
			s.anchor = t.anchor;
			s.text = t.text;
			s.pos = t.lineFrom;
		}
	}

	// -------------------------------------------------------------------------------------------
	// Measuring / rendering
	// -------------------------------------------------------------------------------------------

	/** Measure READ phase: rows of every text highlight intersecting the viewport. */
	measure(strokes: readonly Stroke[] | undefined): void {
		const next = new Map<Stroke, Row[]>();
		if (strokes) {
			const view = this.view;
			const doc = view.state.doc;
			const vp = view.viewport;
			let o: Origin | null = null;
			for (const s of strokes) {
				if (!s.text) continue;
				this.resolve(s, doc);
				const r = s.textRange!;
				if (r.to <= r.from || r.to < vp.from || r.from > vp.to) continue;
				o ??= overlayOrigin(view);
				const rows = measureRange(view, r, o);
				if (rows.length > 0) next.set(s, rows);
			}
		}
		this.rows = next;
	}

	/** Measured rows (overlay space), or null when not visible / nothing to draw. */
	rowsOf(s: Stroke): Row[] | null {
		return this.rows.get(s) ?? null;
	}

	/** Set the path of a rendered text highlight (relative to its line top `top`). */
	applyPath(el: SVGPathElement, s: Stroke, top: number): void {
		const rows = this.rows.get(s);
		const d = rows ? rowsPath(rows, top) : "";
		if (el.getAttribute("d") !== d) el.setAttribute("d", d);
	}

	/** Bbox relative to the line top (selection box), or null. */
	localBox(s: Stroke, top: number): BBox | null {
		const b = s.text ? rowsBox(this.rows.get(s) ?? []) : null;
		return b ? { minX: b.minX, maxX: b.maxX, minY: b.minY - top, maxY: b.maxY - top } : null;
	}

	/** Eraser: does the overlay-space segment touch the highlight's rects? */
	hitSegment(s: Stroke, x1: number, y1: number, x2: number, y2: number, radius: number): boolean {
		const rows = this.rows.get(s);
		return !!rows && rowsHitSegment(rows, x1, y1, x2, y2, radius);
	}

	// -------------------------------------------------------------------------------------------
	// Lasso, clipboard, screenshot
	// -------------------------------------------------------------------------------------------

	/**
	 * Strokes for the lasso predicate: text highlights are replaced by proxies whose points sample
	 * their rects (same anchor/pos, so `topOf` works on them); unmeasured ones are left out.
	 * Map the result back with `originals`.
	 */
	lassoProxies(strokes: readonly Stroke[], topOf: (s: Stroke) => number): Stroke[] {
		this.proxyOf.clear();
		const out: Stroke[] = [];
		for (const s of strokes) {
			if (!s.text) {
				out.push(s);
				continue;
			}
			const rows = this.rows.get(s);
			if (!rows) continue;
			const p: Stroke = { ...s, points: rowsSamplePoints(rows, topOf(s)) };
			this.proxyOf.set(p, s);
			out.push(p);
		}
		return out;
	}

	originals(selected: readonly Stroke[]): Stroke[] {
		const out = selected.map((s) => this.proxyOf.get(s) ?? s);
		this.proxyOf.clear();
		return out;
	}

	/**
	 * Text highlights as plain freehand highlighter strokes at their current layout (one capsule per
	 * visual line; same anchor/pos so `topOf` applies; ids are NOT unique — callers that store them
	 * must give new ids, as lasso copies do). Other strokes pass through; unmeasured or empty text
	 * highlights are dropped. Used by lasso move/scale/duplicate/copy and screenshots: a moved text
	 * highlight detaches from the text.
	 */
	asFreehand(strokes: readonly Stroke[], topOf: (s: Stroke) => number): Stroke[] {
		const out: Stroke[] = [];
		for (const s of strokes) {
			if (!s.text) {
				out.push(s);
				continue;
			}
			const rows = this.rows.get(s);
			if (!rows) continue;
			for (const part of rowsToFreehand(rows, topOf(s))) {
				out.push({ id: s.id, tool: "highlighter", color: s.color, size: part.size, anchor: s.anchor, points: part.points, pos: s.pos });
			}
		}
		return out;
	}

	/** Recolor keeps a text highlight a text highlight (new id). Null for other strokes. */
	recolor(s: Stroke, color: string): Stroke | null {
		if (!s.text) return null;
		const copy: Stroke = {
			...s,
			id: newId(),
			color,
			anchor: { ...s.anchor },
			text: { ...s.text },
			points: s.points.map((p): Point => [p[0], p[1], p[2]]),
			...(s.textRange ? { textRange: { ...s.textRange } } : {}),
		};
		const rows = this.rows.get(s);
		if (rows) this.rows.set(copy, rows);
		return copy;
	}
}
