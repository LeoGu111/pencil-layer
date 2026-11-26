/**
 * Page boundary guide specs (A4, A3, Letter — portrait & landscape) matching Obsidian's PDF export
 * dimensions (`readingMap.ts` `printAreaWidth` / `printAreaHeight`), pure and tested.
 */
import { PRINT_PAGE_CLEARANCE, pageSpec, printAreaHeight, printAreaWidth } from "./readingMap";

export type PageGuideFormat = "off" | "A4" | "A4-landscape" | "A3" | "A3-landscape" | "Letter";

export const PAGE_GUIDE_FORMATS: readonly PageGuideFormat[] = [
	"off",
	"A4",
	"A4-landscape",
	"A3",
	"A3-landscape",
	"Letter",
];

export const PAGE_GUIDE_LABELS: Readonly<Record<PageGuideFormat, string>> = {
	off: "Off",
	A4: "A4",
	"A4-landscape": "A4 ↔",
	A3: "A3",
	"A3-landscape": "A3 ↔",
	Letter: "Letter",
};

export interface PageGuideMetrics {
	format: Exclude<PageGuideFormat, "off">;
	label: string;
	/** Printable width in editor/PDF CSS px (matching Obsidian's default 1 cm print margin). */
	width: number;
	/** Full physical paper width in CSS px (e.g. 794 px = 21.0 cm for A4). */
	paperWidth: number;
	/** Left/right print margin in CSS px (e.g. 38 px = 1.0 cm). */
	marginPx: number;
	/** Printable height of one sheet in editor/PDF CSS px. */
	height: number;
}

export interface PageGuideLayout {
	metrics: PageGuideMetrics;
	/** Total number of sheets currently spanned (>= 1). */
	pageCount: number;
	/** Starting Y coordinate of Page 1 in overlay space (`<= 0`; negative when `.inline-title` sits above `docTop`). */
	startY: number;
	/** Bottom Y coordinate of the full sheet stack in overlay space. */
	endY: number;
	/** Total height covered by the full sheet stack (`endY - startY`). */
	totalHeight: number;
	/** Vertical page break Y coordinates (`startY + pageH`, `startY + 2 * pageH`, ...). */
	horizontalBreaks: number[];
	/** Printable sheet width (`metrics.width`). */
	sheetWidth: number;
	/** Full physical paper width (`metrics.paperWidth`). */
	paperWidth: number;
	/** Left/right print margin in CSS px (`metrics.marginPx`). */
	marginPx: number;
	/** Outer paper left edge in overlay space (`-metrics.marginPx`). */
	paperLeftX: number;
	/** Outer paper right edge in overlay space (`metrics.width + metrics.marginPx`). */
	paperRightX: number;
	/** Width covered by horizontal rules (clamped to `metrics.width` when wider, else `overlayWidth`). */
	guideWidth: number;
	/** Visible X position for page labels (always visible even when sheet exceeds viewport). */
	labelRightX: number;
	/** Shaded overflow start X when canvas is wider than the sheet (`metrics.width`), else `null`. */
	overflowX: number | null;
	overflowWidth: number;
}

const GUIDE_CFG: Readonly<Record<Exclude<PageGuideFormat, "off">, { pageSize: string; landscape: boolean; label: string }>> = {
	A4: { pageSize: "A4", landscape: false, label: "A4" },
	"A4-landscape": { pageSize: "A4", landscape: true, label: "A4 Querformat" },
	A3: { pageSize: "A3", landscape: false, label: "A3" },
	"A3-landscape": { pageSize: "A3", landscape: true, label: "A3 Querformat" },
	Letter: { pageSize: "Letter", landscape: false, label: "Letter" },
};

