/**
 * Formula mode & LaTeX conversion bar controller: buffers handwritten math strokes, runs offline
 * or Vision-LLM LaTeX recognition, shows the preview/edit/confirm bar, and hands off strokes to
 * the Gemini AI assistant.
 */
import type { EditorView } from "@codemirror/view";
import { Notice } from "obsidian";
import type { AssistantLaunchOptions } from "./aiAssistant";
import { docOf, isDomNode, winOf } from "./dom";
import { BBox, bbox } from "./geometry";
import { formatLatexFormula } from "./mathLatex";
import { recognizeMathStrokes, strokesToPngBase64 } from "./mathVision";
import { Point, Stroke, newId } from "./model";
import type { PencilSettings } from "./settings";
import type { XY } from "./shapes";
import type { InkStore } from "./store";
import { blockStylusTouch, onTap } from "./tap";
import { insertionPosForY } from "./tapToType";
import { readTapLineInfo } from "./tapToTypeView";

export interface PendingMath {
	path: string;
	strokeIds: string[];
	rawTex: string;
	midY: number;
	box: BBox;
}

export interface FormulaBarHost {
	readonly store: InkStore;
	getPath(): string | null;
	isDestroyed(): boolean;
	getSettings(): PencilSettings;
	placeStroke(s: Stroke): XY;
	refreshGeometry(): { width: number } | null;
	getSvgRect(): DOMRect;
	effectiveScaleX(): number;
	openAssistant?: (opts: AssistantLaunchOptions) => void;
}

export class FormulaBarController {
	private barEl: HTMLElement | null = null;
	private pendingMath: PendingMath | null = null;
	private buffer: string[] = [];
	private timer: number | null = null;

	constructor(
		private readonly view: EditorView,
		private readonly host: FormulaBarHost,
	) {}

	isUiTarget(target: EventTarget | null): boolean {
		return isDomNode(target, docOf(this.view)) && !!this.barEl && this.barEl.contains(target);
	}

	cancelTimer(): void {
		if (this.timer !== null) {
			winOf(this.view).clearTimeout(this.timer);
			this.timer = null;
		}
	}

	clearBuffer(): void {
		this.cancelTimer();
		this.buffer = [];
		if (!this.pendingMath) this.clearBar();
	}

	clearBar(): void {
		this.pendingMath = null;
		this.barEl?.remove();
		this.barEl = null;
	}

	refreshForSettings(settings: PencilSettings): void {
		if (!settings.mathMode || settings.tool !== "pen") this.clearBuffer();
	}

	recordPenStroke(strokeId: string): void {
		this.buffer.push(strokeId);
		this.showBufferBar();
		this.armTimer();
	}

	destroy(): void {
		this.clearBuffer();
		this.clearBar();
	}

	openGeminiForStrokes(strokes: readonly Stroke[], initialPrompt?: string): void {
		const path = this.host.getPath();
		if (!path || !this.host.openAssistant || strokes.length === 0) return;
		const overlayStrokes: Stroke[] = [];
		let minX = Infinity;
		let minY = Infinity;
		let maxX = -Infinity;
		let maxY = -Infinity;
		for (const s of strokes) {
			const [ox, top] = this.host.placeStroke(s);
			const pts = s.points.map((p): Point => [p[0] + ox, p[1] + top, p[2]]);
			const b = bbox(pts);
			if (!b) continue;
			minX = Math.min(minX, b.minX);
			minY = Math.min(minY, b.minY);
			maxX = Math.max(maxX, b.maxX);
			maxY = Math.max(maxY, b.maxY);
			overlayStrokes.push({ ...s, points: pts });
		}
		if (overlayStrokes.length === 0 || !Number.isFinite(minX)) return;
		const png = strokesToPngBase64(overlayStrokes, { minX, minY, maxX, maxY });
		const noteTitle = path.slice(path.lastIndexOf("/") + 1).replace(/\.md$/i, "");
		const noteContext = this.view.state.doc.toString();
		this.host.openAssistant({
			noteTitle,
			noteContext,
			imageBase64Png: png,
			initialPrompt,
			insertAtCursor: (text) => {
				if (this.host.isDestroyed() || this.host.getPath() !== path) return false;
				const st = this.view.state;
				const head = st.selection.main.head;
				const prefix = head > 0 && st.doc.sliceString(head - 1, head) !== "\n" ? "\n\n" : "";
				const ins = `${prefix}${text}\n`;
				this.view.dispatch({
					changes: { from: head, insert: ins },
					selection: { anchor: head + ins.length },
					userEvent: "input",
				});
				return true;
			},
		});
	}

