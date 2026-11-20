/**
 * Synthetic "hand-drawn" input for recognizer/gesture tests: dense, unevenly spaced points with
 * low-frequency wobble plus high-frequency jitter, from a seeded RNG (deterministic).
 */
export type XY = [number, number];

export function rng(seed: number): () => number {
	let s = seed >>> 0 || 1;
	return () => {
		// mulberry32
		s = (s + 0x6d2b79f5) >>> 0;
		let t = s;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

/** Points along a polyline, spaced ~`step` px apart (with ±40% spacing variation). */
export function along(vertices: readonly XY[], step = 2, seed = 1): XY[] {
	const rand = rng(seed);
	const out: XY[] = [[vertices[0][0], vertices[0][1]]];
	for (let i = 1; i < vertices.length; i++) {
		const a = vertices[i - 1];
		const b = vertices[i];
		const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
		let t = 0;
		while (true) {
			t += (step * (0.6 + 0.8 * rand())) / Math.max(len, 1e-9);
			if (t >= 1) break;
			out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
		}
		out.push([b[0], b[1]]);
	}
	return out;
}

/** Smooth wobble (amplitude `wobble`) + jitter (amplitude `jitter`) added to every point. */
export function noisy(pts: readonly XY[], wobble = 1.5, jitter = 0.6, seed = 7): XY[] {
	const rand = rng(seed);
	const ph = [rand() * 6.28, rand() * 6.28, rand() * 6.28, rand() * 6.28];
	const f1 = 0.02 + 0.02 * rand();
	const f2 = 0.05 + 0.03 * rand();
	let s = 0;
	return pts.map((p, i) => {
		if (i > 0) s += Math.hypot(p[0] - pts[i - 1][0], p[1] - pts[i - 1][1]);
		const wx = wobble * (0.6 * Math.sin(s * f1 + ph[0]) + 0.4 * Math.sin(s * f2 + ph[1]));
		const wy = wobble * (0.6 * Math.sin(s * f1 + ph[2]) + 0.4 * Math.sin(s * f2 + ph[3]));
		return [p[0] + wx + (rand() - 0.5) * 2 * jitter, p[1] + wy + (rand() - 0.5) * 2 * jitter];
	});
}

/** Parametric curve sampled densely. */
export function curve(f: (t: number) => XY, t0: number, t1: number, n = 200): XY[] {
	const out: XY[] = [];
	for (let i = 0; i <= n; i++) out.push(f(t0 + ((t1 - t0) * i) / n));
	return out;
}

export function rotateAll(pts: readonly XY[], deg: number, about: XY): XY[] {
	const a = (deg * Math.PI) / 180;
	const c = Math.cos(a);
	const s = Math.sin(a);
	return pts.map(([x, y]) => {
		const dx = x - about[0];
		const dy = y - about[1];
		return [about[0] + dx * c - dy * s, about[1] + dx * s + dy * c];
	});
}

/** Cursive-like handwriting: loops and arches progressing to the right. */
export function cursive(x0: number, y0: number, letters: number, h = 18, seed = 3): XY[] {
	const rand = rng(seed);
	const out: XY[] = [];
	let x = x0;
	for (let l = 0; l < letters; l++) {
		const w = h * (0.6 + 0.5 * rand());
		const loop = rand() < 0.5;
		const n = 30;
		for (let i = 0; i <= n; i++) {
			const t = i / n;
			// Each letter: an up-and-over arch (or a loop) advancing by w.
			const ang = t * 2 * Math.PI;
			const px = x + w * t + (loop ? -0.35 * w * Math.sin(ang) : 0);
			const py = y0 - h * (loop ? 0.5 * (1 - Math.cos(ang)) : Math.sin(Math.PI * t));
			out.push([px, py]);
		}
		x += w;
	}
	return out;
}

/** Printed "m": stem down, back up, then two arches each followed by a stem down (retraced up). */
export function letterM(x0: number, y0: number, h = 20, w = 26): XY[] {
	const out: XY[] = [];
	const push = (pts: XY[]) => out.push(...(out.length ? pts.slice(1) : pts));
	const shoulder = y0 - 0.75 * h;
	const arch = (xa: number, xb: number) =>
		curve((t) => [xa + ((xb - xa) * (1 - Math.cos(t))) / 2, shoulder - 0.25 * h * Math.sin(t)], 0, Math.PI, 24);
	push(along([[x0, y0 - h], [x0, y0], [x0, shoulder]], 1.5));
	push(arch(x0, x0 + w / 2));
	push(along([[x0 + w / 2, shoulder], [x0 + w / 2, y0], [x0 + w / 2, shoulder]], 1.5));
	push(arch(x0 + w / 2, x0 + w));
	push(along([[x0 + w, shoulder], [x0 + w, y0]], 1.5));
	return out;
}

/** Printed "w": four straight strokes. */
export function letterW(x0: number, y0: number, h = 18, w = 24): XY[] {
	return along(
		[
			[x0, y0 - h],
			[x0 + w * 0.25, y0],
			[x0 + w * 0.5, y0 - h * 0.7],
			[x0 + w * 0.75, y0],
			[x0 + w, y0 - h],
		],
		1.5,
	);
}

export interface HandOpts {
	/** Bow (slight curvature) as a fraction of the length; sign picked by the seed. */
	bow?: number;
	/** Jitter amplitude (px) and low-frequency wobble (px) perpendicular to the stroke. */
	jitter?: number;
	wobble?: number;
	/** Settling hook at the end (px): the pen curls sideways/back when it stops. */
	hook?: number;
	/** Points recorded while the pen is held still (drifting within ±holdDrift px). */
	holdPoints?: number;
	holdDrift?: number;
}

/**
 * A realistic hand-drawn straight stroke from `a` to `b`: slow start, fast middle, slow end (so the
 * point density varies a lot), a slight bow, jitter + wobble, a small settling hook at the end and a
 * cluster of drifting points recorded while the pen is held for the snap.
 */
export function handStroke(a: XY, b: XY, seed: number, o: HandOpts = {}): XY[] {
	const rand = rng(seed);
	const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
	const ux = (b[0] - a[0]) / L;
	const uy = (b[1] - a[1]) / L;
	const nx = -uy;
	const ny = ux;
	const bow = (o.bow ?? 0.02) * L * (rand() < 0.5 ? -1 : 1);
	const jitter = o.jitter ?? 0.6;
	const wobble = o.wobble ?? 0.8;
	const ph = rand() * 6.28;
	const out: XY[] = [];
	let t = 0;
	while (t < 1) {
		const off = bow * 4 * t * (1 - t) + (rand() - 0.5) * 2 * jitter + wobble * Math.sin(t * 9 + ph);
		out.push([a[0] + ux * L * t + nx * off, a[1] + uy * L * t + ny * off]);
		const speed = 0.3 + 3.5 * Math.sin(Math.PI * t); // px per sample: slow at the ends
		t += (speed * (0.5 + rand())) / L;
	}
	out.push([b[0], b[1]]);
	settle(out, ux, uy, rand, o);
	return out;
}

/** Append a settling hook and the hold-drift cluster to `out` (direction of travel ux, uy). */
function settle(out: XY[], ux: number, uy: number, rand: () => number, o: HandOpts): void {
	const end = out[out.length - 1];
	const hook = o.hook ?? 4;
	const side = rand() < 0.5 ? -1 : 1;
	for (let i = 1; i <= 6 && hook > 0; i++) {
		const f = i / 6;
		const back = -hook * 0.5 * f;
		const lat = side * hook * Math.sin(f * 1.4);
		out.push([end[0] + ux * back - uy * lat, end[1] + uy * back + ux * lat]);
	}
	const last = out[out.length - 1];
	const drift = o.holdDrift ?? 1.5;
	for (let i = 0; i < (o.holdPoints ?? 30); i++) out.push([last[0] + (rand() - 0.5) * 2 * drift, last[1] + (rand() - 0.5) * 2 * drift]);
}

/**
 * A hand-drawn arrow drawn the user's way: shaft `a` → `tip`, then for each barb out from the tip
 * and back to (near) the tip, then hold. `barbs` = [angle off the backward shaft direction (deg,
 * signed: + and − are opposite sides), length (px)]. `returnLast` = false leaves the pen at the end
 * of the last barb (shaft → hook style).
 */
export function handArrow(
	a: XY,
	tip: XY,
	barbs: readonly (readonly [number, number])[],
	seed: number,
	o: HandOpts & { returnLast?: boolean } = {},
): XY[] {
	const rand = rng(seed + 100);
	const pts = handStroke(a, tip, seed, { ...o, hook: 0, holdPoints: 0 });
	const L = Math.hypot(tip[0] - a[0], tip[1] - a[1]);
	const back = Math.atan2(a[1] - tip[1], a[0] - tip[0]);
	const verts: XY[] = [[tip[0], tip[1]]];
	barbs.forEach(([deg, len], i) => {
		const ang = back + (deg * Math.PI) / 180;
		verts.push([tip[0] + Math.cos(ang) * len, tip[1] + Math.sin(ang) * len]);
		const last = i === barbs.length - 1;
		if (!last || o.returnLast !== false) {
			// Back to the tip, imprecisely (within ~3 px).
			verts.push([tip[0] + (rand() - 0.5) * 6, tip[1] + (rand() - 0.5) * 6]);
		}
	});
	const head = noisy(along(verts, 1.5, seed), 0.6, 0.4, seed);
	pts.push(...head.slice(1));
	settle(pts, (tip[0] - a[0]) / L, (tip[1] - a[1]) / L, rand, { ...o, hook: o.hook ?? 0 });
	return pts;
}

/**
 * A hand-drawn smooth curve along `f(t)`, t ∈ [0, 1]: slow start, fast middle, slow end, jitter and
 * wobble perpendicular to the path, then the settling hook and hold drift (like `handStroke`).
 */
export function handCurve(f: (t: number) => XY, seed: number, o: HandOpts = {}): XY[] {
	const rand = rng(seed);
	const N = 2000;
	const dense: XY[] = [];
	const cum: number[] = [0];
	for (let i = 0; i <= N; i++) {
		dense.push(f(i / N));
		if (i > 0) cum.push(cum[i - 1] + Math.hypot(dense[i][0] - dense[i - 1][0], dense[i][1] - dense[i - 1][1]));
	}
	const L = cum[N];
	const jitter = o.jitter ?? 0.6;
	const wobble = o.wobble ?? 0.8;
	const ph = rand() * 6.28;
	const out: XY[] = [];
	let s = 0;
	let j = 0;
	let ux = 1;
	let uy = 0;
	while (s < L) {
		while (j < N - 1 && cum[j + 1] < s) j++;
		const t = (s - cum[j]) / Math.max(1e-9, cum[j + 1] - cum[j]);
		const a = dense[j];
		const b = dense[j + 1];
		const len = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
		ux = (b[0] - a[0]) / len;
		uy = (b[1] - a[1]) / len;
		const off = (rand() - 0.5) * 2 * jitter + wobble * Math.sin((s / L) * 9 + ph);
		out.push([a[0] + (b[0] - a[0]) * t - uy * off, a[1] + (b[1] - a[1]) * t + ux * off]);
		const speed = 0.3 + 3.5 * Math.sin(Math.PI * (s / L));
		s += speed * (0.5 + rand());
	}
	const end = dense[N];
	out.push([end[0], end[1]]);
	settle(out, ux, uy, rand, o);
	return out;
}

/**
 * A hand-drawn open polyline in ONE stroke (e.g. graph axes "down, then right"): each segment is a
 * `handStroke` (bow, jitter, slow ends); at every corner the pen overshoots by `overshoot` px before
 * turning, and the next segment starts from there. Settling hook + hold drift only at the very end.
 */
export function handPolyline(vertices: readonly XY[], seed: number, o: HandOpts & { overshoot?: number } = {}): XY[] {
	const rand = rng(seed + 200);
	const out: XY[] = [];
	let from: XY = [vertices[0][0], vertices[0][1]];
	let ux = 1;
	let uy = 0;
	for (let i = 1; i < vertices.length; i++) {
		const to = vertices[i];
		const L = Math.hypot(to[0] - from[0], to[1] - from[1]);
		ux = (to[0] - from[0]) / L;
		uy = (to[1] - from[1]) / L;
		const ov = i < vertices.length - 1 ? (o.overshoot ?? 0) * (0.5 + rand()) : 0;
		const end: XY = [to[0] + ux * ov, to[1] + uy * ov];
		const seg = handStroke(from, end, seed * 31 + i, { ...o, hook: 0, holdPoints: 0 });
		out.push(...(out.length ? seg.slice(1) : seg));
		from = end;
	}
	settle(out, ux, uy, rand, o);
	return out;
}
