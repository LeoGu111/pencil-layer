/**
 * Selection & paste context menu DOM controller (HTML overlay inside `view.scrollDOM` so it
 * scrolls smoothly with the note).
 */
import type { EditorView } from "@codemirror/view";
import { setIcon, setTooltip } from "obsidian";
import { docOf, isDomNode } from "./dom";
import type { BBox } from "./geometry";
import { inkColor } from "./inkColor";
import { MenuState, menuForSelection, placeMenu } from "./menu";
import type { Tool } from "./model";
import { HIGHLIGHTER_COLORS, PEN_COLORS } from "./settings";
import type { XY } from "./shapes";
import { blockStylusTouch, onTap } from "./tap";

export interface SelectionMenuHost {
	hasClipboard(): boolean;
	isInkVisible(): boolean;
	colorTool(): Tool;
	canAskAssistant(): boolean;
	onPaste(at: XY): void;
	onCopy(): void;
	onCut(): void;
	onDuplicate(): void;
	onDelete(): void;
	onRecolor(color: string): void;
	onToLatex(): void;
	onAskGemini(): void;
	onScreenshot(): void;
	onMenuStateChanged(): void;
}

export class SelectionMenuController {
	private menuEl: HTMLElement | null = null;
	private state: MenuState | null = null;
	/** Target + contents the menu was last placed for (it is not re-placed while scrolling). */
	private menuKey = "";

	constructor(
		private readonly view: EditorView,
		private readonly host: SelectionMenuHost,
	) {}

	get isOpen(): boolean {
		return !!this.state;
	}

	get kind(): MenuState["kind"] | null {
		return this.state?.kind ?? null;
	}

	isUiTarget(target: EventTarget | null): boolean {
		return isDomNode(target, docOf(this.view)) && !!this.menuEl && this.menuEl.contains(target);
	}

	showSelection(): void {
		this.state = { kind: "selection", colors: false };
		this.menuKey = "";
		this.build();
		this.host.onMenuStateChanged();
	}

	showPaste(at: XY): void {
		if (!this.host.hasClipboard()) return;
		this.state = { kind: "paste", at };
		this.menuKey = "";
		this.build();
		this.host.onMenuStateChanged();
	}

	close(): void {
		if (!this.state) return;
		this.state = null;
		this.menuKey = "";
		if (this.menuEl) this.menuEl.classList.add("pl-hidden");
	}

	render(
		box: BBox | null,
		hasGeo: boolean,
		dragging: boolean,
		svgRect: DOMRect,
		sx: number,
		sy: number,
	): void {
		const next = menuForSelection(this.state, !!box);
		if (next !== this.state) {
			this.state = next;
			this.menuKey = "";
			if (next) this.build();
		}
		const el = this.menuEl;
		if (!el) return;
		if (!this.state || !hasGeo || dragging || !this.host.isInkVisible()) {
			el.classList.add("pl-hidden");
			return;
		}
		const sd = this.view.scrollDOM;
		const sRect = sd.getBoundingClientRect();
		const sdScaleX = sd.offsetWidth > 0 && sRect.width > 0 ? sRect.width / sd.offsetWidth : 1;
		const sdScaleY = sd.offsetHeight > 0 && sRect.height > 0 ? sRect.height / sd.offsetHeight : 1;
		const ox = (svgRect.left - sRect.left) / sdScaleX + sd.scrollLeft;
		const oy = (svgRect.top - sRect.top) / sdScaleY + sd.scrollTop;
		const target: BBox =
			this.state.kind === "paste"
				? { minX: this.state.at[0], minY: this.state.at[1], maxX: this.state.at[0], maxY: this.state.at[1] }
				: box!;
		const t: BBox = {
			minX: target.minX * (sx / sdScaleX) + ox,
			minY: target.minY * (sy / sdScaleY) + oy,
			maxX: target.maxX * (sx / sdScaleX) + ox,
			maxY: target.maxY * (sy / sdScaleY) + oy,
		};
		el.classList.remove("pl-hidden");
		const w = el.offsetWidth;
		const h = el.offsetHeight;
		const key = `${this.state.kind}:${this.state.kind === "selection" && this.state.colors}:${t.minX},${t.minY},${t.maxX},${t.maxY}:${w}x${h}`;
		if (key === this.menuKey) return;
		this.menuKey = key;
		const visible: BBox = { minX: sd.scrollLeft, minY: sd.scrollTop, maxX: sd.scrollLeft + sd.clientWidth, maxY: sd.scrollTop + sd.clientHeight };
		const p = placeMenu(t, { width: w, height: h }, visible);
		el.style.left = `${p.left}px`;
		el.style.top = `${p.top}px`;
		el.dataset.side = p.side;
	}

