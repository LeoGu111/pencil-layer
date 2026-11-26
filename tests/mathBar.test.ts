import { EditorState } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InkView, type InkHost } from "../src/inkView";
import { planMathBarTop, planMathInsertion } from "../src/mathBar";
import { emptyInk, type InkFile, type Stroke } from "../src/model";
import { DEFAULT_SYNCED, defaultLocal } from "../src/settings";
import { setSpaces, spaceField } from "../src/spaceView";

describe("planMathBarTop", () => {
	it("places .pl-math-bar clear below .inline-title when it would otherwise overlap (issue #14)", () => {
		// Obsidian 1.15.1 geometry from issue #14: leaf top at y=40, header 0..44, inline-title 70..101.
		const top = planMathBarTop({
			leafHeight: 900,
			barHeight: 46,
			headerBottom: 44,
			inlineTitle: { top: 70, bottom: 101 },
		});
		expect(top).toBeGreaterThanOrEqual(109);
	});

	it("keeps .pl-math-bar at headerBottom + 8 when .inline-title is scrolled away or hidden", () => {
		expect(
			planMathBarTop({
				leafHeight: 900,
				barHeight: 46,
				headerBottom: 44,
				inlineTitle: null,
			}),
		).toBe(52);

		expect(
			planMathBarTop({
				leafHeight: 900,
				barHeight: 46,
				headerBottom: 44,
				inlineTitle: { top: -20, bottom: 10 },
			}),
		).toBe(52);
	});

	it("avoids covering the active formula directly beneath .inline-title when room below exists", () => {
		const top = planMathBarTop({
			leafHeight: 900,
			barHeight: 76,
			headerBottom: 44,
			inlineTitle: { top: 70, bottom: 101 },
			formulaRect: { top: 112, bottom: 156 },
		});
		expect(top).toBe(164);
	});
});

describe("planMathInsertion", () => {
	const lastLine = {
		number: 3,
		from: 14,
		to: 58,
		text: "Letzter Absatz vor dem freien Zeichenbereich.",
		top: 200,
		bottom: 224,
	};

	it("inserts on a new line when drawn below the last paragraph (even closely below or in a space)", () => {
		// Closely below lastLine (midY within 0.4 * lineH, but stroke starts below text bottom).
		const closePlan = planMathInsertion({
			formatted: "$1$",
			docLength: 58,
			lineHeight: 24,
			box: { minX: 40, minY: 225, maxX: 44, maxY: 237 },
			lastLine,
			lineAtY: lastLine,
			cursor: { head: 58, line: lastLine, hasFocus: true },
		});
		expect(closePlan).toEqual({ from: 58, insert: "\n$1$", anchor: 62 });

		// Inside a trailing SpaceWidget (should not dump 10 blank lines or append inline).
		const spacePlan = planMathInsertion({
			formatted: "$1$",
			docLength: 58,
			lineHeight: 24,
			box: { minX: 40, minY: 320, maxX: 44, maxY: 360 },
			lastLine,
			lineAtY: lastLine,
			cursor: { head: 58, line: lastLine, hasFocus: false },
			inSpace: true,
		});
		expect(spacePlan).toEqual({ from: 58, insert: "\n$1$", anchor: 62 });
	});

	it("inserts on a new line when drawn below an intermediate non-empty paragraph", () => {
		const para1 = { number: 1, from: 0, to: 10, text: "Absatz 1.", top: 0, bottom: 24 };
		const para2 = { number: 3, from: 12, to: 22, text: "Absatz 2.", top: 300, bottom: 324 };
		const plan = planMathInsertion({
			formatted: "$x^2$",
			docLength: 22,
			lineHeight: 24,
			box: { minX: 20, minY: 80, maxX: 60, maxY: 120 },
			lastLine: para2,
			lineAtY: para1,
			cursor: { head: 22, line: para2, hasFocus: false },
			inSpace: true,
		});
		expect(plan).toEqual({ from: 10, insert: "\n$x^2$", anchor: 16 });
	});

	it("respects an active mid-line cursor when focused or near the formula", () => {
		const line = { number: 1, from: 0, to: 13, text: "Ergebnis:  mA", top: 0, bottom: 24 };
		const plan = planMathInsertion({
			formatted: "$12$",
			docLength: 13,
			lineHeight: 24,
			box: { minX: 80, minY: 8, maxX: 110, maxY: 22 },
			lastLine: line,
			lineAtY: line,
			cursor: { head: 10, line, hasFocus: true },
		});
		expect(plan).toEqual({ from: 10, insert: "$12$", anchor: 14 });
	});

	it("appends inline when drawn vertically aligned to the right of text on the same line", () => {
		const line = { number: 1, from: 0, to: 7, text: "Formel:", top: 0, bottom: 24 };
		const plan = planMathInsertion({
			formatted: "$a+b$",
			docLength: 7,
			lineHeight: 24,
			box: { minX: 90, minY: 4, maxX: 140, maxY: 20 },
			lastLine: line,
			lineAtY: line,
			cursor: { head: 0, line, hasFocus: false },
		});
		expect(plan).toEqual({ from: 7, insert: " $a+b$", anchor: 13 });
	});
});

