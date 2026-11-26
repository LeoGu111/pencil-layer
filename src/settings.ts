/**
 * Plugin settings: defaults, palettes, sanitizing and the mapping from toolbar state to stroke
 * parameters. Pure (no Obsidian / DOM imports) so it can be unit-tested.
 *
 * Settings are split in two:
 *  - `SyncedSettings` live in the plugin's `data.json`, which Obsidian Sync copies to every device.
 *  - `LocalSettings` (toolbar visibility/position/edge/collapsed, mouse draws, and the Stage E tool
 *    options that weren't synced before: eraser mode/size/highlighter-only, straight highlighter,
 *    highlighter snap-to-text, lasso filter) are per device, kept in `app.saveLocalStorage` — e.g.
 *    the toolbar can be shown on the iPad and hidden on the Mac.
 */
import type { PenStyle, Tool } from "./model";
import { SMOOTHING_LEVELS, SmoothingLevel } from "./smoothing";
import { DRAW_SHAPES, DrawShape, SNAP_HOLD_MS } from "./shapes";
import { DOC_FONTS, DocFont, EXPORT_STYLES, ExportStyle } from "./docStyle";

export type ActiveTool = Tool | "eraser" | "lasso";
/** Pen presets. "dashed" was "dotted" before Stage A2 (migrated on load). */
export type PenPreset = "thin" | "dashed" | "thick";
export type HighlighterWidth = "normal" | "wide";
export type PenFeel = "ball" | "notes";
/** Stage E eraser: "stroke" removes whole strokes, "precise" erases only the part touched. */
export type EraserMode = "stroke" | "precise";
export type EraserSize = "s" | "m" | "l";
/** Stage E lasso filter: which ink a lasso selects. */
export type LassoFilter = "both" | "pen" | "highlighter";
/** The leaf edge the floating toolbar is docked nearest to (horizontal bar at top/bottom). */
export type ToolbarEdge = "top" | "bottom" | "left" | "right";
/** Stage F desktop Select tool: rectangle drag (default) or freeform lasso. */
export type SelectMode = "rect" | "lasso";

export interface PenWidths {
	thin: number;
	dashed: number;
	thick: number;
}

export interface SyncedSettings {
	tool: ActiveTool;
	penPreset: PenPreset;
	penColor: string;
	highlighterColor: string;
	highlighterWidth: HighlighterWidth;
	/** "ball" = ballpoint (constant width), "notes" = Apple Notes-style pressure/velocity outline. */
	penFeel: PenFeel;
	/** On-screen widths in px of the three pen presets. */
	penWidths: PenWidths;
	inkVisible: boolean;
	/** New drawing spaces have the fixed printable height of portrait A4. */
	a4DrawingSpaces: boolean;
	/** Draw and hold to snap to a shape (pen only). */
	shapeSnap: boolean;
	/** How long the pen must stay still before snapping (ms). */
	shapeHoldMs: number;
	/** Two quick Pencil-tip taps toggle the eraser. */
	doubleTapEraser: boolean;
	/** Scribble over strokes to erase them (opt-in; conservative coverage rule). */
	scribbleErase: boolean;
	/** Input smoothing of freehand ink (One Euro filter strength; curves are always smooth). */
	smoothing: SmoothingLevel;
	/** Vault folder holding the ink sidecars (`<inkFolder>/<note path>.json`). */
	inkFolder: string;
	/** Vault folder where "Save to vault" puts lasso screenshots. */
	screenshotFolder: string;
	/** PDF export style used by Obsidian's own export and "Export PDF with / without ink". */
	defaultExportStyle: ExportStyle;
	/** Font of the document-style PDF export. */
	docExportFont: DocFont;
	/**
	 * Settings schema version. 2 (Stage E): double-tap became opt-in and the hold delay default
	 * 0.5 s — older data.json files are migrated once (see `sanitizeSynced`).
	 */
	settingsVersion: number;
}

/** Floating toolbar position: fractions (0..1) of the free horizontal / vertical range in the leaf. */
export interface ToolbarPos {
	x: number;
	y: number;
}

