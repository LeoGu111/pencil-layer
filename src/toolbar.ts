/**
 * Floating ink toolbar, Apple Markup style (M2 Stage A2, reworked in A3 + E): a translucent,
 * blurred capsule with circular buttons that floats over the note — one per Markdown leaf.
 *
 *   ( ⠿ | ↶ ↷ | ✎ ⌫ ▬ ◌ | ∿ ⋯ ∿  ● ● ● ● | ⋯ )
 *     grip  undo/redo  tools  options (fixed size)  more
 *
 * - Orientation (A3): horizontal when docked nearest the top or bottom of the leaf, vertical at the
 *   left or right; it switches live while dragging (`floating.ts nearestEdge`, with hysteresis) and
 *   the edge is stored per device next to the position.
 * - Fixed size (A3): the options area has the same size for every tool (the color strip scrolls
 *   inside it), so switching tools never resizes or moves the bar.
 * - Grip (Stage M, `grip.ts`): tap = collapse / expand (no separate button any more), drag = move,
 *   long-press (touch/pen, 500 ms) or right-click = snap-position menu (`floating.ts SNAP_PRESETS`).
 * - Collapsed (A3, Stage M): grip + undo/redo + tools — no presets/colors/⋯. Tapping the active
 *   tool opens its popover, which then also hosts the bar's options area (presets/widths + colors),
 *   so nothing is lost by collapsing.
 * - Tool popovers (Stage E): the first tap on a tool selects it; a tap on the active tool opens its
 *   settings popover (eraser, pen, highlighter, lasso). Popovers open toward the side of the leaf
 *   with more room (`popoverSide`) and are clamped inside it.
 * - Dragging (A3): only by the grip; from pointerdown until the drag ends, touch events are
 *   cancelled and stopped (grip + document capture) so Obsidian mobile's swipe gestures (sidebars,
 *   pull-down) never see them. Elsewhere gestures are untouched.
 * - Pencil (A3): buttons activate on pen pointerup (`tap.ts`) — the Pencil gets no reliable `click`.
 * - Slim desktop variant (Stage F): on desktop with "Mouse draws" off the bar shows only
 *   Undo, Redo, Select, Show/Hide ink and ⋯ (`is-slim`: the drawing tools and options are hidden).
 *   Select is a session toggle: first tap turns it on, a tap on the active Select opens its popover
 *   (rectangle / freeform, filter, "Done"). Same fixed size, drag, orientation and collapse.
 * - Visibility is per device (plugin settings); hidden in Reading view (CSS).
 * - Every press `preventDefault`s pointerdown/mousedown: the editor keeps focus and cursor.
 *
 * Tool state is global (plugin settings); every toolbar re-renders on `refresh()`.
 */
import { MarkdownView, setIcon, setTooltip } from "obsidian";
import { cssColor } from "./inkView";
import {
	Bounds,
	Orientation,
	Rect,
	SNAP_PRESETS,
	Size,
	currentSnapPreset,
	nearestEdge,
	orientationOf,
	placeFloating,
	placePopover,
	popoverSide,
	snapPreset,
	statusBarInset,
	stripScrollState,
	stripWheelDelta,
	toFloatPos,
} from "./floating";
import { GRIP_LONG_PRESS_MS, GripPress } from "./grip";
import type { DrawShape } from "./shapes";
import {
	ActiveTool,
	HIGHLIGHTER_COLORS,
	HOLD_MS_CHOICES,
	HighlighterWidth,
	PEN_COLORS,
	PaletteColor,
	PenPreset,
	PencilSettings,
	ToolbarEdge,
	toolTap,
} from "./settings";
import { SMOOTHING_LEVELS } from "./smoothing";
import { blockStylusTouch, onTap } from "./tap";
import type { ExportChoice } from "./exportOnce";
import { otherStyle, styleExportLabel } from "./docStyle";
import { PAGE_GUIDE_LABELS, PageGuideFormat } from "./pageGuides";
import { formatZoomPercent } from "./zoom";

export interface ToolbarHost {
	getSettings(): PencilSettings;
	updateSettings(patch: Partial<PencilSettings>): void;
	undoInk(view: MarkdownView): void;
	redoInk(view: MarkdownView): void;
	canUndoInk(view: MarkdownView): boolean;
	canRedoInk(view: MarkdownView): boolean;
	/** Show the desktop-only "Mouse draws" toggle. */
	readonly showMouseToggle: boolean;
	// [Stage F] slim desktop toolbar + Select tool
	isSlim(): boolean;
	isDeskSelecting(): boolean;
	setDeskSelect(on: boolean): void;
	// [Stage H] one-shot PDF export from the ⋯ menu
	canExportPdf(view: MarkdownView): boolean;
	exportPdf(view: MarkdownView, choice: ExportChoice): void;
	/** Add extra blank scrollable page space to the current note editor. */
	addBlankPage(view: MarkdownView): void;
	/** Page zoom controls. */
	getZoom(view: MarkdownView): number;
	zoomIn(view: MarkdownView): void;
	zoomOut(view: MarkdownView): void;
	resetZoom(view: MarkdownView): void;
	/** Open the in-app Gemini AI assistant for this note. */
	openAssistantForView(view: MarkdownView): void;
}

const PRESETS: { key: PenPreset; label: string }[] = [
	{ key: "thin", label: "Thin pen (0.3 mm)" },
	{ key: "dashed", label: "Dashed pen (0.3 mm)" },
	{ key: "thick", label: "Thick pen (0.5 mm)" },
];
const HL_WIDTHS: { key: HighlighterWidth; label: string }[] = [
	{ key: "normal", label: "Highlighter, normal width" },
	{ key: "wide", label: "Highlighter, wide" },
];
const TOOL_ICONS: Record<ActiveTool, string> = {
	pen: "pen-line",
	eraser: "eraser",
	highlighter: "highlighter",
	lasso: "lasso",
};
const TOOL_LABELS: Record<ActiveTool, string> = {
	pen: "Pen (tap again for options)",
	eraser: "Eraser (tap again for options)",
	highlighter: "Highlighter (tap again for options)",
	lasso: "Lasso: select, move, resize (tap again for options)",
};

/** Line-sample widths drawn in the (circular) preset buttons. */
const SAMPLE_WIDTH: Record<PenPreset, number> = { thin: 1.6, dashed: 1.8, thick: 3 };
const HL_SAMPLE_WIDTH: Record<HighlighterWidth, number> = { normal: 4.5, wide: 8 };
const SAMPLE_PATH = "M5 15 C 8 6, 11 6, 13 11 S 17 16, 19 7";
const SVG_NS = "http://www.w3.org/2000/svg";
/** Pen drags on the color strip scroll it after this much movement (px). */
const STRIP_SCROLL_MOVE = 8;

type OptionsKind = "pen" | "highlighter" | "eraser" | "lasso";
type PopoverKind = "more" | ActiveTool | "select" | "snap" | "geometry" | "ruler" | "palette";

const SHAPE_ROWS: [DrawShape, string][][] = [
	[["freehand", "Freehand"], ["line", "Line"], ["arrow", "Arrow"]],
	[["rectangle", "Rectangle"], ["ellipse", "Ellipse"], ["triangle", "Triangle"], ["circle", "Circle"]],
];

interface DragState {
	pointerId: number;
	/** Stage M: tap / drag / long-press classification of this grip press. */
	press: GripPress;
	startX: number;
	startY: number;
	left0: number;
	top0: number;
	moved: boolean;
	edge: ToolbarEdge;
	/** A popover was open at the press (a tap then only closes the snap menu). */
	hadSnapMenu: boolean;
}

const GRIP_LABEL = "Drag to move · tap to collapse or expand · hold or right-click for positions";

const SMOOTHING_LABELS: Record<string, string> = { off: "Off", light: "Light", medium: "Medium", strong: "Strong" };

