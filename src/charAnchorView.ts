/**
 * Stage H — ink drawn over text stays on that text: the CodeMirror side. One `CharAnchors` per ink
 * view; inkView.ts calls it from hook points marked "[Stage H]". Rule and math: charAnchor.ts.
 *
 * - Anchoring (`anchorUnit`, `inherit`): on stroke finish / group commit, `posAtCoords` at the
 *   unit's bbox center → nearest letter/digit → `coordsAtPos` → stored offset from that character's
 *   rect to the stroke's points' origin. `charPos` (transient) is the live character position.
 * - Measuring (`measure`, from the render's measure READ phase): `coordsAtPos` of the character of
 *   every character-anchored stroke in CM's viewport, batched, and only when the layout may have
 *   changed since its last measurement (`invalidate`: doc, geometry, height or selection changes —
 *   Live Preview reveals markup on the cursor's line). The result is cached per stroke as a shift
 *   relative to the stroke's line-anchored placement (`shift`), so strokes outside the viewport
 *   keep their last known placement and scrolling costs nothing.
 */
import type { EditorView } from "@codemirror/view";
import type { Text } from "@codemirror/state";
import type { BBox } from "./geometry";
import type { Stroke } from "./model";
import { CHAR_ANCHOR, XY, charAnchorAt, charOffset, charSized, nearChar, pickChar, refPoint, resolveCharPos, touches } from "./charAnchor";
import { Origin, overlayOrigin } from "./textHighlightView";

/** A character's rect in overlay space: top-left and height. */
interface CharRect {
	x: number;
	y: number;
	h: number;
}

interface Shift {
	x: number;
	y: number;
	gen: number;
}

export class CharAnchors {
	/** Per stroke: where its points' origin is relative to its line-anchored placement (0, line top). */
	private shifts = new WeakMap<Stroke, Shift>();
	/** Layout generation: bumped whenever measured characters may have moved. */
	private gen = 0;
	/** The last character-anchored stroke drawn (joining rule). */
	private recent: { stroke: Stroke; box: BBox; at: number } | null = null;

	constructor(private readonly view: EditorView) {}

	// -------------------------------------------------------------------------------------------
	// Positions
	// -------------------------------------------------------------------------------------------

	/** Resolve `charPos` from the persisted anchor once the stroke has its `pos`. */
	resolve(s: Stroke, doc: Text): void {
		if (!s.char || s.charPos !== undefined || s.pos === undefined) return;
		const line = doc.lineAt(Math.min(Math.max(s.pos, 0), doc.length)).number - 1;
		s.charPos = resolveCharPos(doc, line, s.anchor.line, s.char);
	}

	/** Before save: persisted `char` (line, ch) from the live `charPos`. Run AFTER the line anchors are refreshed. */
	refreshAnchors(strokes: readonly Stroke[], doc: Text): void {
		for (const s of strokes) {
			if (!s.char) continue;
			this.resolve(s, doc);
			if (s.charPos === undefined) continue;
			s.char = charAnchorAt(doc, s.charPos, s.char);
		}
	}

	// -------------------------------------------------------------------------------------------
	// Measuring
	// -------------------------------------------------------------------------------------------

	/** The layout may have changed: re-measure every character on the next render. */
	invalidate(): void {
		this.gen++;
	}

	/** Measure READ phase: characters of character-anchored strokes in the viewport (if stale). */
	measure(strokes: readonly Stroke[] | undefined): void {
		if (!strokes) return;
		const view = this.view;
		const doc = view.state.doc;
		const vp = view.viewport;
		let o: Origin | null = null;
		for (const s of strokes) {
			if (!s.char || s.text) continue;
			this.resolve(s, doc);
			const cp = s.charPos;
			if (cp === undefined || s.pos === undefined || cp < vp.from || cp > vp.to) continue;
			const old = this.shifts.get(s);
			if (old && old.gen === this.gen) continue;
			o ??= overlayOrigin(view);
			const c = this.charRect(Math.min(cp, doc.length), o);
			if (!c) continue;
			const top = view.lineBlockAt(doc.lineAt(Math.min(Math.max(s.pos, 0), doc.length)).from).top;
			this.shifts.set(s, { x: c.x + s.char.dx, y: c.y + s.char.dy - top, gen: this.gen });
		}
	}

	/** Offset of a stroke's points' origin from (0, its line top), as last measured ((0, 0) if never). */
	shift(s: Stroke): XY {
		const sh = s.char ? this.shifts.get(s) : undefined;
		return sh ? [sh.x, sh.y] : [0, 0];
	}

	// -------------------------------------------------------------------------------------------
	// Anchoring new strokes
	// -------------------------------------------------------------------------------------------

