import { EditorState, type TransactionSpec } from "@codemirror/state";
import type { EditorView, ViewUpdate } from "@codemirror/view";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SYNCED, defaultLocal } from "../src/settings";
import { insertionPosForY, isPureTapPadding, isUnusedTapPadding, planTapToType } from "../src/tapToType";
import { TapToTypeController } from "../src/tapToTypeView";

describe("tapToType", () => {
	const lastLine = { top: 0, bottom: 24, lineTo: 0, lineEndX: 0 };

	it("extends an empty note with newlines when tapping below line 1 instead of jumping to top", () => {
		const plan = planTapToType({
			docLength: 0,
			lineHeight: 24,
			charWidth: 8,
			tapX: 12,
			tapY: 264,
			lastLine,
		});
		expect(plan).toEqual({
			from: 0,
			insert: "\n".repeat(10),
			anchor: 10,
		});
	});

	it("pads horizontally with NBSP when tapping well past the left edge below existing text", () => {
		const plan = planTapToType({
			docLength: 10,
			lineHeight: 24,
			charWidth: 8,
			tapX: 160,
			tapY: 120,
			lastLine: { top: 24, bottom: 48, lineTo: 10, lineEndX: 40 },
		});
		expect(plan).not.toBeNull();
		expect(plan!.insert.startsWith("\n".repeat(3))).toBe(true);
		expect(plan!.insert.slice(3)).toBe("\u00A0".repeat(20));
		expect(plan!.anchor).toBe(10 + 23);
	});

	it("pads an existing short line horizontally when tapping to its right", () => {
		const plan = planTapToType({
			docLength: 20,
			lineHeight: 24,
			charWidth: 10,
			tapX: 180,
			tapY: 12,
			lastLine: { top: 24, bottom: 48, lineTo: 20, lineEndX: 0 },
			lineAtTap: { top: 0, bottom: 24, lineTo: 6, lineEndX: 60 },
		});
		expect(plan).toEqual({
			from: 6,
			insert: "\u00A0".repeat(12),
			anchor: 18,
		});
	});

	it("returns null when tapping directly inside existing text", () => {
		const plan = planTapToType({
			docLength: 20,
			lineHeight: 24,
			charWidth: 8,
			tapX: 40,
			tapY: 12,
			lastLine: { top: 24, bottom: 48, lineTo: 20, lineEndX: 0 },
			lineAtTap: { top: 0, bottom: 24, lineTo: 12, lineEndX: 90 },
		});
		expect(plan).toBeNull();
	});

	it("computes formula LaTeX insertion newlines when written below text", () => {
		expect(insertionPosForY(168, { top: 0, bottom: 24, lineTo: 5, lineEndX: 40 }, 24, 5, 5)).toEqual({
			prefixNewlines: 6,
			from: 5,
		});
		expect(insertionPosForY(12, { top: 24, bottom: 48, lineTo: 15, lineEndX: 0 }, 24, 7, 15)).toEqual({
			prefixNewlines: 0,
			from: 7,
		});
	});

	it("identifies pure tap-to-type padding vs used text", () => {
		expect(isPureTapPadding("\n\n\u00A0\u00A0")).toBe(true);
		expect(isPureTapPadding("\nhello")).toBe(false);
		expect(isPureTapPadding("")).toBe(false);
		expect(isUnusedTapPadding("\n\u00A0\u00A0", "")).toBe(true);
		expect(isUnusedTapPadding("\n\u00A0\u00A0", "typed")).toBe(false);
	});
});

