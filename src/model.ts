/**
 * Pure data model for Pencil Layer: types, line hashing, anchor resolution and
 * (de)serialization of the per-note sidecar file. No Obsidian / DOM imports.
 */

export type Tool = "pen" | "highlighter";

/**
 * How a pen stroke is rendered (ignored for highlighters):
 * - "ball":   ballpoint — constant width, stroked smooth SVG centerline.
 * - "dashed": like "ball" with a fixed screen-space dash pattern (M2 Stage A2).
 * - "dotted": legacy alias (Stage A's dotted pen) — renders as "dashed".
 * - "notes":  Apple Notes-style — pressure/velocity-sensitive outline via perfect-freehand.
 * Strokes saved before M2 have no style and load as "ball".
 */
export type PenStyle = "ball" | "dashed" | "dotted" | "notes" | "pencil" | "marker" | "calligraphy";
export const PEN_STYLES: readonly PenStyle[] = ["ball", "dashed", "dotted", "notes", "pencil", "marker", "calligraphy"];

/**
 * Kind of a snapped shape (M2 Stage B "draw and hold"). Shapes are ordinary strokes whose points
 * are the densified clean outline; `shape` is informational metadata (rendering is unchanged).
 */
export type ShapeKind =
	| "line"
	| "arrow"
	| "rectangle"
	| "triangle"
	| "polygon"
	| "ellipse"
	| "circle"
	| "polyline"
	| "arc"
	| "parabola"
	| "curve";
/** Older plugin versions drop values they don't know (the stroke itself still loads and renders). */
export const SHAPE_KINDS: readonly ShapeKind[] = [
	"line",
	"arrow",
	"rectangle",
	"triangle",
	"polygon",
	"ellipse",
	"circle",
	"polyline",
	"arc",
	"parabola",
	"curve",
];

/** A point is `[x, y, pressure]`. x is relative to the left edge of `.cm-content`, y to the anchor line top. */
export type Point = [number, number, number];

export interface Anchor {
	/** 0-based line index at save time. */
	line: number;
	/** `hashLine()` of that line's text at save time. */
	hash: string;
}

/**
 * Stage C: persisted text anchor of a highlighter stroke snapped to typed text. The range starts at
 * `ch` on the stroke's anchor line (`Stroke.anchor`) and ends at `endCh` on line `endLine` (0-based,
 * as saved; resolved RELATIVE to where the anchor line resolves: end line =
 * `resolvedLine + endLine - anchor.line`). Offsets are clamped into their lines on load.
 */
export interface TextAnchor {
	ch: number;
	endLine: number;
	endCh: number;
}

/**
 * Stage H: persisted character anchor of ink drawn over typed text (see charAnchor.ts). The ink
 * follows the character at offset `ch` of line `line` (0-based, as saved; resolved RELATIVE to
 * where the stroke's line anchor resolves, like `TextAnchor.endLine`). `dx`/`dy` (px, 0.1 px
 * precision) place the stroke: its points' origin (the point (0, 0) of its local coordinates) is at
 * the character's rect top-left + (dx, dy) — in the editor (`coordsAtPos`) as in Reading view / PDF
 * (the character's client rect). Older plugin versions drop the field; the line anchor stays valid.
 */
export interface CharAnchor {
	line: number;
	ch: number;
	dx: number;
	dy: number;
}

/** A document range `[from, to)`. */
export interface TextRange {
	from: number;
	to: number;
}

