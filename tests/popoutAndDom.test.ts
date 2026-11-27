import { EditorState } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InkView, type InkHost } from "../src/inkView";
import { emptyInk, type Stroke } from "../src/model";
import { PageGuidesController } from "../src/pageGuidesView";
import { DEFAULT_SYNCED, defaultLocal, type PencilSettings } from "../src/settings";
import { ZoomController } from "../src/zoomView";

class FakeDomElement extends EventTarget {
	readonly classSet = new Set<string>();
	readonly classList = {
		add: (...cls: string[]) => cls.forEach((c) => this.classSet.add(c)),
		remove: (...cls: string[]) => cls.forEach((c) => this.classSet.delete(c)),
		toggle: (c: string, force?: boolean) => {
			const on = force === undefined ? !this.classSet.has(c) : force;
			if (on) this.classSet.add(c);
			else this.classSet.delete(c);
			return on;
		},
		contains: (c: string) => this.classSet.has(c),
	};
	readonly style: Record<string, string> = {};
	readonly cssProps: Record<string, string> = {};
	readonly children: FakeDomElement[] = [];
	parentElement: FakeDomElement | null = null;
	ownerDocument?: Document;
	offsetWidth = 300;
	offsetHeight = 600;
	offsetLeft = 0;
	offsetTop = 0;
	clientWidth = 300;
	clientHeight = 600;
	scrollLeft = 0;
	scrollTop = 0;
	isConnected = true;

	setCssProps = vi.fn((props: Record<string, string>) => {
		for (const [k, v] of Object.entries(props)) {
			if (v === "") delete this.cssProps[k];
			else this.cssProps[k] = v;
		}
	});
	append = vi.fn((...nodes: FakeDomElement[]) => {
		for (const n of nodes) {
			n.parentElement = this;
			this.children.push(n);
		}
	});
	appendChild = vi.fn((n: FakeDomElement) => {
		n.parentElement = this;
		this.children.push(n);
		return n;
	});
	replaceChildren = vi.fn();
	setAttribute = vi.fn();
	removeAttribute = vi.fn();
	remove = vi.fn();
	contains = (n: unknown) => n === this || this.children.includes(n as FakeDomElement);
	getBoundingClientRect = () => ({ left: 0, top: 0, width: this.offsetWidth, height: this.offsetHeight, bottom: this.offsetHeight });
	setPointerCapture = vi.fn();
	hasPointerCapture = vi.fn(() => false);
	releasePointerCapture = vi.fn();
	createDiv = vi.fn(() => {
		const div = new FakeDomElement();
		div.ownerDocument = this.ownerDocument;
		return div;
	});
}

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

