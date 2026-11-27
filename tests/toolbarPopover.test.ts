import { EditorState } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import type { MarkdownView } from "obsidian";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InkView, type InkHost } from "../src/inkView";
import type { Stroke } from "../src/model";
import { DEFAULT_SYNCED, defaultLocal, type PencilSettings } from "../src/settings";
import { InkToolbar, type ToolbarHost } from "../src/toolbar";

vi.mock("obsidian", () => ({
	Platform: { isIosApp: false },
	editorInfoField: undefined,
	Modal: class {},
	Notice: class {},
	setIcon: vi.fn(),
	setTooltip: vi.fn(),
}));

class FakeDomEvent {
	target: FakeNode | null = null;
	currentTarget: FakeNode | null = null;
	defaultPrevented = false;
	propagationStopped = false;
	immediateStopped = false;
	readonly bubbles: boolean;
	readonly cancelable: boolean;
	readonly type: string;
	readonly timeStamp = 10;

	constructor(type: string, init: { bubbles?: boolean; cancelable?: boolean } = {}) {
		this.type = type;
		this.bubbles = init.bubbles ?? true;
		this.cancelable = init.cancelable ?? true;
	}

	preventDefault(): void {
		if (this.cancelable) this.defaultPrevented = true;
	}

	stopPropagation(): void {
		this.propagationStopped = true;
	}

	stopImmediatePropagation(): void {
		this.propagationStopped = true;
		this.immediateStopped = true;
	}
}

interface ListenerEntry {
	type: string;
	fn: (e: FakeDomEvent) => void;
	capture: boolean;
}

class FakeNode {
	parentElement: FakeNode | null = null;
	readonly children: FakeNode[] = [];
	readonly listeners: ListenerEntry[] = [];
	ownerDocument: FakeDocument;

	constructor(ownerDocument?: FakeDocument) {
		this.ownerDocument = ownerDocument ?? (this as unknown as FakeDocument);
	}

	get isConnected(): boolean {
		if (this === (this.ownerDocument as FakeNode)) return true;
		for (let cur = this.parentElement; cur; cur = cur.parentElement) {
			if (cur === this.ownerDocument) return true;
		}
		return false;
	}

	instanceOf(ctor: unknown): boolean {
		return ctor === FakeNode || (typeof Node !== "undefined" && ctor === Node);
	}

	contains(other: FakeNode | null): boolean {
		let cur = other;
		while (cur) {
			if (cur === this) return true;
			cur = cur.parentElement;
		}
		return false;
	}

	append(...nodes: FakeNode[]): void {
		for (const n of nodes) this.appendChild(n);
	}

	appendChild<T extends FakeNode>(node: T): T {
		if (node.parentElement) {
			const idx = node.parentElement.children.indexOf(node);
			if (idx >= 0) node.parentElement.children.splice(idx, 1);
		}
		node.parentElement = this;
		this.children.push(node);
		return node;
	}

	before(node: FakeNode): void {
		const parent = this.parentElement;
		if (!parent) return;
		if (node.parentElement) {
			const oldIdx = node.parentElement.children.indexOf(node);
			if (oldIdx >= 0) node.parentElement.children.splice(oldIdx, 1);
		}
		const idx = parent.children.indexOf(this);
		node.parentElement = parent;
		parent.children.splice(idx, 0, node);
	}

	prepend(node: FakeNode): void {
		if (node.parentElement) {
			const idx = node.parentElement.children.indexOf(node);
			if (idx >= 0) node.parentElement.children.splice(idx, 1);
		}
		node.parentElement = this;
		this.children.unshift(node);
	}

	after(node: FakeNode): void {
		const parent = this.parentElement;
		if (!parent) return;
		if (node.parentElement) {
			const oldIdx = node.parentElement.children.indexOf(node);
			if (oldIdx >= 0) node.parentElement.children.splice(oldIdx, 1);
		}
		const idx = parent.children.indexOf(this);
		node.parentElement = parent;
		parent.children.splice(idx + 1, 0, node);
	}

	remove(): void {
		if (!this.parentElement) return;
		const idx = this.parentElement.children.indexOf(this);
		if (idx >= 0) this.parentElement.children.splice(idx, 1);
		this.parentElement = null;
	}