export interface Stroke {
	id: string;
	tool: Tool;
	/** "ink" = theme text color (var(--text-normal)); otherwise any CSS color. */
	color: string;
	/** Stroke width in px (ballpoint: exact line width; notes/highlighter: perfect-freehand `size`). */
	size: number;
	/** Pen rendering style (pen strokes only; absent on highlighters). Missing on a pen ⇒ "ball". */
	style?: PenStyle;
	anchor: Anchor;
	points: Point[];
	/** Optional normalized stylus tilt [0..1] parallel to `points` (omitted when upright). */
	tilts?: number[];
	/** Set when the stroke was snapped to a clean shape (draw-and-hold). Absent for freehand ink. */
	shape?: ShapeKind;
	/**
	 * Stage C text highlight (highlighters only): the stroke is drawn as rounded rects over this
	 * text range instead of its `points` (which keep the originally drawn freehand path, as a
	 * fallback for other code paths and older plugin versions). See textHighlight.ts.
	 */
	text?: TextAnchor;
	/**
	 * TRANSIENT, never serialized (Stage C). Live document range of a text highlight, resolved from
	 * `anchor` + `text` and mapped through every transaction like `pos` (from: assoc 1, to: assoc -1).
	 * May become empty when the text is deleted (the highlight then renders nothing).
	 */
	textRange?: TextRange;
	/** Stage H: the ink follows this character (not on text highlights). See `CharAnchor`. */
	char?: CharAnchor;
	/**
	 * TRANSIENT, never serialized (Stage H). Live document position of the `char` character,
	 * resolved together with `pos` and mapped through every transaction (assoc +1: text typed right
	 * before the character pushes it, and the ink, along).
	 */
	charPos?: number;
	/**
	 * TRANSIENT, never serialized. Document position (start of the anchor line) maintained by the
	 * view layer while the note is open, mapped through every transaction. `undefined` means "not
	 * resolved for the current document yet" — the view should resolve it from `anchor` via
	 * `resolveAnchor`. See `InkStore` docs for the full contract.
	 */
	pos?: number;
	/**
	 * Stage K: id of the drawing space (`InkFile.spaces`) this ink belongs to. Its points are then
	 * relative to (content left, that space's top), so the ink moves rigidly with the space.
	 * `anchor` still names a line (the space's anchor line, or the last line for spaces at the end):
	 * the fallback for older plugin versions and for a space that no longer exists.
	 */
	space?: string;
}

/**
 * Stage K: a protected drawing space, stored in the sidecar (the markdown is never modified). It is
 * shown as an empty block `height` px tall right after its line — exactly: after the last line of the
 * block holding `after` (see spaces.ts `blockEnds`) — or after the note's last line ("end"). Ink
 * drawn in it (`Stroke.space`) is relative to its top and moves with it rigidly.
 */
export interface InkSpace {
	id: string;
	after: Anchor | "end";
	/** Height in px (editor px; the same in Reading view and the PDF). */
	height: number;
	/** A fixed page created in A4 mode. */
	a4?: true;
	/** TRANSIENT, never serialized: live start position of the `after` line (like `Stroke.pos`). */
	pos?: number;
}

/**
 * In-memory ink of one note. `version` is informational in memory (the loader detects the point
 * encoding per stroke); `serializeInkFile` always writes `INK_VERSION`.
 */
export interface InkFile {
	version: 1 | 2;
	/** Width of `.cm-content` when strokes were drawn. Recorded for later scaling (unused in M1). */
	contentWidth: number;
	strokes: Stroke[];
	/** Stage K: drawing spaces, in order (spaces after the same line show in this order). */
	spaces?: InkSpace[];
}

/** Nothing worth a sidecar (no strokes, no spaces). */
export function isEmptyInk(ink: InkFile): boolean {
	return ink.strokes.length === 0 && (ink.spaces?.length ?? 0) === 0;
}

/** Stage K: smallest space height (px). */
export const SPACE_MIN_HEIGHT = 48;
/** Stage K: room kept below the lowest ink of a space (px): a space is never smaller than its ink + this. */
export const SPACE_INK_PAD = 8;
/** Stage K: largest space height accepted from a file (px). */
export const SPACE_MAX_HEIGHT = 50000;

/** Stage K: the smallest height a space may have with ink reaching `inkBottom` px below its top. */
export function spaceMinHeight(inkBottom: number): number {
	const b = Number.isFinite(inkBottom) ? inkBottom : 0;
	return Math.min(SPACE_MAX_HEIGHT, Math.max(SPACE_MIN_HEIGHT, Math.ceil(b + SPACE_INK_PAD)));
}

/**
 * Stage K: height of a converted Stage J blank page: one printable page in editor px, at the note's
 * editor column (`contentWidth`, else 700) and the default export page (Letter, 1 cm margins) —
 * Stage J's `sheetGeometry(...).contentH` (print padding 32 px per side).
 */
export function legacyPageHeight(contentWidth: number): number {
	const col = contentWidth > 50 ? contentWidth : 700;
	const margin = 37.8; // 1 cm in CSS px
	const scale = (816 - 2 * margin) / (col + 64);
	return Math.round((1056 - 2 * margin) / scale);
}

/** File format written to disk. v1: `points: [x,y,p][]`. v2 (Stage G): compact `xy` / `p` integer deltas. */
export const INK_VERSION = 2 as const;

