/**
 * Page zoom controller for `InkView`: manages `.cm-sizer` / `.cm-content` CSS zoom, scroll-anchor
 * math, two-finger pinch-to-zoom, Ctrl/Cmd+Wheel zoom, the zoom spacer, and the floating `% · ↺`
 * reset badge.
 */
import type { EditorView } from "@codemirror/view";
import { blockStylusTouch, onTap } from "./tap";
import {
	PinchActivation,
	ZOOM_MAX,
	ZOOM_MIN,
	ZOOM_STEP,
	clampZoom,
	distanceBetween,
	formatZoomPercent,
	midpoint,
	pinchScale,
	scrollForZoomAnchor,
	wheelZoomFactor,
} from "./zoom";

export interface ZoomSize {
	width: number;
	height: number;
}

export interface ZoomHost {
	getOverlayGeo(): ZoomSize | null;
	onZoomApplied(): void;
	onZoomNeedsRender(): void;
}

export class ZoomController {
	private zoom = 1;
	private sizerEl: HTMLElement | null = null;
	private zoomBaseSizerWidth: number | null = null;
	private zoomSpacer: HTMLElement | null = null;
	private zoomBadge: HTMLElement | null = null;
	private pinch: {
		activation: PinchActivation;
		startZoom: number;
		prevMid: { x: number; y: number };
		lastZoom: number;
	} | null = null;

	constructor(
		private readonly view: EditorView,
		private readonly svg: SVGSVGElement,
		private readonly host: ZoomHost,
	) {}

	/**
	 * Mount the overlay SVG inside `.cm-sizer` when available so text, ink, page guides, and rulers
	 * share one rigid CSS zoom transform and never drift during pinch-to-zoom.
	 */
	mountOverlay(): void {
		this.sizerEl = this.zoomTargetEl();
		if (this.sizerEl) {
			this.sizerEl.classList.add("pl-zoom-host");
			this.sizerEl.appendChild(this.svg);
		} else {
			this.view.scrollDOM.appendChild(this.svg);
		}
	}

	get sizer(): HTMLElement | null {
		return this.sizerEl;
	}

	getZoom(): number {
		return this.zoom;
	}

	zoomBy(factor: number): void {
		const sd = this.view.scrollDOM;
		const r = sd.getBoundingClientRect();
		const focal = { x: r.left + (sd.clientWidth || 400) / 2, y: r.top + (sd.clientHeight || 400) / 2 };
		this.setZoom(this.zoom * factor, focal);
	}

	zoomIn(): void {
		this.zoomBy(1 + ZOOM_STEP);
	}

	zoomOut(): void {
		this.zoomBy(1 / (1 + ZOOM_STEP));
	}

	resetZoom(): void {
		this.setZoom(1);
	}

