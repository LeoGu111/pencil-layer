import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { MarkdownView } from "obsidian";
import { defaultLocal, DEFAULT_SYNCED, PencilSettings } from "../src/settings";

vi.mock("obsidian", async (importOriginal) => {
	const actual = await importOriginal<Record<string, unknown>>();
	class MockMarkdownView {}
	return {
		...actual,
		MarkdownView: MockMarkdownView,
		setIcon(el: { dataset: Record<string, string> }, icon: string) {
			el.dataset.icon = icon;
		},
		setTooltip(el: { setAttribute: (k: string, v: string) => void }, text: string) {
			el.setAttribute("aria-label", text);
			el.setAttribute("data-tooltip", text);
		},
	};
});

class MockNode {
	parentElement: MockEl | null = null;
	children: MockEl[] = [];
	instanceOf(ctor: unknown): boolean {
		return ctor === MockNode || ctor === MockEl;
	}
}

class MockEl extends MockNode {
	readonly tagName: string;
	readonly attrs = new Map<string, string>();
	readonly classes = new Set<string>();
	readonly dataset: Record<string, string> = {};
	readonly style: Record<string, string> = {};
	private readonly listeners = new Map<string, Set<(e: unknown) => void>>();
	private text = "";
	ownerDocument: MockDoc;
	clientWidth = 900;
	clientHeight = 700;
	offsetWidth = 400;
	offsetHeight = 44;
	offsetLeft = 0;
	offsetTop = 0;
	scrollLeft = 0;
	scrollTop = 0;
	scrollWidth = 100;

	constructor(tagName: string, ownerDocument: MockDoc) {
		super();
		this.tagName = tagName;
		this.ownerDocument = ownerDocument;
	}

	get textContent(): string {
		return this.text + this.children.map((c) => c.textContent).join("");
	}

	set textContent(v: string) {
		this.text = v;
	}

	createDiv(opts?: { cls?: string | string[]; text?: string; attr?: Record<string, string> }): MockEl {
		return this.createChild("div", opts);
	}

	createSpan(opts?: { cls?: string | string[]; text?: string; attr?: Record<string, string> }): MockEl {
		return this.createChild("span", opts);
	}

	private createChild(tag: string, opts?: { cls?: string | string[]; text?: string; attr?: Record<string, string> }): MockEl {
		const el = new MockEl(tag, this.ownerDocument);
		if (opts?.cls) {
			const list = Array.isArray(opts.cls) ? opts.cls : opts.cls.split(/\s+/);
			for (const c of list) if (c) el.classes.add(c);
		}
		if (opts?.text !== undefined) el.text = opts.text;
		if (opts?.attr) {
			for (const [k, v] of Object.entries(opts.attr)) el.setAttribute(k, v);
		}
		this.appendChild(el);
		return el;
	}

	appendChild(child: MockEl): MockEl {
		child.remove();
		child.parentElement = this;
		this.children.push(child);
		return child;
	}

	remove(): void {
		if (!this.parentElement) return;
		const idx = this.parentElement.children.indexOf(this);
		if (idx >= 0) this.parentElement.children.splice(idx, 1);
		this.parentElement = null;
	}

	empty(): void {
		for (const c of this.children) c.parentElement = null;
		this.children = [];
		this.text = "";
	}

	before(...nodes: MockEl[]): void {
		if (!this.parentElement) return;
		const parent = this.parentElement;
		for (const n of nodes) {
			n.remove();
			n.parentElement = parent;
			const idx = parent.children.indexOf(this);
			parent.children.splice(idx, 0, n);
		}
	}

	after(...nodes: MockEl[]): void {
		if (!this.parentElement) return;
		const parent = this.parentElement;
		let idx = parent.children.indexOf(this) + 1;
		for (const n of nodes) {
			n.remove();
			n.parentElement = parent;
			parent.children.splice(idx++, 0, n);
		}
	}

	prepend(...nodes: MockEl[]): void {
		for (let i = nodes.length - 1; i >= 0; i--) {
			const n = nodes[i];
			n.remove();
			n.parentElement = this;
			this.children.unshift(n);
		}
	}

	addClass(cls: string): void {
		for (const c of cls.split(/\s+/)) if (c) this.classes.add(c);
	}

	addClasses(list: string[]): void {
		for (const c of list) this.addClass(c);
	}

	removeClass(cls: string): void {
		this.classes.delete(cls);
	}

	toggleClass(cls: string, force?: boolean): void {
		const on = force !== undefined ? force : !this.classes.has(cls);
		if (on) this.classes.add(cls);
		else this.classes.delete(cls);
	}

