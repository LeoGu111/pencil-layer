/**
 * Interactive geometry guides controller (Straight Ruler / Lineal, 45° Set Square / Geodreieck,
 * and Compass / Zirkel): SVG rendering, drag/rotate/radius grips, and 2-finger pinch/rotate physics.
 */
import type { EditorView } from "@codemirror/view";
import { docOf, isDomNode, svgEl } from "./dom";
import {
	GuideEdge,
	PX_PER_CM,
	PX_PER_MM,
	RULER_HALF_LENGTH,
	RULER_HALF_THICKNESS,
	rulerGeometry,
	setSquareEdges,
	snapGuideAngle,
	twoFingerGuideTransform,
} from "./geometryGuide";
import type { PencilSettings } from "./settings";
import type { XY } from "./shapes";

export interface GeometryGuideHost {
	getSettings(): PencilSettings;
	updateSettings?(patch: Partial<PencilSettings>): void;
	hasActiveInput(): boolean;
	toOverlay(e: PointerEvent): XY;
	getGeo(): { top: number; width: number } | null;
	effectiveScaleY(): number;
}

export class GeometryGuideController {
	readonly group: SVGGElement;
	private readonly outline: SVGPathElement;
	private readonly ticks: SVGPathElement;
	private readonly labels: SVGGElement;
	private readonly grip: SVGCircleElement;
	private readonly rotateGrip: SVGCircleElement;
	private readonly resetBtn: SVGGElement;
	private readonly closeBtn: SVGGElement;

	private origin: XY | null = null;
	private drag:
		| { mode: "move"; id: number; offset: XY }
		| { mode: "rotate"; id: number; startAngle: number; startPointerAngle: number }
		| { mode: "radius"; id: number }
		| null = null;
	private readonly touches = new Map<number, XY>();
	private pinchStart: { origin: XY; angle: number; radius: number; a: XY; b: XY; idA: number; idB: number } | null = null;

	constructor(
		private readonly view: EditorView,
		private readonly host: GeometryGuideHost,
	) {
		const doc = docOf(view);
		this.group = svgEl(doc, "g", "pl-guide-tool pl-hidden");
		this.outline = svgEl(doc, "path", "pl-set-square");
		this.ticks = svgEl(doc, "path", "pl-guide-ticks");
		this.labels = svgEl(doc, "g", "pl-guide-labels");
		this.grip = svgEl(doc, "circle", "pl-set-square-grip");
		this.grip.setAttribute("r", "14");
		this.grip.setAttribute("aria-label", "Move guide");
		this.rotateGrip = svgEl(doc, "circle", "pl-guide-rotate-grip");
		this.rotateGrip.setAttribute("r", "13");
		this.rotateGrip.setAttribute("aria-label", "Rotate or resize guide");
		this.resetBtn = svgEl(doc, "g", "pl-guide-action pl-guide-reset");
		this.closeBtn = svgEl(doc, "g", "pl-guide-action pl-guide-close");

		for (const el of [this.outline, this.grip]) {
			el.addEventListener("pointerdown", this.onDown);
			el.addEventListener("pointermove", this.onMove);
			for (const event of ["pointerup", "pointercancel", "lostpointercapture"] as const) {
				el.addEventListener(event, this.onEnd);
			}
		}
		this.rotateGrip.addEventListener("pointerdown", this.onRotateDown);
		this.rotateGrip.addEventListener("pointermove", this.onMove);
		for (const event of ["pointerup", "pointercancel", "lostpointercapture"] as const) {
			this.rotateGrip.addEventListener(event, this.onEnd);
		}
		this.resetBtn.addEventListener("pointerdown", this.onResetDown);
		this.closeBtn.addEventListener("pointerdown", this.onCloseDown);
		this.group.append(
			this.outline,
			this.ticks,
			this.labels,
			this.grip,
			this.rotateGrip,
			this.resetBtn,
			this.closeBtn,
		);
	}

	destroy(): void {
		for (const el of [this.outline, this.grip]) {
			el.removeEventListener("pointerdown", this.onDown);
			el.removeEventListener("pointermove", this.onMove);
			for (const event of ["pointerup", "pointercancel", "lostpointercapture"] as const) {
				el.removeEventListener(event, this.onEnd);
			}
		}
		this.rotateGrip.removeEventListener("pointerdown", this.onRotateDown);
		this.rotateGrip.removeEventListener("pointermove", this.onMove);
		for (const event of ["pointerup", "pointercancel", "lostpointercapture"] as const) {
			this.rotateGrip.removeEventListener(event, this.onEnd);
		}
		this.resetBtn.removeEventListener("pointerdown", this.onResetDown);
		this.closeBtn.removeEventListener("pointerdown", this.onCloseDown);
	}