	async convertStrokesToLatex(strokes: readonly Stroke[]): Promise<boolean> {
		const path = this.host.getPath();
		if (!path || !this.host.store.isLoaded(path) || this.host.isDestroyed() || strokes.length === 0) return false;
		const overlayStrokes: Stroke[] = [];
		let minX = Infinity;
		let minY = Infinity;
		let maxX = -Infinity;
		let maxY = -Infinity;
		for (const s of strokes) {
			if (s.tool === "highlighter") continue;
			const [ox, top] = this.host.placeStroke(s);
			const pts = s.points.map((p): Point => [p[0] + ox, p[1] + top, p[2]]);
			const b = bbox(pts);
			if (!b) continue;
			minX = Math.min(minX, b.minX);
			minY = Math.min(minY, b.minY);
			maxX = Math.max(maxX, b.maxX);
			maxY = Math.max(maxY, b.maxY);
			overlayStrokes.push({ ...s, points: pts });
		}
		if (overlayStrokes.length === 0 || !Number.isFinite(minX)) return false;

		const settings = this.host.getSettings();
		const box: BBox = { minX, minY, maxX, maxY };
		const bar = this.ensureBar();
		if (bar) {
			bar.empty();
			bar.createSpan({ cls: "pl-math-status", text: "Formel wird erkannt…" });
		}
		const { tex: rawTex, usedVision } = await recognizeMathStrokes(overlayStrokes, box, {
			provider: settings.mathProvider,
			apiKey: settings.mathApiKey,
			geminiApiKey: settings.geminiApiKey,
			geminiModel: settings.geminiModel,
		});
		if (this.host.isDestroyed() || this.host.getPath() !== path || !this.host.store.isLoaded(path)) return false;
		if (!rawTex.trim()) {
			this.clearBar();
			new Notice("Keine Formel erkannt — tippe auf das Lasso-Menü oder hinterlege einen Gemini API-Key für handschriftliche Formeln.");
			return false;
		}
		this.showConfirmBar(
			{
				path,
				strokeIds: strokes.map((s) => s.id),
				rawTex,
				midY: (minY + maxY) / 2,
				box,
			},
			usedVision,
		);
		return true;
	}

	private ensureBar(): HTMLElement | null {
		const leaf = this.view.scrollDOM.closest?.<HTMLElement>(".workspace-leaf-content") ?? null;
		if (!leaf || typeof leaf.createDiv !== "function") return null;
		if (!this.barEl || !this.barEl.isConnected) {
			const bar = leaf.createDiv({ cls: "pl-math-bar" });
			bar.addEventListener("pointerdown", (e) => e.stopPropagation());
			blockStylusTouch(bar);
			this.barEl = bar;
		}
		return this.barEl;
	}

	private showBufferBar(): void {
		const bar = this.ensureBar();
		if (!bar) return;
		bar.empty();
		const count = this.buffer.length;
		bar.createSpan({ cls: "pl-math-status", text: `Formel (${count} ${count === 1 ? "Strich" : "Striche"})` });
		const go = bar.createEl("button", { cls: "mod-cta pl-math-btn", text: "→ LaTeX" });
		onTap(go, () => {
			this.cancelTimer();
			void this.flushBuffer();
		});
		const cancel = bar.createEl("button", { cls: "pl-math-btn", text: "×" });
		onTap(cancel, () => {
			this.clearBuffer();
			this.clearBar();
		});
	}