	setZoom(nextZoom: number, focalClient?: { x: number; y: number }, prevFocalClient?: { x: number; y: number }): void {
		const target = clampZoom(nextZoom, ZOOM_MIN, ZOOM_MAX);
		const prev = this.zoom;
		const sd = this.view.scrollDOM;
		const sRect = sd.getBoundingClientRect();
		const oldScrollLeft = sd.scrollLeft;
		const oldScrollTop = sd.scrollTop;
		const sizer = this.sizerEl ?? this.zoomTargetEl();
		const anchorEl = sizer ?? this.view.contentDOM;
		const beforeRect = anchorEl.getBoundingClientRect();
		if (prev === 1 && target !== 1 && anchorEl && anchorEl.offsetWidth > 0) {
			this.zoomBaseSizerWidth = anchorEl.offsetWidth;
		} else if (target === 1) {
			this.zoomBaseSizerWidth = null;
		}
		this.zoom = target;
		this.applyZoomDom();
		if (focalClient && prev > 0) {
			const ratio = target / prev;
			const afterRect = anchorEl.getBoundingClientRect();
			if ((beforeRect.width ?? 0) > 0 && (afterRect.width ?? 0) > 0) {
				const pf = prevFocalClient ?? focalClient;
				const curX = afterRect.left + (pf.x - beforeRect.left) * ratio;
				const curY = afterRect.top + (pf.y - beforeRect.top) * ratio;
				const sdScaleX = sd.offsetWidth > 0 && sRect.width > 0 ? sRect.width / sd.offsetWidth : 1;
				const sdScaleY = sd.offsetHeight > 0 && sRect.height > 0 ? sRect.height / sd.offsetHeight : 1;
				sd.scrollLeft = Math.max(0, sd.scrollLeft + (curX - focalClient.x) / sdScaleX);
				sd.scrollTop = Math.max(0, sd.scrollTop + (curY - focalClient.y) / sdScaleY);
			} else {
				const fx0 = (prevFocalClient?.x ?? focalClient.x) - sRect.left;
				const fy0 = (prevFocalClient?.y ?? focalClient.y) - sRect.top;
				const fx1 = focalClient.x - sRect.left;
				const fy1 = focalClient.y - sRect.top;
				sd.scrollLeft = scrollForZoomAnchor(oldScrollLeft, fx0, ratio, fx1);
				sd.scrollTop = scrollForZoomAnchor(oldScrollTop, fy0, ratio, fy1);
			}
		}
		this.host.onZoomApplied();
		this.updateBadge();
		if (Math.abs(target - prev) > 1e-4) this.host.onZoomNeedsRender();
	}

	zoomTargetEl(): HTMLElement | null {
		const sd = this.view.scrollDOM;
		for (let el = this.view.contentDOM?.parentElement ?? null; el && el !== sd; el = el.parentElement) {
			if (el.classList?.contains("cm-sizer")) return el;
		}
		const children = sd.children ? Array.from(sd.children) : [];
		for (const c of children) {
			if (c.classList?.contains("cm-sizer")) return c as HTMLElement;
		}
		return null;
	}

	updateSpacer(geo: ZoomSize | null): void {
		const sd = this.view.scrollDOM;
		if (this.zoom === 1) {
			this.zoomSpacer?.remove();
			this.zoomSpacer = null;
			return;
		}
		const target = this.sizerEl ?? this.zoomTargetEl() ?? (this.view.contentDOM.offsetWidth > 0 ? this.view.contentDOM : null);
		if (!target || typeof sd.createDiv !== "function") return;
		if (!this.zoomSpacer || !this.zoomSpacer.isConnected) {
			this.zoomSpacer = sd.createDiv({ cls: "pl-zoom-spacer", attr: { "aria-hidden": "true" } });
		}
		const w = Math.ceil((target.offsetLeft || 0) + Math.max(target.offsetWidth, (geo?.width ?? 0) + 80) * this.zoom);
		const h = Math.ceil((target.offsetTop || 0) + Math.max(target.offsetHeight, (geo?.height ?? 0) + 120) * this.zoom);
		this.zoomSpacer.style.width = `${w}px`;
		this.zoomSpacer.style.height = `${h}px`;
	}

	handleWheel(e: WheelEvent, isUiTarget: (t: EventTarget | null) => boolean): boolean {
		if (!e.ctrlKey && !e.metaKey) return false;
		if (isUiTarget(e.target)) return false;
		e.preventDefault();
		e.stopPropagation();
		this.setZoom(this.zoom * wheelZoomFactor(e.deltaY), { x: e.clientX, y: e.clientY });
		return true;
	}