export interface LocalSettings {
	toolbarVisible: boolean;
	mouseDraws: boolean;
	/** Stage D: draw ink in Obsidian's PDF export (per device, default on). */
	includeInkInPdf: boolean;
	/** Where the floating toolbar was dragged to (null = bottom-center). */
	toolbarPos: ToolbarPos | null;
	/** Floating toolbar collapsed to undo/redo + tools. */
	toolbarCollapsed: boolean;
	/** Edge the bar is docked nearest to: horizontal at top/bottom, vertical at left/right. */
	toolbarEdge: ToolbarEdge;
	/** Stage E tool options (per device). */
	eraserMode: EraserMode;
	eraserSize: EraserSize;
	/** The eraser only erases highlighter strokes. */
	eraseHighlighterOnly: boolean;
	/** Highlighter draws straight lines (start → pen, snapped to horizontal within a few degrees). */
	highlighterStraight: boolean;
	/** Highlighter strokes over typed text snap to the text (Stage C, word boundaries). */
	highlighterSnapText: boolean;
	lassoFilter: LassoFilter;
	/** Stage F: the desktop Select tool drags a rectangle or a freeform lasso. */
	selectMode: SelectMode;
	/**
	 * Desktop: a pen (Surface Pen, Wacom, …) is used on this device — the full drawing toolbar is
	 * shown even when the mouse doesn't draw. Set automatically the first time a pen touches a note.
	 */
	penDevice: boolean;
	penShape: DrawShape;
	setSquare: boolean;
	setSquareAngle: number;
	compass: boolean;
	compassRadius: number;
	/**
	 * Per-device settings schema version. 2 (Stage F): the desktop toolbar (now the slim Select
	 * variant) is shown by default — see `sanitizeLocal`.
	 */
	localVersion: number;
}

export type PencilSettings = SyncedSettings & LocalSettings;

export const LOCAL_KEYS: readonly (keyof LocalSettings)[] = [
	"toolbarVisible",
	"mouseDraws",
	"includeInkInPdf",
	"toolbarPos",
	"toolbarCollapsed",
	"toolbarEdge",
	"penShape",
	"setSquare",
	"setSquareAngle",
	"compass",
	"compassRadius",
	"eraserMode",
	"eraserSize",
	"eraseHighlighterOnly",
	"highlighterStraight",
	"highlighterSnapText",
	"lassoFilter",
	"selectMode",
	"penDevice",
	"localVersion",
];

export interface PaletteColor {
	value: string;
	label: string;
}

/** Pen colors in toolbar order ("ink" = theme text color: black in light theme, white in dark). */
export const PEN_COLORS: readonly PaletteColor[] = [
	{ value: "ink", label: "Black (theme text color)" },
	{ value: "#FF0000", label: "Red" },
	{ value: "#03468F", label: "Blue" },
	{ value: "#F59A23", label: "Orange" },
	{ value: "#93419C", label: "Purple" },
	{ value: "#007355", label: "Green" },
	{ value: "#F65353", label: "Coral" },
];

export const HIGHLIGHTER_COLORS: readonly PaletteColor[] = [
	{ value: "#39FF14", label: "Neon green" },
	{ value: "#FFF01F", label: "Neon yellow" },
	{ value: "#BC13FE", label: "Neon purple" },
	{ value: "#1F51FF", label: "Neon blue" },
];

/**
 * GoodNotes letter page (216 mm) fills the iPad width (~1180 pt) ⇒ ~5.5 px/mm:
 * 0.3 mm ≈ 1.6 px, 0.5 mm ≈ 2.7 px.
 */
export const DEFAULT_PEN_WIDTHS: Readonly<PenWidths> = { thin: 1.6, dashed: 1.6, thick: 2.7 };
export const PEN_WIDTH_MIN = 0.5;
export const PEN_WIDTH_MAX = 20;

/** Hold delay bounds/default for snap to shape (ms). */
export const DEFAULT_HOLD_MS = SNAP_HOLD_MS;
/** Hold-delay choices offered in the pen popover (ms). */
export const HOLD_MS_CHOICES: readonly number[] = [300, 500, 800, 1200];
/** Current settings schema version (see `SyncedSettings.settingsVersion`). */
export const SETTINGS_VERSION = 2;