	private showConfirmBar(pending: PendingMath, usedVision: boolean): void {
		const bar = this.ensureBar();
		if (!bar) {
			// Headless / test environment fallback: commit immediately.
			this.pendingMath = pending;
			this.commitPendingMath(pending.rawTex);
			return;
		}
		this.pendingMath = pending;
		bar.empty();
		bar.createSpan({ cls: "pl-math-badge", text: usedVision ? "Gemini LaTeX" : "LaTeX" });
		const input = bar.createEl("input", {
			cls: "pl-math-input",
			type: "text",
			value: pending.rawTex,
			attr: { "aria-label": "Erkannte LaTeX-Formel bearbeiten" },
		});
		input.addEventListener("keydown", (e) => {
			if (e.key === "Enter") {
				e.preventDefault();
				this.commitPendingMath(input.value);
			} else if (e.key === "Escape") {
				e.preventDefault();
				this.clearBar();
			}
		});
		const insertBtn = bar.createEl("button", { cls: "mod-cta pl-math-btn", text: "Einfügen" });
		onTap(insertBtn, () => this.commitPendingMath(input.value));
		if (this.host.openAssistant) {
			const geminiBtn = bar.createEl("button", { cls: "pl-math-btn", text: "Gemini" });
			onTap(geminiBtn, () => {
				const ink = this.host.store.get(pending.path);
				const ids = new Set(pending.strokeIds);
				const src = (ink?.strokes ?? []).filter((s) => ids.has(s.id));
				if (src.length > 0) this.openGeminiForStrokes(src, "Wandle diese handschriftliche Formel in sauberes Obsidian-LaTeX ($...$ / $$...$$) um.");
			});
		}
		const cancelBtn = bar.createEl("button", { cls: "pl-math-btn", text: "Behalten" });
		onTap(cancelBtn, () => this.clearBar());
	}

	private commitPendingMath(rawTex: string): boolean {
		const pending = this.pendingMath;
		this.clearBar();
		const path = this.host.getPath();
		if (!pending || this.host.isDestroyed() || path !== pending.path || !this.host.store.isLoaded(pending.path)) return false;
		const settings = this.host.getSettings();
		const formatted = formatLatexFormula(rawTex, settings.mathDelimiters);
		if (!formatted) {
			new Notice("Leere Formel — Handschrift wurde behalten.");
			return false;
		}
		const ink = this.host.store.get(pending.path);
		const onCanvas = new Set((ink?.strokes ?? []).map((s) => s.id));
		const removeIds = pending.strokeIds.filter((id) => onCanvas.has(id));
		if (removeIds.length > 0) this.host.store.removeStrokes(pending.path, removeIds, newId());

		this.host.refreshGeometry();
		const rect = this.host.getSvgRect();
		const sx = this.host.effectiveScaleX();
		const doc = this.view.state.doc;
		const sy = this.view.scaleY || 1;
		const lineH = (this.view.defaultLineHeight || 24) / sy;
		const lastLine = readTapLineInfo(this.view, doc.lines, rect.left, sx);
		const midY = pending.midY;
		const targetLine = midY <= lastLine.bottom + lineH * 0.4
			? doc.lineAt(this.view.lineBlockAtHeight(Math.max(0, midY) * sy).from)
			: doc.line(doc.lines);
		const { prefixNewlines, from } = insertionPosForY(midY, lastLine, lineH, targetLine.to, doc.length);
		const existingLine = doc.lineAt(from);
		const leading =
			prefixNewlines > 0
				? "\n".repeat(prefixNewlines)
				: existingLine.text.trim().length > 0 && formatted.startsWith("$$")
					? "\n"
					: existingLine.length > 0
						? " "
						: "";
		const insert = `${leading}${formatted}`;
		this.view.dispatch({
			changes: { from, to: from, insert },
			selection: { anchor: from + insert.length },
			userEvent: "input",
		});
		new Notice(`LaTeX eingefügt: ${formatted}`, 2500);
		return true;
	}

	private armTimer(): void {
		this.cancelTimer();
		const delay = this.host.getSettings().mathAutoDelayMs || 1600;
		this.timer = winOf(this.view).setTimeout(() => {
			this.timer = null;
			void this.flushBuffer();
		}, delay);
	}

	private async flushBuffer(): Promise<void> {
		const path = this.host.getPath();
		const ids = new Set(this.buffer);
		this.buffer = [];
		if (ids.size === 0 || !path || !this.host.store.isLoaded(path) || this.host.isDestroyed()) return;
		const ink = this.host.store.get(path);
		if (!ink) return;
		const strokes = ink.strokes.filter((s) => ids.has(s.id));
		if (strokes.length === 0) return;
		await this.convertStrokesToLatex(strokes);
	}
}