	addEventListener(type: string, fn: (e: FakeDomEvent) => void, opts?: boolean | { capture?: boolean }): void {
		const capture = typeof opts === "boolean" ? opts : !!opts?.capture;
		this.listeners.push({ type, fn, capture });
	}

	removeEventListener(type: string, fn: (e: FakeDomEvent) => void, opts?: boolean | { capture?: boolean }): void {
		const capture = typeof opts === "boolean" ? opts : !!opts?.capture;
		const idx = this.listeners.findIndex((l) => l.type === type && l.fn === fn && l.capture === capture);
		if (idx >= 0) this.listeners.splice(idx, 1);
	}

	dispatchEvent(event: FakeDomEvent): boolean {
		event.target = this;
		const path: FakeNode[] = [this];
		for (let cur = this.parentElement; cur; cur = cur.parentElement) path.push(cur);

		const invoke = (node: FakeNode, captureOnly: boolean | null) => {
			event.currentTarget = node;
			const snapshot = [...node.listeners];
			for (const l of snapshot) {
				if (l.type !== event.type) continue;
				if (captureOnly !== null && l.capture !== captureOnly) continue;
				l.fn(event);
				if (event.immediateStopped) break;
			}
		};

		for (let i = path.length - 1; i >= 1 && !event.propagationStopped; i--) {
			invoke(path[i], true);
		}
		if (!event.propagationStopped) invoke(path[0], null);
		if (event.bubbles) {
			for (let i = 1; i < path.length && !event.propagationStopped; i++) {
				invoke(path[i], false);
			}
		}
		return !event.defaultPrevented;
	}
}

class FakeElement extends FakeNode {
	readonly classes = new Set<string>();
	readonly attrs = new Map<string, string>();
	readonly style: Record<string, string> = {};
	readonly dataset: Record<string, string> = {};
	textContent = "";
	offsetWidth = 360;
	offsetHeight = 44;
	offsetLeft = 200;
	offsetTop = 500;
	clientWidth = 800;
	clientHeight = 700;
	scrollLeft = 0;
	scrollTop = 0;

	readonly classList = {
		add: (...cls: string[]) => cls.forEach((c) => this.classes.add(c)),
		remove: (...cls: string[]) => cls.forEach((c) => this.classes.delete(c)),
		toggle: (c: string, force?: boolean) => {
			if (force === undefined ? !this.classes.has(c) : force) this.classes.add(c);
			else this.classes.delete(c);
		},
		contains: (c: string) => this.classes.has(c),
	};

	constructor(
		ownerDocument: FakeDocument,
		readonly tagName = "div",
	) {
		super(ownerDocument);
	}

	addClass(c: string): void {
		this.classes.add(c);
	}

	addClasses(cs: string[]): void {
		for (const c of cs) this.classes.add(c);
	}

	removeClass(c: string): void {
		this.classes.delete(c);
	}

	toggleClass(c: string, on: boolean): void {
		this.classList.toggle(c, on);
	}

	hasClass(c: string): boolean {
		return this.classes.has(c);
	}

	setAttribute(k: string, v: string): void {
		this.attrs.set(k, v);
	}

	getAttribute(k: string): string | null {
		return this.attrs.get(k) ?? null;
	}

	removeAttribute(k: string): void {
		this.attrs.delete(k);
	}

	setText(text: string): void {
		this.textContent = text;
	}

	setCssProps = vi.fn((props: Record<string, string>) => {
		Object.assign(this.style, props);
	});

	replaceChildren(...nodes: FakeNode[]): void {
		for (const c of [...this.children]) c.parentElement = null;
		this.children.length = 0;
		this.append(...nodes);
	}

	empty(): void {
		this.replaceChildren();
		this.textContent = "";
	}

	createDiv(opts: { cls?: string; text?: string; attr?: Record<string, string> } = {}): FakeElement {
		const el = new FakeElement(this.ownerDocument, "div");
		if (opts.cls) for (const c of opts.cls.split(/\s+/).filter(Boolean)) el.classes.add(c);
		if (opts.text !== undefined) el.textContent = opts.text;
		if (opts.attr) for (const [k, v] of Object.entries(opts.attr)) el.setAttribute(k, v);
		return this.appendChild(el);
	}