/** Precise-eraser radius (px) per size. The stroke eraser always uses `STROKE_ERASER_RADIUS`. */
export const ERASER_RADII: Readonly<Record<EraserSize, number>> = { s: 5, m: 10, l: 20 };
export const STROKE_ERASER_RADIUS = 10;
export const HOLD_MS_MIN = 200;
export const HOLD_MS_MAX = 1500;

/** Highlighter widths in px (normal ≈ half a text line, wide ≈ a full text line). */
export const HIGHLIGHTER_WIDTHS: Readonly<Record<HighlighterWidth, number>> = { normal: 12, wide: 22 };

/** Default sidecar folder (visible: Obsidian Sync skips hidden folders). */
export const DEFAULT_INK_FOLDER = "Attachments/Ink";
export const DEFAULT_SCREENSHOT_FOLDER = "Attachments/Screenshots";

/**
 * A vault folder path as typed by the user: trimmed, `\` → `/`, no empty / `.` segments, no leading
 * or trailing slash. Returns `fallback` when nothing usable is left, the path climbs out of the vault
 * (`..`), or a segment is hidden (starts with `.`: Obsidian doesn't index or sync hidden folders).
 */
export function sanitizeFolder(v: unknown, fallback: string): string {
	if (typeof v !== "string") return fallback;
	const parts = v
		.replace(/\\/g, "/")
		.split("/")
		.map((s) => s.trim())
		.filter((s) => s !== "" && s !== ".");
	if (parts.length === 0 || parts.some((s) => s.startsWith("."))) return fallback;
	return parts.join("/");
}

export const DEFAULT_SYNCED: Readonly<SyncedSettings> = {
	tool: "pen",
	penPreset: "thin",
	penColor: "ink",
	highlighterColor: HIGHLIGHTER_COLORS[0].value,
	highlighterWidth: "normal",
	penFeel: "ball",
	penWidths: DEFAULT_PEN_WIDTHS,
	inkVisible: true,
	a4DrawingSpaces: false,
	shapeSnap: true,
	shapeHoldMs: DEFAULT_HOLD_MS,
	doubleTapEraser: false,
	scribbleErase: false,
	smoothing: "medium",
	inkFolder: DEFAULT_INK_FOLDER,
	screenshotFolder: DEFAULT_SCREENSHOT_FOLDER,
	defaultExportStyle: "themed",
	docExportFont: "serif",
	settingsVersion: SETTINGS_VERSION,
};

/** Current per-device settings schema version (see `LocalSettings.localVersion`). */
export const LOCAL_VERSION = 2;

/**
 * Per-device defaults: the toolbar is shown everywhere — the full toolbar on mobile (drawing), the
 * slim Select toolbar on desktop (Stage F; before it, the desktop default was hidden).
 */
export function defaultLocal(_isMobile: boolean): LocalSettings {
	return {
		toolbarVisible: true,
		mouseDraws: false,
		includeInkInPdf: true,
		toolbarPos: null,
		toolbarCollapsed: false,
		toolbarEdge: "bottom",
		penShape: "freehand",
		setSquare: false,
		setSquareAngle: 0,
		compass: false,
		compassRadius: 100,
		eraserMode: "stroke",
		eraserSize: "m",
		eraseHighlighterOnly: false,
		highlighterStraight: false,
		highlighterSnapText: true,
		lassoFilter: "both",
		selectMode: "rect",
		penDevice: false,
		localVersion: LOCAL_VERSION,
	};
}

