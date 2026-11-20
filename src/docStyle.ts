/**
 * Document-style PDF export (pure, tested; no DOM / Obsidian imports).
 *
 * "Themed" prints the note as Obsidian renders it with the current theme and snippets (the
 * classic export). "Document" prints it like a plain word-processor document: white page, black
 * text in a classic font at 12 pt, plain headings, thin black table borders … — styles.css
 * (`.print.pl-doc-style`) does the styling; readingView.ts adds the class to the export's `.print`
 * root before ink is measured, so ink is laid out against the document-style text.
 */
export type ExportStyle = "themed" | "document";
export type DocFont = "serif" | "sans";

export const EXPORT_STYLES: readonly ExportStyle[] = ["themed", "document"];
export const DOC_FONTS: readonly DocFont[] = ["serif", "sans"];

/** Class on the export's `.print` root while it is printed in document style. */
export const DOC_STYLE_CLASS = "pl-doc-style";
/** CSS variable (inline on the `.print` root) holding the document font stack. */
export const DOC_FONT_VAR = "--pl-doc-font";

/** Font stacks: the classic word-processor fonts first, then metric-compatible / common fallbacks. */
export const DOC_FONT_STACKS: Readonly<Record<DocFont, string>> = {
	serif: '"Times New Roman", Times, Georgia, serif',
	sans: "Calibri, Aptos, Carlito, Arial, sans-serif",
};

export function docFontStack(font: DocFont): string {
	return DOC_FONT_STACKS[font] ?? DOC_FONT_STACKS.serif;
}

/** The style a "the other style" entry offers next to the default one. */
export function otherStyle(style: ExportStyle): ExportStyle {
	return style === "document" ? "themed" : "document";
}

/** ⋯ menu / command label of a one-shot export in `style`. */
export function styleExportLabel(style: ExportStyle): string {
	return style === "document" ? "Export PDF (document style)" : "Export PDF (themed style)";
}

/**
 * Vertical scale for ink placed against document-style text: body line height in the export over
 * the editor's line height (ink is drawn in editor pixels). 1 when unknown or within 5 %.
 */
export function inkYScale(printLineHeight: number, editorLineHeight: number | null | undefined): number {
	if (!editorLineHeight || !(editorLineHeight > 0) || !(printLineHeight > 0)) return 1;
	const r = printLineHeight / editorLineHeight;
	if (!Number.isFinite(r) || Math.abs(r - 1) < 0.05) return 1;
	return Math.min(Math.max(r, 0.25), 4);
}

/**
 * Where a stroke goes (its translate y) when the text it hangs off has `r` times the editor's line
 * height. The stroke stays rigid (never squished); only the distance of its center from its anchor
 * scales — and only the part of it outside the anchor's own box: the glyph box of a character
 * (`boxHeight`, its rendered rect: the font box, about the same size in both) keeps its offsets, the
 * leading around it is what shrinks or grows. So an underline drawn just below a word stays just
 * below it, a mark drawn in the gap between rows stays in that gap, a mark mid-line stays mid-line.
 *
 * `y`: the unscaled translate; `anchorTop`: the anchor's top (character rect top, or the line's top
 * with `boxHeight` 0), same coordinates; `centerY`: the stroke's vertical center in its own points'
 * coordinates.
 */
export function scaleInkY(y: number, anchorTop: number, centerY: number, r: number, boxHeight = 0): number {
	if (r === 1) return y;
	const c = y + centerY - anchorTop;
	const h = Math.max(0, boxHeight);
	let scaled = c;
	if (c > h) scaled = h + (c - h) * r;
	else if (c < 0) scaled = c * r;
	return y + (scaled - c);
}
