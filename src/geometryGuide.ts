/**
 * Pure geometry guide math for Straight Ruler (Lineal), 45° Set Square (Geodreieck),
 * and Compass (Zirkel) — including dual-edge snapping, magnetic angle snapping,
 * and two-finger move/rotate/scale transforms.
 */
import type { ShapeSpec, XY } from "./shapes";

export type GuideEdge = readonly [XY, XY];
export type DrawingGuideKind = "none" | "ruler" | "setSquare" | "compass";

/** Default straight ruler dimensions in CSS px (~12.5 cm × 1.5 cm at 96 dpi). */
export const RULER_HALF_LENGTH = 230;
export const RULER_HALF_THICKNESS = 28;
/** Pixels per centimeter at CSS 96 dpi (1 cm = 96 / 2.54 px ≈ 37.8 px). */
export const PX_PER_CM = 96 / 2.54;
export const PX_PER_MM = PX_PER_CM / 10;

/** Common angles (degrees) that magnetic rotation snaps gently toward. */
const SNAP_ANGLES = [0, 30, 45, 60, 90, 120, 135, 150, 180, 210, 225, 240, 270, 300, 315, 330, 360] as const;

/** Normalize degrees into `[0, 360)`. */
export function normalizeDegrees(deg: number): number {
	if (!Number.isFinite(deg)) return 0;
	return ((deg % 360) + 360) % 360;
}

/** Magnetic snap to common angles (0°, 30°, 45°, 60°, 90°, ...) within `toleranceDeg`. */
export function snapGuideAngle(deg: number, toleranceDeg = 3): number {
	const norm = normalizeDegrees(deg);
	for (const target of SNAP_ANGLES) {
		if (Math.abs(norm - target) <= toleranceDeg) return target % 360;
	}
	return Math.round(norm * 2) / 2;
}

/**
 * Straight ruler (Lineal): returns its two long drawing edges (top & bottom) plus its 4 corners
 * `[topLeft, topRight, bottomRight, bottomLeft]` centered at `center`, rotated by `degrees`.
 */
export function rulerGeometry(
	[cx, cy]: XY,
	degrees: number,
	halfLength = RULER_HALF_LENGTH,
	halfThickness = RULER_HALF_THICKNESS,
): { edges: [GuideEdge, GuideEdge]; corners: [XY, XY, XY, XY]; rotateHandle: XY } {
	const rad = (degrees * Math.PI) / 180;
	const cos = Math.cos(rad);
	const sin = Math.sin(rad);
	const pt = (lx: number, ly: number): XY => [cx + lx * cos - ly * sin, cy + lx * sin + ly * cos];
	const tl = pt(-halfLength, -halfThickness);
	const tr = pt(halfLength, -halfThickness);
	const br = pt(halfLength, halfThickness);
	const bl = pt(-halfLength, halfThickness);
	const rotateHandle = pt(halfLength - 22, 0);
	return {
		edges: [
			[tl, tr],
			[bl, br],
		],
		corners: [tl, tr, br, bl],
		rotateHandle,
	};
}

/** Convenience: the two snapping edges of a straight ruler. */
export function rulerEdges(center: XY, degrees: number, halfLength = RULER_HALF_LENGTH, halfThickness = RULER_HALF_THICKNESS): GuideEdge[] {
	return rulerGeometry(center, degrees, halfLength, halfThickness).edges;
}

/** A 45° set square (Geodreieck). Angle is measured clockwise from the horizontal baseline. */
export function setSquareEdges([x, y]: XY, degrees: number, half: number): GuideEdge[] {
	const angle = (degrees * Math.PI) / 180;
	const cos = Math.cos(angle);
	const sin = Math.sin(angle);
	const left: XY = [x - half * cos, y - half * sin];
	const right: XY = [x + half * cos, y + half * sin];
	const tip: XY = [x - half * sin, y + half * cos];
	return [
		[left, right],
		[right, tip],
		[tip, left],
	];
}

export function projectToEdge([x, y]: XY, [[ax, ay], [bx, by]]: GuideEdge): XY {
	const dx = bx - ax;
	const dy = by - ay;
	const length2 = dx * dx + dy * dy;
	const t = length2 === 0 ? 0 : Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / length2));
	return [ax + t * dx, ay + t * dy];
}