	getOrigin(): XY | null {
		return this.origin;
	}

	isManipulating(): boolean {
		return !!this.drag || !!this.pinchStart;
	}

	syncOriginForSettings(geo: { top: number; width: number }, sy: number): void {
		const { ruler, setSquare, compass } = this.host.getSettings();
		if (!ruler && !setSquare && !compass) {
			this.origin = null;
			return;
		}
		if (!this.origin) {
			const scroller = this.view.scrollDOM;
			const visTop = Math.max(0, scroller.scrollTop / sy - geo.top);
			const visH = (scroller.clientHeight || 600) / sy;
			this.origin = [Math.max(120, geo.width / 2), visTop + Math.min(180, visH / 3)];
		}
	}

	guideEdges(): GuideEdge[] {
		const settings = this.host.getSettings();
		if (!this.origin) return [];
		if (settings.ruler) return rulerGeometry(this.origin, settings.rulerAngle, RULER_HALF_LENGTH, RULER_HALF_THICKNESS).edges;
		if (settings.setSquare) return setSquareEdges(this.origin, settings.setSquareAngle, this.halfSize());
		return [];
	}

	isUiTarget(target: EventTarget | null, pointerType?: string): boolean {
		if (
			target === this.grip ||
			target === this.rotateGrip ||
			target === this.resetBtn ||
			target === this.closeBtn
		) {
			return true;
		}
		// Let Apple Pencil (`pen`) draw cleanly right along/over the ruler edge instead of accidentally
		// dragging the ruler body; fingers and mouse still drag/rotate the ruler body directly.
		if (target === this.outline) {
			return pointerType !== "pen";
		}
		if (isDomNode(target, docOf(this.view))) {
			if (this.resetBtn.contains?.(target) || this.closeBtn.contains?.(target)) return true;
			if (this.group.contains?.(target)) return pointerType !== "pen";
		}
		return false;
	}