	hasClass(cls: string): boolean {
		return this.classes.has(cls);
	}

	setText(text: string): void {
		this.children = [];
		this.text = text;
	}

	setAttribute(k: string, v: string): void {
		this.attrs.set(k, v);
	}

	getAttribute(k: string): string | null {
		return this.attrs.get(k) ?? null;
	}

	addEventListener(type: string, fn: (e: unknown) => void): void {
		let set = this.listeners.get(type);
		if (!set) {
			set = new Set();
			this.listeners.set(type, set);
		}
		set.add(fn);
	}

	removeEventListener(type: string, fn: (e: unknown) => void): void {
		this.listeners.get(type)?.delete(fn);
	}

	dispatchEvent(ev: Record<string, unknown>): void {
		const list = this.listeners.get(String(ev.type));
		if (!list) return;
		for (const fn of [...list]) fn(ev);
	}

	contains(target: MockNode | null): boolean {
		let cur: MockNode | null = target;
		while (cur) {
			if (cur === this) return true;
			cur = cur.parentElement;
		}
		return false;
	}

	querySelector(selector: string): MockEl | null {
		if (selector.startsWith(":scope > .")) {
			const cls = selector.slice(":scope > .".length);
			return this.children.find((c) => c.hasClass(cls)) ?? null;
		}
		if (selector.startsWith(".")) {
			const cls = selector.slice(1);
			return this.findAll((c) => c.hasClass(cls))[0] ?? null;
		}
		return null;
	}

	findAll(pred: (el: MockEl) => boolean): MockEl[] {
		const out: MockEl[] = [];
		for (const c of this.children) {
			if (pred(c)) out.push(c);
			out.push(...c.findAll(pred));
		}
		return out;
	}

	getBoundingClientRect() {
		return { left: 0, top: 0, width: 40, height: 36, right: 40, bottom: 36 };
	}
}

class MockDoc {
	private readonly listeners = new Map<string, Set<(e: unknown) => void>>();
	createElementNS(_ns: string, tag: string): MockEl {
		return new MockEl(tag, this);
	}
	addEventListener(type: string, fn: (e: unknown) => void): void {
		let set = this.listeners.get(type);
		if (!set) {
			set = new Set();
			this.listeners.set(type, set);
		}
		set.add(fn);
	}
	removeEventListener(type: string, fn: (e: unknown) => void): void {
		this.listeners.get(type)?.delete(fn);
	}
}

function clickEl(el: MockEl): void {
	el.dispatchEvent({
		type: "click",
		preventDefault() {},
		stopPropagation() {},
	});
}

function tapGrip(grip: MockEl): void {
	grip.dispatchEvent({
		type: "pointerdown",
		pointerId: 1,
		pointerType: "mouse",
		button: 0,
		clientX: 10,
		clientY: 10,
		preventDefault() {},
		stopPropagation() {},
	});
	grip.dispatchEvent({
		type: "pointerup",
		pointerId: 1,
		pointerType: "mouse",
		button: 0,
		clientX: 10,
		clientY: 10,
		preventDefault() {},
		stopPropagation() {},
	});
}

/** Mirrors the display:none rules in styles.css for .ink-pages-toolbar. */
function isVisibleInBar(toolbarEl: MockEl, el: MockEl): boolean {
	const collapsed = toolbarEl.hasClass("is-collapsed");
	const slim = toolbarEl.hasClass("is-slim");
	let cur: MockEl | null = el;
	while (cur) {
		if (cur.hasClass("is-hidden")) return false;
		if (collapsed && cur.hasClass("pl-exp") && !cur.hasClass("is-hosted")) return false;
		if (slim && cur.hasClass("pl-full-only")) return false;
		if (!slim && cur.hasClass("pl-slim-only")) return false;
		if (cur === toolbarEl) break;
		cur = cur.parentElement;
	}
	return true;
}

import { InkToolbar, ToolbarHost } from "../src/toolbar";

interface HarnessOpts {
	isMobile?: boolean;
	mouseDraws?: boolean;
	penDevice?: boolean;
	toolbarCollapsed?: boolean;
}