/** Coordinate quantum of the v2 encoding: integers are tenths of a px (max error 0.05 px). */
export const XY_SCALE = 10;
/** Pressure quantum of the v2 encoding: integers are hundredths (max error 0.005). */
export const P_SCALE = 100;
/** Pressure implied for points stored without a pressure channel. */
export const DEFAULT_PRESSURE = 0.5;

/** Max distance (in lines) `resolveAnchor` searches for a moved line. */
export const ANCHOR_SEARCH_RADIUS = 200;

/** Fallback widths (px) for strokes saved without a valid size. */
export const DEFAULT_PEN_SIZE = 1.6;
export const DEFAULT_HIGHLIGHTER_SIZE = 12;

/** Effective rendering style of a stroke ("ball" for pens without one); undefined for highlighters. */
export function penStyleOf(s: Pick<Stroke, "tool" | "style">): PenStyle | undefined {
	if (s.tool !== "pen") return undefined;
	return s.style && PEN_STYLES.includes(s.style) ? s.style : "ball";
}

export function emptyInk(): InkFile {
	return { version: INK_VERSION, contentWidth: 0, strokes: [], spaces: [] };
}

/**
 * Short stable hash of a line's text (FNV-1a 32-bit, base36). Leading/trailing whitespace is
 * ignored so re-indenting or trailing spaces don't orphan a drawing.
 */
export function hashLine(text: string): string {
	const s = text.trim();
	let h = 0x811c9dc5;
	for (let i = 0; i < s.length; i++) {
		h ^= s.charCodeAt(i);
		h = Math.imul(h, 0x01000193);
	}
	return (h >>> 0).toString(36);
}

/** Hash of an empty/whitespace-only line. Such hashes are never used for searching. */
export const BLANK_HASH = hashLine("");

let idCounter = 0;
/** Short unique-enough id: time + random + counter, base36. */
export function newId(): string {
	idCounter = (idCounter + 1) % 1296;
	return (
		Date.now().toString(36) +
		Math.floor(Math.random() * 0x7fffffff).toString(36).padStart(6, "0").slice(0, 6) +
		idCounter.toString(36).padStart(2, "0")
	);
}

/**
 * Line access for `resolveAnchor`. Either an array of line texts, or an accessor
 * (e.g. for CM6: `{ count: doc.lines, get: (i) => doc.line(i + 1).text }` — note CM6 lines are 1-based).
 */
export type LineSource = readonly string[] | { count: number; get(i: number): string };

function lineCount(src: LineSource): number {
	return Array.isArray(src) ? src.length : (src as { count: number }).count;
}

function lineAt(src: LineSource, i: number): string {
	return Array.isArray(src) ? (src as readonly string[])[i] : (src as { get(i: number): string }).get(i);
}

/**
 * Resolve a saved anchor to a 0-based line index in the current document.
 * 1. If `anchor.line` exists and its hash matches → that line.
 * 2. Else search outward (nearest first, below before above on ties) up to ±ANCHOR_SEARCH_RADIUS
 *    lines for a line whose hash matches. Blank lines never match during the search
 *    (and a blank anchor hash skips the search entirely).
 * 3. Else clamp `anchor.line` into the document.
 * Returns 0 for an empty document.
 */
export function resolveAnchor(src: LineSource, anchor: Anchor, radius = ANCHOR_SEARCH_RADIUS): number {
	const n = lineCount(src);
	if (n <= 0) return 0;
	const line = Number.isFinite(anchor.line) ? Math.floor(anchor.line) : 0;
	const clamped = Math.min(Math.max(line, 0), n - 1);

	if (line >= 0 && line < n && hashLine(lineAt(src, line)) === anchor.hash) return line;
	if (anchor.hash === BLANK_HASH) return clamped;

	const matches = (i: number): boolean => {
		const text = lineAt(src, i);
		return text.trim() !== "" && hashLine(text) === anchor.hash;
	};
	for (let d = 1; d <= radius; d++) {
		const below = line + d;
		const above = line - d;
		if (below >= n && above < 0) break;
		if (below >= 0 && below < n && matches(below)) return below;
		if (above >= 0 && above < n && matches(above)) return above;
	}
	return clamped;
}

// ---------------------------------------------------------------------------------------------
// Serialization
// ---------------------------------------------------------------------------------------------

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const round = (v: number, digits: number): number => {
	const f = 10 ** digits;
	return Math.round(v * f) / f;
};