	createSpan(opts: { cls?: string; text?: string; attr?: Record<string, string> } = {}): FakeElement {
		const el = new FakeElement(this.ownerDocument, "span");
		if (opts.cls) for (const c of opts.cls.split(/\s+/).filter(Boolean)) el.classes.add(c);
		if (opts.text !== undefined) el.textContent = opts.text;
		if (opts.attr) for (const [k, v] of Object.entries(opts.attr)) el.setAttribute(k, v);
		return this.appendChild(el);
	}

	querySelector(sel: string): FakeElement | null {
		const cls = sel.replace(/^:scope\s*>\s*/, "").replace(/^\./, "");
		const directOnly = sel.startsWith(":scope >");
		const visit = (node: FakeNode, depth: number): FakeElement | null => {
			for (const c of node.children) {
				if (c instanceof FakeElement && c.classes.has(cls)) return c;
				if (!directOnly || depth === 0) {
					const found = visit(c, depth + 1);
					if (found) return found;
				}
			}
			return null;
		};
		return visit(this, 0);
	}

	getBoundingClientRect = () => ({ left: 0, top: 0, width: 800, height: 700, bottom: 700 });
	closest = () => null;
	setPointerCapture = vi.fn();
	hasPointerCapture = vi.fn(() => true);
	releasePointerCapture = vi.fn();
}

class FakeDocument extends FakeNode {
	readonly body: FakeElement;
	activeElement: FakeElement | null = null;

	constructor() {
		super();
		this.ownerDocument = this;
		this.body = new FakeElement(this, "body");
		this.appendChild(this.body);
	}

	createElementNS(_ns: string, tag: string): FakeElement {
		return new FakeElement(this, tag);
	}
}

