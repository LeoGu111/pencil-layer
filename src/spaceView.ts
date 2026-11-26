/**
 * Stage K — drawing spaces in the editor (CodeMirror side; pure rules in spaces.ts).
 *
 * Each space is a CM6 block widget (`.pl-space`, exactly `height` px tall) after the last line of
 * the block holding its anchor line (`blockEnds`), or after the note's last line ("end"). The
 * widgets come from a StateField that recomputes their places synchronously in every transaction
 * (anchor positions mapped through the changes with assoc −1, like `Stroke.pos`), so a space moves
 * with its text in the very same update as the edit — no extra dispatch, no frame where text and
 * space overlap. The ink view feeds the field the note's spaces (`setSpaces`) whenever they change
 * (load, add/remove/resize, undo, live sync, live growth while drawing).
 *
 * A space's top in document coordinates is read from CM's block structure (`spaceLayout`): the
 * line block of the line it follows includes the widgets attached to its end, each with its own
 * top. The ink view places space ink at that top, so ink and its space can never disagree.
 *
 * Controls (`SpaceControls`): per space a "⋯" button (top right → Copy / Cut / Clear ink / Delete space) and a
 * resize handle centred on the bottom edge (pen, finger or mouse; 40 px touch target). They are
 * HTML in a layer inside the scroller, outside the editable content (like the lasso menu): presses
 * never reach CodeMirror (no caret move, no focus change, no iPad keyboard), Pencil taps activate
 * on pointerup (tap.ts). The editor is never printed, so neither are they.
 */
import { EditorSelection, EditorState, StateEffect, StateField, Text, Transaction } from "@codemirror/state";
import { invertedEffects } from "@codemirror/commands";
import type { Stroke } from "./model";
import { BlockInfo, Decoration, DecorationSet, EditorView, WidgetType } from "@codemirror/view";
import { setIcon } from "obsidian";
import { blockEnds, displayLine, spaceInRange } from "./spaces";
import { blockStylusTouch, onTap } from "./tap";

/** What the field needs per space: live anchor position (null = "end") and height. */
export interface SpaceSpec {
	id: string;
	pos: number | null;
	height: number;
}

/** A space as CM lays it out (document coordinates). */
export interface SpaceBox {
	id: string;
	top: number;
	height: number;
	/** Anchored at the note's end. */
	end: boolean;
	/** Document position the widget is attached to (end of its display line). */
	at: number;
}

export const setSpaces = StateEffect.define<SpaceSpec[]>();

class SpaceWidget extends WidgetType {
	constructor(
		readonly id: string,
		readonly height: number,
		readonly end: boolean,
		/** Inside the text selection (shown highlighted; Cut/Copy take it along). */
		readonly selected: boolean = false,
	) {
		super();
	}
	eq(o: SpaceWidget): boolean {
		return o.id === this.id && o.height === this.height && o.end === this.end && o.selected === this.selected;
	}
	toDOM(): HTMLElement {
		const el = createDiv({ cls: "pl-space", attr: { "aria-hidden": "true", contenteditable: "false" } });
		el.dataset.space = this.id;
		el.style.height = `${this.height}px`;
		el.classList.toggle("is-selected", this.selected);
		return el;
	}
	updateDOM(dom: HTMLElement): boolean {
		if (dom.dataset.space !== this.id) return false;
		dom.style.height = `${this.height}px`;
		dom.classList.toggle("is-selected", this.selected);
		return true;
	}
	get estimatedHeight(): number {
		return this.height;
	}
	ignoreEvent(): boolean {
		return true;
	}
}

interface FieldValue {
	specs: readonly SpaceSpec[];
	deco: DecorationSet;
	/** Ids of the spaces inside the text selection, joined (rebuild only when it changes). */
	selKey: string;
}

function lineSrc(doc: Text) {
	return { count: doc.lines, get: (i: number) => doc.line(i + 1).text };
}

