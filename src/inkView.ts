/**
 * CM6 ViewPlugin: the ink overlay for one editor view — rendering, pen/mouse input, eraser (whole
 * stroke or precise), draw-and-hold shape snapping, straight highlighter, lasso selection (filtered
 * by tool), Pencil double-tap and scribble-to-erase.
 *
 * Follows the InkStore contract (see store.ts header): subscribe → load → resolve `pos` from anchors
 * → render; map positions on every doc change (position owner only) and refresh anchors in
 * `beforeSave`.
 *
 * Coordinates: the overlay SVG is absolutely positioned inside `view.scrollDOM` so that its (0,0) is
 * the left edge of the `.cm-content` text area at `view.documentTop`. Overlay coordinates are
 * therefore "document coordinates" (same space as `BlockInfo.top`), and the overlay scrolls with the
 * content. Stored stroke points are relative to (content left, anchor line top); a rendered path is
 * the cached local-space path translated by the anchor line's top.
 *
 * Performance (iPad): pointermove only appends points and bookkeeping; drawing happens once per
 * animation frame. The shape recognizer runs once when the pen has been still for the hold delay;
 * the scribble preview is throttled; lasso drags only update SVG transforms until the pen lifts.
 */
import { EditorView, PluginValue, ViewPlugin, ViewUpdate, keymap } from "@codemirror/view";
import { Prec } from "@codemirror/state";
import type { Extension, Text } from "@codemirror/state";
import { Notice, Platform, editorInfoField, setIcon, setTooltip } from "obsidian";
import { InkFile, InkSpace, PenStyle, Point, SPACE_INK_PAD, Stroke, Tool, hashLine, isEmptyInk, newId, resolveAnchor, spaceInkBottoms } from "./model";
import { BBox, bbox, dashArray, hitTestStrokeSegment, isCenterline, isDashed, strokeToPath } from "./geometry";
import {
	CurveBuilder,
	DASH_MIN_DISTANCE,
	SMOOTHING_PARAMS,
	SPoint,
	StrokeSmoother,
	LIFT_SIGMA,
	finishPoints,
	polylinePath,
} from "./smoothing";
import type { InkListener, InkStore, SpaceEdit } from "./store";
import {
	ActiveTool,
	ERASER_RADII,
	HIGHLIGHTER_COLORS,
	PEN_COLORS,
	PencilSettings,
	STROKE_ERASER_RADIUS,
	erasable,
	lassoSelects,
	strokeParams,
} from "./settings";
import { erasePieces } from "./erase";
import { straightLine } from "./highlight";
import { isPenEraser, toolForPress } from "./penInput";
import { blockStylusTouch, onTap } from "./tap";
import { DrawShape, ShapeSpec, XY, adjustShape, draggedShape, recognizeShape, shapeToPoints } from "./shapes";
import { GuideEdge, nearestGuideEdge, projectToEdge, setSquareEdges } from "./geometryGuide";
import {
	RecentInk,
	ScribbleTarget,
	ScribbleTracker,
	Tap,
	canPair,
	isDoubleTap,
	isFirstTap,
	pruneRecentInk,
	TAP,
} from "./gestures";
import {
	IDENTITY,
	SelectionHit,
	SelectionTransform,
	handleScale,
	hitSelection,
	isIdentity,
	scaledSize,
	selectInLasso,
	svgTransform,
	transformBox,
	transformPoints,
} from "./lasso";
import { InkClip, makeClip, pasteOrigin, placeClip } from "./clipboard";
import { MenuState, menuForSelection, placeMenu } from "./menu";
import { embedInsertion, rectFromBox, stageRect } from "./crop";
import { ScreenshotSource, copyPngToClipboard, freeCanvas, rasterizeEditorText, renderInkCanvas } from "./screenshot";
import type { RenderStroke } from "./inkRender";
import { TextHighlights } from "./textHighlightView"; // [Stage C]
import { inkColor } from "./inkColor"; // [Stage L]
import { CharAnchors } from "./charAnchorView"; // [Stage H]
import { CLICK_MOVE, CLICK_TOLERANCE, DeskTarget, InkKeyAction, deskPress, deskRegionRelease, pickTopmost, rectPolygon, strokeNear } from "./select"; // [Stage F/H]
import type { SelectMode } from "./settings"; // [Stage F]
import { MovedSpace, SpaceActions, SpaceBox, SpaceControls, SpaceSpec, currentSpecs, expectSpaceMove, sameSpecs, setSpaces, spaceField, spaceLayout, spaceMove, spaceMoveHistory, spacesChanged } from "./spaceView"; // [Stage K]
import { LaidLine, SPACE_CLIP_TEXT, SpaceRect, blockEnds, boundSpaceY, defaultSpaceHeight, endSpacePlan, enterOpensBelow, groupSpace, grownHeight, isSpaceClipText, blankRunAbove, blankRunBelow, openBelowInsert, planMakeSpace, resizedHeight, sameClipText, spaceAt, spaceInRange, spaceSize } from "./spaces"; // [Stage K]

export type { ActiveTool } from "./settings";

/** The settings the ink view needs. */
export type InkSettings = PencilSettings;

/** What the plugin provides to every ink view. */
export interface InkHost {
	readonly store: InkStore;
	getSettings(): InkSettings;
	/** True while a vault rename to `newPath` is being processed by the store. */
	isRenaming(newPath: string): boolean;
	/** The user started drawing while ink is hidden: make it visible again. */
	showInk(): void;
	/** Pencil double-tap: current tool ↔ eraser. */
	toggleEraser(): void;
	registerInkView(v: InkView): void;
	unregisterInkView(v: InkView): void;
	/** Plugin-internal ink clipboard (shared by all notes). */
	clipboard: InkClip | null;
	/** Copied/cut drawing space (shared by all notes, session only). */
	spaceClip: SpaceClip | null;
	/** Open the screenshot modal. */
	openScreenshot(src: ScreenshotSource): void;
	// [Stage F] desktop Select tool
	/** The desktop Select tool's mode while it is active (mouse selects ink), else null. */
	deskSelect(): SelectMode | null;
	/** May a selection exist right now (lasso tool, or the desktop Select tool)? */
	selectionToolActive(): boolean;
	/** A desktop selection was made in `v`: other views deselect, its leaf becomes active. */
	deskSelectionMade(v: InkView): void;
	/** [Stage H] Turn the desktop Select tool off (deselects everywhere, toolbars follow). */
	exitDeskSelect(): void;
	/** A selection appeared or went away (keyboard shortcuts follow). */
	inkSelectionChanged(): void;
	/** [Stage K] Ask before deleting a drawing space that has ink in it. */
	confirmDeleteSpace(strokes: number): Promise<boolean>;
	/** A pen touched a note (desktop: from now on this device gets the full drawing toolbar). */
	penSeen(): void;
}

/** One drawing space on the clipboard: its height and its ink (points relative to the space top). */
export interface ClipSpace {
	/** Line it follows, relative to the first line of the copied text (0 for a "⋯" Copy/Cut). */
	rel: number;
	height: number;
	a4?: true;
	strokes: (Pick<Stroke, "tool" | "color" | "size" | "style" | "shape"> & { points: Point[] })[];
}

/**
 * Drawing spaces on the clipboard, with the text that went to the system clipboard with them:
 * `SPACE_CLIP_TEXT` for a "⋯" Copy/Cut (pasting it pastes just the drawing), or the selected text
 * for an editor Cut/Copy whose selection held drawings (pasting that text brings them along).
 */
export interface SpaceClip {
	text: string;
	spaces: ClipSpace[];
}

const SVG_NS = "http://www.w3.org/2000/svg";
/** Extra margin (px) around the CM viewport within which strokes are rendered. */
const CULL_MARGIN = 400;
/** How long compat mouse events are swallowed after a pen/mouse ink stroke ends. */
const SUPPRESS_MS = 600;
/** The pen counts as "still" for snap-to-shape while it stays within this radius (px). */
const HOLD_TOLERANCE = 4;
/** Scribble preview (fading candidates) is recomputed at most this often (ms). */
const SCRIBBLE_PREVIEW_MS = 120;
/** Selection box padding, resize-handle hit radius and duplicate offset (px). */
const SEL_PAD = 6;
const HANDLE_HIT = 18;
const DUPLICATE_OFFSET = 16;
/** A finger tap (for "tap outside → deselect"): max duration (ms) and movement (px). */
const FINGER_TAP_MS = 300;
const FINGER_TAP_MOVE = 10;
/** A press on the selection that moves less than this (px) is a tap: it toggles the menu. */
const SEL_TAP_MOVE = 6;
/** Lasso long-press (pen still) that offers Paste: duration (ms) and max movement (px). */
const LONG_PRESS_MS = 500;
const LONG_PRESS_MOVE = 6;
/** Pixels per CSS px of the PNG put on the system clipboard by Copy/Cut. */
const CLIPBOARD_PNG_SCALE = 2;
/** [Stage K] A stroke must start this far below the note's end (px) to go into an end space. */
const END_SPACE_SLACK = 12;

/**
 * Resolve a stroke color to a CSS paint value for the screen. [Stage L] Theme-adaptive (inkColor.ts):
 * "ink" / near-black follow the theme text color in dark mode, near-white in light mode, via CSS
 * variables, so a theme switch recolors live. Also used by the toolbar swatches.
 */
export function cssColor(color: string, tool?: string): string {
	return inkColor(color, "screen", tool);
}

interface CachedShape {
	d: string;
	/** Local-space bbox, padded by the stroke width. */
	box: BBox;
}
/**
 * Paint an ink path element: ballpoint/dashed pens are stroked centerlines, everything else is a
 * filled outline. `color` is a stroke color value ("ink" or CSS).
 */
function paint(el: SVGPathElement, s: Pick<Stroke, "tool" | "style" | "size" | "color">): void {
	const color = cssColor(s.color, s.tool);
	const centerline = isCenterline(s);
	el.setCssProps({ fill: centerline ? "none" : color, stroke: centerline ? color : "" });
	if (centerline) {
		el.setAttribute("stroke-width", String(s.size));
		el.setAttribute("stroke-linecap", "round");
		el.setAttribute("stroke-linejoin", "round");
		const dash = dashArray(s);
		if (dash) el.setAttribute("stroke-dasharray", dash);
	}
}

/** Shared across views: strokes are immutable apart from `pos`/`anchor`. */
const shapeCache = new WeakMap<Stroke, CachedShape>();

function shapeOf(s: Stroke): CachedShape {
	let c = shapeCache.get(s);
	if (!c) {
		const b = bbox(s.points) ?? { minX: 0, minY: 0, maxX: 0, maxY: 0 };
		const pad = s.size;
		c = {
			d: strokeToPath(s),
			box: { minX: b.minX - pad, minY: b.minY - pad, maxX: b.maxX + pad, maxY: b.maxY + pad },
		};
		shapeCache.set(s, c);
	}
	return c;
}

interface Geometry {
	/** Overlay origin, in scrollDOM content coordinates (CSS px). */
	left: number;
	top: number;
	/** Width of the content text area. */
	width: number;
	/** Height from documentTop to the bottom of `.cm-content`. */
	height: number;
}

/** A space (or a new "end" space: id null) and the blank lines above it that join it. */
interface AbsorbTarget {
	S: { id: string | null; top: number; height: number };
	/** 0-based text line the new space follows. */
	after: number;
	/** Document y of the first blank line (the new space's top). */
	top: number;
	/** Line-anchored ink on the blank lines. */
	margin: Stroke[];
}

/** A stroke started on blank lines above a space must reach this far into it to join it (px). */
const CROSS_INTO = 4;

/** Bookkeeping shared by inputs that may turn out to be a Pencil tap. */
interface TapTrack {
	pointerId: number;
	/** Pen (not mouse): eligible for double-tap. */
	pen: boolean;
	downAt: number;
	downX: number;
	downY: number;
	maxMove: number;
	/** A pending first tap this contact may complete into a double tap. */
	pairWith: PendingTap | null;
}

interface DrawInput extends TapTrack {
	kind: "draw";
	tool: Tool;
	color: string;
	size: number;
	style?: PenStyle;
	/**
	 * Overlay coordinates. While drawing freehand: the smoother's filtered points (shared array);
	 * after a snap: the shape's points; after lift: the final points (`finalized`).
	 */
	points: Point[];
	/** Input filter (One Euro + min distance); its raw tip is drawn as the stroke's end. */
	smoother: StrokeSmoother;
	/** Incremental live path for centerline styles (null: perfect-freehand styles). */
	curve: CurveBuilder | null;
	/** How many filtered points were handed to `curve`; the last point given to it. */
	curveFed: number;
	curveLast: SPoint | null;
	/** `points` hold the final (lift-refined) points. */
	finalized: boolean;
	el: SVGPathElement;
	/** Snap to shape: where the pen last settled and since when. */
	holdX: number;
	holdY: number;
	lastMoveAt: number;
	holdTimer: number | null;
	/** Recognition already ran for the current still period. */
	holdTried: boolean;
	/** Snapped shape being adjusted while the pen stays down. */
	snap: { spec0: ShapeSpec; spec: ShapeSpec; p0: XY; pen: XY | null } | null;
	geometry: { shape: Exclude<DrawShape, "freehand">; start: XY; edge: GuideEdge | null; end: XY | null } | null;
	/** Straight-line highlighter: the start point (points = start → pen). */
	straight: XY | null;
	lastScribbleCheck: number;
	/** Scribble-to-erase state for this stroke: the preview shows, and lift erases, its ids. */
	scribble: ScribbleTracker;
	/** [Stage K] The drawing space the stroke started in (its top, document y), or null. */
	space: { id: string; top: number; fixedHeight?: number } | null;
}

interface EraseInput extends TapTrack {
	kind: "erase";
	batchId: string;
	lastX: number;
	lastY: number;
	/** Pen double-tap enabled: nothing is erased until the contact is clearly not a tap. */
	deferred: boolean;
	/** Only highlighter strokes are erased. */
	highlighterOnly: boolean;
	/** Precise eraser state (null: whole-stroke eraser). */
	precise: PreciseErase | null;
}

/**
 * Precise eraser drag: the current pieces (overlay coordinates) of every stroke touched so far.
 * Originals are hidden and their pieces drawn live; on lift ONE `replaceStrokes` op swaps them.
 */
interface PreciseErase {
	radius: number;
	pieces: Map<Stroke, Point[][]>;
	els: Map<Stroke, SVGPathElement[]>;
}

interface LassoInput extends TapTrack {
	kind: "lasso";
	points: XY[];
	el: SVGPathElement;
	/** A selection / a menu existed when the pen went down (a tap then only dismisses it). */
	hadSelection: boolean;
	menuWasOpen: boolean;
	/** Long-press → Paste. */
	pressTimer: number | null;
	longPressed: boolean;
	/** [Stage F] Desktop Select tool (mouse): `rect` = rectangle drag (points = [start, current]). */
	desk: boolean;
	rect: boolean;
}

interface DragInput {
	kind: "drag";
	pointerId: number;
	mode: "move" | "scale";
	start: XY;
	cur: XY;
	/** Fixed top-left corner (scale origin) and the handle position at grab time. */
	origin: XY;
	handle: XY;
	/** Largest distance from `start` so far (a tap toggles the menu instead of moving). */
	maxMove: number;
}


type ActiveInput = DrawInput | EraseInput | LassoInput | DragInput;

interface PendingTap {
	tap: Tap;
	timer: number;
	commit: () => void;
	discard: () => void;
}

function svgEl<K extends keyof SVGElementTagNameMap>(tag: K, cls?: string): SVGElementTagNameMap[K] {
	const el = activeDocument.createElementNS(SVG_NS, tag);
	if (cls) el.setAttribute("class", cls);
	return el;
}

/** Event timestamp (ms) for the input filter; falls back to now when the platform gives none. */
function eventTime(e: Event): number {
	const t = e.timeStamp;
	return typeof t === "number" && t > 0 ? t : performance.now();
}

function lineSource(doc: Text) {
	return { count: doc.lines, get: (i: number) => doc.line(i + 1).text };
}

function clampPos(doc: Text, pos: number): number {
	return Math.min(Math.max(pos, 0), doc.length);
}

/** Does this update replace the entire previous document (file reload / switch via transaction)? */
function replacesWholeDoc(u: ViewUpdate): boolean {
	const len = u.startState.doc.length;
	if (len === 0) return false;
	let whole = false;
	u.changes.iterChangedRanges((fromA, toA) => {
		if (fromA === 0 && toA === len) whole = true;
	});
	return whole;
}

export class InkView implements PluginValue {
	private path: string | null = null;
	/** A path whose note was deleted; never re-subscribe to it from this view. */
	private deadPath: string | null = null;
	private unsub: (() => void) | null = null;
	private attachToken = 0;
	private switchTimer: number | null = null;
	private destroyed = false;

	private readonly svg: SVGSVGElement;
	private readonly gHl: SVGGElement;
	private readonly gHlLive: SVGGElement;
	private readonly gPen: SVGGElement;
	private readonly gPenLive: SVGGElement;
	/** Lasso loop and selection box (above the ink). */
	private readonly gUi: SVGGElement;
	private readonly selRect: SVGRectElement;
	private readonly selHandle: SVGCircleElement;
	/** Context menu (HTML, inside scrollDOM so it scrolls along with the note). */
	private menuEl: HTMLElement | null = null;
	private menu: MenuState | null = null;
	/** Target + contents the menu was last placed for (it is not re-placed while scrolling). */
	private menuKey = "";
	private geo: Geometry | null = null;

	/** Currently rendered strokes → element, the line top and the transform applied. */
	private readonly rendered = new Map<Stroke, { el: SVGPathElement; top: number; x: number; tf: string }>();
	private renderedHl: Stroke[] = [];
	private renderedPen: Stroke[] = [];
	/** Live paths of finished strokes, removed on the next render (avoids a blank frame). */
	private pendingLive: SVGPathElement[] = [];
	/** Elements faded as scribble-erase candidates. */
	private faded: SVGPathElement[] = [];

	private active: ActiveInput | null = null;
	private raf = 0;
	private suppressUntil = 0;
	private pendingTap: PendingTap | null = null;
	/** Ink finished recently (overlay bbox + time): taps near it are handwriting, not a double tap. */
	private recentInk: RecentInk[] = [];
	/** Eraser position while erasing. */
	private readonly eraserCursor: SVGCircleElement;
	private readonly guideOutline: SVGPathElement;
	private readonly guideGrip: SVGCircleElement;
	private guideOrigin: XY | null = null;
	private guideDrag: { id: number; offset: XY } | null = null;