describe("popout window DOM/Window isolation", () => {
	it("uses view.dom.ownerDocument and its defaultView instead of global activeDocument/window", () => {
		const popoutRaf = vi.fn(() => 42);
		const popoutCancelRaf = vi.fn();
		const popoutSetTimeout = vi.fn(() => 99);
		const popoutClearTimeout = vi.fn();
		const popoutGetComputedStyle = vi.fn(() => ({
			paddingLeft: "0",
			paddingRight: "0",
			paddingTop: "0",
			borderLeftWidth: "0",
			borderTopWidth: "0",
			color: "rgb(255, 255, 255)",
			backgroundColor: "rgba(0, 0, 0, 0)",
		}));

		const popoutElements: FakeDomElement[] = [];
		const popoutWin = {
			setTimeout: popoutSetTimeout,
			clearTimeout: popoutClearTimeout,
			requestAnimationFrame: popoutRaf,
			cancelAnimationFrame: popoutCancelRaf,
			getComputedStyle: popoutGetComputedStyle,
		};
		const popoutCreateElementNS = vi.fn(() => {
			const el = new FakeDomElement();
			el.ownerDocument = popoutDoc;
			popoutElements.push(el);
			return el;
		});
		const popoutDoc = {
			defaultView: popoutWin,
			body: { classList: { contains: (c: string) => c === "theme-dark" } },
			createElementNS: popoutCreateElementNS,
		} as unknown as Document;

		// Poison the main-window globals to prove InkView never touches them when view.dom.ownerDocument is present.
		const globalCreateElementNS = vi.fn(() => {
			throw new Error("should not call global activeDocument.createElementNS");
		});
		const globalRaf = vi.fn(() => {
			throw new Error("should not call global window.requestAnimationFrame");
		});
		const globalSetTimeout = vi.fn(() => {
			throw new Error("should not call global window.setTimeout");
		});
		vi.stubGlobal("activeDocument", {
			createElementNS: globalCreateElementNS,
			body: { classList: { contains: () => false } },
		});
		vi.stubGlobal("window", {
			setTimeout: globalSetTimeout,
			clearTimeout: vi.fn(),
			requestAnimationFrame: globalRaf,
			cancelAnimationFrame: vi.fn(),
			getComputedStyle: () => {
				throw new Error("should not call global getComputedStyle");
			},
		});
		vi.stubGlobal("getComputedStyle", () => {
			throw new Error("should not call global getComputedStyle");
		});

		const dom = new FakeDomElement();
		dom.ownerDocument = popoutDoc;
		const scrollDOM = new FakeDomElement();
		scrollDOM.ownerDocument = popoutDoc;
		const contentDOM = new FakeDomElement();
		contentDOM.ownerDocument = popoutDoc;

		const state = EditorState.create({ doc: "Popout note" });
		const view = {
			dom,
			scrollDOM,
			contentDOM,
			state: {
				doc: state.doc,
				selection: state.selection,
				field: (field: unknown) => (field === undefined ? { file: { extension: "md", path: "Popout.md" } } : undefined),
			},
			documentTop: 0,
			scaleX: 1,
			scaleY: 1,
			lineBlockAt: () => ({ top: 0, bottom: 20 }),
			lineBlockAtHeight: () => ({ from: 0, top: 0, bottom: 20 }),
			requestMeasure: vi.fn(),
		};
		const stroke: Stroke = {
			id: "p1",
			tool: "pen",
			color: "ink",
			size: 2,
			anchor: { line: 0, hash: "" },
			points: [[10, 10, 0.5], [40, 20, 0.5]],
			pos: 0,
		};
		const host = {
			store: {
				subscribe: vi.fn(),
				load: () => new Promise(() => {}),
				isLoaded: () => true,
				get: () => ({ version: 2, strokes: [stroke] }),
				allStrokes: () => [stroke],
				setContentWidth: vi.fn(),
				addStroke: vi.fn(),
			},
			getSettings: () => ({ ...DEFAULT_SYNCED, ...defaultLocal(false), tool: "pen", mouseDraws: true, doubleTapEraser: false }),
			registerInkView: vi.fn(),
			unregisterInkView: vi.fn(),
			penSeen: vi.fn(),
			deskSelect: () => null,
			selectionToolActive: () => false,
			inkSelectionChanged: vi.fn(),
		};

		const ink = new InkView(view as unknown as EditorView, host as unknown as InkHost);
		expect(popoutCreateElementNS).toHaveBeenCalled();
		expect(globalCreateElementNS).not.toHaveBeenCalled();

		// Trigger pointerdown/pointermove to verify RAF + hold timer use popout window, not global window.
		scrollDOM.dispatchEvent(
			Object.assign(new Event("pointerdown", { cancelable: true }), {
				pointerId: 1,
				pointerType: "pen",
				button: 0,
				buttons: 1,
				clientX: 15,
				clientY: 15,
				pressure: 0.5,
				tiltX: 0,
				tiltY: 0,
			}),
		);
		expect(popoutRaf).toHaveBeenCalled();
		expect(popoutSetTimeout).toHaveBeenCalled();
		expect(popoutGetComputedStyle).toHaveBeenCalled();
		expect(globalRaf).not.toHaveBeenCalled();
		expect(globalSetTimeout).not.toHaveBeenCalled();

		// Verify lookAndFeel resolves dark theme from popoutDoc.body, not global activeDocument.body.
		const look = (ink as unknown as { lookAndFeel: () => { background: string; paint: { dark: boolean } } }).lookAndFeel();
		expect(look.background).toBe("#1e1e1e");
		expect(look.paint.dark).toBe(true);

		ink.destroy();
		expect(popoutCancelRaf).toHaveBeenCalledWith(42);
		expect(popoutClearTimeout).toHaveBeenCalledWith(99);
	});
});

