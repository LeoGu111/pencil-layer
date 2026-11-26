import type { ShapeSpec, XY } from "./shapes";

export type GuideEdge = readonly [XY, XY];

/** A 45° set square. Angle is measured clockwise from the horizontal baseline. */
export function setSquareEdges([x, y]: XY, degrees: number, half: number): GuideEdge[] {
	const angle = degrees * Math.PI / 180;
	const cos = Math.cos(angle);
	const sin = Math.sin(angle);
	const left: XY = [x - half * cos, y - half * sin];
	const right: XY = [x + half * cos, y + half * sin];
	const tip: XY = [x - half * sin, y + half * cos];
	return [[left, right], [right, tip], [tip, left]];
}

export function projectToEdge([x, y]: XY, [[ax, ay], [bx, by]]: GuideEdge): XY {
	const dx = bx - ax;
	const dy = by - ay;
	const length2 = dx * dx + dy * dy;
	const t = length2 === 0 ? 0 : Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / length2));
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