	/** Handle two-finger pinch-to-zoom + focal-point pan; returns true if the touch event was consumed. */
	handleTouchPinch(e: TouchEvent, direct: readonly { x: number; y: number }[]): boolean {
		if (direct.length === 2) {
			if (e.cancelable) e.preventDefault();
			const dist = distanceBetween(direct[0], direct[1]);
			const mid = midpoint(direct[0], direct[1]);
			if (e.type === "touchstart" || !this.pinch) {
				this.pinch = {
					activation: new PinchActivation(dist, 0.03),
					startZoom: this.zoom,
					prevMid: mid,
					lastZoom: this.zoom,
				};
			} else if (e.type === "touchmove") {
				if (e.cancelable) e.preventDefault();
				const ratio = this.pinch.activation.ratio(dist);
				const nextZoom = this.pinch.activation.active
					? pinchScale(this.pinch.startZoom, 1, ratio, ZOOM_MIN, ZOOM_MAX)
					: this.pinch.startZoom;
				this.setZoom(nextZoom, mid, this.pinch.prevMid);
				this.pinch.prevMid = mid;
				this.pinch.lastZoom = nextZoom;
			}
			return true;
		}
		if (this.pinch && (e.type === "touchend" || e.type === "touchcancel" || direct.length < 2)) {
			this.pinch = null;
		}
		return false;
	}

	resetPinch(): void {
		this.pinch = null;
	}

	isBadgeTarget(target: Node): boolean {
		return !!this.zoomBadge && this.zoomBadge.contains(target);
	}

	destroy(): void {
		this.resetZoomDom();
		this.zoomSpacer?.remove();
		this.zoomSpacer = null;
		this.zoomBadge?.remove();
		this.zoomBadge = null;
		this.pinch = null;
	}

	private applyZoomDom(): void {
		const z = this.zoom;
		const sizer = this.sizerEl ?? this.zoomTargetEl();
		const widthLock = z === 1 || !this.zoomBaseSizerWidth ? "" : `${this.zoomBaseSizerWidth}px`;
		if (sizer) {
			sizer.classList.add("pl-zoom-host");
			if (this.svg.parentElement !== sizer) {
				this.sizerEl = sizer;
				sizer.appendChild(this.svg);
			}
			sizer.classList.toggle("pl-zoom-target", z !== 1);
			sizer.setCssProps({
				"--pl-zoom-scale": z === 1 ? "" : String(z),
				"--pl-zoom-width": widthLock,
			});
			this.svg.setCssProps({ transform: "" });
		} else {
			const cd = this.view.contentDOM;
			cd.classList?.toggle("pl-zoom-target", z !== 1);
			cd.setCssProps?.({
				"--pl-zoom-scale": z === 1 ? "" : String(z),
				"--pl-zoom-width": widthLock,
			});
			this.svg.setCssProps({ transform: z === 1 ? "" : `scale(${z})` });
		}
		this.updateSpacer(this.host.getOverlayGeo());
	}

	private resetZoomDom(): void {
		this.zoom = 1;
		this.zoomBaseSizerWidth = null;
		const sizer = this.sizerEl ?? this.zoomTargetEl();
		if (sizer) {
			sizer.classList.remove("pl-zoom-target", "pl-zoom-host");
			sizer.setCssProps({ "--pl-zoom-scale": "", "--pl-zoom-width": "" });
		} else {
			const cd = this.view.contentDOM;
			cd.classList?.remove("pl-zoom-target");
			cd.setCssProps?.({ "--pl-zoom-scale": "", "--pl-zoom-width": "" });
		}
		this.svg.setCssProps({ transform: "" });
	}

	private updateBadge(): void {
		if (Math.abs(this.zoom - 1) < 0.005) {
			this.zoomBadge?.remove();
			this.zoomBadge = null;
			return;
		}
		const leaf = this.view.scrollDOM.closest?.<HTMLElement>(".workspace-leaf-content") ?? null;
		if (!leaf || typeof leaf.createDiv !== "function") return;
		if (!this.zoomBadge || !this.zoomBadge.isConnected) {
			const b = leaf.createDiv({ cls: "pl-zoom-badge", attr: { role: "button", "aria-label": "Zoom auf 100% zurücksetzen" } });
			b.addEventListener("pointerdown", (e) => {
				e.preventDefault();
				e.stopPropagation();
			});
			blockStylusTouch(b);
			onTap(b, () => this.resetZoom());
			this.zoomBadge = b;
		}
		this.zoomBadge.setText(`${formatZoomPercent(this.zoom)} · ↺`);
	}
}
