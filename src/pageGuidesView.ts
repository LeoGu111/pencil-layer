/**
 * Editor page boundary guides (A4/A3/Letter) and dynamic bottom canvas room controller.
 */
import type { EditorView } from "@codemirror/view";
import { docOf, svgEl } from "./dom";
import type { BBox } from "./geometry";
import { PX_PER_CM } from "./geometryGuide";
import type { InkFile, Stroke } from "./model";
import { buildPageGuideLayout, computeCanvasBottomPadding, PageGuideFormat } from "./pageGuides";
import type { PencilSettings } from "./settings";

export interface PageGuideGeometry {
	left: number;
	width: number;
	height: number;
}

export class PageGuidesController {
	readonly group: SVGGElement;
	private pageGuideKey = "";
	private extraPages = 2;
	private lastBottomPad = -1;

	constructor(private readonly view: EditorView) {
		this.group = svgEl(docOf(view), "g", "pl-guides");
	}

	resetForNote(): void {
		this.extraPages = 2;
		this.lastBottomPad = -1;
		this.pageGuideKey = "";
	}

	addBlankPage(): void {
		this.extraPages = Math.min(40, this.extraPages + 1);
	}

	bumpIfNearBottom(boxMaxY: number, geoHeight: number): void {
		if (boxMaxY > geoHeight - 320) {
			this.extraPages = Math.min(40, this.extraPages + 1);
		}
	}

	/**
	 * Ensure `.cm-content` has scrollable room below the document when ink is active without
	 * imposing an unconditional `120vh !important` height on all Markdown notes.
	 */
	syncCanvasRoom(
		ink: InkFile | undefined,
		settings: PencilSettings,
		hasPath: boolean,
		placeY: (s: Stroke) => number,
		boxOf: (s: Stroke) => BBox,
	): void {
		const cd = this.view.contentDOM;
		if (!cd || !cd.style) return;
		if (!hasPath || !settings.inkVisible) {
			if (this.lastBottomPad !== 0) {
				this.lastBottomPad = 0;
				this.clearCanvasRoomDom(cd);
			}
			return;
		}
		const sd = this.view.scrollDOM;
		let lowestInkY = 0;
		if (ink && ink.strokes.length > 0) {
			for (const st of ink.strokes) {
				if (st.text) continue;
				const top = placeY(st);
				const b = boxOf(st);
				if (top + b.maxY > lowestInkY) lowestInkY = top + b.maxY;
			}
		}
		const docH = (this.view.contentHeight ?? 0) / (this.view.scaleY || 1);
		const pad = computeCanvasBottomPadding({
			format: settings.pageGuide,
			docHeight: docH,
			viewportHeight: sd.clientHeight || 900,
			lowestInkY,
			extraPages: this.extraPages,
		});
		if (Math.abs(pad - this.lastBottomPad) >= 8) {
			this.lastBottomPad = pad;
			cd.classList?.add("pl-canvas-room");
			if (typeof cd.setCssProps === "function") {
				cd.setCssProps({ "--pl-canvas-pad-bottom": `${pad}px` });
			} else {
				cd.style.paddingBottom = `${pad}px`;
			}
		}
	}