function createHarness(opts: HarnessOpts = {}) {
	const doc = new MockDoc();
	const containerEl = new MockEl("div", doc);
	const isMobile = opts.isMobile ?? false;
	let settings: PencilSettings = {
		...DEFAULT_SYNCED,
		...defaultLocal(isMobile),
		mouseDraws: opts.mouseDraws ?? false,
		penDevice: opts.penDevice ?? false,
		toolbarCollapsed: opts.toolbarCollapsed ?? false,
	};
	let deskSelecting = false;
	let zoom = 1;
	const actions: string[] = [];
	const view = { containerEl } as unknown as MarkdownView;

	let toolbar!: InkToolbar;
	const host: ToolbarHost = {
		getSettings: () => settings,
		updateSettings(patch) {
			if (deskSelecting && (patch.mouseDraws !== undefined || patch.penDevice !== undefined || patch.inkVisible === false)) {
				deskSelecting = false;
			}
			settings = { ...settings, ...patch };
			toolbar.refresh();
		},
		undoInk: () => actions.push("undo"),
		redoInk: () => actions.push("redo"),
		canUndoInk: () => false,
		canRedoInk: () => false,
		showMouseToggle: !isMobile,
		isSlim: () => !isMobile && !settings.mouseDraws && !settings.penDevice,
		isDeskSelecting: () => deskSelecting && !isMobile && !settings.mouseDraws && !settings.penDevice,
		setDeskSelect(on) {
			deskSelecting = on;
			toolbar.refresh();
		},
		canExportPdf: () => true,
		exportPdf: (_v, choice) => actions.push(`export:${JSON.stringify(choice)}`),
		addBlankPage: () => actions.push("addBlankPage"),
		getZoom: () => zoom,
		zoomIn: () => {
			zoom += 0.25;
			toolbar.refresh();
		},
		zoomOut: () => {
			zoom = Math.max(0.5, zoom - 0.25);
			toolbar.refresh();
		},
		resetZoom: () => {
			zoom = 1;
			toolbar.refresh();
		},
		openAssistantForView: () => actions.push("assistant"),
	};

	toolbar = new InkToolbar(view, host);
	const el = toolbar.el as unknown as MockEl;
	return {
		toolbar,
		el,
		host,
		actions,
		getSettings: () => settings,
		getZoom: () => zoom,
		visibleButtons: () =>
			el
				.querySelector(".pl-capsule")!
				.findAll((b) => b.hasClass("pl-btn") && isVisibleInBar(el, b)),
		moreButton: () =>
			el
				.querySelector(".pl-capsule")!
				.findAll((b) => b.hasClass("pl-btn") && b.dataset.icon === "more-horizontal")[0],
		grip: () => el.querySelector(".pl-capsule")!.findAll((b) => b.hasClass("pl-grip"))[0],
		popover: (): MockEl | null => el.findAll((c) => c.hasClass("pl-popover")).at(0) ?? null,
	};
}

