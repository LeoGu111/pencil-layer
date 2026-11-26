import { EditorState } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InkView, type InkHost } from "../src/inkView";
import { emptyInk } from "../src/model";
import { buildPageGuideLayout, computeCanvasBottomPadding, nextPageGuide, pageGuideMetrics, pageGuidePrintConfig } from "../src/pageGuides";
import { DEFAULT_SYNCED, defaultLocal } from "../src/settings";

class MockElement extends EventTarget {
	readonly children: MockElement[] = [];
	readonly attributes = new Map<string, string>();
	readonly style: Record<string, string> = {};
	readonly classes = new Set<string>();
	parentElement: MockElement | null = null;
	textContent = "";
	clientWidth = 0;
	clientHeight = 0;
	offsetWidth = 0;
	offsetHeight = 0;
	scrollLeft = 0;
	scrollTop = 0;
	private rect: { left: number; top: number; right: number; bottom: number; width: number; height: number } = {
		left: 0,
		top: 0,
		right: 0,
		bottom: 0,
		width: 0,
		height: 0,
	};
	private computed: Record<string, string> = {};

	constructor(readonly tagName = "div") {
		super();
	}

	readonly classList = {
		add: (...names: string[]) => names.forEach((n) => this.classes.add(n)),
		remove: (...names: string[]) => names.forEach((n) => this.classes.delete(n)),
		toggle: (name: string, force?: boolean) => {
			if (force === undefined) {
				if (this.classes.has(name)) this.classes.delete(name);
				else this.classes.add(name);
			} else if (force) this.classes.add(name);
			else this.classes.delete(name);
		},
		contains: (name: string) => this.classes.has(name),
	};

	setRect(r: Partial<{ left: number; top: number; right: number; bottom: number; width: number; height: number }>) {
		this.rect = { ...this.rect, ...r };
		if (r.width !== undefined && r.right === undefined) this.rect.right = this.rect.left + r.width;
		if (r.height !== undefined && r.bottom === undefined) this.rect.bottom = this.rect.top + r.height;
	}

	setComputed(cs: Record<string, string>) {
		this.computed = cs;
	}

	getComputed() {
		return this.computed;
	}

	getBoundingClientRect() {
		return this.rect;
	}

	appendChild(child: MockElement) {
		child.parentElement = this;
		this.children.push(child);
		return child;
	}

	append(...nodes: MockElement[]) {
		for (const n of nodes) this.appendChild(n);
	}

	replaceChildren(...nodes: MockElement[]) {
		this.children.length = 0;
		for (const n of nodes) this.appendChild(n);
	}

	setAttribute(k: string, v: string) {
		this.attributes.set(k, v);
		if (k === "class") {
			this.classes.clear();
			for (const c of v.split(/\s+/).filter(Boolean)) this.classes.add(c);
		}
	}

	removeAttribute(k: string) {
		this.attributes.delete(k);
	}

	setCssProps(props: Record<string, string>) {
		Object.assign(this.style, props);
	}

	remove() {
		if (!this.parentElement) return;
		const idx = this.parentElement.children.indexOf(this);
		if (idx >= 0) this.parentElement.children.splice(idx, 1);
		this.parentElement = null;
	}

	querySelector(selector: string): MockElement | null {
		const cls = selector.startsWith(".") ? selector.slice(1) : null;
		for (const child of this.children) {
			if (cls && child.classes.has(cls)) return child;
			const nested = child.querySelector(selector);
			if (nested) return nested;
		}
		return null;
	}
}