function setupScene(initialSettings: Partial<PencilSettings> = {}) {
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
	const doc = new FakeDocument();
	vi.stubGlobal("window", { setTimeout, clearTimeout, requestAnimationFrame: vi.fn(() => 1), cancelAnimationFrame: vi.fn() });
	vi.stubGlobal("getComputedStyle", () => ({ paddingLeft: "0", paddingRight: "0", paddingTop: "0", borderLeftWidth: "0", borderTopWidth: "0", borderRightWidth: "0" }));
	vi.stubGlobal("activeDocument", doc);
	vi.stubGlobal("Node", FakeNode);
	vi.stubGlobal("Element", FakeElement);

	const leafEl = doc.body.createDiv({ cls: "workspace-leaf-content" });
	const scrollDOM = leafEl.createDiv({ cls: "cm-scroller" });
	const contentDOM = scrollDOM.createDiv({ cls: "cm-content" });

	let settings: PencilSettings = {
		...DEFAULT_SYNCED,
		...defaultLocal(false),
		tool: "pen",
		mouseDraws: true,
		doubleTapEraser: false,
		...initialSettings,
	};

	const addStroke = vi.fn<(path: string, stroke: Stroke) => void>();
	const removeStrokes = vi.fn();
	const state = EditorState.create({ doc: "Hello note" });
	const editorView = {
		dom: scrollDOM,
		scrollDOM,
		contentDOM,
		state: {
			doc: state.doc,
			selection: state.selection,
			field: (field: unknown) => (field === undefined ? { file: { extension: "md", path: "Test.md" } } : undefined),
		},
		documentTop: 0,
		defaultLineHeight: 24,
		defaultCharacterWidth: 8,
		lineBlockAt: () => ({ from: 0, top: 0, bottom: 24 }),
		lineBlockAtHeight: () => ({ from: 0, top: 0, bottom: 24 }),
		coordsAtPos: () => ({ left: 0, right: 8, top: 0, bottom: 24 }),
		posAtCoords: () => 0,
		requestMeasure: vi.fn(),
		dispatch: vi.fn(),
		focus: vi.fn(),
	};

	let toolbar: InkToolbar;
	let inkView: InkView;
	const strokes: Stroke[] = [];

	const inkHost: InkHost = {
		store: {
			subscribe: vi.fn(() => () => {}),
			load: () => new Promise(() => {}),
			isLoaded: () => true,
			get: () => ({ version: 2, strokes }),
			allStrokes: () => strokes,
			setContentWidth: vi.fn(),
			addStroke,
			removeStrokes,
		} as unknown as InkHost["store"],
		getSettings: () => settings,
		isRenaming: () => false,
		showInk: vi.fn(),
		toggleEraser: vi.fn(),
		registerInkView: vi.fn(),
		unregisterInkView: vi.fn(),
		clipboard: null,
		openScreenshot: vi.fn(),
		deskSelect: () => null,
		selectionToolActive: () => settings.tool === "lasso",
		deskSelectionMade: vi.fn(),
		exitDeskSelect: vi.fn(),
		inkSelectionChanged: vi.fn(),
		penSeen: vi.fn(),
	};

	const toolbarHost: ToolbarHost = {
		getSettings: () => settings,
		updateSettings: (patch) => {
			settings = { ...settings, ...patch };
			inkView.refresh();
			toolbar.refresh();
		},
		undoInk: vi.fn(),
		redoInk: vi.fn(),
		canUndoInk: () => false,
		canRedoInk: () => false,
		showMouseToggle: true,
		isSlim: () => !settings.mouseDraws && !settings.penDevice,
		isDeskSelecting: () => false,
		setDeskSelect: vi.fn(),
		canExportPdf: () => false,
		exportPdf: vi.fn(),
		addBlankPage: vi.fn(),
		getZoom: () => 1,
		zoomIn: vi.fn(),
		zoomOut: vi.fn(),
		resetZoom: vi.fn(),
		openAssistantForView: vi.fn(),
	};

	const mdView = { containerEl: leafEl } as unknown as MarkdownView;
	inkView = new InkView(editorView as unknown as EditorView, inkHost);
	toolbar = new InkToolbar(mdView, toolbarHost);

	const dispatchPointer = (
		target: FakeNode,
		type: string,
		opts: { pointerType?: string; pointerId?: number; button?: number; clientX?: number; clientY?: number } = {},
	) => {
		const ev = Object.assign(new FakeDomEvent(type, { cancelable: type !== "pointercancel" }), {
			pointerId: opts.pointerId ?? 1,
			pointerType: opts.pointerType ?? "mouse",
			button: opts.button ?? 0,
			buttons: type === "pointerdown" || type === "pointermove" ? 1 : 0,
			isPrimary: true,
			clientX: opts.clientX ?? 120,
			clientY: opts.clientY ?? 140,
			pressure: 0.5,
			tiltX: 0,
			tiltY: 0,
		});
		target.dispatchEvent(ev);
		return ev;
	};

	const dispatchMouse = (target: FakeNode, type: string, clientX = 120, clientY = 140, button = 0) => {
		const ev = Object.assign(new FakeDomEvent(type, { cancelable: true }), {
			button,
			clientX,
			clientY,
		});
		target.dispatchEvent(ev);
		return ev;
	};

	const clickTarget = (target: FakeNode, pointerType = "mouse", pointerId = 1) => {
		const pd = dispatchPointer(target, "pointerdown", { pointerType, pointerId });
		const md = pointerType === "mouse" ? dispatchMouse(target, "mousedown") : null;
		const pu = dispatchPointer(target, "pointerup", { pointerType, pointerId });
		const mu = pointerType === "mouse" ? dispatchMouse(target, "mouseup") : null;
		const cl = dispatchMouse(target, "click");
		return { pd, md, pu, mu, cl };
	};

	const openPopoverButton = (ariaPrefix: string) => {
		const findBtn = (node: FakeNode): FakeElement | null => {
			for (const c of node.children) {
				if (c instanceof FakeElement && (c.getAttribute("aria-label") ?? "").startsWith(ariaPrefix)) return c;
				const nested = findBtn(c);
				if (nested) return nested;
			}
			return null;
		};
		const btn = findBtn(toolbar.el as unknown as FakeNode);
		if (!btn) throw new Error(`Button not found: ${ariaPrefix}`);
		clickTarget(btn);
		return btn;
	};

	return { doc, leafEl, scrollDOM, contentDOM, toolbar, inkView, addStroke, removeStrokes, strokes, getSettings: () => settings, dispatchPointer, dispatchMouse, clickTarget, openPopoverButton };
}

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