class MockDomNode extends EventTarget {
	readonly classList = {
		set: new Set<string>(),
		add: (...tokens: string[]) => {
			for (const t of tokens) this.classList.set.add(t);
		},
		remove: (...tokens: string[]) => {
			for (const t of tokens) this.classList.set.delete(t);
		},
		toggle: (t: string, force?: boolean) => {
			const on = force ?? !this.classList.set.has(t);
			if (on) this.classList.set.add(t);
			else this.classList.set.delete(t);
			return on;
		},
		contains: (t: string) => this.classList.set.has(t),
	};
	readonly style: Record<string, string> = {};
	readonly children: MockDomNode[] = [];
	parentElement: MockDomNode | null = null;
	textContent = "";
	value = "";
	offsetTop = 0;
	offsetHeight = 0;
	clientWidth = 600;
	clientHeight = 900;
	scrollLeft = 0;
	scrollTop = 0;
	private rect = { left: 0, top: 0, width: 600, height: 900, bottom: 900, right: 600 };

	constructor(readonly tagName = "DIV") {
		super();
	}

	get isConnected(): boolean {
		return this.parentElement !== null;
	}

	setRect(r: Partial<typeof this.rect>): void {
		Object.assign(this.rect, r);
	}

	getBoundingClientRect() {
		return { ...this.rect };
	}

	contains(node: unknown): boolean {
		if (node === this) return true;
		return this.children.some((c) => c.contains(node));
	}

	append(...nodes: MockDomNode[]): void {
		for (const n of nodes) this.appendChild(n);
	}

	appendChild(n: MockDomNode): MockDomNode {
		n.parentElement = this;
		this.children.push(n);
		return n;
	}

	replaceChildren(...nodes: MockDomNode[]): void {
		for (const c of this.children) c.parentElement = null;
		this.children.length = 0;
		this.append(...nodes);
	}

	empty(): void {
		this.replaceChildren();
	}

	remove(): void {
		if (!this.parentElement) return;
		const idx = this.parentElement.children.indexOf(this);
		if (idx >= 0) this.parentElement.children.splice(idx, 1);
		this.parentElement = null;
	}

	setText(text: string): void {
		this.textContent = text;
	}

	setAttribute(_k: string, _v: string): void {}
	removeAttribute(_k: string): void {}
	setCssProps(_p: Record<string, string>): void {}

	createDiv(opts?: { cls?: string; text?: string }): MockDomNode {
		return this.createEl("div", opts);
	}

	createSpan(opts?: { cls?: string; text?: string }): MockDomNode {
		return this.createEl("span", opts);
	}

	createEl(tag: string, opts?: { cls?: string; text?: string; value?: string }): MockDomNode {
		const el = new MockDomNode(tag.toUpperCase());
		if (opts?.cls) for (const c of opts.cls.split(/\s+/).filter(Boolean)) el.classList.add(c);
		if (opts?.text !== undefined) el.textContent = opts.text;
		if (opts?.value !== undefined) el.value = opts.value;
		if (el.classList.contains("pl-math-bar")) el.offsetHeight = 76;
		this.appendChild(el);
		return el;
	}

