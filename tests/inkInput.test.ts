import { EditorState } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InkView, type InkHost } from "../src/inkView";
import { emptyInk, type Stroke } from "../src/model";
import { DEFAULT_SYNCED, defaultLocal, type PencilSettings } from "../src/settings";
import { elementBoxScale, overlayOrigin, unzoomedLineTop } from "../src/textHighlightView";
import { CharAnchors } from "../src/charAnchorView";

class TestElement extends EventTarget {
	readonly classList = { add: vi.fn(), remove: vi.fn(), toggle: vi.fn(), contains: vi.fn(() => false) };
	readonly style: Record<string, string> = {};
	readonly attrs: Record<string, string> = {};
	readonly children: TestElement[] = [];
	textContent: string | null = null;
	readonly append = vi.fn((...nodes: TestElement[]) => {
		this.children.push(...nodes);
	});
	readonly appendChild = vi.fn((node: TestElement) => {
		this.children.push(node);
		return node;
	});
	readonly replaceChildren = vi.fn((...nodes: TestElement[]) => {
		this.children.length = 0;
		this.children.push(...nodes);
	});
	readonly setAttribute = vi.fn((name: string, value: string) => {
		this.attrs[name] = value;
	});
	readonly removeAttribute = vi.fn((name: string) => {
		delete this.attrs[name];
	});
	readonly setCssProps = vi.fn();
	readonly remove = vi.fn();
	readonly getBoundingClientRect = () => ({ left: 0, top: 0, bottom: 100 });
}

function makeGuideEditor(initialSettings: Partial<PencilSettings> = {}) {
	let currentSettings: PencilSettings = { ...DEFAULT_SYNCED, ...defaultLocal(true), tool: "pen", doubleTapEraser: false, ...initialSettings };
	const updateSettings = vi.fn((patch: Partial<PencilSettings>) => {
		currentSettings = { ...currentSettings, ...patch };
	});
	const elements: TestElement[] = [];
	let pendingMeasure: { read: (v: EditorView) => unknown; write: (v: unknown) => void } | null = null;
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
	vi.stubGlobal("window", { setTimeout, clearTimeout, requestAnimationFrame: vi.fn(() => 1), cancelAnimationFrame: vi.fn() });
	vi.stubGlobal("getComputedStyle", () => ({
		paddingLeft: "0",
		paddingRight: "0",
		paddingTop: "0",
		borderLeftWidth: "0",
		borderTopWidth: "0",
		borderRightWidth: "0",
	}));
	vi.stubGlobal("activeDocument", {
		createElementNS: () => {
			const el = new TestElement();
			elements.push(el);
			return el;
		},
	});
	const state = EditorState.create({ doc: "Geometry notes" });
	const scrollDOM = Object.assign(new TestElement(), {
		scrollLeft: 0,
		scrollTop: 0,
		clientWidth: 600,
		clientHeight: 800,
		setPointerCapture: vi.fn(),
		hasPointerCapture: vi.fn(() => true),
		releasePointerCapture: vi.fn(),
		getBoundingClientRect: () => ({ left: 0, top: 0, width: 600, height: 800, bottom: 800 }),
	});
	const contentDOM = Object.assign(new TestElement(), {
		clientWidth: 500,
		offsetWidth: 500,
		offsetHeight: 800,
		getBoundingClientRect: () => ({ left: 0, top: 0, width: 500, height: 800, bottom: 800 }),
	});
	const view = {
		scrollDOM,
		contentDOM,
		state: {
			doc: state.doc,
			selection: state.selection,
			field: (field: unknown) => (field === undefined ? { file: { extension: "md", path: "Guide.md" } } : undefined),
		},
		scaleX: 1,
		scaleY: 1,
		documentTop: 0,
		contentHeight: 800,
		viewport: { from: 0, to: state.doc.length },
		lineBlockAt: () => ({ top: 0, bottom: 20 }),
		lineBlockAtHeight: () => ({ from: 0, top: 0, bottom: 20 }),
		requestMeasure: vi.fn((spec: { read: (v: EditorView) => unknown; write: (v: unknown) => void }) => {
			pendingMeasure = spec;
		}),
	};
	const host = {
		store: { subscribe: vi.fn(), load: () => new Promise(() => {}), isLoaded: () => true, get: emptyInk, allStrokes: () => [], setContentWidth: vi.fn(), addStroke: vi.fn() },
		getSettings: () => currentSettings,
		registerInkView: vi.fn(),
		unregisterInkView: vi.fn(),
		isRenaming: () => false,
		showInk: vi.fn(),
		toggleEraser: vi.fn(),
		deskSelect: () => null,
		selectionToolActive: () => false,
		deskSelectionMade: vi.fn(),
		exitDeskSelect: vi.fn(),
		inkSelectionChanged: vi.fn(),
		penSeen: vi.fn(),
		updateSettings,
	};
	const ink = new InkView(view as unknown as EditorView, host as unknown as InkHost);
	const flushMeasure = () => {
		if (!pendingMeasure) return;
		const m = pendingMeasure;
		pendingMeasure = null;
		m.write(m.read(view as unknown as EditorView));
	};
	flushMeasure();
	const findByAttr = (name: string, value: string) => elements.find((el) => el.attrs[name] === value)!;
	const dispatchOn = (el: TestElement, type: string, pointerId: number, clientX: number, clientY: number, pointerType = "touch") =>
		el.dispatchEvent(
			Object.assign(new Event(type, { cancelable: type !== "pointercancel" && type !== "lostpointercapture" }), {
				pointerId,
				pointerType,
				button: 0,
				buttons: type === "pointerup" || type === "pointercancel" || type === "lostpointercapture" ? 0 : 1,
				clientX,
				clientY,
				pressure: 0.5,
			}),
		);
	return {
		ink,
		elements,
		updateSettings,
		getSettings: () => currentSettings,
		flushMeasure,
		dispatchOn,
		guideOutline: elements[11],
		guideLabels: elements[13],
		guideGrip: findByAttr("aria-label", "Move guide"),
		guideRotateGrip: findByAttr("aria-label", "Rotate or resize guide"),
		guideResetBtn: elements[16],
	};
}

