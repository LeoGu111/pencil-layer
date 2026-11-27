import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { emptyInk, hashLine, type InkFile, type Stroke } from "../src/model";
import { DEFAULT_SYNCED, defaultLocal } from "../src/settings";

vi.mock("obsidian", () => {
	class TFile {
		path: string;
		extension = "md";
		constructor(path: string) {
			this.path = path;
		}
	}
	class MarkdownView {}
	class MarkdownRenderChild {
		constructor(public containerEl: unknown) {}
		onload() {}
		onunload() {}
	}
	return { TFile, MarkdownView, MarkdownRenderChild };
});

import { TFile, type MarkdownPostProcessorContext, type Plugin } from "obsidian";
import { ReadingInk, type ReadingHost } from "../src/readingView";

class FakeClassList {
	private readonly set = new Set<string>();
	constructor(initial: string[] = []) {
		for (const c of initial) this.set.add(c);
	}
	add(...tokens: string[]) {
		for (const t of tokens) {
			for (const part of t.split(/\s+/)) if (part) this.set.add(part);
		}
	}
	remove(...tokens: string[]) {
		for (const t of tokens) this.set.delete(t);
	}
	contains(token: string) {
		return this.set.has(token);
	}
	toggle(token: string, force?: boolean) {
		if (force === undefined) {
			if (this.set.has(token)) this.set.delete(token);
			else this.set.add(token);
		} else if (force) this.set.add(token);
		else this.set.delete(token);
	}
	[Symbol.iterator]() {
		return this.set.values();
	}
}

class FakeStyle {
	[key: string]: unknown;
	position = "";
	left = "";
	top = "";
	width = "";
	height = "";
	overflow = "";
	pointerEvents = "";
	zIndex = "";
	mixBlendMode = "";
	marginBottom = "";
	removeProperty(name: string) {
		if (name === "margin-bottom") this.marginBottom = "";
		if (name === "position") this.position = "";
	}
	setProperty(name: string, val: string) {
		this[name] = val;
	}
}

class FakeDomNode {
	readonly children: FakeDomNode[] = [];
	readonly classList: FakeClassList;
	readonly style = new FakeStyle();
	readonly attrs = new Map<string, string>();
	parentElement: FakeDomNode | null = null;
	offsetWidth = 0;
	offsetHeight = 0;
	private rectFn: () => { left: number; top: number; right: number; bottom: number; width: number; height: number };

	constructor(
		readonly tagName: string,
		readonly ownerDocument: FakeDocument,
		classes: string[] = [],
		rect: { left?: number; top?: number; width?: number; height?: number } | (() => { left: number; top: number; right: number; bottom: number; width: number; height: number }) = {},
	) {
		this.classList = new FakeClassList(classes);
		if (typeof rect === "function") {
			this.rectFn = rect;
		} else {
			const l = rect.left ?? 0;
			const t = rect.top ?? 0;
			const w = rect.width ?? 700;
			const h = rect.height ?? 0;
			this.offsetWidth = w;
			this.offsetHeight = h;
			this.rectFn = () => ({ left: l, top: t, right: l + w, bottom: t + h, width: w, height: h });
		}
	}

	get firstElementChild(): FakeDomNode | null {
		return this.children[0] ?? null;
	}

	appendChild<T extends FakeDomNode>(child: T): T {
		child.parentElement = this;
		this.children.push(child);
		return child;
	}

	append(...nodes: FakeDomNode[]) {
		for (const n of nodes) this.appendChild(n);
	}

	createDiv(opts: { cls?: string; attr?: Record<string, string> } = {}): FakeDomNode {
		const classes = (opts.cls ?? "").split(/\s+/).filter(Boolean);
		let div!: FakeDomNode;
		div = new FakeDomNode("DIV", this.ownerDocument, classes, () => {
			const parentRect = this.getBoundingClientRect();
			const ownTop = parentRect.top + this.children.filter((c) => c !== div).reduce((acc, c) => acc + c.getBoundingClientRect().height, 0);
			const h = Number.parseFloat(div.style.height || "0") || 0;
			return { left: parentRect.left, top: ownTop, right: parentRect.left + parentRect.width, bottom: ownTop + h, width: parentRect.width, height: h };
		});
		if (opts.attr) {
			for (const [k, v] of Object.entries(opts.attr)) div.setAttribute(k, v);
		}
		return this.appendChild(div);
	}

	setAttribute(k: string, v: string) {
		if (k === "class") {
			for (const c of v.split(/\s+/).filter(Boolean)) this.classList.add(c);
		}
		this.attrs.set(k, v);
	}

	getAttribute(k: string): string | null {
		return this.attrs.get(k) ?? null;
	}

	removeAttribute(k: string) {
		this.attrs.delete(k);
	}