	/** Lasso selection (strokes on the canvas) and the live drag transform. */
	private selection: Stroke[] | null = null;
	private dragT: SelectionTransform | null = null;
	/** Finger down outside the selection: a quick tap deselects (a scroll does not). */
	private fingerTap: { id: number; x: number; y: number; t: number } | null = null;
	/** [Stage C] Highlighter strokes snapped to typed text (textHighlightView.ts). */
	private readonly textHl: TextHighlights;
	/** [Stage H] Ink anchored to a character of typed text (charAnchorView.ts). */
	private readonly charA: CharAnchors;
	/** [Stage K] Drawing space controls (⋯ menu, resize handle). */
	private readonly spaceUi: SpaceControls;
	/** [Stage K] Heights shown while drawing near a space's bottom / dragging its handle (not saved yet). */
	private readonly liveHeights = new Map<string, number>();
	/** [Stage F] Last mouse position over the overlay (paste target) and the pending hover check. */
	private hoverAt: XY | null = null;
	private hoverRaf = 0;
	private hoverCursor = "";

	constructor(
		readonly view: EditorView,
		private readonly host: InkHost,
	) {
		this.svg = svgEl("svg", "pencil-layer-overlay");
		this.svg.setAttribute("aria-hidden", "true");
		this.gHl = svgEl("g", "pl-hl");
		this.gHlLive = svgEl("g", "pl-hl pl-live");
		this.gPen = svgEl("g", "pl-pen");
		this.gPenLive = svgEl("g", "pl-pen pl-live");
		this.textHl = new TextHighlights(view); // [Stage C]
		this.charA = new CharAnchors(view); // [Stage H]
		this.spaceUi = new SpaceControls(view, this.spaceActions); // [Stage K]
		this.gUi = svgEl("g", "pl-ui");
		this.selRect = svgEl("rect", "pl-sel-box");
		this.selHandle = svgEl("circle", "pl-sel-handle");
		this.selHandle.setAttribute("r", "7");
		this.selRect.classList.add("pl-hidden");
		this.selHandle.classList.add("pl-hidden");
		this.eraserCursor = svgEl("circle", "pl-eraser-cursor");
		this.eraserCursor.classList.add("pl-hidden");
		this.guideOutline = svgEl("path", "pl-set-square pl-hidden");
		this.guideGrip = svgEl("circle", "pl-set-square-grip pl-hidden");
		this.guideGrip.setAttribute("r", "14");
		this.guideGrip.setAttribute("aria-label", "Move set square");
		this.guideGrip.addEventListener("pointerdown", this.onGuideDown);
		this.guideGrip.addEventListener("pointermove", this.onGuideMove);
		for (const event of ["pointerup", "pointercancel", "lostpointercapture"] as const) {
			this.guideGrip.addEventListener(event, this.onGuideEnd);
		}
		this.gUi.append(this.guideOutline, this.guideGrip, this.selRect, this.selHandle, this.eraserCursor);
		this.svg.append(this.gHl, this.gHlLive, this.gPen, this.gPenLive, this.gUi);
		view.scrollDOM.appendChild(this.svg);

		const sd = view.scrollDOM;
		const cap = { capture: true };
		const capActive = { capture: true, passive: false };
		sd.addEventListener("pointerdown", this.onPointerDown, cap);
		view.contentDOM.addEventListener("paste", this.onPasteCapture, true); // copied/cut drawing space
		view.contentDOM.addEventListener("copy", this.onCopyCutCapture, true);
		view.contentDOM.addEventListener("cut", this.onCopyCutCapture, true);
		sd.addEventListener("pointermove", this.onPointerMove, cap);
		sd.addEventListener("pointerup", this.onPointerEnd, cap);
		sd.addEventListener("pointercancel", this.onPointerEnd, cap);
		sd.addEventListener("lostpointercapture", this.onPointerEnd, cap);
		sd.addEventListener("pointerleave", this.onPointerLeave);
		sd.addEventListener("touchstart", this.onTouch, capActive);
		sd.addEventListener("touchmove", this.onTouch, capActive);
		sd.addEventListener("touchend", this.onTouch, capActive);
		sd.addEventListener("touchcancel", this.onTouch, capActive);
		for (const t of SUPPRESSED) sd.addEventListener(t, this.onCompatMouse, capActive);

		host.registerInkView(this);
		this.attach(this.currentFilePath());
		this.refresh();
	}

	// -------------------------------------------------------------------------------------------
	// Lifecycle / file tracking
	// -------------------------------------------------------------------------------------------

	update(u: ViewUpdate): void {
		this.applySpaceMoves(u); // drawings moved by a text Cut/Paste or its undo/redo
		const cur = this.currentFilePath();
		if (cur !== this.path && cur && this.path && this.host.isRenaming(cur)) {
			// Same note mid-rename (the store moves entry + listeners together, so whichever key is
			// loaded is the live one). Edits during a rename (e.g. link updates) must still be mapped.
			if (u.docChanged) {
				const key = this.store.isLoaded(this.path) ? this.path : cur;
				if (this.store.isLoaded(key)) this.onDocChanged(u, key);
			}
			this.scheduleFileCheck();
		} else if (cur !== this.path) {
			if (u.docChanged && this.path) {
				// The editor was switched to another file by replacing its document: detach now,
				// snapshotting anchors against the OLD document, before anything maps positions.
				this.detach(u.startState.doc);
				this.attach(cur);
			} else {
				this.scheduleFileCheck();
			}
		} else if (u.docChanged && this.path && this.store.isLoaded(this.path)) {
			this.onDocChanged(u, this.path);
		}
		// [Stage H] characters may have moved (re-wrap, edits; Live Preview reveals markup on the
		// cursor's line): re-measure character-anchored ink. A pure scroll doesn't move text.
		this.spaceCache = null; // [Stage K]
		const moved = spacesChanged(u); // [Stage K] spaces added/removed/resized/re-placed
		if (u.docChanged || u.geometryChanged || u.heightChanged || u.selectionSet || moved) this.charA.invalidate();
		if (u.docChanged || u.geometryChanged || u.viewportChanged || u.heightChanged || moved) this.scheduleRender();
		else if (u.selectionSet && this.hasCharInk()) this.scheduleRender();
	}

	/** [Stage H] Does the note have character-anchored ink? */
	private hasCharInk(): boolean {
		const ink = this.path ? this.store.get(this.path) : undefined;
		return !!ink && ink.strokes.some((s) => s.char);
	}

	destroy(): void {
		// A tap dot waiting for a possible second tap still belongs to this (valid) document.
		this.flushPendingTap();
		this.destroyed = true;
		const sd = this.view.scrollDOM;
		sd.removeEventListener("pointerdown", this.onPointerDown, true);
		this.view.contentDOM.removeEventListener("paste", this.onPasteCapture, true);
		this.view.contentDOM.removeEventListener("copy", this.onCopyCutCapture, true);
		this.view.contentDOM.removeEventListener("cut", this.onCopyCutCapture, true);
		sd.removeEventListener("pointermove", this.onPointerMove, true);
		sd.removeEventListener("pointerup", this.onPointerEnd, true);
		sd.removeEventListener("pointercancel", this.onPointerEnd, true);
		sd.removeEventListener("pointerleave", this.onPointerLeave);
		sd.classList.remove("pl-pen-near");
		sd.removeEventListener("lostpointercapture", this.onPointerEnd, true);
		sd.removeEventListener("touchstart", this.onTouch, true);
		sd.removeEventListener("touchmove", this.onTouch, true);
		sd.removeEventListener("touchend", this.onTouch, true);
		sd.removeEventListener("touchcancel", this.onTouch, true);
		for (const t of SUPPRESSED) sd.removeEventListener(t, this.onCompatMouse, true);
		if (this.raf) window.cancelAnimationFrame(this.raf);
		if (this.switchTimer !== null) window.clearTimeout(this.switchTimer);
		this.cancelActive();
		this.detach();
		this.svg.remove();
		this.menuEl?.remove();
		this.menuEl = null;
		this.view.scrollDOM.classList.remove("pl-mouse-draws", "pl-desk-select");
		this.spaceUi.destroy(); // [Stage K]
		if (this.hoverRaf) window.cancelAnimationFrame(this.hoverRaf);
		this.setHoverCursor("");
		this.host.unregisterInkView(this);
	}

	/** Settings changed (visibility, mouse draws, tool…). */
	refresh(): void {
		const s = this.host.getSettings();
		this.view.scrollDOM.classList.toggle("pl-mouse-draws", s.mouseDraws);
		this.svg.classList.toggle("pl-hidden", !s.inkVisible);
		// [Stage F] Select tool active: no text cursor / selection under the mouse (CSS).
		const desk = this.host.deskSelect() !== null && s.inkVisible;
		this.view.scrollDOM.classList.toggle("pl-desk-select", desk);
		if (!desk) this.setHoverCursor("");
		// Switching tools (or hiding ink) deselects.
		const selecting = this.host.selectionToolActive();
		if (this.selection && (!selecting || !s.inkVisible)) this.clearSelection();
		if (this.menu && (!selecting || !s.inkVisible)) this.closeMenu();
		this.scheduleRender();
	}

	/** The note path this view currently shows ink for. */
	get filePath(): string | null {
		return this.path;
	}

	private get store(): InkStore {
		return this.host.store;
	}

	private currentFilePath(): string | null {
		const info = this.view.state.field(editorInfoField, false);
		const file = info?.file;
		if (!file || file.extension !== "md") return null;
		return file.path;
	}

	private scheduleFileCheck(): void {
		if (this.switchTimer !== null || this.destroyed) return;
		this.switchTimer = window.setTimeout(() => {
			this.switchTimer = null;
			if (this.destroyed) return;
			const cur = this.currentFilePath();
			if (cur === this.path) return;
			// A rename in progress will update our path via the store's "rename" event.
			if (cur && this.host.isRenaming(cur)) {
				this.scheduleFileCheck();
				return;
			}
			this.detach();
			this.attach(cur);
		}, 50);
	}

	private attach(path: string | null): void {
		this.path = path;
		const token = ++this.attachToken;
		if (!path || path === this.deadPath) {
			this.path = null;
			this.clearRendered();
			return;
		}
		this.unsub = this.store.subscribe(path, this.listener, { beforeSave: (ink) => this.refreshAnchors(ink) });
		this.store.load(path).then(
			() => {
				if (token !== this.attachToken || this.destroyed) return;
				this.resolvePositions();
				this.syncSpaces(); // [Stage K]
				this.scheduleRender();
			},
			(err) => console.error("[pencil-layer] load failed", err),
		);
	}

	/** `anchorDoc`: the document the current positions refer to (defaults to the current one). */
	private detach(anchorDoc?: Text): void {
		this.attachToken++;
		if (this.active) this.cancelActive();
		// The document may already be another file's: a pending tap dot can't be anchored safely.
		this.discardPendingTap();
		this.clearSelection();
		this.closeMenu();
		const unsub = this.unsub;
		this.unsub = null;
		if (unsub) {
			this.anchorDoc = anchorDoc ?? null;
			try {
				unsub();
			} finally {
				this.anchorDoc = null;
			}
		}
		this.path = null;
		this.liveHeights.clear();
		this.syncSpaces(); // [Stage K] no note: no spaces
		this.clearRendered();
	}

	private anchorDoc: Text | null = null;

	private readonly listener: InkListener = (_path, change) => {
		if (this.destroyed) return;
		if (change.type === "rename") {
			this.path = change.newPath;
			this.scheduleRender();
			return;
		}
		if (change.type === "delete") {
			this.deadPath = this.path;
			this.detach();
			return;
		}
		// Strokes that arrived from another device (or were copied in by the public API as a
		// "layout" step) need positions in this document. Only unresolved ones are touched.
		if (change.type === "sync" || change.type === "layout") this.resolvePositions();
		this.validateSelection();
		this.syncSpaces(); // [Stage K] spaces added/removed/resized (also by undo / live sync)
		this.scheduleRender();
	};

	// -------------------------------------------------------------------------------------------
	// Anchors / positions
	// -------------------------------------------------------------------------------------------

	private onDocChanged(u: ViewUpdate, path: string): void {
		if (!this.store.isPositionOwner(path, this.listener)) return;
		const ink = this.store.get(path);
		if (!ink) return;
		const strokes = this.store.allStrokes(path);
		const spaces = this.store.allSpaces(path); // [Stage K] spaces follow their lines too
		if (strokes.length === 0 && spaces.length === 0) return;
		if (replacesWholeDoc(u)) {
			// Mapping through a full replacement would collapse every anchor to the top. Snapshot the
			// anchors against the old doc, then re-resolve by line hash against the new one.
			this.refreshAnchorsFor(strokes, u.startState.doc);
			this.refreshSpaceAnchors(spaces, u.startState.doc);
			this.store.clearPositions(path);
			this.resolvePositions();
		} else {
			// Resolve any not-yet-resolved strokes against the pre-change doc so they get mapped too.
			this.resolvePositionsIn(strokes, u.startState.doc);
			this.resolveSpacesIn(spaces, u.startState.doc);
			// [Stage C] assoc: -1 for line starts, +1/-1 for a text highlight's from/to (see store.ts).
			this.store.mapPositions(path, (p, assoc) => u.changes.mapPos(p, assoc), this.listener);
		}
		if (!isEmptyInk(ink)) this.store.touch(path);
	}

	private resolvePositions(): void {
		if (!this.path) return;
		this.resolvePositionsIn(this.store.allStrokes(this.path), this.view.state.doc);
		this.resolveSpacesIn(this.store.allSpaces(this.path), this.view.state.doc); // [Stage K]
	}

	/** [Stage K] Live positions of spaces from their anchors ("end" spaces have none). */
	private resolveSpacesIn(spaces: readonly InkSpace[], doc: Text): void {
		let src: ReturnType<typeof lineSource> | null = null;
		for (const sp of spaces) if (sp.pos === undefined && sp.after !== "end") sp.pos = doc.line(resolveAnchor((src ??= lineSource(doc)), sp.after) + 1).from;
	}

	/** [Stage K] Anchors of spaces from their live positions. */
	private refreshSpaceAnchors(spaces: readonly InkSpace[], doc: Text): void {
		for (const sp of spaces) {
			if (sp.pos === undefined || sp.after === "end") continue;
			const line = doc.lineAt(clampPos(doc, sp.pos));
			sp.after = { line: line.number - 1, hash: hashLine(line.text) };
		}
	}

	private resolvePositionsIn(strokes: Stroke[], doc: Text): void {
		let src: ReturnType<typeof lineSource> | null = null;
		for (const s of strokes) {
			this.textHl.resolve(s, doc); // [Stage C] text highlights: pos + textRange together
			if (s.pos === undefined) {
				src ??= lineSource(doc);
				s.pos = doc.line(resolveAnchor(src, s.anchor) + 1).from;
			}
			this.charA.resolve(s, doc); // [Stage H] charPos relative to the resolved line
		}
	}

	/** `beforeSave` hook: anchors from live positions. */
	private refreshAnchors(ink: InkFile): void {
		this.refreshAnchorsFor(ink.strokes, this.anchorDoc ?? this.view.state.doc);
		this.refreshSpaceAnchors(ink.spaces ?? [], this.anchorDoc ?? this.view.state.doc); // [Stage K]
	}

	private refreshAnchorsFor(strokes: Stroke[], doc: Text): void {
		this.textHl.refreshAnchors(strokes, doc); // [Stage C] re-anchor text highlights to their range start
		for (const s of strokes) {
			if (s.pos === undefined) continue;
			const line = doc.lineAt(clampPos(doc, s.pos));
			s.anchor = { line: line.number - 1, hash: hashLine(line.text) };
		}
		this.charA.refreshAnchors(strokes, doc); // [Stage H] after the line anchors
	}

	/**
	 * [Stage H] Overlay position of a stroke's points' origin: (0, anchor line top), shifted for
	 * character-anchored ink to follow its character (as last measured).
	 */
	private place(s: Stroke): XY {
		const top = this.lineTop(s);
		if (!s.char || s.space) return [0, top]; // [Stage K] ink in a space follows the space
		const [x, y] = this.charA.shift(s);
		return [x, top + y];
	}

	/** [Stage H] A stroke with its points in overlay x (for code that only applies a y offset). */
	private shiftedX(s: Stroke, x: number): Stroke {
		return x === 0 ? s : { ...s, points: s.points.map((p): Point => [p[0] + x, p[1], p[2]]) };
	}

	/** [Stage H] Character anchor for a unit of new strokes (group commit, paste, duplicate). */
	private anchorGroup(strokes: readonly Stroke[]): void {
		if (strokes.some((s) => s.space)) return; // [Stage K] no text in a drawing space
		let minX = Infinity;
		let minY = Infinity;
		let maxX = -Infinity;
		let maxY = -Infinity;
		for (const s of strokes) {
			const top = this.lineTop(s);
			const b = bbox(s.points);
			if (!b) continue;
			minX = Math.min(minX, b.minX);
			maxX = Math.max(maxX, b.maxX);
			minY = Math.min(minY, b.minY + top);
			maxY = Math.max(maxY, b.maxY + top);
		}
		if (Number.isFinite(minX)) this.charA.anchorUnit(strokes, { minX, minY, maxX, maxY });
	}

	/** Overlay-space top of a stroke's anchor line ([Stage K] or of its drawing space). */
	private lineTop(s: Stroke): number {
		if (s.space) {
			const t = this.spaceTop(s.space);
			if (t !== null) return t;
		}
		const doc = this.view.state.doc;
		if (s.pos === undefined) {
			s.pos = doc.line(resolveAnchor(lineSource(doc), s.anchor) + 1).from;
		}
		return this.view.lineBlockAt(doc.lineAt(clampPos(doc, s.pos)).from).top;
	}