function makeEditor(settings: Partial<PencilSettings> = {}) {
	const scrollDOM = Object.assign(new TestElement(), {
		scrollLeft: 0,
		scrollTop: 0,
		setPointerCapture: vi.fn(),
		hasPointerCapture: vi.fn(() => true),
		releasePointerCapture: vi.fn(),
	});
	const toggleEraser = vi.fn();
	const runPencilGestureAction = vi.fn();
	const addStroke = vi.fn<(path: string, stroke: Stroke) => void>();
	const elements: TestElement[] = [];
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
	vi.stubGlobal("window", { setTimeout, clearTimeout, requestAnimationFrame: vi.fn(() => 1), cancelAnimationFrame: vi.fn() });
	vi.stubGlobal("getComputedStyle", () => ({ paddingLeft: "0", paddingRight: "0" }));
	vi.stubGlobal("activeDocument", {
		createElementNS: () => {
			const element = new TestElement();
			elements.push(element);
			return element;
		},
	});
	const state = EditorState.create({ doc: "Result: 12.5 mA" });
	const view = {
		scrollDOM,
		contentDOM: Object.assign(new TestElement(), { clientWidth: 100 }),
		state: {
			doc: state.doc,
			selection: state.selection,
			field: (field: unknown) => (field === undefined ? { file: { extension: "md", path: "Test.md" } } : undefined),
		},
		documentTop: 0,
		lineBlockAt: () => ({ top: 0, bottom: 20 }),
		lineBlockAtHeight: () => ({ from: 0, top: 0, bottom: 20 }),
		requestMeasure: vi.fn(),
	};
	const host = {
		store: { subscribe: vi.fn(), load: () => new Promise(() => {}), isLoaded: () => true, get: emptyInk, setContentWidth: vi.fn(), addStroke },
		getSettings: () => ({ ...DEFAULT_SYNCED, ...defaultLocal(true), tool: "lasso", doubleTapEraser: true, ...settings }),
		registerInkView: vi.fn(),
		penSeen: vi.fn(),
		deskSelect: () => null,
		selectionToolActive: () => true,
		toggleEraser,
		runPencilGestureAction,
	};
	const ink = new InkView(view as unknown as EditorView, host as unknown as InkHost);
	const pointer = (
		type: string,
		pointerId = 1,
		clientX = 20,
		clientY = 20,
		extra: Partial<PointerEvent> = {},
	) => {
		const event = Object.assign(new Event(type, { cancelable: type !== "pointercancel" }), {
			pointerId,
			pointerType: "pen",
			button: 0,
			buttons: type === "pointerdown" ? 1 : 0,
			clientX,
			clientY,
			pressure: 0.5,
			tiltX: 0,
			tiltY: 0,
			...extra,
		});
		scrollDOM.dispatchEvent(event);
	};
	return { pointer, toggleEraser, runPencilGestureAction, elements, scrollDOM, ink, addStroke };
}

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