	remove() {
		if (!this.parentElement) return;
		const idx = this.parentElement.children.indexOf(this);
		if (idx >= 0) this.parentElement.children.splice(idx, 1);
		this.parentElement = null;
	}

	getBoundingClientRect() {
		return this.rectFn();
	}

	querySelectorAll(sel: string): FakeDomNode[] {
		const cls = sel.startsWith(".") ? sel.slice(1) : null;
		const out: FakeDomNode[] = [];
		const walk = (node: FakeDomNode) => {
			for (const c of node.children) {
				if (cls ? c.classList.contains(cls) : c.tagName === sel.toUpperCase()) out.push(c);
				walk(c);
			}
		};
		walk(this);
		return out;
	}

	querySelector(sel: string): FakeDomNode | null {
		return this.querySelectorAll(sel)[0] ?? null;
	}

	closest(sel: string): FakeDomNode | null {
		const cls = sel.startsWith(".") ? sel.slice(1) : null;
		const matches = (node: FakeDomNode) => (cls ? node.classList.contains(cls) : node.tagName === sel.toUpperCase());
		if (matches(this)) return this;
		let cur: FakeDomNode | null = this.parentElement;
		while (cur) {
			if (matches(cur)) return cur;
			cur = cur.parentElement;
		}
		return null;
	}
}

class FakeDocument {
	readonly body: FakeDomNode;
	readonly defaultView = {
		getComputedStyle: () => ({ lineHeight: "24px", fontSize: "16px", paddingTop: "0", paddingBottom: "0" }),
	};
	constructor(lightTheme = true) {
		this.body = new FakeDomNode("BODY", this, lightTheme ? ["theme-light"] : ["theme-dark"]);
	}
	createElementNS(_ns: string, tag: string): FakeDomNode {
		return new FakeDomNode(tag.toUpperCase(), this, [], { width: 700, height: 0 });
	}
}

afterEach(() => {
	vi.unstubAllGlobals();
});

async function runPrintExport(opts: {
	noteText: string;
	sections: { type: string; startLine: number; endLine: number }[];
	blocks: { tag: string; innerTag: string; top: number; height: number }[];
	strokes: Stroke[];
	lightTheme?: boolean;
	pageSize?: string;
}) {
	vi.stubGlobal("window", { setTimeout, clearTimeout });
	const doc = new FakeDocument(opts.lightTheme ?? true);
	const printRoot = new FakeDomNode("DIV", doc, ["print"], { left: 0, top: 0, width: 718, height: 2000 });
	const container = new FakeDomNode("DIV", doc, ["markdown-preview-view", "markdown-rendered"], { left: 0, top: 0, width: 718, height: 2000 });
	printRoot.appendChild(container);
	for (const b of opts.blocks) {
		const hostDiv = new FakeDomNode(b.tag, doc, [], { left: 0, top: b.top, width: 718, height: b.height });
		const inner = new FakeDomNode(b.innerTag, doc, [], { left: 0, top: b.top, width: 718, height: b.height });
		hostDiv.appendChild(inner);
		container.appendChild(hostDiv);
	}

	const file = Object.assign(new TFile(), { path: "TestNote.md", extension: "md" });
	const ink: InkFile = { ...emptyInk(), strokes: opts.strokes };
	let postProcessor: ((el: HTMLElement, ctx: MarkdownPostProcessorContext) => Promise<void> | void) | null = null;

	const host: ReadingHost = {
		app: {
			vault: {
				getAbstractFileByPath: (p: string) => (p === "TestNote.md" ? file : null),
				cachedRead: async () => opts.noteText,
				getConfig: () => ({ pageSize: opts.pageSize ?? "A4", landscape: false, margin: "0", downscalePercent: 100 }),
			},
			metadataCache: {
				getFileCache: () => ({
					sections: opts.sections.map((s) => ({
						type: s.type,
						position: { start: { line: s.startLine, col: 0, offset: 0 }, end: { line: s.endLine, col: 0, offset: 0 } },
					})),
				}),
			},
			workspace: {
				on: () => ({}),
				onLayoutReady: () => {},
				getLeavesOfType: () => [],
			},
		} as unknown as ReadingHost["app"],
		store: {
			load: async () => ink,
			get: () => ink,
			isLoaded: () => true,
			observeAll: () => () => {},
		} as unknown as ReadingHost["store"],
		getSettings: () => ({ ...DEFAULT_SYNCED, ...defaultLocal(true) }),
		updateSettings: () => {},
		printOptions: () => ({ include: true, style: "themed" }),
	};

	const plugin = {
		registerMarkdownPostProcessor: (cb: typeof postProcessor) => {
			postProcessor = cb;
		},
		register: () => {},
		registerEvent: () => {},
	} as unknown as Plugin;

	const reading = new ReadingInk(host);
	reading.install(plugin);

	const ctx = {
		sourcePath: "TestNote.md",
		getSectionInfo: () => null,
		promises: [] as Promise<unknown>[],
	} as unknown as MarkdownPostProcessorContext;

	await postProcessor!(container as unknown as HTMLElement, ctx);
	return { container, hostDivs: container.children };
}