	destroy(): void {
		this.state = null;
		this.menuEl?.remove();
		this.menuEl = null;
	}

	private ensureEl(): HTMLElement {
		if (this.menuEl) return this.menuEl;
		const el = this.view.scrollDOM.createDiv({ cls: "pl-menu", attr: { role: "menu" } });
		const keep = (e: Event) => {
			e.preventDefault();
			e.stopPropagation();
		};
		el.addEventListener("pointerdown", keep);
		el.addEventListener("mousedown", keep);
		el.addEventListener("touchstart", (e) => e.stopPropagation(), { passive: true });
		blockStylusTouch(el);
		this.menuEl = el;
		return el;
	}

	private build(): void {
		const el = this.ensureEl();
		el.empty();
		const m = this.state;
		if (!m) return;
		if (m.kind === "paste") {
			const at = m.at;
			this.item(el, "clipboard-paste", "Paste", () => this.host.onPaste(at));
			return;
		}
		if (m.colors) {
			this.item(el, "chevron-left", "Back", () => this.setColorsOpen(false), "pl-menu-back");
			const palette = this.host.colorTool() === "pen" ? PEN_COLORS : HIGHLIGHTER_COLORS;
			for (const c of palette) {
				const b = this.item(el, null, c.label, () => this.host.onRecolor(c.value), "pl-menu-color");
				b.createSpan({ cls: "pl-color-dot" }).style.background = inkColor(c.value, "screen");
			}
			return;
		}
		this.item(el, "copy", "Copy", () => this.host.onCopy());
		this.item(el, "scissors", "Cut", () => this.host.onCut());
		this.item(el, "copy-plus", "Duplicate", () => this.host.onDuplicate());
		this.item(el, "trash-2", "Delete", () => this.host.onDelete());
		this.item(el, "palette", "Color", () => this.setColorsOpen(true), "pl-menu-sub");
		this.item(el, "fx", "To LaTeX", () => this.host.onToLatex());
		if (this.host.canAskAssistant()) {
			this.item(el, "sparkles", "Frag KI", () => this.host.onAskGemini());
		}
		this.item(el, "camera", "Screenshot", () => this.host.onScreenshot());
	}

	private setColorsOpen(open: boolean): void {
		if (this.state?.kind !== "selection") return;
		this.state.colors = open;
		this.build();
		this.host.onMenuStateChanged();
	}

	private item(parent: HTMLElement, icon: string | null, label: string, run: () => void, cls = ""): HTMLElement {
		const b = parent.createDiv({
			cls: `pl-menu-item ${cls}`.trim(),
			attr: { role: "menuitem", tabindex: "-1", "aria-label": label },
		});
		if (icon === "fx") {
			const span = b.createSpan({ cls: "pl-menu-icon pl-fx-badge", text: "fx" });
			if (!span.parentElement) b.appendChild(span);
			b.createSpan({ cls: "pl-menu-label", text: label });
		} else if (icon) {
			setIcon(b.createSpan({ cls: "pl-menu-icon" }), icon);
			if (cls !== "pl-menu-back") b.createSpan({ cls: "pl-menu-label", text: label });
		} else {
			setTooltip(b, label, { placement: "top" });
		}
		if (cls === "pl-menu-sub") setIcon(b.createSpan({ cls: "pl-menu-chevron" }), "chevron-right");
		onTap(b, run);
		return b;
	}
}