describe("interrupted Pencil contact in the editor", () => {
	it.each(["pointercancel", "lostpointercapture"])("%s discards the active lasso and cannot complete a double tap", (type) => {
		const { pointer, toggleEraser, elements } = makeEditor();
		pointer("pointerdown");
		pointer("pointerup");
		vi.advanceTimersByTime(50);
		pointer("pointerdown");
		const interrupted = elements[elements.length - 1];
		pointer(type);
		expect(interrupted.remove).toHaveBeenCalledOnce();
		expect(toggleEraser).not.toHaveBeenCalled();

		pointer("pointerdown");
		pointer("pointerup");
		expect(toggleEraser).toHaveBeenCalledOnce();
	});

	it("ignores cancellation from a different pointer", () => {
		const { pointer, toggleEraser, scrollDOM } = makeEditor();
		pointer("pointerdown");
		pointer("pointerup");
		vi.advanceTimersByTime(50);
		pointer("pointerdown");
		pointer("pointercancel", 2);
		expect(scrollDOM.releasePointerCapture).toHaveBeenCalledTimes(1);
		pointer("pointerup");
		expect(toggleEraser).toHaveBeenCalledOnce();
	});

	it("allows a finger to scroll immediately after a Pencil contact is canceled", () => {
		const { pointer, scrollDOM } = makeEditor();
		const finger = { touchType: "direct" };
		const fingerMove = () => Object.assign(new Event("touchmove", { cancelable: true }), { changedTouches: [finger], touches: [finger] });
		pointer("pointerdown");
		expect(scrollDOM.dispatchEvent(fingerMove())).toBe(false);
		pointer("pointercancel");
		pointer("lostpointercapture");
		expect(scrollDOM.dispatchEvent(fingerMove())).toBe(true);
		expect(scrollDOM.releasePointerCapture).toHaveBeenCalledOnce();
	});
});

