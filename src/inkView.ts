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
import { EditorView, PluginValue, ViewPlugin, ViewUpdate } from "@codemirror/view";
import type { Extension, Text } from "@codemirror/state";
import { Notice, Platform, editorInfoField, setIcon, setTooltip } from "obsidian";
import { InkFile, PenStyle, Point, Stroke, Tool, hashLine, isEmptyInk, newId, resolveAnchor } from "./model";
import { BBox, bbox, dashArray, hitTestStrokeSegment, isCenterline, isDashed, strokeToPath } from "./geometry";
import { formatLatexFormula } from "./mathLatex";
import { recognizeMathStrokes, strokesToPngBase64 } from "./mathVision";
import { buildPageGuideLayout, computeCanvasBottomPadding } from "./pageGuides";
import { TapLineInfo, insertionPosForY, planTapToType } from "./tapToType";
import type { AssistantLaunchOptions } from "./aiAssistant";
import {
	PinchActivation,
	ZOOM_MAX,
	ZOOM_MIN,
	ZOOM_STEP,
	clampZoom,
	distanceBetween,
	formatZoomPercent,
	midpoint,
	pinchScale,
	scrollForZoomAnchor,
	wheelZoomFactor,
} from "./zoom";
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
import type { InkListener, InkStore } from "./store";
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
import { TiltSample, isPenEraser, pointerTilt, resampleTilts, tiltWidthMultiplier, toolForPress } from "./penInput";
import type { PencilGestureAction } from "./pencilGestures";
import { blockStylusTouch, onTap } from "./tap";
import { DrawShape, ShapeSpec, XY, adjustShape, draggedShape, recognizeShape, shapeToPoints } from "./shapes";
import {
	CompassDrag,
	GuideEdge,
	PX_PER_CM,
	PX_PER_MM,
	RULER_HALF_LENGTH,
	RULER_HALF_THICKNESS,
	compassShape,
	moveCompass,
	nearestGuideEdge,
	projectToInfiniteEdge,
	rulerGeometry,
	setSquareEdges,
	snapGuideAngle,
	startCompassDrag,
	twoFingerGuideTransform,
} from "./geometryGuide";
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
import { Origin, TextHighlights, elementBoxScale, overlayOrigin, unzoomedLineTop } from "./textHighlightView"; // [Stage C]
import { inkColor } from "./inkColor"; // [Stage L]
import { CharAnchors } from "./charAnchorView"; // [Stage H]
import { CLICK_MOVE, CLICK_TOLERANCE, DeskTarget, InkKeyAction, deskPress, deskRegionRelease, pickTopmost, rectPolygon, strokeNear } from "./select"; // [Stage F/H]
import type { SelectMode } from "./settings"; // [Stage F]

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
	/** Configured Pencil gesture action (double-tap / bridged squeeze). */
	runPencilGestureAction?(action: PencilGestureAction): void;
	registerInkView(v: InkView): void;
	unregisterInkView(v: InkView): void;
	/** Plugin-internal ink clipboard (shared by all notes). */
	clipboard: InkClip | null;
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
	/** A pen touched a note (desktop: from now on this device gets the full drawing toolbar). */
	penSeen(): void;
	/** Optional settings patch callback (used by on-canvas ruler/guide handles). */
	updateSettings?(patch: Partial<InkSettings>): void;
	/** Optional Gemini AI assistant opener (launched from lasso menu or toolbar). */
	openAssistant?(opts: AssistantLaunchOptions): void;
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
function paint(el: SVGPathElement, s: Pick<Stroke, "tool" | "style" | "size" | "color" | "tilts">): void {
	const color = cssColor(s.color, s.tool);
	const centerline = isCenterline(s);
	el.setCssProps({ fill: centerline ? "none" : color, stroke: centerline ? color : "" });
	if (s.tool === "pen" && s.style === "pencil") el.setAttribute("opacity", "0.78");
	else if (s.tool === "pen" && s.style === "marker") el.setAttribute("opacity", "0.88");
	else el.removeAttribute?.("opacity");
	if (centerline) {
		el.setAttribute("stroke-width", String(s.size));
		el.setAttribute("stroke-linecap", "round");
		el.setAttribute("stroke-linejoin", "round");
		const dash = dashArray(s);
		if (dash) el.setAttribute("stroke-dasharray", dash);
		else el.removeAttribute?.("stroke-dasharray");
	} else {
		el.removeAttribute?.("stroke-width");
		el.removeAttribute?.("stroke-linecap");
		el.removeAttribute?.("stroke-linejoin");
		el.removeAttribute?.("stroke-dasharray");
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

type DrawGeometry =
	| { kind: "shape"; shape: Exclude<DrawShape, "freehand">; start: XY; edge: GuideEdge | null; end: XY | null }
	| { kind: "compass"; drag: CompassDrag };

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
	geometry: DrawGeometry | null;
	/** Straight-line highlighter: the start point (points = start → pen). */
	straight: XY | null;
	lastScribbleCheck: number;
	/** Scribble-to-erase state for this stroke: the preview shows, and lift erases, its ids. */
	scribble: ScribbleTracker;
	/** Raw `(x, y, tilt)` samples for Apple Pencil tilt shading. */
	tiltSamples: TiltSample[];
	hasTilt: boolean;
	lastPressure: number;
	lastTilt: number;
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
	private readonly gGuides: SVGGElement;
	private readonly gHl: SVGGElement;
	private pageGuideKey = "";
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
	private readonly gGuideUi: SVGGElement;
	private readonly guideOutline: SVGPathElement;
	private readonly guideTicks: SVGPathElement;
	private readonly guideLabels: SVGGElement;
	private readonly guideGrip: SVGCircleElement;
	private readonly guideRotateGrip: SVGCircleElement;
	private readonly guideResetBtn: SVGGElement;
	private readonly guideCloseBtn: SVGGElement;
	private guideOrigin: XY | null = null;
	private guideDrag:
		| { mode: "move"; id: number; offset: XY }
		| { mode: "rotate"; id: number; startAngle: number; startPointerAngle: number }
		| { mode: "radius"; id: number }
		| null = null;
	private readonly guideTouches = new Map<number, XY>();
	private guidePinchStart: { origin: XY; angle: number; radius: number; a: XY; b: XY; idA: number; idB: number } | null = null;
	/** Dynamic extra blank pages so empty/short notes can always be scrolled down cleanly. */
	private extraPages = 2;
	private lastBottomPad = -1;
	/** Page pinch-to-zoom state (`1` = 100%). */
	private zoom = 1;
	private sizerEl: HTMLElement | null = null;
	private zoomBaseSizerWidth: number | null = null;
	private zoomSpacer: HTMLElement | null = null;
	private zoomBadge: HTMLElement | null = null;
	private measuredLineTops: ReadonlyMap<number, number> | null = null;
	private pinch: { activation: PinchActivation; startZoom: number; prevMid: { x: number; y: number }; lastZoom: number } | null = null;
	/** Floating Formula preview/edit bar (keeps handwritten strokes safe until confirmed). */
	private mathBarEl: HTMLElement | null = null;
	private pendingMath: { path: string; strokeIds: string[]; rawTex: string; midY: number; box: BBox } | null = null;

	/** Lasso selection (strokes on the canvas) and the live drag transform. */
	private selection: Stroke[] | null = null;
	private dragT: SelectionTransform | null = null;
	/** Finger down outside the selection: a quick tap deselects (a scroll does not). */
	private fingerTap: { id: number; x: number; y: number; t: number } | null = null;
	/** Non-ink tap tracking (finger or passive mouse): tap anywhere to place typing caret + keyboard. */
	private navTap: { id: number; x: number; y: number; t: number; moved: boolean } | null = null;
	private lastCompletedTap: { x: number; y: number; at: number } | null = null;
	/** Buffered handwritten formula stroke IDs waiting for pause auto-conversion in Formula mode. */
	private mathBuffer: string[] = [];
	private mathTimer: number | null = null;
	/** [Stage C] Highlighter strokes snapped to typed text (textHighlightView.ts). */
	private readonly textHl: TextHighlights;
	/** [Stage H] Ink anchored to a character of typed text (charAnchorView.ts). */
	private readonly charA: CharAnchors;
	/** [Stage F] Last mouse position over the overlay (paste target) and the pending hover check. */
	private hoverAt: XY | null = null;
	private hoverRaf = 0;
	private hoverCursor = "";
	/** [Stage K] Stub space-controls object; replaced by a real SpaceUi when that class lands. */
	private readonly spaceUi = { isControl: (_target: EventTarget | null): boolean => false };

	constructor(
		readonly view: EditorView,
		private readonly host: InkHost,
	) {
		this.svg = svgEl("svg", "ink-pages-overlay");
		this.svg.setAttribute("aria-hidden", "true");
		this.gGuides = svgEl("g", "pl-guides");
		this.gHl = svgEl("g", "pl-hl");
		this.gHlLive = svgEl("g", "pl-hl pl-live");
		this.gPen = svgEl("g", "pl-pen");
		this.gPenLive = svgEl("g", "pl-pen pl-live");
		this.textHl = new TextHighlights(view); // [Stage C]
		this.charA = new CharAnchors(view); // [Stage H]
		this.gUi = svgEl("g", "pl-ui");
		this.selRect = svgEl("rect", "pl-sel-box");
		this.selHandle = svgEl("circle", "pl-sel-handle");
		this.selHandle.setAttribute("r", "7");
		this.selRect.classList.add("pl-hidden");
		this.selHandle.classList.add("pl-hidden");
		this.eraserCursor = svgEl("circle", "pl-eraser-cursor");
		this.eraserCursor.classList.add("pl-hidden");
		this.gGuideUi = svgEl("g", "pl-guide-tool pl-hidden");
		this.guideOutline = svgEl("path", "pl-set-square");
		this.guideTicks = svgEl("path", "pl-guide-ticks");
		this.guideLabels = svgEl("g", "pl-guide-labels");
		this.guideGrip = svgEl("circle", "pl-set-square-grip");
		this.guideGrip.setAttribute("r", "14");
		this.guideGrip.setAttribute("aria-label", "Move guide");
		this.guideRotateGrip = svgEl("circle", "pl-guide-rotate-grip");
		this.guideRotateGrip.setAttribute("r", "13");
		this.guideRotateGrip.setAttribute("aria-label", "Rotate or resize guide");
		this.guideResetBtn = svgEl("g", "pl-guide-action pl-guide-reset");
		this.guideCloseBtn = svgEl("g", "pl-guide-action pl-guide-close");
		for (const el of [this.guideOutline, this.guideGrip]) {
			el.addEventListener("pointerdown", this.onGuideDown);
			el.addEventListener("pointermove", this.onGuideMove);
			for (const event of ["pointerup", "pointercancel", "lostpointercapture"] as const) {
				el.addEventListener(event, this.onGuideEnd);
			}
		}
		this.guideRotateGrip.addEventListener("pointerdown", this.onGuideRotateDown);
		this.guideRotateGrip.addEventListener("pointermove", this.onGuideMove);
		for (const event of ["pointerup", "pointercancel", "lostpointercapture"] as const) {
			this.guideRotateGrip.addEventListener(event, this.onGuideEnd);
		}
		this.guideResetBtn.addEventListener("pointerdown", this.onGuideResetDown);
		this.guideCloseBtn.addEventListener("pointerdown", this.onGuideCloseDown);
		this.gGuideUi.append(
			this.guideOutline,
			this.guideTicks,
			this.guideLabels,
			this.guideGrip,
			this.guideRotateGrip,
			this.guideResetBtn,
			this.guideCloseBtn,
		);
		this.gUi.append(this.selRect, this.selHandle, this.eraserCursor);
		// Keep ruler/guide BELOW pen ink (`gPen` / `gPenLive`) so lines drawn along the edge stay 100% visible!
		this.svg.append(this.gGuides, this.gHl, this.gHlLive, this.gGuideUi, this.gPen, this.gPenLive, this.gUi);
		// Mount the overlay inside `.cm-sizer` when available so text, ink, A4 guides, and rulers share ONE
		// rigid CSS zoom transform and can never scale differently or drift during pinch-to-zoom.
		this.sizerEl = this.zoomTargetEl();
		if (this.sizerEl) {
			this.sizerEl.classList.add("pl-zoom-host");
			this.sizerEl.appendChild(this.svg);
		} else {
			view.scrollDOM.appendChild(this.svg);
		}

		const sd = view.scrollDOM;
		const cap = { capture: true };
		const capActive = { capture: true, passive: false };
		sd.addEventListener("pointerdown", this.onPointerDown, cap);
		sd.addEventListener("pointermove", this.onPointerMove, cap);
		sd.addEventListener("pointerup", this.onPointerEnd, cap);
		sd.addEventListener("pointercancel", this.onPointerEnd, cap);
		sd.addEventListener("lostpointercapture", this.onPointerEnd, cap);
		sd.addEventListener("pointerleave", this.onPointerLeave);
		sd.addEventListener("touchstart", this.onTouch, capActive);
		sd.addEventListener("touchmove", this.onTouch, capActive);
		sd.addEventListener("touchend", this.onTouch, capActive);
		sd.addEventListener("touchcancel", this.onTouch, capActive);
		sd.addEventListener("wheel", this.onWheel, capActive);
		sd.addEventListener("click", this.onEditorClick);
		for (const t of SUPPRESSED) sd.addEventListener(t, this.onCompatMouse, capActive);

		host.registerInkView(this);
		this.attach(this.currentFilePath());
		this.refresh();
	}

	// -------------------------------------------------------------------------------------------
	// Lifecycle / file tracking
	// -------------------------------------------------------------------------------------------

	update(u: ViewUpdate): void {
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
		if (u.docChanged || u.geometryChanged || u.heightChanged || u.selectionSet) this.charA.invalidate();
		if (u.docChanged || u.geometryChanged || u.viewportChanged || u.heightChanged) this.scheduleRender();
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
		sd.removeEventListener("wheel", this.onWheel, true);
		sd.removeEventListener("click", this.onEditorClick);
		for (const t of SUPPRESSED) sd.removeEventListener(t, this.onCompatMouse, true);
		this.clearMathBuffer();
		this.clearMathBar();
		this.resetZoomDom();
		if (this.raf) window.cancelAnimationFrame(this.raf);
		if (this.switchTimer !== null) window.clearTimeout(this.switchTimer);
		this.cancelActive();
		this.detach();
		this.svg.remove();
		this.menuEl?.remove();
		this.menuEl = null;
		this.zoomSpacer?.remove();
		this.zoomSpacer = null;
		this.zoomBadge?.remove();
		this.zoomBadge = null;
		this.view.scrollDOM.classList.remove("pl-mouse-draws", "pl-desk-select");
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
		if (!s.mathMode || s.tool !== "pen") this.clearMathBuffer();
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
		this.extraPages = 2;
		this.lastBottomPad = -1;
		this.pageGuideKey = "";
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
				this.scheduleRender();
			},
			(err) => console.error("[ink-pages] load failed", err),
		);
		this.scheduleRender();
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
		if (strokes.length === 0) return;
		if (replacesWholeDoc(u)) {
			// Mapping through a full replacement would collapse every anchor to the top. Snapshot the
			// anchors against the old doc, then re-resolve by line hash against the new one.
			this.refreshAnchorsFor(strokes, u.startState.doc);
			this.store.clearPositions(path);
			this.resolvePositions();
		} else {
			// Resolve any not-yet-resolved strokes against the pre-change doc so they get mapped too.
			this.resolvePositionsIn(strokes, u.startState.doc);
			// [Stage C] assoc: -1 for line starts, +1/-1 for a text highlight's from/to (see store.ts).
			this.store.mapPositions(path, (p, assoc) => u.changes.mapPos(p, assoc), this.listener);
		}
		if (!isEmptyInk(ink)) this.store.touch(path);
	}

	private resolvePositions(): void {
		if (!this.path) return;
		this.resolvePositionsIn(this.store.allStrokes(this.path), this.view.state.doc);
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
		if (!s.char) return [0, top];
		const [x, y] = this.charA.shift(s);
		return [x, top + y];
	}

	/** [Stage H] A stroke with its points in overlay x (for code that only applies a y offset). */
	private shiftedX(s: Stroke, x: number): Stroke {
		return x === 0 ? s : { ...s, points: s.points.map((p): Point => [p[0] + x, p[1], p[2]]) };
	}

	/** [Stage H] Character anchor for a unit of new strokes (group commit, paste, duplicate). */
	private anchorGroup(strokes: readonly Stroke[]): void {
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

	/** Overlay-space top of a stroke's anchor line (unzoomed CSS px). */
	private lineTop(s: Stroke): number {
		const doc = this.view.state.doc;
		if (s.pos === undefined) {
			s.pos = doc.line(resolveAnchor(lineSource(doc), s.anchor) + 1).from;
		}
		const lineFrom = doc.lineAt(clampPos(doc, s.pos)).from;
		const cached = this.measuredLineTops?.get(lineFrom);
		if (cached !== undefined) return cached;
		return unzoomedLineTop(this.view, lineFrom);
	}

	/**
	 * Anchor for overlay-space points: the document line under the topmost point (last line if
	 * below the document). Returns the anchor, the line start position and the line's top.
	 */
	private anchorFor(points: readonly (readonly number[])[]): { anchor: Stroke["anchor"]; pos: number; top: number } {
		const view = this.view;
		const doc = view.state.doc;
		let minY = Infinity;
		for (const p of points) if (p[1] < minY) minY = p[1];
		const sy = view.scaleY || 1;
		const lastBlock = view.lineBlockAt(doc.length);
		const scaledMinY = Math.max(minY, 0) * sy;
		const line =
			scaledMinY >= lastBlock.bottom ? doc.line(doc.lines) : doc.lineAt(view.lineBlockAtHeight(scaledMinY).from);
		return {
			anchor: { line: line.number - 1, hash: hashLine(line.text) },
			pos: line.from,
			top: unzoomedLineTop(view, line.from),
		};
	}

	private scheduleRender(): void {
		if (this.destroyed) return;
		this.view.requestMeasure({
			key: this,
			read: (view) => {
				// [Stage C] text highlight rects are measured here (layout reads), drawn in render().
				const ink = this.path && this.host.getSettings().inkVisible ? this.store.get(this.path) : undefined;
				this.textHl.measure(ink?.strokes);
				this.charA.measure(ink?.strokes); // [Stage H] characters of char-anchored ink (stale ones only)
				const lineTops = new Map<number, number>();
				if (ink && ink.strokes.length > 0) {
					const doc = view.state.doc;
					let src: ReturnType<typeof lineSource> | null = null;
					let origin: Origin | null = null;
					for (const s of ink.strokes) {
						if (s.text) continue;
						if (s.pos === undefined) {
							src ??= lineSource(doc);
							s.pos = doc.line(resolveAnchor(src, s.anchor) + 1).from;
						}
						const lineFrom = doc.lineAt(clampPos(doc, s.pos)).from;
						if (lineTops.has(lineFrom)) continue;
						origin ??= overlayOrigin(view);
						lineTops.set(lineFrom, unzoomedLineTop(view, lineFrom, origin));
					}
				}
				const geo = this.readGeometry(view);
				const { ruler, setSquare, compass } = this.host.getSettings();
				if (!ruler && !setSquare && !compass) this.guideOrigin = null;
				else if (!this.guideOrigin) {
					const scroller = view.scrollDOM;
					const sy = this.effectiveScaleY();
					const visTop = Math.max(0, scroller.scrollTop / sy - geo.top);
					const visH = (scroller.clientHeight || 600) / sy;
					this.guideOrigin = [Math.max(120, geo.width / 2), visTop + Math.min(180, visH / 3)];
				}
				return { geo, lineTops };
			},
			write: ({ geo, lineTops }: { geo: Geometry; lineTops: Map<number, number> }) => {
				this.measuredLineTops = lineTops;
				try {
					this.syncCanvasRoom();
					this.render(geo);
					this.renderGuide();
					this.updateZoomSpacer();
				} finally {
					this.measuredLineTops = null;
				}
			},
		});
	}

	/** Add one more blank page height at the bottom of the editor canvas so you can keep scrolling. */
	addBlankPage(): void {
		this.extraPages = Math.min(40, this.extraPages + 1);
		this.syncCanvasRoom();
		this.scheduleRender();
	}

	/** Ensure `.cm-content` always has generous bottom padding so blank/short notes scroll cleanly. */
	private syncCanvasRoom(): void {
		const cd = this.view.contentDOM;
		if (!cd || !cd.style) return;
		const sd = this.view.scrollDOM;
		const s = this.host.getSettings();
		let lowestInkY = 0;
		const ink = this.path ? this.store.get(this.path) : undefined;
		if (ink && ink.strokes.length > 0) {
			for (const st of ink.strokes) {
				if (st.text) continue;
				const top = this.place(st)[1];
				const b = shapeOf(st).box;
				if (top + b.maxY > lowestInkY) lowestInkY = top + b.maxY;
			}
		}
		const docH = (this.view.contentHeight ?? 0) / (this.view.scaleY || 1);
		const pad = computeCanvasBottomPadding({
			format: s.pageGuide,
			docHeight: docH,
			viewportHeight: sd.clientHeight || 900,
			lowestInkY,
			extraPages: this.extraPages,
		});
		if (Math.abs(pad - this.lastBottomPad) >= 8) {
			this.lastBottomPad = pad;
			cd.style.paddingBottom = `${pad}px`;
		}
	}

	private effectiveScaleX(): number {
		const cd = this.view.contentDOM;
		const fallback = this.zoom !== 1 ? this.zoom : this.view.scaleX || 1;
		return elementBoxScale(cd, cd.getBoundingClientRect(), fallback, fallback).sx;
	}

	private effectiveScaleY(): number {
		const cd = this.view.contentDOM;
		const fallback = this.zoom !== 1 ? this.zoom : this.view.scaleY || 1;
		return elementBoxScale(cd, cd.getBoundingClientRect(), fallback, fallback).sy;
	}

	private readGeometry(view: EditorView): Geometry {
		const sd = view.scrollDOM;
		const cd = view.contentDOM;
		const cRect = cd.getBoundingClientRect();
		const cs = getComputedStyle(cd);
		const fallbackX = this.zoom !== 1 ? this.zoom : view.scaleX || 1;
		const fallbackY = this.zoom !== 1 ? this.zoom : view.scaleY || 1;
		const { sx, sy } = elementBoxScale(cd, cRect, fallbackX, fallbackY, cs);
		const padL = (parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.borderLeftWidth) || 0);
		const padT = parseInt(cs.paddingTop) || 0;
		const borderT = parseFloat(cs.borderTopWidth) || 0;
		const hasLiveHeight = (cd.offsetHeight > 0 || parseFloat(cs.height) > 0) && cRect.height > 0;
		const docTop = hasLiveHeight || this.zoom !== 1 ? cRect.top + (borderT + padT) * sy : view.documentTop;
		if (this.sizerEl && this.svg.parentElement === this.sizerEl) {
			const hRect = this.sizerEl.getBoundingClientRect();
			const hCs = getComputedStyle(this.sizerEl);
			const hBorderL = parseFloat(hCs.borderLeftWidth) || 0;
			const hBorderT = parseFloat(hCs.borderTopWidth) || 0;
			return {
				left: (cRect.left - hRect.left) / sx - hBorderL + padL,
				top: (docTop - hRect.top) / sy - hBorderT,
				width: Math.max(0, cd.clientWidth - (parseFloat(cs.paddingLeft) || 0) - (parseFloat(cs.paddingRight) || 0)),
				height: Math.max(0, (cRect.bottom - docTop) / sy),
			};
		}
		const sRect = sd.getBoundingClientRect();
		const sdScaleX = sd.offsetWidth > 0 && sRect.width > 0 ? sRect.width / sd.offsetWidth : 1;
		const sdScaleY = sd.offsetHeight > 0 && sRect.height > 0 ? sRect.height / sd.offsetHeight : 1;
		const baseLeft = sRect.left - sd.scrollLeft * sdScaleX;
		const baseTop = sRect.top - sd.scrollTop * sdScaleY;
		return {
			left: (cRect.left - baseLeft) / sdScaleX + padL * (sx / sdScaleX),
			top: (docTop - baseTop) / sdScaleY,
			width: Math.max(0, cd.clientWidth - (parseFloat(cs.paddingLeft) || 0) - (parseFloat(cs.paddingRight) || 0)),
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
		this.renderPageGuides(geo);
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
		const sy = view.scaleY || 1;
		const vpTop = vp.from <= 0 ? -Infinity : view.lineBlockAt(vp.from).top / sy - CULL_MARGIN;
		const vpBottom = vp.to >= doc.length ? Infinity : view.lineBlockAt(vp.to).bottom / sy + CULL_MARGIN;

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

	/** Events on the context menu, math bar, zoom badge, or ruler/guide controls are left to their own handlers. */
	private isUiTarget(target: EventTarget | null, pointerType?: string): boolean {
		if (
			target === this.guideGrip ||
			target === this.guideRotateGrip ||
			target === this.guideResetBtn ||
			target === this.guideCloseBtn
		) {
			return true;
		}
		// Let Apple Pencil (`pen`) draw cleanly right along/over the ruler edge instead of accidentally
		// dragging the ruler body; fingers and mouse still drag/rotate the ruler body directly.
		if (target === this.guideOutline) {
			return pointerType !== "pen";
		}
		if (typeof Node !== "undefined" && target instanceof Node) {
			if (this.guideResetBtn.contains?.(target) || this.guideCloseBtn.contains?.(target)) return true;
			if (this.gGuideUi.contains?.(target)) return pointerType !== "pen";
			if (this.menuEl && this.menuEl.contains(target)) return true;
			if (this.mathBarEl && this.mathBarEl.contains(target)) return true;
			if (this.zoomBadge && this.zoomBadge.contains(target)) return true;
		}
		return false;
	}

	// -------------------------------------------------------------------------------------------
	// Pinch-to-zoom & page zoom controls
	// -------------------------------------------------------------------------------------------

	getZoom(): number {
		return this.zoom;
	}

	zoomBy(factor: number): void {
		const sd = this.view.scrollDOM;
		const r = sd.getBoundingClientRect();
		const focal = { x: r.left + (sd.clientWidth || 400) / 2, y: r.top + (sd.clientHeight || 400) / 2 };
		this.setZoom(this.zoom * factor, focal);
	}

	zoomIn(): void {
		this.zoomBy(1 + ZOOM_STEP);
	}

	zoomOut(): void {
		this.zoomBy(1 / (1 + ZOOM_STEP));
	}

	resetZoom(): void {
		this.setZoom(1);
	}

	setZoom(nextZoom: number, focalClient?: { x: number; y: number }, prevFocalClient?: { x: number; y: number }): void {
		const target = clampZoom(nextZoom, ZOOM_MIN, ZOOM_MAX);
		const prev = this.zoom;
		const sd = this.view.scrollDOM;
		const sRect = sd.getBoundingClientRect();
		const oldScrollLeft = sd.scrollLeft;
		const oldScrollTop = sd.scrollTop;
		const sizer = this.sizerEl ?? this.zoomTargetEl();
		const anchorEl = sizer ?? this.view.contentDOM;
		const beforeRect = anchorEl.getBoundingClientRect();
		if (prev === 1 && target !== 1 && anchorEl && anchorEl.offsetWidth > 0) {
			this.zoomBaseSizerWidth = anchorEl.offsetWidth;
		} else if (target === 1) {
			this.zoomBaseSizerWidth = null;
		}
		this.zoom = target;
		this.applyZoomDom();
		if (focalClient && prev > 0) {
			const ratio = target / prev;
			const afterRect = anchorEl.getBoundingClientRect();
			if ((beforeRect.width ?? 0) > 0 && (afterRect.width ?? 0) > 0) {
				const pf = prevFocalClient ?? focalClient;
				const curX = afterRect.left + (pf.x - beforeRect.left) * ratio;
				const curY = afterRect.top + (pf.y - beforeRect.top) * ratio;
				const sdScaleX = sd.offsetWidth > 0 && sRect.width > 0 ? sRect.width / sd.offsetWidth : 1;
				const sdScaleY = sd.offsetHeight > 0 && sRect.height > 0 ? sRect.height / sd.offsetHeight : 1;
				sd.scrollLeft = Math.max(0, sd.scrollLeft + (curX - focalClient.x) / sdScaleX);
				sd.scrollTop = Math.max(0, sd.scrollTop + (curY - focalClient.y) / sdScaleY);
			} else {
				const fx0 = (prevFocalClient?.x ?? focalClient.x) - sRect.left;
				const fy0 = (prevFocalClient?.y ?? focalClient.y) - sRect.top;
				const fx1 = focalClient.x - sRect.left;
				const fy1 = focalClient.y - sRect.top;
				sd.scrollLeft = scrollForZoomAnchor(oldScrollLeft, fx0, ratio, fx1);
				sd.scrollTop = scrollForZoomAnchor(oldScrollTop, fy0, ratio, fy1);
			}
		}
		this.applyGeometry(this.readGeometry(this.view));
		this.renderSelection();
		this.updateZoomBadge();
		if (Math.abs(target - prev) > 1e-4) this.scheduleRender();
	}

	private zoomTargetEl(): HTMLElement | null {
		const sd = this.view.scrollDOM;
		for (let el = this.view.contentDOM?.parentElement ?? null; el && el !== sd; el = el.parentElement) {
			if (el.classList?.contains("cm-sizer")) return el;
		}
		const children = sd.children ? Array.from(sd.children) : [];
		for (const c of children) {
			if (c.classList?.contains("cm-sizer")) return c as HTMLElement;
		}
		return null;
	}

	private applyZoomDom(): void {
		const z = this.zoom;
		const sizer = this.sizerEl ?? this.zoomTargetEl();
		const widthLock = z === 1 || !this.zoomBaseSizerWidth ? "" : `${this.zoomBaseSizerWidth}px`;
		if (sizer) {
			sizer.classList.add("pl-zoom-host");
			if (this.svg.parentElement !== sizer) {
				this.sizerEl = sizer;
				sizer.appendChild(this.svg);
			}
			sizer.classList.toggle("pl-zoom-target", z !== 1);
			sizer.setCssProps({
				transform: z === 1 ? "" : `scale(${z})`,
				width: widthLock,
				minWidth: widthLock,
				maxWidth: widthLock,
			});
			this.svg.setCssProps({ transform: "" });
		} else {
			const cd = this.view.contentDOM;
			cd.classList?.toggle("pl-zoom-target", z !== 1);
			cd.setCssProps?.({
				transform: z === 1 ? "" : `scale(${z})`,
				width: widthLock,
				minWidth: widthLock,
				maxWidth: widthLock,
			});
			this.svg.setCssProps({ transform: z === 1 ? "" : `scale(${z})` });
		}
		this.updateZoomSpacer();
	}

	private resetZoomDom(): void {
		this.zoom = 1;
		this.zoomBaseSizerWidth = null;
		const sizer = this.sizerEl ?? this.zoomTargetEl();
		if (sizer) {
			sizer.classList.remove("pl-zoom-target");
			sizer.setCssProps({ transform: "", width: "", minWidth: "", maxWidth: "" });
		} else {
			const cd = this.view.contentDOM;
			cd.classList?.remove("pl-zoom-target");
			cd.setCssProps?.({ transform: "", width: "", minWidth: "", maxWidth: "" });
		}
		this.svg.setCssProps({ transform: "" });
	}

	private updateZoomSpacer(): void {
		const sd = this.view.scrollDOM;
		if (this.zoom === 1) {
			this.zoomSpacer?.remove();
			this.zoomSpacer = null;
			return;
		}
		const target = this.sizerEl ?? this.zoomTargetEl() ?? (this.view.contentDOM.offsetWidth > 0 ? this.view.contentDOM : null);
		if (!target || typeof sd.createDiv !== "function") return;
		if (!this.zoomSpacer || !this.zoomSpacer.isConnected) {
			this.zoomSpacer = sd.createDiv({ cls: "pl-zoom-spacer", attr: { "aria-hidden": "true" } });
		}
		const w = Math.ceil((target.offsetLeft || 0) + Math.max(target.offsetWidth, (this.geo?.width ?? 0) + 80) * this.zoom);
		const h = Math.ceil((target.offsetTop || 0) + Math.max(target.offsetHeight, (this.geo?.height ?? 0) + 120) * this.zoom);
		this.zoomSpacer.style.width = `${w}px`;
		this.zoomSpacer.style.height = `${h}px`;
	}

	private updateZoomBadge(): void {
		if (Math.abs(this.zoom - 1) < 0.005) {
			this.zoomBadge?.remove();
			this.zoomBadge = null;
			return;
		}
		const leaf = this.view.scrollDOM.closest?.<HTMLElement>(".workspace-leaf-content") ?? null;
		if (!leaf || typeof leaf.createDiv !== "function") return;
		if (!this.zoomBadge || !this.zoomBadge.isConnected) {
			const b = leaf.createDiv({ cls: "pl-zoom-badge", attr: { role: "button", "aria-label": "Reset zoom to 100%" } });
			b.addEventListener("pointerdown", (e) => {
				e.preventDefault();
				e.stopPropagation();
			});
			blockStylusTouch(b);
			onTap(b, () => this.resetZoom());
			this.zoomBadge = b;
		}
		this.zoomBadge.setText(`${formatZoomPercent(this.zoom)} · ↺`);
	}

	private readonly onWheel = (e: WheelEvent): void => {
		if (!e.ctrlKey && !e.metaKey) return;
		if (this.isUiTarget(e.target)) return;
		e.preventDefault();
		e.stopPropagation();
		this.setZoom(this.zoom * wheelZoomFactor(e.deltaY), { x: e.clientX, y: e.clientY });
	};

	// -------------------------------------------------------------------------------------------
	// Drawing guides (Straight ruler, Set square, Compass) + Page boundaries
	// -------------------------------------------------------------------------------------------

	private guideHalfSize(): number {
		return Math.max(90, Math.min(180, (this.geo?.width ?? 480) * 0.36));
	}

	private guideEdges(): GuideEdge[] {
		const settings = this.host.getSettings();
		if (!this.guideOrigin) return [];
		if (settings.ruler) return rulerGeometry(this.guideOrigin, settings.rulerAngle, RULER_HALF_LENGTH, RULER_HALF_THICKNESS).edges;
		if (settings.setSquare) return setSquareEdges(this.guideOrigin, settings.setSquareAngle, this.guideHalfSize());
		return [];
	}

	private renderPageGuides(geo: Geometry): void {
		const fmt = this.host.getSettings().pageGuide;
		const sd = this.view.scrollDOM;
		const visW = Math.round(sd.clientWidth || geo.width);
		const leftMargin = Math.max(0, Math.round(geo.left));
		const key = `${fmt}:${Math.round(geo.width)}x${Math.round(geo.height)}:${visW}:${leftMargin}`;
		if (key === this.pageGuideKey) return;
		this.pageGuideKey = key;
		this.gGuides.replaceChildren();
		const layout = buildPageGuideLayout(fmt, geo.width, geo.height, Math.max(200, visW - leftMargin));
		if (!layout) return;
		const totalH = layout.totalHeight;
		const sheetW = layout.sheetWidth;
		const paperLeft = layout.paperLeftX;
		const paperRight = layout.paperRightX;

		// Subtle shading OUTSIDE the physical paper (beyond the 1 cm print margins).
		const leftOuterW = leftMargin + paperLeft;
		if (leftOuterW > 4) {
			const leftShade = svgEl("rect", "pl-guide-overflow");
			leftShade.setAttribute("x", String(-leftMargin));
			leftShade.setAttribute("y", "0");
			leftShade.setAttribute("width", String(leftOuterW));
			leftShade.setAttribute("height", String(totalH));
			this.gGuides.appendChild(leftShade);
		}
		const rightShadeW = Math.max(geo.width - paperRight, visW - leftMargin - paperRight);
		if (rightShadeW > 2) {
			const shade = svgEl("rect", "pl-guide-overflow");
			shade.setAttribute("x", String(paperRight));
			shade.setAttribute("y", "0");
			shade.setAttribute("width", String(rightShadeW));
			shade.setAttribute("height", String(totalH));
			this.gGuides.appendChild(shade);
		}

		// Full physical paper frame (e.g. 21.0 cm wide for A4) + subtle inner 1 cm print margin ("Druckrand").
		const addLine = (cls: string, x1: number, y1: number, x2: number, y2: number) => {
			const l = svgEl("line", cls);
			l.setAttribute("x1", String(x1));
			l.setAttribute("y1", String(y1));
			l.setAttribute("x2", String(x2));
			l.setAttribute("y2", String(y2));
			this.gGuides.appendChild(l);
		};
		// Outer paper borders (exact DIN A4 = 21 cm, A3 = 29.7 cm, etc.)
		addLine("pl-guide-line pl-guide-paper", paperLeft, 0, paperLeft, totalH);
		addLine("pl-guide-line pl-guide-paper", paperRight, 0, paperRight, totalH);
		addLine("pl-guide-line pl-guide-paper", paperLeft, 0, paperRight, 0);
		// Subtle inner print margin lines (Druckrand: 1 cm inside left & right edges)
		addLine("pl-guide-line pl-guide-print-margin", 0, 0, 0, totalH);
		addLine("pl-guide-line pl-guide-print-margin", sheetW, 0, sheetW, totalH);

		// Page 1 header badge showing true paper width + print margin.
		const paperWCm = Math.round((layout.paperWidth / PX_PER_CM) * 10) / 10;
		const marginCm = Math.round((layout.marginPx / PX_PER_CM) * 10) / 10;
		const topLabel = svgEl("text", "pl-guide-label");
		topLabel.setAttribute("x", "8");
		topLabel.setAttribute("y", "14");
		topLabel.textContent = `${layout.metrics.label} (${paperWCm} cm · margin ${marginCm} cm) · Page 1`;
		this.gGuides.appendChild(topLabel);

		layout.horizontalBreaks.forEach((y, idx) => {
			addLine("pl-guide-line pl-guide-break", paperLeft, y, paperRight, y);

			const label = svgEl("text", "pl-guide-label");
			label.setAttribute("x", String(layout.labelRightX));
			label.setAttribute("y", String(Math.max(14, y - 6)));
			label.setAttribute("text-anchor", "end");
			label.textContent = `${layout.metrics.label} · End of page ${idx + 1}`;
			this.gGuides.appendChild(label);

			const nextLabel = svgEl("text", "pl-guide-label");
			nextLabel.setAttribute("x", "8");
			nextLabel.setAttribute("y", String(y + 15));
			nextLabel.textContent = `${layout.metrics.label} · Page ${idx + 2}`;
			this.gGuides.appendChild(nextLabel);
		});
	}

	private renderGuide(): void {
		const origin = this.guideOrigin;
		const settings = this.host.getSettings();
		const activeKind = settings.compass ? "compass" : settings.ruler ? "ruler" : settings.setSquare ? "setSquare" : "none";
		const shown = !!this.path && !!origin && activeKind !== "none";
		this.gGuideUi.classList.toggle("pl-hidden", !shown);
		if (!shown || !origin) return;

		this.guideLabels.replaceChildren();
		this.guideResetBtn.replaceChildren();
		this.guideCloseBtn.replaceChildren();

		const addActionBtn = (parent: SVGGElement, cx: number, cy: number, text: string, label: string) => {
			parent.setAttribute("aria-label", label);
			const bg = svgEl("circle", "pl-guide-action-bg");
			bg.setAttribute("cx", String(cx));
			bg.setAttribute("cy", String(cy));
			bg.setAttribute("r", "13");
			const t = svgEl("text", "pl-guide-action-text");
			t.setAttribute("x", String(cx));
			t.setAttribute("y", String(cy + 4));
			t.setAttribute("text-anchor", "middle");
			t.textContent = text;
			parent.append(bg, t);
		};

		if (activeKind === "compass") {
			const [x, y] = origin;
			const r = settings.compassRadius;
			this.guideOutline.setAttribute("d", `M ${x - r} ${y} a ${r} ${r} 0 0 1 ${2 * r} 0 a ${r} ${r} 0 0 1 ${-2 * r} 0 Z M ${x} ${y} h ${r}`);
			let ticks = "";
			for (let i = 0; i < 24; i++) {
				const a = (i * Math.PI) / 12;
				const len = i % 6 === 0 ? 10 : 5;
				ticks += ` M ${(x + Math.cos(a) * (r - len)).toFixed(1)} ${(y + Math.sin(a) * (r - len)).toFixed(1)} L ${(x + Math.cos(a) * r).toFixed(1)} ${(y + Math.sin(a) * r).toFixed(1)}`;
			}
			this.guideTicks.setAttribute("d", ticks);
			this.guideGrip.setAttribute("cx", String(x));
			this.guideGrip.setAttribute("cy", String(y));
			this.guideRotateGrip.setAttribute("cx", String(x + r));
			this.guideRotateGrip.setAttribute("cy", String(y));
			const cm = (r / PX_PER_CM).toFixed(1);
			const badge = svgEl("text", "pl-guide-readout");
			badge.setAttribute("x", String(x));
			badge.setAttribute("y", String(y - 18));
			badge.setAttribute("text-anchor", "middle");
			badge.textContent = `r = ${cm} cm`;
			this.guideLabels.appendChild(badge);
			addActionBtn(this.guideResetBtn, x - 26, y - r - 18, "R", "Reset radius");
			addActionBtn(this.guideCloseBtn, x + 26, y - r - 18, "×", "Close compass");
			return;
		}

		if (activeKind === "ruler") {
			const geom = rulerGeometry(origin, settings.rulerAngle, RULER_HALF_LENGTH, RULER_HALF_THICKNESS);
			const [tl, tr, br, bl] = geom.corners;
			const rad = (settings.rulerAngle * Math.PI) / 180;
			const cos = Math.cos(rad);
			const sin = Math.sin(rad);
			const pt = (lx: number, ly: number): XY => [origin[0] + lx * cos - ly * sin, origin[1] + lx * sin + ly * cos];

			this.guideOutline.setAttribute(
				"d",
				`M ${tl[0].toFixed(1)} ${tl[1].toFixed(1)} L ${tr[0].toFixed(1)} ${tr[1].toFixed(1)} L ${br[0].toFixed(1)} ${br[1].toFixed(1)} L ${bl[0].toFixed(1)} ${bl[1].toFixed(1)} Z`,
			);

			const totalPx = RULER_HALF_LENGTH * 2 - 28;
			const totalMm = Math.floor(totalPx / PX_PER_MM);
			let ticks = "";
			for (let mm = 0; mm <= totalMm; mm++) {
				const lx = -RULER_HALF_LENGTH + 14 + mm * PX_PER_MM;
				const len = mm % 10 === 0 ? 13 : mm % 5 === 0 ? 9 : 5;
				const p0 = pt(lx, -RULER_HALF_THICKNESS);
				const p1 = pt(lx, -RULER_HALF_THICKNESS + len);
				const q0 = pt(lx, RULER_HALF_THICKNESS);
				const q1 = pt(lx, RULER_HALF_THICKNESS - (mm % 10 === 0 ? 8 : 4));
				ticks += ` M ${p0[0].toFixed(1)} ${p0[1].toFixed(1)} L ${p1[0].toFixed(1)} ${p1[1].toFixed(1)}`;
				if (mm % 5 === 0) ticks += ` M ${q0[0].toFixed(1)} ${q0[1].toFixed(1)} L ${q1[0].toFixed(1)} ${q1[1].toFixed(1)}`;
				if (mm % 10 === 0) {
					const lp = pt(lx, -RULER_HALF_THICKNESS + 23);
					const num = svgEl("text", "pl-guide-cm");
					num.setAttribute("x", lp[0].toFixed(1));
					num.setAttribute("y", lp[1].toFixed(1));
					num.setAttribute("text-anchor", "middle");
					num.setAttribute("transform", `rotate(${settings.rulerAngle} ${lp[0].toFixed(1)} ${lp[1].toFixed(1)})`);
					num.textContent = String(mm / 10);
					this.guideLabels.appendChild(num);
				}
			}
			this.guideTicks.setAttribute("d", ticks);

			const anglePos = pt(0, 6);
			const angleText = svgEl("text", "pl-guide-readout");
			angleText.setAttribute("x", anglePos[0].toFixed(1));
			angleText.setAttribute("y", anglePos[1].toFixed(1));
			angleText.setAttribute("text-anchor", "middle");
			angleText.setAttribute("transform", `rotate(${settings.rulerAngle} ${anglePos[0].toFixed(1)} ${anglePos[1].toFixed(1)})`);
			angleText.textContent = `${Math.round(settings.rulerAngle)}°`;
			this.guideLabels.appendChild(angleText);

			const movePos = pt(-RULER_HALF_LENGTH + 26, 0);
			this.guideGrip.setAttribute("cx", movePos[0].toFixed(1));
			this.guideGrip.setAttribute("cy", movePos[1].toFixed(1));
			this.guideRotateGrip.setAttribute("cx", geom.rotateHandle[0].toFixed(1));
			this.guideRotateGrip.setAttribute("cy", geom.rotateHandle[1].toFixed(1));

			const resetPos = pt(-52, RULER_HALF_THICKNESS + 18);
			const closePos = pt(52, RULER_HALF_THICKNESS + 18);
			addActionBtn(this.guideResetBtn, resetPos[0], resetPos[1], "0°", "Reset angle to 0°");
			addActionBtn(this.guideCloseBtn, closePos[0], closePos[1], "×", "Close ruler");
			return;
		}

		// Set square (Geodreieck)
		const half = this.guideHalfSize();
		const edges = setSquareEdges(origin, settings.setSquareAngle, half);
		const [a, b, c] = edges.map(([from]) => from);
		const length = Math.hypot(b[0] - a[0], b[1] - a[1]);
		const dx = (b[0] - a[0]) / length;
		const dy = (b[1] - a[1]) / length;
		this.guideOutline.setAttribute("d", `M ${a.join(" ")} L ${b.join(" ")} L ${c.join(" ")} Z`);

		let ticks = "";
		const totalMm = Math.floor(length / PX_PER_MM);
		for (let mm = 1; mm < totalMm; mm++) {
			const distance = mm * PX_PER_MM;
			const x = a[0] + dx * distance;
			const y = a[1] + dy * distance;
			const size = mm % 10 === 0 ? 12 : mm % 5 === 0 ? 8 : 4;
			ticks += ` M ${x.toFixed(1)} ${y.toFixed(1)} l ${(-dy * size).toFixed(1)} ${(dx * size).toFixed(1)}`;
			if (mm % 10 === 0 && mm < totalMm - 3) {
				const lx = x - dy * 21;
				const ly = y + dx * 21;
				const num = svgEl("text", "pl-guide-cm");
				num.setAttribute("x", lx.toFixed(1));
				num.setAttribute("y", ly.toFixed(1));
				num.setAttribute("text-anchor", "middle");
				num.setAttribute("transform", `rotate(${settings.setSquareAngle} ${lx.toFixed(1)} ${ly.toFixed(1)})`);
				num.textContent = String(mm / 10);
				this.guideLabels.appendChild(num);
			}
		}
		this.guideTicks.setAttribute("d", ticks);
		const cx = (a[0] + b[0] + c[0]) / 3;
		const cy = (a[1] + b[1] + c[1]) / 3;
		this.guideGrip.setAttribute("cx", String(cx));
		this.guideGrip.setAttribute("cy", String(cy));
		this.guideRotateGrip.setAttribute("cx", String(b[0] - dx * 22 - dy * 12));
		this.guideRotateGrip.setAttribute("cy", String(b[1] - dy * 22 + dx * 12));

		const badge = svgEl("text", "pl-guide-readout");
		badge.setAttribute("x", String(cx));
		badge.setAttribute("y", String(cy - 20));
		badge.setAttribute("text-anchor", "middle");
		badge.textContent = `${Math.round(settings.setSquareAngle)}°`;
		this.guideLabels.appendChild(badge);
		addActionBtn(this.guideResetBtn, c[0] - 24, c[1] + 18, "0°", "Reset set square to 0°");
		addActionBtn(this.guideCloseBtn, c[0] + 24, c[1] + 18, "×", "Close set square");
	}

	private readonly onGuideDown = (event: PointerEvent): void => {
		if (!this.guideOrigin || this.active || (event.pointerType === "mouse" && event.button !== 0)) return;
		// When drawing with Apple Pencil along the ruler body, let the ink stroke capture the edge
		// instead of accidentally dragging the ruler (pen can still grab the explicit center grip).
		if (event.pointerType === "pen" && event.currentTarget === this.guideOutline) return;
		event.preventDefault();
		event.stopPropagation();
		const [x, y] = this.toOverlay(event, this.svg.getBoundingClientRect());
		const target = event.currentTarget as Element;
		try {
			target.setPointerCapture(event.pointerId);
		} catch {
			/* ignore */
		}
		this.guideTouches.set(event.pointerId, [x, y]);
		if (this.guideTouches.size === 2) {
			const entries = [...this.guideTouches.entries()];
			const s = this.host.getSettings();
			const angle = s.ruler ? s.rulerAngle : s.setSquareAngle;
			this.guidePinchStart = {
				origin: [...this.guideOrigin] as XY,
				angle,
				radius: s.compassRadius,
				idA: entries[0][0],
				a: entries[0][1],
				idB: entries[1][0],
				b: entries[1][1],
			};
			this.guideDrag = null;
			return;
		}
		this.guideDrag = { mode: "move", id: event.pointerId, offset: [this.guideOrigin[0] - x, this.guideOrigin[1] - y] };
	};

	private readonly onGuideRotateDown = (event: PointerEvent): void => {
		if (!this.guideOrigin || this.active || (event.pointerType === "mouse" && event.button !== 0)) return;
		event.preventDefault();
		event.stopPropagation();
		const [x, y] = this.toOverlay(event, this.svg.getBoundingClientRect());
		try {
			this.guideRotateGrip.setPointerCapture(event.pointerId);
		} catch {
			/* ignore */
		}
		const s = this.host.getSettings();
		if (s.compass) {
			this.guideDrag = { mode: "radius", id: event.pointerId };
			return;
		}
		const startPointerAngle = (Math.atan2(y - this.guideOrigin[1], x - this.guideOrigin[0]) * 180) / Math.PI;
		const startAngle = s.ruler ? s.rulerAngle : s.setSquareAngle;
		this.guideDrag = { mode: "rotate", id: event.pointerId, startAngle, startPointerAngle };
	};

	private readonly onGuideMove = (event: PointerEvent): void => {
		if (!this.guideOrigin) return;
		const [x, y] = this.toOverlay(event, this.svg.getBoundingClientRect());
		if (this.guideTouches.has(event.pointerId)) {
			this.guideTouches.set(event.pointerId, [x, y]);
		}
		if (this.guidePinchStart && this.guideTouches.size >= 2) {
			const p = this.guidePinchStart;
			const curA = this.guideTouches.get(p.idA);
			const curB = this.guideTouches.get(p.idB);
			if (curA && curB) {
				event.preventDefault();
				event.stopPropagation();
				const tf = twoFingerGuideTransform(p.origin, p.angle, p.a, p.b, curA, curB, 3);
				this.guideOrigin = tf.origin;
				const s = this.host.getSettings();
				if (s.ruler) this.host.updateSettings?.({ rulerAngle: tf.angle });
				else if (s.setSquare) this.host.updateSettings?.({ setSquareAngle: tf.angle });
				else if (s.compass) {
					const nextR = Math.max(40, Math.min(200, Math.round(p.radius * tf.scaleRatio)));
					this.host.updateSettings?.({ compassRadius: nextR });
				}
				this.renderGuide();
			}
			return;
		}
		const drag = this.guideDrag;
		if (!drag || event.pointerId !== drag.id) return;
		event.preventDefault();
		event.stopPropagation();
		const s = this.host.getSettings();
		if (drag.mode === "move") {
			this.guideOrigin = [x + drag.offset[0], y + drag.offset[1]];
			this.renderGuide();
		} else if (drag.mode === "rotate") {
			const curAng = (Math.atan2(y - this.guideOrigin[1], x - this.guideOrigin[0]) * 180) / Math.PI;
			const nextAng = snapGuideAngle(drag.startAngle + (curAng - drag.startPointerAngle), 3);
			if (s.ruler) this.host.updateSettings?.({ rulerAngle: nextAng });
			else if (s.setSquare) this.host.updateSettings?.({ setSquareAngle: nextAng });
			this.renderGuide();
		} else if (drag.mode === "radius") {
			const nextR = Math.max(40, Math.min(200, Math.round(Math.hypot(x - this.guideOrigin[0], y - this.guideOrigin[1]))));
			this.host.updateSettings?.({ compassRadius: nextR });
			this.renderGuide();
		}
	};

	private readonly onGuideEnd = (event: PointerEvent): void => {
		this.guideTouches.delete(event.pointerId);
		if (this.guideTouches.size < 2) this.guidePinchStart = null;
		if (this.guideDrag?.id === event.pointerId) this.guideDrag = null;
	};

	private readonly onGuideResetDown = (event: PointerEvent): void => {
		event.preventDefault();
		event.stopPropagation();
		const s = this.host.getSettings();
		if (s.ruler) this.host.updateSettings?.({ rulerAngle: s.rulerAngle === 0 ? 90 : 0 });
		else if (s.setSquare) this.host.updateSettings?.({ setSquareAngle: 0 });
		else if (s.compass) this.host.updateSettings?.({ compassRadius: 100 });
	};

	private readonly onGuideCloseDown = (event: PointerEvent): void => {
		event.preventDefault();
		event.stopPropagation();
		this.host.updateSettings?.({ ruler: false, setSquare: false, compass: false });
	};

	/** Client coordinates → overlay coordinates. */
	private clientToOverlay(clientX: number, clientY: number, rect: DOMRect): XY {
		const sx = this.effectiveScaleX();
		const sy = this.effectiveScaleY();
		return [(clientX - rect.left) / sx, (clientY - rect.top) / sy];
	}

	/** Pointer position in overlay coordinates. */
	private toOverlay(e: PointerEvent, rect: DOMRect): [number, number, number] {
		const [x, y] = this.clientToOverlay(e.clientX, e.clientY, rect);
		const p = e.pressure > 0 ? e.pressure : 0.5;
		return [x, y, Math.min(p, 1)];
	}

	private readonly onTouch = (e: TouchEvent): void => {
		let stylus = false;
		const direct: { x: number; y: number }[] = [];
		for (let i = 0; i < e.changedTouches.length; i++) {
			if ((e.changedTouches[i] as Touch & { touchType?: string }).touchType === "stylus") stylus = true;
		}
		for (let i = 0; i < e.touches.length; i++) {
			const t = e.touches[i] as Touch & { touchType?: string };
			if (t.touchType === "stylus") stylus = true;
			else if (typeof t.clientX === "number" && typeof t.clientY === "number") direct.push({ x: t.clientX, y: t.clientY });
		}
		if (this.isUiTarget(e.target, stylus ? "pen" : "touch")) return;
		if (stylus) {
			this.pinch = null;
			// Blocks scrolling, selection/caret moves, compat mouse events and iPadOS Scribble.
			if (e.cancelable) e.preventDefault();
			e.stopPropagation();
			return;
		}
		if (this.active && e.type === "touchmove" && e.cancelable) {
			// A resting palm/finger must not scroll the page out from under an active pen stroke,
			// and a finger dragging the selection must not scroll either.
			e.preventDefault();
			return;
		}
		// Two-finger pinch-to-zoom + focal-point pan directly on the note page.
		if (!this.active && !this.guideDrag && !this.guidePinchStart) {
			if (direct.length === 2) {
				this.navTap = null;
				if (e.cancelable) e.preventDefault();
				const dist = distanceBetween(direct[0], direct[1]);
				const mid = midpoint(direct[0], direct[1]);
				if (e.type === "touchstart" || !this.pinch) {
					this.pinch = {
						activation: new PinchActivation(dist, 0.03),
						startZoom: this.zoom,
						prevMid: mid,
						lastZoom: this.zoom,
					};
				} else if (e.type === "touchmove") {
					if (e.cancelable) e.preventDefault();
					const ratio = this.pinch.activation.ratio(dist);
					const nextZoom = this.pinch.activation.active
						? pinchScale(this.pinch.startZoom, 1, ratio, ZOOM_MIN, ZOOM_MAX)
						: this.pinch.startZoom;
					this.setZoom(nextZoom, mid, this.pinch.prevMid);
					this.pinch.prevMid = mid;
					this.pinch.lastZoom = nextZoom;
				}
				return;
			}
			if (this.pinch && (e.type === "touchend" || e.type === "touchcancel" || direct.length < 2)) {
				this.pinch = null;
			}
		}
		if (e.type === "touchstart" && this.selection && e.cancelable && e.touches.length === 1) {
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
		if (this.isUiTarget(e.target, e.pointerType)) return;
		if (e.pointerType === "touch") this.setPenNear(false);
		if (this.isDeskSelectPointer(e)) {
			this.onDeskSelectDown(e); // [Stage F]
			return;
		}
		if (!this.isInkPointer(e)) {
			this.onOtherPointerDown(e);
			return;
		}
		// Never let the editor see it: no caret move, no focus change, no selection.
		e.preventDefault();
		e.stopPropagation();
		if (this.active || !this.path || !this.store.isLoaded(this.path)) return;
		// Never auto-convert a formula mid-stroke while the user puts the pen down to keep writing.
		if (this.mathTimer !== null) {
			window.clearTimeout(this.mathTimer);
			this.mathTimer = null;
		}

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
		const edge = tool === "pen" && (settings.penShape === "freehand" || settings.penShape === "line")
			? nearestGuideEdge([x, y], this.guideEdges(), 24) : null;
		const compass = tool === "pen" && settings.penShape === "freehand" && settings.compass && this.guideOrigin
			? startCompassDrag([x, y], this.guideOrigin, settings.compassRadius, 22) : null;
		const shape = edge ? "line" : tool === "pen" ? settings.penShape : "freehand";
		const geometry: DrawGeometry | null = compass ? { kind: "compass", drag: compass } : shape === "freehand" ? null : {
			kind: "shape", shape, start: edge ? projectToInfiniteEdge([x, y], edge) : [x, y], edge, end: null,
		};
		const el = svgEl("path");
		const tilt = settings.tiltShading ? pointerTilt(e) : 0;
		// Geometry/ruler strokes render snapped shapes without tilt outlines; never strip their live stroke!
		const hasTilt = !geometry && tiltWidthMultiplier(tilt, params.style, params.tool) > 1.01;
		paint(el, hasTilt ? { ...params, tilts: [tilt] } : params);
		(tool === "highlighter" ? this.gHlLive : this.gPenLive).appendChild(el);
		const smoother = new StrokeSmoother(SMOOTHING_PARAMS[settings.smoothing]);
		smoother.push(x, y, p, eventTime(e));
		const straight: XY | null = tool === "highlighter" && settings.highlighterStraight ? [x, y] : null;
		const draw: DrawInput = {
			kind: "draw",
			...track,
			...params,
			points: smoother.points,
			smoother,
			curve: !hasTilt && isCenterline(params) ? new CurveBuilder() : null,
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
			geometry,
			straight,
			lastScribbleCheck: now,
			scribble: new ScribbleTracker(),
			tiltSamples: [{ x, y, tilt }],
			hasTilt,
			lastPressure: p,
			lastTilt: tilt,
		};
		if (straight) draw.points = straightLine(straight, straight);
		this.active = draw;
		this.armHold(draw);
		this.scheduleLive();
	};

	private onOtherPointerDown(e: PointerEvent): void {
		if (this.active) return;
		if (e.pointerType === "mouse" && e.button !== 0) return;
		const canTapType =
			(e.pointerType === "touch" || (e.pointerType === "mouse" && e.button === 0)) &&
			!this.isInteractiveEditorTarget(e.target);
		if (!this.selection) {
			this.navTap = canTapType ? { id: e.pointerId, x: e.clientX, y: e.clientY, t: performance.now(), moved: false } : null;
			return;
		}
		this.navTap = null;
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

	/** Do not intercept clicks on links, checkboxes, fold icons, widgets, or embeds. */
	private isInteractiveEditorTarget(target: EventTarget | null): boolean {
		if (!(target instanceof Element)) return false;
		return !!target.closest(
			"a, button, input, textarea, select, label, .clickable-icon, .internal-link, .external-link, .task-list-item-checkbox, .cm-foldGutter, .callout-fold, .pl-menu, .ink-pages-toolbar",
		);
	}

	private capture(pointerId: number): void {
		try {
			this.view.scrollDOM.setPointerCapture(pointerId);
		} catch {
			/* not fatal */
		}
	}

	private readonly onPointerMove = (e: PointerEvent): void => {
		if (this.navTap && e.pointerId === this.navTap.id && Math.hypot(e.clientX - this.navTap.x, e.clientY - this.navTap.y) >= 10) {
			this.navTap.moved = true;
		}
		const a = this.active;
		if (!a && e.pointerType === "mouse") this.onDeskHover(e); // [Stage F] cursor feedback
		if (!a && e.pointerType === "pen") this.setPenNear(true);
		if (!a || e.pointerId !== a.pointerId) return;
		e.preventDefault();
		e.stopPropagation();
		const rect = this.svg.getBoundingClientRect();
		let rawCoalesced: PointerEvent[] = [];
		if (typeof e.getCoalescedEvents === "function") {
			try {
				rawCoalesced = e.getCoalescedEvents();
			} catch {
				rawCoalesced = [];
			}
		}
		const list: PointerEvent[] = [];
		for (const ev of rawCoalesced) {
			if (!Number.isFinite(ev.clientX) || !Number.isFinite(ev.clientY)) continue;
			// Guard against WebKit uninitialized (0, 0) coalesced frames far away from the parent event.
			if (ev.clientX === 0 && ev.clientY === 0 && (Math.abs(e.clientX) > 20 || Math.abs(e.clientY) > 20)) continue;
			list.push(ev);
		}
		if (list.length === 0) {
			list.push(e);
		} else {
			const tail = list[list.length - 1];
			if (Math.hypot(tail.clientX - e.clientX, tail.clientY - e.clientY) > 0.5 && Number.isFinite(e.clientX) && Number.isFinite(e.clientY)) {
				list.push(e);
			}
		}
		const now = performance.now();
		const settings = this.host.getSettings();
		for (const ev of list) {
			const [x, y, p] = this.toOverlay(ev, rect);
			if (a.kind === "drag") {
				a.cur = [x, y];
				a.maxMove = Math.max(a.maxMove, Math.hypot(x - a.start[0], y - a.start[1]));
				continue;
			}
			a.maxMove = Math.max(a.maxMove, Math.hypot(x - a.downX, y - a.downY));
			if (a.kind === "draw") {
				if (ev.pointerType !== "pen" || ev.pressure > 0) a.lastPressure = p;
				const tilt = settings.tiltShading ? pointerTilt(ev) : 0;
				a.lastTilt = tilt;
				if (!a.geometry && !a.snap && !a.hasTilt && tiltWidthMultiplier(tilt, a.style, a.tool) > 1.01) {
					a.hasTilt = true;
					a.curve = null;
					paint(a.el, { ...a, tilts: [tilt] });
				}
				if (a.geometry) {
					this.moveGeometry(a.geometry, [x, y]);
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
				if (tip && tip[0] === x && tip[1] === y && tilt === a.tiltSamples[a.tiltSamples.length - 1]?.tilt) continue;
				a.tiltSamples.push({ x, y, tilt });
				a.smoother.push(x, y, a.lastPressure, eventTime(ev));
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
		if (a.kind !== "erase") this.scheduleLive();
	};

	private readonly onPointerEnd = (e: PointerEvent): void => {
		const completed = e.type === "pointerup";
		const nt = this.navTap;
		if (nt && e.pointerId === nt.id) {
			this.navTap = null;
			if (
				completed &&
				!nt.moved &&
				performance.now() - nt.t < 450 &&
				Math.hypot(e.clientX - nt.x, e.clientY - nt.y) < 10 &&
				e.isPrimary
			) {
				if (e.pointerType === "touch" && !this.view.contentDOM.contains(e.target as Node)) {
					this.lastCompletedTap = null;
					this.applyTapToType(e.clientX, e.clientY, e.target);
				} else {
					this.lastCompletedTap = { x: e.clientX, y: e.clientY, at: performance.now() };
				}
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
			const [x, y, p] = this.toOverlay(e, this.svg.getBoundingClientRect());
			if (a.geometry) {
				a.maxMove = Math.max(a.maxMove, Math.hypot(x - a.downX, y - a.downY));
				this.moveGeometry(a.geometry, [x, y]);
				this.updateDrawGeometry(a);
			} else if (a.straight) {
				a.points = straightLine(a.straight, [x, y]);
			} else if (!a.snap && Number.isFinite(x) && Number.isFinite(y)) {
				// Capture the lift coordinate so fast strokes never lose their final segment between
				// the last pointermove and pointerup, reusing last contact pressure when pressure === 0.
				const finalP = e.pointerType === "pen" && e.pressure === 0 ? a.lastPressure : p;
				const tip = a.smoother.tip;
				if (!tip || Math.hypot(x - tip[0], y - tip[1]) > 0.5) {
					a.maxMove = Math.max(a.maxMove, Math.hypot(x - a.downX, y - a.downY));
					a.tiltSamples.push({ x, y, tilt: a.lastTilt });
					a.smoother.push(x, y, finalP, eventTime(e));
				} else if (e.pointerType === "pen" && e.pressure === 0) {
					tip[2] = a.lastPressure;
				}
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
		const settings = this.host.getSettings();
		const doubleTapOn = a.pen && settings.doubleTapEraser && !(a.kind === "draw" && a.snap);
		if (doubleTapOn) this.recentInk = pruneRecentInk(this.recentInk, now);
		const pending = this.pendingTap;
		if (doubleTapOn && pending && a.pairWith === pending && isDoubleTap(pending.tap, tap, this.recentInk)) {
			// Double tap: neither tap leaves anything behind (no dots, no undo entries).
			this.pendingTap = null;
			window.clearTimeout(pending.timer);
			pending.discard();
			this.discardInput(a);
			if (settings.doubleTapAction === "eraser" || !this.host.runPencilGestureAction) this.host.toggleEraser();
			else this.host.runPencilGestureAction(settings.doubleTapAction);
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

	/** Drop an input without any effect (double-tap). */
	private discardInput(a: DrawInput | EraseInput | LassoInput): void {
		if (a.kind === "draw") {
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
	private drawShape(a: DrawInput, tilts?: number[]): Pick<Stroke, "tool" | "size" | "style" | "points" | "shape" | "tilts"> {
		return {
			tool: a.tool,
			size: a.size,
			style: a.style,
			points: a.points,
			...(a.snap ? { shape: a.snap.spec.kind } : {}),
			...(tilts ? { tilts } : {}),
		};
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
		if (!a.curve) {
			const pts = sm.livePoints();
			const tilts = a.hasTilt ? resampleTilts(a.tiltSamples, pts, a.style, a.tool) : undefined;
			return strokeToPath({ ...this.drawShape(a, tilts), points: pts }, { last: false });
		}
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
				this.clearFade();
				a.el.remove();
				this.store.removeStrokes(path, ids, newId());
				return;
			}
		}
		this.clearFade();
		// [Stage C] a highlighter stroke over typed text becomes a text highlight.
		const snapped =
			a.tool === "highlighter" && settings.highlighterSnapText !== false
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
		const tilts = settings.tiltShading && !a.snap ? resampleTilts(a.tiltSamples, a.points, a.style, a.tool) : undefined;
		const box = bbox(a.points);
		// Show the final shape until the next render replaces it with the stored stroke.
		paint(a.el, { ...this.drawShape(a, tilts), color: a.color });
		a.el.setAttribute("d", strokeToPath(this.drawShape(a, tilts)));
		this.pendingLive.push(a.el);
		const { anchor, pos, top } = this.anchorFor(a.points);
		const stroke: Stroke = {
			id: newId(),
			tool: a.tool,
			color: a.color,
			size: a.size,
			...(a.style ? { style: a.style } : {}),
			anchor,
			points: a.points.map((p): Point => [p[0], p[1] - top, p[2]]),
			...(tilts ? { tilts } : {}),
			...(a.snap ? { shape: a.snap.spec.kind } : {}),
			pos,
		};
		// [Stage H] over typed text: follow the character under it (or the stroke just drawn).
		if (box) {
			this.charA.anchorUnit([stroke], box, true);
			this.charA.drawn(stroke, box);
		}
		if (this.geo) this.store.setContentWidth(path, Math.round(this.geo.width));
		this.store.addStroke(path, stroke);
		if (box && this.geo && box.maxY > this.geo.height - 320) {
			this.extraPages = Math.min(40, this.extraPages + 1);
		}
		if (a.tool === "pen" && !a.snap && settings.mathMode) {
			this.mathBuffer.push(stroke.id);
			this.showMathBufferBar();
			this.armMathTimer();
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
			const origSamples = s.tilts
				? s.points.map((p, i) => ({ x: p[0] + from[0], y: p[1] + from[1], tilt: s.tilts![i] ?? 0 }))
				: null;
			for (const pts of pe.pieces.get(s)!) {
				const tilts = origSamples ? resampleTilts(origSamples, pts, s.style, s.tool) : undefined;
				const piece = this.anchoredStroke(
					// Pieces of a snapped shape keep straight segments (rendered as a polyline).
					{ tool: s.tool, color: s.color, size: s.size, style: s.style, shape: s.shape ? "polyline" : undefined, tilts },
					pts,
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

	private moveGeometry(geometry: DrawGeometry, point: XY): void {
		if (geometry.kind === "compass") moveCompass(geometry.drag, point);
		else geometry.end = point;
	}

	private updateDrawGeometry(a: DrawInput): void {
		const geometry = a.geometry;
		const minDrag = 2;
		if (!geometry || a.maxMove < minDrag) return;
		let spec: ShapeSpec | null = null;
		if (geometry.kind === "compass") {
			spec = compassShape(geometry.drag, minDrag);
		} else if (geometry.end) {
			const end = geometry.edge ? projectToInfiniteEdge(geometry.end, geometry.edge) : geometry.end;
			if (Math.hypot(end[0] - geometry.start[0], end[1] - geometry.start[1]) >= minDrag) spec = draggedShape(geometry.shape, geometry.start, end);
		}
		if (!spec) {
			a.snap = null;
			return;
		}
		a.snap = { spec0: spec, spec, p0: [a.downX, a.downY], pen: null };
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
		if (a.hasTilt) {
			a.hasTilt = false;
			paint(a.el, { ...this.drawShape(a), color: a.color });
		}
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
		const moved = this.groupCopies(parts, t);
		this.anchorGroup(moved); // [Stage H] the moved group follows ONE character if it qualifies
		this.replaceSelection(moved);
	}

	/** Overlay points of `s` transformed by `t` (or as shown, when `t` is null). */
	private overlayPoints(s: Stroke, t: SelectionTransform | null): Point[] {
		const [x, top] = this.place(s); // [Stage H] x ≠ 0 for shifted character-anchored ink
		return t ? transformPoints(s.points, top, t, x) : s.points.map((p): Point => [p[0] + x, p[1] + top, p[2]]);
	}

	private copyProps(s: Stroke, t: SelectionTransform | null, patch: Partial<Stroke> = {}): Pick<Stroke, "tool" | "color" | "size" | "style" | "shape" | "tilts"> {
		return {
			tool: s.tool,
			color: s.color,
			size: t ? scaledSize(s.size, t) : s.size,
			...(s.style ? { style: s.style } : {}),
			...(s.shape ? { shape: s.shape } : {}),
			...(s.tilts ? { tilts: s.tilts.slice() } : {}),
			...patch,
		};
	}

	/**
	 * A copy of `s` with a new id, transformed in overlay space (or not, when `t` is null), with
	 * `patch` applied, re-anchored to the line under its new top.
	 */
	private transformedCopy(s: Stroke, t: SelectionTransform | null, patch: Partial<Stroke> = {}): Stroke {
		return this.anchoredStroke(this.copyProps(s, t, patch), this.overlayPoints(s, t));
	}

	/** Transformed copies of a group (lasso move/scale, duplicate). */
	private groupCopies(strokes: readonly Stroke[], t: SelectionTransform): Stroke[] {
		return strokes.map((s) => this.transformedCopy(s, t));
	}

	/** A new stroke (new id) from overlay-space points, anchored to the line under its top. */
	private anchoredStroke(props: Pick<Stroke, "tool" | "color" | "size" | "style" | "shape" | "tilts">, pts: readonly Point[]): Stroke {
		const { anchor, pos, top } = this.anchorFor(pts);
		return {
			id: newId(),
			tool: props.tool,
			color: props.color,
			size: props.size,
			...(props.style ? { style: props.style } : {}),
			...(props.shape ? { shape: props.shape } : {}),
			...(props.tilts ? { tilts: props.tilts } : {}),
			anchor,
			points: pts.map((p): Point => [p[0], p[1] - top, p[2]]),
			pos,
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
		this.store.replaceStrokes(
			path,
			replaced.map((s) => s.id),
			next,
		);
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
		const copies = this.groupCopies(this.textHl.asFreehand(this.orderedSelection(), topOf), t); // [Stage C]
		this.anchorGroup(copies); // [Stage H]
		this.selection = copies;
		this.store.replaceStrokes(path, [], copies);
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
			console.warn("[ink-pages] PNG for the system clipboard failed", err);
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
		const strokes = placed.map(({ stroke, points }) => this.anchoredStroke(stroke, points));
		this.anchorGroup(strokes); // [Stage H]
		if (this.geo) this.store.setContentWidth(path, Math.round(this.geo.width));
		this.selection = strokes;
		this.store.replaceStrokes(path, [], strokes);
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
		const pos = this.view.posAtCoords({ x: r.left + x * this.effectiveScaleX(), y: r.top + y * this.effectiveScaleY() }, false);
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
		const sx = this.effectiveScaleX();
		const sy = this.effectiveScaleY();
		const sRect = sd.getBoundingClientRect();
		const sdScaleX = sd.offsetWidth > 0 && sRect.width > 0 ? sRect.width / sd.offsetWidth : 1;
		const sdScaleY = sd.offsetHeight > 0 && sRect.height > 0 ? sRect.height / sd.offsetHeight : 1;
		const svgRect = this.svg.getBoundingClientRect();
		const ox = (svgRect.left - sRect.left) / sdScaleX + sd.scrollLeft;
		const oy = (svgRect.top - sRect.top) / sdScaleY + sd.scrollTop;
		const vis = {
			minX: (sd.scrollLeft - ox) * (sdScaleX / sx),
			minY: (sd.scrollTop - oy) * (sdScaleY / sy),
			maxX: (sd.scrollLeft + sd.clientWidth - ox) * (sdScaleX / sx),
			maxY: (sd.scrollTop + sd.clientHeight - oy) * (sdScaleY / sy),
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
		const sx = this.effectiveScaleX();
		const sy = this.effectiveScaleY();
		const sd = this.view.scrollDOM;
		const sRect = sd.getBoundingClientRect();
		const sdScaleX = sd.offsetWidth > 0 && sRect.width > 0 ? sRect.width / sd.offsetWidth : 1;
		const sdScaleY = sd.offsetHeight > 0 && sRect.height > 0 ? sRect.height / sd.offsetHeight : 1;
		const svgRect = this.svg.getBoundingClientRect();
		const ox = (svgRect.left - sRect.left) / sdScaleX + sd.scrollLeft;
		const oy = (svgRect.top - sRect.top) / sdScaleY + sd.scrollTop;
		const target: BBox =
			this.menu.kind === "paste"
				? { minX: this.menu.at[0], minY: this.menu.at[1], maxX: this.menu.at[0], maxY: this.menu.at[1] }
				: box!;
		const t: BBox = {
			minX: target.minX * (sx / sdScaleX) + ox,
			minY: target.minY * (sy / sdScaleY) + oy,
			maxX: target.maxX * (sx / sdScaleX) + ox,
			maxY: target.maxY * (sy / sdScaleY) + oy,
		};
		el.classList.remove("pl-hidden");
		const w = el.offsetWidth;
		const h = el.offsetHeight;
		const key = `${this.menu.kind}:${this.menu.kind === "selection" && this.menu.colors}:${t.minX},${t.minY},${t.maxX},${t.maxY}:${w}x${h}`;
		// Placed once per target/content: scrolling the note doesn't make it jump around.
		if (key === this.menuKey) return;
		this.menuKey = key;
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
		this.menuItem(el, "fx", "To LaTeX", () => void this.convertSelectionToLatex());
		if (this.host.openAssistant) {
			this.menuItem(el, "sparkles", "Ask AI", () => this.askGeminiOnSelection());
		}
		this.menuItem(el, "camera", "Screenshot", () => this.screenshotSelection());
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
		if (icon === "fx") {
			const span = b.createSpan({ cls: "pl-menu-icon pl-fx-badge", text: "fx" });
			if (!span.parentElement) b.appendChild(span);
			b.createSpan({ cls: "pl-menu-label", text: label });
		} else if (icon) {
			setIcon(b.createSpan({ cls: "pl-menu-icon" }), icon);
			if (cls !== "pl-menu-back") b.createSpan({ cls: "pl-menu-label", text: label });
		} else {
			setTooltip(b, label, { placement: "top" });
		}
		if (cls === "pl-menu-sub") setIcon(b.createSpan({ cls: "pl-menu-chevron" }), "chevron-right");
		onTap(b, run);
		return b;
	}

	// -------------------------------------------------------------------------------------------
	// Tap anywhere to type + handwritten formulas → LaTeX
	// -------------------------------------------------------------------------------------------

	private readonly onEditorClick = (e: MouseEvent): void => {
		const tap = this.lastCompletedTap;
		this.lastCompletedTap = null;
		if (!tap || performance.now() - tap.at > 400) return;
		if (e.defaultPrevented || this.active || this.selection) return;
		const s = this.host.getSettings();
		if (s.mouseDraws || this.host.deskSelect() !== null) return;
		if (this.isUiTarget(e.target) || this.isInteractiveEditorTarget(e.target)) return;
		if (!this.view.state.selection.main.empty) return;
		this.applyTapToType(e.clientX || tap.x, e.clientY || tap.y, e.target);
	};

	private lineInfoAt(lineNumber: number, svgRect: DOMRect, sx: number): TapLineInfo {
		const doc = this.view.state.doc;
		const line = doc.line(lineNumber);
		const sy = this.view.scaleY || 1;
		const block = this.view.lineBlockAt(line.from);
		const top = unzoomedLineTop(this.view, line.from);
		const height = (block.bottom - block.top) / sy;
		const endCoords = this.view.coordsAtPos(line.to);
		const lineEndX = endCoords ? Math.max(0, (endCoords.right - svgRect.left) / sx) : 0;
		return { top, bottom: top + height, lineTo: line.to, lineEndX };
	}

	private applyTapToType(clientX: number, clientY: number, target: EventTarget | null): void {
		if (this.destroyed) return;
		this.applyGeometry(this.readGeometry(this.view));
		const geo = this.geo;
		if (!geo) return;
		const rect = this.svg.getBoundingClientRect();
		const sx = this.effectiveScaleX();
		const [tapX, tapY] = this.clientToOverlay(clientX, clientY, rect);
		const sy = this.view.scaleY || 1;
		const lineH = (this.view.defaultLineHeight || 24) / sy;
		const charW = (this.view.defaultCharacterWidth || 8.5) / (this.view.scaleX || 1);
		const doc = this.view.state.doc;
		const lastLine = this.lineInfoAt(doc.lines, rect, sx);
		let lineAtTap: TapLineInfo | undefined;
		if (tapY <= lastLine.bottom + lineH * 0.4) {
			const block = this.view.lineBlockAtHeight(Math.max(0, tapY) * sy);
			const line = doc.lineAt(block.from);
			lineAtTap = this.lineInfoAt(line.number, rect, sx);
		}
		const plan = planTapToType({
			docLength: doc.length,
			lineHeight: lineH,
			charWidth: charW,
			tapX,
			tapY,
			lastLine,
			lineAtTap,
		});
		if (plan) {
			this.view.dispatch({
				changes: { from: plan.from, to: plan.from, insert: plan.insert },
				selection: { anchor: plan.anchor },
				userEvent: "input",
			});
			this.view.focus();
			return;
		}
		if (target instanceof Node && !this.view.contentDOM.contains(target)) {
			const clampedX = rect.left + Math.max(4, Math.min(Math.max(4, geo.width - 4), tapX)) * sx;
			const pos = this.view.posAtCoords({ x: clampedX, y: clientY }, false);
			this.view.dispatch({ selection: { anchor: pos }, userEvent: "select.pointer" });
			this.view.focus();
		}
	}

	private clearMathBuffer(): void {
		if (this.mathTimer !== null) {
			window.clearTimeout(this.mathTimer);
			this.mathTimer = null;
		}
		this.mathBuffer = [];
		if (!this.pendingMath) this.clearMathBar();
	}

	private clearMathBar(): void {
		this.pendingMath = null;
		this.mathBarEl?.remove();
		this.mathBarEl = null;
	}

	private ensureMathBar(): HTMLElement | null {
		const leaf = this.view.scrollDOM.closest?.<HTMLElement>(".workspace-leaf-content") ?? null;
		if (!leaf || typeof leaf.createDiv !== "function") return null;
		if (!this.mathBarEl || !this.mathBarEl.isConnected) {
			const bar = leaf.createDiv({ cls: "pl-math-bar" });
			bar.addEventListener("pointerdown", (e) => e.stopPropagation());
			blockStylusTouch(bar);
			this.mathBarEl = bar;
		}
		return this.mathBarEl;
	}

	private showMathBufferBar(): void {
		const bar = this.ensureMathBar();
		if (!bar) return;
		bar.empty();
		const count = this.mathBuffer.length;
		bar.createSpan({ cls: "pl-math-status", text: `Formel (${count} ${count === 1 ? "Strich" : "Striche"})` });
		const go = bar.createEl("button", { cls: "mod-cta pl-math-btn", text: "→ LaTeX" });
		onTap(go, () => {
			if (this.mathTimer !== null) {
				window.clearTimeout(this.mathTimer);
				this.mathTimer = null;
			}
			void this.flushMathBuffer();
		});
		const cancel = bar.createEl("button", { cls: "pl-math-btn", text: "×" });
		onTap(cancel, () => {
			this.clearMathBuffer();
			this.clearMathBar();
		});
	}

	private showMathConfirmBar(pending: { path: string; strokeIds: string[]; rawTex: string; midY: number; box: BBox }, usedVision: boolean): void {
		const bar = this.ensureMathBar();
		if (!bar) {
			// Headless / test environment fallback: commit immediately.
			this.pendingMath = pending;
			this.commitPendingMath(pending.rawTex);
			return;
		}
		this.pendingMath = pending;
		bar.empty();
		bar.createSpan({ cls: "pl-math-badge", text: usedVision ? "Gemini LaTeX" : "LaTeX" });
		const input = bar.createEl("input", {
			cls: "pl-math-input",
			type: "text",
			value: pending.rawTex,
			attr: { "aria-label": "Edit recognized LaTeX formula" },
		});
		input.addEventListener("keydown", (e) => {
			if (e.key === "Enter") {
				e.preventDefault();
				this.commitPendingMath(input.value);
			} else if (e.key === "Escape") {
				e.preventDefault();
				this.clearMathBar();
			}
		});
		const insertBtn = bar.createEl("button", { cls: "mod-cta pl-math-btn", text: "Insert" });
		onTap(insertBtn, () => this.commitPendingMath(input.value));
		if (this.host.openAssistant) {
			const geminiBtn = bar.createEl("button", { cls: "pl-math-btn", text: "Gemini" });
			onTap(geminiBtn, () => {
				const ink = this.store.get(pending.path);
				const ids = new Set(pending.strokeIds);
				const src = (ink?.strokes ?? []).filter((s) => ids.has(s.id));
				if (src.length > 0) this.openGeminiForStrokes(src, "Convert this handwritten formula into clean Obsidian LaTeX ($...$ / $$...$$).");
			});
		}
		const cancelBtn = bar.createEl("button", { cls: "pl-math-btn", text: "Keep ink" });
		onTap(cancelBtn, () => this.clearMathBar());
	}

	private commitPendingMath(rawTex: string): boolean {
		const pending = this.pendingMath;
		this.clearMathBar();
		if (!pending || this.destroyed || this.path !== pending.path || !this.store.isLoaded(pending.path)) return false;
		const settings = this.host.getSettings();
		const formatted = formatLatexFormula(rawTex, settings.mathDelimiters);
		if (!formatted) {
			new Notice("Empty formula — handwriting kept.");
			return false;
		}
		const ink = this.store.get(pending.path);
		const onCanvas = new Set((ink?.strokes ?? []).map((s) => s.id));
		const removeIds = pending.strokeIds.filter((id) => onCanvas.has(id));
		if (removeIds.length > 0) this.store.removeStrokes(pending.path, removeIds, newId());

		this.applyGeometry(this.readGeometry(this.view));
		const rect = this.svg.getBoundingClientRect();
		const sx = this.effectiveScaleX();
		const doc = this.view.state.doc;
		const sy = this.view.scaleY || 1;
		const lineH = (this.view.defaultLineHeight || 24) / sy;
		const lastLine = this.lineInfoAt(doc.lines, rect, sx);
		const midY = pending.midY;
		const targetLine = midY <= lastLine.bottom + lineH * 0.4
			? doc.lineAt(this.view.lineBlockAtHeight(Math.max(0, midY) * sy).from)
			: doc.line(doc.lines);
		const { prefixNewlines, from } = insertionPosForY(midY, lastLine, lineH, targetLine.to, doc.length);
		const existingLine = doc.lineAt(from);
		const leading =
			prefixNewlines > 0
				? "\n".repeat(prefixNewlines)
				: existingLine.text.trim().length > 0 && formatted.startsWith("$$")
					? "\n"
					: existingLine.length > 0
						? " "
						: "";
		const insert = `${leading}${formatted}`;
		this.view.dispatch({
			changes: { from, to: from, insert },
			selection: { anchor: from + insert.length },
			userEvent: "input",
		});
		new Notice(`LaTeX inserted: ${formatted}`, 2500);
		return true;
	}

	private armMathTimer(): void {
		if (this.mathTimer !== null) window.clearTimeout(this.mathTimer);
		const delay = this.host.getSettings().mathAutoDelayMs || 1600;
		this.mathTimer = window.setTimeout(() => {
			this.mathTimer = null;
			void this.flushMathBuffer();
		}, delay);
	}

	private async flushMathBuffer(): Promise<void> {
		const path = this.path;
		const ids = new Set(this.mathBuffer);
		this.mathBuffer = [];
		if (ids.size === 0 || !path || !this.store.isLoaded(path) || this.destroyed) return;
		const ink = this.store.get(path);
		if (!ink) return;
		const strokes = ink.strokes.filter((s) => ids.has(s.id));
		if (strokes.length === 0) return;
		await this.convertStrokesToLatex(strokes);
	}

	async convertSelectionToLatex(): Promise<void> {
		const sel = this.selection;
		if (!sel || sel.length === 0) return;
		const ok = await this.convertStrokesToLatex(sel);
		if (ok) this.clearSelection();
	}

	private askGeminiOnSelection(): void {
		const sel = this.selection;
		if (!sel || sel.length === 0) return;
		this.openGeminiForStrokes(sel);
	}

	private openGeminiForStrokes(strokes: readonly Stroke[], initialPrompt?: string): void {
		const path = this.path;
		if (!path || !this.host.openAssistant || strokes.length === 0) return;
		const overlayStrokes: Stroke[] = [];
		let minX = Infinity;
		let minY = Infinity;
		let maxX = -Infinity;
		let maxY = -Infinity;
		for (const s of strokes) {
			const [ox, top] = this.place(s);
			const pts = s.points.map((p): Point => [p[0] + ox, p[1] + top, p[2]]);
			const b = bbox(pts);
			if (!b) continue;
			minX = Math.min(minX, b.minX);
			minY = Math.min(minY, b.minY);
			maxX = Math.max(maxX, b.maxX);
			maxY = Math.max(maxY, b.maxY);
			overlayStrokes.push({ ...s, points: pts });
		}
		if (overlayStrokes.length === 0 || !Number.isFinite(minX)) return;
		const png = strokesToPngBase64(overlayStrokes, { minX, minY, maxX, maxY });
		const noteTitle = path.slice(path.lastIndexOf("/") + 1).replace(/\.md$/i, "");
		const noteContext = this.view.state.doc.toString();
		this.host.openAssistant({
			noteTitle,
			noteContext,
			imageBase64Png: png,
			initialPrompt,
			insertAtCursor: (text) => {
				if (this.destroyed || this.path !== path) return false;
				const st = this.view.state;
				const head = st.selection.main.head;
				const prefix = head > 0 && st.doc.sliceString(head - 1, head) !== "\n" ? "\n\n" : "";
				const ins = `${prefix}${text}\n`;
				this.view.dispatch({
					changes: { from: head, insert: ins },
					selection: { anchor: head + ins.length },
					userEvent: "input",
				});
				return true;
			},
		});
	}

	private async convertStrokesToLatex(strokes: readonly Stroke[]): Promise<boolean> {
		const path = this.path;
		if (!path || !this.store.isLoaded(path) || this.destroyed || strokes.length === 0) return false;
		const overlayStrokes: Stroke[] = [];
		let minX = Infinity;
		let minY = Infinity;
		let maxX = -Infinity;
		let maxY = -Infinity;
		for (const s of strokes) {
			if (s.tool === "highlighter") continue;
			const [ox, top] = this.place(s);
			const pts = s.points.map((p): Point => [p[0] + ox, p[1] + top, p[2]]);
			const b = bbox(pts);
			if (!b) continue;
			minX = Math.min(minX, b.minX);
			minY = Math.min(minY, b.minY);
			maxX = Math.max(maxX, b.maxX);
			maxY = Math.max(maxY, b.maxY);
			overlayStrokes.push({ ...s, points: pts });
		}
		if (overlayStrokes.length === 0 || !Number.isFinite(minX)) return false;

		const settings = this.host.getSettings();
		const box: BBox = { minX, minY, maxX, maxY };
		const bar = this.ensureMathBar();
		if (bar) {
			bar.empty();
			bar.createSpan({ cls: "pl-math-status", text: "Recognizing formula…" });
		}
		const { tex: rawTex, usedVision } = await recognizeMathStrokes(overlayStrokes, box, {
			provider: settings.mathProvider,
			apiKey: settings.mathApiKey,
			geminiApiKey: settings.geminiApiKey,
			geminiModel: settings.geminiModel,
		});
		if (this.destroyed || this.path !== path || !this.store.isLoaded(path)) return false;
		if (!rawTex.trim()) {
			this.clearMathBar();
			new Notice("No formula recognized — use the lasso menu or set a Gemini API key for handwritten formulas.");
			return false;
		}
		this.showMathConfirmBar(
			{
				path,
				strokeIds: strokes.map((s) => s.id),
				rawTex,
				midY: (minY + maxY) / 2,
				box,
			},
			usedVision,
		);
		return true;
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
		EditorView.contentAttributes.of({ class: "ink-pages-content" }),
	];
}
