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

export interface ZoomSizerMarginOptions {
	containerWidth: number;
	paddingLeft: number;
	paddingRight: number;
	baseWidth: number;
	zoom: number;
	centered: boolean;
}

/**
 * Compute horizontal `margin-left` (unzoomed CSS px) for a zoomed `.cm-sizer` inside `.cm-scroller`.
 * Keeps the sizer centered while its scaled width fits inside the scroller's inner width, and
 * collapses the auto-margin to `0` once zoomed wider so the content's left edge stays reachable
 * at `scrollLeft = 0` (`>= scroller.left`).
 */
export function zoomedSizerMarginLeft(opts: ZoomSizerMarginOptions): number {
	const { containerWidth, paddingLeft, paddingRight, baseWidth, zoom, centered } = opts;
	if (!centered || ![containerWidth, paddingLeft, paddingRight, baseWidth, zoom].every(Number.isFinite)) return 0;
	if (containerWidth <= 0 || baseWidth <= 0 || zoom <= 0) return 0;
	const innerWidth = Math.max(0, containerWidth - paddingLeft - paddingRight);
	const scaledWidth = baseWidth * zoom;
	if (scaledWidth >= innerWidth) return 0;
	return (innerWidth - scaledWidth) / 2;
}

export interface ZoomSpacerSizeOptions {
	offsetLeft: number;
	offsetTop: number;
	targetWidth: number;
	targetHeight: number;
	geoRight: number;
	geoBottom: number;
	paddingRight: number;
	rightExtra: number;
	bottomExtra: number;
	zoom: number;
}

/** Compute `.pl-zoom-spacer` dimensions so the entire zoomed page + ink canvas is horizontally & vertically scrollable. */
export function zoomSpacerSize(opts: ZoomSpacerSizeOptions): { width: number; height: number } {
	const z = Number.isFinite(opts.zoom) && opts.zoom > 0 ? opts.zoom : 1;
	const left = Math.max(0, Number.isFinite(opts.offsetLeft) ? opts.offsetLeft : 0);
	const top = Math.max(0, Number.isFinite(opts.offsetTop) ? opts.offsetTop : 0);
	const contentW = Math.max(opts.targetWidth || 0, (opts.geoRight || 0) + (opts.rightExtra || 0));
	const contentH = Math.max(opts.targetHeight || 0, (opts.geoBottom || 0) + (opts.bottomExtra || 0));
	return {
		width: Math.ceil(left + contentW * z + Math.max(0, opts.paddingRight || 0)),
		height: Math.ceil(top + contentH * z),
	};
}
