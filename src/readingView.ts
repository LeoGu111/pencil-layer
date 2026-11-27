/**
 * Stage D — ink in Reading view and in Obsidian's PDF export (`registerMarkdownPostProcessor`).
 *
 * Reading view: the post-processor is called once per rendered section (paragraph, list, heading
 * …) with `ctx.getSectionInfo(el)` = {text, lineStart, lineEnd}. Each section gets its own
 * absolutely positioned, `overflow: visible` SVG (so ink overflowing the block is never clipped)
 * drawing the strokes of the lines it owns, at y positions mapped from the editor layout to the
 * rendered one (see readingMap.ts). Sections are re-laid out when they resize (ResizeObserver:
 * images loading, width changes, attach after virtualization), when another section of the note is
 * (re-)rendered (line numbers shift), when the note's ink changes (drawing in another pane, undo,
 * live sync) and when settings change ("Show ink").
 *
 * PDF export (desktop: a hidden popout window; mobile: a `.print` div in the main document) renders
 * the whole note into ONE container and runs the post-processors once on it with
 * `getSectionInfo: () => null`. We return a promise (the export awaits it), wait for embeds and
 * images, then match the container's top-level blocks to the note's sections from the metadata
 * cache (`alignBlocks`) and draw each block's ink like a Reading view section. Skipped entirely when
 * "Include ink in PDF export" is off on this device. The DOM may live in another window: always
 * use `el.ownerDocument` / `el.win`, never the globals.
 *
 * Stage K: drawing spaces are in-flow blocks of exactly their height (`.pl-reading-space`) with
 * their ink, placed where the editor shows them (after the block holding their line; see
 * spaces.ts). In print they don't break inside unless taller than a page. They print with or
 * without ink (the layout must not change).
 */
import { App, MarkdownPostProcessorContext, MarkdownRenderChild, MarkdownView, Plugin, TFile } from "obsidian";
import { dashArray, isCenterline, strokeToPath, bbox } from "./geometry";
import { InkFile, Stroke, isEmptyInk, resolveAnchor } from "./model";
import type { PencilSettings } from "./settings";
import { InkTarget, PAPER_INK, inkColor } from "./inkColor"; // [Stage L]
import type { InkStore } from "./store";
import { Row, mergeRows, rowsPath } from "./textHighlight";
import { charNeedle, charOrigin } from "./charAnchor";
import type { ExportOptions } from "./exportOnce";
import { DOC_FONT_VAR, DOC_STYLE_CLASS, ExportStyle, docFontStack, inkYScale, scaleInkY } from "./docStyle";
import { pageGuidePrintConfig } from "./pageGuides";
import { Band, Pager, inSlice, padExtents, planSlices } from "./printSlices";
import {
	LineMark,
	LineRange,
	PRINT_PAGE_CLEARANCE,
	alignBlocks,
	countOccurrences,
	elementKind,
	findNth,
	lineTop,
	listItemLines,
	normalizeWithMap,
	normalizeWs,
	ownedRange,
	printAreaHeight,
	printAreaWidth,
	rangePieces,
	reserveSpace,
	sectionKind,
	stripInline,
	tableRowLines,
	BlockKind,
} from "./readingMap";

/** A printed block matched to a section of the note. */
interface Host {
	el: HTMLElement;
	lineStart: number;
	lineEnd: number;
	kind: BlockKind;
}


export interface ReadingHost {
	app: App;
	store: InkStore;
	getSettings(): PencilSettings;
	updateSettings(patch: Partial<PencilSettings>): void;
	/**
	 * [Stage H] A print run starts: include ink, and in which style? (one-shot export override, else
	 * the "Include ink in PDF export" toggle / "Default export style"; consumes the override.)
	 */
	printOptions(): ExportOptions;
}

const SVG_NS = "http://www.w3.org/2000/svg";
/** "ink" color in the PDF (always printed on white). [Stage L] see inkColor.ts. */
export const PRINT_INK = PAPER_INK;
const HL_OPACITY = "0.35";
const SVG_CLASS = "pl-reading-ink";
/** Set on a section whose bottom margin we enlarged (room for ink in collapsed blank lines). */
const GAP_ATTR = "data-pl-gap";
const HOST_CLASS = "pl-reading-host";
/** [Stage I] Spacer inside the note's last section: room for ink below the end of the note. */
const ROOM_CLASS = "pl-reading-room";
const ROOM_SLICE_CLASS = "pl-reading-room-slice";
/** Legacy space block class (cleaned up if present on re-render). */
const SPACE_CLASS = "pl-reading-space";

interface Section {
	el: HTMLElement;
	path: string;
	ctx: MarkdownPostProcessorContext;
	ro: ResizeObserver | null;
	child: MarkdownRenderChild;
}

interface Layout {
	lines: readonly string[];
	lineStart: number;
	lineEnd: number;
	range: LineRange;
	print: boolean;
	/**
	 * Document-style print: line height of the text / the editor's. Ink offsets from the text it
	 * hangs off (character or line) scale by it; the strokes themselves don't (docStyle.ts).
	 */
	yScale?: number;
	/** Printable sheet height in px during PDF export (for clean multi-page slicing). */
	pageHeight?: number;
	/** Viewport Y of the print root's top edge (page 1 start) for page-offset slicing. */
	printTop?: number;
	/** Optional per-render deduplication set so a stroke is never painted twice across sections. */
	drawnIds?: Set<string>;
}

// ---------------------------------------------------------------------------------------------
// Caches
// ---------------------------------------------------------------------------------------------

const pathCache = new WeakMap<Stroke, string>();
function pathOf(s: Stroke): string {
	let d = pathCache.get(s);
	if (d === undefined) {
		d = strokeToPath(s);
		pathCache.set(s, d);
	}
	return d;
}