const TOOLS: readonly ActiveTool[] = ["pen", "highlighter", "eraser", "lasso"];
const PRESETS: readonly PenPreset[] = ["thin", "dashed", "thick"];
const HL_WIDTHS: readonly HighlighterWidth[] = ["normal", "wide"];
const FEELS: readonly PenFeel[] = ["ball", "notes"];
const EDGES: readonly ToolbarEdge[] = ["top", "bottom", "left", "right"];
const ERASER_MODES: readonly EraserMode[] = ["stroke", "precise"];
const ERASER_SIZES: readonly EraserSize[] = ["s", "m", "l"];
const LASSO_FILTERS: readonly LassoFilter[] = ["both", "pen", "highlighter"];
const SELECT_MODES: readonly SelectMode[] = ["rect", "lasso"];

function oneOf<T>(list: readonly T[], v: unknown, fallback: T): T {
	return list.includes(v as T) ? (v as T) : fallback;
}

function bool(v: unknown, fallback: boolean): boolean {
	return typeof v === "boolean" ? v : fallback;
}

function asObject(raw: unknown): Record<string, unknown> {
	return raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
}

function inPalette(palette: readonly PaletteColor[], v: unknown): v is string {
	return typeof v === "string" && palette.some((c) => c.value === v);
}

/** Clamp a pen width; returns `fallback` for anything that isn't a positive finite number. */
export function sanitizeWidth(v: unknown, fallback: number): number {
	const n = typeof v === "string" && v.trim() !== "" ? Number(v) : v;
	if (typeof n !== "number" || !Number.isFinite(n) || n <= 0) return fallback;
	return Math.min(Math.max(Math.round(n * 10) / 10, PEN_WIDTH_MIN), PEN_WIDTH_MAX);
}

/** Hold delay in ms, clamped; `fallback` for anything that isn't a finite number. */
export function sanitizeHoldMs(v: unknown, fallback = DEFAULT_HOLD_MS): number {
	const n = typeof v === "string" && v.trim() !== "" ? Number(v) : v;
	if (typeof n !== "number" || !Number.isFinite(n)) return fallback;
	return Math.min(Math.max(Math.round(n), HOLD_MS_MIN), HOLD_MS_MAX);
}

/**
 * Synced settings from `data.json` (any shape, incl. M1's). Unknown/invalid values fall back to
 * defaults; M1-only keys (penSize, highlighterSize, toolbarVisible, mouseDraws) are dropped;
 * colors outside the current palettes reset to the palette default. Stage A's "dotted" preset (and its
 * width) become "dashed".
 *
 * Migration to version 2 (Stage E), for files written before it (no/older `settingsVersion`):
 * double-tap → eraser is switched OFF (it used to default on and misfired on dotted i's; the user
 * asked for it to be opt-in) and the old 450 ms default hold delay becomes the new 500 ms default.
 */