const clamp01 = (v: number): number => Math.min(Math.max(v, 0), 1);
/** Integer quantization; `+ 0` normalizes -0 so equal inputs always give identical JSON. */
const quant = (v: number, scale: number): number => Math.round(v * scale) + 0;

/** v1 point `[x, y, p?]`. */
function parsePoint(raw: unknown): Point | null {
	if (!Array.isArray(raw) || raw.length < 2) return null;
	const [x, y, p] = raw as unknown[];
	if (!isNum(x) || !isNum(y)) return null;
	const pressure = isNum(p) ? clamp01(p) : DEFAULT_PRESSURE;
	return [x, y, pressure];
}

/**
 * Decode v2 points: `xy` = flat integer tenths of a px, first point absolute then per-point deltas
 * (`[x0, y0, dx1, dy1, ...]`); optional `p` = pressure in hundredths, first absolute then deltas.
 * Repairs: decoding stops at the first non-numeric coordinate (later deltas would be meaningless),
 * an odd trailing value is ignored, and from the first invalid/missing pressure on, p = 0.5.
 */
function decodeXY(xy: readonly unknown[], pr: unknown): Point[] {
	const ps = Array.isArray(pr) ? (pr as unknown[]) : null;
	const out: Point[] = [];
	let x = 0;
	let y = 0;
	let p = 0;
	let pOk = ps !== null;
	for (let i = 0; i + 1 < xy.length; i += 2) {
		const dx = xy[i];
		const dy = xy[i + 1];
		if (!isNum(dx) || !isNum(dy)) break;
		x += Math.round(dx);
		y += Math.round(dy);
		const k = i / 2;
		if (pOk && isNum(ps![k])) p += Math.round(ps![k]);
		else pOk = false;
		out.push([x / XY_SCALE, y / XY_SCALE, pOk ? clamp01(p / P_SCALE) : DEFAULT_PRESSURE]);
	}
	return out;
}

/** Decode a delta-encoded hundredths channel (such as tilt `t`), aligned to `count` points. */
function decodeChannel(raw: unknown, count: number, fallback: number): number[] | null {
	if (!Array.isArray(raw) || raw.length === 0 || count <= 0) return null;
	const out: number[] = [];
	let acc = 0;
	let ok = true;
	let anyPositive = false;
	for (let i = 0; i < count; i++) {
		if (ok && isNum(raw[i])) {
			acc += Math.round(raw[i] as number);
			const v = clamp01(acc / P_SCALE);
			if (v > 0) anyPositive = true;
			out.push(v);
		} else {
			ok = false;
			out.push(fallback);
		}
	}
	return anyPositive ? out : null;
}

const isIndex = (v: unknown): v is number => isNum(v) && v >= 0 && Math.floor(v) === v;

/** A valid Stage C text anchor, or null (the stroke then loads as a freehand highlighter). */
function parseTextAnchor(raw: unknown, line: number): TextAnchor | null {
	if (!raw || typeof raw !== "object") return null;
	const t = raw as Record<string, unknown>;
	if (!isIndex(t.ch) || !isIndex(t.endLine) || !isIndex(t.endCh)) return null;
	// An empty range is valid: its text was deleted (it renders nothing, but must not turn freehand).
	if (t.endLine < line || (t.endLine === line && t.endCh < t.ch)) return null;
	return { ch: t.ch, endLine: t.endLine, endCh: t.endCh };
}

/** A valid Stage H character anchor (offsets rounded to 0.1 px), or null (the stroke stays line-anchored). */
function parseCharAnchor(raw: unknown): CharAnchor | null {
	if (!raw || typeof raw !== "object") return null;
	const c = raw as Record<string, unknown>;
	if (!isIndex(c.line) || !isIndex(c.ch) || !isNum(c.dx) || !isNum(c.dy)) return null;
	return { line: c.line, ch: c.ch, dx: round(c.dx, 1) + 0, dy: round(c.dy, 1) + 0 };
}

