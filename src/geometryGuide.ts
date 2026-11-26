import type { XY } from "./shapes";

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