export function sanitizeSynced(raw: unknown): SyncedSettings {
	const r = asObject(raw);
	const version = typeof r.settingsVersion === "number" && Number.isFinite(r.settingsVersion) ? r.settingsVersion : 1;
	const legacy = version < 2;
	const w = asObject(r.penWidths);
	const preset = r.penPreset === "dotted" ? "dashed" : r.penPreset;
	return {
		tool: TOOLS.includes(r.tool as ActiveTool) ? (r.tool as ActiveTool) : DEFAULT_SYNCED.tool,
		penPreset: PRESETS.includes(preset as PenPreset) ? (preset as PenPreset) : DEFAULT_SYNCED.penPreset,
		penColor: inPalette(PEN_COLORS, r.penColor) ? r.penColor : DEFAULT_SYNCED.penColor,
		highlighterColor: inPalette(HIGHLIGHTER_COLORS, r.highlighterColor)
			? r.highlighterColor
			: DEFAULT_SYNCED.highlighterColor,
		highlighterWidth: HL_WIDTHS.includes(r.highlighterWidth as HighlighterWidth)
			? (r.highlighterWidth as HighlighterWidth)
			: DEFAULT_SYNCED.highlighterWidth,
		penFeel: FEELS.includes(r.penFeel as PenFeel) ? (r.penFeel as PenFeel) : DEFAULT_SYNCED.penFeel,
		penWidths: {
			thin: sanitizeWidth(w.thin, DEFAULT_PEN_WIDTHS.thin),
			dashed: sanitizeWidth(w.dashed ?? w.dotted, DEFAULT_PEN_WIDTHS.dashed),
			thick: sanitizeWidth(w.thick, DEFAULT_PEN_WIDTHS.thick),
		},
		inkVisible: typeof r.inkVisible === "boolean" ? r.inkVisible : DEFAULT_SYNCED.inkVisible,
		a4DrawingSpaces: bool(r.a4DrawingSpaces, DEFAULT_SYNCED.a4DrawingSpaces),
		shapeSnap: typeof r.shapeSnap === "boolean" ? r.shapeSnap : DEFAULT_SYNCED.shapeSnap,
		shapeHoldMs: legacy && r.shapeHoldMs === 450 ? DEFAULT_HOLD_MS : sanitizeHoldMs(r.shapeHoldMs),
		doubleTapEraser: legacy ? false : bool(r.doubleTapEraser, DEFAULT_SYNCED.doubleTapEraser),
		scribbleErase: typeof r.scribbleErase === "boolean" ? r.scribbleErase : DEFAULT_SYNCED.scribbleErase,
		smoothing: SMOOTHING_LEVELS.includes(r.smoothing as SmoothingLevel)
			? (r.smoothing as SmoothingLevel)
			: DEFAULT_SYNCED.smoothing,
		inkFolder: sanitizeFolder(r.inkFolder, DEFAULT_INK_FOLDER),
		screenshotFolder: sanitizeFolder(r.screenshotFolder, DEFAULT_SCREENSHOT_FOLDER),
		defaultExportStyle: oneOf(EXPORT_STYLES, r.defaultExportStyle, DEFAULT_SYNCED.defaultExportStyle),
		docExportFont: oneOf(DOC_FONTS, r.docExportFont, DEFAULT_SYNCED.docExportFont),
		settingsVersion: SETTINGS_VERSION,
	};
}

/** A stored toolbar position, or null when missing/invalid (fractions are clamped to 0..1). */
export function sanitizeToolbarPos(raw: unknown): ToolbarPos | null {
	const r = asObject(raw);
	const ok = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
	if (!ok(r.x) || !ok(r.y)) return null;
	const c = (v: number) => Math.min(Math.max(v, 0), 1);
	return { x: c(r.x), y: c(r.y) };
}

/**
 * Per-device settings from local storage (`null`/garbage ⇒ platform defaults).
 *
 * Migration to version 2 (Stage F), desktop only: a stored `toolbarVisible: false` from before is
 * dropped (→ shown). Every local save wrote all keys, so `false` there is almost always the old
 * "hidden on desktop" default rather than a choice — and it hid the old drawing toolbar, not the
 * new slim Select toolbar. Hiding it again (ribbon, command, settings) is stored with version 2 and
 * sticks. Mobile values are kept as they are.
 */
export function needsLocalMigration(raw: unknown): boolean {
	const r = asObject(raw);
	return Object.keys(r).length > 0 && !(typeof r.localVersion === "number" && r.localVersion >= LOCAL_VERSION);
}