describe("TapToTypeController", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	function makeController(tapToType: boolean, initialText = "Hello") {
		let state = EditorState.create({ doc: initialText });
		const contentDOM = Object.assign(new EventTarget(), {
			contains: () => false,
		});
		const scrollDOM = new EventTarget();
		let ctrl!: TapToTypeController;
		const dispatch = vi.fn((spec: TransactionSpec) => {
			const tr = state.update(spec);
			const prevState = state;
			state = tr.state;
			ctrl.onViewUpdate({
				state,
				startState: prevState,
				docChanged: tr.docChanged,
				selectionSet: tr.selection !== undefined,
				changes: tr.changes,
				transactions: [tr],
			} as unknown as ViewUpdate);
		});
		const view = {
			scrollDOM,
			contentDOM,
			get state() {
				return state;
			},
			scaleX: 1,
			scaleY: 1,
			defaultLineHeight: 24,
			defaultCharacterWidth: 8,
			lineBlockAt: (pos: number) => {
				const n = state.doc.lineAt(pos).number - 1;
				return { from: state.doc.line(n + 1).from, top: n * 24, bottom: (n + 1) * 24 };
			},
			lineBlockAtHeight: (h: number) => {
				const idx = Math.max(0, Math.min(state.doc.lines - 1, Math.floor(h / 24)));
				const line = state.doc.line(idx + 1);
				return { from: line.from, top: idx * 24, bottom: (idx + 1) * 24 };
			},
			coordsAtPos: () => ({ left: 0, right: 40, top: 0, bottom: 24 }),
			posAtCoords: () => 0,
			domAtPos: () => ({ node: { nodeType: 3, parentElement: { closest: () => null } }, offset: 0 }),
			dispatch,
			focus: vi.fn(),
		} as unknown as EditorView;

		const rafQueue: FrameRequestCallback[] = [];
		vi.stubGlobal("window", {
			requestAnimationFrame: vi.fn((cb: FrameRequestCallback) => {
				rafQueue.push(cb);
				return rafQueue.length;
			}),
			cancelAnimationFrame: vi.fn(),
		});

		ctrl = new TapToTypeController(view, {
			isDestroyed: () => false,
			getSettings: () => ({ ...DEFAULT_SYNCED, ...defaultLocal(true), tapToType }),
			hasActiveInput: () => false,
			hasSelection: () => false,
			isDeskSelectActive: () => false,
			isUiTarget: () => false,
			isInteractiveEditorTarget: () => false,
			refreshGeometry: () => ({ width: 500 }),
			getSvgRect: () => ({ left: 0, top: 0, width: 500, height: 800, right: 500, bottom: 800, x: 0, y: 0, toJSON: () => ({}) }),
			clientToOverlay: (x, y) => [x, y],
			effectiveScaleX: () => 1,
		});

		const tapAt = (x: number, y: number) => {
			ctrl.trackPointerDown({ pointerId: 1, pointerType: "touch", button: 0, clientX: x, clientY: y, target: scrollDOM } as unknown as PointerEvent);
			ctrl.trackPointerEnd({ pointerId: 1, pointerType: "touch", clientX: x, clientY: y, isPrimary: true, target: scrollDOM } as unknown as PointerEvent, true);
		};

		return { ctrl, view, contentDOM, getDoc: () => state.doc.toString(), getHead: () => state.selection.main.head, tapAt, dispatch, flushRaf: () => rafQueue.splice(0).forEach((cb) => cb(16)) };
	}

	it("does not insert \\n or NBSP when tapToType is disabled", () => {
		const { getDoc, tapAt } = makeController(false, "Hello");
		tapAt(160, 144);
		expect(getDoc()).toBe("Hello");
	});

	it("inserts padding on tap and cleans it up automatically on blur or caret move if nothing was typed", () => {
		const { contentDOM, getDoc, tapAt, dispatch, flushRaf } = makeController(true, "Hello");
		tapAt(160, 144);
		expect(getDoc()).toContain("\n");
		expect(getDoc()).toContain("\u00A0");

		// Moving the caret away without typing triggers cleanup on next animation frame.
		dispatch({ selection: { anchor: 2 } });
		flushRaf();
		expect(getDoc()).toBe("Hello");

		// Tapping again and blurring also cleans up unused padding immediately.
		tapAt(160, 144);
		expect(getDoc()).not.toBe("Hello");
		contentDOM.dispatchEvent(new Event("blur"));
		expect(getDoc()).toBe("Hello");
	});

	it("keeps padding when the user actually types text at the tapped spot", () => {
		const { contentDOM, getDoc, getHead, tapAt, dispatch } = makeController(true, "Hello");
		tapAt(160, 144);
		const head = getHead();
		dispatch({ changes: { from: head, to: head, insert: "Note" }, selection: { anchor: head + 4 } });
		contentDOM.dispatchEvent(new Event("blur"));
		expect(getDoc()).toContain("\u00A0Note");
	});

	it("cleans up previous unused padding before applying a new tap", () => {
		const { getDoc, tapAt } = makeController(true, "Hello");
		tapAt(160, 144);
		const firstLen = getDoc().length;
		tapAt(80, 96);
		// Second tap should not stack on top of the first tap's unused newlines/NBSPs.
		expect(getDoc().length).toBeLessThan(firstLen);
	});
});