export class InkToolbar {
	readonly el: HTMLElement;
	private readonly leafEl: HTMLElement;
	private readonly barEl: HTMLElement;
	private readonly grip: HTMLElement;
	private readonly toolBtns = new Map<ActiveTool, HTMLElement>();
	private readonly undoBtn: HTMLElement;
	private readonly redoBtn: HTMLElement;
	private readonly moreBtn: HTMLElement;
	private readonly rulerBtn: HTMLElement;
	private readonly geometryBtn: HTMLElement;
	private readonly mathBtn: HTMLElement;
	private readonly aiBtn: HTMLElement;
	/** Stage M: the separator after the options area (where `optionsEl` returns from a popover). */
	private readonly optionsEndSep: HTMLElement;
	/** [Stage F] slim desktop variant: Select tool and Show/Hide ink buttons. */
	private readonly selectBtn: HTMLElement;
	private readonly eyeBtn: HTMLElement;
	private shownEye: boolean | null = null;
	private readonly optionsEl: HTMLElement;
	private optionsKind: OptionsKind | null = null;
	/** Preset/width buttons and color buttons of the current options, keyed by value. */
	private readonly variantBtns = new Map<string, { btn: HTMLElement; sample: SVGPathElement }>();
	private readonly colorBtns = new Map<string, HTMLElement>();
	private stripWrap: HTMLElement | null = null;
	private strip: HTMLElement | null = null;
	private caption: HTMLElement | null = null;
	private popover: HTMLElement | null = null;
	private popoverKind: PopoverKind | null = null;
	private readonly resizeObs: ResizeObserver | null = null;
	private observedStatusBar: HTMLElement | null = null;
	private drag: DragState | null = null;
	private longPressTimer = 0;
	private layoutRaf = 0;
	/** Collapsed state / orientation last rendered (re-layout synchronously when they change). */
	private shownCollapsed: boolean | null = null;
	private shownOrientation: Orientation | null = null;

	constructor(
		private readonly view: MarkdownView,
		private readonly host: ToolbarHost,
	) {
		this.leafEl = view.containerEl;
		this.leafEl.addClass("pl-has-float");
		this.el = this.leafEl.createDiv({ cls: "ink-pages-toolbar" });

		// Keep editor focus/cursor: a press anywhere on the toolbar or its popover never moves focus.
		const keepFocus = (e: Event) => e.preventDefault();
		this.el.addEventListener("pointerdown", keepFocus);
		this.el.addEventListener("mousedown", keepFocus);
		// Pencil presses on our buttons: no Scribble / text interaction (buttons fire on pen pointerup).
		blockStylusTouch(this.el);
		// The color strip and menus own their scroll gestures. Keep the rest of the toolbar still.
		this.el.addEventListener(
			"touchmove",
			(e) => {
				const target = e.target as Node | null;
				if (target?.instanceOf(Node) && (this.strip?.contains(target) || this.popover?.contains(target))) return;
				if (e.cancelable) e.preventDefault();
			},
			{ passive: false },
		);

		this.barEl = this.el.createDiv({ cls: "pl-capsule" });
		this.grip = this.barEl.createDiv({ cls: "pl-grip", attr: { role: "button", "aria-label": GRIP_LABEL } });
		setIcon(this.grip, "grip-vertical");
		setTooltip(this.grip, GRIP_LABEL, { placement: "top" });
		this.grip.addEventListener("pointerdown", (e) => this.startDrag(e));
		// Stage M: right-click (desktop) opens the snap-position menu; never the browser/Obsidian menu.
		this.grip.addEventListener("contextmenu", (e) => {
			e.preventDefault();
			e.stopPropagation();
			if (this.popoverKind !== "snap") this.togglePopover("snap", this.grip);
		});
		// The drag starts with the grip press: Obsidian must not see this touch (mobile swipe gestures).
		this.grip.addEventListener("touchstart", stopTouch, { passive: false });

		const history = this.barEl.createDiv({ cls: "pl-group" });
		this.undoBtn = this.button(history, "undo-2", "Undo ink", () => this.host.undoInk(this.view));
		this.redoBtn = this.button(history, "redo-2", "Redo ink", () => this.host.redoInk(this.view));
		this.barEl.createDiv({ cls: "pl-sep" });

		const tools = this.barEl.createDiv({ cls: "pl-group pl-tools" });
		for (const t of ["pen", "eraser", "highlighter", "lasso"] as const) this.toolButton(tools, t);
		this.rulerBtn = this.button(tools, "ruler", "Lineal / Geodreieck / Zirkel (erneut tippen für Optionen)", () => {
			const s = this.host.getSettings();
			const anyGuide = s.ruler || s.setSquare || s.compass;
			if (!anyGuide) {
				this.closePopover();
				this.host.updateSettings({ tool: "pen", penShape: "freehand", ruler: true, setSquare: false, compass: false, inkVisible: true });
			} else {
				this.togglePopover("ruler", this.rulerBtn);
			}
		});
		this.rulerBtn.addClasses(["pl-tool", "pl-full-only"]);
		this.rulerBtn.setAttribute("aria-haspopup", "menu");
		this.rulerBtn.setAttribute("aria-expanded", "false");
		this.geometryBtn = this.button(tools, "shapes", "Formen & Seitengrenzen", () => this.togglePopover("geometry", this.geometryBtn));
		this.geometryBtn.addClasses(["pl-tool", "pl-full-only"]);
		this.geometryBtn.setAttribute("aria-haspopup", "menu");
		this.geometryBtn.setAttribute("aria-expanded", "false");
		this.mathBtn = this.button(tools, null, "Formel-Modus: Handschrift → LaTeX", () => {
			const next = !this.host.getSettings().mathMode;
			this.host.updateSettings({
				mathMode: next,
				...(next && this.host.getSettings().tool !== "pen" ? { tool: "pen" } : {}),
			});
		});
		this.mathBtn.addClasses(["pl-tool", "pl-full-only"]);
		this.mathBtn.createSpan({ cls: "pl-fx-badge", text: "fx" });
		this.aiBtn = this.button(tools, "sparkles", "Gemini KI-Assistent (Fragen stellen)", () => {
			this.closePopover();
			this.host.openAssistantForView(this.view);
		});
		this.aiBtn.addClass("pl-tool");
		// [Stage F] desktop Select tool (slim variant only).
		this.selectBtn = this.button(tools, SELECT_ICON, SELECT_OFF_LABEL, () => {
			if (this.host.isDeskSelecting()) {
				this.togglePopover("select", this.selectBtn);
			} else {
				this.closePopover();
				this.host.setDeskSelect(true);
			}
		});
		this.selectBtn.addClasses(["pl-tool", "pl-slim-only"]);
		this.selectBtn.dataset.tool = "select";

		this.barEl.createDiv({ cls: "pl-sep pl-exp pl-full-only" });
		this.optionsEl = this.barEl.createDiv({ cls: "pl-options pl-exp pl-full-only" });

		// Hidden when collapsed: the end group then holds only expanded-only buttons.
		this.optionsEndSep = this.barEl.createDiv({ cls: "pl-sep pl-exp" });
		const end = this.barEl.createDiv({ cls: "pl-group pl-exp" });
		// [Stage F] Show/Hide ink directly on the slim bar.
		this.eyeBtn = this.button(end, "eye", "Hide ink", () => this.host.updateSettings({ inkVisible: !this.host.getSettings().inkVisible }));
		this.eyeBtn.addClasses(["pl-exp", "pl-slim-only"]);
		this.moreBtn = this.button(end, "more-horizontal", "More", () => this.togglePopover("more", this.moreBtn));
		this.moreBtn.addClass("pl-exp");
		for (const b of this.toolBtns.values()) b.addClass("pl-full-only");

		if (typeof ResizeObserver !== "undefined") {
			this.resizeObs = new ResizeObserver(() => this.scheduleLayout());
			this.resizeObs.observe(this.leafEl);
			this.resizeObs.observe(this.el);
		}
		this.refresh();
	}