	render(fmt: PageGuideFormat, geo: PageGuideGeometry): void {
		const sd = this.view.scrollDOM;
		const doc = docOf(this.view);
		const visW = Math.round(sd.clientWidth || geo.width);
		const leftMargin = Math.max(0, Math.round(geo.left));
		const key = `${fmt}:${Math.round(geo.width)}x${Math.round(geo.height)}:${visW}:${leftMargin}`;
		if (key === this.pageGuideKey) return;
		this.pageGuideKey = key;
		this.group.replaceChildren();
		const layout = buildPageGuideLayout(fmt, geo.width, geo.height, Math.max(200, visW - leftMargin));
		if (!layout) return;
		const totalH = layout.totalHeight;
		const sheetW = layout.sheetWidth;
		const paperLeft = layout.paperLeftX;
		const paperRight = layout.paperRightX;

		// Subtle shading OUTSIDE the physical paper (beyond the 1 cm print margins).
		const leftOuterW = leftMargin + paperLeft;
		if (leftOuterW > 4) {
			const leftShade = svgEl(doc, "rect", "pl-guide-overflow");
			leftShade.setAttribute("x", String(-leftMargin));
			leftShade.setAttribute("y", "0");
			leftShade.setAttribute("width", String(leftOuterW));
			leftShade.setAttribute("height", String(totalH));
			this.group.appendChild(leftShade);
		}
		const rightShadeW = Math.max(geo.width - paperRight, visW - leftMargin - paperRight);
		if (rightShadeW > 2) {
			const shade = svgEl(doc, "rect", "pl-guide-overflow");
			shade.setAttribute("x", String(paperRight));
			shade.setAttribute("y", "0");
			shade.setAttribute("width", String(rightShadeW));
			shade.setAttribute("height", String(totalH));
			this.group.appendChild(shade);
		}

		const addLine = (cls: string, x1: number, y1: number, x2: number, y2: number) => {
			const l = svgEl(doc, "line", cls);
			l.setAttribute("x1", String(x1));
			l.setAttribute("y1", String(y1));
			l.setAttribute("x2", String(x2));
			l.setAttribute("y2", String(y2));
			this.group.appendChild(l);
		};
		// Outer paper borders (exact DIN A4 = 21 cm, A3 = 29.7 cm, etc.)
		addLine("pl-guide-line pl-guide-paper", paperLeft, 0, paperLeft, totalH);
		addLine("pl-guide-line pl-guide-paper", paperRight, 0, paperRight, totalH);
		addLine("pl-guide-line pl-guide-paper", paperLeft, 0, paperRight, 0);
		// Subtle inner print margin lines (Druckrand: 1 cm inside left & right edges)
		addLine("pl-guide-line pl-guide-print-margin", 0, 0, 0, totalH);
		addLine("pl-guide-line pl-guide-print-margin", sheetW, 0, sheetW, totalH);

		const paperWCm = Math.round((layout.paperWidth / PX_PER_CM) * 10) / 10;
		const marginCm = Math.round((layout.marginPx / PX_PER_CM) * 10) / 10;
		const topLabel = svgEl(doc, "text", "pl-guide-label");
		topLabel.setAttribute("x", "8");
		topLabel.setAttribute("y", "14");
		topLabel.textContent = `${layout.metrics.label} (${paperWCm} cm · Druckrand ${marginCm} cm) · Seite 1`;
		this.group.appendChild(topLabel);

		layout.horizontalBreaks.forEach((y, idx) => {
			addLine("pl-guide-line pl-guide-break", paperLeft, y, paperRight, y);

			const label = svgEl(doc, "text", "pl-guide-label");
			label.setAttribute("x", String(layout.labelRightX));
			label.setAttribute("y", String(Math.max(14, y - 6)));
			label.setAttribute("text-anchor", "end");
			label.textContent = `${layout.metrics.label} · Ende Seite ${idx + 1}`;
			this.group.appendChild(label);

			const nextLabel = svgEl(doc, "text", "pl-guide-label");
			nextLabel.setAttribute("x", "8");
			nextLabel.setAttribute("y", String(y + 15));
			nextLabel.textContent = `${layout.metrics.label} · Seite ${idx + 2}`;
			this.group.appendChild(nextLabel);
		});
	}

	destroy(): void {
		const cd = this.view.contentDOM;
		if (cd) this.clearCanvasRoomDom(cd);
	}

	private clearCanvasRoomDom(cd: HTMLElement): void {
		cd.classList?.remove("pl-canvas-room");
		if (typeof cd.setCssProps === "function") {
			cd.setCssProps({ "--pl-canvas-pad-bottom": "" });
		}
		if (cd.style) cd.style.paddingBottom = "";
	}
}
