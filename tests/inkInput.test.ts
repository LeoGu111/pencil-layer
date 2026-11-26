import { EditorState } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InkView, type InkHost } from "../src/inkView";
import { emptyInk } from "../src/model";
import { DEFAULT_SYNCED, defaultLocal, type PencilSettings } from "../src/settings";
import { A4_SPACE_HEIGHT } from "../src/spaces";
import type { SpaceEdit } from "../src/store";

class TestElement extends EventTarget {
	readonly classList = { add: vi.fn(), remove: vi.fn(), toggle: vi.fn() };
	readonly style = {};
	readonly append = vi.fn();
	readonly appendChild = vi.fn();
	readonly replaceChildren = vi.fn();
	readonly setAttribute = vi.fn();
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
			field: (field: unknown) => field === undefined ? { file: { extension: "md", path: "Test.md" } } : undefined,
		},
		documentTop: 0,
		lineBlockAt: () => ({ top: 0, bottom: 20 }),
		requestMeasure: vi.fn(),
	};
	const editSpaces = vi.fn<(path: string, edit: SpaceEdit) => boolean>(() => true);
	const host = {
		store: { subscribe: vi.fn(), load: () => new Promise(() => {}), isLoaded: () => true, get: emptyInk, setContentWidth: vi.fn(), editSpaces },
		getSettings: () => ({ ...DEFAULT_SYNCED, ...defaultLocal(true), tool: "lasso", doubleTapEraser: true, ...settings }),
		registerInkView: vi.fn(),
		penSeen: vi.fn(),
		deskSelect: () => null,
		selectionToolActive: () => true,
		toggleEraser,
	};
	const ink = new InkView(view as unknown as EditorView, host as unknown as InkHost);
	const pointer = (type: string, pointerId = 1, clientX = 20, clientY = 20) => {
		const event = Object.assign(new Event(type, { cancelable: type !== "pointercancel" }), {
			pointerId,
			pointerType: "pen",
			button: 0,
			buttons: type === "pointerdown" ? 1 : 0,
			clientX,
			clientY,
		});
		scrollDOM.dispatchEvent(event);
	};
	return { pointer, toggleEraser, elements, scrollDOM, ink, editSpaces };
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

describe("A4 drawing tools", () => {
	it("inserts a fixed A4 space at the editor's cursor", () => {
		const { ink, editSpaces } = makeEditor({ a4DrawingSpaces: true });
		ink.addSpace();
		expect(editSpaces).toHaveBeenCalledOnce();
		const [path, edit] = editSpaces.mock.calls[0];
		expect(path).toBe("Test.md");
		expect(edit.addSpaces?.[0].space).toMatchObject({ a4: true, height: A4_SPACE_HEIGHT, pos: 0 });
	});

	it("saves the selected shape below the note on lift using the final pointer position", () => {
		const { pointer, editSpaces } = makeEditor({ tool: "pen", penShape: "rectangle", a4DrawingSpaces: true });
		pointer("pointerdown", 1, 20, 60);
		pointer("pointermove", 1, 60, 100);
		pointer("pointerup", 1, 80, 110);
		expect(editSpaces).toHaveBeenCalledOnce();
		const [path, edit] = editSpaces.mock.calls[0];
		expect(path).toBe("Test.md");
		expect(edit.addSpaces?.[0].space).toMatchObject({ a4: true, height: A4_SPACE_HEIGHT, after: "end" });
		const stroke = edit.addStrokes?.[0];
		expect(stroke?.shape).toBe("rectangle");
		expect(stroke?.points).toContainEqual([20, 40, 0.5]);
		expect(stroke?.points).toContainEqual([80, 90, 0.5]);
	});
});