/** Validate/repair one stroke (v1 `points` or v2 `xy`/`p`, detected per stroke). Returns null if unrecoverable (e.g. no valid points). */
export function parseStroke(raw: unknown): Stroke | null {
	if (!raw || typeof raw !== "object") return null;
	const r = raw as Record<string, unknown>;
	let points: Point[] = [];
	if (Array.isArray(r.xy)) {
		points = decodeXY(r.xy, r.p);
	} else if (Array.isArray(r.points)) {
		for (const p of r.points) {
			const pt = parsePoint(p);
			if (pt) points.push(pt);
		}
	}
	if (points.length === 0) return null;

	const tool: Tool = r.tool === "highlighter" ? "highlighter" : "pen";
	const a = (r.anchor && typeof r.anchor === "object" ? r.anchor : {}) as Record<string, unknown>;
	const anchor: Anchor = {
		line: isNum(a.line) && a.line >= 0 ? Math.floor(a.line) : 0,
		hash: typeof a.hash === "string" ? a.hash : "",
	};
	const stroke: Stroke = {
		id: typeof r.id === "string" && r.id ? r.id : newId(),
		tool,
		color: typeof r.color === "string" && r.color ? r.color : "ink",
		size: isNum(r.size) && r.size > 0 ? r.size : tool === "highlighter" ? DEFAULT_HIGHLIGHTER_SIZE : DEFAULT_PEN_SIZE,
		anchor,
		points,
	};
	// Pre-M2 strokes (and unknown styles from newer versions) render as ballpoint.
	if (tool === "pen") stroke.style = PEN_STYLES.includes(r.style as PenStyle) ? (r.style as PenStyle) : "ball";
	if (SHAPE_KINDS.includes(r.shape as ShapeKind)) stroke.shape = r.shape as ShapeKind;
	const tilts = !stroke.shape ? decodeChannel(r.t, points.length, 0) : null;
	if (tilts) stroke.tilts = tilts;
	if (tool === "highlighter") {
		const text = parseTextAnchor(r.text, anchor.line);
		if (text) stroke.text = text;
	}
	// A text highlight is placed by its text range; a character anchor would be meaningless.
	if (!stroke.text) {
		const char = parseCharAnchor(r.char);
		if (char) stroke.char = char;
	}
	// Stage K: ink in a drawing space (an id the file doesn't have falls back to the line anchor).
	if (typeof r.space === "string" && r.space) stroke.space = r.space;
	return stroke;
}

function parseAnchor(raw: unknown): Anchor | null {
	if (!raw || typeof raw !== "object") return null;
	const a = raw as Record<string, unknown>;
	if (!isIndex(a.line) || typeof a.hash !== "string") return null;
	return { line: a.line, hash: a.hash };
}

/** Stage K: a valid space entry, or null (height clamped into [SPACE_MIN_HEIGHT, SPACE_MAX_HEIGHT], whole px). */
export function parseSpace(raw: unknown): InkSpace | null {
	if (!raw || typeof raw !== "object") return null;
	const r = raw as Record<string, unknown>;
	if (typeof r.id !== "string" || !r.id || !isNum(r.height)) return null;
	const height = Math.min(SPACE_MAX_HEIGHT, Math.max(SPACE_MIN_HEIGHT, Math.ceil(r.height)));
	const a4 = r.a4 === true ? { a4: true as const } : {};
	if (r.after === "end") return { id: r.id, after: "end", height, ...a4 };
	const after = parseAnchor(r.after);
	return after ? { id: r.id, after, height, ...a4 } : null;
}

/** A Stage J page entry (legacy: converted to a space on load), or null. */
function parseLegacyPage(raw: unknown): { id: string; after: Anchor | "end" } | null {
	if (!raw || typeof raw !== "object") return null;
	const r = raw as Record<string, unknown>;
	if (typeof r.id !== "string" || !r.id) return null;
	if (r.after === "end") return { id: r.id, after: "end" };
	const after = parseAnchor(r.after);
	return after ? { id: r.id, after } : null;
}

/** Filled in by `parseInkFile` when data had to be discarded. */
export interface ParseReport {
	/** JSON unparseable, not an object, or `strokes` not an array. */
	malformed: boolean;
	/** Number of strokes dropped as unrecoverable. */
	dropped: number;
}

/**
 * Parse sidecar JSON. Never throws: malformed JSON or structure yields an empty (or partially
 * repaired) InkFile. Invalid strokes are dropped; duplicate ids are re-generated. Pass `report`
 * to learn whether anything was discarded (the store backs such files up before overwriting).
 */