export function sanitizeLocal(raw: unknown, isMobile: boolean): LocalSettings {
	const r = asObject(raw);
	const d = defaultLocal(isMobile);
	const preStageF = needsLocalMigration(raw);
	return {
		toolbarVisible:
			typeof r.toolbarVisible === "boolean" && !(preStageF && !isMobile && !r.toolbarVisible) ? r.toolbarVisible : d.toolbarVisible,
		// Mouse drawing is a desktop-only option.
		mouseDraws: !isMobile && typeof r.mouseDraws === "boolean" ? r.mouseDraws : false,
		includeInkInPdf: bool(r.includeInkInPdf, d.includeInkInPdf),
		toolbarPos: sanitizeToolbarPos(r.toolbarPos),
		toolbarCollapsed: bool(r.toolbarCollapsed, d.toolbarCollapsed),
		toolbarEdge: oneOf(EDGES, r.toolbarEdge, d.toolbarEdge),
		penShape: oneOf(DRAW_SHAPES, r.penShape, d.penShape),
		setSquare: r.compass !== true && bool(r.setSquare, d.setSquare),
		setSquareAngle: typeof r.setSquareAngle === "number" && Number.isFinite(r.setSquareAngle)
			? ((Math.round(r.setSquareAngle) % 360) + 360) % 360 : d.setSquareAngle,
		compass: bool(r.compass, d.compass),
		compassRadius: typeof r.compassRadius === "number" && Number.isFinite(r.compassRadius)
			? Math.max(40, Math.min(160, Math.round(r.compassRadius))) : d.compassRadius,
		eraserMode: oneOf(ERASER_MODES, r.eraserMode, d.eraserMode),
		eraserSize: oneOf(ERASER_SIZES, r.eraserSize, d.eraserSize),
		eraseHighlighterOnly: bool(r.eraseHighlighterOnly, d.eraseHighlighterOnly),
		highlighterStraight: bool(r.highlighterStraight, d.highlighterStraight),
		highlighterSnapText: bool(r.highlighterSnapText, d.highlighterSnapText),
		lassoFilter: oneOf(LASSO_FILTERS, r.lassoFilter, d.lassoFilter),
		selectMode: oneOf(SELECT_MODES, r.selectMode, d.selectMode),
		penDevice: !isMobile && bool(r.penDevice, d.penDevice),
		localVersion: LOCAL_VERSION,
	};
}

/** Only the per-device keys (what goes into local storage). */
export function localOnly(s: PencilSettings): LocalSettings {
	return splitPatch(s).local as LocalSettings;
}

/** Split a settings patch into its synced and per-device parts. */
export function splitPatch(patch: Partial<PencilSettings>): {
	synced: Partial<SyncedSettings>;
	local: Partial<LocalSettings>;
} {
	const synced: Record<string, unknown> = {};
	const local: Record<string, unknown> = {};
	for (const [k, v] of Object.entries(patch)) {
		if ((LOCAL_KEYS as readonly string[]).includes(k)) local[k] = v;
		else synced[k] = v;
	}
	return { synced: synced, local: local };
}

/** Only the synced keys (what goes into data.json). */
export function syncedOnly(s: PencilSettings): SyncedSettings {
	return splitPatch(s).synced as SyncedSettings;
}

export interface StrokeParams {
	tool: Tool;
	color: string;
	size: number;
	/** Pens only. */
	style?: PenStyle;
}

/** Parameters for a new stroke drawn with `tool` under the current settings. */
export function strokeParams(s: SyncedSettings, tool: Tool): StrokeParams {
	if (tool === "highlighter") {
		return { tool, color: s.highlighterColor, size: HIGHLIGHTER_WIDTHS[s.highlighterWidth] };
	}
	const size = s.penWidths[s.penPreset];
	// Dashed is always ballpoint-rendered; the "pen feel" applies to Thin/Thick.
	const style: PenStyle = s.penPreset === "dashed" ? "dashed" : s.penFeel === "notes" ? "notes" : "ball";
	return { tool, color: s.penColor, size, style };
}

/**
 * A toolbar tool button was tapped (Stage E): the first tap on an inactive tool selects it; a tap on
 * the already-active tool opens (or closes) that tool's settings popover. (Replaces A2's "re-tap the
 * eraser to return to the previous tool".)
 */
export function toolTap(current: ActiveTool, tapped: ActiveTool): { select: ActiveTool } | { popover: ActiveTool } {
	return tapped === current ? { popover: tapped } : { select: tapped };
}

/** "Toggle eraser" (command, Pencil double-tap): current tool ↔ eraser. */
export function toggleEraser(current: ActiveTool, previous: ActiveTool | null): ActiveTool {
	if (current !== "eraser") return "eraser";
	return previous && previous !== "eraser" ? previous : "pen";
}

/** Can the eraser (under the current options) erase a stroke of this tool? */
export function erasable(tool: Tool, highlighterOnly: boolean): boolean {
	return !highlighterOnly || tool === "highlighter";
}

/** Does the lasso (under the current filter) select a stroke of this tool? */
export function lassoSelects(tool: Tool, filter: LassoFilter): boolean {
	return filter === "both" || filter === tool;
}