	/**
	 * Anchor for overlay-space points: the document line under the topmost point (last line if
	 * below the document). Returns the anchor, the line start position and the line's top.
	 * [Stage K] With `space`: the points belong to that drawing space (relative to its top; the
	 * line anchor is the space's line, the fallback for older versions).
	 */
	private anchorFor(points: readonly (readonly number[])[], space: SpaceRect | null = null): { anchor: Stroke["anchor"]; pos: number; top: number; space?: string } {
		const view = this.view;
		const doc = view.state.doc;
		if (space) {
			const sp = this.path ? this.store.get(this.path)?.spaces?.find((x) => x.id === space.id) : undefined;
			const line = !sp || sp.after === "end" || sp.pos === undefined ? doc.line(doc.lines) : doc.lineAt(clampPos(doc, sp.pos));
			return { anchor: { line: line.number - 1, hash: hashLine(line.text) }, pos: line.from, top: space.top, space: space.id };
		}
		let minY = Infinity;
		for (const p of points) if (p[1] < minY) minY = p[1];
		const lastBlock = view.lineBlockAt(doc.length);
		const line =
			minY >= lastBlock.bottom ? doc.line(doc.lines) : doc.lineAt(view.lineBlockAtHeight(Math.max(minY, 0)).from);
		return {
			anchor: { line: line.number - 1, hash: hashLine(line.text) },
			pos: line.from,
			top: view.lineBlockAt(line.from).top,
		};
	}

	// -------------------------------------------------------------------------------------------
	// [Stage K] Drawing spaces
	// -------------------------------------------------------------------------------------------

	/** Spaces as CM lays them out (document y = overlay y); cached until the next editor update / measure. */
	private spaceRects(): SpaceBox[] {
		return (this.spaceCache ??= spaceLayout(this.view));
	}

	private spaceCache: SpaceBox[] | null = null;

	/** Top (overlay y) of space `id` as CM shows it now, or null if it isn't shown. */
	private spaceTop(id: string): number | null {
		return this.spaceRects().find((r) => r.id === id)?.top ?? null;
	}

	/** The store's space `id` of the current note. */
	private spaceById(id: string): InkSpace | undefined {
		return this.path ? this.store.get(this.path)?.spaces?.find((x) => x.id === id) : undefined;
	}

	// --- Blank lines next to a space (2026-11-19) ---------------------------------------------
	// A drawing started on the note's blank lines that continues into a space (typically: ink on
	// the trailing blank lines, then the pen goes below the end and an "end" space is made) would
	// be split between line-anchored ink and the space. Instead the space moves up to just after
	// the text: the blank lines' ink joins it (same place on screen) and the blank lines now show
	// BELOW it (room to type under the drawing). No text changes, so one ink undo reverts it all.

	private readonly blankLine = (l: number): boolean => this.view.state.doc.line(l + 1).text.trim() === "";

	/** 0-based line a shown space follows. */
	private boxLine(b: SpaceBox): number {
		return this.view.state.doc.lineAt(clampPos(this.view.state.doc, b.at)).number - 1;
	}

	/** Plain line-anchored strokes (not text highlights) on 0-based lines first..last. */
	private marginOn(first: number, last: number): Stroke[] {
		const doc = this.view.state.doc;
		const from = doc.line(first + 1).from;
		const to = doc.line(last + 1).to;
		const ink = this.path ? this.store.get(this.path) : undefined;
		return (ink?.strokes ?? []).filter((s) => !s.space && !s.text && s.pos !== undefined && s.pos >= from && s.pos <= to);
	}

	/** The space whose ink-free blank lines below contain document y (a stroke started there grows it). */
	private spaceAboveBlank(y: number): SpaceBox | null {
		const doc = this.view.state.doc;
		const boxes = this.spaceRects();
		let best: SpaceBox | null = null;
		for (const b of boxes) {
			if (this.spaceById(b.id)?.a4) continue;
			const bottom = b.top + b.height;
			if (y < bottom || (best && bottom <= best.top + best.height)) continue;
			const run = blankRunBelow(this.blankLine, doc.lines, this.boxLine(b));
			if (!run) continue;
			if (y >= this.view.lineBlockAt(doc.line(run.last + 1).from).bottom) continue;
			if (boxes.some((o) => o !== b && o.top >= bottom && o.top <= y)) continue;
			if (this.marginOn(run.first, run.last).length > 0) continue;
			best = b;
		}
		return best;
	}

	/**
	 * Should this stroke pull the blank lines above its space (and their ink) into the space? Yes
	 * when it goes into a space (or a new "end" space) shown after blank lines that carry ink, or
	 * when it starts on such blank lines and reaches into the space below them.
	 */
	private absorbTarget(a: DrawInput, rect: SpaceRect | null, extra: SpaceEdit, box: BBox): AbsorbTarget | null {
		const doc = this.view.state.doc;
		let S: AbsorbTarget["S"];
		let line: number;
		if (rect) {
			if (this.spaceById(rect.id)?.a4 || extra.addSpaces?.some(({ space }) => space.id === rect.id && space.a4)) return null;
			if (extra.addSpaces?.some((x) => x.space.id === rect.id)) {
				S = { id: null, top: rect.top, height: rect.height };
				line = doc.lines - 1;
			} else {
				const b = this.spaceRects().find((r) => r.id === rect.id);
				if (!b) return null;
				const grown = extra.resize?.find((r) => r.id === rect.id)?.height ?? 0;
				S = { id: rect.id, top: b.top, height: Math.max(rect.height, grown) };
				line = this.boxLine(b);
			}
		} else {
			// The first space below where the stroke started, if the stroke reaches into it.
			const b = this.spaceRects().filter((r) => r.top > a.downY).sort((p, q) => p.top - q.top)[0];
			if (!b || this.spaceById(b.id)?.a4 || box.maxY < b.top + CROSS_INTO) return null;
			S = { id: b.id, top: b.top, height: this.spaceById(b.id)?.height ?? b.height };
			line = this.boxLine(b);
		}
		const run = blankRunAbove(this.blankLine, blockEnds(lineSource(doc)), line);
		if (!run) return null;
		const top = this.view.lineBlockAt(doc.line(run.first + 1).from).top;
		if (!rect && a.downY < top) return null; // started on text, not on the blank lines
		const margin = this.marginOn(run.first, line);
		if (rect && margin.length === 0) return null; // nothing on the blank lines: leave them
		return { S, after: run.after, top, margin };
	}

	/** One ink op: a space after `t.after` holding the blank lines' ink, the old space's ink and the new stroke. */
	private absorbCommit(path: string, a: DrawInput, t: AbsorbTarget): void {
		const ink = this.store.get(path);
		if (!ink) return;
		const doc = this.view.state.doc;
		const afterLine = doc.line(t.after + 1);
		const anchor = { line: t.after, hash: hashLine(afterLine.text) };
		const id = newId();
		const shift = t.S.top - t.top;
		const space: InkSpace = { id, after: anchor, height: Math.ceil(t.S.height + shift), pos: afterLine.from };
		const into = (s: Stroke, pts: Point[]): Stroke => {
			const { char, charPos, text, textRange, ...rest } = s;
			return { ...rest, id: newId(), anchor: { ...anchor }, points: pts, pos: afterLine.from, space: id };
		};
		const add: Stroke[] = [];
		for (const s of t.margin) {
			const [x, top] = this.place(s);
			add.push(into(s, s.points.map((p): Point => [p[0] + x, p[1] + top - t.top, p[2]])));
		}
		if (t.S.id) for (const s of ink.strokes) if (s.space === t.S.id) add.push(into(s, s.points.map((p): Point => [p[0], p[1] + shift, p[2]])));
		add.push({
			id: newId(),
			tool: a.tool,
			color: a.color,
			size: a.size,
			...(a.style ? { style: a.style } : {}),
			anchor: { ...anchor },
			points: a.points.map((p): Point => [p[0], p[1] - t.top, p[2]]),
			...(a.snap ? { shape: a.snap.spec.kind } : {}),
			pos: afterLine.from,
			space: id,
		});
		const index = t.S.id ? (ink.spaces ?? []).findIndex((x) => x.id === t.S.id) : -1;
		this.commitStrokes(
			path,
			t.margin.map((s) => s.id),
			add,
			{ removeSpaceIds: t.S.id ? [t.S.id] : [], addSpaces: [{ space, ...(index >= 0 ? { index } : {}) }] },
		);
	}

	/** Feed the editor's space widgets the note's spaces (live heights included). Cheap when unchanged. */
	private syncSpaces(): void {
		if (this.destroyed) return;
		const ink = this.path ? this.store.get(this.path) : undefined;
		const doc = this.view.state.doc;
		const specs: SpaceSpec[] = [];
		if (ink?.spaces) {
			this.resolveSpacesIn(ink.spaces, doc);
			for (const sp of ink.spaces) {
				specs.push({ id: sp.id, pos: sp.after === "end" ? null : clampPos(doc, sp.pos ?? 0), height: this.liveHeights.get(sp.id) ?? sp.height });
			}
		}
		if (sameSpecs(currentSpecs(this.view), specs)) return;
		try {
			this.view.dispatch({ effects: setSpaces.of(specs) });
		} catch {
			// Called during an editor update: once it is done (positions are re-read from the store then).
			queueMicrotask(() => this.syncSpaces());
		}
	}

	/** Lowest ink of space `id` (px below its top), -Infinity if none. */
	private spaceInkBottom(id: string): number {
		const ink = this.path ? this.store.get(this.path) : undefined;
		return spaceInkBottoms((ink?.strokes ?? []).filter((s) => s.space === id)).get(id) ?? -Infinity;
	}

	private readonly spaceActions: SpaceActions = {
		canResize: (id) => !this.spaceById(id)?.a4,
		resizeLive: (id, height) => {
			const sp = this.spaceById(id);
			if (!sp || sp.a4) return;
			this.liveHeights.set(id, resizedHeight(height, this.spaceInkBottom(id)));
			this.syncSpaces();
		},
		resizeEnd: (id, height) => {
			this.liveHeights.delete(id);
			const sp = this.spaceById(id);
			if (this.path && sp && !sp.a4 && height !== null) {
				const h = resizedHeight(height, this.spaceInkBottom(id));
				if (h !== sp.height) this.store.editSpaces(this.path, { resize: [{ id, height: h }] });
			}
			this.syncSpaces();
		},
		clear: (id) => {
			const ink = this.path ? this.store.get(this.path) : undefined;
			if (!this.path || !ink) return;
			const ids = ink.strokes.filter((s) => s.space === id).map((s) => s.id);
			this.clearSelection();
			if (ids.length > 0) this.store.removeStrokes(this.path, ids);
		},
		remove: (id) => void this.deleteSpace(id),
		copy: (id) => {
			if (this.copySpace(id)) new Notice("Drawing copied. Put the cursor on the line it should go below, then paste.");
		},
		cut: (id) => {
			if (!this.path || !this.copySpace(id)) return;
			this.clearSelection();
			this.store.editSpaces(this.path, { removeSpaceIds: [id] });
			new Notice("Drawing cut. Put the cursor on the line it should go below, then paste.");
		},
	};

	/** Space `id` with its ink, for the clipboard. */
	private clipSpace(id: string, rel: number): ClipSpace | null {
		const ink = this.path ? this.store.get(this.path) : undefined;
		const sp = ink?.spaces?.find((x) => x.id === id);
		if (!ink || !sp) return null;
		return {
			rel,
			height: this.liveHeights.get(id) ?? sp.height,
			...(sp.a4 ? { a4: true as const } : {}),
			strokes: ink.strokes
				.filter((s) => s.space === id)
				.map((s) => ({ tool: s.tool, color: s.color, size: s.size, style: s.style, shape: s.shape, points: s.points.map((p): Point => [p[0], p[1], p[2]]) })),
		};
	}

	/** Put space `id` and its ink on the space clipboard (+ a label on the system clipboard, so Cmd+V / iOS Paste reach the paste handler). Runs inside the tap. */
	private copySpace(id: string): boolean {
		const c = this.clipSpace(id, 0);
		if (!c) return false;
		this.host.spaceClip = { text: SPACE_CLIP_TEXT, spaces: [c] };
		try {
			void navigator.clipboard?.writeText(SPACE_CLIP_TEXT).catch(() => {});
		} catch {
			/* the "Paste drawing space" command still works */
		}
		return true;
	}

	/** Paste the space clipboard's drawings after line `firstLine` (1-based) + each one's `rel` (one ink undo step). */
	pasteSpace(firstLine?: number): boolean {
		const clip = this.host.spaceClip;
		const path = this.path;
		if (!clip || clip.spaces.length === 0 || !path || !this.store.isLoaded(path)) return false;
		const doc = this.view.state.doc;
		const first = firstLine ?? doc.lineAt(this.view.state.selection.main.head).number;
		const addSpaces: { space: InkSpace }[] = [];
		const addStrokes: Stroke[] = [];
		for (const c of clip.spaces) {
			const line = doc.line(Math.min(Math.max(1, first + c.rel), doc.lines));
			const after = { line: line.number - 1, hash: hashLine(line.text) };
			const space: InkSpace = { id: newId(), after, height: c.height, ...(c.a4 ? { a4: true } : {}), pos: line.from };
			addSpaces.push({ space });
			for (const st of c.strokes) {
				addStrokes.push({
					id: newId(),
					tool: st.tool,
					color: st.color,
					size: st.size,
					...(st.style ? { style: st.style } : {}),
					...(st.shape ? { shape: st.shape } : {}),
					anchor: { ...after },
					points: st.points.map((p): Point => [p[0], p[1], p[2]]),
					pos: line.from,
					space: space.id,
				});
			}
		}
		this.clearSelection();
		this.store.editSpaces(path, { addSpaces, addStrokes });
		return true;
	}

	/**
	 * Editor Copy/Cut (capture, before CM): drawings inside the text selection (`spaceInRange`) go
	 * on the space clipboard with the selected text; Cut also removes them (CM removes the text).
	 */
	private readonly onCopyCutCapture = (e: ClipboardEvent): void => {
		const st = this.view.state;
		const sel = st.selection;
		if (sel.ranges.length !== 1 || sel.main.empty || !this.path) return;
		const { from, to } = sel.main;
		const startLine = st.doc.lineAt(from).number;
		const inside = spaceLayout(this.view).filter((b) => spaceInRange(b.at, st.doc.lineAt(b.at).from, from, to));
		if (inside.length === 0) return;
		const spaces = inside.map((b) => this.clipSpace(b.id, st.doc.lineAt(b.at).number - startLine)).filter((c): c is ClipSpace => !!c);
		this.host.spaceClip = { text: st.sliceDoc(from, to), spaces };
		if (e.type !== "cut") return;
		// The editor's cut transaction carries the removal (so ⌘Z restores text and drawings together).
		const ink = this.store.get(this.path);
		const moved: MovedSpace[] = [];
		for (const b of inside) {
			const sp = ink?.spaces?.find((x) => x.id === b.id);
			if (!ink || !sp) continue;
			const line = st.doc.lineAt(sp.after === "end" || sp.pos === undefined ? st.doc.length : clampPos(st.doc, sp.pos));
			const after = { line: line.number - 1, hash: hashLine(line.text) };
			moved.push({
				space: { id: sp.id, after, height: sp.height, ...(sp.a4 ? { a4: true } : {}) },
				strokes: ink.strokes.filter((x) => x.space === sp.id).map((x) => ({ ...x, anchor: { ...after }, pos: undefined })),
			});
		}
		const claimed = expectSpaceMove(st, () => ({ add: [], remove: moved }));
		window.setTimeout(() => {
			// Nothing claimed it (the editor didn't cut): remove them directly, as before.
			if (!claimed() && !this.destroyed && this.path) this.store.editSpaces(this.path, { removeSpaceIds: moved.map((m) => m.space.id) });
		}, 0);
	};

	/** [spaceMove] A text Cut/Paste (or its undo/redo) moved drawings: apply it to the ink (after this update). */
	private applySpaceMoves(u: ViewUpdate): void {
		const moves = u.transactions.flatMap((tr) => tr.effects.filter((e) => e.is(spaceMove)).map((e) => e.value));
		if (moves.length === 0) return;
		queueMicrotask(() => {
			const path = this.path;
			if (this.destroyed || !path || !this.store.isLoaded(path)) return;
			const doc = this.view.state.doc;
			const have = new Set((this.store.get(path)?.spaces ?? []).map((x) => x.id));
			const edit: SpaceEdit = { removeSpaceIds: [], addSpaces: [], addStrokes: [] };
			for (const m of moves) {
				for (const r of m.remove) if (have.has(r.space.id)) edit.removeSpaceIds!.push(r.space.id);
				for (const a of m.add) {
					if (have.has(a.space.id)) continue;
					const line = doc.line(Math.min(Math.max(1, a.space.after.line + 1), doc.lines));
					const after = { line: line.number - 1, hash: hashLine(line.text) };
					edit.addSpaces!.push({ space: { ...a.space, after, pos: line.from } });
					for (const st of a.strokes) edit.addStrokes = [...edit.addStrokes!, { ...st, anchor: { ...after }, pos: line.from }];
				}
			}
			if (edit.removeSpaceIds!.length + edit.addSpaces!.length === 0) return;
			this.clearSelection();
			this.store.editSpaces(path, edit);
		});
	}

	/**
	 * Paste (capture, before CM/Obsidian). The label a "⋯" Copy/Cut wrote → paste just the drawing
	 * after the cursor line. Text copied/cut together with drawings → let the editor paste the
	 * text, then put the drawings back after the same lines of the pasted text.
	 */
	private readonly onPasteCapture = (e: ClipboardEvent): void => {
		const clip = this.host.spaceClip;
		const text = e.clipboardData?.getData("text/plain");
		if (!clip) return;
		if (isSpaceClipText(text)) {
			e.preventDefault();
			e.stopImmediatePropagation();
			this.pasteSpace();
			return;
		}
		if (!sameClipText(text, clip.text)) return;
		const st = this.view.state;
		const first = st.doc.lineAt(st.selection.main.from).number;
		// The editor's paste transaction carries the new drawings (so ⌘Z removes them with the text).
		const claimed = expectSpaceMove(st, (tr) => ({
			remove: [],
			add: clip.spaces.map((c): MovedSpace => {
				const ln = Math.min(Math.max(1, first + c.rel), tr.newDoc.lines);
				const text = tr.newDoc.line(ln).text;
				const after = { line: ln - 1, hash: hashLine(text) };
				const id = newId();
				return {
					space: { id, after, height: c.height, ...(c.a4 ? { a4: true } : {}) },
					strokes: c.strokes.map((x) => ({
						id: newId(),
						tool: x.tool,
						color: x.color,
						size: x.size,
						...(x.style ? { style: x.style } : {}),
						...(x.shape ? { shape: x.shape } : {}),
						anchor: { ...after },
						points: x.points.map((p): Point => [p[0], p[1], p[2]]),
						space: id,
					})),
				};
			}),
		}));
		window.setTimeout(() => {
			if (!claimed() && !this.destroyed) this.pasteSpace(first); // the editor didn't paste: add them directly
		}, 0);
	};