	render(hasPath: boolean): void {
		const origin = this.origin;
		const settings = this.host.getSettings();
		const activeKind = settings.compass ? "compass" : settings.ruler ? "ruler" : settings.setSquare ? "setSquare" : "none";
		const shown = hasPath && !!origin && activeKind !== "none";
		this.group.classList.toggle("pl-hidden", !shown);
		if (!shown || !origin) return;

		const doc = docOf(this.view);
		this.labels.replaceChildren();
		this.resetBtn.replaceChildren();
		this.closeBtn.replaceChildren();

		const addActionBtn = (parent: SVGGElement, cx: number, cy: number, text: string, label: string) => {
			parent.setAttribute("aria-label", label);
			const bg = svgEl(doc, "circle", "pl-guide-action-bg");
			bg.setAttribute("cx", String(cx));
			bg.setAttribute("cy", String(cy));
			bg.setAttribute("r", "13");
			const t = svgEl(doc, "text", "pl-guide-action-text");
			t.setAttribute("x", String(cx));
			t.setAttribute("y", String(cy + 4));
			t.setAttribute("text-anchor", "middle");
			t.textContent = text;
			parent.append(bg, t);
		};

		if (activeKind === "compass") {
			const [x, y] = origin;
			const r = settings.compassRadius;
			this.outline.setAttribute("d", `M ${x - r} ${y} a ${r} ${r} 0 0 1 ${2 * r} 0 a ${r} ${r} 0 0 1 ${-2 * r} 0 Z M ${x} ${y} h ${r}`);
			let ticks = "";
			for (let i = 0; i < 24; i++) {
				const a = (i * Math.PI) / 12;
				const len = i % 6 === 0 ? 10 : 5;
				ticks += ` M ${(x + Math.cos(a) * (r - len)).toFixed(1)} ${(y + Math.sin(a) * (r - len)).toFixed(1)} L ${(x + Math.cos(a) * r).toFixed(1)} ${(y + Math.sin(a) * r).toFixed(1)}`;
			}
			this.ticks.setAttribute("d", ticks);
			this.grip.setAttribute("cx", String(x));
			this.grip.setAttribute("cy", String(y));
			this.rotateGrip.setAttribute("cx", String(x + r));
			this.rotateGrip.setAttribute("cy", String(y));
			const cm = (r / PX_PER_CM).toFixed(1);
			const badge = svgEl(doc, "text", "pl-guide-readout");
			badge.setAttribute("x", String(x));
			badge.setAttribute("y", String(y - 18));
			badge.setAttribute("text-anchor", "middle");
			badge.textContent = `r = ${cm} cm`;
			this.labels.appendChild(badge);
			addActionBtn(this.resetBtn, x - 26, y - r - 18, "R", "Standard-Radius");
			addActionBtn(this.closeBtn, x + 26, y - r - 18, "×", "Zirkel schließen");
			return;
		}

		if (activeKind === "ruler") {
			const geom = rulerGeometry(origin, settings.rulerAngle, RULER_HALF_LENGTH, RULER_HALF_THICKNESS);
			const [tl, tr, br, bl] = geom.corners;
			const rad = (settings.rulerAngle * Math.PI) / 180;
			const cos = Math.cos(rad);
			const sin = Math.sin(rad);
			const pt = (lx: number, ly: number): XY => [origin[0] + lx * cos - ly * sin, origin[1] + lx * sin + ly * cos];

			this.outline.setAttribute(
				"d",
				`M ${tl[0].toFixed(1)} ${tl[1].toFixed(1)} L ${tr[0].toFixed(1)} ${tr[1].toFixed(1)} L ${br[0].toFixed(1)} ${br[1].toFixed(1)} L ${bl[0].toFixed(1)} ${bl[1].toFixed(1)} Z`,
			);

			const totalPx = RULER_HALF_LENGTH * 2 - 28;
			const totalMm = Math.floor(totalPx / PX_PER_MM);
			let ticks = "";
			for (let mm = 0; mm <= totalMm; mm++) {
				const lx = -RULER_HALF_LENGTH + 14 + mm * PX_PER_MM;
				const len = mm % 10 === 0 ? 13 : mm % 5 === 0 ? 9 : 5;
				const p0 = pt(lx, -RULER_HALF_THICKNESS);
				const p1 = pt(lx, -RULER_HALF_THICKNESS + len);
				const q0 = pt(lx, RULER_HALF_THICKNESS);
				const q1 = pt(lx, RULER_HALF_THICKNESS - (mm % 10 === 0 ? 8 : 4));
				ticks += ` M ${p0[0].toFixed(1)} ${p0[1].toFixed(1)} L ${p1[0].toFixed(1)} ${p1[1].toFixed(1)}`;
				if (mm % 5 === 0) ticks += ` M ${q0[0].toFixed(1)} ${q0[1].toFixed(1)} L ${q1[0].toFixed(1)} ${q1[1].toFixed(1)}`;
				if (mm % 10 === 0) {
					const lp = pt(lx, -RULER_HALF_THICKNESS + 23);
					const num = svgEl(doc, "text", "pl-guide-cm");
					num.setAttribute("x", lp[0].toFixed(1));
					num.setAttribute("y", lp[1].toFixed(1));
					num.setAttribute("text-anchor", "middle");
					num.setAttribute("transform", `rotate(${settings.rulerAngle} ${lp[0].toFixed(1)} ${lp[1].toFixed(1)})`);
					num.textContent = String(mm / 10);
					this.labels.appendChild(num);
				}
			}
			this.ticks.setAttribute("d", ticks);

			const anglePos = pt(0, 6);
			const angleText = svgEl(doc, "text", "pl-guide-readout");
			angleText.setAttribute("x", anglePos[0].toFixed(1));
			angleText.setAttribute("y", anglePos[1].toFixed(1));
			angleText.setAttribute("text-anchor", "middle");
			angleText.setAttribute("transform", `rotate(${settings.rulerAngle} ${anglePos[0].toFixed(1)} ${anglePos[1].toFixed(1)})`);
			angleText.textContent = `${Math.round(settings.rulerAngle)}°`;
			this.labels.appendChild(angleText);

			const movePos = pt(-RULER_HALF_LENGTH + 26, 0);
			this.grip.setAttribute("cx", movePos[0].toFixed(1));
			this.grip.setAttribute("cy", movePos[1].toFixed(1));
			this.rotateGrip.setAttribute("cx", geom.rotateHandle[0].toFixed(1));
			this.rotateGrip.setAttribute("cy", geom.rotateHandle[1].toFixed(1));

			const resetPos = pt(-52, RULER_HALF_THICKNESS + 18);
			const closePos = pt(52, RULER_HALF_THICKNESS + 18);
			addActionBtn(this.resetBtn, resetPos[0], resetPos[1], "0°", "Winkel auf 0° setzen");
			addActionBtn(this.closeBtn, closePos[0], closePos[1], "×", "Lineal schließen");
			return;
		}

		// Set square (Geodreieck)
		const half = this.halfSize();
		const edges = setSquareEdges(origin, settings.setSquareAngle, half);
		const [a, b, c] = edges.map(([from]) => from);
		const length = Math.hypot(b[0] - a[0], b[1] - a[1]);
		const dx = (b[0] - a[0]) / length;
		const dy = (b[1] - a[1]) / length;
		this.outline.setAttribute("d", `M ${a.join(" ")} L ${b.join(" ")} L ${c.join(" ")} Z`);

		let ticks = "";
		const totalMm = Math.floor(length / PX_PER_MM);
		for (let mm = 1; mm < totalMm; mm++) {
			const distance = mm * PX_PER_MM;
			const x = a[0] + dx * distance;
			const y = a[1] + dy * distance;
			const size = mm % 10 === 0 ? 12 : mm % 5 === 0 ? 8 : 4;
			ticks += ` M ${x.toFixed(1)} ${y.toFixed(1)} l ${(-dy * size).toFixed(1)} ${(dx * size).toFixed(1)}`;
			if (mm % 10 === 0 && mm < totalMm - 3) {
				const lx = x - dy * 21;
				const ly = y + dx * 21;
				const num = svgEl(doc, "text", "pl-guide-cm");
				num.setAttribute("x", lx.toFixed(1));
				num.setAttribute("y", ly.toFixed(1));
				num.setAttribute("text-anchor", "middle");
				num.setAttribute("transform", `rotate(${settings.setSquareAngle} ${lx.toFixed(1)} ${ly.toFixed(1)})`);
				num.textContent = String(mm / 10);
				this.labels.appendChild(num);
			}
		}
		this.ticks.setAttribute("d", ticks);
		const cx = (a[0] + b[0] + c[0]) / 3;
		const cy = (a[1] + b[1] + c[1]) / 3;
		this.grip.setAttribute("cx", String(cx));
		this.grip.setAttribute("cy", String(cy));
		this.rotateGrip.setAttribute("cx", String(b[0] - dx * 22 - dy * 12));
		this.rotateGrip.setAttribute("cy", String(b[1] - dy * 22 + dx * 12));

		const badge = svgEl(doc, "text", "pl-guide-readout");
		badge.setAttribute("x", String(cx));
		badge.setAttribute("y", String(cy - 20));
		badge.setAttribute("text-anchor", "middle");
		badge.textContent = `${Math.round(settings.setSquareAngle)}°`;
		this.labels.appendChild(badge);
		addActionBtn(this.resetBtn, c[0] - 24, c[1] + 18, "0°", "Geodreieck auf 0° setzen");
		addActionBtn(this.closeBtn, c[0] + 24, c[1] + 18, "×", "Geodreieck schließen");
	}