	/**
	 * Give a unit of NEW strokes (a finished stroke, or a moved / pasted / duplicated group; each
	 * with `pos` set and points relative to its line top) a common character anchor if the rule in
	 * charAnchor.ts qualifies. `box` = overlay bbox of the unit's points. `join`: a single drawn
	 * stroke may join the previous character-anchored stroke. Returns whether it anchored.
	 */
	anchorUnit(strokes: readonly Stroke[], box: BBox, join = false): boolean {
		const view = this.view;
		const lh = view.defaultLineHeight;
		if (strokes.length === 0 || strokes.some((s) => s.text || s.pos === undefined) || !charSized(box, lh)) return false;
		const o = overlayOrigin(view);
		const doc = view.state.doc;
		let charPos: number | null = null;
		let rect: CharRect | null = null;
		const r = this.recent;
		if (join && r && performance.now() - r.at < CHAR_ANCHOR.joinMs && r.stroke.charPos !== undefined && touches(box, r.box, lh)) {
			charPos = Math.min(r.stroke.charPos, doc.length);
			rect = this.charRect(charPos, o);
		}
		if (rect === null) {
			// The center may lie in the gap (or blank line) next to the text it annotates: probe the
			// center and half a line above/below it; the qualifying character closest to the center wins.
			const ref = refPoint(box);
			let best = Infinity;
			const seen = new Set<number>();
			for (const dy of [0, lh / 2, -lh / 2]) {
				const pos = view.posAtCoords({ x: o.x + ref[0] * o.sx, y: o.y + (ref[1] + dy) * o.sy }, false);
				const line = doc.lineAt(pos);
				const at = this.charRect(pos, o);
				const ch = pickChar(line.text, pos - line.from, !!at && ref[0] < at.x);
				if (ch === null || seen.has(line.from + ch)) continue;
				seen.add(line.from + ch);
				const c = this.charRect(line.from + ch, o);
				if (!c || c.h > 2 * lh || !nearChar(ref, [c.x, c.y], c.h, lh) || !this.isText(line.from + ch)) continue;
				const d = Math.hypot(Math.max(0, c.y - ref[1], ref[1] - (c.y + c.h)), Math.max(0, c.x - ref[0], ref[0] - (c.x + lh)));
				if (d < best) {
					best = d;
					charPos = line.from + ch;
					rect = c;
				}
			}
		}
		if (charPos === null || rect === null) return false;
		for (const s of strokes) {
			const top = view.lineBlockAt(doc.lineAt(Math.min(Math.max(s.pos!, 0), doc.length)).from).top;
			s.char = charAnchorAt(doc, charPos, charOffset([0, top], [rect.x, rect.y]));
			s.charPos = charPos;
			this.shifts.set(s, { x: 0, y: 0, gen: this.gen });
		}
		return true;
	}

	/**
	 * A NEW stroke `to` (precise-eraser piece, recolored copy) made from `from` follows `from`'s
	 * character. `fromOrigin` / `toOrigin`: overlay positions of their points' origins right now.
	 */
	inherit(from: Stroke, fromOrigin: XY, to: Stroke, toOrigin: XY): void {
		if (!from.char || from.charPos === undefined || to.text) return;
		const char: XY = [fromOrigin[0] - from.char.dx, fromOrigin[1] - from.char.dy];
		to.char = charAnchorAt(this.view.state.doc, from.charPos, charOffset(toOrigin, char));
		to.charPos = from.charPos;
		this.shifts.set(to, { x: 0, y: 0, gen: this.gen });
	}

	/** Remember a finished character-anchored stroke for the joining rule. */
	drawn(s: Stroke, box: BBox): void {
		this.recent = s.char ? { stroke: s, box, at: performance.now() } : null;
	}

	// -------------------------------------------------------------------------------------------

	/** Overlay-space rect (top-left, height) of the character after `pos`. */
	private charRect(pos: number, o: Origin): CharRect | null {
		const c = this.view.coordsAtPos(pos, 1);
		if (!c) return null;
		return { x: (c.left - o.x) / o.sx, y: (c.top - o.y) / o.sy, h: (c.bottom - c.top) / o.sy };
	}

	/** Is the character rendered as text (not inside a widget such as a Live Preview table or embed)? */
	private isText(pos: number): boolean {
		try {
			const d = this.view.domAtPos(pos, 1);
			const node = d.node.nodeType === 3 ? d.node : d.node.childNodes[d.offset];
			if (!node || node.nodeType !== 3) return false;
			const el = node.parentElement;
			return !!el && !el.closest("[contenteditable=false]");
		} catch {
			return false;
		}
	}
}