	/** Does a space sit right after line `ln` (1-based)? */
	private spacesAfterLine(ln: number): boolean {
		const to = this.view.state.doc.line(ln).to;
		return spaceLayout(this.view).some((b) => b.at === to);
	}

	/**
	 * Put the cursor on a new line BELOW the spaces shown after line `ln` (1-based): spaces at the
	 * note's "end" there are first pinned to that line (so they stay above the new text), then a
	 * blank separator + new line are inserted after it (`openBelowInsert`).
	 */
	openBelow(ln: number): void {
		const view = this.view;
		const doc = view.state.doc;
		const line = doc.line(ln);
		const ink = this.path ? this.store.get(this.path) : undefined;
		if (this.path && ink?.spaces && ln === doc.lines) {
			const ends = ink.spaces.filter((sp) => sp.after === "end");
			if (ends.length > 0) {
				const after = { line: line.number - 1, hash: hashLine(line.text) };
				const ids = new Set(ends.map((sp) => sp.id));
				this.store.editSpaces(this.path, {
					removeSpaceIds: [...ids],
					addSpaces: ends.map((sp) => ({ space: { ...sp, after: { ...after }, pos: line.from }, index: ink.spaces!.indexOf(sp) })),
					addStrokes: ink.strokes.filter((s) => s.space !== undefined && ids.has(s.space)).map((s) => ({ ...s, anchor: { ...after }, pos: line.from })),
				});
			}
		}
		const insert = openBelowInsert(line.text);
		view.dispatch({
			changes: { from: line.to, insert },
			selection: { anchor: line.to + insert.length },
			scrollIntoView: true,
			userEvent: "input",
		});
		view.focus();
	}

	/** ArrowDown on the last line with a drawing below it: open a line below the drawing. */
	arrowDown(): boolean {
		const st = this.view.state;
		const sel = st.selection.main;
		if (!sel.empty || st.doc.lineAt(sel.head).number !== st.doc.lines || !this.spacesAfterLine(st.doc.lines)) return false;
		this.openBelow(st.doc.lines);
		return true;
	}

	/** Enter at the end of a paragraph line with a drawing after it: the new line goes below the drawing. */
	enter(): boolean {
		const st = this.view.state;
		const sel = st.selection.main;
		if (!sel.empty || st.selection.ranges.length > 1) return false;
		const line = st.doc.lineAt(sel.head);
		if (sel.head !== line.to || !enterOpensBelow(line.text) || !this.spacesAfterLine(line.number)) return false;
		this.openBelow(line.number);
		return true;
	}

	/** "Add space": a drawing space below the cursor's line (its block), ~⅓ of the editor tall. One ink undo step; focus and cursor untouched. */
	addSpace(): void {
		const path = this.path;
		if (!path || !this.store.isLoaded(path)) return;
		const doc = this.view.state.doc;
		const line = doc.lineAt(this.view.state.selection.main.head);
		const size = spaceSize(defaultSpaceHeight(this.view.scrollDOM.clientHeight), this.host.getSettings().a4DrawingSpaces);
		const space: InkSpace = { id: newId(), after: { line: line.number - 1, hash: hashLine(line.text) }, ...size, pos: line.from };
		this.store.editSpaces(path, { addSpaces: [{ space }] });
	}

	/** Delete a space with its ink (asks first when it has ink); one undo step brings both back. */
	async deleteSpace(id: string): Promise<void> {
		const path = this.path;
		const ink = path ? this.store.get(path) : undefined;
		if (!path || !ink) return;
		const n = ink.strokes.filter((s) => s.space === id).length;
		if (n > 0 && !(await this.host.confirmDeleteSpace(n))) return;
		if (this.path !== path) return;
		this.clearSelection();
		this.store.editSpaces(path, { removeSpaceIds: [id] });
	}

	/**
	 * Commit strokes (replacing `removeIds`) and grow every space they land in so it holds them
	 * (`grownHeight`), as ONE undoable op. `extra` adds space changes to the same op.
	 */
	private commitStrokes(path: string, removeIds: readonly string[], add: readonly Stroke[], extra: SpaceEdit = {}): boolean {
		const ink = this.store.get(path);
		const known = new Map((ink?.spaces ?? []).map((sp) => [sp.id, sp]));
		for (const a of extra.addSpaces ?? []) known.set(a.space.id, a.space);
		for (const s of add) {
			const space = s.space ? known.get(s.space) : undefined;
			const radius = s.size / 2;
			if (space?.a4 && s.points.some(([, y]) => Math.abs(y - boundSpaceY(y, space.height, radius)) > 0.051)) {
				new Notice("The drawing does not fit inside this A4 space.");
				return false;
			}
		}
		const resize: { id: string; height: number }[] = [...(extra.resize ?? [])];
		for (const [id, bottom] of spaceInkBottoms(add)) {
			const sp = known.get(id);
			if (!sp || sp.a4) continue;
			const h0 = resize.find((r) => r.id === id)?.height ?? sp.height;
			const h = grownHeight(h0, bottom);
			if (h === h0) continue;
			const r = resize.find((x) => x.id === id);
			if (r) r.height = h;
			else resize.push({ id, height: h });
		}
		// A new space is created at its final height (no resize entry for it).
		for (const a of extra.addSpaces ?? []) {
			const r = resize.findIndex((x) => x.id === a.space.id);
			if (r >= 0) a.space.height = resize.splice(r, 1)[0].height;
		}
		const simple = resize.length === 0 && !extra.addSpaces?.length && !extra.removeSpaceIds?.length;
		if (simple) {
			if (removeIds.length === 0 && add.length === 1) this.store.addStroke(path, add[0]);
			else this.store.replaceStrokes(path, removeIds, add);
		} else this.store.editSpaces(path, { ...extra, resize, removeStrokeIds: [...removeIds], addStrokes: add });
		return true;
	}

	/**
	 * "Make drawing space" (lasso menu): the selected strokes become a space exactly where they are
	 * (rigid from now on); blank lines the space replaces are deleted (one CM undo step), the ink
	 * change is one ink undo step.
	 */
	private makeDrawingSpace(): void {
		const path = this.path;
		const sel = this.orderedSelection().filter((s) => !s.space && !s.text);
		if (!path || !this.store.isLoaded(path) || sel.length === 0) return;
		const view = this.view;
		const doc = view.state.doc;
		// Overlay points as shown now (character-anchored ink at its current place).
		const items = sel.map((s) => {
			const [x, top] = this.place(s);
			return { s, pts: s.points.map((p): Point => [p[0] + x, p[1] + top, p[2]]) };
		});
		let inkTop = Infinity;
		let inkBottom = -Infinity;
		for (const { s, pts } of items) {
			for (const p of pts) {
				inkTop = Math.min(inkTop, p[1] - s.size / 2);
				inkBottom = Math.max(inkBottom, p[1] + s.size / 2);
			}
		}
		if (!Number.isFinite(inkTop)) return;
		// Lines around the ink (and up to the end of the blank run below it).
		const selected = new Set(sel);
		const pinned = new Set<number>();
		for (const s of this.store.get(path)?.strokes ?? []) {
			if (selected.has(s) || s.space || s.pos === undefined) continue;
			pinned.add(doc.lineAt(clampPos(doc, s.pos)).number - 1);
		}
		const ends = blockEnds(lineSource(doc));
		const lines: LaidLine[] = [];
		for (let i = 1; i <= doc.lines; i++) {
			const ln = doc.line(i);
			const b = view.lineBlockAt(ln.from);
			lines.push({ top: b.top, bottom: b.bottom, blank: ln.text.trim() === "", end: ends[i - 1] === i - 1, pinned: pinned.has(i - 1) });
		}
		const plan = planMakeSpace(lines, inkTop, inkBottom);
		if (!plan) return;
		const size = spaceSize(plan.height, this.host.getSettings().a4DrawingSpaces);
		if (size.a4 && (inkTop < plan.top || inkBottom > plan.top + size.height - SPACE_INK_PAD)) {
			new Notice("The selection does not fit inside one A4 space.");
			return;
		}
		const afterLine = doc.line(plan.after + 1);
		// Ink first (positions refer to the current document), then the blank lines.
		const id = newId();
		const space: InkSpace = { id, after: { line: plan.after, hash: hashLine(afterLine.text) }, ...size, pos: afterLine.from };
		const rect: SpaceRect = { id, top: plan.top, height: size.height };
		const strokes = items.map(({ s, pts }) =>
			this.anchoredStroke({ tool: s.tool, color: s.color, size: s.size, style: s.style, shape: s.shape }, pts, rect),
		);
		this.clearSelection();
		if (plan.del) {
			const from = doc.line(plan.del[0] + 1).from - 1;
			const to = doc.line(plan.del[1] + 1).to;
			view.dispatch({ changes: { from, to }, userEvent: "delete" });
		}
		this.store.editSpaces(path, { addSpaces: [{ space }], removeStrokeIds: sel.map((s) => s.id), addStrokes: strokes });
		this.setSelection(strokes);
		this.showSelectionMenu();
	}

	// -------------------------------------------------------------------------------------------
	// Rendering	// -------------------------------------------------------------------------------------------
	// Rendering
	// -------------------------------------------------------------------------------------------

	private scheduleRender(): void {
		if (this.destroyed) return;
		this.view.requestMeasure({
			key: this,
			read: (view) => {
				// [Stage C] text highlight rects are measured here (layout reads), drawn in render().
				const ink = this.path && this.host.getSettings().inkVisible ? this.store.get(this.path) : undefined;
				this.textHl.measure(ink?.strokes);
				this.charA.measure(ink?.strokes); // [Stage H] characters of char-anchored ink (stale ones only)
				const geo = this.readGeometry(view);
				if (!this.host.getSettings().setSquare) this.guideOrigin = null;
				else if (!this.guideOrigin) {
					const scroller = view.scrollDOM;
					this.guideOrigin = [geo.width / 2, Math.max(0, scroller.scrollTop - geo.top) + Math.min(140, scroller.clientHeight / 3)];
				}
				this.spaceCache = null; // [Stage K] CM has just measured
				const spaces = this.spaceRects(); // [Stage K] for the space controls
				return { geo, spaces };
			},
			write: ({ geo, spaces }: { geo: Geometry; spaces: SpaceBox[] }) => {
				this.render(geo);
				this.renderGuide();
				this.spaceUi.apply(spaces, geo.left, geo.top, geo.width, !!this.path); // [Stage K]
			},
		});
	}

	private readGeometry(view: EditorView): Geometry {
		const sd = view.scrollDOM;
		const cd = view.contentDOM;
		const sx = view.scaleX || 1;
		const sy = view.scaleY || 1;
		const sRect = sd.getBoundingClientRect();
		const cRect = cd.getBoundingClientRect();
		const cs = getComputedStyle(cd);
		const padL = parseFloat(cs.paddingLeft) || 0;
		const padR = parseFloat(cs.paddingRight) || 0;
		const baseLeft = sRect.left - sd.scrollLeft * sx;
		const baseTop = sRect.top - sd.scrollTop * sy;
		const docTop = view.documentTop;
		return {
			left: (cRect.left - baseLeft) / sx + padL,
			top: (docTop - baseTop) / sy,
			width: Math.max(0, cd.clientWidth - padL - padR),
			height: Math.max(0, (cRect.bottom - docTop) / sy),
		};
	}

	private applyGeometry(geo: Geometry): void {
		const old = this.geo;
		this.geo = geo;
		if (old && old.left === geo.left && old.top === geo.top && old.width === geo.width && old.height === geo.height) {
			return;
		}
		const st = this.svg.style;
		st.left = `${geo.left}px`;
		st.top = `${geo.top}px`;
		st.width = `${geo.width}px`;
		st.height = `${geo.height}px`;
	}

	private clearRendered(): void {
		this.rendered.clear();
		this.renderedHl = [];
		this.renderedPen = [];
		this.faded = [];
		this.gHl.replaceChildren();
		this.gPen.replaceChildren();
		this.gHlLive.replaceChildren();
		this.gPenLive.replaceChildren();
		this.pendingLive = [];
	}

	/** Transform attribute for a rendered stroke (selection drag prefix + its line offset). */
	private transformFor(s: Stroke, x: number, top: number, selected: ReadonlySet<Stroke> | null): string {
		const prefix = this.dragT && selected?.has(s) ? svgTransform(this.dragT) : "";
		return `${prefix}translate(${x} ${top})`;
	}

	private render(geo: Geometry): void {
		if (this.destroyed) return;
		this.applyGeometry(geo);
		for (const el of this.pendingLive) el.remove();
		this.pendingLive = [];

		const ink = this.path ? this.store.get(this.path) : undefined;
		if (!ink || !this.host.getSettings().inkVisible) {
			if (this.rendered.size) {
				this.rendered.clear();
				this.renderedHl = [];
				this.renderedPen = [];
				this.gHl.replaceChildren();
				this.gPen.replaceChildren();
			}
			this.renderSelection();
			return;
		}

		const view = this.view;
		const doc = view.state.doc;
		const vp = view.viewport;
		const vpTop = vp.from <= 0 ? -Infinity : view.lineBlockAt(vp.from).top - CULL_MARGIN;
		const vpBottom = vp.to >= doc.length ? Infinity : view.lineBlockAt(vp.to).bottom + CULL_MARGIN;

		const hl: Stroke[] = [];
		const pen: Stroke[] = [];
		const tops = new Map<Stroke, XY>();
		for (const s of ink.strokes) {
			const at = this.place(s); // [Stage H] (0, line top), or following its character
			const top = at[1];
			if (s.text) {
				// [Stage C] text highlights: drawn only where their text was measured (in the viewport).
				if (!this.textHl.rowsOf(s)) continue;
			} else {
				const { box } = shapeOf(s);
				if (top + box.maxY < vpTop || top + box.minY > vpBottom) continue;
			}
			tops.set(s, at);
			(s.tool === "highlighter" ? hl : pen).push(s);
		}

		// Drop elements that are no longer visible.
		for (const [s, r] of this.rendered) {
			if (!tops.has(s)) {
				r.el.remove();
				this.rendered.delete(s);
			}
		}
		// Create / position.
		const selected = this.selection ? new Set(this.selection) : null;
		for (const [s, [x, top]] of tops) {
			let r = this.rendered.get(s);
			if (!r) {
				const el = svgEl("path");
				if (!s.text) el.setAttribute("d", shapeOf(s).d);
				paint(el, s);
				if (this.isErasingPrecisely(s)) el.classList.add("pl-hidden");
				r = { el, top: NaN, x: 0, tf: "" };
				this.rendered.set(s, r);
			}
			if (s.text) this.textHl.applyPath(r.el, s, top); // [Stage C] rects reflow with the text
			r.top = top;
			r.x = x;
			const tf = this.transformFor(s, x, top, selected);
			if (r.tf !== tf) {
				r.tf = tf;
				r.el.setAttribute("transform", tf);
			}
		}
		// Z-order: rebuild a group only when its ordered contents changed.
		if (!sameList(hl, this.renderedHl)) {
			this.gHl.replaceChildren(...hl.map((s) => this.rendered.get(s)!.el));
			this.renderedHl = hl;
		}
		if (!sameList(pen, this.renderedPen)) {
			this.gPen.replaceChildren(...pen.map((s) => this.rendered.get(s)!.el));
			this.renderedPen = pen;
		}
		this.renderSelection();
	}

	// -------------------------------------------------------------------------------------------
	// Input
	// -------------------------------------------------------------------------------------------

	private isInkPointer(e: PointerEvent): boolean {
		if (e.pointerType === "pen") return true;
		return e.pointerType === "mouse" && e.button === 0 && this.host.getSettings().mouseDraws;
	}

	/** Events on the context menu are left to its own handlers. */
	private isUiTarget(target: EventTarget | null): boolean {
		if (target === this.guideGrip) return true;
		if (this.spaceUi.isControl(target)) return true; // [Stage K] space controls
		return !!this.menuEl && target instanceof Node && this.menuEl.contains(target);
	}

	private guideEdges(): GuideEdge[] {
		const settings = this.host.getSettings();
		if (!this.guideOrigin || !settings.setSquare) return [];
		return setSquareEdges(this.guideOrigin, settings.setSquareAngle, Math.max(30, Math.min(135, (this.geo?.width ?? 0) / 3)));
	}

	private renderGuide(): void {
		const edges = this.guideEdges();
		const shown = !!this.path && edges.length > 0;
		this.guideOutline.classList.toggle("pl-hidden", !shown);
		this.guideGrip.classList.toggle("pl-hidden", !shown);
		if (!shown) return;
		const [a, b, c] = edges.map(([from]) => from);
		const length = Math.hypot(b[0] - a[0], b[1] - a[1]);
		const dx = (b[0] - a[0]) / length;
		const dy = (b[1] - a[1]) / length;
		const halfCentimeter = 96 / 5.08;
		let outline = `M ${a.join(" ")} L ${b.join(" ")} L ${c.join(" ")} Z`;
		for (let mark = 1; mark * halfCentimeter < length; mark++) {
			const distance = mark * halfCentimeter;
			const x = a[0] + dx * distance;
			const y = a[1] + dy * distance;
			const size = mark % 2 === 0 ? 9 : 5;
			outline += ` M ${x} ${y} l ${-dy * size} ${dx * size}`;
		}
		this.guideOutline.setAttribute("d", outline);
		this.guideGrip.setAttribute("cx", String((a[0] + b[0] + c[0]) / 3));
		this.guideGrip.setAttribute("cy", String((a[1] + b[1] + c[1]) / 3));
	}

	private readonly onGuideDown = (event: PointerEvent): void => {
		if (!this.guideOrigin || this.active || this.guideDrag || event.button !== 0) return;
		event.preventDefault();
		event.stopPropagation();
		const [x, y] = this.toOverlay(event, this.svg.getBoundingClientRect());
		try {
			this.guideGrip.setPointerCapture(event.pointerId);
		} catch {
			return;
		}
		this.guideDrag = { id: event.pointerId, offset: [this.guideOrigin[0] - x, this.guideOrigin[1] - y] };
	};

	private readonly onGuideMove = (event: PointerEvent): void => {
		const drag = this.guideDrag;
		if (!drag || event.pointerId !== drag.id) return;
		const [x, y] = this.toOverlay(event, this.svg.getBoundingClientRect());
		this.guideOrigin = [x + drag.offset[0], y + drag.offset[1]];
		this.renderGuide();
	};