	refresh(): void {
		const s = this.host.getSettings();
		this.el.toggleClass("is-hidden", !s.toolbarVisible);
		if (!s.toolbarVisible) this.closePopover();
		this.el.toggleClass("is-collapsed", s.toolbarCollapsed);
		if (s.toolbarCollapsed && this.popoverKind === "more") this.closePopover();
		this.grip.setAttribute("aria-expanded", String(!s.toolbarCollapsed));
		// [Stage F] slim desktop variant (Mouse draws off): Undo, Redo, Select, Show/Hide ink, ⋯.
		const slim = this.host.isSlim();
		const selecting = this.host.isDeskSelecting();
		this.el.toggleClass("is-slim", slim);
		if (this.popoverKind === "select" && !selecting) this.closePopover();
		if (this.popoverKind === "geometry" && slim) this.closePopover();
		if (this.popoverKind === "ruler" && slim) this.closePopover();
		this.selectBtn.toggleClass("is-active", selecting);
		// [Stage H] Select on is obvious: solid accent button + accent ring around the bar; the label says how out.
		this.el.toggleClass("is-selecting", selecting);
		const selectLabel = selecting ? SELECT_ON_LABEL : SELECT_OFF_LABEL;
		if (this.selectBtn.getAttribute("aria-label") !== selectLabel) {
			this.selectBtn.setAttribute("aria-label", selectLabel);
			setTooltip(this.selectBtn, selectLabel, { placement: "top" });
		}
		this.selectBtn.toggleClass("is-open", this.popoverKind === "select");
		if (this.shownEye !== s.inkVisible) {
			this.shownEye = s.inkVisible;
			const label = s.inkVisible ? "Hide ink" : "Show ink";
			setIcon(this.eyeBtn, s.inkVisible ? "eye" : "eye-off");
			this.eyeBtn.setAttribute("aria-label", label);
			setTooltip(this.eyeBtn, label, { placement: "top" });
		}
		this.eyeBtn.toggleClass("is-active", !s.inkVisible);
		// A tool popover belongs to the active tool.
		const k = this.popoverKind;
		if (k && k !== "more" && k !== "select" && k !== "snap" && k !== "geometry" && k !== "ruler" && k !== "palette" && (slim || k !== s.tool)) {
			this.closePopover();
		}
		this.rulerBtn.toggleClass("is-active", s.ruler || s.setSquare || s.compass);
		this.rulerBtn.toggleClass("is-open", this.popoverKind === "ruler");
		this.geometryBtn.toggleClass("is-active", s.tool === "pen" && s.penShape !== "freehand");
		this.mathBtn.toggleClass("is-active", s.mathMode);
		for (const [tool, b] of this.toolBtns) {
			b.toggleClass("is-active", tool === s.tool);
			b.toggleClass("is-open", tool === this.popoverKind);
		}
		this.applyOrientation(this.drag?.edge ?? s.toolbarEdge);
		this.renderOptions(s);
		this.refreshHistory();
		if (this.popover && this.popoverKind) this.renderPopover(this.popover, this.popoverKind);
		if (this.shownCollapsed !== s.toolbarCollapsed) {
			this.shownCollapsed = s.toolbarCollapsed;
			this.layout();
		} else {
			this.scheduleLayout();
		}
	}

	/** Undo/redo availability for this leaf's file. */
	refreshHistory(): void {
		this.setDisabled(this.undoBtn, !this.host.canUndoInk(this.view));
		this.setDisabled(this.redoBtn, !this.host.canRedoInk(this.view));
	}

	destroy(): void {
		this.resizeObs?.disconnect();
		if (this.layoutRaf) window.cancelAnimationFrame(this.layoutRaf);
		this.clearLongPress();
		this.endDragGuards();
		this.closePopover();
		this.el.remove();
		if (!this.leafEl.querySelector(":scope > .ink-pages-toolbar")) this.leafEl.removeClass("pl-has-float");
	}

	// -------------------------------------------------------------------------------------------
	// Orientation
	// -------------------------------------------------------------------------------------------

	private applyOrientation(edge: ToolbarEdge): boolean {
		const o = orientationOf(edge);
		if (o === this.shownOrientation) return false;
		this.shownOrientation = o;
		this.el.dataset.orient = o;
		setIcon(this.grip, o === "horizontal" ? "grip-vertical" : "grip-horizontal");
		return true;
	}

	// -------------------------------------------------------------------------------------------
	// Placement (floating, draggable, clamped inside the leaf's content area)
	// -------------------------------------------------------------------------------------------