	private halfSize(): number {
		return Math.max(90, Math.min(180, (this.host.getGeo()?.width ?? 480) * 0.36));
	}

	private readonly onDown = (event: PointerEvent): void => {
		if (!this.origin || this.host.hasActiveInput() || (event.pointerType === "mouse" && event.button !== 0)) return;
		if (event.pointerType === "pen" && event.currentTarget === this.outline) return;
		event.preventDefault();
		event.stopPropagation();
		const [x, y] = this.host.toOverlay(event);
		const target = event.currentTarget as Element;
		try {
			target.setPointerCapture(event.pointerId);
		} catch {
			/* ignore */
		}
		this.touches.set(event.pointerId, [x, y]);
		if (this.touches.size === 2) {
			const entries = [...this.touches.entries()];
			const s = this.host.getSettings();
			const angle = s.ruler ? s.rulerAngle : s.setSquareAngle;
			this.pinchStart = {
				origin: [...this.origin] as XY,
				angle,
				radius: s.compassRadius,
				idA: entries[0][0],
				a: entries[0][1],
				idB: entries[1][0],
				b: entries[1][1],
			};
			this.drag = null;
			return;
		}
		this.drag = { mode: "move", id: event.pointerId, offset: [this.origin[0] - x, this.origin[1] - y] };
	};

