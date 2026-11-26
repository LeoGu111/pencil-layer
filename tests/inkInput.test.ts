import { EditorState } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InkView, type InkHost } from "../src/inkView";
import { DEFAULT_SYNCED, defaultLocal } from "../src/settings";

class TestElement extends EventTarget {
	readonly classList = { add: vi.fn(), toggle: vi.fn() };
	readonly style = {};
	readonly append = vi.fn();
	readonly appendChild = vi.fn();
	readonly replaceChildren = vi.fn();
	readonly setAttribute = vi.fn();
	readonly remove = vi.fn();
	readonly getBoundingClientRect = () => ({ left: 0, top: 0, bottom: 100 });
}

function makeLassoEditor() {
	const scrollDOM = Object.assign(new TestElement(), {
		scrollLeft: 0,
		scrollTop: 0,
		setPointerCapture: vi.fn(),
		hasPointerCapture: vi.fn(() => true),
		releasePointerCapture: vi.fn(),
	});
	const toggleEraser = vi.fn();
	const elements: TestElement[] = [];
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
	vi.stubGlobal("window", { setTimeout, clearTimeout });
	vi.stubGlobal("getComputedStyle", () => ({ paddingLeft: "0", paddingRight: "0" }));
	vi.stubGlobal("activeDocument", {
		createElementNS: () => {
			const element = new TestElement();
			elements.push(element);
			return element;
		},
	});
	const view = {
		scrollDOM,
		contentDOM: Object.assign(new TestElement(), { clientWidth: 100 }),
		state: {
			doc: EditorState.create({ doc: "Result: 12.5 mA" }).doc,
			field: () => ({ file: { extension: "md", path: "Test.md" } }),
		},
		documentTop: 0,
		requestMeasure: vi.fn(),
	};
	const host = {
		store: { subscribe: vi.fn(), load: () => new Promise(() => {}), isLoaded: () => true },
		getSettings: () => ({ ...DEFAULT_SYNCED, ...defaultLocal(true), tool: "lasso", doubleTapEraser: true }),
		registerInkView: vi.fn(),
		penSeen: vi.fn(),
		deskSelect: () => null,
		selectionToolActive: () => true,
		toggleEraser,
	};
	new InkView(view as unknown as EditorView, host as unknown as InkHost);
	const pointer = (type: string, pointerId = 1) => {
		const event = Object.assign(new Event(type, { cancelable: type !== "pointercancel" }), {
			pointerId,
			pointerType: "pen",
			button: 0,
			buttons: type === "pointerdown" ? 1 : 0,
			clientX: 20,
			clientY: 20,
		});
		scrollDOM.dispatchEvent(event);
	};
	return { pointer, toggleEraser, elements, scrollDOM };
}

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

describe("interrupted Pencil contact in the editor", () => {
	it.each(["pointercancel", "lostpointercapture"])("%s discards the active lasso and cannot complete a double tap", (type) => {
		const { pointer, toggleEraser, elements } = makeLassoEditor();
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
		const { pointer, toggleEraser, scrollDOM } = makeLassoEditor();
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
		const { pointer, scrollDOM } = makeLassoEditor();
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