	/** Bounds of Obsidian's `.status-bar` in this window (or null when absent/hidden). */
	private statusBarBounds(): Bounds | null {
		const sb = this.leafEl.ownerDocument.querySelector<HTMLElement>(".status-bar");
		if (!sb) return null;
		if (sb !== this.observedStatusBar) {
			this.observedStatusBar = sb;
			this.resizeObs?.observe(sb);
		}
		const style = this.leafEl.ownerDocument.defaultView?.getComputedStyle(sb);
		if (style && (style.display === "none" || style.visibility === "hidden")) return null;
		const r = sb.getBoundingClientRect();
		return { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
	}

	/** The area the bar may occupy (leaf below its view header and clear of the status bar), relative to the leaf. */
	private area(): { top: number; size: Size } {
		const header = this.leafEl.querySelector<HTMLElement>(":scope > .view-header");
		const top = header ? header.offsetTop + header.offsetHeight : 0;
		const leafRect = this.leafEl.getBoundingClientRect();
		const bottomInset = statusBarInset(
			{ left: leafRect.left, top: leafRect.top, right: leafRect.right, bottom: leafRect.bottom },
			this.statusBarBounds(),
		);
		return { top, size: { w: this.leafEl.clientWidth, h: Math.max(0, this.leafEl.clientHeight - top - bottomInset) } };
	}

	private barSize(): Size {
		return { w: this.el.offsetWidth, h: this.el.offsetHeight };
	}

	private scheduleLayout(): void {
		if (this.layoutRaf || this.drag) return;
		this.layoutRaf = window.requestAnimationFrame(() => {
			this.layoutRaf = 0;
			this.layout();
		});
	}

	/** Never longer than the leaf along the bar's axis: the options area shrinks and scrolls. */
	private applyMaxSize(size: Size): void {
		const vertical = this.shownOrientation === "vertical";
		this.el.style.maxWidth = vertical ? "" : `${Math.max(0, size.w - 16)}px`;
		this.el.style.maxHeight = vertical ? `${Math.max(0, size.h - 16)}px` : "";
	}

	/** Position the toolbar from the stored per-device position (clamped). */
	private layout(): void {
		if (this.drag || this.el.hasClass("is-hidden")) return;
		const { top, size } = this.area();
		if (size.w === 0 || this.el.offsetWidth === 0) return; // not rendered (hidden leaf / reading view)
		this.applyMaxSize(size);
		this.updateStripScroll();
		const p = placeFloating(size, this.barSize(), this.host.getSettings().toolbarPos);
		this.setPos(p.left, top + p.top);
		if (this.popover) this.placePopoverEl(this.popover);
	}

	private setPos(left: number, top: number): void {
		this.el.style.left = `${Math.round(left)}px`;
		this.el.style.top = `${Math.round(top)}px`;
	}

	/**
	 * Grip press (Stage M): drag = move (as in A3), tap = collapse/expand, long-press (touch/pen) =
	 * snap-position menu. Gesture guards run from the press until release whatever it turns into.
	 */
	private startDrag(e: PointerEvent): void {
		if (e.pointerType === "mouse" && e.button !== 0) return; // right button: `contextmenu`
		e.preventDefault();
		e.stopPropagation();
		if (this.drag) return;
		const hadSnapMenu = this.popoverKind === "snap";
		this.closePopover();
		const handle = this.grip;
		try {
			handle.setPointerCapture(e.pointerId);
		} catch {
			/* not fatal */
		}
		const press = new GripPress(e.pointerType, e.clientX, e.clientY, performance.now());
		this.drag = {
			pointerId: e.pointerId,
			press,
			startX: e.clientX,
			startY: e.clientY,
			left0: this.el.offsetLeft,
			top0: this.el.offsetTop,
			moved: false,
			edge: this.host.getSettings().toolbarEdge,
			hadSnapMenu,
		};
		this.startDragGuards();
		if (press.canLongPress) {
			this.longPressTimer = window.setTimeout(() => {
				this.longPressTimer = 0;
				if (this.drag?.press === press && press.hold(performance.now())) this.togglePopover("snap", this.grip);
			}, GRIP_LONG_PRESS_MS);
		}
		const move = (ev: PointerEvent) => {
			const d = this.drag;
			if (!d || ev.pointerId !== d.pointerId) return;
			ev.preventDefault();
			ev.stopPropagation();
			if (d.press.phase === "longpress") return; // the menu is open: the rest of the press is inert
			let dx = ev.clientX - d.startX;
			let dy = ev.clientY - d.startY;
			if (!d.moved) {
				if (!d.press.move(ev.clientX, ev.clientY)) return;
				d.moved = true;
				this.clearLongPress();
				this.el.addClass("is-dragging");
			}
			const { top, size } = this.area();
			const leafRect = this.leafEl.getBoundingClientRect();
			const px = ev.clientX - leafRect.left;
			const py = ev.clientY - leafRect.top - top;
			const edge = nearestEdge(size, px, py, d.edge);
			if (edge !== d.edge) {
				d.edge = edge;
				if (this.applyOrientation(edge)) {
					// The bar changed shape: keep the grip under the pointer and continue from there.
					this.applyMaxSize(size);
					this.updateStripScroll();
					const g = this.grip.getBoundingClientRect();
					const r = this.el.getBoundingClientRect();
					const gx = g.left + g.width / 2 - r.left;
					const gy = g.top + g.height / 2 - r.top;
					d.left0 = px - gx;
					d.top0 = top + py - gy;
					d.startX = ev.clientX;
					d.startY = ev.clientY;
					dx = 0;
					dy = 0;
				}
			}
			const bar = this.barSize();
			const p = placeFloating(size, bar, toFloatPos(size, bar, d.left0 + dx, d.top0 - top + dy));
			this.setPos(p.left, top + p.top);
		};
		const end = (ev: PointerEvent) => {
			const d = this.drag;
			if (!d || ev.pointerId !== d.pointerId) return;
			handle.removeEventListener("pointermove", move);
			handle.removeEventListener("pointerup", end);
			handle.removeEventListener("pointercancel", end);
			handle.removeEventListener("lostpointercapture", end);
			this.clearLongPress();
			this.drag = null;
			this.endDragGuards();
			this.el.removeClass("is-dragging");
			const result = ev.type === "pointerup" ? d.press.up(ev.clientX, ev.clientY, performance.now()) : d.press.phase;
			if (d.moved) {
				const { top, size } = this.area();
				const pos = toFloatPos(size, this.barSize(), this.el.offsetLeft, this.el.offsetTop - top);
				this.host.updateSettings({ toolbarPos: pos, toolbarEdge: d.edge });
				return;
			}
			this.applyOrientation(this.host.getSettings().toolbarEdge);
			if (result === "longpress" && this.popoverKind !== "snap") {
				this.togglePopover("snap", this.grip); // a late timer: open on release
			} else if (result === "tap" && !d.hadSnapMenu) {
				this.setCollapsed(!this.host.getSettings().toolbarCollapsed);
			}
		};
		handle.addEventListener("pointermove", move);
		handle.addEventListener("pointerup", end);
		handle.addEventListener("pointercancel", end);
		handle.addEventListener("lostpointercapture", end);
	}

	private clearLongPress(): void {
		if (this.longPressTimer) window.clearTimeout(this.longPressTimer);
		this.longPressTimer = 0;
	}

	/**
	 * While dragging: every touch event is cancelled and stopped in the document's capture phase,
	 * before Obsidian's (bubbling) mobile gesture handlers — sidebars and pull-down never open.
	 */
	private startDragGuards(): void {
		const doc = this.el.ownerDocument;
		for (const t of DRAG_GUARDED) doc.addEventListener(t, stopTouch, { capture: true, passive: false });
	}

	private endDragGuards(): void {
		const doc = this.el.ownerDocument;
		for (const t of DRAG_GUARDED) doc.removeEventListener(t, stopTouch, { capture: true });
	}

	private setCollapsed(collapsed: boolean): void {
		this.closePopover();
		this.host.updateSettings({ toolbarCollapsed: collapsed });
	}

	// -------------------------------------------------------------------------------------------
	// Tool options (fixed-size area)
	// -------------------------------------------------------------------------------------------

	private renderOptions(s: PencilSettings): void {
		const kind: OptionsKind = s.tool;
		if (kind !== this.optionsKind) {
			// Rebuild only when the tool changes, so the color strip keeps its scroll position.
			this.optionsKind = kind;
			this.optionsEl.empty();
			this.variantBtns.clear();
			this.colorBtns.clear();
			this.stripWrap = null;
			this.strip = null;
			this.caption = null;
			if (kind === "pen") {
				this.buildVariants(PRESETS, (k) => this.host.updateSettings({ penPreset: k }), (k, path) => {
					path.setAttribute("stroke-width", String(SAMPLE_WIDTH[k]));
					if (k === "dashed") {
						path.setAttribute("stroke-dasharray", "3.2 2.6");
						path.setAttribute("stroke-linecap", "butt");
					}
				});
				this.buildStrip(PEN_COLORS, (c) => this.host.updateSettings({ penColor: c }));
			} else if (kind === "highlighter") {
				this.buildVariants(HL_WIDTHS, (k) => this.host.updateSettings({ highlighterWidth: k }), (k, path) => {
					path.setAttribute("stroke-width", String(HL_SAMPLE_WIDTH[k]));
					path.setAttribute("stroke-linecap", "butt");
					path.addClass("is-highlighter");
				});
				this.buildStrip(HIGHLIGHTER_COLORS, (c) => this.host.updateSettings({ highlighterColor: c }));
			} else {
				// Eraser / lasso: the reserved area shows the current mode (options: tap the tool again).
				this.caption = this.optionsEl.createDiv({ cls: "pl-caption" });
				onTap(this.caption, () => this.togglePopover(kind, this.toolBtns.get(kind)!));
			}
			this.updateOptions(s);
			this.revealActiveColor();
			return;
		}
		this.updateOptions(s);
	}

	private updateOptions(s: PencilSettings): void {
		const kind = this.optionsKind;
		if (kind === "eraser" || kind === "lasso") {
			if (!this.caption) return;
			const text =
				kind === "eraser"
					? `${s.eraserMode === "precise" ? `Precise · ${s.eraserSize.toUpperCase()}` : "Whole stroke"}${s.eraseHighlighterOnly ? " · highlighter only" : ""}`
					: s.lassoFilter === "both"
						? "Selects pen + highlighter"
						: s.lassoFilter === "pen"
							? "Selects pen only"
							: "Selects highlighter only";
			if (this.caption.textContent !== text) this.caption.setText(text);
			return;
		}
		if (kind !== "pen" && kind !== "highlighter") return;
		const pen = kind === "pen";
		const variant = pen ? s.penPreset : s.highlighterWidth;
		const color = cssColor(pen ? s.penColor : s.highlighterColor);
		for (const [k, { btn, sample }] of this.variantBtns) {
			btn.toggleClass("is-active", k === variant);
			sample.style.stroke = color;
		}
		const current = pen ? s.penColor : s.highlighterColor;
		for (const [v, b] of this.colorBtns) b.toggleClass("is-active", v === current);
	}

	private buildVariants<K extends string>(
		items: { key: K; label: string }[],
		select: (k: K) => void,
		style: (k: K, path: SVGPathElement) => void,
	): void {
		const group = this.optionsEl.createDiv({ cls: "pl-group pl-variants" });
		for (const it of items) {
			const btn = this.button(group, null, it.label, () => select(it.key));
			btn.addClass("pl-variant");
			const svg = group.ownerDocument.createElementNS(SVG_NS, "svg");
			svg.setAttribute("viewBox", "0 0 24 22");
			svg.setAttribute("class", "pl-sample");
			const path = group.ownerDocument.createElementNS(SVG_NS, "path");
			path.setAttribute("d", SAMPLE_PATH);
			path.setAttribute("fill", "none");
			path.setAttribute("stroke-linecap", "round");
			path.setAttribute("stroke-linejoin", "round");
			style(it.key, path);
			svg.appendChild(path);
			btn.appendChild(svg);
			this.variantBtns.set(it.key, { btn, sample: path });
		}
	}

	private buildStrip(colors: readonly PaletteColor[], select: (c: string) => void): void {
		const wrap = this.optionsEl.createDiv({ cls: "pl-strip-wrap" });
		const prevBtn = this.button(wrap, "chevron-left", "Scroll colors back", () => this.scrollStrip(-1));
		prevBtn.addClasses(["pl-strip-nav", "pl-strip-prev"]);
		const strip = wrap.createDiv({ cls: "pl-strip" });
		const vertical = () => this.shownOrientation === "vertical";
		// Desktop convenience: the wheel scrolls the strip along its axis.
		strip.addEventListener(
			"wheel",
			(e) => {
				const isVert = vertical();
				const total = isVert ? strip.scrollHeight : strip.scrollWidth;
				const client = isVert ? strip.clientHeight : strip.clientWidth;
				const delta = stripWheelDelta(e.deltaX, e.deltaY, e.deltaMode, client, isVert);
				if (!delta || total <= client) return;
				if (!isVert) {
					e.preventDefault();
					strip.scrollLeft += delta;
					this.updateStripScroll();
				} else if (e.deltaMode !== 0) {
					e.preventDefault();
					strip.scrollTop += delta;
					this.updateStripScroll();
				}
			},
			{ passive: false },
		);
		strip.addEventListener("scroll", () => this.updateStripScroll(), { passive: true });
		// The Pencil can't pan the strip natively (its touches are cancelled): scroll it by hand.
		let pan: { id: number; x: number; y: number; left: number; top: number; active: boolean } | null = null;
		strip.addEventListener("pointerdown", (e) => {
			pan = e.pointerType === "pen" ? { id: e.pointerId, x: e.clientX, y: e.clientY, left: strip.scrollLeft, top: strip.scrollTop, active: false } : null;
		});
		strip.addEventListener("pointermove", (e) => {
			if (!pan || e.pointerId !== pan.id) return;
			const dx = e.clientX - pan.x;
			const dy = e.clientY - pan.y;
			if (!pan.active && Math.hypot(dx, dy) < STRIP_SCROLL_MOVE) return;
			pan.active = true;
			if (vertical()) strip.scrollTop = pan.top - dy;
			else strip.scrollLeft = pan.left - dx;
		});
		const endPan = (e: PointerEvent) => {
			if (pan && e.pointerId === pan.id) pan = null;
		};
		strip.addEventListener("pointerup", endPan);
		strip.addEventListener("pointercancel", endPan);
		for (const c of colors) {
			const b = this.button(strip, null, c.label, () => select(c.value));
			b.addClass("pl-color");
			b.createSpan({ cls: "pl-color-dot" }).style.background = cssColor(c.value);
			this.colorBtns.set(c.value, b);
		}
		const nextBtn = this.button(wrap, "chevron-right", "Scroll colors forward", () => this.scrollStrip(1));
		nextBtn.addClasses(["pl-strip-nav", "pl-strip-next"]);
		this.stripWrap = wrap;
		this.strip = strip;
	}

	private scrollStrip(dir: -1 | 1): void {
		const strip = this.strip;
		if (!strip) return;
		const isVert = this.shownOrientation === "vertical";
		const client = isVert ? strip.clientHeight : strip.clientWidth;
		const step = Math.max(32, Math.floor(client * 0.75));
		if (typeof strip.scrollBy === "function") {
			strip.scrollBy({ left: isVert ? 0 : dir * step, top: isVert ? dir * step : 0, behavior: "smooth" });
		} else if (isVert) {
			strip.scrollTop += dir * step;
		} else {
			strip.scrollLeft += dir * step;
		}
		this.updateStripScroll();
	}

	/** Show scroll arrows / edge fades only for sides of `.pl-strip` that currently overflow. */
	private updateStripScroll(): void {
		const strip = this.strip;
		const wrap = this.stripWrap;
		if (!strip || !wrap) return;
		const isVert = this.shownOrientation === "vertical";
		const { canPrev, canNext } = stripScrollState(
			isVert ? strip.scrollTop : strip.scrollLeft,
			isVert ? strip.clientHeight : strip.clientWidth,
			isVert ? strip.scrollHeight : strip.scrollWidth,
		);
		wrap.toggleClass("can-scroll-prev", canPrev);
		wrap.toggleClass("can-scroll-next", canNext);
		strip.toggleClass("is-scrollable", canNext);
		strip.toggleClass("is-scrollable-prev", canPrev);
	}

	/** Scroll the strip (not the page) so the selected color is visible. */
	private revealActiveColor(): void {
		const strip = this.strip;
		if (!strip) return;
		const active = [...this.colorBtns.values()].find((b) => b.hasClass("is-active"));
		if (!active) return;
		if (this.shownOrientation === "vertical") {
			const top = active.offsetTop - strip.offsetTop;
			if (top + active.offsetHeight > strip.scrollTop + strip.clientHeight || top < strip.scrollTop) strip.scrollTop = top;
			this.updateStripScroll();
			return;
		}
		const left = active.offsetLeft - strip.offsetLeft;
		if (left + active.offsetWidth > strip.scrollLeft + strip.clientWidth || left < strip.scrollLeft) {
			strip.scrollLeft = left;
		}
		this.updateStripScroll();
	}

	// -------------------------------------------------------------------------------------------
	// Popovers: ⋯ and the Stage E tool settings
	// -------------------------------------------------------------------------------------------

	private togglePopover(kind: PopoverKind, anchor: HTMLElement): void {
		if (this.popoverKind === kind) {
			this.closePopover();
			return;
		}
		this.closePopover();
		const el = this.el.createDiv({ cls: `pl-popover pl-popover-${kind}`, attr: { role: "menu" } });
		this.popover = el;
		this.popoverKind = kind;
		el.dataset.anchor = kind;
		this.renderPopover(el, kind);
		this.placePopoverEl(el);
		anchor.addClass("is-open");
		if (kind === "geometry" || kind === "ruler") anchor.setAttribute("aria-expanded", "true");
		this.el.ownerDocument.addEventListener("pointerdown", this.onOutside, true);
	}

	/** Toggle the quick Apple Pencil tool palette popover (also triggered by bridged Squeeze). */
	togglePalette(): void {
		if (!this.host.getSettings().toolbarVisible) this.host.updateSettings({ toolbarVisible: true });
		if (this.host.isSlim()) return;
		const anchor = this.toolBtns.get(this.host.getSettings().tool) ?? this.moreBtn;
		this.togglePopover("palette", anchor);
	}

	private popoverAnchor(): HTMLElement | null {
		const k = this.popoverKind;
		if (!k) return null;
		if (k === "select") return this.selectBtn; // [Stage F]
		if (k === "snap") return this.grip; // [Stage M]
		if (k === "ruler") return this.rulerBtn;
		if (k === "geometry") return this.geometryBtn;
		if (k === "palette") return this.toolBtns.get(this.host.getSettings().tool) ?? this.moreBtn;
		return k === "more" ? this.moreBtn : (this.toolBtns.get(k) ?? null);
	}

	/** Next to the bar on the side with more room, centered on its button, inside the leaf. */
	private placePopoverEl(el: HTMLElement): void {
		const anchor = this.popoverAnchor();
		if (!anchor) return;
		const { top: areaTop, size } = this.area();
		el.style.maxHeight = `${Math.max(120, size.h - 16)}px`;
		const leafRect = this.leafEl.getBoundingClientRect();
		const rel = (r: DOMRect): Rect => ({ left: r.left - leafRect.left, top: r.top - leafRect.top - areaTop, w: r.width, h: r.height });
		const bar = rel(this.el.getBoundingClientRect());
		const side = popoverSide(this.shownOrientation ?? "horizontal", bar, size);
		const p = placePopover(side, bar, rel(anchor.getBoundingClientRect()), { w: el.offsetWidth, h: el.offsetHeight }, size);
		el.dataset.side = side;
		// The popover lives inside the toolbar element: convert to its coordinates.
		el.style.left = `${Math.round(p.left - bar.left)}px`;
		el.style.top = `${Math.round(p.top - bar.top)}px`;
	}

	private closePopover(): void {
		if (!this.popover) return;
		this.returnOptions();
		this.popoverAnchor()?.removeClass("is-open");
		if (this.popoverKind === "geometry") this.geometryBtn.setAttribute("aria-expanded", "false");
		if (this.popoverKind === "ruler") this.rulerBtn.setAttribute("aria-expanded", "false");
		this.popover.remove();
		this.popover = null;
		this.popoverKind = null;
		this.el.ownerDocument.removeEventListener("pointerdown", this.onOutside, true);
	}

	/** Pen, finger or mouse press outside the toolbar closes the popover (and still acts normally). */
	private readonly onOutside = (e: PointerEvent): void => {
		if ((e.target as Node | null)?.instanceOf(Node) && this.el.contains(e.target as Node)) return;
		this.closePopover();
	};

	/**
	 * [Stage M] Collapsed bar: the pen / highlighter popover hosts the bar's own options area
	 * (presets or widths + color swatches) above its settings — the same live element, moved, so the
	 * swatches render exactly as on the expanded bar. It goes back to the bar when the popover closes.
	 */
	private hostsOptions(kind: PopoverKind): boolean {
		const s = this.host.getSettings();
		return s.toolbarCollapsed && !this.host.isSlim() && (kind === "pen" || kind === "highlighter") && kind === s.tool;
	}

	private returnOptions(): void {
		if (this.optionsEl.parentElement === this.barEl) return;
		this.optionsEl.removeClass("is-hosted");
		this.optionsEndSep.before(this.optionsEl);
	}

	private renderPopover(el: HTMLElement, kind: PopoverKind): void {
		const hosted = this.hostsOptions(kind);
		if (!hosted) this.returnOptions();
		const strip = this.strip;
		const scroll = strip ? { left: strip.scrollLeft, top: strip.scrollTop } : null;
		el.empty();
		el.toggleClass("has-options", hosted);
		const s = this.host.getSettings();
		const set = (patch: Partial<PencilSettings>) => this.host.updateSettings(patch);
		switch (kind) {
			case "snap": // [Stage M] preset positions (long-press / right-click the grip)
				{
					this.title(el, "Move toolbar to");
					const current = currentSnapPreset(s.toolbarPos, s.toolbarEdge);
					for (const p of SNAP_PRESETS) {
						this.menuItem(el, p.icon, p.label, p.key === current, () => {
							const { pos, edge } = snapPreset(p.key);
							set({ toolbarPos: pos, toolbarEdge: edge });
						});
					}
				}
				break;
			case "more":
				this.menuItem(el, "sparkles", "Gemini KI-Assistent fragen", false, () => this.host.openAssistantForView(this.view));
				this.menuItem(el, "file-plus-2", "Weitere Seite anhängen (+ Platz)", false, () => this.host.addBlankPage(this.view));
				this.menuItem(el, s.inkVisible ? "eye-off" : "eye", s.inkVisible ? "Hide ink" : "Show ink", false, () =>
					set({ inkVisible: !s.inkVisible }),
				);
				// [Stage D]
				this.menuItem(el, "file-down", "Include ink in PDF export", s.includeInkInPdf, () => set({ includeInkInPdf: !s.includeInkInPdf }));
				// [Stage H] one-shot exports: the toggle above stays the default for Obsidian's own export.
				if (this.host.canExportPdf(this.view)) {
					this.menuItem(el, "file-pen-line", "Export PDF with ink", false, () => this.host.exportPdf(this.view, { include: true }));
					this.menuItem(el, "file-text", "Export PDF without ink", false, () => this.host.exportPdf(this.view, { include: false }));
					// The style that isn't the default, for this one export (ink per the toggle above).
					const other = otherStyle(s.defaultExportStyle);
					this.menuItem(el, other === "document" ? "file-type" : "palette", styleExportLabel(other), false, () =>
						this.host.exportPdf(this.view, { style: other }),
					);
				}
				if (this.host.showMouseToggle) {
					this.menuItem(el, "mouse-pointer-2", "Mouse draws", s.mouseDraws, () => set({ mouseDraws: !s.mouseDraws }));
				}
				if (s.toolbarPos || s.toolbarEdge !== "bottom") {
					this.menuItem(el, "move-down", "Move toolbar to bottom center", false, () =>
						set({ toolbarPos: null, toolbarEdge: "bottom" }),
					);
				}
				this.subtitle(el, "Zoom (auch 2-Finger-Pinch)");
				this.segmented(el, [
					{ label: "−", active: false, run: () => this.host.zoomOut(this.view) },
					{ label: formatZoomPercent(this.host.getZoom(this.view)), active: Math.abs(this.host.getZoom(this.view) - 1) < 0.01, run: () => this.host.resetZoom(this.view) },
					{ label: "+", active: false, run: () => this.host.zoomIn(this.view) },
				]);
				this.subtitle(el, "Page boundary guides");
				this.segmented(
					el,
					(["off", "A4", "A4-landscape"] as PageGuideFormat[]).map((f) => ({
						label: PAGE_GUIDE_LABELS[f],
						active: s.pageGuide === f,
						run: () => set({ pageGuide: f }),
					})),
				);
				this.segmented(
					el,
					(["A3", "A3-landscape", "Letter"] as PageGuideFormat[]).map((f) => ({
						label: PAGE_GUIDE_LABELS[f],
						active: s.pageGuide === f,
						run: () => set({ pageGuide: f }),
					})),
				);
				break;
			case "ruler":
				this.title(el, "Lineal & Zeichengeräte");
				this.segmented(el, [
					{
						label: "Aus",
						active: !s.ruler && !s.setSquare && !s.compass,
						run: () => {
							this.closePopover();
							set({ ruler: false, setSquare: false, compass: false });
						},
					},
					{
						label: "Lineal",
						active: s.ruler,
						run: () => set({ tool: "pen", penShape: "freehand", ruler: true, setSquare: false, compass: false, inkVisible: true }),
					},
					{
						label: "Geodreieck",
						active: s.setSquare,
						run: () => set({ tool: "pen", penShape: "freehand", ruler: false, setSquare: true, compass: false, inkVisible: true }),
					},
					{
						label: "Zirkel",
						active: s.compass,
						run: () => set({ tool: "pen", penShape: "freehand", ruler: false, setSquare: false, compass: true, inkVisible: true }),
					},
				]);
				if (s.ruler || s.setSquare) {
					const angle = s.ruler ? s.rulerAngle : s.setSquareAngle;
					const setAngle = (next: number) => set(s.ruler ? { rulerAngle: next } : { setSquareAngle: next });
					this.segmented(
						el,
						[
							{ label: "0°", active: Math.round(angle) === 0, run: () => setAngle(0) },
							{ label: "30°", active: Math.round(angle) === 30, run: () => setAngle(30) },
							{ label: "45°", active: Math.round(angle) === 45, run: () => setAngle(45) },
							{ label: "90°", active: Math.round(angle) === 90, run: () => setAngle(90) },
						],
						`Winkel (${Math.round(angle)}°)`,
					);
					this.segmented(el, [
						{ label: "−15°", active: false, run: () => setAngle((angle + 345) % 360) },
						{ label: "−5°", active: false, run: () => setAngle((angle + 355) % 360) },
						{ label: "+5°", active: false, run: () => setAngle((angle + 5) % 360) },
						{ label: "+15°", active: false, run: () => setAngle((angle + 15) % 360) },
					]);
					el.createDiv({
						cls: "pl-pop-hint",
						text: "Direkt auf dem Lineal ziehen zum Verschieben · am Drehgriff oder mit 2 Fingern drehen · Stift an der Kante anlegen.",
					});
				} else if (s.compass) {
					this.segmented(
						el,
						[60, 100, 140, 180].map((radius, i) => ({
							label: ["S", "M", "L", "XL"][i],
							active: s.compassRadius === radius,
							run: () => set({ compassRadius: radius }),
						})),
						`Radius (${Math.round((s.compassRadius / (96 / 2.54)) * 10) / 10} cm)`,
					);
					el.createDiv({
						cls: "pl-pop-hint",
						text: "Mittelpunkt verschieben · äußeren Griff ziehen für freien Radius · Stift am Kreis anlegen.",
					});
				}
				break;
			case "eraser":
				this.title(el, "Eraser");
				this.segmented(el, [
					{ label: "Whole stroke", active: s.eraserMode === "stroke", run: () => set({ eraserMode: "stroke" }) },
					{ label: "Precise", active: s.eraserMode === "precise", run: () => set({ eraserMode: "precise" }) },
				]);
				if (s.eraserMode === "precise") {
					this.segmented(
						el,
						(["s", "m", "l"] as const).map((k) => ({
							label: { s: "Small", m: "Medium", l: "Large" }[k],
							active: s.eraserSize === k,
							run: () => set({ eraserSize: k }),
						})),
						"Size",
					);
				}
				this.toggle(el, "Erase highlighter only", s.eraseHighlighterOnly, () => set({ eraseHighlighterOnly: !s.eraseHighlighterOnly }));
				this.subtitle(el, "Switch to the eraser by");
				this.toggle(el, "Double-tap with the Pencil tip", s.doubleTapEraser, () => set({ doubleTapEraser: !s.doubleTapEraser }));
				if (s.doubleTapEraser) {
					this.segmented(
						el,
						[
							{ label: "Eraser", active: s.doubleTapAction === "eraser", run: () => set({ doubleTapAction: "eraser" }) },
							{ label: "Previous", active: s.doubleTapAction === "previous-tool", run: () => set({ doubleTapAction: "previous-tool" }) },
							{ label: "Palette", active: s.doubleTapAction === "palette", run: () => set({ doubleTapAction: "palette" }) },
							{ label: "Undo", active: s.doubleTapAction === "undo", run: () => set({ doubleTapAction: "undo" }) },
						],
						"Double-tap action",
					);
				}
				this.toggle(el, "Scribbling over ink", s.scribbleErase, () => set({ scribbleErase: !s.scribbleErase }));
				break;
			case "geometry":
				this.title(el, "Geometry");
				this.subtitle(el, "Shapes");
				for (const row of SHAPE_ROWS) {
					this.segmented(el, row.map(([shape, label]) => ({ label, active: s.tool === "pen" && s.penShape === shape, run: () => {
						this.closePopover();
						set({ tool: "pen", penShape: shape });
					} })));
				}
				this.subtitle(el, "Lineale & Zeichengeräte");
				this.toggle(el, "Lineal (gerade)", s.ruler, () =>
					set(s.ruler ? { ruler: false } : { tool: "pen", penShape: "freehand", ruler: true, setSquare: false, compass: false, inkVisible: true }),
				);
				this.toggle(el, "Geodreieck", s.setSquare, () =>
					set(s.setSquare ? { setSquare: false } : { tool: "pen", penShape: "freehand", ruler: false, setSquare: true, compass: false, inkVisible: true }),
				);
				this.toggle(el, "Zirkel", s.compass, () =>
					set(s.compass ? { compass: false } : { tool: "pen", penShape: "freehand", ruler: false, setSquare: false, compass: true, inkVisible: true }),
				);
				this.subtitle(el, "Page limits (PDF preview)");
				this.segmented(
					el,
					(["off", "A4", "A4-landscape"] as PageGuideFormat[]).map((f) => ({
						label: PAGE_GUIDE_LABELS[f],
						active: s.pageGuide === f,
						run: () => set({ pageGuide: f }),
					})),
				);
				this.segmented(
					el,
					(["A3", "A3-landscape", "Letter"] as PageGuideFormat[]).map((f) => ({
						label: PAGE_GUIDE_LABELS[f],
						active: s.pageGuide === f,
						run: () => set({ pageGuide: f }),
					})),
				);
				break;
			case "pen":
				this.title(el, "Pen");
				this.segmented(
					el,
					[
						{ label: "Ballpoint", active: s.penFeel === "ball", run: () => set({ penFeel: "ball" }) },
						{ label: "Fountain", active: s.penFeel === "notes", run: () => set({ penFeel: "notes" }) },
						{ label: "Pencil", active: s.penFeel === "pencil", run: () => set({ penFeel: "pencil" }) },
					],
					"Pen type",
				);
				this.segmented(
					el,
					[
						{ label: "Marker", active: s.penFeel === "marker", run: () => set({ penFeel: "marker" }) },
						{ label: "Calligraphy", active: s.penFeel === "calligraphy", run: () => set({ penFeel: "calligraphy" }) },
					],
				);
				this.toggle(el, "Tilt shading (Neigung)", s.tiltShading, () => set({ tiltShading: !s.tiltShading }));
				this.toggle(el, "Formula mode (auto LaTeX)", s.mathMode, () => set({ mathMode: !s.mathMode }));
				this.segmented(
					el,
					SMOOTHING_LEVELS.map((l) => ({ label: SMOOTHING_LABELS[l], active: s.smoothing === l, run: () => set({ smoothing: l }) })),
					"Smoothing",
				);
				this.toggle(el, "Snap to shape (draw and hold)", s.shapeSnap, () => set({ shapeSnap: !s.shapeSnap }));
				if (s.shapeSnap) {
					this.segmented(
						el,
						HOLD_MS_CHOICES.map((ms) => ({
							label: `${ms / 1000} s`,
							active: s.shapeHoldMs === ms,
							run: () => set({ shapeHoldMs: ms }),
						})),
						"Hold for",
					);
				}
				break;
			case "highlighter":
				this.title(el, "Highlighter");
				this.toggle(el, "Snap to text", s.highlighterSnapText, () => set({ highlighterSnapText: !s.highlighterSnapText }));
				this.toggle(el, "Straight line", s.highlighterStraight, () => set({ highlighterStraight: !s.highlighterStraight }));
				if (!hosted) {
					// Hosted: the width buttons are already at the top of the popover.
					this.segmented(
						el,
						HL_WIDTHS.map((w) => ({
							label: w.key === "normal" ? "Normal" : "Wide",
							active: s.highlighterWidth === w.key,
							run: () => set({ highlighterWidth: w.key }),
						})),
						"Width",
					);
				}
				break;
			case "select": // [Stage F] desktop Select tool
				this.title(el, "Select");
				this.segmented(el, [
					{ label: "Rectangle", active: s.selectMode === "rect", run: () => set({ selectMode: "rect" }) },
					{ label: "Freeform", active: s.selectMode === "lasso", run: () => set({ selectMode: "lasso" }) },
				]);
				this.segmented(
					el,
					[
						{ label: "Both", active: s.lassoFilter === "both", run: () => set({ lassoFilter: "both" }) },
						{ label: "Pen", active: s.lassoFilter === "pen", run: () => set({ lassoFilter: "pen" }) },
						{ label: "Highlighter", active: s.lassoFilter === "highlighter", run: () => set({ lassoFilter: "highlighter" }) },
					],
					"Selects",
				);
				el.createDiv({ cls: "pl-pop-hint", text: SELECT_HINT });
				this.menuItem(el, "text-cursor", "Done — back to the text cursor", false, () => this.host.setDeskSelect(false));
				break;
			case "lasso":
				this.title(el, "Lasso selects");
				this.segmented(el, [
					{ label: "Both", active: s.lassoFilter === "both", run: () => set({ lassoFilter: "both" }) },
					{ label: "Pen", active: s.lassoFilter === "pen", run: () => set({ lassoFilter: "pen" }) },
					{ label: "Highlighter", active: s.lassoFilter === "highlighter", run: () => set({ lassoFilter: "highlighter" }) },
				]);
				break;
			case "palette": {
				this.title(el, "Quick palette");
				this.segmented(
					el,
					[
						{ label: "Pen", active: s.tool === "pen", run: () => set({ tool: "pen" }) },
						{ label: "Eraser", active: s.tool === "eraser", run: () => set({ tool: "eraser" }) },
						{ label: "Highlight", active: s.tool === "highlighter", run: () => set({ tool: "highlighter" }) },
						{ label: "Lasso", active: s.tool === "lasso", run: () => set({ tool: "lasso" }) },
					],
					"Tool",
				);
				if (s.tool === "pen") {
					this.segmented(
						el,
						[
							{ label: "Ballpoint", active: s.penFeel === "ball", run: () => set({ penFeel: "ball" }) },
							{ label: "Fountain", active: s.penFeel === "notes", run: () => set({ penFeel: "notes" }) },
							{ label: "Pencil", active: s.penFeel === "pencil", run: () => set({ penFeel: "pencil" }) },
						],
						"Pen type",
					);
					this.segmented(
						el,
						[
							{ label: "Marker", active: s.penFeel === "marker", run: () => set({ penFeel: "marker" }) },
							{ label: "Calligraphy", active: s.penFeel === "calligraphy", run: () => set({ penFeel: "calligraphy" }) },
						],
					);
					this.renderPaletteSwatches(el, PEN_COLORS, s.penColor, (c) => set({ penColor: c }));
				} else if (s.tool === "highlighter") {
					this.renderPaletteSwatches(el, HIGHLIGHTER_COLORS, s.highlighterColor, (c) => set({ highlighterColor: c }));
				}
				this.menuItem(el, "undo-2", "Undo ink", false, () => this.host.undoInk(this.view));
				this.toggle(el, "Formula mode (auto LaTeX)", s.mathMode, () => set({ mathMode: !s.mathMode }));
				break;
			}
		}
		if (hosted) {
			// Right below the title: presets/widths + colors first, as on the expanded bar.
			this.optionsEl.addClass("is-hosted");
			const title = el.querySelector(":scope > .pl-pop-title");
			if (title) title.after(this.optionsEl);
			else el.prepend(this.optionsEl);
			if (strip && scroll && this.strip === strip) {
				strip.scrollLeft = scroll.left;
				strip.scrollTop = scroll.top;
			}
		}
		if (this.popover === el) this.placePopoverEl(el);
	}

	private title(parent: HTMLElement, text: string): void {
		parent.createDiv({ cls: "pl-pop-title", text });
	}

	private subtitle(parent: HTMLElement, text: string): void {
		parent.createDiv({ cls: "pl-pop-subtitle", text });
	}

	private renderPaletteSwatches(parent: HTMLElement, colors: readonly PaletteColor[], current: string, select: (c: string) => void): void {
		const row = parent.createDiv({ cls: "pl-pop-row" });
		row.createDiv({ cls: "pl-pop-label", text: "Color" });
		const grid = row.createDiv({ cls: "pl-palette-colors" });
		for (const c of colors) {
			const b = this.button(grid, null, c.label, () => select(c.value));
			b.addClass("pl-color");
			b.toggleClass("is-active", c.value === current);
			b.createSpan({ cls: "pl-color-dot" }).style.background = cssColor(c.value);
		}
	}

	/** A row of mutually exclusive choices (GoodNotes-style segmented control). */
	private segmented(parent: HTMLElement, items: { label: string; active: boolean; run: () => void }[], label?: string): void {
		const row = parent.createDiv({ cls: "pl-pop-row" });
		if (label) row.createDiv({ cls: "pl-pop-label", text: label });
		const seg = row.createDiv({ cls: "pl-seg", attr: { role: "radiogroup" } });
		for (const it of items) {
			const b = seg.createDiv({
				cls: "pl-seg-item",
				text: it.label,
				attr: { role: "radio", tabindex: "-1", "aria-checked": String(it.active) },
			});
			if (it.active) b.addClass("is-active");
			onTap(b, () => {
				if (!it.active) it.run();
			});
		}
	}

	/** A labeled on/off switch; the whole row toggles. */
	private toggle(parent: HTMLElement, label: string, on: boolean, run: () => void): void {
		const row = parent.createDiv({
			cls: "pl-pop-toggle",
			attr: { role: "switch", tabindex: "-1", "aria-checked": String(on) },
		});
		row.createSpan({ cls: "pl-pop-toggle-label", text: label });
		row.createDiv({ cls: `pl-switch${on ? " is-on" : ""}` });
		onTap(row, run);
	}

	private menuItem(parent: HTMLElement, icon: string, label: string, checked: boolean, run: () => void): void {
		const item = parent.createDiv({ cls: "pl-menu-item", attr: { role: "menuitem", tabindex: "-1" } });
		setIcon(item.createSpan({ cls: "pl-menu-icon" }), icon);
		item.createSpan({ text: label });
		if (checked) {
			item.addClass("is-active");
			setIcon(item.createSpan({ cls: "pl-menu-check" }), "check");
		}
		onTap(item, () => {
			this.closePopover();
			run();
		});
	}

	// -------------------------------------------------------------------------------------------
	// Buttons
	// -------------------------------------------------------------------------------------------

	private toolButton(parent: HTMLElement, tool: ActiveTool): void {
		const b = this.button(parent, TOOL_ICONS[tool], TOOL_LABELS[tool], () => {
			const r = toolTap(this.host.getSettings().tool, tool);
			if ("popover" in r) {
				this.togglePopover(r.popover, b);
			} else {
				this.closePopover();
				this.host.updateSettings({ tool: r.select });
			}
		});
		b.addClass("pl-tool");
		b.dataset.tool = tool;
		this.toolBtns.set(tool, b);
	}

	private setDisabled(el: HTMLElement, disabled: boolean): void {
		el.toggleClass("is-disabled", disabled);
		el.setAttribute("aria-disabled", String(disabled));
	}

	private button(parent: HTMLElement, icon: string | null, label: string, onClick: () => void): HTMLElement {
		const b = parent.createDiv({ cls: "pl-btn clickable-icon", attr: { role: "button", tabindex: "-1" } });
		if (icon) setIcon(b, icon);
		b.setAttribute("aria-label", label);
		setTooltip(b, label, { placement: "top" });
		onTap(b, () => {
			if (!b.hasClass("is-disabled")) onClick();
		});
		return b;
	}
}

/** [Stage F] Select tool icon and the keyboard hint in its popover. */
const SELECT_ICON = "square-dashed-mouse-pointer";
const SELECT_HINT =
	"Click a stroke or drag around ink. Click empty space (or Esc twice) to go back to typing · Delete removes · ⌘/Ctrl C, X, V, D copy, cut, paste, duplicate";
const SELECT_OFF_LABEL = "Select ink: drag a rectangle or click a stroke (tap again for options)";
const SELECT_ON_LABEL = "Select is on — click empty space in the note to type again (tap for options)";

/** Touch events swallowed while the toolbar is being dragged. */
const DRAG_GUARDED = ["touchstart", "touchmove", "touchend", "touchcancel"] as const;

function stopTouch(e: Event): void {
	if (e.cancelable) e.preventDefault();
	e.stopPropagation();
}