export function parseInkFile(text: string | null | undefined, report?: ParseReport): InkFile {
	if (report) {
		report.malformed = false;
		report.dropped = 0;
	}
	const bad = (): InkFile => {
		if (report) report.malformed = true;
		return emptyInk();
	};
	if (!text) return emptyInk();
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch {
		return bad();
	}
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return bad();
	const r = raw as Record<string, unknown>;
	const ink = emptyInk();
	if (isNum(r.contentWidth) && r.contentWidth > 0) ink.contentWidth = r.contentWidth;
	if (!Array.isArray(r.strokes)) {
		if (report) report.malformed = true;
		return ink;
	}
	// Stage K: drawing spaces (older plugin versions ignore the key). Invalid or duplicate entries
	// are dropped.
	const spaceIds = new Set<string>();
	if (Array.isArray(r.spaces)) {
		for (const raw of r.spaces) {
			const sp = parseSpace(raw);
			if (!sp || spaceIds.has(sp.id)) continue;
			spaceIds.add(sp.id);
			ink.spaces!.push(sp);
		}
	}
	// Stage J files: blank / added pages become spaces one printable page tall (same id and anchor;
	// their ink keeps its page-relative points, now space-relative). Manual page breaks are dropped.
	const pageToSpace = new Map<string, string>();
	if (Array.isArray(r.pages)) {
		const h = legacyPageHeight(ink.contentWidth);
		for (const raw of r.pages) {
			const pg = parseLegacyPage(raw);
			if (!pg || pageToSpace.has(pg.id)) continue;
			let id = pg.id;
			while (spaceIds.has(id)) id = newId();
			spaceIds.add(id);
			pageToSpace.set(pg.id, id);
			ink.spaces!.push({ id, after: pg.after, height: h });
		}
	}
	const seen = new Set<string>();
	r.strokes.forEach((raw: unknown) => {
		const stroke = parseStroke(raw);
		if (!stroke) {
			if (report) report.dropped++;
			return;
		}
		// Stage J ink on a (known) blank page → ink in the space that page became.
		const page = raw && typeof raw === "object" ? (raw as Record<string, unknown>).page : undefined;
		if (!stroke.space && typeof page === "string" && pageToSpace.has(page)) stroke.space = pageToSpace.get(page);
		while (seen.has(stroke.id)) stroke.id = newId();
		seen.add(stroke.id);
		ink.strokes.push(stroke);
	});
	// A space is never smaller than its ink (repairs files edited elsewhere; sizes converted pages).
	fitSpacesToInk(ink);
	return ink;
}

/** Disk (v2) form of one stroke. See `serializeStroke`. */
export interface DiskStroke {
	id: string;
	tool: Tool;
	color: string;
	size: number;
	style?: PenStyle;
	anchor: Anchor;
	/** Flat integer tenths of a px: `[x0, y0, dx1, dy1, ...]` (first point absolute, then deltas). */
	xy: number[];
	/** Pressure in hundredths, first absolute then deltas. Only on notes-style freehand strokes with real pressure. */
	p?: number[];
	/** Stylus tilt in hundredths [0..100], first absolute then deltas. Omitted when upright. */
	t?: number[];
	shape?: ShapeKind;
	/** Stage C text highlight anchor (highlighters only). */
	text?: TextAnchor;
	/** Stage H character anchor (never together with `text`). */
	char?: CharAnchor;
	/** Stage K: id of the drawing space the ink belongs to (last key). */
	space?: string;
}

/** Disk (v2) form of a whole sidecar. */
export interface DiskInkFile {
	version: typeof INK_VERSION;
	contentWidth: number;
	strokes: DiskStroke[];
	/** Stage K, only written when non-empty. */
	spaces?: Pick<InkSpace, "id" | "after" | "height" | "a4">[];
}

/**
 * Whether a stroke's pressure is worth storing: only notes-style freehand pens render pressure
 * (ballpoint/dashed/highlighter ignore it; shapes are constant 0.5), and a notes stroke whose
 * pressure is uniformly 0.5 (mouse input) reloads identically without it.
 */
function keepsPressure(s: Stroke): boolean {
	const style = penStyleOf(s);
	if ((style !== "notes" && style !== "pencil" && style !== "calligraphy") || s.shape) return false;
	const def = quant(DEFAULT_PRESSURE, P_SCALE);
	return s.points.some((p) => quant(clamp01(p[2]), P_SCALE) !== def);
}

function keepsTilt(s: Stroke): boolean {
	if (s.shape || !s.tilts || s.tilts.length === 0) return false;
	return s.tilts.some((v) => quant(clamp01(v), P_SCALE) > 0);
}