/**
 * Unclamped projection onto the infinite line extending a guide edge, so users can pull a straight
 * stroke smoothly past either end of the ruler/set-square instead of hitting an invisible wall.
 */
export function projectToInfiniteEdge([x, y]: XY, [[ax, ay], [bx, by]]: GuideEdge): XY {
	const dx = bx - ax;
	const dy = by - ay;
	const length2 = dx * dx + dy * dy;
	const t = length2 === 0 ? 0 : ((x - ax) * dx + (y - ay) * dy) / length2;
	return [ax + t * dx, ay + t * dy];
}

/** Capture the nearest edge only when the stroke starts close enough. */
export function nearestGuideEdge(point: XY, edges: readonly GuideEdge[], tolerance: number): GuideEdge | null {
	let best: GuideEdge | null = null;
	for (const edge of edges) {
		const [x, y] = projectToEdge(point, edge);
		const distance = Math.hypot(x - point[0], y - point[1]);
		if (distance >= tolerance) continue;
		tolerance = distance;
		best = edge;
	}
	return best;
}

/**
 * Compute updated origin + angle (and optional scale ratio) from two-finger drag/rotate on a guide.
 */
export function twoFingerGuideTransform(
	initialOrigin: XY,
	initialAngle: number,
	initialA: XY,
	initialB: XY,
	currentA: XY,
	currentB: XY,
	snapTolerance = 3,
): { origin: XY; angle: number; scaleRatio: number } {
	const mid0: XY = [(initialA[0] + initialB[0]) / 2, (initialA[1] + initialB[1]) / 2];
	const mid1: XY = [(currentA[0] + currentB[0]) / 2, (currentA[1] + currentB[1]) / 2];
	const ang0 = Math.atan2(initialB[1] - initialA[1], initialB[0] - initialA[0]);
	const ang1 = Math.atan2(currentB[1] - currentA[1], currentB[0] - currentA[0]);
	const deltaDeg = ((ang1 - ang0) * 180) / Math.PI;
	const d0 = Math.max(1, Math.hypot(initialB[0] - initialA[0], initialB[1] - initialA[1]));
	const d1 = Math.max(1, Math.hypot(currentB[0] - currentA[0], currentB[1] - currentA[1]));
	return {
		origin: [initialOrigin[0] + (mid1[0] - mid0[0]), initialOrigin[1] + (mid1[1] - mid0[1])],
		angle: snapGuideAngle(initialAngle + deltaDeg, snapTolerance),
		scaleRatio: d1 / d0,
	};
}

export interface CompassDrag {
	center: XY;
	radius: number;
	start: number;
	lastAngle: number;
	sweep: number;
}

const FULL_TURN = 2 * Math.PI;

export function startCompassDrag(point: XY, center: XY, radius: number, tolerance: number): CompassDrag | null {
	const x = point[0] - center[0];
	const y = point[1] - center[1];
	if (Math.abs(Math.hypot(x, y) - radius) >= tolerance) return null;
	const angle = Math.atan2(y, x);
	return { center, radius, start: angle, lastAngle: angle, sweep: 0 };
}

/** Accumulate adjacent samples so arcs can cross ±180° and still complete a full turn. */
export function moveCompass(drag: CompassDrag, point: XY): void {
	const x = point[0] - drag.center[0];
	const y = point[1] - drag.center[1];
	if (Math.hypot(x, y) < drag.radius / 4) return;
	const angle = Math.atan2(y, x);
	const delta = angle - drag.lastAngle;
	const step = Math.atan2(Math.sin(delta), Math.cos(delta));
	drag.lastAngle = angle;
	drag.sweep = Math.max(-FULL_TURN, Math.min(FULL_TURN, drag.sweep + step));
}

export function compassShape({ center: [cx, cy], radius, start, sweep }: CompassDrag, minLength: number): ShapeSpec | null {
	if (Math.abs(sweep) * radius < minLength) return null;
	if (Math.abs(sweep) >= FULL_TURN - 0.035) return { kind: "circle", cx, cy, rx: radius, ry: radius, rot: 0 };
	return { kind: "arc", cx, cy, r: radius, start, sweep };
}