const bottomCache = new WeakMap<Stroke, number>();
/** Lowest y of a stroke relative to its anchor line top (incl. half its width). */
function strokeBottom(s: Stroke): number {
	let b = bottomCache.get(s);
	if (b === undefined) {
		b = (bbox(s.points)?.maxY ?? 0) + s.size / 2;
		bottomCache.set(s, b);
	}
	return b;
}

const topCache = new WeakMap<Stroke, number>();
/** Highest y of a stroke relative to its anchor line top (incl. half its width). */
function strokeTop(s: Stroke): number {
	let t = topCache.get(s);
	if (t === undefined) {
		t = (bbox(s.points)?.minY ?? 0) - s.size / 2;
		topCache.set(s, t);
	}
	return t;
}

const centerCache = new WeakMap<Stroke, number>();
/** Vertical center of a stroke's points (relative to its anchor line top). */
function strokeCenterY(s: Stroke): number {
	let c = centerCache.get(s);
	if (c === undefined) {
		const b = bbox(s.points);
		c = b ? (b.minY + b.maxY) / 2 : 0;
		centerCache.set(s, c);
	}
	return c;
}

let linesMemo: { text: string; lines: string[] } | null = null;
function splitLines(text: string): string[] {
	if (linesMemo && linesMemo.text === text) return linesMemo.lines;
	const lines = text.split(/\r?\n/);
	linesMemo = { text, lines };
	return lines;
}

/** Resolved anchor line per stroke, for the last document text it was resolved against. */
const resolved = new WeakMap<Stroke, { lines: readonly string[]; line: number }>();
function resolveLine(s: Stroke, lines: readonly string[]): number {
	const c = resolved.get(s);
	if (c && c.lines === lines) return c.line;
	const line = resolveAnchor(lines, s.anchor);
	resolved.set(s, { lines, line });
	return line;
}

// ---------------------------------------------------------------------------------------------
// DOM helpers
// ---------------------------------------------------------------------------------------------

function isOurs(n: Element): boolean {
	return n.classList.contains(SVG_CLASS) || n.classList.contains(ROOM_CLASS) || n.classList.contains(SPACE_CLASS);
}

/** Remove a section's legacy space blocks if any exist. */
function removeSpaces(el: HTMLElement): void {
	for (const c of Array.from(el.querySelectorAll(`.${SPACE_CLASS}`))) c.remove();
}

function lineHeightOf(el: HTMLElement): number {
	const cs = el.ownerDocument.defaultView?.getComputedStyle(el);
	if (!cs) return 24;
	const lh = parseFloat(cs.lineHeight);
	if (Number.isFinite(lh) && lh > 0) return lh;
	const fs = parseFloat(cs.fontSize);
	return Number.isFinite(fs) && fs > 0 ? fs * 1.5 : 24;
}

function elementScale(el: HTMLElement, rect: DOMRect): [number, number] {
	const ow = el.offsetWidth;
	const oh = el.offsetHeight;
	let sx = ow > 0 && rect.width > 0 ? rect.width / ow : 1;
	let sy = oh > 0 && rect.height > 0 ? rect.height / oh : 1;
	if (!Number.isFinite(sx) || Math.abs(sx - 1) <= 0.005) sx = 1;
	if (!Number.isFinite(sy) || Math.abs(sy - 1) <= 0.005) sy = 1;
	return [sx, sy];
}

/** Bottom of the section's own content (our SVG excluded), relative to `top`. */
function contentBottom(el: HTMLElement, top: number, sy = 1): number {
	let bottom = 0;
	let any = false;
	for (const c of Array.from(el.children)) {
		if (isOurs(c)) continue;
		const r = c.getBoundingClientRect();
		if (r.width === 0 && r.height === 0) continue;
		bottom = Math.max(bottom, (r.bottom - top) / sy);
		any = true;
	}
	return any ? bottom : el.getBoundingClientRect().height / sy;
}

/** Top of the first rendered content after a `<br>` (= the next source line's top). */
function topAfter(node: Node): number | null {
	const doc = node.ownerDocument;
	if (!doc) return null;
	for (let n: Node | null = node.nextSibling; n; n = n.nextSibling) {
		if (n.nodeType === 3) {
			if (!n.textContent || n.textContent.trim() === "") continue;
			const range = doc.createRange();
			range.selectNodeContents(n);
			const r = Array.from(range.getClientRects()).find((q) => q.height > 0);
			if (r) return r.top;
		} else if (n.nodeType === 1) {
			const e = n as Element;
			if (e.tagName === "BR") return null;
			const r = e.getBoundingClientRect();
			if (r.height > 0) return r.top;
		}
	}
	return null;
}

/**
 * Measured tops of source lines inside a section: list items (one `<li>` per item line), table
 * rows, `<br>`-separated paragraph lines, code block content. Everything else is interpolated.
 */