describe("free drawing without Ink spaces", () => {
	it("saves a stroke drawn below the note directly as line-anchored ink without creating a space", () => {
		const { pointer, addStroke } = makeEditor({ tool: "pen", penShape: "rectangle" });
		pointer("pointerdown", 1, 20, 60);
		pointer("pointermove", 1, 60, 100);
		pointer("pointerup", 1, 80, 110);
		expect(addStroke).toHaveBeenCalledOnce();
		const [, stroke] = addStroke.mock.calls[0];
		expect(stroke.space).toBeUndefined();
		expect(stroke.shape).toBe("rectangle");
		expect(stroke.points).toContainEqual([20, 60, 0.5]);
		expect(stroke.points).toContainEqual([80, 110, 0.5]);
	});

	it("records stylus tilt on tilted pen strokes and omits it when upright", () => {
		const { pointer, addStroke } = makeEditor({ tool: "pen", doubleTapEraser: false, tiltShading: true });
		// Upright stroke (< 38°): no tilts stored.
		pointer("pointerdown", 1, 10, 20, { tiltX: 15, tiltY: 0 });
		pointer("pointermove", 1, 50, 20, { tiltX: 15, tiltY: 0 });
		pointer("pointerup", 1, 70, 20, { tiltX: 15, tiltY: 0, pressure: 0 });
		expect(addStroke).toHaveBeenCalledTimes(1);
		expect(addStroke.mock.calls[0][1].tilts).toBeUndefined();

		// Tilted Apple Pencil (~60°): tilts recorded and persisted.
		pointer("pointerdown", 1, 10, 40, { tiltX: 60, tiltY: 0, pressure: 0.7 });
		pointer("pointermove", 1, 50, 40, { tiltX: 65, tiltY: 0, pressure: 0.8 });
		pointer("pointerup", 1, 70, 40, { tiltX: 65, tiltY: 0, pressure: 0 });
		expect(addStroke).toHaveBeenCalledTimes(2);
		const tilted = addStroke.mock.calls[1][1];
		expect(tilted.tilts).toBeDefined();
		expect(tilted.tilts!.length).toBe(tilted.points.length);
		expect(Math.max(...tilted.tilts!)).toBeGreaterThan(0.6);
		// Final point preserves last contact pressure rather than dropping to 0.5 on pointerup.
		expect(tilted.points[tilted.points.length - 1][2]).toBe(0.8);
	});

	it("routes double-tap to custom doubleTapAction when configured", () => {
		const { pointer, runPencilGestureAction, toggleEraser } = makeEditor({ tool: "pen", doubleTapAction: "palette" });
		pointer("pointerdown");
		pointer("pointerup");
		vi.advanceTimersByTime(50);
		pointer("pointerdown");
		pointer("pointerup");
		expect(runPencilGestureAction).toHaveBeenCalledWith("palette");
		expect(toggleEraser).not.toHaveBeenCalled();
	});

	it("keeps ruler/shape live stroke visibly stroked even when Apple Pencil is tilted", () => {
		let rafCb: FrameRequestCallback | null = null;
		const { pointer, elements, addStroke } = makeEditor({ tool: "pen", penShape: "line", doubleTapEraser: false, tiltShading: true });
		vi.stubGlobal("window", {
			setTimeout,
			clearTimeout,
			requestAnimationFrame: vi.fn((cb: FrameRequestCallback) => {
				rafCb = cb;
				return 1;
			}),
			cancelAnimationFrame: vi.fn(),
		});
		// Tilted Apple Pencil (~60°): geometry line must stay a stroked centerline live, not fill-only.
		pointer("pointerdown", 1, 20, 40, { tiltX: 60, tiltY: 0, pressure: 0.7 });
		const liveEl = elements[elements.length - 1];
		pointer("pointermove", 1, 80, 40, { tiltX: 62, tiltY: 0, pressure: 0.7 });
		expect(rafCb).not.toBeNull();
		rafCb!(16);
		// Must have a non-empty SVG path AND visible stroke styling BEFORE pointerup.
		const dCalls = liveEl.setAttribute.mock.calls.filter(([k]) => k === "d");
		expect(dCalls.length).toBeGreaterThan(0);
		expect(dCalls[dCalls.length - 1][1]).toMatch(/^M20 40 .*L80 40$/);
		const cssCalls = liveEl.setCssProps.mock.calls;
		const lastCss = cssCalls[cssCalls.length - 1][0] as Record<string, string>;
		expect(lastCss.stroke).not.toBe("");
		expect(liveEl.setAttribute).toHaveBeenCalledWith("stroke-width", expect.any(String));

		pointer("pointerup", 1, 100, 40, { tiltX: 62, tiltY: 0, pressure: 0 });
		expect(addStroke).toHaveBeenCalledOnce();
		expect(addStroke.mock.calls[0][1].shape).toBe("line");
	});

	it("computes live zoomed scale in overlayOrigin when CSS zoom differs from cached CM6 scale", () => {
		vi.stubGlobal("getComputedStyle", () => ({ paddingLeft: "10", paddingTop: "20" }));
		const fakeView = {
			scaleX: 1,
			scaleY: 1,
			documentTop: 20,
			contentDOM: {
				offsetWidth: 500,
				offsetHeight: 1000,
				getBoundingClientRect: () => ({ left: 40, top: 10, width: 1000, height: 2000 }),
			},
		};
		const o = overlayOrigin(fakeView as unknown as EditorView);
		expect(o.sx).toBeCloseTo(2, 5);
		expect(o.sy).toBeCloseTo(2, 5);
		expect(o.x).toBeCloseTo(60, 5);
		expect(o.y).toBeCloseTo(50, 5);

		// Subpixel computed CSS height avoids integer offsetHeight drift on tall documents.
		const fakeEl = {
			offsetWidth: 500,
			offsetHeight: 15000, // rounded from 15000.45
		} as unknown as HTMLElement;
		const sub = elementBoxScale(
			fakeEl,
			{ width: 300, height: 15000.45 * 0.6 },
			1,
			1,
			{ width: "500px", height: "15000.45px", boxSizing: "border-box" } as unknown as CSSStyleDeclaration,
		);
		expect(sub.sx).toBeCloseTo(0.6, 7);
		expect(sub.sy).toBeCloseTo(0.6, 7);
	});

	it("returns unzoomed line top when CM6 scaleY is zoomed or stale", () => {
		vi.stubGlobal("getComputedStyle", () => ({ paddingLeft: "0", paddingTop: "10" }));
		const lineEl = {
			classList: { contains: (c: string) => c === "cm-line" },
			closest: function (sel: string) {
				return sel === ".cm-line" ? this : null;
			},
			getBoundingClientRect: () => ({ left: 0, top: 100, width: 400, height: 48 }),
		};
		const fakeView = {
			scaleX: 1,
			scaleY: 1, // stale relative to 2x CSS zoom on contentDOM
			documentTop: 10,
			viewport: { from: 0, to: 100 },
			contentDOM: {
				offsetWidth: 500,
				offsetHeight: 1000,
				contains: (el: unknown) => el === lineEl,
				getBoundingClientRect: () => ({ left: 0, top: 20, width: 1000, height: 2000 }),
			},
			domAtPos: () => ({ node: { nodeType: 1, closest: (s: string) => lineEl.closest(s) }, offset: 0 }),
			lineBlockAt: () => ({ top: 480, bottom: 528 }),
		};
		// (100 - (20 + 10 * 2)) / 2 = 30 even though CM6 scaleY is stale and lineBlockAt is 480.
		expect(unzoomedLineTop(fakeView as unknown as EditorView, 20)).toBeCloseTo(30, 5);
		// Outside viewport falls back to dividing scaled heightMap by view.scaleY.
		const scaledFallbackView = { ...fakeView, scaleY: 2, viewport: { from: 50, to: 100 } };
		expect(unzoomedLineTop(scaledFallbackView as unknown as EditorView, 20)).toBeCloseTo(240, 5);
	});

	it("anchors and re-measures CharAnchors in unzoomed coordinates when view.scaleY is 2", () => {
		vi.stubGlobal("getComputedStyle", () => ({ paddingLeft: "0", paddingTop: "0" }));
		const doc = EditorState.create({ doc: "First line\nSecond line" }).doc;
		const lineTopUnzoomed = [0, 24];
		const lineEl = {
			closest: () => lineEl,
			getBoundingClientRect: () => ({ left: 0, top: 48, width: 200, height: 48 }),
		};
		const fakeView = {
			state: { doc },
			scaleX: 2,
			scaleY: 2,
			documentTop: 0,
			defaultLineHeight: 48, // 2x zoomed CM6 heightOracle
			viewport: { from: 0, to: doc.length },
			contentDOM: {
				offsetWidth: 400,
				offsetHeight: 200,
				contains: () => true,
				getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 400 }),
			},
			domAtPos: (pos: number) => ({
				node: {
					nodeType: 3,
					parentElement: {
						closest: (sel: string) => (pos >= 11 && sel === ".cm-line" ? lineEl : null),
					},
				},
				offset: 0,
			}),
			lineBlockAt: (pos: number) => {
				const idx = doc.lineAt(pos).number - 1;
				const t = lineTopUnzoomed[idx] * 2;
				return { from: doc.line(idx + 1).from, top: t, bottom: t + 48 };
			},
			posAtCoords: () => 11,
			coordsAtPos: () => ({ left: 20, right: 36, top: 48, bottom: 96 }), // unzoomed: x=10, y=24, h=24
		};
		const charA = new CharAnchors(fakeView as unknown as EditorView);
		const stroke: Stroke = {
			id: "s1",
			tool: "pen",
			color: "ink",
			size: 2,
			anchor: { line: 1, hash: "" },
			points: [[12, 4, 0.5], [18, 12, 0.5]],
			pos: 11,
		};
		expect(charA.anchorUnit([stroke], { minX: 12, minY: 28, maxX: 18, maxY: 36 })).toBe(true);
		expect(stroke.char).toBeDefined();
		expect(stroke.char!.dy).toBeCloseTo(0, 5);
		expect(charA.shift(stroke)).toEqual([0, 0]);
		charA.invalidate();
		charA.measure([stroke]);
		expect(charA.shift(stroke)).toEqual([0, 0]);
	});

	it("renders and draws strokes in unzoomed coordinates when zoomed at 2x with scaleY=2", () => {
		const lines = Array.from({ length: 12 }, (_, i) => `Line ${i + 1} content`);
		const state = EditorState.create({ doc: lines.join("\n") });
		const doc = state.doc;
		const elements: TestElement[] = [];
		const addStroke = vi.fn<(path: string, stroke: Stroke) => void>();
		const storedStroke: Stroke = {
			id: "existing",
			tool: "pen",
			color: "ink",
			size: 2,
			anchor: { line: 10, hash: "" },
			points: [[10, 5, 0.5], [30, 10, 0.5]],
			pos: doc.line(11).from,
		};
		let pendingMeasure: { read: (v: EditorView) => unknown; write: (v: unknown) => void } | null = null;
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
		vi.stubGlobal("window", { setTimeout, clearTimeout, requestAnimationFrame: vi.fn(() => 1), cancelAnimationFrame: vi.fn() });
		vi.stubGlobal("getComputedStyle", () => ({ paddingLeft: "0", paddingRight: "0", paddingTop: "0", borderLeftWidth: "0", borderTopWidth: "0", borderRightWidth: "0" }));
		vi.stubGlobal("activeDocument", {
			createElementNS: () => {
				const el = new TestElement();
				elements.push(el);
				return el;
			},
			createRange: () => ({ setStart: vi.fn(), setEnd: vi.fn(), getClientRects: () => [] }),
		});
		const scrollDOM = Object.assign(new TestElement(), {
			scrollLeft: 0,
			scrollTop: 0,
			clientWidth: 400,
			clientHeight: 400,
			setPointerCapture: vi.fn(),
			hasPointerCapture: vi.fn(() => true),
			releasePointerCapture: vi.fn(),
			getBoundingClientRect: () => ({ left: 0, top: 0, width: 400, height: 400, bottom: 400 }),
		});
		const contentDOM = Object.assign(new TestElement(), {
			clientWidth: 300,
			offsetWidth: 300,
			offsetHeight: 600,
			contains: () => false,
			getBoundingClientRect: () => ({ left: 0, top: 0, width: 600, height: 1200, bottom: 1200 }),
		});
		const view = {
			scrollDOM,
			contentDOM,
			state: {
				doc,
				selection: state.selection,
				field: (field: unknown) => (field === undefined ? { file: { extension: "md", path: "Test.md" } } : undefined),
			},
			scaleX: 2,
			scaleY: 2,
			documentTop: 0,
			contentHeight: 1200,
			defaultLineHeight: 48,
			viewport: { from: doc.line(5).from, to: doc.length },
			posAtCoords: () => doc.line(11).from,
			coordsAtPos: () => ({ left: 20, right: 36, top: 480, bottom: 528 }),
			domAtPos: () => ({ node: { nodeType: 3, parentElement: { closest: () => null } }, offset: 0 }),
			lineBlockAt: (pos: number) => {
				const idx = doc.lineAt(pos).number - 1;
				const top = idx * 48; // 2x zoomed CM6 heightMap (unzoomed 24px/line)
				return { from: doc.line(idx + 1).from, top, bottom: top + 48 };
			},
			lineBlockAtHeight: (h: number) => {
				const idx = Math.max(0, Math.min(doc.lines - 1, Math.floor(h / 48)));
				const line = doc.line(idx + 1);
				return { from: line.from, top: idx * 48, bottom: (idx + 1) * 48 };
			},
			requestMeasure: vi.fn((spec: { read: (v: EditorView) => unknown; write: (v: unknown) => void }) => {
				pendingMeasure = spec;
			}),
		};
		const host = {
			store: {
				subscribe: vi.fn(),
				load: () => new Promise(() => {}),
				isLoaded: () => true,
				get: () => ({ version: 2, strokes: [storedStroke] }),
				allStrokes: () => [storedStroke],
				setContentWidth: vi.fn(),
				addStroke,
			},
			getSettings: () => ({ ...DEFAULT_SYNCED, ...defaultLocal(true), tool: "pen", doubleTapEraser: false }),
			registerInkView: vi.fn(),
			penSeen: vi.fn(),
			deskSelect: () => null,
			selectionToolActive: () => false,
		};
		const ink = new InkView(view as unknown as EditorView, host as unknown as InkHost);
		ink.setZoom(2);
		expect(pendingMeasure).not.toBeNull();
		pendingMeasure!.write(pendingMeasure!.read(view as unknown as EditorView));

		// Existing stroke on line 11 (unzoomed top = 240, scaled lineBlockAt = 480) must render at translate(0 240).
		const pathTransforms = elements
			.flatMap((el) => el.setAttribute.mock.calls.filter(([k]) => k === "transform").map(([, v]) => String(v)));
		expect(pathTransforms).toContain("translate(0 240)");
		expect(pathTransforms).not.toContain("translate(0 480)");

		// Drawing while zoomed at 2x: clientY=490 maps to overlayY=245 -> anchored to line 11 (top=240), point y=5.
		const svgEl = elements[0];
		Object.defineProperty(svgEl, "getBoundingClientRect", {
			value: () => ({ left: 0, top: 0, width: 600, height: 1200, bottom: 1200 }),
		});
		const dispatch = (type: string, clientX: number, clientY: number) =>
			scrollDOM.dispatchEvent(
				Object.assign(new Event(type, { cancelable: true }), {
					pointerId: 7,
					pointerType: "pen",
					button: 0,
					buttons: type === "pointerup" ? 0 : 1,
					clientX,
					clientY,
					pressure: 0.5,
					tiltX: 0,
					tiltY: 0,
				}),
			);
		dispatch("pointerdown", 60, 490);
		dispatch("pointermove", 360, 500);
		dispatch("pointerup", 360, 500);
		expect(addStroke).toHaveBeenCalledOnce();
		const created = addStroke.mock.calls[0][1];
		expect(created.pos).toBe(doc.line(11).from);
		expect(created.points[0][0]).toBeCloseTo(30, 5);
		expect(created.points[0][1]).toBeCloseTo(5, 5);
	});
});