	querySelector<T = MockDomNode>(selector: string): T | null {
		const cls = selector.replace(/^:scope\s*>\s*/, "").replace(/^\./, "");
		if (selector.startsWith(":scope >")) {
			return (this.children.find((c) => c.classList.contains(cls)) ?? null) as T | null;
		}
		for (const c of this.children) {
			if (c.classList.contains(cls)) return c as unknown as T;
			const nested = c.querySelector<T>(selector);
			if (nested) return nested;
		}
		return null;
	}

	closest<T = MockDomNode>(selector: string): T | null {
		const cls = selector.replace(/^\./, "");
		if (this.classList.contains(cls)) return this as unknown as T;
		let cur = this.parentElement;
		while (cur) {
			if (cur.classList.contains(cls)) return cur as unknown as T;
			cur = cur.parentElement;
		}
		return null;
	}
}

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

describe("InkView formula bar integration (issue #14)", () => {
	it("positions .pl-math-bar clear of .inline-title, renders live MathJax preview, and inserts on a new line below trailing SpaceWidget", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
		vi.stubGlobal("window", { setTimeout, clearTimeout, requestAnimationFrame: vi.fn(() => 1), cancelAnimationFrame: vi.fn() });
		vi.stubGlobal("getComputedStyle", () => ({ paddingLeft: "0", paddingRight: "0", display: "block", visibility: "visible" }));
		vi.stubGlobal("activeDocument", {
			createElement: (tag: string) => new MockDomNode(tag.toUpperCase()),
			createElementNS: (_ns: string, tag: string) => new MockDomNode(tag.toUpperCase()),
		});

		const leaf = new MockDomNode("DIV");
		leaf.classList.add("workspace-leaf-content");
		leaf.setRect({ left: 0, top: 40, width: 600, height: 900, bottom: 940, right: 600 });

		const header = leaf.createDiv({ cls: "view-header" });
		header.offsetTop = 0;
		header.offsetHeight = 44;

		const titleEl = leaf.createDiv({ cls: "inline-title", text: "Test-Notiz" });
		titleEl.setRect({ left: 20, top: 110, width: 200, height: 31, bottom: 141, right: 220 });

		const scrollDOM = Object.assign(leaf.createDiv({ cls: "cm-scroller" }), {
			setPointerCapture: vi.fn(),
			hasPointerCapture: vi.fn(() => true),
			releasePointerCapture: vi.fn(),
		});
		const contentDOM = scrollDOM.createDiv({ cls: "cm-content" });
		contentDOM.setRect({ left: 20, top: 160, width: 560, height: 600, bottom: 760, right: 580 });

		const docText = "# Test-Notiz\n\nLetzter Absatz vor dem freien Zeichenbereich.";
		let state = EditorState.create({
			doc: docText,
			selection: { anchor: docText.length },
			extensions: [spaceField],
		});
		state = state.update({ effects: setSpaces.of([{ id: "sp1", pos: null, height: 320 }]) }).state;

		const dispatch = vi.fn((spec: { changes?: { from: number; to?: number; insert: string }; selection?: { anchor: number } }) => {
			if (spec.changes) {
				state = state.update({
					changes: spec.changes,
					selection: spec.selection,
				}).state;
			}
		});

		const lastLineStart = docText.indexOf("Letzter");
		const view = {
			scrollDOM,
			contentDOM,
			get state() {
				return {
					doc: state.doc,
					selection: state.selection,
					field: (f: unknown, req?: boolean) =>
						f === undefined
							? { file: { extension: "md", path: "Test-Notiz.md" } }
							: state.field(f as typeof spaceField, req as false),
				};
			},
			dispatch,
			hasFocus: true,
			documentTop: 0,
			defaultLineHeight: 24,
			scaleX: 1,
			scaleY: 1,
			lineBlockAt: (pos: number) => {
				if (pos >= lastLineStart) {
					// Composite CM6 block: text line (top 60..84) + trailing SpaceWidget (84..404)!
					return {
						from: lastLineStart,
						to: docText.length,
						top: 60,
						bottom: 404,
						type: [
							{ from: lastLineStart, to: docText.length, top: 60, bottom: 84 },
							{ from: docText.length, to: docText.length, top: 84, bottom: 404, widget: { id: "sp1" } },
						],
					};
				}
				return { from: 0, to: 12, top: 0, bottom: 24 };
			},
			lineBlockAtHeight: (y: number) => {
				if (y >= 60) return { from: lastLineStart, to: docText.length, top: 60, bottom: 404 };
				return { from: 0, to: 12, top: 0, bottom: 24 };
			},
			posAtCoords: () => docText.length,
			coordsAtPos: () => ({ left: 20, right: 400, top: 220, bottom: 244 }),
			requestMeasure: vi.fn(),
		};

		let inkFile: InkFile = emptyInk();
		const host = {
			store: {
				subscribe: vi.fn(),
				load: () => new Promise(() => {}),
				isLoaded: () => true,
				get: () => inkFile,
				setContentWidth: vi.fn(),
				addStroke: (_p: string, s: Stroke) => {
					inkFile = { ...inkFile, strokes: [...inkFile.strokes, s] };
				},
				removeStrokes: (_p: string, ids: readonly string[]) => {
					const rem = new Set(ids);
					inkFile = { ...inkFile, strokes: inkFile.strokes.filter((s) => !rem.has(s.id)) };
				},
			},
			getSettings: () => ({ ...DEFAULT_SYNCED, ...defaultLocal(true), tool: "pen" as const, mathMode: true, mathAutoDelayMs: 600 }),
			registerInkView: vi.fn(),
			unregisterInkView: vi.fn(),
			penSeen: vi.fn(),
			deskSelect: () => null,
			selectionToolActive: () => false,
			toggleEraser: vi.fn(),
		};

		new InkView(view as unknown as EditorView, host as unknown as InkHost);

		// Draw a vertical "1" inside the SpaceWidget below "Letzter Absatz..." (clientY = 300..350 -> overlay y = 140..190).
		const pointer = (type: string, clientX: number, clientY: number) => {
			scrollDOM.dispatchEvent(
				Object.assign(new Event(type, { cancelable: true }), {
					pointerId: 1,
					pointerType: "pen",
					button: 0,
					buttons: type === "pointerdown" ? 1 : 0,
					clientX,
					clientY,
					pressure: 0.5,
					tiltX: 0,
					tiltY: 0,
				}),
			);
		};
		pointer("pointerdown", 60, 300);
		pointer("pointermove", 60, 325);
		pointer("pointerup", 60, 350);

		const bar = leaf.querySelector(".pl-math-bar");
		expect(bar).not.toBeNull();
		// While buffering, bar is already positioned clear below .inline-title (bottom = 101 relative to leaf -> top >= 109).
		expect(parseInt(bar!.style.top, 10)).toBeGreaterThanOrEqual(109);

		// Wait for mathAutoDelayMs to trigger recognition and confirm bar.
		vi.advanceTimersByTime(650);
		await Promise.resolve();
		await Promise.resolve();

		expect(parseInt(bar!.style.top, 10)).toBeGreaterThanOrEqual(109);
		const input = bar!.querySelector(".pl-math-input");
		const preview = bar!.querySelector(".pl-math-preview");
		expect(input?.value).toBe("1");
		expect(preview?.children.length).toBeGreaterThan(0);
		expect(preview?.children[0].textContent).toBe("1");

		// Live MathJax preview updates when user edits input.
		input!.value = "1 + 2";
		input!.dispatchEvent(new Event("input"));
		await Promise.resolve();
		expect(preview?.children[0].textContent).toBe("1 + 2");

		// Click "Einfügen" button.
		const buttons: MockDomNode[] = [];
		const collectButtons = (n: MockDomNode) => {
			if (n.tagName === "BUTTON") buttons.push(n);
			for (const c of n.children) collectButtons(c);
		};
		collectButtons(bar!);
		const insertBtn = buttons.find((b) => b.textContent === "Einfügen");
		expect(insertBtn).toBeDefined();
		insertBtn!.dispatchEvent(new Event("click"));

		expect(state.doc.toString()).toBe("# Test-Notiz\n\nLetzter Absatz vor dem freien Zeichenbereich.\n$1 + 2$");
	});
});