	private readonly onRotateDown = (event: PointerEvent): void => {
		if (!this.origin || this.host.hasActiveInput() || (event.pointerType === "mouse" && event.button !== 0)) return;
		event.preventDefault();
		event.stopPropagation();
		const [x, y] = this.host.toOverlay(event);
		try {
			this.rotateGrip.setPointerCapture(event.pointerId);
		} catch {
			/* ignore */
		}
		const s = this.host.getSettings();
		if (s.compass) {
			this.drag = { mode: "radius", id: event.pointerId };
			return;
		}
		const startPointerAngle = (Math.atan2(y - this.origin[1], x - this.origin[0]) * 180) / Math.PI;
		const startAngle = s.ruler ? s.rulerAngle : s.setSquareAngle;
		this.drag = { mode: "rotate", id: event.pointerId, startAngle, startPointerAngle };
	};

	private readonly onMove = (event: PointerEvent): void => {
		if (!this.origin) return;
		const [x, y] = this.host.toOverlay(event);
		if (this.touches.has(event.pointerId)) {
			this.touches.set(event.pointerId, [x, y]);
		}
		if (this.pinchStart && this.touches.size >= 2) {
			const p = this.pinchStart;
			const curA = this.touches.get(p.idA);
			const curB = this.touches.get(p.idB);
			if (curA && curB) {
				event.preventDefault();
				event.stopPropagation();
				const tf = twoFingerGuideTransform(p.origin, p.angle, p.a, p.b, curA, curB, 3);
				this.origin = tf.origin;
				const s = this.host.getSettings();
				if (s.ruler) this.host.updateSettings?.({ rulerAngle: tf.angle });
				else if (s.setSquare) this.host.updateSettings?.({ setSquareAngle: tf.angle });
				else if (s.compass) {
					const nextR = Math.max(40, Math.min(200, Math.round(p.radius * tf.scaleRatio)));
					this.host.updateSettings?.({ compassRadius: nextR });
				}
				this.render(true);
			}
			return;
		}
		const drag = this.drag;
		if (!drag || event.pointerId !== drag.id) return;
		event.preventDefault();
		event.stopPropagation();
		const s = this.host.getSettings();
		if (drag.mode === "move") {
			this.origin = [x + drag.offset[0], y + drag.offset[1]];
			this.render(true);
		} else if (drag.mode === "rotate") {
			const curAng = (Math.atan2(y - this.origin[1], x - this.origin[0]) * 180) / Math.PI;
			const nextAng = snapGuideAngle(drag.startAngle + (curAng - drag.startPointerAngle), 3);
			if (s.ruler) this.host.updateSettings?.({ rulerAngle: nextAng });
			else if (s.setSquare) this.host.updateSettings?.({ setSquareAngle: nextAng });
			this.render(true);
		} else if (drag.mode === "radius") {
			const nextR = Math.max(40, Math.min(200, Math.round(Math.hypot(x - this.origin[0], y - this.origin[1]))));
			this.host.updateSettings?.({ compassRadius: nextR });
			this.render(true);
		}
	};

	private readonly onEnd = (event: PointerEvent): void => {
		this.touches.delete(event.pointerId);
		if (this.touches.size < 2) this.pinchStart = null;
		if (this.drag?.id === event.pointerId) this.drag = null;
	};

	private readonly onResetDown = (event: PointerEvent): void => {
		event.preventDefault();
		event.stopPropagation();
		const s = this.host.getSettings();
		if (s.ruler) this.host.updateSettings?.({ rulerAngle: s.rulerAngle === 0 ? 90 : 0 });
		else if (s.setSquare) this.host.updateSettings?.({ setSquareAngle: 0 });
		else if (s.compass) this.host.updateSettings?.({ compassRadius: 100 });
	};

	private readonly onCloseDown = (event: PointerEvent): void => {
		event.preventDefault();
		event.stopPropagation();
		this.host.updateSettings?.({ ruler: false, setSquare: false, compass: false });
	};
}