describe("geometry guide transient drag and reset", () => {
	it("keeps ruler rotation transient during pointermove and persists once on pointerup", () => {
		const { guideRotateGrip, guideLabels, updateSettings, getSettings, dispatchOn } = makeGuideEditor({
			ruler: true,
			rulerAngle: 0,
		});
		// Guide origin defaults to [250, 180] in a 500x800 view.
		dispatchOn(guideRotateGrip, "pointerdown", 1, 458, 180, "mouse");
		dispatchOn(guideRotateGrip, "pointermove", 1, 397, 327, "mouse"); // ~45°
		dispatchOn(guideRotateGrip, "pointermove", 1, 250, 388, "mouse"); // 90°
		expect(updateSettings).not.toHaveBeenCalled();
		expect(getSettings().rulerAngle).toBe(0);
		expect(guideLabels.children.some((el) => el.textContent === "90°")).toBe(true);

		dispatchOn(guideRotateGrip, "pointerup", 1, 250, 388, "mouse");
		dispatchOn(guideRotateGrip, "lostpointercapture", 1, 250, 388, "mouse");
		expect(updateSettings).toHaveBeenCalledTimes(1);
		expect(updateSettings).toHaveBeenCalledWith({ rulerAngle: 90 });
		expect(getSettings().rulerAngle).toBe(90);
	});

	it("persists set square rotation once on pointercancel and ignores subsequent lostpointercapture", () => {
		const { guideRotateGrip, guideLabels, updateSettings, dispatchOn } = makeGuideEditor({
			setSquare: true,
			setSquareAngle: 0,
		});
		dispatchOn(guideRotateGrip, "pointerdown", 2, 430, 180, "touch");
		dispatchOn(guideRotateGrip, "pointermove", 2, 377, 307, "touch"); // ~45°
		expect(updateSettings).not.toHaveBeenCalled();
		expect(guideLabels.children.some((el) => el.textContent === "45°")).toBe(true);

		dispatchOn(guideRotateGrip, "pointercancel", 2, 377, 307, "touch");
		dispatchOn(guideRotateGrip, "lostpointercapture", 2, 377, 307, "touch");
		expect(updateSettings).toHaveBeenCalledTimes(1);
		expect(updateSettings).toHaveBeenCalledWith({ setSquareAngle: 45 });
	});

	it("keeps compass radius transient during pointermove and persists once on pointerup", () => {
		const { guideRotateGrip, guideLabels, updateSettings, getSettings, dispatchOn } = makeGuideEditor({
			compass: true,
			compassRadius: 100,
		});
		dispatchOn(guideRotateGrip, "pointerdown", 3, 350, 180, "mouse");
		dispatchOn(guideRotateGrip, "pointermove", 3, 390, 180, "mouse"); // r = 140
		dispatchOn(guideRotateGrip, "pointermove", 3, 410, 180, "mouse"); // r = 160
		expect(updateSettings).not.toHaveBeenCalled();
		expect(getSettings().compassRadius).toBe(100);
		expect(guideLabels.children.some((el) => el.textContent === "r = 4.2 cm")).toBe(true);

		dispatchOn(guideRotateGrip, "pointerup", 3, 410, 180, "mouse");
		expect(updateSettings).toHaveBeenCalledTimes(1);
		expect(updateSettings).toHaveBeenCalledWith({ compassRadius: 160 });
	});

	it("keeps two-finger pinch rotation transient during pointermove and persists once when pinch ends", () => {
		const { guideOutline, guideLabels, updateSettings, dispatchOn } = makeGuideEditor({
			ruler: true,
			rulerAngle: 0,
		});
		dispatchOn(guideOutline, "pointerdown", 10, 210, 180, "touch");
		dispatchOn(guideOutline, "pointerdown", 11, 290, 180, "touch");
		dispatchOn(guideOutline, "pointermove", 10, 250, 140, "touch");
		dispatchOn(guideOutline, "pointermove", 11, 250, 220, "touch"); // rotated +90°
		expect(updateSettings).not.toHaveBeenCalled();
		expect(guideLabels.children.some((el) => el.textContent === "90°")).toBe(true);

		dispatchOn(guideOutline, "pointerup", 10, 250, 140, "touch");
		dispatchOn(guideOutline, "pointerup", 11, 250, 220, "touch");
		expect(updateSettings).toHaveBeenCalledTimes(1);
		expect(updateSettings).toHaveBeenCalledWith({ rulerAngle: 90 });
	});

	it("keeps two-finger compass pinch-resize transient during pointermove and persists once on pointercancel", () => {
		const { guideOutline, guideLabels, updateSettings, dispatchOn } = makeGuideEditor({
			compass: true,
			compassRadius: 100,
		});
		dispatchOn(guideOutline, "pointerdown", 10, 200, 180, "touch");
		dispatchOn(guideOutline, "pointerdown", 11, 300, 180, "touch"); // dist = 100
		dispatchOn(guideOutline, "pointermove", 10, 175, 180, "touch");
		dispatchOn(guideOutline, "pointermove", 11, 325, 180, "touch"); // dist = 150 -> r = 150
		expect(updateSettings).not.toHaveBeenCalled();
		expect(guideLabels.children.some((el) => el.textContent === "r = 4.0 cm")).toBe(true);

		dispatchOn(guideOutline, "pointercancel", 10, 175, 180, "touch");
		dispatchOn(guideOutline, "pointerup", 11, 325, 180, "touch");
		expect(updateSettings).toHaveBeenCalledTimes(1);
		expect(updateSettings).toHaveBeenCalledWith({ compassRadius: 150 });
	});

	it("resets the ruler angle to 0° when clicking the 0° button even if already at 0°", () => {
		const { guideResetBtn, updateSettings, getSettings, dispatchOn } = makeGuideEditor({
			ruler: true,
			rulerAngle: 0,
		});
		dispatchOn(guideResetBtn, "pointerdown", 1, 200, 226, "touch");
		expect(updateSettings).toHaveBeenCalledWith({ rulerAngle: 0 });
		expect(getSettings().rulerAngle).toBe(0);
	});

	it("resets a rotated ruler angle back to 0° when clicking the 0° button", () => {
		const { guideResetBtn, updateSettings, getSettings, dispatchOn } = makeGuideEditor({
			ruler: true,
			rulerAngle: 45,
		});
		dispatchOn(guideResetBtn, "pointerdown", 1, 200, 226, "touch");
		expect(updateSettings).toHaveBeenCalledWith({ rulerAngle: 0 });
		expect(getSettings().rulerAngle).toBe(0);
	});
});