/** Where each spec is shown: its display line (0-based), sorted like `spaceSlots`. */
function place(doc: Text, specs: readonly SpaceSpec[]) {
	const ends = blockEnds(lineSrc(doc));
	const placed = specs.map((s, i) => {
		const line = s.pos === null ? null : doc.lineAt(Math.min(Math.max(0, s.pos), doc.length)).number - 1;
		return { s, i, d: displayLine(ends, line), end: s.pos === null };
	});
	placed.sort((a, b) => a.d - b.d || Number(a.end) - Number(b.end) || a.i - b.i);
	return placed.map((p) => ({ ...p, line: doc.line(Math.min(p.d, doc.lines - 1) + 1) }));
}

/** Ids of the spaces inside the main selection range (see `spaceInRange`). */
function selectedIds(doc: Text, specs: readonly SpaceSpec[], sel: EditorSelection): Set<string> {
	const out = new Set<string>();
	if (specs.length === 0 || sel.ranges.length !== 1 || sel.main.empty) return out;
	for (const p of place(doc, specs)) if (spaceInRange(p.line.to, p.line.from, sel.main.from, sel.main.to)) out.add(p.s.id);
	return out;
}

/** Widgets for the specs: each after the last line of its block (sorted like `spaceSlots`). */
function build(doc: Text, specs: readonly SpaceSpec[], selected: ReadonlySet<string>): DecorationSet {
	if (specs.length === 0) return Decoration.none;
	return Decoration.set(
		place(doc, specs).map((p, k) =>
			Decoration.widget({ widget: new SpaceWidget(p.s.id, p.s.height, p.end, selected.has(p.s.id)), block: true, side: 1 + k }).range(p.line.to),
		),
		true,
	);
}

/** The note's drawing spaces as block widgets. Always installed; empty unless the note has spaces. */
export const spaceField = StateField.define<FieldValue>({
	create: () => ({ specs: [], deco: Decoration.none, selKey: "" }),
	update(v, tr) {
		let specs = v.specs;
		let changed = false;
		for (const e of tr.effects) {
			if (e.is(setSpaces)) {
				specs = e.value;
				changed = true;
			}
		}
		if (!changed && tr.docChanged && specs.length > 0) {
			specs = specs.map((s) => (s.pos === null ? s : { ...s, pos: tr.changes.mapPos(s.pos, -1) }));
			changed = true;
		}
		if (!changed && !tr.selection) return v;
		const sel = selectedIds(tr.state.doc, specs, tr.state.selection);
		const selKey = [...sel].join(",");
		if (!changed && selKey === v.selKey) return v;
		return { specs, deco: build(tr.state.doc, specs, sel), selKey };
	},
	provide: (f) => EditorView.decorations.from(f, (v) => v.deco),
});

/** The specs the field shows now. */
export function currentSpecs(view: EditorView): readonly SpaceSpec[] {
	return view.state.field(spaceField, false)?.specs ?? [];
}

export function sameSpecs(a: readonly SpaceSpec[], b: readonly SpaceSpec[]): boolean {
	return a.length === b.length && a.every((x, i) => x.id === b[i].id && x.pos === b[i].pos && x.height === b[i].height);
}

/** Did this update change the spaces (set or re-placed)? */
export function spacesChanged(u: { startState: { field: (f: typeof spaceField, req: false) => FieldValue | undefined }; state: { field: (f: typeof spaceField, req: false) => FieldValue | undefined } }): boolean {
	return u.startState.field(spaceField, false)?.deco !== u.state.field(spaceField, false)?.deco;
}

/**
 * Every space as CM lays it out now, in document order. The line block of the line a space follows
 * includes the widgets attached to its end; each part knows its widget and top.
 */
