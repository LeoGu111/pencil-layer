import { EditorState } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InkView, type InkHost } from "../src/inkView";
import { emptyInk, type Stroke } from "../src/model";
import { DEFAULT_SYNCED, defaultLocal, type PencilSettings } from "../src/settings";
import { overlayOrigin } from "../src/textHighlightView";

class TestElement extends EventTarget {
	readonly classList = { add: vi.fn(), remove: vi.fn(), toggle: vi.fn() };
	readonly style: Record<string, string> = {};
	readonly append = vi.fn();
	readonly appendChild = vi.fn();
	readonly replaceChildren = vi.fn();
	readonly setAttribute = vi.fn();
	readonly removeAttribute = vi.fn();
	readonly setCssProps = vi.fn();
	readonly remove = vi.fn();
	readonly getBoundingClientRect = () => ({ left: 0, top: 0, bottom: 100 });
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
	});
});
