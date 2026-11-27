/**
 * Tap-to-Type controller for `InkView`: tracks passive finger/mouse taps outside existing text,
 * places the typing caret (optionally padding newlines/NBSP when `settings.tapToType` is enabled),
 * and automatically cleans up unused padding if the user moves away, blurs, or draws without typing.
 */
import { Annotation } from "@codemirror/state";
import type { EditorView, ViewUpdate } from "@codemirror/view";
import { docOf, isDomNode, winOf } from "./dom";
import type { PencilSettings } from "./settings";
import type { XY } from "./shapes";
import { TapLineInfo, TapPaddingRange, isPureTapPadding, isUnusedTapPadding, planTapToType } from "./tapToType";
import { unzoomedLineTop } from "./textHighlightView";

export const tapCleanupAnnotation = Annotation.define<boolean>();

export interface TapToTypeHost {
	isDestroyed(): boolean;
	getSettings(): PencilSettings;
	hasActiveInput(): boolean;
	hasSelection(): boolean;
	isDeskSelectActive(): boolean;
	isUiTarget(target: EventTarget | null): boolean;
	isInteractiveEditorTarget(target: EventTarget | null): boolean;
	refreshGeometry(): { width: number } | null;
	getSvgRect(): DOMRect;
	clientToOverlay(clientX: number, clientY: number, rect: DOMRect): XY;
	effectiveScaleX(): number;
}

export function readTapLineInfo(view: EditorView, lineNumber: number, svgLeft: number, sx: number): TapLineInfo {
	const doc = view.state.doc;
	const line = doc.line(lineNumber);
	const sy = view.scaleY || 1;
	const block = view.lineBlockAt(line.from);
	const top = unzoomedLineTop(view, line.from);
	const height = (block.bottom - block.top) / sy;
	const endCoords = view.coordsAtPos?.(line.to);
	const lineEndX = endCoords ? Math.max(0, (endCoords.right - svgLeft) / sx) : 0;
	return { top, bottom: top + height, lineTo: line.to, lineEndX };
}

export class TapToTypeController {
	private navTap: { id: number; x: number; y: number; t: number; moved: boolean } | null = null;
	private lastCompletedTap: { x: number; y: number; at: number } | null = null;
	private pendingPad: TapPaddingRange | null = null;
	private cleanupScheduled = false;

	private readonly onBlur = (): void => {
		this.cleanupUnusedPadding();
	};

	constructor(
		private readonly view: EditorView,
		private readonly host: TapToTypeHost,
	) {
		this.view.contentDOM?.addEventListener?.("blur", this.onBlur);
	}

	destroy(): void {
		this.view.contentDOM?.removeEventListener?.("blur", this.onBlur);
		this.navTap = null;
		this.lastCompletedTap = null;
		this.pendingPad = null;
	}

	onDetach(): void {
		this.navTap = null;
		this.lastCompletedTap = null;
		this.pendingPad = null;
	}

	trackPointerDown(e: PointerEvent): void {
		const canTapType =
			(e.pointerType === "touch" || (e.pointerType === "mouse" && e.button === 0)) &&
			!this.host.isInteractiveEditorTarget(e.target);
		this.navTap = canTapType ? { id: e.pointerId, x: e.clientX, y: e.clientY, t: performance.now(), moved: false } : null;
	}

	clearNavTap(): void {
		this.navTap = null;
	}

	trackPointerMove(e: PointerEvent): void {
		if (this.navTap && e.pointerId === this.navTap.id && Math.hypot(e.clientX - this.navTap.x, e.clientY - this.navTap.y) >= 10) {
			this.navTap.moved = true;
		}
	}

	trackPointerEnd(e: PointerEvent, completed: boolean): void {
		const nt = this.navTap;
		if (!nt || e.pointerId !== nt.id) return;
		this.navTap = null;
		if (
			completed &&
			!nt.moved &&
			performance.now() - nt.t < 450 &&
			Math.hypot(e.clientX - nt.x, e.clientY - nt.y) < 10 &&
			e.isPrimary
		) {
			if (e.pointerType === "touch" && !this.view.contentDOM.contains(e.target as Node)) {
				this.lastCompletedTap = null;
				this.applyTapToType(e.clientX, e.clientY, e.target);
			} else {
				this.lastCompletedTap = { x: e.clientX, y: e.clientY, at: performance.now() };
			}
		}
	}

	readonly onEditorClick = (e: MouseEvent): void => {
		const tap = this.lastCompletedTap;
		this.lastCompletedTap = null;
		if (!tap || performance.now() - tap.at > 400) return;
		if (e.defaultPrevented || this.host.hasActiveInput() || this.host.hasSelection()) return;
		const s = this.host.getSettings();
		if (s.mouseDraws || this.host.isDeskSelectActive()) return;
		if (this.host.isUiTarget(e.target) || this.host.isInteractiveEditorTarget(e.target)) return;
		if (!this.view.state.selection.main.empty) return;
		this.applyTapToType(e.clientX || tap.x, e.clientY || tap.y, e.target);
	};