function setupEditorGuides(opts: { inlineTitleVisible: boolean; scrollerTopPadding?: number }) {
	const scrollerTopPad = opts.scrollerTopPadding ?? 32;
	const scrollerTop = 78;
	const sizerTop = scrollerTop + scrollerTopPad;
	const titleHeight = opts.inlineTitleVisible ? 31 : 0;
	const titleMarginBottom = opts.inlineTitleVisible ? 12 : 0;
	const docTop = sizerTop + titleHeight + titleMarginBottom;
	const contentHeight = 2200;

	const scrollDOM = new MockElement("div");
	scrollDOM.setRect({ left: 0, top: scrollerTop, width: 900, height: 800 });
	scrollDOM.clientWidth = 900;
	scrollDOM.clientHeight = 800;
	scrollDOM.offsetWidth = 900;
	scrollDOM.offsetHeight = 800;

	const sizerEl = new MockElement("div");
	sizerEl.classList.add("cm-sizer");
	sizerEl.setRect({ left: 100, top: sizerTop, width: 700, height: contentHeight + titleHeight + titleMarginBottom });
	scrollDOM.appendChild(sizerEl);

	const inlineTitleEl = new MockElement("div");
	inlineTitleEl.classList.add("inline-title");
	inlineTitleEl.setRect({ left: 100, top: sizerTop, width: 700, height: titleHeight });
	inlineTitleEl.setComputed({
		display: opts.inlineTitleVisible ? "block" : "none",
		visibility: "visible",
	});
	sizerEl.appendChild(inlineTitleEl);

	const contentDOM = new MockElement("div");
	contentDOM.classList.add("cm-content");
	contentDOM.clientWidth = 700;
	contentDOM.offsetWidth = 700;
	contentDOM.offsetHeight = contentHeight;
	contentDOM.setRect({ left: 100, top: docTop, width: 700, height: contentHeight });
	contentDOM.setComputed({ paddingLeft: "0", paddingRight: "0", paddingTop: "0", borderTopWidth: "0" });
	sizerEl.appendChild(contentDOM);

	let pendingMeasure: { read: (v: EditorView) => unknown; write: (m: unknown) => void } | null = null;
	vi.stubGlobal("window", { setTimeout, clearTimeout, requestAnimationFrame: vi.fn(() => 1), cancelAnimationFrame: vi.fn() });
	vi.stubGlobal("getComputedStyle", (el: MockElement) => ({
		paddingLeft: "0",
		paddingRight: "0",
		paddingTop: "0",
		borderLeftWidth: "0",
		borderRightWidth: "0",
		borderTopWidth: "0",
		borderBottomWidth: "0",
		...el.getComputed?.(),
	}));
	vi.stubGlobal("activeDocument", {
		createElementNS: (_ns: string, tag: string) => new MockElement(tag),
	});

	const state = EditorState.create({ doc: "# Heading\n\nBody" });
	const view = {
		scrollDOM,
		contentDOM,
		contentHeight,
		scaleX: 1,
		scaleY: 1,
		documentTop: docTop,
		viewport: { from: 0, to: state.doc.length },
		state: {
			doc: state.doc,
			selection: state.selection,
			field: (field: unknown) => (field === undefined ? { file: { extension: "md", path: "Test.md" } } : undefined),
		},
		lineBlockAt: () => ({ top: 0, bottom: 24 }),
		lineBlockAtHeight: () => ({ from: 0, top: 0, bottom: 24 }),
		requestMeasure: (spec: { read: (v: EditorView) => unknown; write: (m: unknown) => void }) => {
			pendingMeasure = spec;
		},
	};
	const host = {
		store: {
			subscribe: vi.fn(() => () => {}),
			load: () => new Promise(() => {}),
			isLoaded: () => true,
			get: emptyInk,
			allStrokes: () => [],
			setContentWidth: vi.fn(),
		},
		getSettings: () => ({ ...DEFAULT_SYNCED, ...defaultLocal(true), pageGuide: "A4" as const }),
		registerInkView: vi.fn(),
		unregisterInkView: vi.fn(),
		penSeen: vi.fn(),
		deskSelect: () => null,
		selectionToolActive: () => false,
	};

	const ink = new InkView(view as unknown as EditorView, host as unknown as InkHost);
	const flushMeasure = () => {
		if (!pendingMeasure) throw new Error("expected pending requestMeasure");
		const m = pendingMeasure;
		pendingMeasure = null;
		m.write(m.read(view as unknown as EditorView));
	};
	flushMeasure();
	const svg = sizerEl.querySelector(".ink-pages-overlay")!;
	const guides = svg.querySelector(".pl-guides")!;
	return { ink, svg, guides, sizerTop, docTop, flushMeasure };
}

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("pageGuides", () => {
	it("computes exact PDF-matching dimensions for A4 and A3 portrait/landscape", () => {
		const a4 = pageGuideMetrics("A4")!;
		const a3 = pageGuideMetrics("A3")!;
		const a4Land = pageGuideMetrics("A4-landscape")!;
		expect(a4.width).toBeGreaterThan(680);
		expect(a4.width).toBeLessThan(760);
		expect(a4.paperWidth).toBe(794);
		expect(a4.marginPx).toBe(38);
		expect(a4.height).toBeGreaterThan(1000);
		expect(a4.height).toBeLessThan(1100);
		expect(a3.width).toBeGreaterThan(a4.width * 1.35);
		expect(a3.paperWidth).toBeGreaterThan(1100);
		expect(a3.height).toBeGreaterThan(a4.height * 1.35);
		expect(a4Land.width).toBeGreaterThan(a4Land.height);
		expect(pageGuideMetrics("off")).toBeNull();
	});

	it("builds horizontal page breaks, full paper frame, and inner print margin bounds", () => {
		const layout = buildPageGuideLayout("A4", 900, 2200)!;
		expect(layout.horizontalBreaks.length).toBeGreaterThanOrEqual(2);
		expect(layout.horizontalBreaks[0]).toBe(layout.metrics.height);
		expect(layout.horizontalBreaks[1]).toBe(layout.metrics.height * 2);
		expect(layout.paperLeftX).toBe(-layout.marginPx);
		expect(layout.paperRightX).toBe(layout.sheetWidth + layout.marginPx);
		expect(layout.paperRightX - layout.paperLeftX).toBe(layout.metrics.width + layout.marginPx * 2);
		expect(layout.overflowX).toBe(layout.metrics.width);
		expect(layout.overflowWidth).toBe(900 - layout.metrics.width);
		expect(layout.guideWidth).toBe(layout.metrics.width);
	});

	it("cycles cleanly through page formats and supplies print config fallbacks", () => {
		expect(nextPageGuide("off")).toBe("A4");
		expect(nextPageGuide("A4")).toBe("A4-landscape");
		expect(nextPageGuide("Letter")).toBe("off");
		expect(pageGuidePrintConfig("A3-landscape")).toEqual({ pageSize: "A3", landscape: true });
		expect(pageGuidePrintConfig("off")).toBeNull();
	});

	it("provides ample scrollable bottom padding on empty notes and clamps labels inside narrow viewports", () => {
		const a4 = pageGuideMetrics("A4")!;
		const blankPad = computeCanvasBottomPadding({
			format: "A4",
			docHeight: 24,
			viewportHeight: 900,
			lowestInkY: 0,
			extraPages: 2,
		});
		expect(blankPad).toBeGreaterThanOrEqual(a4.height * 2);

		const inkPad = computeCanvasBottomPadding({
			format: "A4",
			docHeight: 24,
			viewportHeight: 900,
			lowestInkY: a4.height * 2.5,
			extraPages: 2,
		});
		expect(inkPad).toBeGreaterThan(blankPad);

		// A3 on a narrow 600 px viewport still keeps page labels visible inside the viewport.
		const a3Layout = buildPageGuideLayout("A3", 600, 1500, 600)!;
		expect(a3Layout.sheetWidth).toBeGreaterThan(900);
		expect(a3Layout.labelRightX).toBeLessThanOrEqual(600);
	});

	it("anchors Page 1 and page breaks at negative startY when an inline title precedes documentTop", () => {
		const a4 = pageGuideMetrics("A4")!;
		const layout = buildPageGuideLayout("A4", 700, 2200, 700, -43)!;
		expect(layout.startY).toBe(-43);
		expect(layout.horizontalBreaks[0]).toBe(a4.height - 43);
		expect(layout.horizontalBreaks[1]).toBe(a4.height * 2 - 43);
		expect(layout.endY).toBeGreaterThanOrEqual(2200);
		expect(layout.totalHeight).toBe(layout.endY - (-43));
	});

	it("starts A4 Page 1 at the top of .cm-sizer above visible .inline-title with label clearance above the border", () => {
		const a4 = pageGuideMetrics("A4")!;
		const { svg, guides, sizerTop, docTop } = setupEditorGuides({ inlineTitleVisible: true, scrollerTopPadding: 32 });
		expect(parseFloat(svg.style.top)).toBe(docTop - sizerTop); // 43 px below .cm-sizer top

		const lines = guides.children.filter((el) => el.tagName === "line");
		const topBorder = lines.find((l) => l.attributes.get("y1") === "-43" && l.attributes.get("y2") === "-43");
		expect(topBorder).toBeDefined();

		const leftPaper = lines.find((l) => l.classes.has("pl-guide-paper") && l.attributes.get("x1") === l.attributes.get("x2"));
		expect(leftPaper?.attributes.get("y1")).toBe("-43");

		const firstBreak = lines.find((l) => l.classes.has("pl-guide-break"));
		expect(Number(firstBreak?.attributes.get("y1"))).toBe(a4.height - 43);

		const labels = guides.children.filter((el) => el.tagName === "text");
		const page1Label = labels.find((t) => t.textContent.includes("Seite 1") && !t.textContent.includes("Ende"));
		expect(page1Label).toBeDefined();
		// Placed cleanly above the Page 1 top border (-43), never overlapping .inline-title (-43..-12) or line 1 (0+).
		expect(Number(page1Label!.attributes.get("y"))).toBe(-49);
		expect(page1Label!.attributes.get("x")).toBe("8");
	});

	it("keeps Page 1 at documentTop when .inline-title is hidden and falls back inside Page 1 if scroller has no top padding", () => {
		const a4 = pageGuideMetrics("A4")!;
		const hidden = setupEditorGuides({ inlineTitleVisible: false, scrollerTopPadding: 32 });
		const hiddenTopLine = hidden.guides.children.find(
			(el) => el.tagName === "line" && el.attributes.get("y1") === "0" && el.attributes.get("y2") === "0",
		);
		expect(hiddenTopLine).toBeDefined();
		const hiddenBreak = hidden.guides.children.find((el) => el.classes.has("pl-guide-break"));
		expect(Number(hiddenBreak?.attributes.get("y1"))).toBe(a4.height);
		const hiddenLabel = hidden.guides.children.find(
			(el) => el.tagName === "text" && el.textContent.includes("Seite 1") && !el.textContent.includes("Ende"),
		);
		expect(Number(hiddenLabel?.attributes.get("y"))).toBe(-6);

		const tight = setupEditorGuides({ inlineTitleVisible: true, scrollerTopPadding: 0 });
		const tightLabel = tight.guides.children.find(
			(el) => el.tagName === "text" && el.textContent.includes("Seite 1") && !el.textContent.includes("Ende"),
		);
		expect(Number(tightLabel?.attributes.get("y"))).toBe(-43 + 14);
		expect(tightLabel?.attributes.get("text-anchor")).toBe("end");
	});
});