	private readonly onGuideEnd = (event: PointerEvent): void => {
		if (this.guideDrag?.id === event.pointerId) this.guideDrag = null;
	};

	/** Client coordinates → overlay coordinates. */
	private clientToOverlay(clientX: number, clientY: number, rect: DOMRect): XY {
		const sx = this.view.scaleX || 1;
		const sy = this.view.scaleY || 1;
		return [(clientX - rect.left) / sx, (clientY - rect.top) / sy];
	}

	/** Pointer position in overlay coordinates. */
	private toOverlay(e: PointerEvent, rect: DOMRect): [number, number, number] {
		const [x, y] = this.clientToOverlay(e.clientX, e.clientY, rect);
		const p = e.pressure > 0 ? e.pressure : 0.5;
		return [x, y, Math.min(p, 1)];
	}

	private readonly onTouch = (e: TouchEvent): void => {
		if (this.isUiTarget(e.target)) return;
		let stylus = false;
		for (let i = 0; i < e.changedTouches.length; i++) {
			if ((e.changedTouches[i] as Touch & { touchType?: string }).touchType === "stylus") stylus = true;
		}
		if (!stylus) {
			for (let i = 0; i < e.touches.length; i++) {
				if ((e.touches[i] as Touch & { touchType?: string }).touchType === "stylus") stylus = true;
			}
		}
		if (stylus) {
			// Blocks scrolling, selection/caret moves, compat mouse events and iPadOS Scribble.
			if (e.cancelable) e.preventDefault();
			e.stopPropagation();
		} else if (this.active && e.type === "touchmove" && e.cancelable) {
			// A resting palm/finger must not scroll the page out from under an active pen stroke,
			// and a finger dragging the selection must not scroll either.
			e.preventDefault();
		} else if (e.type === "touchstart" && this.selection && e.cancelable && e.touches.length === 1) {
			// A finger starting on the selection drags it instead of scrolling.
			const t = e.changedTouches[0];
			const [x, y] = this.clientToOverlay(t.clientX, t.clientY, this.svg.getBoundingClientRect());
			if (this.hitSel(x, y)) e.preventDefault();
		}
	};

	private readonly onCompatMouse = (e: Event): void => {
		if (this.isUiTarget(e.target)) return;
		if (this.active || performance.now() < this.suppressUntil) {
			e.preventDefault();
			e.stopPropagation();
		}
	};

	/**
	 * Windows / Android: browsers pan the page on a pen drag unless `touch-action` forbids it, and
	 * `touch-action` can't tell a pen from a finger. A hovering pen (Surface Pen, Wacom: pointermove
	 * with no contact) therefore sets `touch-action: none` on the scroller (`.pl-pen-near`) before it
	 * touches; a finger touch or the pen leaving clears it so fingers scroll again. Not on iOS, where
	 * stylus touches are cancelled in `onTouch` and Pencil hover must not block finger scrolling.
	 */
	private penNear = false;
	private setPenNear(on: boolean): void {
		if (on === this.penNear || Platform.isIosApp) return;
		this.penNear = on;
		this.view.scrollDOM.classList.toggle("pl-pen-near", on);
	}

	private readonly onPointerLeave = (e: PointerEvent): void => {
		if (e.pointerType === "pen" && !this.active) this.setPenNear(false);
	};

	private readonly onPointerDown = (e: PointerEvent): void => {
		if (this.isUiTarget(e.target)) return;
		if (e.pointerType === "touch") this.setPenNear(false);
		if (this.isDeskSelectPointer(e)) {
			this.onDeskSelectDown(e); // [Stage F]
			return;
		}
		if (!this.isInkPointer(e)) {
			if (this.belowDrawingDown(e)) return;
			this.onOtherPointerDown(e);
			return;
		}
		// Never let the editor see it: no caret move, no focus change, no selection.
		e.preventDefault();
		e.stopPropagation();
		if (this.active || !this.path || !this.store.isLoaded(this.path)) return;

		const settings = this.host.getSettings();
		if (!settings.inkVisible) this.host.showInk();
		this.capture(e.pointerId);
		// Make sure the overlay is positioned before converting coordinates (event handler: layout reads OK).
		this.applyGeometry(this.readGeometry(this.view));
		const [x, y, p] = this.toOverlay(e, this.svg.getBoundingClientRect());
		const now = performance.now();
		const pen = e.pointerType === "pen";

		// Pen eraser end (Surface Pen etc.: button 5 / buttons & 32) erases regardless of the selected
		// tool, and never counts as a double-tap tap.
		const eraserEnd = isPenEraser(e);
		if (pen) this.host.penSeen();

		// A quick second pen contact near a pending tap may complete a double tap.
		let pairWith: PendingTap | null = null;
		if (this.pendingTap) {
			if (pen && !eraserEnd && canPair(this.pendingTap.tap, x, y, now, this.recentInk)) pairWith = this.pendingTap;
			else this.flushPendingTap();
		}
		const tool: ActiveTool = toolForPress(e, settings.tool);
		const track: TapTrack = { pointerId: e.pointerId, pen: pen && !eraserEnd, downAt: now, downX: x, downY: y, maxMove: 0, pairWith };
		if (tool === "lasso") {
			const hadSelection = !!this.selection;
			const menuWasOpen = !!this.menu;
			if (this.selection) {
				const hit = this.hitSel(x, y);
				if (hit) {
					this.flushPendingTap();
					this.startDrag(e.pointerId, hit, x, y);
					return;
				}
				this.clearSelection();
			}
			this.closeMenu();
			const el = svgEl("path", "pl-lasso-path");
			this.gUi.appendChild(el);
			const lasso: LassoInput = {
				kind: "lasso",
				...track,
				points: [[x, y]],
				el,
				hadSelection,
				menuWasOpen,
				pressTimer: null,
				longPressed: false,
				desk: false,
				rect: false,
			};
			// Long-press (pen still) on empty space offers Paste.
			if (this.host.clipboard && !hadSelection) {
				lasso.pressTimer = window.setTimeout(() => this.onLongPress(lasso), LONG_PRESS_MS);
			}
			this.active = lasso;
			return;
		}
		if (tool === "eraser") {
			const deferred = pen && !eraserEnd && settings.doubleTapEraser;
			const precise: PreciseErase | null =
				settings.eraserMode === "precise" ? { radius: ERASER_RADII[settings.eraserSize], pieces: new Map(), els: new Map() } : null;
			const erase: EraseInput = {
				kind: "erase",
				...track,
				batchId: newId(),
				lastX: x,
				lastY: y,
				deferred,
				highlighterOnly: settings.eraseHighlighterOnly,
				precise,
			};
			this.active = erase;
			this.showEraserCursor(erase, x, y);
			if (!deferred) this.eraseAlong(erase, x, y, x, y);
			return;
		}
		const params = strokeParams(settings, tool);
		const el = svgEl("path");
		paint(el, params);
		(tool === "highlighter" ? this.gHlLive : this.gPenLive).appendChild(el);
		// A stroke starting on a fixed page is bounded to that page from the first sample.
		const sp = spaceAt(this.spaceRects(), y) ?? this.spaceAboveBlank(y);
		const fixedHeight = sp && this.spaceById(sp.id)?.a4 ? sp.height : undefined;
		const startY = sp && fixedHeight ? sp.top + boundSpaceY(y - sp.top, fixedHeight, params.size / 2) : y;
		const smoother = new StrokeSmoother(SMOOTHING_PARAMS[settings.smoothing]);
		smoother.push(x, startY, p, eventTime(e));
		const edge = tool === "pen" && (settings.penShape === "freehand" || settings.penShape === "line")
			? nearestGuideEdge([x, y], this.guideEdges(), 14) : null;
		const shape = edge ? "line" : tool === "pen" ? settings.penShape : "freehand";
		const straight: XY | null = tool === "highlighter" && settings.highlighterStraight ? [x, startY] : null;
		const draw: DrawInput = {
			kind: "draw",
			...track,
			...params,
			points: smoother.points,
			smoother,
			curve: isCenterline(params) ? new CurveBuilder() : null,
			curveFed: 0,
			curveLast: null,
			finalized: false,
			el,
			holdX: x,
			holdY: y,
			lastMoveAt: now,
			holdTimer: null,
			holdTried: false,
			snap: null,
			geometry: shape === "freehand" ? null : { shape, start: edge ? projectToEdge([x, startY], edge) : [x, startY], edge, end: null },
			straight,
			lastScribbleCheck: now,
			scribble: new ScribbleTracker(),
			space: sp ? { id: sp.id, top: sp.top, fixedHeight } : null,
		};
		if (straight) draw.points = straightLine(straight, straight);
		this.active = draw;
		this.armHold(draw);
		this.scheduleLive();
	};

	/** Finger, or mouse when mouse doesn't draw: only interacts with an existing selection. */
	/** A finger/mouse press below a drawing at the very end of the note (where no text line exists). */
	private belowTap: { id: number; x: number; y: number; t: number } | null = null;

	/** Mouse click / finger tap below a drawing that ends the note → a new line under it (`openBelow`). */
	private belowDrawingDown(e: PointerEvent): boolean {
		if (this.selection || this.active) return false;
		if (e.pointerType === "mouse" && e.button !== 0) return false;
		const doc = this.view.state.doc;
		if (!this.spacesAfterLine(doc.lines)) return false;
		this.applyGeometry(this.readGeometry(this.view));
		const [, y] = this.toOverlay(e, this.svg.getBoundingClientRect());
		if (y < this.view.lineBlockAt(doc.length).bottom) return false;
		if (e.pointerType === "mouse") {
			e.preventDefault();
			e.stopPropagation();
			this.openBelow(doc.lines);
		} else {
			this.belowTap = { id: e.pointerId, x: e.clientX, y: e.clientY, t: performance.now() };
		}
		return true;
	}

	private onOtherPointerDown(e: PointerEvent): void {
		if (!this.selection || this.active) return;
		if (e.pointerType === "mouse" && e.button !== 0) return;
		this.applyGeometry(this.readGeometry(this.view));
		const [x, y] = this.toOverlay(e, this.svg.getBoundingClientRect());
		const hit = this.hitSel(x, y);
		if (hit) {
			e.preventDefault();
			e.stopPropagation();
			this.capture(e.pointerId);
			this.startDrag(e.pointerId, hit, x, y);
			return;
		}
		if (e.pointerType === "touch") {
			this.fingerTap = { id: e.pointerId, x: e.clientX, y: e.clientY, t: performance.now() };
		} else {
			this.clearSelection();
		}
	}

	private capture(pointerId: number): void {
		try {
			this.view.scrollDOM.setPointerCapture(pointerId);
		} catch {
			/* not fatal */
		}
	}

	private readonly onPointerMove = (e: PointerEvent): void => {
		const a = this.active;
		if (!a && e.pointerType === "mouse") this.onDeskHover(e); // [Stage F] cursor feedback
		if (!a && e.pointerType === "pen") this.setPenNear(true);
		if (!a || e.pointerId !== a.pointerId) return;
		e.preventDefault();
		e.stopPropagation();
		const rect = this.svg.getBoundingClientRect();
		const evs = typeof e.getCoalescedEvents === "function" ? e.getCoalescedEvents() : [];
		const list = evs.length > 0 ? evs : [e];
		const now = performance.now();
		for (const ev of list) {
			const [x, rawY, p] = this.toOverlay(ev, rect);
			const y = a.kind === "draw" ? this.boundDrawY(a, rawY) : rawY;
			if (a.kind === "drag") {
				a.cur = [x, y];
				a.maxMove = Math.max(a.maxMove, Math.hypot(x - a.start[0], y - a.start[1]));
				continue;
			}
			a.maxMove = Math.max(a.maxMove, Math.hypot(x - a.downX, rawY - a.downY));
			if (a.kind === "draw") {
				if (a.geometry) {
					a.geometry.end = [x, y];
					continue;
				}
				if (a.snap) {
					a.snap.pen = [x, y];
					continue;
				}
				if (a.straight) {
					a.points = straightLine(a.straight, [x, y]);
					continue;
				}
				const tip = a.smoother.tip;
				if (tip && tip[0] === x && tip[1] === y) continue;
				a.smoother.push(x, y, p, eventTime(ev));
				if (Math.hypot(x - a.holdX, y - a.holdY) > HOLD_TOLERANCE) {
					a.holdX = x;
					a.holdY = y;
					a.lastMoveAt = now;
					a.holdTried = false;
				}
			} else if (a.kind === "lasso") {
				if (a.rect) {
					a.points[1] = [x, y]; // [Stage F] rectangle: start + current corner
					continue;
				}
				if (a.longPressed) continue;
				if (a.pressTimer !== null && a.maxMove >= LONG_PRESS_MOVE) this.clearPress(a);
				const last = a.points[a.points.length - 1];
				if (Math.hypot(x - last[0], y - last[1]) >= 1.5) a.points.push([x, y]);
			} else {
				if (a.deferred) {
					if (a.maxMove < TAP.maxMove && now - a.downAt < TAP.maxMs) continue;
					// Clearly not a tap: start erasing from where the pen went down.
					a.deferred = false;
					this.flushPendingTap();
					a.lastX = a.downX;
					a.lastY = a.downY;
				}
				this.eraseAlong(a, a.lastX, a.lastY, x, y);
				a.lastX = x;
				a.lastY = y;
			}
		}
		if (a.kind === "erase") this.showEraserCursor(a, a.lastX, a.lastY);
		if (a.kind === "draw") this.armHold(a);
		if (a.kind === "draw" && a.space) this.growLive(a); // [Stage K]
		if (a.kind !== "erase") this.scheduleLive();
	};

	private readonly onPointerEnd = (e: PointerEvent): void => {
		const completed = e.type === "pointerup";
		const bt = this.belowTap;
		if (bt && e.pointerId === bt.id) {
			this.belowTap = null;
			if (completed && performance.now() - bt.t < FINGER_TAP_MS * 2 && Math.hypot(e.clientX - bt.x, e.clientY - bt.y) < FINGER_TAP_MOVE) {
				this.openBelow(this.view.state.doc.lines);
			}
		}
		const ft = this.fingerTap;
		if (ft && e.pointerId === ft.id) {
			this.fingerTap = null;
			if (
				completed &&
				performance.now() - ft.t < FINGER_TAP_MS &&
				Math.hypot(e.clientX - ft.x, e.clientY - ft.y) < FINGER_TAP_MOVE
			) {
				this.clearSelection();
			}
		}
		const a = this.active;
		if (!a || e.pointerId !== a.pointerId) return;
		// Moving the implicit (touch/pen) capture from the hit element to scrollDOM fires a
		// lostpointercapture on that element which bubbles here — that is not the end of the stroke.
		if (e.type === "lostpointercapture" && e.target !== this.view.scrollDOM) return;
		if (completed) e.preventDefault();
		if (e.type !== "lostpointercapture") e.stopPropagation();
		// A cancellation discards the preview and leaves any earlier tap pending.
		if (completed) this.active = null;
		else this.cancelActive();
		this.suppressUntil = performance.now() + SUPPRESS_MS;
		try {
			if (this.view.scrollDOM.hasPointerCapture(e.pointerId)) this.view.scrollDOM.releasePointerCapture(e.pointerId);
		} catch {
			/* ignore */
		}
		if (this.raf) {
			window.cancelAnimationFrame(this.raf);
			this.raf = 0;
		}
		if (!completed) return;
		if (a.kind === "drag") {
			this.commitDrag(a);
			return;
		}
		if (a.kind === "draw") {
			this.clearHold(a);
			if (a.geometry) {
				const [x, y] = this.toOverlay(e, this.svg.getBoundingClientRect());
				const boundedY = this.boundDrawY(a, y);
				a.maxMove = Math.max(a.maxMove, Math.hypot(x - a.downX, y - a.downY));
				a.geometry.end = [x, boundedY];
				this.updateDrawGeometry(a);
			}
		}
		if (a.kind === "lasso") {
			this.clearPress(a);
			// The long-press already showed Paste; the lift itself does nothing.
			if (a.longPressed) return;
		}

		if (a.kind === "erase") this.eraserCursor.classList.add("pl-hidden");
		const now = performance.now();
		const tap: Tap = { x: a.downX, y: a.downY, downAt: a.downAt, upAt: now, maxMove: a.maxMove };
		const doubleTapOn = a.pen && this.host.getSettings().doubleTapEraser && !(a.kind === "draw" && a.snap);
		if (doubleTapOn) this.recentInk = pruneRecentInk(this.recentInk, now);
		const pending = this.pendingTap;
		if (doubleTapOn && pending && a.pairWith === pending && isDoubleTap(pending.tap, tap, this.recentInk)) {
			// Double tap: neither tap leaves anything behind (no dots, no undo entries).
			this.pendingTap = null;
			window.clearTimeout(pending.timer);
			pending.discard();
			this.discardInput(a);
			this.host.toggleEraser();
			return;
		}
		// Stage E: a tap next to ink written in the last moments is handwriting (i-dot, full stop):
		// it is committed right away and can't start a double tap.
		if (doubleTapOn && isFirstTap(tap, this.recentInk)) {
			this.flushPendingTap();
			// Might be the first tap of a double tap: keep it on screen, commit it only if no second tap follows.
			if (a.kind === "draw") {
				this.finalizePoints(a);
				a.el.setAttribute("d", strokeToPath(this.drawShape(a)));
			}
			this.pendingTap = {
				tap,
				timer: window.setTimeout(() => this.flushPendingTap(), TAP.maxGapMs + 30),
				commit: () => this.completeInput(a),
				discard: () => this.discardInput(a),
			};
			return;
		}
		this.flushPendingTap();
		this.completeInput(a);
	};

	/** Finish a (non-drag) input normally. */
	private completeInput(a: DrawInput | EraseInput | LassoInput): void {
		if (a.kind === "draw") this.finishStroke(a);
		else if (a.kind === "lasso") this.finishLasso(a);
		else {
			if (a.deferred) this.eraseAlong(a, a.downX, a.downY, a.downX, a.downY);
			if (a.precise) this.commitPrecise(a.precise);
		}
	}