	onViewUpdate(u: ViewUpdate): void {
		if (u.transactions.some((tr) => tr.annotation(tapCleanupAnnotation))) return;
		const pad = this.pendingPad;
		if (!pad) return;

		if (u.docChanged) {
			let touched = false;
			u.changes.iterChangedRanges((fromA, toA) => {
				if (toA >= pad.from && fromA <= pad.to) touched = true;
			});
			const newFrom = u.changes.mapPos(pad.from, -1);
			const newTo = u.changes.mapPos(pad.to, 1);
			if (newTo <= newFrom) {
				this.pendingPad = null;
				return;
			}
			const newDoc = u.state.doc;
			const slice = newDoc.sliceString(newFrom, newTo);
			if (touched && !isPureTapPadding(slice)) {
				// User typed non-padding text: keep the placement permanently.
				this.pendingPad = null;
				return;
			}
			const line = newDoc.lineAt(newTo);
			if (newDoc.sliceString(newTo, line.to).length > 0) {
				this.pendingPad = null;
				return;
			}
			const newAnchor = u.state.selection.main.head;
			this.pendingPad = { from: newFrom, to: newTo, anchor: newAnchor };
			return;
		}

		if (u.selectionSet) {
			const sel = u.state.selection.main;
			if (!sel.empty || sel.head !== pad.anchor) {
				this.scheduleCleanup();
			}
		}
	}

	cleanupUnusedPadding(): void {
		this.cleanupScheduled = false;
		const pad = this.pendingPad;
		if (!pad || this.host.isDestroyed()) return;
		this.pendingPad = null;
		const doc = this.view.state.doc;
		if (pad.from < 0 || pad.to > doc.length || pad.from >= pad.to) return;
		const slice = doc.sliceString(pad.from, pad.to);
		const line = doc.lineAt(pad.to);
		const restOfLine = doc.sliceString(pad.to, line.to);
		if (!isUnusedTapPadding(slice, restOfLine)) return;
		this.view.dispatch({
			changes: { from: pad.from, to: pad.to, insert: "" },
			annotations: tapCleanupAnnotation.of(true),
			userEvent: "delete.cleanup",
		});
	}

	private scheduleCleanup(): void {
		if (this.cleanupScheduled || !this.pendingPad || this.host.isDestroyed()) return;
		this.cleanupScheduled = true;
		winOf(this.view).requestAnimationFrame(() => {
			if (this.cleanupScheduled) this.cleanupUnusedPadding();
		});
	}

	private applyTapToType(clientX: number, clientY: number, target: EventTarget | null): void {
		if (this.host.isDestroyed()) return;
		// Clean up any prior unused tap padding before computing coordinates for the new tap.
		this.cleanupUnusedPadding();
		const geo = this.host.refreshGeometry();
		if (!geo) return;
		const rect = this.host.getSvgRect();
		const sx = this.host.effectiveScaleX();
		const [tapX, tapY] = this.host.clientToOverlay(clientX, clientY, rect);

		if (this.host.getSettings().tapToType) {
			const sy = this.view.scaleY || 1;
			const lineH = (this.view.defaultLineHeight || 24) / sy;
			const charW = (this.view.defaultCharacterWidth || 8.5) / (this.view.scaleX || 1);
			const doc = this.view.state.doc;
			const lastLine = readTapLineInfo(this.view, doc.lines, rect.left, sx);
			let lineAtTap: TapLineInfo | undefined;
			if (tapY <= lastLine.bottom + lineH * 0.4) {
				const block = this.view.lineBlockAtHeight(Math.max(0, tapY) * sy);
				const line = doc.lineAt(block.from);
				lineAtTap = readTapLineInfo(this.view, line.number, rect.left, sx);
			}
			const plan = planTapToType({
				docLength: doc.length,
				lineHeight: lineH,
				charWidth: charW,
				tapX,
				tapY,
				lastLine,
				lineAtTap,
			});
			if (plan) {
				this.view.dispatch({
					changes: { from: plan.from, to: plan.from, insert: plan.insert },
					selection: { anchor: plan.anchor },
					userEvent: "input",
				});
				this.pendingPad = {
					from: plan.from,
					to: plan.from + plan.insert.length,
					anchor: plan.anchor,
				};
				this.view.focus();
				return;
			}
		}

		if (isDomNode(target, docOf(this.view)) && !this.view.contentDOM.contains(target)) {
			const clampedX = rect.left + Math.max(4, Math.min(Math.max(4, geo.width - 4), tapX)) * sx;
			const pos = this.view.posAtCoords({ x: clampedX, y: clientY }, false);
			this.view.dispatch({ selection: { anchor: pos }, userEvent: "select.pointer" });
			this.view.focus();
		}
	}
}