describe("PDF end-of-note slicing (Issue #5)", () => {
	it("accounts for the last section's vertical page offset when computing firstRoom and breaks onto page 2 when too little room remains", async () => {
		// A4 printable height = floor((11.69*96 - 2*96/2.54) - 2) = 1044 px.
		// Section 0 fills 900px, Section 1 is 40px tall at top=960 -> content ends at y=1000 on page 1 (only 44px left!).
		// Stroke below the note extends 600px below the last line (well under pageHeight=1044, but > firstRoom=44).
		const noteText = ["First paragraph", "", "Last line"].join("\n");
		const strokes: Stroke[] = [
			{
				id: "s1",
				tool: "pen",
				color: "ink",
				size: 3,
				anchor: { line: 2, hash: hashLine("Last line") },
				points: [[20, 60, 0.5], [120, 600, 0.5]],
			},
		];
		const { hostDivs } = await runPrintExport({
			noteText,
			sections: [
				{ type: "paragraph", startLine: 0, endLine: 0 },
				{ type: "paragraph", startLine: 2, endLine: 2 },
			],
			blocks: [
				{ tag: "DIV", innerTag: "P", top: 0, height: 900 },
				{ tag: "DIV", innerTag: "P", top: 960, height: 40 },
			],
			strokes,
		});

		const lastHost = hostDivs[1];
		const sliceDivs = lastHost.querySelectorAll(".pl-reading-room-slice");
		// Because only 44px remain on page 1 (< minFirst), the drawing must break to page 2 in a slice block!
		expect(sliceDivs.length).toBeGreaterThanOrEqual(1);
		const sliceSvg = sliceDivs[0].querySelector(".pl-reading-slice-svg")!;
		expect(sliceSvg).toBeTruthy();
		// Continuation slice SVGs must have inline absolute positioning for the hidden desktop print window.
		expect(sliceSvg.style.position).toBe("absolute");
		expect(sliceSvg.style.left).toBe("0");
		expect(sliceSvg.style.top).toBe("0");
	});

	it("cuts slice 0 at the remaining page room when last section starts mid-page with a multi-page drawing", async () => {
		// A4 printable height = 1044 px. Last section starts at y=600, height=44 -> content ends at y=644 (400px left on page 1).
		// Stroke spans 1800px below the last line -> slice 0 must be <= 400px (not ~1000px!), followed by full page slices.
		const noteText = ["Top", "", "Bottom"].join("\n");
		const strokes: Stroke[] = [
			{
				id: "s1",
				tool: "pen",
				color: "ink",
				size: 3,
				anchor: { line: 2, hash: hashLine("Bottom") },
				points: [[20, 60, 0.5], [80, 1800, 0.5]],
			},
		];
		const { hostDivs } = await runPrintExport({
			noteText,
			sections: [
				{ type: "paragraph", startLine: 0, endLine: 0 },
				{ type: "paragraph", startLine: 2, endLine: 2 },
			],
			blocks: [
				{ tag: "DIV", innerTag: "P", top: 0, height: 550 },
				{ tag: "DIV", innerTag: "P", top: 600, height: 44 },
			],
			strokes,
		});

		const lastHost = hostDivs[1];
		const mainSvg = lastHost.children.find((c) => c.tagName === "SVG")!;
		// Main SVG height must be clamped to height (44) + slice0 (<= 400) = <= 444, NOT 44 + 1000!
		expect(Number(mainSvg.getAttribute("height"))).toBeLessThanOrEqual(444);
		const sliceDivs = lastHost.querySelectorAll(".pl-reading-room-slice");
		expect(sliceDivs.length).toBeGreaterThanOrEqual(2);
		for (const div of sliceDivs) {
			const s = div.querySelector(".pl-reading-slice-svg")!;
			expect(s.style.position).toBe("absolute");
			expect(s.style.left).toBe("0");
			expect(s.style.top).toBe("0");
		}
	});

	it("does not unconditionally apply mix-blend-mode: multiply to .pl-reading-slice-svg in styles.css", () => {
		const css = readFileSync(resolve(__dirname, "../styles.css"), "utf8");
		const match = /\.pl-reading-slice-svg\s*\{([^}]*)\}/.exec(css);
		expect(match).not.toBeNull();
		expect(match![1]).not.toMatch(/mix-blend-mode\s*:\s*multiply/i);
	});
});
