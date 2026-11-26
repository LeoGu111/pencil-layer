/**
 * Pen hardware details that differ between platforms (pure, tested in tests/penInput.test.ts).
 *
 * - **Eraser end** (Surface Pen, Wacom and other Windows Ink / Android pens): Pointer Events report
 *   the eraser end as `pointerType: "pen"` with `button === 5` on pointerdown and bit 32 set in
 *   `buttons` while it touches. It erases while held, whatever tool is selected.
 * - **Tilt (Apple Pencil Neigung / stylus tilt)**: Pointer Events report `tiltX`/`tiltY` (degrees)
 *   and/or `altitudeAngle`/`azimuthAngle` (radians). `pointerTilt` normalizes tilt angle from
 *   vertical into `[0, 1]` (`0` = upright, `1` = 90° flat), and `tiltWidthMultiplier` maps tilt +
 *   tool/style to stroke width expansion for shading.
 */

/** `PointerEvent.button` of the pen's eraser end. */
export const ERASER_BUTTON = 5;
/** `PointerEvent.buttons` bit of the pen's eraser end. */
export const ERASER_BUTTONS = 32;

export interface PenPointer {
	pointerType: string;
	button: number;
	buttons: number;
}

export interface PenTiltEvent {
	pointerType: string;
	tiltX?: number;
	tiltY?: number;
	altitudeAngle?: number;
	azimuthAngle?: number;
}

const DEG_TO_RAD = Math.PI / 180;
const RAD_TO_DEG = 180 / Math.PI;
const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);
const smoothstep = (edge0: number, edge1: number, x: number): number => {
	const t = clamp01((x - edge0) / (edge1 - edge0));
	return t * t * (3 - 2 * t);
};

/** Is this the eraser end of a pen touching the screen? */
export function isPenEraser(e: PenPointer): boolean {
	return e.pointerType === "pen" && (e.button === ERASER_BUTTON || (e.buttons & ERASER_BUTTONS) !== 0);
}

/** The tool a pen press uses: the eraser end always erases, the tip uses the selected tool. */
export function toolForPress<T extends string>(e: PenPointer, selected: T): T | "eraser" {
	return isPenEraser(e) ? "eraser" : selected;
}

/**
 * Angle of the stylus from vertical in degrees `[0, 90]`. Returns `0` for non-pen pointers or
 * when no tilt information is present.
 */
export function pointerTiltAngleDeg(e: PenTiltEvent): number {
	if (e.pointerType !== "pen") return 0;
	const alt = e.altitudeAngle;
	if (typeof alt === "number" && Number.isFinite(alt) && alt < Math.PI / 2 - 1e-4) {
		const clamped = Math.max(0, Math.min(Math.PI / 2, alt));
		return (Math.PI / 2 - clamped) * RAD_TO_DEG;
	}
	const tx = e.tiltX;
	const ty = e.tiltY;
	if (typeof tx === "number" && typeof ty === "number" && Number.isFinite(tx) && Number.isFinite(ty) && (tx !== 0 || ty !== 0)) {
		const cx = Math.max(-89.9, Math.min(89.9, tx)) * DEG_TO_RAD;
		const cy = Math.max(-89.9, Math.min(89.9, ty)) * DEG_TO_RAD;
		return Math.atan(Math.hypot(Math.tan(cx), Math.tan(cy))) * RAD_TO_DEG;
	}
	return 0;
}

/** Normalized stylus tilt `[0, 1]` (`0` = perpendicular to screen, `1` = 90° flat). */
export function pointerTilt(e: PenTiltEvent): number {
	return clamp01(pointerTiltAngleDeg(e) / 90);
}

/** Activation threshold (normalized tilt = deg / 90) below which tilt does not widen a stroke. */
export function tiltThreshold(style?: string, tool?: string): number {
	if (tool === "highlighter") return 38 / 90;
	if (style === "pencil") return 22 / 90;
	if (style === "calligraphy") return 28 / 90;
	if (style === "marker") return 34 / 90;
	if (style === "notes") return 32 / 90;
	return 38 / 90;
}

/**
 * Width multiplier for normalized stylus tilt `[0, 1]`. Normal upright writing stays at `1`;
 * tilting the Apple Pencil on its side smoothly widens the stroke for shading.
 */
export function tiltWidthMultiplier(tilt: number, style?: string, tool?: string): number {
	if (!Number.isFinite(tilt) || tilt <= 0) return 1;
	if (style === "dashed" || style === "dotted") return 1;
	const t = clamp01(tilt);
	if (tool === "highlighter") return 1 + 1.0 * smoothstep(38 / 90, 75 / 90, t);
	if (style === "pencil") return 1 + 3.0 * smoothstep(22 / 90, 72 / 90, t);
	if (style === "calligraphy") return 1 + 2.4 * smoothstep(28 / 90, 74 / 90, t);
	if (style === "marker") return 1 + 1.3 * smoothstep(34 / 90, 75 / 90, t);
	if (style === "notes") return 1 + 2.2 * smoothstep(32 / 90, 74 / 90, t);
	return 1 + 2.0 * smoothstep(38 / 90, 75 / 90, t);
}

export interface TiltSample {
	x: number;
	y: number;
	tilt: number;
}

/**
 * Map raw `(x, y, tilt)` samples onto finalized stroke points (by arc-length proportion). Returns
 * `undefined` when no sample actually triggers tilt widening for the stroke's tool/style.
 */
export function resampleTilts(
	samples: readonly TiltSample[],
	points: readonly (readonly number[])[],
	style?: string,
	tool?: string,
): number[] | undefined {
	if (samples.length === 0 || points.length === 0) return undefined;
	if (style === "dashed" || style === "dotted") return undefined;
	const minTilt = tiltThreshold(style, tool);
	if (!samples.some((s) => s.tilt > minTilt)) return undefined;
	if (samples.length === 1 || points.length === 1) {
		const v = clamp01(samples[0].tilt);
		return points.map(() => v);
	}
	const sCum = new Float64Array(samples.length);
	for (let i = 1; i < samples.length; i++) {
		sCum[i] = sCum[i - 1] + Math.hypot(samples[i].x - samples[i - 1].x, samples[i].y - samples[i - 1].y);
	}
	const sTotal = sCum[samples.length - 1];
	const pCum = new Float64Array(points.length);
	for (let i = 1; i < points.length; i++) {
		pCum[i] = pCum[i - 1] + Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1]);
	}
	const pTotal = pCum[points.length - 1];
	const out: number[] = [];
	let j = 0;
	for (let i = 0; i < points.length; i++) {
		const target = sTotal > 0 && pTotal > 0 ? (pCum[i] / pTotal) * sTotal : (i / Math.max(1, points.length - 1)) * (samples.length - 1);
		if (sTotal > 0 && pTotal > 0) {
			while (j + 1 < samples.length - 1 && sCum[j + 1] < target) j++;
			const span = sCum[j + 1] - sCum[j];
			const f = span > 0 ? clamp01((target - sCum[j]) / span) : 0;
			out.push(clamp01(samples[j].tilt + (samples[j + 1].tilt - samples[j].tilt) * f));
		} else {
			const idx = Math.min(samples.length - 1, Math.round((i / Math.max(1, points.length - 1)) * (samples.length - 1)));
			out.push(clamp01(samples[idx].tilt));
		}
	}
	return out.some((v) => v > minTilt) ? out : undefined;
}