function measureMarks(el: HTMLElement, lines: readonly string[], start: number, end: number, top: number, sy = 1): LineMark[] {
	if (end <= start) return [];
	const marks: LineMark[] = [];
	const lis = Array.from(el.querySelectorAll("li"));
	if (lis.length > 0) {
		const items = listItemLines(lines, start, end);
		lis.forEach((li, i) => {
			let line: number | undefined;
			if (items.length === lis.length) line = items[i];
			else {
				const dl = li.getAttribute("data-line");
				if (dl !== null && /^\d+$/.test(dl)) line = start + Number(dl);
			}
			if (line !== undefined) marks.push({ line, y: (li.getBoundingClientRect().top - top) / sy });
		});
		return marks;
	}
	const trs = Array.from(el.querySelectorAll("tr"));
	if (trs.length > 0) {
		const rows = tableRowLines(lines, start, end);
		if (rows.length === trs.length) trs.forEach((tr, i) => marks.push({ line: rows[i], y: (tr.getBoundingClientRect().top - top) / sy }));
		return marks;
	}
	const fence = /^\s*(```|~~~)/;
	const pre = el.querySelector("pre");
	if (pre && fence.test(lines[start] ?? "")) {
		const code = pre.querySelector("code") ?? pre;
		const r = code.getBoundingClientRect();
		const cs = el.ownerDocument.defaultView?.getComputedStyle(code);
		const pt = cs ? parseFloat(cs.paddingTop) || 0 : 0;
		const pb = cs ? parseFloat(cs.paddingBottom) || 0 : 0;
		marks.push({ line: start + 1, y: (r.top - top) / sy + pt });
		if (fence.test(lines[end] ?? "")) marks.push({ line: end, y: (r.bottom - top) / sy - pb });
		return marks;
	}
	const brs = Array.from(el.querySelectorAll("br"));
	if (brs.length === end - start) {
		brs.forEach((br, i) => {
			const y = topAfter(br);
			if (y !== null) marks.push({ line: start + i + 1, y: (y - top) / sy });
		});
	}
	return marks;
}

/** A section's rendered text: its text nodes, concatenated and whitespace-normalized (index-mapped). */
interface SectionText {
	nodes: Text[];
	/** Per raw character: index of its node and offset in it. */
	nodeAt: number[];
	offAt: number[];
	hay: { text: string; map: number[] };
}

function sectionText(el: HTMLElement): SectionText {
	const doc = el.ownerDocument;
	const nodes: Text[] = [];
	const walker = doc.createTreeWalker(el, 4 /* NodeFilter.SHOW_TEXT */);
	for (let n = walker.nextNode(); n; n = walker.nextNode()) {
		const p = n.parentElement;
		if (p && p.closest(`svg, .frontmatter, .math, mjx-container`)) continue;
		nodes.push(n as Text);
	}
	let raw = "";
	const nodeAt: number[] = [];
	const offAt: number[] = [];
	nodes.forEach((n, k) => {
		const t = n.data;
		raw += t;
		for (let i = 0; i < t.length; i++) {
			nodeAt.push(k);
			offAt.push(i);
		}
	});
	return { nodes, nodeAt, offAt, hay: normalizeWithMap(raw) };
}

/**
 * Rows of a text highlight's pieces inside this section, found in the rendered text (see
 * readingMap.ts). Rects are relative to (left, top). Empty when the text can't be located.
 */
function measureTextRows(el: HTMLElement, st: SectionText, lay: Layout, pieces: { line: number; from: number; to: number }[], left: number, top: number, lh: number, sx = 1, sy = 1): Row[] {
	const doc = el.ownerDocument;
	const { nodes, nodeAt, offAt, hay } = st;
	const rects: Row[] = [];
	for (const pc of pieces) {
		const src = lay.lines[pc.line];
		const needle = normalizeWs(stripInline(src.slice(pc.from, pc.to), pc.from === 0));
		if (!needle) continue;
		let prefix = "";
		for (let l = lay.lineStart; l < pc.line; l++) prefix += stripInline(lay.lines[l], true) + " ";
		prefix += stripInline(src.slice(0, pc.from), true);
		const k = countOccurrences(normalizeWithMap(prefix).text, needle);
		const at = findNth(hay.text, needle, k);
		if (at < 0) continue;
		const a = hay.map[at];
		const b = hay.map[at + needle.length - 1];
		const range = doc.createRange();
		try {
			range.setStart(nodes[nodeAt[a]], offAt[a]);
			range.setEnd(nodes[nodeAt[b]], offAt[b] + 1);
		} catch {
			continue;
		}
		for (const r of Array.from(range.getClientRects())) {
			rects.push({ left: (r.left - left) / sx, top: (r.top - top) / sy, right: (r.right - left) / sx, bottom: (r.bottom - top) / sy });
		}
	}
	return mergeRows(rects, 2.5 * lh);
}

/**
 * [Stage H] Top-left and height (relative to (left, top)) of character `ch` of source line `line` in the
 * section's rendered text (the Stage C matching, on the word around it), or null if not found.
 */
function measureChar(el: HTMLElement, st: SectionText, lay: Layout, line: number, ch: number, left: number, top: number, lh: number, sx = 1, sy = 1): [number, number, number] | null {
	const n = charNeedle(lay.lines, lay.lineStart, line, ch);
	if (!n) return null;
	const at = findNth(st.hay.text, n.needle, n.k);
	if (at < 0) return null;
	const i = st.hay.map[at + n.offset];
	if (i === undefined) return null;
	const range = el.ownerDocument.createRange();
	try {
		range.setStart(st.nodes[st.nodeAt[i]], st.offAt[i]);
		range.setEnd(st.nodes[st.nodeAt[i]], st.offAt[i] + 1);
	} catch {
		return null;
	}
	const r = Array.from(range.getClientRects()).find((q) => q.height / sy > 0 && q.height / sy <= 2.5 * lh);
	return r ? [(r.left - left) / sx, (r.top - top) / sy, r.height / sy] : null;
}

function svgEl<K extends keyof SVGElementTagNameMap>(doc: Document, tag: K): SVGElementTagNameMap[K] {
	return doc.createElementNS<K>(SVG_NS, tag);
}

/** Create a positioned ink SVG with inline styles (for Reading view and the hidden desktop print window). */
function createReadingSvg(doc: Document, cls: string, width: number, height: number, multiply: boolean, clip = false): SVGSVGElement {
	const svg = svgEl(doc, "svg");
	svg.setAttribute("class", cls);
	svg.setAttribute("aria-hidden", "true");
	const st = svg.style;
	st.position = "absolute";
	st.left = "0";
	st.top = "0";
	st.overflow = clip ? "hidden" : "visible";
	st.pointerEvents = "none";
	st.zIndex = "5";
	if (multiply) st.mixBlendMode = "multiply";
	svg.setAttribute("width", String(Math.max(1, width)));
	svg.setAttribute("height", String(Math.max(1, height)));
	return svg;
}

/** Paint an ink path like the editor overlay (centerline pens stroked, everything else filled). */
function paintPath(el: SVGPathElement, s: Pick<Stroke, "tool" | "style" | "size" | "color">, target: InkTarget): void {
	// [Stage L] theme-adaptive on screen (CSS variables), black on white paper in print.
	const color = inkColor(s.color, target, s.tool);
	if (s.tool === "highlighter") el.setAttribute("opacity", HL_OPACITY);
	else if (s.style === "pencil") el.setAttribute("opacity", "0.78");
	else if (s.style === "marker") el.setAttribute("opacity", "0.88");
	if (isCenterline(s)) {
		el.setAttribute("fill", "none");
		el.setAttribute("stroke", color);
		el.setAttribute("stroke-width", String(s.size));
		el.setAttribute("stroke-linecap", "round");
		el.setAttribute("stroke-linejoin", "round");
		const dash = dashArray(s);
		if (dash) el.setAttribute("stroke-dasharray", dash);
	} else {
		el.setAttribute("fill", color);
	}
	// Presentation attributes can't hold var(): the theme color goes into the style.
	if (color.startsWith("var(")) {
		if (isCenterline(s)) el.style.stroke = color;
		else el.style.fill = color;
	}
}

/** Remove our drawing from a section element. */
function clearSection(el: HTMLElement): void {
	removeSpaces(el);
	for (const c of Array.from(el.children)) if (isOurs(c)) c.remove();
	if (el.classList.contains(HOST_CLASS)) {
		el.classList.remove(HOST_CLASS);
		el.style.removeProperty("position");
	}
	setGap(el, 0);
}

/**
 * Room below a section for its ink: a bottom margin (collapses with the paragraph gap), or for the
 * note's last section (`room`) an empty in-flow spacer block of that height inside the section
 * (Stage I). In print a margin adjoining a page break is truncated, and Chromium moves a block
 * with a large bottom padding to the next page whole, so a spacer is the only form that keeps the
 * last line where it is and lets the drawing below the end of the note flow onto further pages.
 */
function setGap(el: HTMLElement, px: number, room = false, contentHeight?: number, sy = 1): void {
	const cur = el.getAttribute(GAP_ATTR);
	const want = px > 0 ? `${room ? `r${Math.round(contentHeight ?? 0)}:` : "m"}${px}` : null;
	if (cur === want) return;
	if (cur === null && want === null) return;
	el.style.removeProperty("margin-bottom");
	for (const c of Array.from(el.children)) if (c.classList.contains(ROOM_CLASS)) c.remove();
	if (want === null) {
		el.removeAttribute(GAP_ATTR);
		return;
	}
	el.setAttribute(GAP_ATTR, want);
	if (room) {
		const sp = el.createDiv({ cls: ROOM_CLASS, attr: { "aria-hidden": "true" } });
		// `px` is counted from the content's bottom; the spacer starts below the last child's bottom
		// margin, so subtract what is already there (one layout read; only the last section).
		const already = (sp.getBoundingClientRect().top - el.getBoundingClientRect().top) / sy - (contentHeight ?? 0);
		sp.style.height = `${Math.max(0, Math.ceil(px - Math.max(0, already)))}px`;
	} else el.style.marginBottom = `${px}px`;
}

/**
 * Draw the ink owned by one section into it (replacing any previous drawing), with [Stage K] the
 * drawing spaces shown after its lines. Returns the number of strokes drawn.
 */
function drawSection(el: HTMLElement, lay: Layout, ink: InkFile): number {
	const doc = el.ownerDocument;
	const strokes = ink.strokes;
	const { lines, lineStart, lineEnd, range } = lay;
	// Which strokes belong here? (resolve first: cheap, cached; no layout reads yet)
	const own: { s: Stroke; line: number; charLine?: number }[] = [];
	const texts: { s: Stroke; line: number; pieces: { line: number; from: number; to: number }[] }[] = [];
	for (const s of strokes) {
		if (s.points.length === 0 && !s.text) continue;
		if (lay.drawnIds?.has(s.id)) continue;
		const line = resolveLine(s, lines);
		if (s.text && s.tool === "highlighter") {
			const endLine = Math.min(lines.length - 1, Math.max(line, line + s.text.endLine - s.anchor.line));
			const pieces = rangePieces(lines, line, s.text.ch, endLine, s.text.endCh).filter((p) => p.line >= lineStart && p.line <= lineEnd);
			const owner = line >= range.from && line <= range.to;
			if (pieces.length > 0 || owner) {
				texts.push({ s, line, pieces });
				if (owner) lay.drawnIds?.add(s.id);
			}
			continue;
		}
		if (s.char) {
			// [Stage H] drawn by the section owning its character's line (where the character is).
			const charLine = Math.min(lines.length - 1, Math.max(0, line + s.char.line - s.anchor.line));
			if (charLine >= range.from && charLine <= range.to) {
				own.push({ s, line, charLine });
				lay.drawnIds?.add(s.id);
			}
			continue;
		}
		if (line >= range.from && line <= range.to) {
			own.push({ s, line });
			lay.drawnIds?.add(s.id);
		}
	}
	const existing = Array.from(el.children).filter((c) => c.classList.contains(SVG_CLASS));
	removeSpaces(el);
	if (own.length === 0 && texts.length === 0) {
		clearSection(el);
		return 0;
	}

	// Layout reads.
	const elRect = el.getBoundingClientRect();
	const [sx, sy] = elementScale(el, elRect);
	const top = elRect.top;
	const left = elRect.left;
	const height = contentBottom(el, top, sy);
	const lh = lineHeightOf(el);
	const marks = measureMarks(el, lines, lineStart, lineEnd, top, sy);
	const yOf = (line: number) => lineTop(line, marks, lineStart, lineEnd, height, lh);
	const target: InkTarget = lay.print ? "paper" : "screen";
	const multiply = doc.body.classList.contains("theme-light") || lay.print;

	const svg = createReadingSvg(doc, SVG_CLASS, Math.round(elRect.width / sx), Math.round(height), multiply);
	const gHl = svgEl(doc, "g");
	gHl.setAttribute("class", "pl-hl");
	const gPen = svgEl(doc, "g");
	gPen.setAttribute("class", "pl-pen");
	svg.append(gHl, gPen);

	let drawn = 0;
	let inkBottom = -Infinity;
	const placed: { s: Stroke; d: string; x: number; y: number; from: number; to: number }[] = [];
	const addPath = (s: Stroke, d: string, y: number, x = 0, band?: Band): SVGPathElement | null => {
		if (!d) return null;
		const p = svgEl(doc, "path");
		p.setAttribute("d", d);
		const r2 = (v: number) => Math.round(v * 100) / 100;
		if (y !== 0 || x !== 0) p.setAttribute("transform", `translate(${r2(x)} ${r2(y)})`);
		paintPath(p, s, target);
		(s.tool === "highlighter" ? gHl : gPen).appendChild(p);
		if (band) placed.push({ s, d, x, y, ...band });
		drawn++;
		return p;
	};
	let text: SectionText | null = null;
	const textOf = () => (text ??= sectionText(el));
	// Text highlights: exact rows from the rendered text; the owner falls back to the drawn path.
	for (const t of texts) {
		const rows = t.pieces.length > 0 ? measureTextRows(el, textOf(), lay, t.pieces, left, top, lh, sx, sy) : [];
		if (rows.length > 0) addPath(t.s, rowsPath(rows), 0);
		else if (t.line >= range.from && t.line <= range.to && t.s.points.length > 0) addPath(t.s, pathOf(t.s), yOf(t.line));
	}
	// Plain ink in z-order (highlighters go to their own group beneath the pens).
	for (const { s, line, charLine } of own) {
		let x = 0;
		let y = yOf(line);
		let anchorTop = y;
		let box = 0;
		if (s.char && charLine !== undefined) {
			// [Stage H] at its character's rendered rect + offset; else the section mapping.
			const c = measureChar(el, textOf(), lay, charLine, s.char.ch, left, top, lh, sx, sy);
			if (c) {
				[x, y] = charOrigin(c, s.char);
				anchorTop = c[1];
				box = c[2];
			}
		}
		// Document style: text rows are shorter/taller than the editor's; keep the ink's distance
		// from its text proportional (the stroke itself is not scaled).
		if (lay.yScale !== undefined && lay.yScale !== 1) y = scaleInkY(y, anchorTop, strokeCenterY(s), lay.yScale, box);
		const band = { from: y + strokeTop(s), to: y + strokeBottom(s) };
		addPath(s, pathOf(s), y, x, band);
		inkBottom = Math.max(inkBottom, band.to);
	}

	for (const c of existing) c.remove();
	for (const c of Array.from(el.children)) if (c.classList.contains(ROOM_SLICE_CLASS)) c.remove();
	if (!el.classList.contains(HOST_CLASS)) el.classList.add(HOST_CLASS);
	el.appendChild(svg);
	// Room for ink drawn in the blank lines below the block (they collapse in Reading view).
	// The note's last section also makes room for ink drawn below the end of the note (Stage I).
	const atEnd = range.to >= lines.length - 1;
	const roomPx = reserveSpace(inkBottom, height, range.to - lineEnd, lh, { atEnd, pad: atEnd ? 2 : 4 });
	if (lay.print && atEnd && lay.pageHeight && roomPx > 0) {
		const sectionTop = lay.printTop !== undefined ? Math.max(0, (top - lay.printTop) / sy) : 0;
		const firstRoom = new Pager(lay.pageHeight).room(sectionTop + height);
		if (roomPx > firstRoom) {
			const extents = padExtents(placed.map((p) => ({ from: p.from - height, to: p.to - height })));
			const plan = planSlices(roomPx, extents, { pageHeight: lay.pageHeight, firstRoom });
			if (plan.slices.length > 1 || plan.breakFirst) {
				const w = Math.max(1, Math.round(elRect.width / sx));
				// Clip main SVG strictly at end of page 1 content (or slice 0) so continuation slices draw pages 2+ cleanly.
				svg.classList.add("pl-reading-slice-svg");
				if (plan.breakFirst) {
					svg.setAttribute("height", String(Math.max(1, Math.ceil(height))));
					setGap(el, 0, true, height, sy);
				} else {
					const firstSlice = plan.slices[0];
					svg.setAttribute("height", String(Math.max(1, Math.ceil(height + firstSlice.to))));
					setGap(el, Math.ceil(firstSlice.to - firstSlice.from), true, height, sy);
				}
				const startSlice = plan.breakFirst ? 0 : 1;
				for (let si = startSlice; si < plan.slices.length; si++) {
					const slice = plan.slices[si];
					const sliceH = Math.max(1, Math.ceil(slice.to - slice.from));
					const div = el.createDiv({ cls: `${ROOM_CLASS} ${ROOM_SLICE_CLASS}`, attr: { "aria-hidden": "true" } });
					div.style.height = `${sliceH}px`;
					const sliceSvg = createReadingSvg(doc, `${SVG_CLASS} pl-reading-slice-svg`, w, sliceH, multiply, true);
					const sgHl = svgEl(doc, "g");
					sgHl.setAttribute("class", "pl-hl");
					const sgPen = svgEl(doc, "g");
					sgPen.setAttribute("class", "pl-pen");
					sliceSvg.append(sgHl, sgPen);
					for (const item of placed) {
						const localBand = { from: item.from - height, to: item.to - height };
						if (!inSlice(localBand, slice)) continue;
						const p = svgEl(doc, "path");
						p.setAttribute("d", item.d);
						const ty = item.y - height - slice.from;
						const r2 = (v: number) => Math.round(v * 100) / 100;
						if (ty !== 0 || item.x !== 0) p.setAttribute("transform", `translate(${r2(item.x)} ${r2(ty)})`);
						paintPath(p, item.s, target);
						(item.s.tool === "highlighter" ? sgHl : sgPen).appendChild(p);
					}
					div.appendChild(sliceSvg);
				}
				return drawn;
			}
		}
	}
	setGap(el, roomPx, atEnd, height, sy);
	return drawn;
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | undefined> {
	return new Promise((resolve) => {
		const t = window.setTimeout(() => resolve(undefined), ms);
		p.then(
			(v) => {
				window.clearTimeout(t);
				resolve(v);
			},
			() => {
				window.clearTimeout(t);
				resolve(undefined);
			},
		);
	});
}

async function waitImages(el: HTMLElement, ms: number): Promise<void> {
	const imgs = Array.from(el.querySelectorAll("img")).filter((i) => !i.complete);
	if (imgs.length === 0) return;
	await withTimeout(
		Promise.all(
			imgs.map(
				(img) =>
					new Promise<void>((r) => {
						img.addEventListener("load", () => r(), { once: true });
						img.addEventListener("error", () => r(), { once: true });
					}),
			),
		),
		ms,
	);
}

// ---------------------------------------------------------------------------------------------
// Controller
// ---------------------------------------------------------------------------------------------

export class ReadingInk {
	private readonly sections = new Map<string, Set<Section>>();
	private readonly byEl = new WeakMap<HTMLElement, Section>();
	private readonly printedRoots = new WeakSet<HTMLElement>();
	private readonly scheduled = new Set<string>();
	private timer: number | null = null;

	constructor(private readonly host: ReadingHost) {}

	/** Wire the post-processor, store observer and export commands into the plugin. */
	install(plugin: Plugin): void {
		plugin.registerMarkdownPostProcessor((el, ctx) => this.process(el, ctx));
		plugin.register(
			this.host.store.observeAll((path, change) => {
				if (change.type === "rename") this.renamePath(change.oldPath, change.newPath);
				if (this.sections.has(path)) this.schedule(path);
			}),
		);
		plugin.register(() => this.destroy());
		// Theme switch: highlighter blending (multiply in light themes) is decided per drawing.
		plugin.registerEvent(this.host.app.workspace.on("css-change", () => this.refresh()));
		// [Stage H] The export commands are one-shot (exportPdf.ts, registered by the plugin).
		// Reading views already open when the plugin loads were rendered without the post-processor.
		this.host.app.workspace.onLayoutReady(() => this.rerenderReadingViews());
	}

	private rerenderReadingViews(): void {
		for (const leaf of this.host.app.workspace.getLeavesOfType("markdown")) {
			const v = leaf.view;
			if (v instanceof MarkdownView && v.getMode() === "preview") v.previewMode.rerender(true);
		}
	}

	/** Settings changed (e.g. "Show ink"): redraw every section. */
	refresh(): void {
		for (const path of this.sections.keys()) this.schedule(path);
	}

	private destroy(): void {
		for (const set of this.sections.values()) {
			for (const sec of set) {
				sec.ro?.disconnect();
				clearSection(sec.el);
			}
		}
		this.sections.clear();
		if (this.timer !== null) window.clearTimeout(this.timer);
		this.timer = null;
	}

	private process(el: HTMLElement, ctx: MarkdownPostProcessorContext): Promise<void> | void {
		const path = ctx.sourcePath;
		if (!path || !path.toLowerCase().endsWith(".md")) return;
		// Transcluded notes / hover previews: their own layout, not this note's ink.
		if (el.closest(".markdown-embed")) return;
		if (ctx.getSectionInfo(el)) {
			this.attach(el, path, ctx);
			return;
		}
		if (el.parentElement?.classList.contains("print")) return this.processPrint(el, path, ctx);
	}

	// ----- Reading view ---------------------------------------------------------------------

	private attach(el: HTMLElement, path: string, ctx: MarkdownPostProcessorContext): void {
		// Ignore elements nested inside an already-attached reading section host so child blocks
		// never paint a second copy of the parent section's ink.
		const parentHost = el.parentElement?.closest(`.${HOST_CLASS}`);
		if (parentHost && parentHost !== el) return;
		let sec = this.byEl.get(el);
		if (!sec) {
			const child = new MarkdownRenderChild(el);
			const s: Section = { el, path, ctx, ro: null, child };
			child.onunload = () => this.detach(s);
			ctx.addChild(child);
			const RO = el.ownerDocument.defaultView?.ResizeObserver ?? (typeof ResizeObserver !== "undefined" ? ResizeObserver : null);
			if (RO) {
				s.ro = new RO(() => this.layout(s));
				s.ro.observe(el);
			}
			this.byEl.set(el, s);
			sec = s;
		}
		const old = this.sections.get(sec.path);
		if (old && sec.path !== path) old.delete(sec);
		sec.path = path;
		sec.ctx = ctx;
		let set = this.sections.get(path);
		if (!set) this.sections.set(path, (set = new Set()));
		set.add(sec);
		if (!this.host.store.isLoaded(path)) void this.host.store.load(path).then(() => this.schedule(path));
		// Line numbers of the note's other sections may have shifted: re-lay them out too.
		this.schedule(path);
	}

	private detach(sec: Section): void {
		sec.ro?.disconnect();
		sec.ro = null;
		clearSection(sec.el);
		this.sections.get(sec.path)?.delete(sec);
		if (this.sections.get(sec.path)?.size === 0) this.sections.delete(sec.path);
		this.byEl.delete(sec.el);
	}

	private renamePath(oldPath: string, newPath: string): void {
		const set = this.sections.get(oldPath);
		if (!set) return;
		this.sections.delete(oldPath);
		const into = this.sections.get(newPath) ?? new Set<Section>();
		for (const s of set) {
			s.path = newPath;
			into.add(s);
		}
		this.sections.set(newPath, into);
	}

	private schedule(path: string): void {
		this.scheduled.add(path);
		if (this.timer !== null) return;
		this.timer = window.setTimeout(() => {
			this.timer = null;
			const paths = [...this.scheduled];
			this.scheduled.clear();
			for (const p of paths) this.layoutPath(p);
		}, 0);
	}

	/** Lay out all attached Reading-view sections of one note in line order with stroke deduplication. */
	private layoutPath(path: string): void {
		const list = [...(this.sections.get(path) ?? [])];
		if (list.length === 0) return;
		const withInfo: { sec: Section; info: { text: string; lineStart: number; lineEnd: number } | null }[] = list.map((sec) => {
			let info: { text: string; lineStart: number; lineEnd: number } | null = null;
			try {
				info = sec.ctx.getSectionInfo(sec.el);
			} catch {
				info = null;
			}
			return { sec, info };
		});
		withInfo.sort((a, b) => (a.info?.lineStart ?? Infinity) - (b.info?.lineStart ?? Infinity));
		const drawnIds = new Set<string>();
		for (let i = 0; i < withInfo.length; i++) {
			const { sec, info } = withInfo[i];
			const nextInfo = withInfo.slice(i + 1).find((x) => x.info && x.sec.el.isConnected && x.sec.el.getClientRects().length > 0)?.info;
			const nextStart = nextInfo ? nextInfo.lineStart : undefined;
			this.layout(sec, info, drawnIds, nextStart);
		}
	}

	private layout(
		sec: Section,
		preInfo?: { text: string; lineStart: number; lineEnd: number } | null,
		drawnIds?: Set<string>,
		nextStart?: number,
	): void {
		const { el } = sec;
		let info = preInfo;
		if (info === undefined) {
			try {
				info = sec.ctx.getSectionInfo(el);
			} catch {
				info = null;
			}
		}
		if (!info) {
			// Section re-rendered/discarded (its replacement registers itself).
			if (!el.isConnected) this.detach(sec);
			else clearSection(el);
			return;
		}
		if (!el.isConnected) return; // virtualized away; the ResizeObserver fires on re-attach
		// [Stage K] Not rendered (the leaf is in editing mode / hidden): measurements would be
		// garbage and a space block placed from them would stay wrong. The ResizeObserver fires
		// again when it is shown (its size goes from 0 to its real size).
		if (el.getClientRects().length === 0) return;
		const ink = this.host.store.get(sec.path);
		if (!ink || isEmptyInk(ink)) {
			clearSection(el);
			return;
		}
		const lines = splitLines(info.text);
		const range = ownedRange(lines, info.lineStart, info.lineEnd, nextStart !== undefined ? { nextStart } : {});
		try {
			// [Stage K] "Show ink" off: spaces still take their room (the layout never changes).
			const shown = this.host.getSettings().inkVisible ? ink : { ...ink, strokes: [] };
			drawSection(el, { lines, lineStart: info.lineStart, lineEnd: info.lineEnd, range, print: false, drawnIds }, shown);
		} catch (err) {
			console.error("[ink-pages] reading view ink failed", err);
		}
	}

	// ----- PDF export -----------------------------------------------------------------------

	private processPrint(el: HTMLElement, path: string, ctx: MarkdownPostProcessorContext): Promise<void> | void {
		const printRoot = el.parentElement?.classList.contains("print") ? el.parentElement : el;
		if (this.printedRoots.has(printRoot)) return;
		this.printedRoots.add(printRoot);
		// [Stage H] one-shot export override, else the toggle / default style
		const { include: withInk, style } = this.host.printOptions();
		// Document style first (synchronously, even without ink): everything measured below — block
		// heights, line marks, character rects — is measured against the document-style text.
		this.applyStyle(el, style);
		if (!withInk) return;
		const promises = (ctx as unknown as { promises?: Promise<unknown>[] }).promises;
		let self: Promise<void> | null = null;
		self = (async () => {
			// Embeds are queued right after the post-processors run: let them be pushed, then wait.
			await Promise.resolve();
			const others = Array.isArray(promises) ? promises.filter((p) => p !== self) : [];
			if (others.length > 0) await withTimeout(Promise.all(others), 8000);
			const file = this.host.app.vault.getAbstractFileByPath(path);
			if (!(file instanceof TFile)) return;
			const [text, loaded] = await Promise.all([this.host.app.vault.cachedRead(file), this.host.store.load(path)]);
			const ink: InkFile = withInk ? loaded : { ...loaded, strokes: [] };
			if (isEmptyInk(ink)) return;
			await waitImages(el, 4000);
			const rawCfg = this.exportSettings();
			const cfg = rawCfg ?? pageGuidePrintConfig(this.host.getSettings().pageGuide);
			// The export lays the note out in a hidden (1 px wide) window; measure at the printed
			// width so blocks wrap as they will on paper. Restored right after measuring.
			const page = el.parentElement;
			const prevWidth = page?.style.width ?? "";
			if (page) page.style.width = `${printAreaWidth(cfg)}px`;
			try {
				this.layoutPrint(el, file, text, ink, cfg, page, style);
			} catch (err) {
				console.error("[ink-pages] PDF ink failed", err);
			} finally {
				if (page) page.style.width = prevWidth;
			}
		})();
		return self;
	}

	/**
	 * Document-style export: a class on the export's `.print` root (styles.css does the rest) and the
	 * chosen font as a variable. Not removed afterwards: the root is printed after the post-processors
	 * resolve and discarded after printing (desktop: its window closes; mobile: the div is removed).
	 */
	private applyStyle(el: HTMLElement, style: ExportStyle): void {
		const root = el.parentElement?.classList.contains("print") ? el.parentElement : el;
		if (style !== "document") {
			root.classList.remove(DOC_STYLE_CLASS);
			return;
		}
		root.classList.add(DOC_STYLE_CLASS);
		root.style.setProperty(DOC_FONT_VAR, docFontStack(this.host.getSettings().docExportFont));
	}

	/**
	 * Line height (px) of the editor the ink was drawn in: the note's open editor (CodeMirror's
	 * `defaultLineHeight`), else any open Markdown editor's, else null (unknown).
	 */
	private editorLineHeight(path: string): number | null {
		let any: number | null = null;
		for (const leaf of this.host.app.workspace.getLeavesOfType("markdown")) {
			const v = leaf.view;
			if (!(v instanceof MarkdownView)) continue;
			const cm = (v.editor as unknown as { cm?: { defaultLineHeight?: number; scaleY?: number } }).cm;
			const rawLh = cm?.defaultLineHeight;
			if (typeof rawLh !== "number" || !(rawLh > 0)) continue;
			const lh = rawLh / (cm?.scaleY || 1);
			if (v.file?.path === path) return lh;
			any ??= lh;
		}
		return any;
	}

	/** Obsidian's saved PDF export options (written by the export dialog before it renders). */
	private exportSettings(): unknown {
		try {
			return (this.host.app.vault as unknown as { getConfig?(key: string): unknown }).getConfig?.("pdfExportSettings") ?? null;
		} catch {
			return null;
		}
	}

	/** The export container's top-level blocks and the ones matched to the note's sections. */
	private printBlocks(container: HTMLElement, file: TFile): { blocks: HTMLElement[]; hosts: Host[] } {
		const sections = this.host.app.metadataCache.getFileCache(file)?.sections ?? [];
		const blocks = Array.from(container.children).filter((c) => !isOurs(c)) as HTMLElement[];
		const kinds: BlockKind[] = blocks.map((b) => {
			// Each block is wrapped in a <div> (post-processors may add classes to it, e.g. frontmatter).
			if (b.tagName === "DIV" && b.firstElementChild) {
				const f = b.firstElementChild;
				const k = elementKind(f.tagName, Array.from(f.classList));
				return k !== "other" ? k : elementKind(b.tagName, Array.from(b.classList));
			}
			if (/^H[1-6]$/.test(b.tagName)) return "title"; // the export's "include file name" title
			return elementKind(b.tagName, Array.from(b.classList));
		});
		const align = alignBlocks(
			sections.map((s) => sectionKind(s.type)),
			kinds,
		);
		const hosts: Host[] = [];
		blocks.forEach((b, i) => {
			const si = align[i];
			if (si < 0 || b.tagName !== "DIV") return; // <hr> can't host an SVG: its lines go to the block above
			const sec = sections[si];
			hosts.push({ el: b, lineStart: sec.position.start.line, lineEnd: sec.position.end.line, kind: sectionKind(sec.type) });
		});
		return { blocks, hosts };
	}

	private drawHosts(container: HTMLElement, lines: readonly string[], hosts: Host[], ink: InkFile, yScale: number, pageHeight: number, printTop: number): void {
		if (isEmptyInk(ink)) return;
		const drawnIds = new Set<string>();
		if (hosts.length === 0) {
			// No metadata: the whole note as one block (proportional placement).
			drawSection(container, { lines, lineStart: 0, lineEnd: lines.length - 1, range: { from: 0, to: lines.length - 1 }, print: true, yScale, pageHeight, printTop, drawnIds }, ink);
			return;
		}
		hosts.forEach((h, i) => {
			const nextStart = i + 1 < hosts.length ? hosts[i + 1].lineStart : lines.length;
			const range = ownedRange(lines, h.lineStart, h.lineEnd, { nextStart, isFirst: i === 0 });
			drawSection(h.el, { lines, lineStart: h.lineStart, lineEnd: h.lineEnd, range, print: true, yScale, pageHeight, printTop, drawnIds }, ink);
		});
	}

	private layoutPrint(container: HTMLElement, file: TFile, text: string, ink: InkFile, cfg: unknown, page: HTMLElement | null, style: ExportStyle): void {
		const lines = splitLines(text);
		const { hosts } = this.printBlocks(container, file);
		// Document style: its body text has its own line height; ink was drawn against the editor's.
		const yScale = style === "document" ? inkYScale(lineHeightOf(container), this.editorLineHeight(file.path)) : 1;
		const pageHeight = Math.floor(printAreaHeight(cfg) - PRINT_PAGE_CLEARANCE);
		const printTop = (page ?? container).getBoundingClientRect().top;
		this.drawHosts(container, lines, hosts, ink, yScale, pageHeight, printTop);
	}
}
