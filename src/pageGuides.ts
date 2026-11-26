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
	/** Vertical page break Y coordinates (`pageH`, `2 * pageH`, ...). */
	horizontalBreaks: number[];
	/** Width covered by horizontal rules. */
	guideWidth: number;
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

/** Compute dashed guide coordinates for the editor overlay dimensions. */
export function buildPageGuideLayout(format: PageGuideFormat, overlayWidth: number, overlayHeight: number): PageGuideLayout | null {
	const metrics = pageGuideMetrics(format);
	if (!metrics) return null;
	const h = metrics.height;
	const horizontalBreaks: number[] = [];
	const maxBreaks = 60;
	for (let y = h; y <= Math.max(overlayHeight + 40, h) && horizontalBreaks.length < maxBreaks; y += h) {
		horizontalBreaks.push(y);
	}
	const overflow = overlayWidth > metrics.width + 2;
	return {
		metrics,
		horizontalBreaks,
		guideWidth: overflow ? metrics.width : overlayWidth,
		overflowX: overflow ? metrics.width : null,
		overflowWidth: overflow ? overlayWidth - metrics.width : 0,
	};
}