	/** [Stage K] Drawing near a space's bottom grows it live (saved with the stroke). */
	private growLive(a: DrawInput): void {
		const sp = a.space && this.spaceById(a.space.id);
		if (!sp || sp.a4 || !a.space) return;
		let maxY = -Infinity;
		for (const p of a.points) if (p[1] > maxY) maxY = p[1];
		const tip = a.smoother.tip;
		if (tip && tip[1] > maxY) maxY = tip[1];
		const cur = this.liveHeights.get(sp.id) ?? sp.height;
		const h = grownHeight(cur, maxY + a.size / 2 - a.space.top);
		if (h > cur) {
			this.liveHeights.set(sp.id, h);
			this.syncSpaces();
		}
	}

	/** [Stage K] Forget a live height (the stroke was discarded). */
	private dropLiveHeight(a: DrawInput): void {
		if (a.space && this.liveHeights.delete(a.space.id)) this.syncSpaces();
	}

	/** Drop an input without any effect (double-tap). */
	private discardInput(a: DrawInput | EraseInput | LassoInput): void {
		if (a.kind === "draw") {
			this.dropLiveHeight(a);
			this.clearFade();
			a.el.remove();
		} else if (a.kind === "lasso") {
			a.el.remove();
		} else if (a.precise) {
			this.cancelPrecise(a.precise);
		}
	}

	private flushPendingTap(): void {
		const p = this.pendingTap;
		if (!p) return;
		this.pendingTap = null;
		window.clearTimeout(p.timer);
		p.commit();
	}

	private discardPendingTap(): void {
		const p = this.pendingTap;
		if (!p) return;
		this.pendingTap = null;
		window.clearTimeout(p.timer);
		p.discard();
	}

	private cancelActive(): void {
		const a = this.active;
		this.active = null;
		if (!a) return;
		if (a.kind === "draw") {
			this.clearHold(a);
			this.dropLiveHeight(a);
			this.clearFade();
			a.el.remove();
		} else if (a.kind === "lasso") {
			this.clearPress(a);
			a.el.remove();
		} else if (a.kind === "drag") {
			this.dragT = null;
			this.scheduleRender();
		} else if (a.kind === "erase") {
			this.eraserCursor.classList.add("pl-hidden");
			if (a.precise) this.cancelPrecise(a.precise);
		}
	}

	private scheduleLive(): void {
		if (this.raf) return;
		this.raf = window.requestAnimationFrame(() => {
			this.raf = 0;
			const a = this.active;
			if (!a) return;
			if (a.kind === "draw") {
				if (a.geometry) this.updateDrawGeometry(a);
				if (a.snap) this.updateSnap(a);
				// [Stage C] live preview: a highlighter stroke over typed text shows the snapped rects.
				const snapped =
					a.tool === "highlighter" && this.host.getSettings().highlighterSnapText !== false
						? this.textHl.livePath(a.smoother.livePoints())
						: null;
				a.el.setAttribute("d", snapped ?? this.livePath(a));
				this.previewScribble(a);
			} else if (a.kind === "lasso") {
				a.el.setAttribute("d", a.rect ? `${polylinePath(rectPolygon(a.points[0], a.points[a.points.length - 1]))} Z` : polylinePath(a.points));
			} else if (a.kind === "drag") {
				this.updateDrag(a);
			}
		});
	}

	/** The stroke being drawn as path input (snapped shapes keep straight segments). */
	private drawShape(a: DrawInput): Pick<Stroke, "tool" | "size" | "style" | "points" | "shape"> {
		return { tool: a.tool, size: a.size, style: a.style, points: a.points, ...(a.snap ? { shape: a.snap.spec.kind } : {}) };
	}

	/**
	 * Path of the in-progress stroke. Freehand centerlines extend a cached curve (only new filtered
	 * points are appended; the raw pen position is the tip, so the ink never trails the pen) and
	 * produce exactly what `strokeToPath` will draw for the committed stroke. Other styles redraw
	 * from the filtered points + tip.
	 */
	private livePath(a: DrawInput): string {
		if (a.geometry && !a.snap) return "";
		if (a.snap || a.straight || a.finalized) return strokeToPath(this.drawShape(a), { last: true });
		const sm = a.smoother;
		if (!a.curve) return strokeToPath({ ...this.drawShape(a), points: sm.livePoints() }, { last: false });
		// Dashed strokes thin their centerline (same rule as `centerlinePath`) so the pattern stays put.
		const minDist = isDashed(a) ? DASH_MIN_DISTANCE : 0;
		for (; a.curveFed < sm.points.length; a.curveFed++) {
			const p = sm.points[a.curveFed];
			const q = a.curveLast;
			if (q && a.curveFed > 0 && Math.hypot(p[0] - q[0], p[1] - q[1]) < minDist) continue;
			a.curve.push(p);
			a.curveLast = p;
		}
		return a.curve.path(sm.tip);
	}

	/** On lift: the final freehand points (filtered + lift point, lightly simplified). Idempotent. */
	private finalizePoints(a: DrawInput): void {
		if (a.finalized || a.snap) return;
		a.finalized = true;
		if (a.straight) return; // already the final straight line
		const off = this.host.getSettings().smoothing === "off";
		a.points = finishPoints(a.smoother.points, a.smoother.tip, isDashed(a), off ? 0 : LIFT_SIGMA);
	}

	// -------------------------------------------------------------------------------------------
	// Finishing strokes, scribble erase
	// -------------------------------------------------------------------------------------------

	private finishStroke(a: DrawInput): void {
		const path = this.path;
		if (a.geometry && !a.snap) {
			this.discardInput(a);
			return;
		}
		this.finalizePoints(a);
		if (!path || !this.store.isLoaded(path) || a.points.length === 0) {
			this.dropLiveHeight(a);
			this.clearFade();
			a.el.remove();
			return;
		}
		if (a.snap) this.updateSnap(a);
		const settings = this.host.getSettings();
		if (a.tool === "pen" && !a.snap && settings.scribbleErase) {
			// Same tracker and same input points as the live preview (not the lift-smoothed ones):
			// erases exactly the faded strokes plus any the last few points added.
			const pts = a.smoother.points;
			const ids = a.scribble.update(pts, performance.now() - a.downAt, (box) => this.scribbleCandidates(box));
			if (ids.size > 0) {
				// The scribble itself is not kept; one undo restores everything it erased.
				this.dropLiveHeight(a);
				this.clearFade();
				a.el.remove();
				this.store.removeStrokes(path, ids, newId());
				return;
			}
		}
		this.clearFade();
		// [Stage C] a highlighter stroke over typed text becomes a text highlight.
		const snapped =
			a.tool === "highlighter" && settings.highlighterSnapText !== false && !a.space // [Stage K] no text in a space
				? this.textHl.snapStroke(a.points, { color: a.color, size: a.size })
				: null;
		if (snapped) {
			a.el.setAttribute("d", snapped.d);
			this.pendingLive.push(a.el);
			if (this.geo) this.store.setContentWidth(path, Math.round(this.geo.width));
			this.store.addStroke(path, snapped.stroke);
			this.scheduleRender();
			return;
		}
		// [Stage K] which space: the one it started in; below the note's end: the end space (new or grown).
		let box = bbox(a.points);
		let rect: SpaceRect | null = null;
		let extra: SpaceEdit = {};
		let fixed = false;
		const live = a.space ? this.liveHeights.get(a.space.id) : undefined;
		if (a.space) {
			this.liveHeights.delete(a.space.id);
			const sp = this.spaceById(a.space.id);
			const cur = this.spaceRects().find((r) => r.id === a.space!.id);
			if (sp && cur) {
				rect = { id: sp.id, top: cur.top, height: sp.height };
				fixed = sp.a4 === true;
				if (live !== undefined && live > sp.height) extra = { resize: [{ id: sp.id, height: live }] };
			}
		} else if (box) {
			const doc = this.view.state.doc;
			const docBottom = this.view.lineBlockAt(doc.length).bottom;
			if (a.downY >= docBottom + END_SPACE_SLACK) {
				const boxes = this.spaceRects();
				const lastBox = boxes.length > 0 ? boxes[boxes.length - 1] : null;
				let last = lastBox && lastBox.at === doc.length ? lastBox : null;
				// A space followed only by ink-free blank lines still ends the drawing: grow it.
				if (!last && lastBox) {
					const run = blankRunBelow(this.blankLine, doc.lines, this.boxLine(lastBox));
					if (run?.toEnd && this.marginOn(run.first, run.last).length === 0) last = { ...lastBox, end: true };
				}
				const a4 = settings.a4DrawingSpaces;
				const plan = endSpacePlan(last && { ...last, a4: this.spaceById(last.id)?.a4 }, docBottom, box.maxY + a.size / 2, a4);
				if (plan.extend) {
					rect = { id: plan.extend, top: plan.top, height: plan.height };
					extra = { resize: [{ id: plan.extend, height: plan.height }] };
				} else {
					const space: InkSpace = { id: newId(), after: "end", ...spaceSize(plan.height, a4) };
					rect = { id: space.id, top: plan.top, height: plan.height };
					extra = { addSpaces: [{ space }] };
					fixed = a4;
				}
			}
		}
		if (fixed && rect && !a.snap) {
			const { top, height } = rect;
			a.points = a.points.map(([x, y, p]): Point => [x, top + boundSpaceY(y - top, height, a.size / 2), p]);
			box = bbox(a.points);
		}
		// Show the final shape until the next render replaces it with the stored stroke.
		a.el.setAttribute("d", strokeToPath(this.drawShape(a)));
		this.pendingLive.push(a.el);
		// The drawing started on blank lines just above this space: those lines' ink joins it.
		const absorb = box ? this.absorbTarget(a, rect, extra, box) : null;
		if (absorb) {
			if (this.geo) this.store.setContentWidth(path, Math.round(this.geo.width));
			this.absorbCommit(path, a, absorb);
			this.recentInk = pruneRecentInk(this.recentInk, performance.now());
			this.recentInk.push({ box: box!, at: performance.now() });
			this.scheduleRender();
			return;
		}
		const { anchor, pos, top, space } = this.anchorFor(a.points, rect);
		const stroke: Stroke = {
			id: newId(),
			tool: a.tool,
			color: a.color,
			size: a.size,
			...(a.style ? { style: a.style } : {}),
			anchor,
			points: a.points.map((p): Point => [p[0], p[1] - top, p[2]]),
			...(a.snap ? { shape: a.snap.spec.kind } : {}),
			pos,
			...(space ? { space } : {}), // [Stage K] drawn in a drawing space
		};
		// [Stage H] over typed text: follow the character under it (or the stroke just drawn).
		if (box && !space) {
			this.charA.anchorUnit([stroke], box, true);
			this.charA.drawn(stroke, box);
		}
		if (this.geo) this.store.setContentWidth(path, Math.round(this.geo.width));
		if (!this.commitStrokes(path, [], [stroke], extra)) {
			a.el.remove();
			this.scheduleRender();
			return;
		}
		if (box) {
			const now = performance.now();
			this.recentInk = pruneRecentInk(this.recentInk, now);
			this.recentInk.push({ box, at: now });
		}
		this.scheduleRender();
	}

	/** Rendered strokes near a scribble, in overlay coordinates. */
	private scribbleCandidates(box: BBox): (ScribbleTarget & { el: SVGPathElement })[] {
		const out: (ScribbleTarget & { el: SVGPathElement })[] = [];
		for (const [s, r] of this.rendered) {
			const b = shapeOf(s).box;
			if (b.maxX + r.x < box.minX || b.minX + r.x > box.maxX || b.maxY + r.top < box.minY || b.minY + r.top > box.maxY) continue;
			out.push({ id: s.id, size: s.size, el: r.el, points: s.points.map((p) => [p[0] + r.x, p[1] + r.top]) });
		}
		return out;
	}

	/** While scribbling: fade the strokes that would be erased (throttled; commit happens on lift). */
	private previewScribble(a: DrawInput): void {
		const s = this.host.getSettings();
		if (a.tool !== "pen" || a.snap || !s.scribbleErase) return;
		const now = performance.now();
		if (now - a.lastScribbleCheck < SCRIBBLE_PREVIEW_MS) return;
		a.lastScribbleCheck = now;
		const ids = a.scribble.update(a.points, now - a.downAt, (box) => this.scribbleCandidates(box));
		this.clearFade();
		if (ids.size === 0) return;
		for (const [s, r] of this.rendered) {
			if (!ids.has(s.id)) continue;
			r.el.classList.add("pl-fade");
			this.faded.push(r.el);
		}
	}

	private clearFade(): void {
		for (const el of this.faded) el.classList.remove("pl-fade");
		this.faded = [];
	}

	/**
	 * Eraser segment (x1, y1) → (x2, y2). Whole-stroke mode removes every rendered stroke it touches
	 * (one undo step per drag via the batch id); precise mode cuts the touched strokes (committed on lift).
	 */
	private eraseAlong(a: EraseInput, x1: number, y1: number, x2: number, y2: number): void {
		if (!this.path) return;
		if (a.precise) {
			this.erasePrecise(a, x1, y1, x2, y2);
			return;
		}
		const ids: string[] = [];
		for (const [s, r] of this.rendered) {
			if (!erasable(s.tool, a.highlighterOnly)) continue;
			const hit = s.text
				? this.textHl.hitSegment(s, x1, y1, x2, y2, STROKE_ERASER_RADIUS) // [Stage C] against its rects
				: hitTestStrokeSegment(s, x1, y1, x2, y2, STROKE_ERASER_RADIUS, r.x, r.top);
			if (hit) ids.push(s.id);
		}
		if (ids.length > 0) this.store.removeStrokes(this.path, ids, a.batchId);
	}

	private isErasingPrecisely(s: Stroke): boolean {
		const a = this.active;
		return a?.kind === "erase" && !!a.precise?.pieces.has(s);
	}

	/** Precise eraser: split the touched strokes' current pieces; draw the pieces live. */
	private erasePrecise(a: EraseInput, x1: number, y1: number, x2: number, y2: number): void {
		const pe = a.precise!;
		const seg = [x1, y1, x2, y2] as const;
		for (const [s, r] of this.rendered) {
			if (!erasable(s.tool, a.highlighterOnly)) continue;
			const reach = pe.radius + s.size / 2;
			let cur = pe.pieces.get(s);
			if (s.text) {
				// [Stage C] text highlights aren't cut: touching their rects erases the whole highlight.
				if (!cur && this.textHl.hitSegment(s, x1, y1, x2, y2, pe.radius)) {
					pe.pieces.set(s, []);
					r.el.classList.add("pl-hidden");
				}
				continue;
			}
			if (!cur) {
				const b = shapeOf(s).box;
				if (
					Math.max(x1, x2) < b.minX + r.x - reach ||
					Math.min(x1, x2) > b.maxX + r.x + reach ||
					Math.max(y1, y2) < b.minY + r.top - reach ||
					Math.min(y1, y2) > b.maxY + r.top + reach
				) {
					continue;
				}
				cur = [s.points.map((q): Point => [q[0] + r.x, q[1] + r.top, q[2]])];
			}
			const next = erasePieces(cur, seg, reach);
			if (!next) continue;
			pe.pieces.set(s, next);
			r.el.classList.add("pl-hidden");
			for (const el of pe.els.get(s) ?? []) el.remove();
			const group = s.tool === "highlighter" ? this.gHlLive : this.gPenLive;
			const els = next.map((pts) => {
				const el = svgEl("path");
				paint(el, s);
				el.setAttribute("d", strokeToPath({ tool: s.tool, size: s.size, style: s.style, points: pts, ...(s.shape ? { shape: "polyline" as const } : {}) }));
				group.appendChild(el);
				return el;
			});
			pe.els.set(s, els);
		}
	}

	/** Lift: replace every cut stroke by its pieces (new ids, re-anchored) as ONE undoable op. */
	private commitPrecise(pe: PreciseErase): void {
		const path = this.path;
		const live = [...pe.els.values()].flat();
		if (pe.pieces.size === 0 || !path || !this.store.isLoaded(path)) {
			this.cancelPrecise(pe);
			return;
		}
		const ink = this.store.get(path);
		const order = new Map((ink?.strokes ?? []).map((s, i) => [s, i] as const));
		const cut = [...pe.pieces.keys()].filter((s) => order.has(s)).sort((p, q) => order.get(p)! - order.get(q)!);
		const next: Stroke[] = [];
		for (const s of cut) {
			const from = this.place(s);
			const own = this.ownSpace(s); // [Stage K] pieces stay in their space
			for (const pts of pe.pieces.get(s)!) {
				const piece = this.anchoredStroke(
					// Pieces of a snapped shape keep straight segments (rendered as a polyline).
					{ tool: s.tool, color: s.color, size: s.size, style: s.style, shape: s.shape ? "polyline" : undefined },
					pts,
					own,
				);
				this.charA.inherit(s, from, piece, [0, this.lineTop(piece)]); // [Stage H] pieces follow its character
				next.push(piece);
			}
		}
		// Originals reappear if they're still on the canvas (e.g. a sync removed them meanwhile, then nothing changes).
		for (const s of pe.pieces.keys()) {
			const r = this.rendered.get(s);
			if (r) r.el.classList.remove("pl-hidden");
		}
		pe.pieces.clear();
		pe.els.clear();
		if (cut.length > 0) {
			this.store.replaceStrokes(
				path,
				cut.map((s) => s.id),
				next,
			);
		}
		// Swap the live pieces for the stored strokes on the next render (no blank frame).
		this.pendingLive.push(...live);
		this.scheduleRender();
	}

	/** Abort a precise erase: originals back, live pieces gone. */
	private cancelPrecise(pe: PreciseErase): void {
		for (const s of pe.pieces.keys()) {
			const r = this.rendered.get(s);
			if (r) r.el.classList.remove("pl-hidden");
		}
		for (const els of pe.els.values()) for (const el of els) el.remove();
		pe.pieces.clear();
		pe.els.clear();
	}

	private showEraserCursor(a: EraseInput, x: number, y: number): void {
		const c = this.eraserCursor;
		c.setAttribute("cx", String(x));
		c.setAttribute("cy", String(y));
		c.setAttribute("r", String(a.precise ? a.precise.radius : STROKE_ERASER_RADIUS));
		c.classList.remove("pl-hidden");
	}

	// -------------------------------------------------------------------------------------------
	// Snap to shape (draw and hold)
	// -------------------------------------------------------------------------------------------

	/** (Re)start the hold timer for a pen stroke unless one is running or the stroke snapped. */
	private armHold(a: DrawInput): void {
		const s = this.host.getSettings();
		if (a.tool !== "pen" || !s.shapeSnap || a.geometry || a.snap || a.holdTimer !== null || a.holdTried) return;
		const wait = Math.max(10, s.shapeHoldMs - (performance.now() - a.lastMoveAt));
		a.holdTimer = window.setTimeout(() => this.onHold(a), wait);
	}