/** Delta-encode quantized values (`out[0]` absolute, then differences of the QUANTIZED values: no drift). */
function pushDeltas(out: number[], q: number, prev: number): number {
	out.push(q - prev);
	return q;
}

/** Serialize for disk (always v2). Drops transient fields (`pos`, `textRange`, `charPos`) and quantizes points. */
export function serializeInkFile(ink: InkFile): string {
	const out: DiskInkFile = {
		version: INK_VERSION,
		contentWidth: round(ink.contentWidth || 0, 2),
		strokes: ink.strokes.map(serializeStroke),
	};
	if (ink.spaces && ink.spaces.length > 0) {
		out.spaces = ink.spaces.map((p) => ({
			id: p.id,
			after: p.after === "end" ? "end" : { line: p.after.line, hash: p.after.hash },
			height: Math.ceil(p.height),
			...(p.a4 ? { a4: true as const } : {}),
		}));
	}
	return JSON.stringify(out);
}

/**
 * Disk (v2) form of one stroke: fixed key order; `style` only on pens; `p` only when
 * `keepsPressure`; `shape` only on shapes; transient fields dropped. Points are quantized to
 * 0.1 px and delta-encoded into `xy` (pressure: 0.01, into `p`). Pure; the input is not mutated.
 */
export function serializeStroke(s: Stroke): DiskStroke {
	const style = penStyleOf(s);
	const xy: number[] = [];
	let px = 0;
	let py = 0;
	for (const pt of s.points) {
		px = pushDeltas(xy, quant(pt[0], XY_SCALE), px);
		py = pushDeltas(xy, quant(pt[1], XY_SCALE), py);
	}
	let p: number[] | undefined;
	if (keepsPressure(s)) {
		p = [];
		let pp = 0;
		for (const pt of s.points) pp = pushDeltas(p, quant(clamp01(pt[2]), P_SCALE), pp);
	}
	let t: number[] | undefined;
	if (keepsTilt(s)) {
		t = [];
		let ptAcc = 0;
		for (let i = 0; i < s.points.length; i++) {
			const v = s.tilts?.[i] ?? 0;
			ptAcc = pushDeltas(t, quant(clamp01(v), P_SCALE), ptAcc);
		}
	}
	return {
		id: s.id,
		tool: s.tool,
		color: s.color,
		size: s.size,
		...(style ? { style } : {}),
		anchor: { line: s.anchor.line, hash: s.anchor.hash },
		xy,
		...(p ? { p } : {}),
		...(t ? { t } : {}),
		...(s.shape ? { shape: s.shape } : {}),
		...(s.text && s.tool === "highlighter" ? { text: { ch: s.text.ch, endLine: s.text.endLine, endCh: s.text.endCh } } : {}),
		...(s.char && !(s.text && s.tool === "highlighter")
			? { char: { line: s.char.line, ch: s.char.ch, dx: round(s.char.dx, 1) + 0, dy: round(s.char.dy, 1) + 0 } }
			: {}),
		...(s.space ? { space: s.space } : {}),
	};
}

// ---------------------------------------------------------------------------------------------
// Merging (live sync)
// ---------------------------------------------------------------------------------------------

/**
 * Content identity of a stroke for merging: everything but the (re-derivable) anchor — including a
 * text highlight's `text` offsets, which shift as the text is edited (only "is a text highlight"
 * counts) and a Stage H character anchor's `line`/`ch` (only its presence and offsets count) — compared in
 * the quantized disk encoding — so a full-precision in-memory stroke equals its own reloaded copy.
 */
function strokeKey(s: Stroke): string {
	const d = serializeStroke(s);
	// Stage H: a character anchor's `line`/`ch` move with text edits (like the anchor) and don't
	// count; whether there is one and its offsets do (a device without Stage H drops it).
	const char = d.char ? [d.char.dx, d.char.dy] : null;
	return JSON.stringify([d.tool, d.color, d.size, d.style ?? null, d.shape ?? null, d.xy, d.p ?? null, d.t ?? null, d.text ? 1 : 0, char, d.space ?? null]);
}