export function spaceLayout(view: EditorView): SpaceBox[] {
	const f = view.state.field(spaceField, false);
	if (!f || f.specs.length === 0) return [];
	const out: SpaceBox[] = [];
	const atPos = new Map<number, SpaceWidget[]>();
	f.deco.between(0, view.state.doc.length, (from, _to, d) => {
		const w = (d.spec as { widget?: unknown }).widget;
		if (w instanceof SpaceWidget) {
			const list = atPos.get(from) ?? [];
			list.push(w);
			atPos.set(from, list);
		}
	});
	for (const [pos, widgets] of atPos) {
		const b = view.lineBlockAt(pos);
		const parts: readonly BlockInfo[] = Array.isArray(b.type) ? (b.type as readonly BlockInfo[]) : [];
		const found = new Map<SpaceWidget, { top: number; height: number }>();
		for (const p of parts) {
			const w = (p as { widget?: unknown }).widget;
			if (w instanceof SpaceWidget) found.set(w, { top: p.top, height: p.height });
		}
		// Fallback (no BlockInfo.widget): stack them below the line's text, in widget order.
		let y = b.bottom - widgets.reduce((s, w) => s + w.height, 0);
		for (const w of widgets) {
			const hit = found.get(w) ?? [...found.entries()].find(([k]) => k.id === w.id)?.[1];
			out.push({ id: w.id, top: hit ? hit.top : y, height: hit ? hit.height : w.height, end: w.end, at: pos });
			y += w.height;
		}
	}
	out.sort((a, b) => a.top - b.top);
	return out;
}

// ---------------------------------------------------------------------------------------------
// Controls
// ---------------------------------------------------------------------------------------------

export interface SpaceActions {
	canResize(id: string): boolean;
	/** The resize handle moved: show this height now (not saved). */
	resizeLive(id: string, height: number): void;
	/** The resize handle was released (one undo step), or cancelled (`height` null). */
	resizeEnd(id: string, height: number | null): void;
	clear(id: string): void;
	remove(id: string): void;
	/** Copy / Cut the space with its ink (to paste it after another line). */
	copy(id: string): void;
	cut(id: string): void;
}

interface Ctl {
	more: HTMLElement;
	handle: HTMLElement;
	panel: HTMLElement | null;
}

/** Handle drag in progress. */
interface Drag {
	id: string;
	pointerId: number;
	startY: number;
	startH: number;
	el: HTMLElement;
}

export class SpaceControls {
	private layer: HTMLDivElement | null = null;
	private readonly ctls = new Map<string, Ctl>();
	private openId: string | null = null;
	private drag: Drag | null = null;
	private destroyed = false;
	private last: { boxes: SpaceBox[]; left: number; top: number; width: number } | null = null;

	constructor(
		private readonly view: EditorView,
		private readonly actions: SpaceActions,
	) {}

	/** Is this element one of the controls? (The ink view leaves their events alone.) */
	isControl(target: EventTarget | null): boolean {
		return !!this.layer && target instanceof Node && this.layer.contains(target);
	}

	/** A resize drag is in progress. */
	get dragging(): boolean {
		return this.drag !== null;
	}