	private boundDrawY(a: DrawInput, y: number): number {
		const space = a.space;
		return space?.fixedHeight ? space.top + boundSpaceY(y - space.top, space.fixedHeight, a.size / 2) : y;
	}

	private updateDrawGeometry(a: DrawInput): void {
		const geometry = a.geometry;
		if (!geometry?.end || a.maxMove < TAP.maxMove) return;
		const end = geometry.edge ? projectToEdge(geometry.end, geometry.edge) : geometry.end;
		if (Math.hypot(end[0] - geometry.start[0], end[1] - geometry.start[1]) < TAP.maxMove) {
			a.snap = null;
			return;
		}
		const spec = draggedShape(geometry.shape, geometry.start, end);
		a.snap = { spec0: spec, spec, p0: geometry.start, pen: null };
		a.points = shapeToPoints(spec).map(([px, py]): Point => [px, py, 0.5]);
	}

	private clearHold(a: DrawInput): void {
		if (a.holdTimer !== null) window.clearTimeout(a.holdTimer);
		a.holdTimer = null;
	}

	private onHold(a: DrawInput): void {
		a.holdTimer = null;
		if (this.active !== a || a.snap) return;
		const holdMs = this.host.getSettings().shapeHoldMs;
		if (performance.now() - a.lastMoveAt < holdMs - 15) {
			this.armHold(a); // moved meanwhile: wait for the remainder
			return;
		}
		a.holdTried = true;
		// Runs once per still period, not per pointermove.
		const spec = recognizeShape(a.points);
		if (!spec) return;
		this.clearFade();
		a.snap = { spec0: spec, spec, p0: [a.holdX, a.holdY], pen: null };
		a.points = shapeToPoints(spec).map((p): Point => [p[0], p[1], 0.5]);
		this.scheduleLive();
	}

	/** Pen moved after the snap: reshape (line end follows; shapes scale from the opposite corner). */
	private updateSnap(a: DrawInput): void {
		const snap = a.snap;
		if (!snap || !snap.pen) return;
		snap.spec = adjustShape(snap.spec0, snap.p0, snap.pen);
		snap.pen = null;
		a.points = shapeToPoints(snap.spec).map((p): Point => [p[0], p[1], 0.5]);
	}

	// -------------------------------------------------------------------------------------------
	// Lasso selection
	// -------------------------------------------------------------------------------------------

	private finishLasso(a: LassoInput): void {
		a.el.remove();
		const ink = this.path ? this.store.get(this.path) : undefined;
		// [Stage H] Select tool: a click on empty space leaves Select and puts the text cursor there.
		if (a.desk && deskRegionRelease(a.maxMove) === "exit-to-text") {
			this.exitSelectToText(a.downX, a.downY);
			return;
		}
		const tap = a.desk ? a.maxMove < CLICK_MOVE : a.points.length < 3 || a.maxMove < 8;
		if (!ink || tap) {
			// A tap: dismisses a selection or an open menu; on empty space it offers Paste.
			this.clearSelection();
			// [Stage F] a mouse click only deselects (Paste: right-click or Cmd+V).
			if (!a.desk && !a.hadSelection && !a.menuWasOpen && this.host.clipboard) this.showPasteMenu([a.downX, a.downY]);
			return;
		}
		// [Stage F] rectangle drag: the rectangle is the loop (same touch rule).
		const loop = a.rect ? rectPolygon(a.points[0], a.points[a.points.length - 1]) : a.points;
		// Stage E filter (pen / highlighter / both), applied before the selection rule.
		const filter = this.host.getSettings().lassoFilter;
		const candidates = filter === "both" ? ink.strokes : ink.strokes.filter((s) => lassoSelects(s.tool, filter));
		// [Stage C] text highlights take part through proxies whose points sample their rects.
		const topOf = (s: Stroke) => this.place(s)[1];
		const leftOf = (s: Stroke) => (s.char ? this.place(s)[0] : 0); // [Stage H]
		const sel = this.textHl.originals(selectInLasso(this.textHl.lassoProxies(candidates, topOf), loop, topOf, leftOf));
		if (sel.length === 0) {
			this.clearSelection();
			return;
		}
		this.setSelection(sel);
		this.showSelectionMenu();
		if (a.desk) this.host.deskSelectionMade(this);
	}

	/** Pen held still at the start of a lasso: cancel the loop and offer Paste. */
	private onLongPress(a: LassoInput): void {
		a.pressTimer = null;
		if (this.active !== a || a.maxMove >= LONG_PRESS_MOVE || !this.host.clipboard) return;
		a.longPressed = true;
		a.el.remove();
		this.showPasteMenu([a.downX, a.downY]);
	}

	private clearPress(a: LassoInput): void {
		if (a.pressTimer !== null) window.clearTimeout(a.pressTimer);
		a.pressTimer = null;
	}

	private setSelection(strokes: Stroke[]): void {
		this.selection = strokes;
		this.dragT = null;
		this.scheduleRender();
		this.host.inkSelectionChanged(); // [Stage F]
	}

	clearSelection(): void {
		if (this.menu?.kind === "selection") this.closeMenu();
		if (!this.selection && !this.dragT) return;
		this.selection = null;
		this.dragT = null;
		if (this.active?.kind === "drag") this.active = null;
		this.scheduleRender();
		this.host.inkSelectionChanged(); // [Stage F]
	}

	/** After any store change: keep only selected strokes that are still on the canvas. */
	private validateSelection(): void {
		if (!this.selection) return;
		const ink = this.path ? this.store.get(this.path) : undefined;
		const onCanvas = new Set(ink?.strokes ?? []);
		const kept = this.selection.filter((s) => onCanvas.has(s));
		if (kept.length === 0) this.clearSelection();
		else if (kept.length !== this.selection.length) this.selection = kept;
	}