describe("InkToolbar UX (issue #13)", () => {
	const origNode = globalThis.Node;
	const origWindow = globalThis.window;

	beforeEach(() => {
		(globalThis as unknown as { Node: unknown }).Node = MockNode;
		(globalThis as unknown as { window: unknown }).window = {
			requestAnimationFrame: () => 0,
			cancelAnimationFrame: () => {},
			setTimeout: globalThis.setTimeout.bind(globalThis),
			clearTimeout: globalThis.clearTimeout.bind(globalThis),
		};
	});

	afterEach(() => {
		(globalThis as unknown as { Node: unknown }).Node = origNode;
		(globalThis as unknown as { window: unknown }).window = origWindow;
	});

	it("keeps the More (⋯) button visible when collapsed and keeps its popover open across zoom/guide updates", () => {
		const h = createHarness({ isMobile: true });
		expect(isVisibleInBar(h.el, h.moreButton())).toBe(true);

		tapGrip(h.grip());
		expect(h.getSettings().toolbarCollapsed).toBe(true);
		expect(h.el.hasClass("is-collapsed")).toBe(true);
		expect(isVisibleInBar(h.el, h.moreButton())).toBe(true);

		// Opening ⋯ while collapsed gives access to Zoom, Page boundary guides, Hide ink, Export PDF, etc.
		clickEl(h.moreButton());
		let pop = h.popover();
		expect(pop).not.toBeNull();
		if (!pop) throw new Error("expected more popover");
		expect(pop.hasClass("pl-popover-more")).toBe(true);

		const zoomPlus = pop.findAll((c) => c.hasClass("pl-seg-item") && c.textContent === "+")[0];
		expect(zoomPlus).toBeDefined();
		clickEl(zoomPlus);
		expect(h.getZoom()).toBe(1.25);
		// Popover remains open after refresh so users can adjust zoom or page guides repeatedly.
		pop = h.popover();
		expect(pop).not.toBeNull();
		if (!pop) throw new Error("expected more popover after zoom");
		expect(pop.hasClass("pl-popover-more")).toBe(true);

		const a3Guide = pop.findAll((c) => c.hasClass("pl-seg-item") && c.textContent === "A3")[0];
		expect(a3Guide).toBeDefined();
		clickEl(a3Guide);
		expect(h.getSettings().pageGuide).toBe("A3");
		expect(h.popover()).not.toBeNull();
	});

	it("keeps the More (⋯) button visible in collapsed slim desktop mode too and toggles Mouse draws from ⋯", () => {
		const h = createHarness({ isMobile: false, mouseDraws: false, penDevice: false, toolbarCollapsed: true });
		expect(h.el.hasClass("is-collapsed")).toBe(true);
		expect(h.el.hasClass("is-slim")).toBe(true);
		expect(isVisibleInBar(h.el, h.moreButton())).toBe(true);

		clickEl(h.moreButton());
		const pop = h.popover();
		expect(pop).not.toBeNull();
		if (!pop) throw new Error("expected more popover");
		const items = pop.findAll((c) => c.hasClass("pl-menu-item"));
		const mouseIdx = items.findIndex((c) => c.textContent === "Mouse draws");
		expect(mouseIdx).toBeGreaterThanOrEqual(0);
		expect(mouseIdx).toBeLessThan(4);
		clickEl(items[mouseIdx]);
		expect(h.getSettings().mouseDraws).toBe(true);
		expect(h.el.hasClass("is-slim")).toBe(false);
		expect(isVisibleInBar(h.el, h.moreButton())).toBe(true);
	});

	it("shows a one-click Pen / Mouse-draws button on the first-run desktop slim bar", () => {
		const h = createHarness({ isMobile: false, mouseDraws: false, penDevice: false });
		expect(h.el.hasClass("is-slim")).toBe(true);

		// Even if Select was active first, clicking the Pen / Draw with mouse button exits Select and enables drawing.
		const selectBtn = h.visibleButtons().find((b) => b.dataset.tool === "select");
		expect(selectBtn).toBeDefined();
		clickEl(selectBtn!);
		expect(h.host.isDeskSelecting()).toBe(true);

		const buttons = h.visibleButtons();
		const penBtn = buttons.find((b) => b.dataset.icon === "pen-line");
		expect(penBtn).toBeDefined();

		// One click enables mouseDraws and reveals the full drawing tools (Pen, Eraser, Highlighter, Lasso).
		clickEl(penBtn!);
		expect(h.getSettings().mouseDraws).toBe(true);
		expect(h.getSettings().tool).toBe("pen");
		expect(h.host.isDeskSelecting()).toBe(false);
		expect(h.el.hasClass("is-slim")).toBe(false);

		const fullIcons = h.visibleButtons().map((b) => b.dataset.icon);
		expect(fullIcons).toContain("pen-line");
		expect(fullIcons).toContain("eraser");
		expect(fullIcons).toContain("highlighter");
		expect(fullIcons).toContain("lasso");

		// Desktop full bar also exposes a one-click Mouse draws toggle to switch back to typing.
		const mouseBtn = h.visibleButtons().find((b) => b.dataset.icon === "mouse-pointer-2");
		expect(mouseBtn).toBeDefined();
		expect(mouseBtn!.hasClass("is-active")).toBe(true);
		clickEl(mouseBtn!);
		expect(h.getSettings().mouseDraws).toBe(false);
		expect(h.el.hasClass("is-slim")).toBe(true);
	});

	it("shows inactive Mouse draws toggle on desktop when penDevice is true and mouseDraws is false", () => {
		const h = createHarness({ isMobile: false, mouseDraws: false, penDevice: true });
		expect(h.el.hasClass("is-slim")).toBe(false);
		const mouseBtn = h.visibleButtons().find((b) => b.dataset.icon === "mouse-pointer-2");
		expect(mouseBtn).toBeDefined();
		expect(mouseBtn!.hasClass("is-active")).toBe(false);
		clickEl(mouseBtn!);
		expect(h.getSettings().mouseDraws).toBe(true);
	});

	it("never shows desktop Mouse draws buttons on mobile/iPad", () => {
		const h = createHarness({ isMobile: true });
		const icons = h.visibleButtons().map((b) => b.dataset.icon);
		expect(icons).not.toContain("mouse-pointer-2");
		expect(h.el.hasClass("is-slim")).toBe(false);
	});

	it("styles.css matches collapsed and slim visibility assumptions", () => {
		const css = readFileSync(resolve(process.cwd(), "styles.css"), "utf8");
		expect(css).toContain(".ink-pages-toolbar.is-collapsed .pl-exp");
		expect(css).toContain(".ink-pages-toolbar:not(.is-slim) .pl-slim-only");
		expect(css).toContain(".ink-pages-toolbar.is-slim .pl-full-only");
		expect(css).toContain(".ink-pages-toolbar .is-hidden");
	});
});
