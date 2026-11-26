/**
 * Page boundary guide specs (A4, A3, Letter — portrait & landscape) matching Obsidian's PDF export
 * dimensions (`readingMap.ts` `printAreaWidth` / `printAreaHeight`), pure and tested.
 */
import { PRINT_PAGE_CLEARANCE, printAreaHeight, printAreaWidth } from "./readingMap";

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
	/** Printable height of one sheet in editor/PDF CSS px. */
	height: number;
}

export interface PageGuideLayout {
	metrics: PageGuideMetrics;
	/** Total number of sheets currently spanned (>= 1). */
	pageCount: number;
	/** Total height covered by the full sheet stack (`pageCount * metrics.height`). */
	totalHeight: number;
	/** Vertical page break Y coordinates (`pageH`, `2 * pageH`, ...). */
	horizontalBreaks: number[];
	/** Sheet width (`metrics.width`). */
	sheetWidth: number;
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
	return {
		format,
		label: cfg.label,
		width: Math.round(printAreaWidth(cfg)),
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
): PageGuideLayout | null {
	const metrics = pageGuideMetrics(format);
	if (!metrics) return null;
	const h = metrics.height;
	const maxBreaks = 60;
	const horizontalBreaks: number[] = [];
	for (let y = h; y <= Math.max(overlayHeight + 40, h) && horizontalBreaks.length < maxBreaks; y += h) {
		horizontalBreaks.push(y);
	}
	const pageCount = Math.max(1, horizontalBreaks.length);
	const totalHeight = Math.max(overlayHeight, horizontalBreaks[horizontalBreaks.length - 1] ?? h);
	const overflow = overlayWidth > metrics.width + 2;
	const effectiveVisible = visibleWidth && visibleWidth > 40 ? visibleWidth : overlayWidth;
	const labelRightX = Math.max(110, Math.min(metrics.width, effectiveVisible) - 8);
	return {
		metrics,
		pageCount,
		totalHeight,
		horizontalBreaks,
		sheetWidth: metrics.width,
		guideWidth: overflow ? metrics.width : overlayWidth,
		labelRightX,
		overflowX: overflow ? metrics.width : null,
		overflowWidth: overflow ? overlayWidth - metrics.width : 0,
	};
}
