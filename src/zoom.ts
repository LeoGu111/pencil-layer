/**
 * Pure page zoom & pinch-gesture helpers (inspired by Notify's touchGestures.ts).
 * Zero DOM / Obsidian imports so all zoom math is deterministic and unit-tested.
 */

export const ZOOM_MIN = 0.5;
export const ZOOM_MAX = 3.0;
export const ZOOM_STEP = 0.15;

export interface ZoomPoint {
	x: number;
	y: number;
}

export function clampZoom(zoom: number, minZoom = ZOOM_MIN, maxZoom = ZOOM_MAX): number {
	if (!Number.isFinite(zoom) || zoom <= 0) return 1;
	const clamped = Math.min(maxZoom, Math.max(minZoom, zoom));
	return Math.round(clamped * 1000) / 1000;
}

export function pinchScale(
	startZoom: number,
	startDistance: number,
	currentDistance: number,
	minZoom = ZOOM_MIN,
	maxZoom = ZOOM_MAX,
): number {
	if (![startZoom, startDistance, currentDistance].every(Number.isFinite) || startDistance <= 0 || currentDistance <= 0) {
		return clampZoom(startZoom, minZoom, maxZoom);
	}
	return clampZoom((startZoom * currentDistance) / startDistance, minZoom, maxZoom);
}

/**
 * Compute new scroll offset along one axis so the document point under `focalPoint`
 * (viewport-relative px) stays anchored under `currentFocalPoint` after zoom changes by `zoomRatio`.
 */
export function scrollForZoomAnchor(
	scroll: number,
	focalPoint: number,
	zoomRatio: number,
	currentFocalPoint = focalPoint,
): number {
	if (![scroll, focalPoint, zoomRatio, currentFocalPoint].every(Number.isFinite)) return Math.max(0, scroll || 0);
	return Math.max(0, (scroll + focalPoint) * zoomRatio - currentFocalPoint);
}

export function distanceBetween(a: ZoomPoint, b: ZoomPoint): number {
	return Math.hypot(b.x - a.x, b.y - a.y);
}

export function midpoint(a: ZoomPoint, b: ZoomPoint): ZoomPoint {
	return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

/**
 * Deadband activation for two-finger pinch: ignores tiny finger spacing jitter (< 3%)
 * while allowing smooth two-finger panning; rebases cleanly on activation so there is no jump.
 */
export class PinchActivation {
	private baseline: number;
	active = false;

	constructor(
		startDistance: number,
		private readonly threshold = 0.03,
	) {
		this.baseline = startDistance;
	}

	ratio(distance: number): number {
		if (!Number.isFinite(distance) || distance <= 0) return 1;
		if (!Number.isFinite(this.baseline) || this.baseline <= 0) {
			this.baseline = distance;
			return 1;
		}
		if (!this.active) {
			if (Math.abs(distance / this.baseline - 1) < this.threshold) return 1;
			this.active = true;
			this.baseline = distance;
		}
		return distance / this.baseline;
	}
}

/** Smooth multiplicative zoom factor from a Ctrl+Wheel / trackpad pinch deltaY event. */
export function wheelZoomFactor(deltaY: number): number {
	if (!Number.isFinite(deltaY) || deltaY === 0) return 1;
	const clamped = Math.max(-120, Math.min(120, deltaY));
	return Math.exp(-clamped * 0.0025);
}

export function formatZoomPercent(zoom: number): string {
	return `${Math.round(clampZoom(zoom) * 100)}%`;
}