describe("non-intrusive editor DOM overrides", () => {
	it("applies canvas bottom room only when ink is visible and cleans up on hide/destroy", () => {
		const contentDOM = new FakeDomElement();
		const scrollDOM = new FakeDomElement();
		const doc = { createElementNS: vi.fn(() => new FakeDomElement()) } as unknown as Document;
		contentDOM.ownerDocument = doc;
		scrollDOM.ownerDocument = doc;
		const view = {
			contentDOM,
			scrollDOM,
			contentHeight: 24,
			scaleY: 1,
		} as unknown as EditorView;

		const pg = new PageGuidesController(view);
		const visibleSettings: PencilSettings = { ...DEFAULT_SYNCED, ...defaultLocal(true), inkVisible: true, pageGuide: "A4" };
		pg.syncCanvasRoom(emptyInk(), visibleSettings, true, () => 0, () => ({ minX: 0, minY: 0, maxX: 0, maxY: 0 }));
		expect(contentDOM.classList.contains("pl-canvas-room")).toBe(true);
		expect(contentDOM.cssProps["--pl-canvas-pad-bottom"]).toMatch(/^\d+px$/);

		// Hiding ink removes the room class and CSS variable override.
		pg.syncCanvasRoom(emptyInk(), { ...visibleSettings, inkVisible: false }, true, () => 0, () => ({ minX: 0, minY: 0, maxX: 0, maxY: 0 }));
		expect(contentDOM.classList.contains("pl-canvas-room")).toBe(false);
		expect(contentDOM.cssProps["--pl-canvas-pad-bottom"]).toBeUndefined();

		pg.syncCanvasRoom(emptyInk(), visibleSettings, true, () => 0, () => ({ minX: 0, minY: 0, maxX: 0, maxY: 0 }));
		expect(contentDOM.classList.contains("pl-canvas-room")).toBe(true);
		pg.destroy();
		expect(contentDOM.classList.contains("pl-canvas-room")).toBe(false);
		expect(contentDOM.cssProps["--pl-canvas-pad-bottom"]).toBeUndefined();
	});

	it("applies .cm-sizer zoom CSS custom properties only while zoomed and clears them at 100% / destroy", () => {
		const scrollDOM = new FakeDomElement();
		const sizer = new FakeDomElement();
		sizer.classList.add("cm-sizer");
		sizer.offsetWidth = 700;
		const contentDOM = new FakeDomElement();
		contentDOM.parentElement = sizer;
		sizer.children.push(contentDOM);
		scrollDOM.children.push(sizer);
		const svg = new FakeDomElement() as unknown as SVGSVGElement;
		const view = { scrollDOM, contentDOM } as unknown as EditorView;

		const zoom = new ZoomController(view, svg, {
			getOverlayGeo: () => ({ width: 700, height: 1000 }),
			onZoomApplied: vi.fn(),
			onZoomNeedsRender: vi.fn(),
		});
		zoom.mountOverlay();
		expect(sizer.classList.contains("pl-zoom-target")).toBe(false);
		expect(sizer.cssProps["--pl-zoom-scale"]).toBeUndefined();

		zoom.setZoom(1.5);
		expect(sizer.classList.contains("pl-zoom-target")).toBe(true);
		expect(sizer.cssProps["--pl-zoom-scale"]).toBe("1.5");
		expect(sizer.cssProps["--pl-zoom-width"]).toBe("700px");

		zoom.resetZoom();
		expect(sizer.classList.contains("pl-zoom-target")).toBe(false);
		expect(sizer.cssProps["--pl-zoom-scale"]).toBeUndefined();
		expect(sizer.cssProps["--pl-zoom-width"]).toBeUndefined();

		zoom.setZoom(2);
		zoom.destroy();
		expect(sizer.classList.contains("pl-zoom-target")).toBe(false);
		expect(sizer.classList.contains("pl-zoom-host")).toBe(false);
		expect(sizer.cssProps["--pl-zoom-scale"]).toBeUndefined();
	});
});