export function pageGuideMetrics(format: PageGuideFormat): PageGuideMetrics | null {
	if (format === "off") return null;
	const cfg = GUIDE_CFG[format];
	if (!cfg) return null;
	const spec = pageSpec(cfg);
	return {
		format,
		label: cfg.label,
		width: Math.round(printAreaWidth(cfg)),
		paperWidth: Math.round(spec.width),
		marginPx: Math.round(spec.margin),
		height: Math.floor(printAreaHeight(cfg) - PRINT_PAGE_CLEARANCE),
	};
}

/** Export settings object compatible with `readingMap.ts` (`printAreaWidth` / `printAreaHeight`). */
export function pageGuidePrintConfig(format: PageGuideFormat): { pageSize: string; landscape: boolean } | null {
	if (format === "off") return null;
	const cfg = GUIDE_CFG[format];
	return cfg ? { pageSize: cfg.pageSize, landscape: cfg.landscape } : null;
}

/** Cycle to the next page guide format for toolbar / command toggles. */
export function nextPageGuide(current: PageGuideFormat): PageGuideFormat {
	const idx = PAGE_GUIDE_FORMATS.indexOf(current);
	return PAGE_GUIDE_FORMATS[(idx + 1) % PAGE_GUIDE_FORMATS.length];
}

/**
 * Compute required bottom padding (px) for `.cm-content` so even completely blank notes can be
 * scrolled comfortably across pages and below existing ink.
 */
export function computeCanvasBottomPadding(opts: {
	format: PageGuideFormat;
	docHeight: number;
	viewportHeight: number;
	lowestInkY: number;
	extraPages: number;
}): number {
	const metrics = pageGuideMetrics(opts.format);
	const pageH = metrics ? metrics.height : Math.max(760, Math.round(opts.viewportHeight || 900));
	const docH = Math.max(0, opts.docHeight);
	const minPages = Math.max(2, opts.extraPages);
	const inkPages = opts.lowestInkY > 0 ? Math.ceil((opts.lowestInkY + pageH * 0.65) / pageH) : 0;
	const targetTotalH = Math.max(minPages * pageH + 120, inkPages * pageH + 120, docH + Math.round(pageH * 0.85));
	return Math.max(Math.round(pageH * 0.85), Math.ceil(targetTotalH - docH));
}

/** Compute complete sheet frame & dashed break coordinates for the editor overlay dimensions. */
export function buildPageGuideLayout(
	format: PageGuideFormat,
	overlayWidth: number,
	overlayHeight: number,
	visibleWidth?: number,
	startY = 0,
): PageGuideLayout | null {
	const metrics = pageGuideMetrics(format);
	if (!metrics) return null;
	const h = metrics.height;
	const originY = Number.isFinite(startY) ? Math.min(0, startY) : 0;
	const maxBreaks = 60;
	const horizontalBreaks: number[] = [];
	for (let y = originY + h; y <= Math.max(overlayHeight + 40, originY + h) && horizontalBreaks.length < maxBreaks; y += h) {
		horizontalBreaks.push(y);
	}
	const pageCount = Math.max(1, horizontalBreaks.length);
	const endY = Math.max(overlayHeight, horizontalBreaks[horizontalBreaks.length - 1] ?? originY + h);
	const totalHeight = endY - originY;
	const overflow = overlayWidth > metrics.width + 2;
	const effectiveVisible = visibleWidth && visibleWidth > 40 ? visibleWidth : overlayWidth;
	const labelRightX = Math.max(110, Math.min(metrics.width, effectiveVisible) - 8);
	return {
		metrics,
		pageCount,
		startY: originY,
		endY,
		totalHeight,
		horizontalBreaks,
		sheetWidth: metrics.width,
		paperWidth: metrics.paperWidth,
		marginPx: metrics.marginPx,
		paperLeftX: -metrics.marginPx,
		paperRightX: metrics.width + metrics.marginPx,
		guideWidth: overflow ? metrics.width : overlayWidth,
		labelRightX,
		overflowX: overflow ? metrics.width : null,
		overflowWidth: overflow ? overlayWidth - metrics.width : 0,
	};
}
