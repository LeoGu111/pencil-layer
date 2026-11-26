/**
 * Handwritten math formula → LaTeX recognizer (pure geometry & symbol classifier in TS, plus an
 * optional Vision-LLM adapter using Obsidian's `requestUrl`).
 *
 * Works 100% offline out-of-the-box for common mathematical expressions (digits, variables,
 * German handwriting variants like 2-stroke `4` / barred `7` / barred `z`, operators
 * `+ - = \times \div \pm \le \ge \neq < > ( )`, fractions `\frac{a}{b}`, square roots `\sqrt{x}`,
 * superscripts `x^2`, subscripts `a_n`, sums `\sum`, integrals `\int`, common Greek symbols)
 * using 2D bounding-box spatial parsing + direction-aware geometric & template matching.
 */
import type { Stroke } from "./model";

export type MathDelimiters = "auto" | "inline" | "block";
export type MathVisionProvider = "offline" | "gemini" | "openai";

export interface MathBox {
	minX: number;
	minY: number;
	maxX: number;
	maxY: number;
}

interface GlyphStroke {
	pts: [number, number][];
	box: MathBox;
}

type TokenRole = "bar" | "radical" | "op" | "open" | "close" | "dot" | "bigop" | "atom";

interface Glyph {
	strokes: GlyphStroke[];
	box: MathBox;
	tex: string;
	role: TokenRole;
}

const RESAMPLE_N = 24;

function boxOfPts(pts: readonly [number, number][]): MathBox {
	let minX = Infinity;
	let minY = Infinity;
	let maxX = -Infinity;
	let maxY = -Infinity;
	for (const [x, y] of pts) {
		if (x < minX) minX = x;
		if (y < minY) minY = y;
		if (x > maxX) maxX = x;
		if (y > maxY) maxY = y;
	}
	return { minX, minY, maxX, maxY };
}

function mergeBoxes(a: MathBox, b: MathBox): MathBox {
	return {
		minX: Math.min(a.minX, b.minX),
		minY: Math.min(a.minY, b.minY),
		maxX: Math.max(a.maxX, b.maxX),
		maxY: Math.max(a.maxY, b.maxY),
	};
}

function boxW(b: MathBox): number {
	return Math.max(0, b.maxX - b.minX);
}

function boxH(b: MathBox): number {
	return Math.max(0, b.maxY - b.minY);
}

function boxCx(b: MathBox): number {
	return (b.minX + b.maxX) / 2;
}

function boxCy(b: MathBox): number {
	return (b.minY + b.maxY) / 2;
}

function pathLength(pts: readonly [number, number][]): number {
	let d = 0;
	for (let i = 1; i < pts.length; i++) d += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
	return d;
}

/** Resample a polyline to N equally spaced points along arc length. */
export function resamplePolyline(pts: readonly [number, number][], n = RESAMPLE_N): [number, number][] {
	if (pts.length === 0) return [];
	if (pts.length === 1) return Array.from({ length: n }, () => [pts[0][0], pts[0][1]]);
	const total = pathLength(pts);
	if (total < 1e-6) return Array.from({ length: n }, () => [pts[0][0], pts[0][1]]);
	const out: [number, number][] = [[pts[0][0], pts[0][1]]];
	const step = total / (n - 1);
	let acc = 0;
	let prev = pts[0];
	for (let i = 1; i < pts.length; i++) {
		const cur = pts[i];
		let seg = Math.hypot(cur[0] - prev[0], cur[1] - prev[1]);
		while (acc + seg >= step && out.length < n) {
			const t = (step - acc) / seg;
			const nx = prev[0] + (cur[0] - prev[0]) * t;
			const ny = prev[1] + (cur[1] - prev[1]) * t;
			out.push([nx, ny]);
			prev = [nx, ny];
			seg = Math.hypot(cur[0] - prev[0], cur[1] - prev[1]);
			acc = 0;
		}
		acc += seg;
		prev = cur;
	}
	const last = pts[pts.length - 1];
	while (out.length < n) out.push([last[0], last[1]]);
	return out;
}

/** Aspect-preserving normalization into [-0.5, 0.5]^2 centered at (0, 0). */
function normalizePts(pts: readonly [number, number][]): [number, number][] {
	const res = resamplePolyline(pts, RESAMPLE_N);
	const b = boxOfPts(res);
	const scale = Math.max(boxW(b), boxH(b), 1);
	const cx = (b.minX + b.maxX) / 2;
	const cy = (b.minY + b.maxY) / 2;
	return res.map(([x, y]) => [(x - cx) / scale, (y - cy) / scale]);
}

function polyDistance(a: readonly [number, number][], b: readonly [number, number][]): number {
	let sum = 0;
	for (let i = 0; i < a.length && i < b.length; i++) {
		sum += Math.hypot(a[i][0] - b[i][0], a[i][1] - b[i][1]);
	}
	return sum / Math.max(1, a.length);
}

/** Bidirectional point-cloud distance (handles reversed stroke drawing direction, e.g. bottom-to-top). */
function polyDistanceBi(a: readonly [number, number][], b: readonly [number, number][], allowReverse: boolean): number {
	const fwd = polyDistance(a, b);
	if (!allowReverse) return fwd;
	let rev = 0;
	const n = Math.min(a.length, b.length);
	for (let i = 0; i < n; i++) {
		const q = b[n - 1 - i];
		rev += Math.hypot(a[i][0] - q[0], a[i][1] - q[1]);
	}
	return Math.min(fwd, rev / Math.max(1, n));
}

function isClosedLoop(pts: readonly [number, number][], box: MathBox): boolean {
	if (pts.length < 6) return false;
	const diag = Math.hypot(boxW(box), boxH(box));
	if (diag < 6) return false;
	const first = pts[0];
	const last = pts[pts.length - 1];
	const endDist = Math.hypot(last[0] - first[0], last[1] - first[1]);
	const len = pathLength(pts);
	return endDist <= diag * 0.36 && len >= diag * 2.1;
}