	/** WRITE phase: place the controls for the laid-out spaces (overlay origin `left`/`top`, text column `width`). */
	apply(boxes: SpaceBox[], left: number, top: number, width: number, visible: boolean): void {
		if (this.destroyed) return;
		if (!visible || boxes.length === 0) {
			this.last = null;
			if (!this.drag) this.clearAll();
			return;
		}
		this.last = { boxes, left, top, width };
		const sd = this.view.scrollDOM;
		if (!this.layer) {
			const el = createDiv({ cls: "pl-space-ctls" });
			// Never take focus from the editor; never let CM or the ink handlers see these presses.
			const keep = (e: Event) => {
				if (e.target === el) return;
				e.preventDefault();
				e.stopPropagation();
			};
			el.addEventListener("pointerdown", keep);
			el.addEventListener("mousedown", keep);
			el.addEventListener("touchstart", (e) => e.stopPropagation(), { passive: true });
			blockStylusTouch(el); // Pencil: no Scribble; buttons activate on pointerup (tap.ts)
			this.layer = el;
		}
		if (this.layer.parentElement !== sd) sd.appendChild(this.layer);
		this.layer.style.left = `${left}px`;
		this.layer.style.top = `${top}px`;
		const ids = new Set(boxes.map((b) => b.id));
		for (const [id, c] of this.ctls) {
			if (ids.has(id) || this.drag?.id === id) continue;
			c.more.remove();
			c.handle.remove();
			c.panel?.remove();
			this.ctls.delete(id);
		}
		if (this.openId && !ids.has(this.openId)) this.openId = null;
		for (const b of boxes) {
			const c = this.ctls.get(b.id) ?? this.create(b.id);
			c.more.style.left = `${width - 40}px`;
			c.more.style.top = `${b.top}px`;
			c.handle.style.left = `${width / 2 - 40}px`;
			c.handle.style.top = `${b.top + b.height - 20}px`;
			c.handle.style.display = this.actions.canResize(b.id) ? "" : "none";
			if (this.openId === b.id) {
				if (!c.panel) c.panel = this.makePanel(b.id);
				c.panel.style.left = `${width - 168}px`;
				c.panel.style.top = `${b.top + 40}px`;
			} else if (c.panel) {
				c.panel.remove();
				c.panel = null;
			}
		}
	}

	private create(id: string): Ctl {
		const more = this.button("more-horizontal", "Drawing space", "pl-space-more");
		onTap(more, () => {
			this.openId = this.openId === id ? null : id;
			this.reapply();
		});
		const handle = createDiv({ cls: "pl-space-handle", attr: { role: "slider", "aria-label": "Resize drawing space", title: "Drag to resize the drawing space" } });
		handle.createSpan({ cls: "pl-space-grip" });
		handle.addEventListener("pointerdown", (e) => this.onHandleDown(id, handle, e));
		handle.addEventListener("pointermove", (e) => this.onHandleMove(e));
		handle.addEventListener("pointerup", (e) => this.onHandleUp(e, false));
		handle.addEventListener("pointercancel", (e) => this.onHandleUp(e, true));
		handle.addEventListener("lostpointercapture", (e) => this.onHandleUp(e, true));
		// A finger on the handle resizes instead of scrolling.
		handle.addEventListener("touchmove", (e) => {
			if (e.cancelable) e.preventDefault();
		}, { passive: false });
		const c: Ctl = { more, handle, panel: null };
		this.layer!.append(more, handle);
		this.ctls.set(id, c);
		return c;
	}

	private makePanel(id: string): HTMLElement {
		const p = createDiv({ cls: "pl-space-panel" });
		const item = (icon: string, label: string, run: () => void, cls = "") => {
			const b = this.button(icon, label, `pl-space-item ${cls}`.trim());
			b.querySelector(".pl-space-face")!.appendText(label);
			onTap(b, () => {
				this.openId = null;
				this.reapply();
				run();
			});
			p.appendChild(b);
		};
		item("copy", "Copy", () => this.actions.copy(id));
		item("scissors", "Cut", () => this.actions.cut(id));
		item("eraser", "Clear ink", () => this.actions.clear(id));
		item("trash-2", "Delete space", () => this.actions.remove(id), "mod-warning");
		this.layer!.appendChild(p);
		return p;
	}

	private button(icon: string, label: string, cls: string): HTMLElement {
		const b = createDiv({ cls: `pl-space-ctl ${cls}`, attr: { role: "button", "aria-label": label, title: label } });
		const face = b.createSpan({ cls: "pl-space-face" });
		setIcon(face, icon);
		return b;
	}

	private reapply(): void {
		const l = this.last;
		if (l) this.apply(l.boxes, l.left, l.top, l.width, true);
	}