/**
 * Three-way merge of stroke lists by id, used when the sidecar changed on disk (e.g. Obsidian Sync
 * delivered another device's edits) while the note is loaded here.
 *  - `base`:   strokes as last saved/loaded by this device (what both sides started from)
 *  - `local`:  strokes in memory now (may include unsaved changes)
 *  - `remote`: strokes now on disk
 * Rules: a stroke deleted locally since `base` stays deleted; a stroke added locally is kept;
 * remote additions are added; remote deletions apply unless the stroke is a local addition.
 * Order: remote order first, then local-only additions in local order (so with no local changes
 * the result equals `remote`). When a stroke exists on both sides with identical content, the
 * LOCAL object is reused (keeps its live `pos`, render cache and undo identity); if its content
 * differs, the remote version wins.
 */
export function mergeStrokes(base: readonly Stroke[], local: readonly Stroke[], remote: readonly Stroke[]): Stroke[] {
	return mergeById(base, local, remote, (l, r) => strokeKey(l) === strokeKey(r));
}

/**
 * Stage K: three-way merge of spaces. By id like strokes; for a space on both sides the height is
 * merged field-wise (`mergedHeight`: the side that changed it since `base` wins, remote if both did),
 * so a local unsaved resize survives a remote edit elsewhere. A space's anchor moves with text edits
 * and doesn't count; a switch between "end" and a line anchor takes the remote version. The local
 * object is kept (with the merged height) unless the remote one wins.
 */
export function mergeSpaces(base: readonly InkSpace[], local: readonly InkSpace[], remote: readonly InkSpace[]): InkSpace[] {
	const baseById = new Map(base.map((s) => [s.id, s] as const));
	const localById = new Map(local.map((s) => [s.id, s] as const));
	const remoteById = new Map(remote.map((s) => [s.id, s] as const));
	const merged = mergeById(base, local, remote, (l, r) => (l.after === "end") === (r.after === "end"));
	for (const s of merged) {
		const l = localById.get(s.id);
		const r = remoteById.get(s.id);
		if (!l || !r) continue;
		const fixed = l.a4 ? l : r.a4 ? r : null;
		if (fixed) {
			s.a4 = true;
			s.height = fixed.height;
			continue;
		}
		const h = mergedHeight(baseById.get(s.id)?.height, l.height, r.height);
		s.height = h;
	}
	return merged;
}

/** Field-wise three-way merge of one value: the side that changed it wins (remote if both did). */
export function mergedHeight(base: number | undefined, local: number, remote: number): number {
	if (base === undefined) return remote;
	if (local !== base && remote === base) return local;
	return remote;
}

/** Stage K: lowest ink (px below the space top, incl. half the pen width) per space id. */
export function spaceInkBottoms(strokes: readonly Stroke[]): Map<string, number> {
	const bottom = new Map<string, number>();
	for (const s of strokes) {
		if (!s.space || s.points.length === 0) continue;
		let b = -Infinity;
		for (const p of s.points) if (p[1] > b) b = p[1];
		b += s.size / 2;
		bottom.set(s.space, Math.max(bottom.get(s.space) ?? -Infinity, b));
	}
	return bottom;
}

/** Stage K: grow every space so it holds its ink (`spaceMinHeight` of its lowest stroke). */
export function fitSpacesToInk(ink: InkFile): void {
	if (!ink.spaces || ink.spaces.length === 0) return;
	const bottom = spaceInkBottoms(ink.strokes);
	for (const sp of ink.spaces) {
		const b = bottom.get(sp.id);
		if (!sp.a4 && b !== undefined) sp.height = Math.max(sp.height, spaceMinHeight(b));
	}
}

/** Generic three-way merge by id (rules: see `mergeStrokes`); `same(local, remote)` keeps the local object. */
export function mergeById<T extends { id: string }>(base: readonly T[], local: readonly T[], remote: readonly T[], same: (l: T, r: T) => boolean): T[] {
	const baseIds = new Set(base.map((s) => s.id));
	const localById = new Map(local.map((s) => [s.id, s] as const));
	const remoteIds = new Set(remote.map((s) => s.id));
	const out: T[] = [];
	for (const r of remote) {
		const l = localById.get(r.id);
		if (!l) {
			if (baseIds.has(r.id)) continue; // deleted locally since last save
			out.push(r); // remote addition
			continue;
		}
		out.push(same(l, r) ? l : r);
	}
	for (const l of local) {
		if (remoteIds.has(l.id)) continue;
		if (baseIds.has(l.id)) continue; // deleted remotely
		out.push(l); // local addition not yet on disk
	}
	return out;
}