describe("toolbar popover outside dismissal", () => {
	it("clicking outside an open popover with Mouse draws on dismisses it without drawing a dot, then allows subsequent strokes", () => {
		const { leafEl, contentDOM, addStroke, dispatchPointer, clickTarget, openPopoverButton } = setupScene({
			tool: "pen",
			mouseDraws: true,
		});

		openPopoverButton("More");
		expect(leafEl.querySelector(".pl-popover")).not.toBeNull();

		// Dismiss the popover by clicking on the note canvas.
		const dismissed = clickTarget(contentDOM, "mouse", 1);
		expect(leafEl.querySelector(".pl-popover")).toBeNull();
		expect(dismissed.pd.defaultPrevented).toBe(true);
		expect(dismissed.md!.defaultPrevented).toBe(true);
		expect(dismissed.cl.defaultPrevented).toBe(true);
		expect(addStroke).not.toHaveBeenCalled();

		// The next mouse drag on the note canvas draws normally.
		dispatchPointer(contentDOM, "pointerdown", { pointerType: "mouse", pointerId: 1, clientX: 40, clientY: 50 });
		dispatchPointer(contentDOM, "pointermove", { pointerType: "mouse", pointerId: 1, clientX: 90, clientY: 60 });
		dispatchPointer(contentDOM, "pointerup", { pointerType: "mouse", pointerId: 1, clientX: 90, clientY: 60 });
		expect(addStroke).toHaveBeenCalledOnce();
	});

	it("consumes outside dismissal for Highlighter, Eraser, and Ruler popovers too", () => {
		const { leafEl, contentDOM, addStroke, clickTarget, openPopoverButton } = setupScene({
			tool: "highlighter",
			mouseDraws: true,
			ruler: true,
		});

		// Tap active Highlighter tool to open its popover.
		openPopoverButton("Highlighter");
		expect(leafEl.querySelector(".pl-popover-highlighter")).not.toBeNull();
		clickTarget(contentDOM, "mouse", 1);
		expect(leafEl.querySelector(".pl-popover")).toBeNull();
		expect(addStroke).not.toHaveBeenCalled();

		// Open Ruler popover and dismiss by clicking outside.
		openPopoverButton("Lineal");
		expect(leafEl.querySelector(".pl-popover-ruler")).not.toBeNull();
		clickTarget(contentDOM, "mouse", 1);
		expect(leafEl.querySelector(".pl-popover")).toBeNull();
		expect(addStroke).not.toHaveBeenCalled();
	});

	it("consumes Apple Pencil tap outside popover without drawing a dot and allows immediate next pen stroke", () => {
		const { leafEl, contentDOM, addStroke, dispatchPointer, openPopoverButton } = setupScene({
			tool: "pen",
			mouseDraws: false,
		});

		openPopoverButton("More");
		expect(leafEl.querySelector(".pl-popover-more")).not.toBeNull();

		// Apple Pencil taps outside (WebKit often omits click for pen taps).
		const pd = dispatchPointer(contentDOM, "pointerdown", { pointerType: "pen", pointerId: 7, clientX: 120, clientY: 140 });
		const pu = dispatchPointer(contentDOM, "pointerup", { pointerType: "pen", pointerId: 7, clientX: 120, clientY: 140 });
		expect(pd.defaultPrevented).toBe(true);
		expect(pu.defaultPrevented).toBe(true);
		expect(leafEl.querySelector(".pl-popover")).toBeNull();
		expect(addStroke).not.toHaveBeenCalled();

		// Immediate next pen stroke draws normally without waiting for any timer.
		dispatchPointer(contentDOM, "pointerdown", { pointerType: "pen", pointerId: 8, clientX: 30, clientY: 40 });
		dispatchPointer(contentDOM, "pointermove", { pointerType: "pen", pointerId: 8, clientX: 80, clientY: 40 });
		dispatchPointer(contentDOM, "pointerup", { pointerType: "pen", pointerId: 8, clientX: 80, clientY: 40 });
		expect(addStroke).toHaveBeenCalledOnce();
	});

	it("closes popover on touch start outside without blocking native finger scroll", () => {
		const { leafEl, contentDOM, addStroke, dispatchPointer, openPopoverButton } = setupScene({
			tool: "pen",
			mouseDraws: true,
		});

		openPopoverButton("More");
		expect(leafEl.querySelector(".pl-popover-more")).not.toBeNull();

		const pd = dispatchPointer(contentDOM, "pointerdown", { pointerType: "touch", pointerId: 12 });
		expect(pd.defaultPrevented).toBe(true);
		expect(leafEl.querySelector(".pl-popover")).toBeNull();

		// Finger touchmove for scrolling is NOT blocked by the popover dismissal guard.
		const finger = { touchType: "direct", clientX: 120, clientY: 160 };
		const ts = Object.assign(new FakeDomEvent("touchstart", { cancelable: true }), { changedTouches: [finger], touches: [finger] });
		const tm = Object.assign(new FakeDomEvent("touchmove", { cancelable: true }), { changedTouches: [finger], touches: [finger] });
		expect(contentDOM.dispatchEvent(ts)).toBe(true);
		expect(contentDOM.dispatchEvent(tm)).toBe(true);

		// Scrolling cancels the pointer; subsequent mouse click draws normally.
		dispatchPointer(contentDOM, "pointercancel", { pointerType: "touch", pointerId: 12 });
		dispatchPointer(contentDOM, "pointerdown", { pointerType: "mouse", pointerId: 1, clientX: 20, clientY: 30 });
		dispatchPointer(contentDOM, "pointermove", { pointerType: "mouse", pointerId: 1, clientX: 70, clientY: 30 });
		dispatchPointer(contentDOM, "pointerup", { pointerType: "mouse", pointerId: 1, clientX: 70, clientY: 30 });
		expect(addStroke).toHaveBeenCalledOnce();
	});

	it("allows clicking toolbar items inside the popover without dismissing prematurely", () => {
		const { leafEl, openPopoverButton, toolbar, clickTarget, getSettings } = setupScene({
			tool: "pen",
			mouseDraws: true,
		});

		openPopoverButton("More");
		const pop = leafEl.querySelector(".pl-popover-more");
		expect(pop).not.toBeNull();
		expect(toolbar.el.contains(pop as unknown as Node)).toBe(true);

		const findByText = (node: FakeNode, text: string): FakeElement | null => {
			for (const c of node.children) {
				if (c instanceof FakeElement && c.textContent === text) return c;
				const nested = findByText(c, text);
				if (nested) return nested;
			}
			return null;
		};
		const toggleItem = findByText(pop!, "Mouse draws");
		expect(toggleItem).not.toBeNull();
		clickTarget(toggleItem!.parentElement!, "mouse", 1);
		expect(getSettings().mouseDraws).toBe(false);
		expect(leafEl.querySelector(".pl-popover")).toBeNull();
	});

	it("consumes outside right-click contextmenu and cleans up guard listeners on destroy", () => {
		const { doc, leafEl, contentDOM, openPopoverButton, dispatchPointer, dispatchMouse, toolbar } = setupScene({
			tool: "eraser",
			mouseDraws: true,
		});

		openPopoverButton("Eraser");
		expect(leafEl.querySelector(".pl-popover-eraser")).not.toBeNull();

		const pd = dispatchPointer(contentDOM, "pointerdown", { pointerType: "mouse", pointerId: 1, button: 2 });
		const md = dispatchMouse(contentDOM, "mousedown", 120, 140, 2);
		const pu = dispatchPointer(contentDOM, "pointerup", { pointerType: "mouse", pointerId: 1, button: 2 });
		const mu = dispatchMouse(contentDOM, "mouseup", 120, 140, 2);
		const cm = dispatchMouse(contentDOM, "contextmenu", 120, 140, 2);

		expect(pd.defaultPrevented).toBe(true);
		expect(md.defaultPrevented).toBe(true);
		expect(pu.defaultPrevented).toBe(true);
		expect(mu.defaultPrevented).toBe(true);
		expect(cm.defaultPrevented).toBe(true);
		expect(leafEl.querySelector(".pl-popover")).toBeNull();

		// If destroyed mid-dismissal before pointerup, document listeners are cleaned up.
		openPopoverButton("Eraser");
		dispatchPointer(contentDOM, "pointerdown", { pointerType: "mouse", pointerId: 1 });
		toolbar.destroy();
		expect(doc.listeners).toHaveLength(0);
	});
});