	/** Selected strokes in z-order (as on the canvas). */
	private orderedSelection(): Stroke[] {
		const sel = this.selection ?? [];
		const ink = this.path ? this.store.get(this.path) : undefined;
		if (!ink) return [...sel];
		const order = new Map(ink.strokes.map((s, i) => [s, i] as const));
		return [...sel].sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0));
	}

	/** Untransformed overlay bbox of the selection (strokes padded by their width). */
	private selectionBox(): BBox | null {
		if (!this.selection || this.selection.length === 0) return null;
		let minX = Infinity;
		let minY = Infinity;
		let maxX = -Infinity;
		let maxY = -Infinity;
		for (const s of this.selection) {
			const r = this.rendered.get(s);
			const [x, top] = r ? [r.x, r.top] : this.place(s); // [Stage H] x: character-anchored shift
			const b = this.textHl.localBox(s, top) ?? shapeOf(s).box; // [Stage C]
			minX = Math.min(minX, b.minX + x);
			maxX = Math.max(maxX, b.maxX + x);
			minY = Math.min(minY, b.minY + top);
			maxY = Math.max(maxY, b.maxY + top);
		}
		return { minX: minX - SEL_PAD, minY: minY - SEL_PAD, maxX: maxX + SEL_PAD, maxY: maxY + SEL_PAD };
	}

	private hitSel(x: number, y: number): SelectionHit {
		const b = this.selectionBox();
		return b ? hitSelection(b, x, y, HANDLE_HIT, 4) : null;
	}

	private startDrag(pointerId: number, hit: Exclude<SelectionHit, null>, x: number, y: number): void {
		const b = this.selectionBox();
		if (!b) return;
		this.active = {
			kind: "drag",
			pointerId,
			mode: hit === "handle" ? "scale" : "move",
			start: [x, y],
			cur: [x, y],
			origin: [b.minX, b.minY],
			handle: [b.maxX, b.maxY],
			maxMove: 0,
		};
		this.dragT = { ...IDENTITY };
		this.renderSelection();
	}

	private dragTransform(a: DragInput): SelectionTransform {
		if (a.mode === "move") return { dx: a.cur[0] - a.start[0], dy: a.cur[1] - a.start[1], scale: 1, ox: 0, oy: 0 };
		// The handle follows the pointer (keeping the grab offset).
		const target: XY = [a.cur[0] + a.handle[0] - a.start[0], a.cur[1] + a.handle[1] - a.start[1]];
		return { dx: 0, dy: 0, scale: handleScale(a.origin, a.handle, target), ox: a.origin[0], oy: a.origin[1] };
	}

	/** Per frame while dragging: only transforms of the selected elements + the selection box. */
	private updateDrag(a: DragInput): void {
		if (!this.selection) return;
		this.dragT = a.maxMove < SEL_TAP_MOVE ? { ...IDENTITY } : this.dragTransform(a);
		const prefix = svgTransform(this.dragT);
		for (const s of this.selection) {
			const r = this.rendered.get(s);
			if (!r) continue;
			const tf = `${prefix}translate(${r.x} ${r.top})`;
			if (r.tf !== tf) {
				r.tf = tf;
				r.el.setAttribute("transform", tf);
			}
		}
		this.renderSelection();
	}

	private commitDrag(a: DragInput): void {
		if (a.maxMove < SEL_TAP_MOVE) {
			// A tap on the selection (pen or finger) just keeps the menu (it is always shown).
			this.dragT = null;
			this.scheduleRender();
			return;
		}
		// The menu was hidden while dragging; the next render shows it again, re-placed.
		const t = this.selection ? this.dragTransform(a) : null;
		this.dragT = null;
		if (!t || isIdentity(t) || !this.selection || !this.path) {
			this.scheduleRender();
			return;
		}
		// [Stage C] a moved/scaled text highlight detaches from the text: freehand capsules per row.
		const parts = this.textHl.asFreehand(this.selection, (s) => this.lineTop(s));
		const moved = this.groupCopies(parts, t); // [Stage K] into / out of a space as one group
		this.anchorGroup(moved); // [Stage H] the moved group follows ONE character if it qualifies
		this.replaceSelection(moved);
	}

	/** Overlay points of `s` transformed by `t` (or as shown, when `t` is null). */
	private overlayPoints(s: Stroke, t: SelectionTransform | null): Point[] {
		const [x, top] = this.place(s); // [Stage H] x ≠ 0 for shifted character-anchored ink
		return t ? transformPoints(s.points, top, t, x) : s.points.map((p): Point => [p[0] + x, p[1] + top, p[2]]);
	}

	private copyProps(s: Stroke, t: SelectionTransform | null, patch: Partial<Stroke> = {}): Pick<Stroke, "tool" | "color" | "size" | "style" | "shape"> {
		return {
			tool: s.tool,
			color: s.color,
			size: t ? scaledSize(s.size, t) : s.size,
			...(s.style ? { style: s.style } : {}),
			...(s.shape ? { shape: s.shape } : {}),
			...patch,
		};
	}

	/**
	 * A copy of `s` with a new id, transformed in overlay space (or not, when `t` is null), with
	 * `patch` applied, re-anchored to the line under its new top — [Stage K] or kept in its space.
	 */
	private transformedCopy(s: Stroke, t: SelectionTransform | null, patch: Partial<Stroke> = {}): Stroke {
		return this.anchoredStroke(this.copyProps(s, t, patch), this.overlayPoints(s, t), t ? null : this.ownSpace(s));
	}

	/**
	 * [Stage K] Transformed copies of a group (lasso move/scale, duplicate): the group joins the
	 * space holding the centre of its bounding box (`groupSpace`), as one piece, or none.
	 */
	private groupCopies(strokes: readonly Stroke[], t: SelectionTransform): Stroke[] {
		const items = strokes.map((s) => ({ s, pts: this.overlayPoints(s, t) }));
		const sp = groupSpace(this.spaceRects(), items.map((i) => i.pts));
		return items.map(({ s, pts }) => this.anchoredStroke(this.copyProps(s, t), pts, sp));
	}

	/** [Stage K] The laid-out space a stroke is in (null: none, or not shown). */
	private ownSpace(s: Stroke): SpaceRect | null {
		if (!s.space) return null;
		return this.spaceRects().find((r) => r.id === s.space) ?? null;
	}

	/** A new stroke (new id) from overlay-space points, anchored to the line under its top ([Stage K] or in `space`). */
	private anchoredStroke(props: Pick<Stroke, "tool" | "color" | "size" | "style" | "shape">, pts: readonly Point[], space: SpaceRect | null = null): Stroke {
		const { anchor, pos, top, space: sp } = this.anchorFor(pts, space);
		return {
			id: newId(),
			tool: props.tool,
			color: props.color,
			size: props.size,
			...(props.style ? { style: props.style } : {}),
			...(props.shape ? { shape: props.shape } : {}),
			anchor,
			points: pts.map((p): Point => [p[0], p[1] - top, p[2]]),
			pos,
			...(sp ? { space: sp } : {}), // [Stage K] in a drawing space
		};
	}

	/**
	 * Replace the selected strokes (all, or those in `only`) with `next` as ONE undoable op; the
	 * selection becomes the new strokes (plus untouched selected ones).
	 */
	private replaceSelection(next: Stroke[], only?: Stroke[]): void {
		const path = this.path;
		const sel = this.selection;
		if (!path || !sel) return;
		const replaced = only ?? sel;
		const keep = sel.filter((s) => !replaced.includes(s));
		// Set first: the store's change event validates the selection against the canvas.
		this.selection = [...keep, ...next];
		if (!this.commitStrokes(
			path,
			replaced.map((s) => s.id),
			next,
		)) this.selection = sel;
		this.scheduleRender();
	}

	// -------------------------------------------------------------------------------------------
	// Selection actions (context menu)
	// -------------------------------------------------------------------------------------------

	private deleteSelection(): void {
		const sel = this.selection;
		if (!sel || !this.path) return;
		this.clearSelection();
		this.store.removeStrokes(
			this.path,
			sel.map((s) => s.id),
		);
	}

	private duplicateSelection(): void {
		const path = this.path;
		if (!this.selection || !path || !this.store.isLoaded(path)) return;
		const t: SelectionTransform = { dx: DUPLICATE_OFFSET, dy: DUPLICATE_OFFSET, scale: 1, ox: 0, oy: 0 };
		const topOf = (s: Stroke) => this.lineTop(s);
		const copies = this.groupCopies(this.textHl.asFreehand(this.orderedSelection(), topOf), t); // [Stage C/K]
		this.anchorGroup(copies); // [Stage H]
		const previous = this.selection;
		this.selection = copies;
		if (!this.commitStrokes(path, [], copies)) this.selection = previous;
		this.scheduleRender();
		this.host.inkSelectionChanged(); // [Stage F]
	}

	/**
	 * Copy the selection to the plugin clipboard (works across notes) and, best effort, a PNG of
	 * it to the system clipboard. Must run inside the tap (Safari's clipboard gesture rule).
	 */
	private copySelection(): boolean {
		const box = this.selectionBox();
		const topOf = (s: Stroke) => this.lineTop(s);
		const items = this.textHl
			.asFreehand(this.orderedSelection(), topOf) // [Stage C]
			.map((s): RenderStroke => {
				const [x, top] = this.place(s); // [Stage H]
				return { stroke: this.shiftedX(s, x), top };
			});
		const clip = makeClip(items);
		if (!clip || !box) return false;
		this.host.clipboard = clip;
		try {
			const region = rectFromBox(box);
			const look = this.lookAndFeel();
			const canvas = renderInkCanvas({ strokes: () => items, background: look.background, paint: look.paint }, region, CLIPBOARD_PNG_SCALE);
			const png = new Promise<Blob>((resolve, reject) =>
				canvas.toBlob((b) => {
					freeCanvas(canvas);
					if (b) resolve(b);
					else reject(new Error("toBlob failed"));
				}, "image/png"),
			);
			void copyPngToClipboard(png);
		} catch (err) {
			console.warn("[pencil-layer] PNG for the system clipboard failed", err);
		}
		return true;
	}

	private cutSelection(): void {
		if (this.copySelection()) this.deleteSelection();
	}

	/** Paste the plugin clipboard centered at `at` (overlay space) as one undoable op; selects it. */
	private paste(at: XY): void {
		const clip = this.host.clipboard;
		const path = this.path;
		this.closeMenu();
		if (!clip || !path || !this.store.isLoaded(path) || clip.strokes.length === 0) return;
		const origin = pasteOrigin(clip, at, this.geo?.width ?? 0);
		const placed = placeClip(clip, origin);
		const sp = groupSpace(this.spaceRects(), placed.map((p) => p.points)); // [Stage K]
		const strokes = placed.map(({ stroke, points }) => this.anchoredStroke(stroke, points, sp));
		this.anchorGroup(strokes); // [Stage H]
		if (this.geo) this.store.setContentWidth(path, Math.round(this.geo.width));
		const previous = this.selection;
		this.selection = strokes;
		if (!this.commitStrokes(path, [], strokes)) this.selection = previous;
		this.scheduleRender();
		this.host.inkSelectionChanged(); // [Stage F]
	}

	/** Recolor: pens get pen colors; a highlighter-only selection gets highlighter colors. */
	private recolorSelection(color: string): void {
		const sel = this.selection;
		if (!sel) return;
		const tool = this.colorTool();
		const targets = sel.filter((s) => s.tool === tool && s.color !== color);
		if (targets.length === 0) return;
		this.replaceSelection(
			// [Stage C] recolored text highlights stay text highlights.
			targets.map((s) => this.textHl.recolor(s, color) ?? this.recolored(s, color)),
			targets,
		);
	}

	/** A recolored copy (new id) in place; [Stage H] it keeps following its character. */
	private recolored(s: Stroke, color: string): Stroke {
		const copy = this.transformedCopy(s, null, { color });
		this.charA.inherit(s, this.place(s), copy, [0, this.lineTop(copy)]);
		return copy;
	}

	private colorTool(): Tool {
		return this.selection?.some((s) => s.tool === "pen") ? "pen" : "highlighter";
	}

	/** Theme colors for rasterizing ink (resolved now, from the editor's CSS variables). */
	private lookAndFeel(): { background: string; paint: { ink: string; multiplyHighlighter: boolean; dark: boolean } } {
		const probe = this.view.scrollDOM.createDiv({ cls: "pl-color-probe" });
		const cs = getComputedStyle(probe);
		const ink = cs.color || "#000";
		let background = cs.backgroundColor;
		probe.remove();
		if (!background || background === "transparent" || background === "rgba(0, 0, 0, 0)") {
			background = activeDocument.body.classList.contains("theme-dark") ? "#1e1e1e" : "#ffffff";
		}
		const dark = activeDocument.body.classList.contains("theme-dark");
		return { background, paint: { ink, multiplyHighlighter: activeDocument.body.classList.contains("theme-light"), dark } };
	}

	/** Open the screenshot modal for the current selection. */
	private screenshotSelection(): void {
		const box = this.selectionBox();
		const path = this.path;
		const geo = this.geo;
		if (!box || !path || !geo) return;
		const sd = this.view.scrollDOM;
		const sel = rectFromBox(box);
		const limits = { x: -geo.left, y: 0, w: Math.max(sd.scrollWidth, geo.left + geo.width), h: Math.max(geo.height, box.maxY) };
		const stage = stageRect(sel, { x: 0, w: geo.width }, limits);
		const look = this.lookAndFeel();
		const view = this.view;
		const name = path.slice(path.lastIndexOf("/") + 1).replace(/\.md$/i, "");
		this.host.openScreenshot({
			notePath: path,
			noteBasename: name,
			selection: sel,
			stage,
			background: look.background,
			paint: look.paint,
			strokes: (r) => {
				const ink = this.path === path ? this.store.get(path) : undefined;
				const out: RenderStroke[] = [];
				const topOf = (s: Stroke) => this.lineTop(s);
				for (const s of this.textHl.asFreehand(ink?.strokes ?? [], topOf)) { // [Stage C]
					const [x, top] = this.place(s); // [Stage H]
					const b = shapeOf(s).box;
					if (b.maxX + x < r.x || b.minX + x > r.x + r.w || b.maxY + top < r.y || b.minY + top > r.y + r.h) continue;
					out.push({ stroke: this.shiftedX(s, x), top });
				}
				return out;
			},
			rasterizeText: (r, scale) => rasterizeEditorText(view, r, scale),
			insertAtCursor: (text) => {
				if (this.destroyed || this.path !== path) return false;
				const st = view.state;
				const head = st.selection.main.head;
				const line = st.doc.lineAt(head);
				const ins = embedInsertion(st.doc.sliceString(line.from, head), st.doc.sliceString(head, line.to), text);
				// No focus() and no scrollIntoView: the caret just ends up after the embed.
				view.dispatch({ changes: { from: head, insert: ins }, selection: { anchor: head + ins.length }, userEvent: "input" });
				return true;
			},
		});
	}

	// -------------------------------------------------------------------------------------------
	// [Stage F] Desktop Select tool (mouse) + keyboard actions
	// -------------------------------------------------------------------------------------------

	/** A mouse press handled by the desktop Select tool (active, ink shown, primary/secondary button). */
	private isDeskSelectPointer(e: PointerEvent): boolean {
		if (e.pointerType !== "mouse" || (e.button !== 0 && e.button !== 2)) return false;
		if (this.host.deskSelect() === null || !this.host.getSettings().inkVisible) return false;
		// The scroller's own scrollbar keeps working.
		const sd = this.view.scrollDOM;
		const r = sd.getBoundingClientRect();
		return e.clientX - r.left < sd.clientWidth && e.clientY - r.top < sd.clientHeight;
	}

	/**
	 * Select tool press: on the selection → move/scale it; on a stroke → select it (and drag it if
	 * the mouse moves); elsewhere → rectangle / freeform lasso. Never reaches the editor: no caret
	 * move, no text selection. Right-click on empty space offers Paste (ink clipboard non-empty).
	 */
	private onDeskSelectDown(e: PointerEvent): void {
		if (this.active || !this.path || !this.store.isLoaded(this.path)) return;
		this.applyGeometry(this.readGeometry(this.view));
		const [x, y] = this.toOverlay(e, this.svg.getBoundingClientRect());
		const hit = this.selection ? this.hitSel(x, y) : null;
		// Right-click only distinguishes the selection from everything else (no stroke hit-test).
		const stroke = !hit && e.button === 0 ? this.strokeAt(x, y) : null;
		const target: DeskTarget = hit === "handle" ? "handle" : hit ? "selection" : stroke ? "stroke" : "empty";
		const action = deskPress(target, e.button, !!this.host.clipboard);
		if (action === "pass") return;
		if (action === "paste-menu") {
			e.preventDefault();
			e.stopPropagation();
			this.suppressUntil = performance.now() + SUPPRESS_MS; // swallows the contextmenu event
			this.clearSelection();
			this.showPasteMenu([x, y]);
			return;
		}
		e.preventDefault();
		e.stopPropagation();
		this.releaseOutsideFocus();
		this.capture(e.pointerId);
		if (hit) {
			this.startDrag(e.pointerId, hit, x, y);
			return;
		}
		if (stroke) {
			// Click selects the stroke; pressing and dragging moves it right away (desktop convention).
			this.closeMenu();
			this.setSelection([stroke]);
			this.showSelectionMenu();
			this.host.deskSelectionMade(this);
			this.startDrag(e.pointerId, "inside", x, y);
			return;
		}
		const hadSelection = !!this.selection;
		const menuWasOpen = !!this.menu;
		this.clearSelection();
		this.closeMenu();
		const rect = this.host.deskSelect() === "rect";
		const el = svgEl("path", "pl-lasso-path");
		this.gUi.appendChild(el);
		this.active = {
			kind: "lasso",
			pointerId: e.pointerId,
			pen: false,
			downAt: performance.now(),
			downX: x,
			downY: y,
			maxMove: 0,
			pairWith: null,
			points: rect ? [[x, y], [x, y]] : [[x, y]],
			el,
			hadSelection,
			menuWasOpen,
			pressTimer: null,
			longPressed: false,
			desk: true,
			rect,
		};
	}

	/**
	 * [Stage H] A click on empty space with Select on: deselect, turn Select off and put the text
	 * cursor at the clicked spot (overlay x, y) with the editor focused, so the user can type at once.
	 */
	private exitSelectToText(x: number, y: number): void {
		this.clearSelection();
		this.closeMenu();
		this.host.exitDeskSelect();
		const r = this.svg.getBoundingClientRect();
		const pos = this.view.posAtCoords({ x: r.left + x * (this.view.scaleX || 1), y: r.top + y * (this.view.scaleY || 1) }, false);
		this.host.deskSelectionMade(this); // makes this leaf the active one
		this.view.dispatch({ selection: { anchor: pos }, userEvent: "select.pointer" });
		this.view.focus();
	}

	/**
	 * Focus in another pane (a sidebar search box, another editor) would keep receiving keys after
	 * this press — which is preventDefault'ed, so the browser doesn't move focus itself. Blur it, as
	 * a normal click in the note would, so Delete / Cmd+C reach the ink selection.
	 */
	private releaseOutsideFocus(): void {
		const el = this.view.dom.ownerDocument.activeElement;
		if (el?.instanceOf(HTMLElement) && el !== el.ownerDocument.body && !this.view.dom.contains(el)) el.blur();
	}

	/** The topmost (rendered, selectable) stroke within a few px of (x, y), overlay space. */
	private strokeAt(x: number, y: number): Stroke | null {
		const ink = this.path ? this.store.get(this.path) : undefined;
		if (!ink) return null;
		const filter = this.host.getSettings().lassoFilter;
		const cands = ink.strokes.filter((s) => this.rendered.has(s) && lassoSelects(s.tool, filter));
		return pickTopmost(cands, (s) => {
			const { top, x: ox } = this.rendered.get(s)!; // [Stage H] ox: character-anchored shift
			if (s.text) return this.textHl.hitSegment(s, x, y, x, y, CLICK_TOLERANCE); // [Stage C]
			const b = shapeOf(s).box;
			const r = CLICK_TOLERANCE;
			if (x - ox < b.minX - r || x - ox > b.maxX + r || y < b.minY + top - r || y > b.maxY + top + r) return false;
			return strokeNear(s, top, x - ox, y);
		});
	}

	/** Mouse moving with no input in progress: remember it (paste target) and update the cursor. */
	private onDeskHover(e: PointerEvent): void {
		if (this.host.deskSelect() === null) {
			this.hoverAt = null;
			return;
		}
		const [x, y] = this.clientToOverlay(e.clientX, e.clientY, this.svg.getBoundingClientRect());
		this.hoverAt = [x, y];
		if (this.hoverRaf) return;
		this.hoverRaf = window.requestAnimationFrame(() => {
			this.hoverRaf = 0;
			const at = this.hoverAt;
			if (!at || this.active || this.host.deskSelect() === null) return;
			const hit = this.selection ? this.hitSel(at[0], at[1]) : null;
			this.setHoverCursor(hit === "handle" ? "resize" : hit === "inside" ? "move" : this.strokeAt(at[0], at[1]) ? "pointer" : "");
		});
	}

	/** Cursor feedback over the note: "pointer" (a stroke), "move" (the selection), "resize" (handle). */
	private setHoverCursor(c: string): void {
		if (c === this.hoverCursor) return;
		const cl = this.view.scrollDOM.classList;
		if (this.hoverCursor) cl.remove(`pl-cur-${this.hoverCursor}`);
		if (c) cl.add(`pl-cur-${c}`);
		this.hoverCursor = c;
	}

	/** An ink selection exists in this view. */
	get hasSelection(): boolean {
		return !!this.selection && this.selection.length > 0;
	}

	/** Keyboard action (routed by the plugin, see select.ts `routeInkKey`). */
	runKeyAction(action: InkKeyAction): void {
		switch (action) {
			case "deselect":
				this.clearSelection();
				this.closeMenu();
				break;
			case "delete":
				this.deleteSelection();
				break;
			case "copy":
				this.copySelection();
				break;
			case "cut":
				this.cutSelection();
				break;
			case "duplicate":
				this.duplicateSelection();
				break;
			case "paste":
				this.paste(this.pasteTarget());
				if (this.selection) this.host.deskSelectionMade(this);
				break;
			case "exit-select":
				break; // handled by the plugin
		}
	}

	/** Where Cmd+V pastes: at the mouse if it is over the visible note, else the middle of the view. */
	private pasteTarget(): XY {
		const sd = this.view.scrollDOM;
		const geo = this.geo ?? this.readGeometry(this.view);
		const vis = {
			minX: sd.scrollLeft - geo.left,
			minY: sd.scrollTop - geo.top,
			maxX: sd.scrollLeft - geo.left + sd.clientWidth,
			maxY: sd.scrollTop - geo.top + sd.clientHeight,
		};
		const h = this.hoverAt;
		if (h && h[0] >= vis.minX && h[0] <= vis.maxX && h[1] >= vis.minY && h[1] <= vis.maxY) return h;
		return [geo.width / 2, (vis.minY + vis.maxY) / 2];
	}

	// -------------------------------------------------------------------------------------------
	// Selection box + context menu rendering
	// -------------------------------------------------------------------------------------------

	private showSelectionMenu(): void {
		this.menu = { kind: "selection", colors: false };
		this.menuKey = "";
		this.buildMenu();
		this.renderSelection();
	}

	private showPasteMenu(at: XY): void {
		if (!this.host.clipboard) return;
		this.menu = { kind: "paste", at };
		this.menuKey = "";
		this.buildMenu();
		this.renderSelection();
	}

	private closeMenu(): void {
		if (!this.menu) return;
		this.menu = null;
		this.menuKey = "";
		if (this.menuEl) this.menuEl.classList.add("pl-hidden");
	}

	/** Draw the dashed selection box, its handle and the context menu (or hide them). */
	private renderSelection(): void {
		const box = this.selection && this.host.getSettings().inkVisible ? this.selectionBox() : null;
		if (!box) {
			this.selRect.classList.add("pl-hidden");
			this.selHandle.classList.add("pl-hidden");
		} else {
			const b = this.dragT ? transformBox(box, this.dragT) : box;
			const r = this.selRect;
			r.classList.remove("pl-hidden");
			r.setAttribute("x", String(b.minX));
			r.setAttribute("y", String(b.minY));
			r.setAttribute("width", String(Math.max(1, b.maxX - b.minX)));
			r.setAttribute("height", String(Math.max(1, b.maxY - b.minY)));
			this.selHandle.classList.remove("pl-hidden");
			this.selHandle.setAttribute("cx", String(b.maxX));
			this.selHandle.setAttribute("cy", String(b.maxY));
		}
		this.renderMenu(box);
	}

	private renderMenu(box: BBox | null): void {
		// A selection always has its menu (hidden only while it is dragged/resized, below).
		const next = menuForSelection(this.menu, !!box);
		if (next !== this.menu) {
			this.menu = next;
			this.menuKey = "";
			if (next) this.buildMenu();
		}
		const el = this.menuEl;
		if (!el) return;
		// Hidden while the selection is being moved/resized (a press that hasn't moved yet may be a tap).
		const dragging = this.active?.kind === "drag" && this.active.maxMove >= SEL_TAP_MOVE;
		if (!this.menu || !this.geo || dragging || !this.host.getSettings().inkVisible) {
			el.classList.add("pl-hidden");
			return;
		}
		const geo = this.geo;
		const target: BBox =
			this.menu.kind === "paste"
				? { minX: this.menu.at[0], minY: this.menu.at[1], maxX: this.menu.at[0], maxY: this.menu.at[1] }
				: box!;
		const t: BBox = { minX: target.minX + geo.left, minY: target.minY + geo.top, maxX: target.maxX + geo.left, maxY: target.maxY + geo.top };
		el.classList.remove("pl-hidden");
		const w = el.offsetWidth;
		const h = el.offsetHeight;
		const key = `${this.menu.kind}:${this.menu.kind === "selection" && this.menu.colors}:${t.minX},${t.minY},${t.maxX},${t.maxY}:${w}x${h}`;
		// Placed once per target/content: scrolling the note doesn't make it jump around.
		if (key === this.menuKey) return;
		this.menuKey = key;
		const sd = this.view.scrollDOM;
		const visible: BBox = { minX: sd.scrollLeft, minY: sd.scrollTop, maxX: sd.scrollLeft + sd.clientWidth, maxY: sd.scrollTop + sd.clientHeight };
		const p = placeMenu(t, { width: w, height: h }, visible);
		el.style.left = `${p.left}px`;
		el.style.top = `${p.top}px`;
		el.dataset.side = p.side;
	}

	private ensureMenuEl(): HTMLElement {
		if (this.menuEl) return this.menuEl;
		const el = this.view.scrollDOM.createDiv({ cls: "pl-menu", attr: { role: "menu" } });
		// Never take focus from the editor; never let CM or our ink handlers see these presses.
		const keep = (e: Event) => {
			e.preventDefault();
			e.stopPropagation();
		};
		el.addEventListener("pointerdown", keep);
		el.addEventListener("mousedown", keep);
		el.addEventListener("touchstart", (e) => e.stopPropagation(), { passive: true });
		// Pencil taps: no Scribble on the menu; items activate on pen pointerup (tap.ts).
		blockStylusTouch(el);
		this.menuEl = el;
		return el;
	}

	private buildMenu(): void {
		const el = this.ensureMenuEl();
		el.empty();
		const m = this.menu;
		if (!m) return;
		if (m.kind === "paste") {
			const at = m.at;
			this.menuItem(el, "clipboard-paste", "Paste", () => this.paste(at));
			return;
		}
		if (m.colors) {
			this.menuItem(el, "chevron-left", "Back", () => this.setColorsOpen(false), "pl-menu-back");
			const palette = this.colorTool() === "pen" ? PEN_COLORS : HIGHLIGHTER_COLORS;
			for (const c of palette) {
				const b = this.menuItem(el, null, c.label, () => this.recolorSelection(c.value), "pl-menu-color");
				b.createSpan({ cls: "pl-color-dot" }).style.background = cssColor(c.value);
			}
			return;
		}
		this.menuItem(el, "copy", "Copy", () => this.copySelection());
		this.menuItem(el, "scissors", "Cut", () => this.cutSelection());
		this.menuItem(el, "copy-plus", "Duplicate", () => this.duplicateSelection());
		this.menuItem(el, "trash-2", "Delete", () => this.deleteSelection());
		this.menuItem(el, "palette", "Color", () => this.setColorsOpen(true), "pl-menu-sub");
		this.menuItem(el, "camera", "Screenshot", () => this.screenshotSelection());
		// [Stage K] line-anchored ink → a protected drawing space where it is.
		if (this.selection?.some((s) => !s.space && !s.text)) this.menuItem(el, "square-dashed", "Make drawing space", () => this.makeDrawingSpace());
	}

	private setColorsOpen(open: boolean): void {
		if (this.menu?.kind !== "selection") return;
		this.menu.colors = open;
		this.buildMenu();
		this.renderSelection();
	}

	/** A menu entry: icon + label (color swatches show only the swatch; the label is for a11y). */
	private menuItem(parent: HTMLElement, icon: string | null, label: string, run: () => void, cls = ""): HTMLElement {
		const b = parent.createDiv({
			cls: `pl-menu-item ${cls}`.trim(),
			attr: { role: "menuitem", tabindex: "-1", "aria-label": label },
		});
		if (icon) {
			setIcon(b.createSpan({ cls: "pl-menu-icon" }), icon);
			if (cls !== "pl-menu-back") b.createSpan({ cls: "pl-menu-label", text: label });
		} else {
			setTooltip(b, label, { placement: "top" });
		}
		if (cls === "pl-menu-sub") setIcon(b.createSpan({ cls: "pl-menu-chevron" }), "chevron-right");
		onTap(b, run);
		return b;
	}
}

const SUPPRESSED = ["mousedown", "mouseup", "click", "dblclick", "auxclick", "contextmenu"] as const;

function sameList<T>(a: readonly T[], b: readonly T[]): boolean {
	if (a.length !== b.length) return false;
	for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
	return true;
}

/** The editor extension: ink overlay plugin + room to draw past the end of the note. */
export function inkExtension(host: InkHost): Extension {
	const plugin = ViewPlugin.define((view) => new InkView(view, host));
	return [
		plugin,
		// Typing below a drawing: ↓ on the last line, Enter at the end of a paragraph line before one.
		Prec.highest(
			keymap.of([
				{ key: "ArrowDown", run: (v) => v.plugin(plugin)?.arrowDown() ?? false },
				{ key: "Enter", run: (v) => v.plugin(plugin)?.enter() ?? false },
			]),
		),
		spaceField, // [Stage K] drawing spaces (block widgets; empty unless the note has spaces)
		spaceMoveHistory, // drawings cut/pasted with text undo/redo with it
		EditorView.contentAttributes.of({ class: "pencil-layer-content" }),
	];
}