function segmentsIntersect(a1: [number, number], a2: [number, number], b1: [number, number], b2: [number, number]): boolean {
	const cross = (p: [number, number], q: [number, number], r: [number, number]) =>
		(q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
	const d1 = cross(b1, b2, a1);
	const d2 = cross(b1, b2, a2);
	const d3 = cross(a1, a2, b1);
	const d4 = cross(a1, a2, b2);
	return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
}

function strokesCross(a: GlyphStroke, b: GlyphStroke): boolean {
	if (
		a.box.maxX + 4 < b.box.minX ||
		b.box.maxX + 4 < a.box.minX ||
		a.box.maxY + 4 < b.box.minY ||
		b.box.maxY + 4 < a.box.minY
	) {
		return false;
	}
	const stepA = Math.max(1, Math.floor(a.pts.length / 18));
	const stepB = Math.max(1, Math.floor(b.pts.length / 18));
	for (let i = 0; i + stepA < a.pts.length; i += stepA) {
		const p1 = a.pts[i];
		const p2 = a.pts[Math.min(a.pts.length - 1, i + stepA)];
		for (let j = 0; j + stepB < b.pts.length; j += stepB) {
			const q1 = b.pts[j];
			const q2 = b.pts[Math.min(b.pts.length - 1, j + stepB)];
			if (segmentsIntersect(p1, p2, q1, q2)) return true;
		}
	}
	return false;
}

/** Minimum Euclidean distance between two polylines (subsampled for speed). */
function minStrokeDist(a: GlyphStroke, b: GlyphStroke): number {
	const stepA = Math.max(1, Math.floor(a.pts.length / 16));
	const stepB = Math.max(1, Math.floor(b.pts.length / 16));
	let best = Infinity;
	for (let i = 0; i < a.pts.length; i += stepA) {
		for (let j = 0; j < b.pts.length; j += stepB) {
			const d = Math.hypot(a.pts[i][0] - b.pts[j][0], a.pts[i][1] - b.pts[j][1]);
			if (d < best) best = d;
		}
	}
	return best;
}

function isHorizontalBar(s: GlyphStroke): boolean {
	const w = boxW(s.box);
	const h = boxH(s.box);
	if (w < 6) return false;
	const endDist = Math.hypot(s.pts[s.pts.length - 1][0] - s.pts[0][0], s.pts[s.pts.length - 1][1] - s.pts[0][1]);
	const len = pathLength(s.pts);
	const straight = len > 0 ? endDist / len : 0;
	return w / Math.max(h, 1) >= 2.2 && h <= Math.max(12, w * 0.38) && straight >= 0.7;
}

function isVerticalBar(s: GlyphStroke): boolean {
	const w = boxW(s.box);
	const h = boxH(s.box);
	if (h < 8) return false;
	const endDist = Math.hypot(s.pts[s.pts.length - 1][0] - s.pts[0][0], s.pts[s.pts.length - 1][1] - s.pts[0][1]);
	const len = pathLength(s.pts);
	const straight = len > 0 ? endDist / len : 0;
	return h / Math.max(w, 1) >= 2.2 && w <= Math.max(12, h * 0.38) && straight >= 0.7;
}

function isDiagonalSlash(s: GlyphStroke): "fwd" | "back" | null {
	const w = boxW(s.box);
	const h = boxH(s.box);
	if (w < 5 || h < 5) return null;
	const first = s.pts[0];
	const last = s.pts[s.pts.length - 1];
	const dx = last[0] - first[0];
	const dy = last[1] - first[1];
	const endDist = Math.hypot(dx, dy);
	const len = pathLength(s.pts);
	if (len <= 0 || endDist / len < 0.74) return null;
	const ratio = w / h;
	if (ratio < 0.25 || ratio > 2.8) return null;
	return dx * dy < 0 ? "fwd" : "back";
}

function isDot(s: GlyphStroke): boolean {
	return boxW(s.box) <= 9 && boxH(s.box) <= 9 && pathLength(s.pts) <= 24;
}

/** Check if stroke matches a radical √ shape (down-up check mark extending horizontally right). */
function isRadicalStroke(s: GlyphStroke): boolean {
	if (s.pts.length < 4) return false;
	const w = boxW(s.box);
	const h = boxH(s.box);
	if (w < 16 || h < 10) return false;
	let dipIdx = -1;
	let dipY = -Infinity;
	for (let i = 0; i < s.pts.length; i++) {
		if (s.pts[i][0] > s.box.minX + w * 0.55) break;
		if (s.pts[i][1] > dipY) {
			dipY = s.pts[i][1];
			dipIdx = i;
		}
	}
	if (dipIdx <= 0 || dipIdx >= s.pts.length - 2) return false;
	let topIdx = dipIdx;
	let topY = Infinity;
	for (let i = dipIdx + 1; i < s.pts.length; i++) {
		if (s.pts[i][1] < topY) {
			topY = s.pts[i][1];
			topIdx = i;
		}
		if (s.pts[i][0] > s.box.minX + w * 0.7) break;
	}
	const last = s.pts[s.pts.length - 1];
	const first = s.pts[0];
	const wentDownFirst = dipY - first[1] > h * 0.18;
	const wentUpToTop = dipY - topY > h * 0.5;
	const runsRightAlongTop = last[0] - s.pts[topIdx][0] > w * 0.32 && Math.abs(last[1] - topY) < h * 0.45;
	return wentDownFirst && wentUpToTop && runsRightAlongTop;
}

/** Check if a stroke is an L-shaped corner (down/diagonal-left then right: first half of 2-stroke `4`). */
function isLShapeForFour(s: GlyphStroke): boolean {
	const w = boxW(s.box);
	const h = boxH(s.box);
	if (w < 6 || h < 6 || s.pts.length < 3) return false;
	const first = s.pts[0];
	const last = s.pts[s.pts.length - 1];
	// Starts upper-middle/left, goes down-left to corner, then right along bottom.
	const startsHigh = first[1] <= s.box.minY + h * 0.35;
	const endsRight = last[0] >= s.box.maxX - w * 0.25 && last[1] >= s.box.minY + h * 0.55;
	// Has a bottom-left corner point
	let hasCorner = false;
	for (const p of s.pts) {
		if (p[0] <= s.box.minX + w * 0.3 && p[1] >= s.box.maxY - h * 0.3) {
			hasCorner = true;
			break;
		}
	}
	return startsHigh && endsRight && hasCorner;
}

// -------------------------------------------------------------------------------------------------
// Canonical polyline templates (normalized coordinate space: top = -0.5, bottom = 0.5)
// -------------------------------------------------------------------------------------------------

interface PolyTemplate {
	tex: string;
	role?: TokenRole;
	variants: readonly (readonly [number, number][])[];
	/** Preferred aspect ratio w / h range `[min, max]`. */
	aspect?: [number, number];
	/** Allow matching the template in reverse stroke order. */
	reversible?: boolean;
}

const arcPts = (cx: number, cy: number, rx: number, ry: number, deg0: number, deg1: number, steps = 16): [number, number][] => {
	const out: [number, number][] = [];
	for (let i = 0; i <= steps; i++) {
		const rad = ((deg0 + ((deg1 - deg0) * i) / steps) * Math.PI) / 180;
		out.push([cx + rx * Math.cos(rad), cy + ry * Math.sin(rad)]);
	}
	return out;
};

const RAW_TEMPLATES: PolyTemplate[] = [
	{
		tex: "0",
		aspect: [0.3, 1.35],
		reversible: true,
		variants: [
			arcPts(0, 0, 0.35, 0.5, -90, 270),
			arcPts(0, 0, 0.35, 0.5, -90, -450),
			arcPts(0, 0, 0.35, 0.5, 0, 360),
			arcPts(0, 0, 0.35, 0.5, 90, 450),
			arcPts(0, 0, 0.35, 0.5, 180, 540),
		],
	},
	{
		tex: "1",
		aspect: [0.04, 0.75],
		reversible: true,
		variants: [
			[[-0.22, -0.2], [0.06, -0.5], [0.06, 0.5]],
			[[-0.28, -0.15], [0.1, -0.5], [0.1, 0.5]],
			[[0, -0.5], [0, 0.5]],
		],
	},
	{
		tex: "2",
		aspect: [0.32, 1.35],
		variants: [
			[[-0.3, -0.25], [0, -0.5], [0.3, -0.25], [0.2, 0.05], [-0.35, 0.5], [0.35, 0.5]],
			[[-0.25, -0.35], [0.1, -0.5], [0.3, -0.2], [-0.35, 0.45], [0.35, 0.48]],
		],
	},
	{
		tex: "3",
		aspect: [0.28, 1.25],
		variants: [
			[[-0.25, -0.4], [0.15, -0.5], [0.3, -0.25], [-0.05, 0], [0.32, 0.25], [0.1, 0.5], [-0.3, 0.4]],
			[[-0.3, -0.45], [0.25, -0.45], [-0.05, -0.05], [0.3, 0.22], [0.05, 0.5], [-0.3, 0.4]],
		],
	},
	{
		tex: "4",
		aspect: [0.32, 1.35],
		variants: [
			[[0.05, -0.5], [-0.35, 0.15], [0.35, 0.15]],
			[[0.15, -0.5], [-0.35, 0.12], [0.35, 0.12], [0.15, -0.1], [0.15, 0.5]],
		],
	},
	{
		tex: "5",
		aspect: [0.32, 1.3],
		variants: [
			[[0.3, -0.5], [-0.25, -0.5], [-0.25, -0.05], [0.15, -0.05], [0.35, 0.22], [0.1, 0.5], [-0.3, 0.4]],
			[[-0.25, -0.5], [-0.25, -0.05], [0.2, -0.05], [0.35, 0.22], [0.05, 0.5], [-0.3, 0.4]],
		],
	},
	{
		tex: "6",
		aspect: [0.28, 1.25],
		variants: [
			[[0.2, -0.5], [-0.2, -0.1], [-0.3, 0.3], [0, 0.5], [0.3, 0.25], [0.05, 0], [-0.28, 0.2]],
			[[0.15, -0.5], [-0.25, 0.1], [-0.2, 0.45], [0.2, 0.45], [0.25, 0.15], [-0.2, 0.12]],
		],
	},
	{
		tex: "7",
		aspect: [0.32, 1.35],
		variants: [
			[[-0.35, -0.5], [0.35, -0.5], [-0.1, 0.5]],
			[[-0.35, -0.45], [0.35, -0.5], [0.0, 0.5]],
		],
	},
	{
		tex: "8",
		aspect: [0.28, 1.2],
		reversible: true,
		variants: [
			[[0, 0], [-0.25, -0.25], [0, -0.5], [0.25, -0.25], [0, 0], [-0.3, 0.25], [0, 0.5], [0.3, 0.25], [0, 0]],
			[[0, -0.5], [-0.25, -0.25], [0.25, 0.25], [0, 0.5], [-0.25, 0.25], [0.25, -0.25], [0, -0.5]],
		],
	},
	{
		tex: "9",
		aspect: [0.28, 1.25],
		variants: [
			[[0.25, -0.2], [0, -0.5], [-0.28, -0.25], [0, 0], [0.28, -0.2], [0.2, 0.5]],
			[[0.25, -0.25], [-0.05, -0.5], [-0.28, -0.22], [0, 0.02], [0.25, -0.25], [0.05, 0.5]],
		],
	},
	{
		tex: "a",
		aspect: [0.5, 1.45],
		variants: [
			[[0.2, -0.2], [-0.2, -0.2], [-0.35, 0.1], [-0.1, 0.3], [0.25, 0.05], [0.3, -0.25], [0.35, 0.35]],
			[[0.25, -0.25], [-0.2, -0.25], [-0.35, 0.15], [0, 0.35], [0.28, -0.1], [0.35, 0.38]],
		],
	},
	{
		tex: "b",
		aspect: [0.32, 1.15],
		variants: [
			[[-0.25, -0.5], [-0.25, 0.5], [0.2, 0.4], [0.3, 0.1], [-0.2, 0]],
		],
	},
	{
		tex: "c",
		aspect: [0.4, 1.35],
		reversible: true,
		variants: [arcPts(0.05, 0, 0.35, 0.45, -45, -315)],
	},
	{
		tex: "d",
		aspect: [0.32, 1.2],
		variants: [
			[[0.25, 0], [-0.25, 0], [-0.3, 0.35], [0.2, 0.45], [0.28, -0.5], [0.32, 0.5]],
		],
	},
	{
		tex: "e",
		aspect: [0.5, 1.45],
		variants: [
			[[-0.25, 0], [0.3, -0.05], [0.15, -0.35], [-0.25, -0.2], [-0.3, 0.2], [0.05, 0.4], [0.35, 0.25]],
		],
	},
	{
		tex: "g",
		aspect: [0.32, 1.15],
		variants: [
			[[0.25, -0.25], [-0.15, -0.45], [-0.3, -0.15], [0.2, -0.1], [0.25, -0.35], [0.2, 0.4], [-0.15, 0.5], [-0.3, 0.35]],
		],
	},
	{
		tex: "h",
		aspect: [0.35, 1.2],
		variants: [
			[[-0.28, -0.5], [-0.28, 0.5], [-0.22, 0.05], [0.1, -0.05], [0.28, 0.15], [0.3, 0.5]],
		],
	},
	{
		tex: "m",
		aspect: [0.85, 2.5],
		variants: [
			[[-0.5, 0.3], [-0.45, -0.3], [-0.2, 0.3], [0, -0.3], [0.2, 0.3], [0.45, -0.3], [0.5, 0.3]],
		],
	},
	{
		tex: "n",
		aspect: [0.55, 1.65],
		variants: [
			[[-0.35, 0.35], [-0.35, -0.3], [0, -0.35], [0.3, -0.1], [0.35, 0.35]],
		],
	},
	{
		tex: "p",
		aspect: [0.32, 1.15],
		variants: [
			[[-0.25, 0.5], [-0.25, -0.45], [0.2, -0.4], [0.3, -0.15], [0.15, 0.05], [-0.25, 0.05]],
		],
	},
	{
		tex: "r",
		aspect: [0.4, 1.35],
		variants: [
			[[-0.25, 0.4], [-0.25, -0.35], [0.05, -0.4], [0.3, -0.2]],
		],
	},
	{
		tex: "s",
		aspect: [0.32, 1.2],
		variants: [
			[[0.3, -0.35], [0, -0.5], [-0.3, -0.25], [0.3, 0.2], [0, 0.5], [-0.3, 0.35]],
		],
	},
	{
		tex: "u",
		aspect: [0.5, 1.55],
		reversible: true,
		variants: [
			[[-0.35, -0.35], [-0.25, 0.35], [0.25, 0.35], [0.35, -0.35], [0.35, 0.4]],
			[[-0.35, -0.35], [-0.2, 0.35], [0.2, 0.35], [0.35, -0.35]],
		],
	},
	{
		tex: "v",
		aspect: [0.5, 1.55],
		reversible: true,
		variants: [
			[[-0.4, -0.4], [0, 0.45], [0.4, -0.4]],
		],
	},
	{
		tex: "w",
		aspect: [0.85, 2.5],
		reversible: true,
		variants: [
			[[-0.5, -0.35], [-0.25, 0.35], [0, -0.2], [0.25, 0.35], [0.5, -0.35]],
		],
	},
	{
		tex: "y",
		aspect: [0.35, 1.25],
		variants: [
			[[-0.3, -0.45], [0, 0.05], [0.3, -0.45], [0.1, 0.3], [-0.2, 0.5]],
			[[-0.3, -0.4], [-0.1, 0.05], [0.25, -0.4], [0.15, 0.4], [-0.15, 0.5]],
		],
	},
	{
		tex: "z",
		aspect: [0.45, 1.45],
		variants: [
			[[-0.35, -0.35], [0.35, -0.35], [-0.35, 0.35], [0.35, 0.35]],
		],
	},
	{
		tex: "(",
		role: "open",
		aspect: [0.08, 0.65],
		reversible: true,
		variants: [arcPts(0.25, 0, 0.45, 0.55, -120, -240)],
	},
	{
		tex: ")",
		role: "close",
		aspect: [0.08, 0.65],
		reversible: true,
		variants: [arcPts(-0.25, 0, 0.45, 0.55, -60, 60)],
	},
	{
		tex: "[",
		role: "open",
		aspect: [0.08, 0.65],
		reversible: true,
		variants: [[[0.2, -0.5], [-0.2, -0.5], [-0.2, 0.5], [0.2, 0.5]]],
	},
	{
		tex: "]",
		role: "close",
		aspect: [0.08, 0.65],
		reversible: true,
		variants: [[[-0.2, -0.5], [0.2, -0.5], [0.2, 0.5], [-0.2, 0.5]]],
	},
	{
		tex: "<",
		role: "op",
		aspect: [0.35, 1.55],
		reversible: true,
		variants: [[[0.35, -0.4], [-0.35, 0], [0.35, 0.4]]],
	},
	{
		tex: ">",
		role: "op",
		aspect: [0.35, 1.55],
		reversible: true,
		variants: [[[-0.35, -0.4], [0.35, 0], [-0.35, 0.4]]],
	},
	{
		tex: "\\int",
		role: "bigop",
		aspect: [0.1, 0.6],
		reversible: true,
		variants: [[[0.25, -0.45], [0.05, -0.5], [0, 0], [-0.05, 0.5], [-0.25, 0.45]]],
	},
	{
		tex: "\\Sigma",
		role: "bigop",
		aspect: [0.42, 1.35],
		variants: [[[0.35, -0.45], [-0.35, -0.45], [0.05, 0], [-0.35, 0.45], [0.35, 0.45]]],
	},
	{
		tex: "\\Delta",
		aspect: [0.55, 1.5],
		reversible: true,
		variants: [[[0, -0.45], [-0.45, 0.45], [0.45, 0.45], [0, -0.45]]],
	},
	{
		tex: "\\alpha",
		aspect: [0.6, 1.75],
		reversible: true,
		variants: [
			[[0.4, -0.3], [0, 0.3], [-0.35, 0.1], [-0.2, -0.3], [0.15, 0.1], [0.45, 0.3]],
		],
	},
	{
		tex: "\\beta",
		aspect: [0.28, 1.1],
		variants: [
			[[-0.25, 0.5], [-0.22, -0.45], [0.22, -0.35], [-0.15, -0.05], [0.28, 0.18], [-0.18, 0.35]],
		],
	},
	{
		tex: "\\gamma",
		aspect: [0.35, 1.25],
		variants: [
			[[-0.35, -0.4], [0.05, 0.2], [0, 0.5], [-0.1, 0.25], [0.35, -0.4]],
		],
	},
	{
		tex: "\\omega",
		aspect: [0.85, 2.4],
		variants: [
			[[-0.45, -0.2], [-0.3, 0.3], [0, 0.05], [0.3, 0.3], [0.45, -0.2]],
		],
	},
	{
		tex: "\\infty",
		aspect: [1.25, 3.2],
		reversible: true,
		variants: [
			[[0, 0], [-0.3, -0.35], [-0.5, 0], [-0.3, 0.35], [0, 0], [0.3, -0.35], [0.5, 0], [0.3, 0.35], [0, 0]],
		],
	},
];

const NORMALIZED_TEMPLATES = RAW_TEMPLATES.map((t) => {
	const role: TokenRole = t.role ?? "atom";
	return {
		tex: t.tex,
		role,
		aspect: t.aspect,
		reversible: t.reversible === true,
		variants: t.variants.map((v) => normalizePts(v)),
	};
});

function classifySingleStroke(s: GlyphStroke): { tex: string; role: TokenRole; score: number } {
	if (isDot(s)) return { tex: ".", role: "dot", score: 0.05 };
	if (isHorizontalBar(s)) return { tex: "-", role: "bar", score: 0.05 };
	if (isRadicalStroke(s)) return { tex: "\\sqrt", role: "radical", score: 0.05 };
	const diag = isDiagonalSlash(s);
	if (diag === "fwd") return { tex: "/", role: "op", score: 0.1 };
	if (isVerticalBar(s)) return { tex: "1", role: "atom", score: 0.08 };

	const w = boxW(s.box);
	const h = boxH(s.box);
	const aspect = w / Math.max(h, 1);
	const closed = isClosedLoop(s.pts, s.box);
	const norm = normalizePts(s.pts);
	let bestTex = "x";
	let bestRole: TokenRole = "atom";
	let bestScore = Infinity;

	for (const tpl of NORMALIZED_TEMPLATES) {
		if (tpl.aspect && (aspect < tpl.aspect[0] * 0.65 || aspect > tpl.aspect[1] * 1.5)) continue;
		for (const v of tpl.variants) {
			let dist = polyDistanceBi(norm, v, tpl.reversible);
			// Closed loops strongly favor 0 / \Delta / 8 / \infty over open curves like c / (.
			if (closed && (tpl.tex === "c" || tpl.tex === "(" || tpl.tex === ")")) dist += 0.22;
			if (!closed && tpl.tex === "0") dist += 0.14;
			if (dist < bestScore) {
				bestScore = dist;
				bestTex = tpl.tex;
				bestRole = tpl.role;
			}
		}
	}
	return { tex: bestTex, role: bestRole, score: bestScore };
}

function classifyGroup(strokes: GlyphStroke[]): Glyph {
	const box = strokes.slice(1).reduce((b, s) => mergeBoxes(b, s.box), strokes[0].box);
	if (strokes.length === 1) {
		const { tex, role } = classifySingleStroke(strokes[0]);
		return { strokes, box, tex, role };
	}
	if (strokes.length === 2) {
		const [a, b] = strokes;
		const aH = isHorizontalBar(a);
		const bH = isHorizontalBar(b);
		const aV = isVerticalBar(a);
		const bV = isVerticalBar(b);
		if ((aH && bV) || (aV && bH)) {
			const hBar = aH ? a : b;
			const vBar = aH ? b : a;
			// Distinguishing '+' vs 't' (if horizontal bar is noticeably above midpoint of tall vertical, or crossing near center)
			const cyRatio = (boxCy(hBar.box) - vBar.box.minY) / Math.max(1, boxH(vBar.box));
			const crossing = strokesCross(hBar, vBar);
			if (crossing || minStrokeDist(hBar, vBar) <= 6) {
				if (cyRatio < 0.34 && boxH(vBar.box) > boxW(hBar.box) * 1.35) {
					return { strokes, box, tex: "t", role: "atom" };
				}
				return { strokes, box, tex: "+", role: "op" };
			}
			// Non-crossing horizontal bar below vertical? Treat as '+' if close
			return { strokes, box, tex: "+", role: "op" };
		}
		if (aH && bH) return { strokes, box, tex: "=", role: "op" };
		const da = isDiagonalSlash(a);
		const db = isDiagonalSlash(b);
		if (da && db && da !== db) {
			if (strokesCross(a, b)) return { strokes, box, tex: "x", role: "atom" };
			// Two diagonals meeting at bottom -> 'v', or meeting at top -> '\lambda' / 'A'
			const aBot = Math.max(a.pts[0][1], a.pts[a.pts.length - 1][1]);
			const bBot = Math.max(b.pts[0][1], b.pts[b.pts.length - 1][1]);
			if (Math.abs(aBot - bBot) < boxH(box) * 0.25 && minStrokeDist(a, b) < boxW(box) * 0.25) {
				return { strokes, box, tex: "x", role: "atom" };
			}
		}
		if ((isDot(a) && isVerticalBar(b)) || (isDot(b) && isVerticalBar(a))) {
			return { strokes, box, tex: "i", role: "atom" };
		}
		// Two-stroke '4': L-shape + vertical bar (standard German & international 4!).
		if ((aV && isLShapeForFour(b)) || (bV && isLShapeForFour(a))) {
			return { strokes, box, tex: "4", role: "atom" };
		}
		if (aH || bH) {
			const bar = aH ? a : b;
			const other = aH ? b : a;
			const single = classifySingleStroke(other);
			// '<' + bar or '>' + bar -> \le / \ge
			if (boxCy(bar.box) > boxCy(other.box) && Math.abs(boxCx(bar.box) - boxCx(other.box)) < boxW(box) * 0.45) {
				if (single.tex === "<") return { strokes, box, tex: "\\le", role: "op" };
				if (single.tex === ">") return { strokes, box, tex: "\\ge", role: "op" };
			}
			// German barred '7' (7 stroke + horizontal crossbar near middle).
			if (single.tex === "7" && strokesCross(bar, other)) {
				return { strokes, box, tex: "7", role: "atom" };
			}
			// German barred 'z' (z stroke + horizontal crossbar near middle).
			if (single.tex === "z" && strokesCross(bar, other)) {
				return { strokes, box, tex: "z", role: "atom" };
			}
			// '5' (horizontal top bar + lower body)
			if (bar.box.maxY < other.box.minY + boxH(other.box) * 0.4 && (single.tex === "5" || single.tex === "s" || single.tex === "3")) {
				return { strokes, box, tex: "5", role: "atom" };
			}
			// 't' (vertical/hook crossed by horizontal)
			if (strokesCross(bar, other) && boxH(other.box) > boxW(bar.box) * 0.85) {
				return { strokes, box, tex: "t", role: "atom" };
			}
		}
		// Curved 'x' drawn as two touching/crossing arcs ')('
		const ca = classifySingleStroke(a);
		const cb = classifySingleStroke(b);
		if ((ca.tex === ")" && cb.tex === "(") || (ca.tex === "(" && cb.tex === ")") || (ca.tex === "c" && cb.tex === ")") || (cb.tex === "c" && ca.tex === ")")) {
			return { strokes, box, tex: "x", role: "atom" };
		}
		if (strokesCross(a, b)) return { strokes, box, tex: "x", role: "atom" };
	}
	if (strokes.length === 3) {
		const horiz = strokes.filter(isHorizontalBar);
		const vert = strokes.filter(isVerticalBar);
		const slashes = strokes.filter((s) => isDiagonalSlash(s) !== null);
		// '=' + diagonal slash -> \neq
		if (horiz.length === 2 && slashes.length === 1) {
			return { strokes, box, tex: "\\neq", role: "op" };
		}
		// '+' over '-' -> \pm
		if (horiz.length === 2 && vert.length === 1) {
			const v = vert[0];
			const crossed = horiz.filter((h) => strokesCross(h, v));
			const uncrossed = horiz.filter((h) => !strokesCross(h, v));
			if (crossed.length === 1 && uncrossed.length === 1 && boxCy(uncrossed[0].box) > boxCy(crossed[0].box)) {
				return { strokes, box, tex: "\\pm", role: "op" };
			}
		}
		// 3 parallel horizontal bars -> \equiv
		if (horiz.length === 3) {
			return { strokes, box, tex: "\\equiv", role: "op" };
		}
		if (horiz.length === 1 && vert.length === 2) {
			const bar = horiz[0];
			if (bar.box.maxY <= Math.min(vert[0].box.minY, vert[1].box.minY) + 10) {
				return { strokes, box, tex: "\\pi", role: "atom" };
			}
			return { strokes, box, tex: "H", role: "atom" };
		}
		if (strokes.filter(isDot).length === 2 && horiz.length === 1) {
			return { strokes, box, tex: "\\div", role: "op" };
		}
		// 'A': two diagonals + horizontal crossbar
		if (horiz.length === 1 && slashes.length === 2) {
			return { strokes, box, tex: "A", role: "atom" };
		}
	}
	const sorted = [...strokes].sort((p, q) => pathLength(q.pts) - pathLength(p.pts));
	const best = classifySingleStroke(sorted[0]);
	return { strokes, box, tex: best.tex, role: best.role };
}

/** Merge raw strokes into candidate glyphs before 2D layout parsing. */
function groupStrokes(raw: readonly Stroke[]): Glyph[] {
	const items: GlyphStroke[] = raw
		.filter((s) => s.points.length > 0 && s.tool !== "highlighter")
		.map((s) => {
			const pts = s.points.map((p): [number, number] => [p[0], p[1]]);
			return { pts, box: boxOfPts(pts) };
		});
	if (items.length === 0) return [];

	const medianH = Math.max(
		14,
		[...items].map((i) => boxH(i.box)).sort((a, b) => a - b)[Math.floor(items.length / 2)] ?? 24,
	);
	const n = items.length;
	const parent = Array.from({ length: n }, (_, i) => i);
	const find = (x: number): number => (parent[x] === x ? x : (parent[x] = find(parent[x])));
	const unite = (a: number, b: number) => {
		const ra = find(a);
		const rb = find(b);
		if (ra !== rb) parent[rb] = ra;
	};

	for (let i = 0; i < n; i++) {
		for (let j = i + 1; j < n; j++) {
			const a = items[i];
			const b = items[j];
			if (isRadicalStroke(a) || isRadicalStroke(b)) continue;
			// Merge crossing strokes (+, x, t, barred 7, barred z, 4, \neq ...).
			if (strokesCross(a, b)) {
				unite(i, j);
				continue;
			}
			const ha = isHorizontalBar(a);
			const hb = isHorizontalBar(b);
			const va = isVerticalBar(a);
			const vb = isVerticalBar(b);
			const overlapX = Math.min(a.box.maxX, b.box.maxX) - Math.max(a.box.minX, b.box.minX);
			const minW = Math.max(1, Math.min(boxW(a.box), boxW(b.box)));
			const maxW = Math.max(boxW(a.box), boxW(b.box));

			// Merge '=' (or '\equiv' / '\pm' bottom bar): two close horizontal bars with nothing between them.
			if (ha && hb && overlapX / minW >= 0.42 && maxW <= minW * 2.0) {
				const gapY = Math.max(a.box.minY, b.box.minY) - Math.min(a.box.maxY, b.box.maxY);
				if (gapY >= -4 && gapY <= Math.max(20, maxW * 0.6)) {
					const topY = Math.min(a.box.maxY, b.box.maxY);
					const botY = Math.max(a.box.minY, b.box.minY);
					const x0 = Math.min(a.box.minX, b.box.minX);
					const x1 = Math.max(a.box.maxX, b.box.maxX);
					const hasMiddle = items.some(
						(k, idx) =>
							idx !== i &&
							idx !== j &&
							!strokesCross(k, a) &&
							!strokesCross(k, b) &&
							k.box.maxX >= x0 &&
							k.box.minX <= x1 &&
							boxCy(k.box) > topY - 2 &&
							boxCy(k.box) < botY + 2,
					);
					if (!hasMiddle) {
						unite(i, j);
						continue;
					}
				}
			}

			// Merge '+' or 2-stroke '4' where strokes touch within a small gap without crossing.
			if (((ha && vb) || (hb && va)) && minStrokeDist(a, b) <= 4) {
				const hBar = ha ? a : b;
				const vBar = ha ? b : a;
				if (boxW(hBar.box) <= boxH(vBar.box) * 2.2) {
					unite(i, j);
					continue;
				}
			}
			if (((va && isLShapeForFour(b)) || (vb && isLShapeForFour(a))) && minStrokeDist(a, b) <= 8) {
				unite(i, j);
				continue;
			}

			// Merge '<' / '>' with underline bar ('\le' / '\ge').
			if ((ha || hb) && overlapX / minW >= 0.45) {
				const bar = ha ? a : b;
				const other = ha ? b : a;
				const gap = bar.box.minY - other.box.maxY;
				if (gap >= -4 && gap <= Math.max(14, medianH * 0.45)) {
					const cls = classifySingleStroke(other);
					if (cls.tex === "<" || cls.tex === ">") {
						unite(i, j);
						continue;
					}
				}
			}

			// Merge two-stroke '5' (top bar + lower curve touching).
			if ((ha || hb) && minStrokeDist(a, b) <= 8) {
				const bar = ha ? a : b;
				const other = ha ? b : a;
				if (bar.box.maxY <= other.box.minY + Math.max(8, boxH(other.box) * 0.3) && overlapX >= -4) {
					const cls = classifySingleStroke(other);
					if (cls.tex === "5" || cls.tex === "s" || cls.tex === "3") {
						unite(i, j);
						continue;
					}
				}
			}

			// Merge curved 'x' drawn as touching ')('.
			if (minStrokeDist(a, b) <= 5 && Math.abs(boxCy(a.box) - boxCy(b.box)) <= medianH * 0.35) {
				const ca = classifySingleStroke(a);
				const cb = classifySingleStroke(b);
				if ((ca.tex === ")" && (cb.tex === "(" || cb.tex === "c")) || (cb.tex === ")" && (ca.tex === "(" || ca.tex === "c"))) {
					unite(i, j);
					continue;
				}
			}

			// Merge dot over vertical bar ('i').
			if ((isDot(a) && vb) || (isDot(b) && va)) {
				const dot = isDot(a) ? a : b;
				const bar = isDot(a) ? b : a;
				const gap = bar.box.minY - dot.box.maxY;
				if (gap >= -4 && gap <= medianH * 0.7 && Math.abs(dot.box.minX - bar.box.minX) <= Math.max(10, medianH * 0.45)) {
					unite(i, j);
					continue;
				}
			}

			// Merge π legs with top bar.
			if ((ha && vb) || (hb && va)) {
				const bar = ha ? a : b;
				const leg = ha ? b : a;
				const gap = leg.box.minY - bar.box.maxY;
				if (
					gap >= -6 &&
					gap <= 10 &&
					leg.box.minX >= bar.box.minX - 4 &&
					leg.box.maxX <= bar.box.maxX + 4 &&
					boxW(bar.box) >= 12
				) {
					unite(i, j);
				}
			}
		}
	}

	const groups = new Map<number, GlyphStroke[]>();
	for (let i = 0; i < n; i++) {
		const r = find(i);
		let list = groups.get(r);
		if (!list) groups.set(r, (list = []));
		list.push(items[i]);
	}
	return [...groups.values()].map(classifyGroup);
}

function wrapBraces(tex: string): string {
	return tex.length === 1 && !tex.startsWith("\\") ? tex : `{${tex}}`;
}

function parseTokens(tokens: Glyph[]): string {
	if (tokens.length === 0) return "";
	const remaining = [...tokens];
	const consumed = new Set<Glyph>();
	const resolved: Glyph[] = [];

	// 1. Radicals (\sqrt{inner})
	for (const g of remaining) {
		if (consumed.has(g) || g.role !== "radical") continue;
		const inner = remaining.filter(
			(o) =>
				o !== g &&
				!consumed.has(o) &&
				o.box.minX >= g.box.minX + boxW(g.box) * 0.14 &&
				o.box.maxX <= g.box.maxX + 12 &&
				boxCy(o.box) >= g.box.minY &&
				o.box.maxY <= g.box.maxY + Math.max(12, boxH(g.box) * 0.45),
		);
		if (inner.length > 0) {
			consumed.add(g);
			for (const o of inner) consumed.add(o);
			const box = inner.reduce((b, o) => mergeBoxes(b, o.box), g.box);
			resolved.push({ strokes: g.strokes, box, tex: `\\sqrt{${parseTokens(inner)}}`, role: "atom" });
		}
	}

	// 2. Fractions (\frac{num}{den}): wide horizontal bar with tokens strictly above and below inside its x-span.
	const bars = remaining
		.filter((g) => !consumed.has(g) && g.role === "bar" && boxW(g.box) >= 14)
		.sort((a, b) => boxW(b.box) - boxW(a.box));
	for (const bar of bars) {
		if (consumed.has(bar)) continue;
		const pad = Math.max(8, boxW(bar.box) * 0.18);
		const num = remaining.filter(
			(o) =>
				o !== bar &&
				!consumed.has(o) &&
				o.box.minX >= bar.box.minX - pad &&
				o.box.maxX <= bar.box.maxX + pad &&
				boxCy(o.box) < bar.box.minY,
		);
		const den = remaining.filter(
			(o) =>
				o !== bar &&
				!consumed.has(o) &&
				o.box.minX >= bar.box.minX - pad &&
				o.box.maxX <= bar.box.maxX + pad &&
				boxCy(o.box) > bar.box.maxY,
		);
		if (num.length > 0 && den.length > 0) {
			consumed.add(bar);
			for (const o of num) consumed.add(o);
			for (const o of den) consumed.add(o);
			const box = [...num, ...den].reduce((b, o) => mergeBoxes(b, o.box), bar.box);
			resolved.push({
				strokes: bar.strokes,
				box,
				tex: `\\frac{${parseTokens(num)}}{${parseTokens(den)}}`,
				role: "atom",
			});
		}
	}

	for (const g of remaining) if (!consumed.has(g)) resolved.push(g);
	if (resolved.length === 0) return "";

	// 3. Left-to-right baseline + super/subscript parsing.
	resolved.sort((a, b) => a.box.minX - b.box.minX);
	const out: string[] = [];
	let base = resolved[0];
	let i = 0;

	const emitOp = (tex: string): string => {
		if (tex === "+" || tex === "-" || tex === "=" || tex === "<" || tex === ">") return ` ${tex} `;
		if (
			tex === "\\le" ||
			tex === "\\ge" ||
			tex === "\\neq" ||
			tex === "\\equiv" ||
			tex === "\\times" ||
			tex === "\\div" ||
			tex === "\\pm"
		) {
			return ` ${tex} `;
		}
		return tex;
	};

	while (i < resolved.length) {
		const cur = resolved[i];
		if (i === 0) {
			out.push(cur.tex);
			base = cur;
			i++;
			continue;
		}
		const baseH = Math.max(12, boxH(base.box));
		const curH = boxH(cur.box);
		const baseMid = boxCy(base.box);
		const curMid = boxCy(cur.box);

		if (base.role === "bigop" && Math.abs(cur.box.minX - base.box.maxX) < Math.max(24, boxW(base.box) * 1.4)) {
			if (curMid < base.box.minY + baseH * 0.25) {
				const group: Glyph[] = [cur];
				let j = i + 1;
				while (j < resolved.length && boxCy(resolved[j].box) < base.box.minY + baseH * 0.3) {
					group.push(resolved[j++]);
				}
				out.push(`^${wrapBraces(parseTokens(group))}`);
				i = j;
				continue;
			}
			if (curMid > base.box.maxY - baseH * 0.25) {
				const group: Glyph[] = [cur];
				let j = i + 1;
				while (j < resolved.length && boxCy(resolved[j].box) > base.box.maxY - baseH * 0.3) {
					group.push(resolved[j++]);
				}
				out.push(`_${wrapBraces(parseTokens(group))}`);
				i = j;
				continue;
			}
		}

		// Superscript: noticeably higher than base midline (or tiny minus/sign above baseline like e^-x).
		const isSup =
			base.role !== "op" &&
			base.role !== "open" &&
			cur.role !== "close" &&
			cur.tex !== "=" &&
			((curMid < baseMid - baseH * 0.28 && curH < baseH * 0.85) ||
				(cur.box.maxY < base.box.minY + baseH * 0.35 && curH < baseH * 0.9));
		if (isSup) {
			const group: Glyph[] = [cur];
			let j = i + 1;
			while (
				j < resolved.length &&
				resolved[j].tex !== "=" &&
				boxCy(resolved[j].box) < baseMid - baseH * 0.2
			) {
				group.push(resolved[j++]);
			}
			out.push(`^${wrapBraces(parseTokens(group))}`);
			i = j;
			continue;
		}

		// Subscript: noticeably below base midline.
		const isSub =
			base.role !== "op" &&
			base.role !== "open" &&
			cur.role !== "close" &&
			cur.role !== "dot" &&
			cur.tex !== "=" &&
			curMid > baseMid + baseH * 0.28 &&
			curH < baseH * 0.85;
		if (isSub) {
			const group: Glyph[] = [cur];
			let j = i + 1;
			while (
				j < resolved.length &&
				resolved[j].tex !== "=" &&
				boxCy(resolved[j].box) > baseMid + baseH * 0.2
			) {
				group.push(resolved[j++]);
			}
			out.push(`_${wrapBraces(parseTokens(group))}`);
			i = j;
			continue;
		}

		if (cur.role === "dot") {
			if (curMid < base.box.maxY - baseH * 0.25) out.push(" \\cdot ");
			else out.push(".");
			i++;
			continue;
		}

		out.push(emitOp(cur.tex));
		base = cur;
		i++;
	}

	return out.join("").replace(/\s+/g, " ").trim();
}

/** Recognize handwritten strokes locally into a raw LaTeX expression (without `$` delimiters). */
export function recognizeMathFromStrokes(strokes: readonly Stroke[]): string {
	const glyphs = groupStrokes(strokes);
	if (glyphs.length === 0) return "";
	return parseTokens(glyphs);
}

/** Wrap raw LaTeX in Obsidian `$...$` / `$$...$$` delimiters. */
export function formatLatexFormula(rawTex: string, delimiters: MathDelimiters): string {
	const tex = rawTex.trim().replace(/^\$+|\$+$/g, "").trim();
	if (!tex) return "";
	const useBlock =
		delimiters === "block" ||
		(delimiters === "auto" && (/\\frac|\\sum|\\int|\\sqrt/.test(tex) || tex.includes("\n")));
	return useBlock ? `$$\n${tex}\n$$` : `$${tex}$`;
}

/** Extract clean LaTeX from an AI model response (strips markdown fences and surrounding `$`). */
export function cleanVisionLatexResponse(raw: string): string {
	let s = raw.trim();
	s = s.replace(/^```(?:latex|tex)?\s*/i, "").replace(/```$/i, "").trim();
	s = s.replace(/^\$\$?|\$\$?$/g, "").trim();
	return s;
}
