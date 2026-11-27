/**
 * Popout-window-safe DOM, Window, and SVG helpers.
 *
 * Always resolve `Document` / `Window` from the CodeMirror view's own DOM (`ownerDocument` /
 * `defaultView`) rather than Obsidian's globals (`activeDocument` / `window`), falling back only
 * when a headless test mock omits `view.dom`.
 */
import type { EditorView } from "@codemirror/view";

export const SVG_NS = "http://www.w3.org/2000/svg";

export type ViewDomLike = Pick<EditorView, "scrollDOM" | "contentDOM"> & { dom?: HTMLElement };

export function docOf(view: ViewDomLike): Document {
	return (
		view.dom?.ownerDocument ??
		view.scrollDOM?.ownerDocument ??
		view.contentDOM?.ownerDocument ??
		(typeof activeDocument !== "undefined" ? activeDocument : (undefined as unknown as Document))
	);
}

export function winOf(view: ViewDomLike): Window {
	return docOf(view)?.defaultView ?? window;
}

export function computedStyleOf(el: Element, fallbackDoc?: Document): CSSStyleDeclaration {
	const win = (el.ownerDocument ?? fallbackDoc)?.defaultView;
	if (win && typeof win.getComputedStyle === "function") return win.getComputedStyle(el);
	return getComputedStyle(el);
}

export function svgEl<K extends keyof SVGElementTagNameMap>(doc: Document, tag: K, cls?: string): SVGElementTagNameMap[K] {
	const el = doc.createElementNS(SVG_NS, tag);
	if (cls) el.setAttribute("class", cls);
	return el;
}

export function isDomNode(target: unknown, doc?: Document): target is Node {
	if (!target || typeof target !== "object") return false;
	const win = doc?.defaultView;
	if (win?.Node && target instanceof win.Node) return true;
	return typeof Node !== "undefined" && target instanceof Node;
}

export function isDomElement(target: unknown, doc?: Document): target is Element {
	if (!target || typeof target !== "object") return false;
	const win = doc?.defaultView;
	if (win?.Element && target instanceof win.Element) return true;
	return typeof Element !== "undefined" && target instanceof Element;
}