	private onHandleDown(id: string, el: HTMLElement, e: PointerEvent): void {
		e.preventDefault();
		e.stopPropagation();
		if (this.drag) return;
		const box = this.last?.boxes.find((b) => b.id === id);
		if (!box) return;
		this.openId = null;
		try {
			el.setPointerCapture(e.pointerId);
		} catch {
			/* not fatal */
		}
		this.drag = { id, pointerId: e.pointerId, startY: e.clientY, startH: box.height, el };
		el.classList.add("is-dragging");
	}

	private onHandleMove(e: PointerEvent): void {
		const d = this.drag;
		if (!d || e.pointerId !== d.pointerId) return;
		e.preventDefault();
		e.stopPropagation();
		const sy = this.view.scaleY || 1;
		this.actions.resizeLive(d.id, d.startH + (e.clientY - d.startY) / sy);
	}

	private onHandleUp(e: PointerEvent, cancel: boolean): void {
		const d = this.drag;
		if (!d || e.pointerId !== d.pointerId) return;
		if (e.type === "lostpointercapture" && e.target !== d.el) return;
		this.drag = null;
		d.el.classList.remove("is-dragging");
		try {
			if (d.el.hasPointerCapture(e.pointerId)) d.el.releasePointerCapture(e.pointerId);
		} catch {
			/* ignore */
		}
		const sy = this.view.scaleY || 1;
		const moved = Math.abs(e.clientY - d.startY) >= 2;
		this.actions.resizeEnd(d.id, cancel || !moved ? null : d.startH + (e.clientY - d.startY) / sy);
	}

	private clearAll(): void {
		this.layer?.remove();
		this.layer = null;
		this.ctls.clear();
		this.openId = null;
	}

	destroy(): void {
		this.destroyed = true;
		this.drag = null;
		this.clearAll();
	}
}

// ---------------------------------------------------------------------------------------------
// Drawings cut / pasted with text: one step in the EDITOR's undo history (⌘Z / ⌘⇧Z)
// ---------------------------------------------------------------------------------------------

/** A space with its ink, as moved by a text Cut/Paste. `after.line` is valid in the doc where it is added. */
export interface MovedSpace {
	space: { id: string; after: { line: number; hash: string }; height: number; a4?: true };
	strokes: Stroke[];
}

/**
 * Riding on a text Cut/Paste transaction (and on its undo/redo): spaces to remove from / add to
 * the note's ink. The ink view applies it to the store. CM history stores the inverse (add ↔
 * remove), so ⌘Z after a cut brings the drawings back together with their text.
 */
export const spaceMove = StateEffect.define<{ add: MovedSpace[]; remove: MovedSpace[] }>();

/** Set by a Cut/Paste capture handler just before the editor's own handler dispatches the text change. */
let pending: { state: EditorState; build: (tr: Transaction) => { add: MovedSpace[]; remove: MovedSpace[] } } | null = null;

/** Attach `build(tr)` as a `spaceMove` to the next doc-changing transaction from `state` (the editor's Cut/Paste). Returns a check: was it claimed? */
export function expectSpaceMove(state: EditorState, build: (tr: Transaction) => { add: MovedSpace[]; remove: MovedSpace[] }): () => boolean {
	const p = { state, build };
	pending = p;
	return () => {
		const claimed = pending !== p;
		if (pending === p) pending = null;
		return claimed;
	};
}

export const spaceMoveHistory = [
	EditorState.transactionExtender.of((tr) => {
		const p = pending;
		if (!p || !tr.docChanged || tr.startState !== p.state) return null;
		pending = null;
		return { effects: spaceMove.of(p.build(tr)) };
	}),
	invertedEffects.of((tr) => {
		const out: StateEffect<unknown>[] = [];
		for (const e of tr.effects) if (e.is(spaceMove)) out.push(spaceMove.of({ add: e.value.remove, remove: e.value.add }));
		return out;
	}),
];
