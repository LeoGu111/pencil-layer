import { describe, expect, it } from "vitest";
import { SNAP_HOLD_MS, ShapeSpec, adjustShape, arrowBarbs, draggedShape, findCorners, recognizeShape, resample, shapeToPoints } from "../src/shapes";
import { nearestGuideEdge, projectToEdge, setSquareEdges } from "../src/geometryGuide";
import { XY, along, curve, cursive, handArrow, handCurve, handPolyline, handStroke, letterM, letterW, noisy, rotateAll } from "./handdrawn";

const close = (a: number, b: number, tol: number) => expect(Math.abs(a - b)).toBeLessThanOrEqual(tol);
const closePt = (p: readonly number[], q: readonly number[], tol: number) => {
	close(p[0], q[0], tol);
	close(p[1], q[1], tol);
};

describe("geometry tools", () => {
	it("sizes selected shapes by dragging in either direction", () => {
		expect(draggedShape("rectangle", [80, 100], [20, 40])).toEqual({ kind: "rectangle", vertices: [[80, 100], [20, 100], [20, 40], [80, 40]] });
		expect(draggedShape("ellipse", [80, 100], [20, 60])).toEqual({ kind: "ellipse", cx: 50, cy: 80, rx: 30, ry: 20, rot: 0 });
		expect(draggedShape("triangle", [80, 100], [20, 40])).toEqual({ kind: "triangle", vertices: [[50, 100], [20, 40], [80, 40]] });
	});

	it("snaps to one finite edge of a rotated set square", () => {
		const edges = setSquareEdges([100, 100], 90, 50);
		const edge = nearestGuideEdge([104, 90], edges, 14);
		expect(edge).toEqual(edges[0]);
		closePt(projectToEdge([70, 200], edge!), [100, 150], 1e-6);
		expect(nearestGuideEdge([170, 90], edges, 14)).toBeNull();
	});
});

function rectPath(x: number, y: number, w: number, h: number, startFrac = 0): XY[] {
	const v: XY[] = [
		[x, y],
		[x + w, y],
		[x + w, y + h],
		[x, y + h],
	];
	// Start somewhere along the top edge, go around and slightly past the start.
	const s: XY = [x + w * startFrac, y];
	return along([s, ...v.slice(1), v[0], [s[0] + 4, s[1]]], 2);
}

function ellipsePath(cx: number, cy: number, rx: number, ry: number, rotDeg = 0, overshoot = 0.05): XY[] {
	const r = (rotDeg * Math.PI) / 180;
	return curve(
		(t) => {
			const x = rx * Math.cos(t);
			const y = ry * Math.sin(t);
			return [cx + x * Math.cos(r) - y * Math.sin(r), cy + x * Math.sin(r) + y * Math.cos(r)];
		},
		0.3,
		0.3 + 2 * Math.PI * (1 + overshoot),
		260,
	);
}

describe("recognizeShape — positives (noisy hand-drawn input)", () => {
	it("line", () => {
		for (const seed of [1, 2, 3, 4, 5]) {
			const s = recognizeShape(noisy(along([[10, 10], [210, 90]], 2, seed), 1.5, 0.6, seed));
			expect(s?.kind).toBe("line");
			const l = s as Extract<ShapeSpec, { kind: "line" }>;
			closePt(l.a, [10, 10], 3);
			closePt(l.b, [210, 90], 4);
		}
	});

	it("nearly horizontal line snaps to exactly horizontal", () => {
		const s = recognizeShape(noisy(along([[0, 100], [300, 108]]), 1, 0.4)) as Extract<ShapeSpec, { kind: "line" }>;
		expect(s.kind).toBe("line");
		close(s.b[1], s.a[1], 1e-9);
	});

	it("arrow (shaft, then a hook back at the tip)", () => {
		for (const seed of [1, 2, 3]) {
			const pts = noisy(along([[20, 200], [220, 200], [200, 186]], 2, seed), 1, 0.5, seed);
			const s = recognizeShape(pts);
			expect(s?.kind).toBe("arrow");
			const a = s as Extract<ShapeSpec, { kind: "arrow" }>;
			closePt(a.b, [220, 200], 4);
			expect(a.head).toBeGreaterThan(10);
			expect(a.head).toBeLessThan(40);
		}
	});

	it("arrow with a two-barb head (tip → barb → tip → barb)", () => {
		const pts = noisy(along([[0, 0], [150, 150], [130, 148], [150, 150], [148, 130]], 2), 0.8, 0.4);
		expect(recognizeShape(pts)?.kind).toBe("arrow");
	});

	it("axis-aligned rectangle", () => {
		for (const seed of [1, 2, 3, 4]) {
			const s = recognizeShape(noisy(rectPath(50, 40, 220, 120, 0.3), 2, 0.7, seed));
			expect(s?.kind).toBe("rectangle");
			const v = (s as Extract<ShapeSpec, { kind: "rectangle" }>).vertices;
			const xs = v.map((p) => p[0]).sort((a, b) => a - b);
			const ys = v.map((p) => p[1]).sort((a, b) => a - b);
			// Snapped to the axes: two distinct x and two distinct y values.
			close(xs[0], xs[1], 1e-6);
			close(ys[2], ys[3], 1e-6);
			close(xs[0], 50, 4);
			close(xs[3], 270, 4);
			close(ys[0], 40, 4);
			close(ys[3], 160, 4);
		}
	});

	it("rotated rectangle keeps its rotation", () => {
		const pts = noisy(rotateAll(rectPath(100, 100, 200, 100, 0.5), 25, [200, 150]), 1.5, 0.6);
		const s = recognizeShape(pts);
		expect(s?.kind).toBe("rectangle");
		const [a, b] = (s as Extract<ShapeSpec, { kind: "rectangle" }>).vertices;
		let ang = (Math.atan2(b[1] - a[1], b[0] - a[0]) * 180) / Math.PI;
		ang = ((ang % 90) + 90) % 90; // edge direction modulo 90°
		close(ang, 25, 4);
	});

	it("square drawn starting at a corner, without overshoot", () => {
		const pts = noisy(along([[0, 0], [100, 0], [100, 100], [0, 100], [0, 3]]), 1.2, 0.5, 9);
		expect(recognizeShape(pts)?.kind).toBe("rectangle");
	});

	it("triangle", () => {
		for (const seed of [1, 2, 3]) {
			const pts = noisy(along([[100, 20], [190, 170], [10, 170], [98, 24]], 2, seed), 1.5, 0.6, seed);
			const s = recognizeShape(pts);
			expect(s?.kind).toBe("triangle");
			const v = (s as Extract<ShapeSpec, { kind: "triangle" }>).vertices;
			expect(v).toHaveLength(3);
			const want: XY[] = [[100, 20], [190, 170], [10, 170]];
			for (const w of want) expect(Math.min(...v.map((p) => Math.hypot(p[0] - w[0], p[1] - w[1])))).toBeLessThan(8);
		}
	});

	it("pentagon and hexagon → polygon with the right vertex count", () => {
		for (const sides of [5, 6]) {
			const v: XY[] = [];
			for (let i = 0; i <= sides; i++) {
				const t = (i / sides) * 2 * Math.PI - Math.PI / 2;
				v.push([200 + 100 * Math.cos(t), 200 + 100 * Math.sin(t)]);
			}
			const s = recognizeShape(noisy(along(v), 1.2, 0.5, sides));
			expect(s?.kind).toBe("polygon");
			expect((s as Extract<ShapeSpec, { kind: "polygon" }>).vertices).toHaveLength(sides);
		}
	});

	it("circle", () => {
		for (const seed of [1, 2, 3, 4]) {
			const s = recognizeShape(noisy(ellipsePath(150, 150, 80, 76), 2.5, 0.7, seed));
			expect(s?.kind).toBe("circle");
			const c = s as Extract<ShapeSpec, { kind: "circle" }>;
			close(c.cx, 150, 5);
			close(c.cy, 150, 5);
			close(c.rx, 78, 6);
			expect(c.rx).toBe(c.ry);
		}
	});

	it("ellipse (axis-aligned and rotated)", () => {
		const s = recognizeShape(noisy(ellipsePath(150, 100, 120, 50), 2, 0.6)) as Extract<ShapeSpec, { kind: "ellipse" }>;
		expect(s.kind).toBe("ellipse");
		close(s.rx, 120, 8);
		close(s.ry, 50, 6);
		expect(s.rot).toBe(0);
		const r = recognizeShape(noisy(ellipsePath(150, 100, 120, 50, 35), 2, 0.6)) as Extract<ShapeSpec, { kind: "ellipse" }>;
		expect(r.kind).toBe("ellipse");
		close((r.rot * 180) / Math.PI, 35, 5);
	});

	it("tall ellipse is expressed with rot 0 and rx < ry", () => {
		const s = recognizeShape(noisy(ellipsePath(100, 200, 40, 110), 1.5, 0.5)) as Extract<ShapeSpec, { kind: "ellipse" }>;
		expect(s.kind).toBe("ellipse");
		expect(s.rot).toBe(0);
		expect(s.rx).toBeLessThan(s.ry);
	});

	it("open polyline with clear corners (zigzag / L)", () => {
		const z = recognizeShape(noisy(along([[0, 0], [120, 0], [0, 90], [120, 90]]), 1, 0.4));
		expect(z?.kind).toBe("polyline");
		expect((z as Extract<ShapeSpec, { kind: "polyline" }>).vertices).toHaveLength(4);
		const l = recognizeShape(noisy(along([[0, 0], [0, 150], [140, 150]]), 1, 0.4));
		expect(l?.kind).toBe("polyline");
	});

	it("ignores the pressure field and accepts [x,y,p] points", () => {
		const pts = along([[10, 10], [210, 90]]).map(([x, y]) => [x, y, 0.4]);
		expect(recognizeShape(pts)?.kind).toBe("line");
	});
});

describe("recognizeShape — negatives (must NOT snap)", () => {
	it("cursive handwriting", () => {
		for (const seed of [1, 2, 3, 4, 5, 6]) {
			expect(recognizeShape(noisy(cursive(0, 100, 5, 18, seed), 0.8, 0.4, seed))).toBeNull();
		}
	});

	it("printed m and mmm", () => {
		expect(recognizeShape(noisy(letterM(0, 100), 0.6, 0.3))).toBeNull();
		const mmm = [...letterM(0, 100), ...letterM(28, 100), ...letterM(56, 100)];
		expect(recognizeShape(noisy(mmm, 0.6, 0.3))).toBeNull();
	});

	it("spiral (S-curves and arcs snap since the graph-curves change; see below)", () => {
		const spiral = curve((t) => [200 + 6 * t * Math.cos(t), 200 + 6 * t * Math.sin(t)], 1, 18, 400);
		expect(recognizeShape(noisy(spiral, 0.8, 0.4))).toBeNull();
	});

	it("figure eight", () => {
		const eight = curve((t) => [100 + 40 * Math.sin(2 * t), 100 + 80 * Math.sin(t)], 0.1, 2 * Math.PI + 0.1);
		expect(recognizeShape(noisy(eight, 0.8, 0.4))).toBeNull();
	});

	it("tiny strokes and dots", () => {
		expect(recognizeShape([[0, 0]])).toBeNull();
		expect(recognizeShape([[0, 0], [3, 2], [5, 5]])).toBeNull();
		expect(recognizeShape(along([[0, 0], [8, 6]]))).toBeNull();
	});

	it("a very wobbly 'circle' (lumpy blob) is not forced into a shape", () => {
		const blob = curve((t) => {
			const r = 80 + 22 * Math.sin(3 * t) + 12 * Math.sin(7 * t);
			return [150 + r * Math.cos(t), 150 + r * Math.sin(t)];
		}, 0, 2 * Math.PI * 1.02, 300);
		expect(recognizeShape(blob)).toBeNull();
	});
});

describe("findCorners / resample", () => {
	it("resample gives uniform spacing and keeps the ends", () => {
		const r = resample([[0, 0], [10, 0], [10, 10]], 21);
		expect(r).toHaveLength(21);
		expect(r[0]).toEqual([0, 0]);
		expect(r[20]).toEqual([10, 10]);
		for (let i = 1; i < r.length; i++) close(Math.hypot(r[i][0] - r[i - 1][0], r[i][1] - r[i - 1][1]), 1, 1e-9);
	});

	it("a circle has no corners, a square has four", () => {
		const circ = resample(curve((t) => [100 * Math.cos(t), 100 * Math.sin(t)], 0, 2 * Math.PI), 120).slice(0, -1);
		expect(findCorners(circ, true)).toHaveLength(0);
		const sq = resample(along([[0, 0], [100, 0], [100, 100], [0, 100], [0, 0]]), 121).slice(0, -1);
		expect(findCorners(sq, true)).toHaveLength(4);
	});
});

describe("shapeToPoints", () => {
	it("densifies a line with exact ends and small spacing", () => {
		const p = shapeToPoints({ kind: "line", a: [0, 0], b: [30, 40] }, 3);
		expect(p[0]).toEqual([0, 0]);
		closePt(p[p.length - 1], [30, 40], 1e-9);
		for (let i = 1; i < p.length; i++) expect(Math.hypot(p[i][0] - p[i - 1][0], p[i][1] - p[i - 1][1])).toBeLessThanOrEqual(3 + 1e-9);
	});

	it("closes polygons and ellipses", () => {
		const r = shapeToPoints({ kind: "rectangle", vertices: [[0, 0], [10, 0], [10, 5], [0, 5]] });
		closePt(r[r.length - 1], r[0], 1e-9);
		const e = shapeToPoints({ kind: "ellipse", cx: 0, cy: 0, rx: 50, ry: 20, rot: 0 });
		closePt(e[e.length - 1], e[0], 1e-9);
		for (const [x, y] of e) close((x / 50) ** 2 + (y / 20) ** 2, 1, 1e-9);
	});

	it("an arrow is one path through both barbs", () => {
		const spec = { kind: "arrow" as const, a: [0, 0] as XY, b: [100, 0] as XY, head: 20 };
		const p = shapeToPoints(spec);
		const [h1, h2] = arrowBarbs(spec.a, spec.b, spec.head);
		expect(p.some((q) => Math.hypot(q[0] - h1[0], q[1] - h1[1]) < 1e-9)).toBe(true);
		closePt(p[p.length - 1], h2, 1e-9);
		// Barbs point backwards.
		expect(h1[0]).toBeLessThan(100);
		expect(h2[0]).toBeLessThan(100);
	});
});

describe("adjustShape (pen still down after the snap)", () => {
	it("line: the end under the pen follows it, the start stays", () => {
		const s = adjustShape({ kind: "line", a: [0, 0], b: [100, 0] }, [100, 0], [80, 60]) as Extract<ShapeSpec, { kind: "line" }>;
		expect(s.a).toEqual([0, 0]);
		closePt(s.b, [80, 60], 1e-9);
	});

	it("arrow keeps its head length", () => {
		const s = adjustShape({ kind: "arrow", a: [0, 0], b: [100, 0], head: 15 }, [101, 1], [0, 200]);
		expect(s).toMatchObject({ kind: "arrow", a: [0, 0], head: 15 });
		closePt((s as Extract<ShapeSpec, { kind: "arrow" }>).b, [-1, 199], 1e-9);
	});

	it("rectangle scales relative to the opposite corner (aspect may change)", () => {
		const rect: ShapeSpec = { kind: "rectangle", vertices: [[0, 0], [100, 0], [100, 50], [0, 50]] };
		const s = adjustShape(rect, [100, 50], [200, 60]) as Extract<ShapeSpec, { kind: "rectangle" }>;
		closePt(s.vertices[0], [0, 0], 1e-9);
		closePt(s.vertices[2], [200, 60], 1e-9);
	});

	it("rotated rectangle stays rectangular", () => {
		const v = rotateAll([[0, 0], [100, 0], [100, 50], [0, 50]], 30, [0, 0]);
		const s = adjustShape({ kind: "rectangle", vertices: v }, v[2], [v[2][0] + 30, v[2][1] + 10]) as Extract<ShapeSpec, { kind: "rectangle" }>;
		const w = s.vertices;
		const dot = (w[1][0] - w[0][0]) * (w[3][0] - w[0][0]) + (w[1][1] - w[0][1]) * (w[3][1] - w[0][1]);
		close(dot, 0, 1e-6);
		closePt(w[0], v[0], 1e-9);
	});

	it("circle scales uniformly, ellipse changes aspect", () => {
		const c = adjustShape({ kind: "circle", cx: 50, cy: 50, rx: 50, ry: 50, rot: 0 }, [100, 100], [150, 110]) as Extract<ShapeSpec, { kind: "circle" }>;
		close(c.rx, c.ry, 1e-9);
		close(c.rx, 75, 1e-9);
		const e = adjustShape({ kind: "ellipse", cx: 50, cy: 50, rx: 50, ry: 25, rot: 0 }, [100, 75], [200, 75]) as Extract<ShapeSpec, { kind: "ellipse" }>;
		close(e.rx, 100, 1e-9);
		close(e.ry, 25, 1e-9);
		close(e.cx, 100, 1e-9);
	});

	it("never collapses to zero size", () => {
		const s = adjustShape({ kind: "triangle", vertices: [[0, 0], [100, 0], [50, 80]] }, [100, 80], [0, 0]) as Extract<ShapeSpec, { kind: "triangle" }>;
		const xs = s.vertices.map((p) => p[0]);
		expect(Math.max(...xs) - Math.min(...xs)).toBeGreaterThan(1);
	});

	it("does not mutate the input spec", () => {
		const rect: ShapeSpec = { kind: "rectangle", vertices: [[0, 0], [100, 0], [100, 50], [0, 50]] };
		const copy = JSON.stringify(rect);
		adjustShape(rect, [100, 50], [10, 10]);
		expect(JSON.stringify(rect)).toBe(copy);
	});
});

describe("printed w", () => {
	it("a held printed 'w' is a polyline at most (never a closed shape)", () => {
		const s = recognizeShape(noisy(letterW(0, 100), 0.5, 0.3));
		expect(s === null || s.kind === "polyline").toBe(true);
	});
});

describe("draw and hold: realistic hand-drawn lines (A3 #8)", () => {
	const cases: [XY, XY][] = [
		[[10, 100], [310, 100]], // horizontal
		[[10, 10], [210, 90]], // angled
		[[50, 20], [52, 260]], // vertical
		[[0, 0], [120, 3]], // short, nearly horizontal
		[[300, 40], [40, 200]], // right to left
		[[0, 0], [60, 45]], // short angled
	];

	it("a straight stroke with bow, jitter, varying density, a settling hook and hold drift → line", () => {
		for (const [a, b] of cases) {
			for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
				const s = recognizeShape(handStroke(a, b, seed));
				expect(s?.kind, `${JSON.stringify([a, b])} seed ${seed}`).toBe("line");
				const l = s as Extract<ShapeSpec, { kind: "line" }>;
				const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
				closePt(l.a, a, Math.max(4, 0.03 * len));
				closePt(l.b, b, Math.max(6, 0.05 * len));
			}
		}
	});

	it("tolerates a lot of hold drift and a bigger hook", () => {
		for (const seed of [1, 2, 3, 4, 5]) {
			const pts = handStroke([20, 50], [260, 70], seed, { holdPoints: 120, holdDrift: 2, hook: 6 });
			expect(recognizeShape(pts)?.kind).toBe("line");
		}
	});

	it("a visibly curved stroke (~15% bow) is not a line", () => {
		for (const seed of [1, 2, 3]) {
			const s = recognizeShape(handStroke([0, 100], [200, 100], seed, { bow: 0.15 }));
			expect(s?.kind).not.toBe("line");
		}
	});
});

describe("draw and hold: arrows drawn the user's way (A3 #9)", () => {
	type Arrow = Extract<ShapeSpec, { kind: "arrow" }>;
	const expectArrow = (s: ShapeSpec | null, a: XY, tip: XY, msg: string) => {
		expect(s?.kind, msg).toBe("arrow");
		const ar = s as Arrow;
		const len = Math.hypot(tip[0] - a[0], tip[1] - a[1]);
		closePt(ar.a, a, Math.max(5, 0.04 * len));
		closePt(ar.b, tip, 7);
		expect(ar.head).toBeGreaterThan(8);
		expect(ar.head).toBeLessThanOrEqual(0.4 * len + 1e-9);
	};
	const shafts: [XY, XY][] = [
		[[20, 200], [240, 200]],
		[[30, 30], [200, 170]],
		[[200, 300], [210, 60]],
		[[300, 100], [80, 140]],
	];

	it("shaft → barb → back → other barb → back, hold", () => {
		for (const [a, tip] of shafts) {
			for (const seed of [1, 2, 3, 4, 5]) {
				const barbs: [number, number][] = [
					[25 + 4 * seed, 18 + 3 * seed],
					[-(30 + 2 * seed), 22 + 2 * seed],
				];
				expectArrow(recognizeShape(handArrow(a, tip, barbs, seed)), a, tip, `${JSON.stringify([a, tip])} seed ${seed}`);
			}
		}
	});

	it("shaft → one barb → back to the tip, hold", () => {
		for (const [a, tip] of shafts) {
			for (const seed of [1, 2, 3, 4]) {
				const s = recognizeShape(handArrow(a, tip, [[(seed % 2 ? 1 : -1) * 35, 25]], seed));
				expectArrow(s, a, tip, `${JSON.stringify([a, tip])} seed ${seed}`);
			}
		}
	});

	it("simpler styles still work: shaft → hook, and shaft → barb → back → barb (no final return)", () => {
		for (const seed of [1, 2, 3]) {
			const hook = handArrow([20, 200], [220, 200], [[35, 24]], seed, { returnLast: false });
			expectArrow(recognizeShape(hook), [20, 200], [220, 200], `hook seed ${seed}`);
			const two = handArrow([0, 0], [150, 150], [[30, 22], [-30, 22]], seed, { returnLast: false });
			expectArrow(recognizeShape(two), [0, 0], [150, 150], `two seed ${seed}`);
		}
	});

	it("the snapped arrow has two symmetric barbs at the tip", () => {
		const s = recognizeShape(handArrow([20, 200], [240, 200], [[22, 20], [-40, 30]], 1)) as Arrow;
		expect(s.kind).toBe("arrow");
		const [h1, h2] = arrowBarbs(s.a, s.b, s.head);
		close(Math.hypot(h1[0] - s.b[0], h1[1] - s.b[1]), Math.hypot(h2[0] - s.b[0], h2[1] - s.b[1]), 1e-9);
		const proj = (p: XY) => (p[0] - s.b[0]) * (s.a[0] - s.b[0]) + (p[1] - s.b[1]) * (s.a[1] - s.b[1]);
		close(proj(h1), proj(h2), 1e-6);
	});
});

describe("draw and hold: arrow negatives (A3 #9)", () => {
	it("a 'V' is not an arrow", () => {
		for (const seed of [1, 2, 3]) {
			const v = noisy(along([[0, 0], [40, 100], [80, 0]], 2, seed), 0.8, 0.4, seed);
			expect(recognizeShape(v)?.kind).not.toBe("arrow");
			// Narrow V with a shorter second arm.
			const v2 = noisy(along([[0, 0], [30, 100], [55, 30]], 2, seed), 0.8, 0.4, seed);
			expect(recognizeShape(v2)?.kind).not.toBe("arrow");
		}
	});

	it("a 'Y' (any stroke order) is not an arrow", () => {
		const TL: XY = [0, 0];
		const TR: XY = [70, 0];
		const C: XY = [35, 50];
		const B: XY = [35, 120];
		const orders: XY[][] = [
			[TL, C, TR, C, B], // left arm, right arm, stem
			[B, C, TL, C, TR], // stem up, then arms (barbs pointing forward)
			[B, C, TL, C, TR, C], // stem up, both arms, back to the junction
			[TL, C, B, C, TR], // left arm, stem down and back, right arm
		];
		for (const [i, o] of orders.entries()) {
			for (const seed of [1, 2]) {
				const pts = noisy(along(o, 2, seed), 0.8, 0.4, seed);
				expect(recognizeShape(pts)?.kind, `order ${i} seed ${seed}`).not.toBe("arrow");
			}
		}
	});

	it("a check mark is not an arrow", () => {
		for (const seed of [1, 2, 3]) {
			const check = noisy(along([[0, 60], [30, 100], [110, 0]], 2, seed), 0.8, 0.4, seed);
			expect(recognizeShape(check)?.kind).not.toBe("arrow");
			const small = noisy(along([[0, 12], [6, 20], [24, 0]], 1, seed), 0.4, 0.2, seed);
			expect(recognizeShape(small)?.kind).not.toBe("arrow");
		}
	});

	it("handwriting held at the end does not become an arrow (or any shape)", () => {
		for (const seed of [1, 2, 3, 4]) {
			const w = noisy(cursive(0, 100, 5, 18, seed), 0.8, 0.4, seed);
			const last = w[w.length - 1];
			for (let i = 0; i < 30; i++) w.push([last[0] + Math.sin(i) * 1.2, last[1] + Math.cos(i * 1.7) * 1.2]);
			expect(recognizeShape(w)).toBeNull();
		}
		expect(recognizeShape(noisy(letterM(0, 100), 0.6, 0.3))?.kind).not.toBe("arrow");
		expect(recognizeShape(noisy(letterW(0, 100), 0.5, 0.3))?.kind).not.toBe("arrow");
	});
});

describe("hold delay", () => {
	it("SNAP_HOLD_MS defaults to 0.5 s", () => {
		expect(SNAP_HOLD_MS).toBe(500);
	});
});

describe("draw and hold: right angles / graph axes", () => {
	type Poly = Extract<ShapeSpec, { kind: "polyline" }>;
	const angleAt = (v: readonly XY[]) => {
		const [a, b, c] = v;
		const ux = a[0] - b[0];
		const uy = a[1] - b[1];
		const wx = c[0] - b[0];
		const wy = c[1] - b[1];
		return Math.acos((ux * wx + uy * wy) / (Math.hypot(ux, uy) * Math.hypot(wx, wy))) / (Math.PI / 180);
	};
	const expectRight = (s: ShapeSpec | null, msg: string): Poly => {
		expect(s?.kind, msg).toBe("polyline");
		const p = s as Poly;
		expect(p.vertices, msg).toHaveLength(3);
		expect(p.rightAngle, msg).toBe(true);
		const [a, b, c] = p.vertices;
		// Exactly perpendicular legs.
		const dot = (a[0] - b[0]) * (c[0] - b[0]) + (a[1] - b[1]) * (c[1] - b[1]);
		close(dot / (Math.hypot(a[0] - b[0], a[1] - b[1]) * Math.hypot(c[0] - b[0], c[1] - b[1])), 0, 1e-9);
		return p;
	};
	const expectAxisAligned = (p: Poly, msg: string) => {
		const [a, b, c] = p.vertices;
		for (const [u, v] of [
			[a, b],
			[b, c],
		] as const) {
			const horiz = Math.abs(u[1] - v[1]) <= 1e-9;
			const vert = Math.abs(u[0] - v[0]) <= 1e-9;
			expect(horiz || vert, `${msg}: leg ${JSON.stringify([u, v])}`).toBe(true);
		}
	};
	// One stroke, start → corner → end, in all four orientations and both drawing directions.
	const Ls: [XY, XY, XY][] = [
		[[0, 0], [0, 150], [140, 150]], // └ down, then right (graph axes)
		[[140, 150], [0, 150], [0, 0]], // └ drawn the other way
		[[140, 0], [140, 150], [0, 150]], // ┘
		[[0, 150], [0, 0], [140, 0]], // ┌ up, then right
		[[0, 0], [140, 0], [140, 150]], // ┐ right, then down
		[[0, 0], [0, 60], [200, 60]], // short vertical leg (ratio ~3.3)
		[[0, 0], [0, 220], [70, 220]], // short horizontal leg (ratio ~3.1)
		[[0, 0], [0, 50], [50, 50]], // small
	];

	it("hand-drawn L's (jitter, overshoot at the corner, hold tail) → exact, axis-aligned right angle", () => {
		for (const [a, c, b] of Ls) {
			for (const seed of [1, 2, 3, 4, 5, 6]) {
				const msg = `${JSON.stringify([a, c, b])} seed ${seed}`;
				const pts = handPolyline([a, c, b], seed, { overshoot: 4 });
				const p = expectRight(recognizeShape(pts), msg);
				expectAxisAligned(p, msg);
				const size = Math.max(Math.hypot(c[0] - a[0], c[1] - a[1]), Math.hypot(b[0] - c[0], b[1] - c[1]));
				// The overshoot (up to 6 px past the corner) must not move the corner.
				closePt(p.vertices[1], c, Math.max(5, 0.04 * size));
				closePt(p.vertices[0], a, Math.max(6, 0.06 * size));
				closePt(p.vertices[2], b, Math.max(7, 0.06 * size));
			}
		}
	});

	it("an L tilted up to ~8° snaps to the axes; tilted 25° keeps its rotation (exact 90°)", () => {
		for (const deg of [-8, -5, 4, 8]) {
			for (const seed of [1, 2, 3]) {
				const v = rotateAll([[0, 0], [0, 150], [140, 150]], deg, [70, 75]);
				const p = expectRight(recognizeShape(handPolyline(v, seed, { overshoot: 3 })), `tilt ${deg} seed ${seed}`);
				expectAxisAligned(p, `tilt ${deg} seed ${seed}`);
			}
		}
		for (const seed of [1, 2, 3]) {
			const v = rotateAll([[0, 0], [0, 150], [140, 150]], 25, [70, 75]);
			const p = expectRight(recognizeShape(handPolyline(v, seed)), `25° seed ${seed}`);
			const [a, b] = p.vertices;
			const ang = (Math.atan2(b[1] - a[1], b[0] - a[0]) * 180) / Math.PI;
			close(ang, 90 + 25, 5);
		}
	});

	it("corners of ~78°..102° become exactly 90°; 60° and 125° keep their angle", () => {
		const corner: XY = [100, 200];
		const leg = (deg: number): XY => [corner[0] + 150 * Math.cos((deg * Math.PI) / 180), corner[1] - 150 * Math.sin((deg * Math.PI) / 180)];
		for (const open of [78, 84, 96, 102]) {
			for (const seed of [1, 2, 3]) {
				// First leg straight up from the corner, second leg `open`° away from it.
				const pts = handPolyline([leg(90), corner, leg(90 - open)], seed);
				expectRight(recognizeShape(pts), `${open}° seed ${seed}`);
			}
		}
		for (const open of [60, 125]) {
			for (const seed of [1, 2, 3]) {
				const s = recognizeShape(handPolyline([leg(90), corner, leg(90 - open)], seed));
				expect(s?.kind, `${open}° seed ${seed}`).toBe("polyline");
				const p = s as Poly;
				expect(p.rightAngle).toBeUndefined();
				close(angleAt(p.vertices), open, 8);
			}
		}
	});

	it("a 'V' with a ~90° opening becomes a symmetric right angle (rotated 45°), never an arrow", () => {
		for (const seed of [1, 2, 3]) {
			const s = recognizeShape(handPolyline([[0, 0], [80, 80], [160, 0]], seed));
			const p = expectRight(s, `V seed ${seed}`);
			const [a, b, c] = p.vertices;
			close(Math.abs(Math.atan2(a[1] - b[1], a[0] - b[0]) * 180) / Math.PI, 135, 6);
			close(Math.abs(Math.atan2(c[1] - b[1], c[0] - b[0]) * 180) / Math.PI, 45, 6);
		}
	});

	it("zigzags and longer polylines are unaffected (no rightAngle flag)", () => {
		const z = recognizeShape(noisy(along([[0, 0], [120, 0], [120, 90], [240, 90]]), 1, 0.4)) as Poly;
		expect(z.kind).toBe("polyline");
		expect(z.vertices).toHaveLength(4);
		expect(z.rightAngle).toBeUndefined();
	});

	it("adjust while the pen is down keeps it a right angle (axis-aligned and rotated)", () => {
		const spec: ShapeSpec = { kind: "polyline", vertices: [[0, 0], [0, 150], [140, 150]], rightAngle: true };
		const adj = adjustShape(spec, [140, 150], [200, 120]) as Poly;
		expectRight(adj, "axis-aligned");
		expectAxisAligned(adj, "axis-aligned");
		expect(adj.rightAngle).toBe(true);
		closePt(adj.vertices[0], [0, 0], 1e-9); // anchor = bbox corner opposite the pen
		closePt(adj.vertices[2], [200, 120], 1e-9);
		const th = (30 * Math.PI) / 180;
		const rot = (p: XY): XY => [p[0] * Math.cos(th) - p[1] * Math.sin(th), p[0] * Math.sin(th) + p[1] * Math.cos(th)];
		const rv: XY[] = [rot([0, 0]), rot([0, 150]), rot([140, 150])];
		const rspec: ShapeSpec = { kind: "polyline", vertices: rv, rightAngle: true };
		const radj = adjustShape(rspec, rv[2], [rv[2][0] + 40, rv[2][1] - 25]) as Poly;
		expectRight(radj, "rotated");
	});
});

describe("axis snap for plain lines", () => {
	type Line = Extract<ShapeSpec, { kind: "line" }>;
	const tan = (deg: number) => Math.tan((deg * Math.PI) / 180);
	it("lines within 5° of horizontal/vertical become exact; 7.5° and diagonals keep their angle", () => {
		for (const seed of [1, 2, 3]) {
			const h = recognizeShape(handStroke([0, 100], [250, 100 + 250 * tan(4.5)], seed)) as Line;
			expect(h.kind).toBe("line");
			close(h.b[1], h.a[1], 1e-9);
			const v = recognizeShape(handStroke([50, 0], [50 + 250 * tan(4.5), 250], seed)) as Line;
			expect(v.kind).toBe("line");
			close(v.b[0], v.a[0], 1e-9);
			const t = recognizeShape(handStroke([0, 100], [250, 100 + 250 * tan(7.5)], seed)) as Line;
			expect(t.kind).toBe("line");
			expect(Math.abs(t.b[1] - t.a[1])).toBeGreaterThan(10);
			const d = recognizeShape(handStroke([0, 0], [200, 200], seed)) as Line;
			close((Math.atan2(d.b[1] - d.a[1], d.b[0] - d.a[0]) * 180) / Math.PI, 45, 3);
		}
	});
});

describe("draw and hold: curves on graphs (arcs, parabolas, smooth curves)", () => {
	type Arc = Extract<ShapeSpec, { kind: "arc" }>;
	const DEGR = Math.PI / 180;
	/** Every output point lies within `tol` of the true curve and the output covers it (ends within `endTol`). */
	const expectFollows = (s: ShapeSpec, f: (t: number) => XY, tol: number, endTol: number, msg: string) => {
		const truth: XY[] = [];
		for (let i = 0; i <= 600; i++) truth.push(f(i / 600));
		const out = shapeToPoints(s);
		const near = (p: XY, set: readonly XY[]) => Math.min(...set.map((q) => Math.hypot(p[0] - q[0], p[1] - q[1])));
		let worst = 0;
		for (const p of out) worst = Math.max(worst, near(p, truth));
		expect(worst, `${msg}: max deviation`).toBeLessThanOrEqual(tol);
		expect(near(truth[0], out), `${msg}: start covered`).toBeLessThanOrEqual(endTol);
		expect(near(truth[600], out), `${msg}: end covered`).toBeLessThanOrEqual(endTol);
		// The start of the snapped curve is where the pen started.
		expect(Math.hypot(out[0][0] - truth[0][0], out[0][1] - truth[0][1]), `${msg}: starts at the start`).toBeLessThanOrEqual(endTol);
	};
	const circ = (cx: number, cy: number, r: number, a0: number, a1: number) => (t: number): XY => {
		const a = (a0 + (a1 - a0) * t) * DEGR;
		return [cx + r * Math.cos(a), cy + r * Math.sin(a)];
	};

	it("arcs (semicircle both ways, quarter, 200°, shallow 70°) → arc with the drawn center, radius and sweep", () => {
		const cases: [number, number, number, number, number][] = [
			[150, 150, 80, 180, 360], // semicircle over the top (y down)
			[150, 150, 80, 0, -180], // the same, drawn the other way
			[100, 100, 120, 90, 0], // quarter circle
			[200, 200, 70, -20, 180], // 200°
			[300, 400, 220, 235, 305], // shallow 70° arc
		];
		for (const [cx, cy, r, a0, a1] of cases) {
			for (const seed of [1, 2, 3, 4]) {
				const msg = `arc ${[cx, cy, r, a0, a1].join(",")} seed ${seed}`;
				const f = circ(cx, cy, r, a0, a1);
				const s = recognizeShape(handCurve(f, seed));
				expect(s?.kind, msg).toBe("arc");
				const arc = s as Arc;
				close(arc.r, r, Math.max(4, 0.06 * r));
				closePt([arc.cx, arc.cy], [cx, cy], Math.max(5, 0.08 * r));
				close(arc.sweep / DEGR, a1 - a0, 10);
				expectFollows(s as ShapeSpec, f, 5, 12, msg);
			}
		}
	});

	it("parabolas: U, ∩, sideways, half, rotated → parabola following the drawn curve", () => {
		const cases: [string, (t: number) => XY][] = [
			["U", (t) => [40 + 200 * t, 60 + 0.01 * (200 * t - 100) ** 2]],
			["∩ right to left", (t) => [240 - 200 * t, 260 - 0.012 * (200 * t - 100) ** 2]],
			["sideways ⊂", (t) => [200 - 0.012 * (200 * t - 100) ** 2, 40 + 200 * t]],
			["half (vertex at the start)", (t) => [50 + 180 * t, 250 - 0.006 * (180 * t) ** 2]],
			["narrow U", (t) => [100 + 100 * t, 50 + 0.025 * (100 * t - 50) ** 2]],
		];
		for (const [name, f] of cases) {
			for (const seed of [1, 2, 3, 4]) {
				const msg = `${name} seed ${seed}`;
				const s = recognizeShape(handCurve(f, seed));
				expect(s?.kind, msg).toBe("parabola");
				expectFollows(s as ShapeSpec, f, 5, 12, msg);
			}
		}
		// Rotated 25°.
		const rot = (p: XY): XY => {
			const c = Math.cos(25 * DEGR);
			const si = Math.sin(25 * DEGR);
			return [200 + (p[0] - 140) * c - (p[1] - 100) * si, 200 + (p[0] - 140) * si + (p[1] - 100) * c];
		};
		const g = (t: number) => rot([40 + 200 * t, 60 + 0.01 * (200 * t - 100) ** 2]);
		for (const seed of [1, 2, 3]) {
			const s = recognizeShape(handCurve(g, seed));
			expect(s?.kind, `rotated seed ${seed}`).toBe("parabola");
			expectFollows(s as ShapeSpec, g, 5, 12, `rotated seed ${seed}`);
		}
	});

	it("an axis-aligned parabola has its axis exactly vertical (control point midway in x)", () => {
		const f = (t: number): XY => [40 + 200 * t, 60 + 0.01 * (200 * t - 100) ** 2];
		const s = recognizeShape(handCurve(f, 1)) as Extract<ShapeSpec, { kind: "parabola" }>;
		expect(s.kind).toBe("parabola");
		// Quadratic Bézier of y = f(x): the control point's x is exactly midway between the ends.
		close(s.c[0], (s.a[0] + s.b[0]) / 2, 1e-9);
	});

	it("smooth graph curves (exponential decay, growth, S-curve, sigmoid) → a clean curve following them", () => {
		const cases: [string, (t: number) => XY][] = [
			["decay", (t) => [40 + 260 * t, 300 - 200 * Math.exp(-(260 * t) / 50)]],
			["growth", (t) => [40 + 220 * t, 300 - 4 * Math.exp((220 * t) / 55)]],
			["sine S", (t) => [100 + 40 * Math.sin(2 * Math.PI * t), 20 + 160 * t]],
			["sigmoid", (t) => [40 + 260 * t, 250 - 180 / (1 + Math.exp(-(260 * t - 130) / 25))]],
		];
		for (const [name, f] of cases) {
			for (const seed of [1, 2, 3, 4]) {
				const msg = `${name} seed ${seed}`;
				const s = recognizeShape(handCurve(f, seed));
				expect(s, msg).not.toBeNull();
				expect(["curve", "parabola", "arc"], msg).toContain(s?.kind);
				expectFollows(s as ShapeSpec, f, 6, 12, msg);
			}
		}
		// The S-shapes cannot be an arc or a parabola.
		for (const seed of [1, 2]) {
			expect(recognizeShape(handCurve(cases[2][1], seed))?.kind).toBe("curve");
			expect(recognizeShape(handCurve(cases[3][1], seed))?.kind).toBe("curve");
		}
	});

	it("near-straight strokes stay lines (line wins over a slight arc)", () => {
		for (const seed of [1, 2, 3, 4, 5, 6]) {
			for (const bow of [0, 0.02, 0.03]) {
				expect(recognizeShape(handStroke([20, 100], [300, 130], seed, { bow }))?.kind, `bow ${bow} seed ${seed}`).toBe("line");
			}
		}
	});

	// Small letters / waves must never become a smooth curve. (A small "n" or a wave can still come
	// out as a zigzag polyline — pre-existing polyline behavior, unchanged here.)
	const CURVES = ["arc", "parabola", "curve"];
	it("small handwritten letters (c, u, n, s, e) held at the end do not become curves", () => {
		const letters: [string, (t: number) => XY][] = [
			["c", circ(100, 100, 9, -50, -310)],
			["u", (t) => [100 + 16 * t, 100 + 18 * Math.sqrt(Math.max(0, 1 - (2 * t - 1) ** 2))]],
			["n", (t) => [100 + 16 * t, 100 - 18 * Math.sin(Math.PI * t)]],
			["s", (t) => [100 - 7 * Math.sin(2 * Math.PI * t), 100 + 20 * t]],
			["e", (t) => {
				const a = t * 1.7 * 2 * Math.PI;
				return [100 + 9 * Math.cos(a) + 6 * t, 100 + 9 * Math.sin(-a)];
			}],
		];
		for (const [name, f] of letters) {
			for (const seed of [1, 2, 3]) {
				const s = recognizeShape(handCurve(f, seed, { hook: 1.5, holdDrift: 1 }));
				expect(CURVES, `${name} seed ${seed}`).not.toContain(s?.kind);
			}
		}
	});

	it("wavy lines, spirals and cursive held at the end do not become curves", () => {
		for (const seed of [1, 2, 3]) {
			const wave = (t: number): XY => [20 + 300 * t, 100 + 25 * Math.sin(6 * Math.PI * t)];
			expect(CURVES, `wave seed ${seed}`).not.toContain(recognizeShape(handCurve(wave, seed))?.kind);
			const w = noisy(cursive(0, 100, 5, 18, seed), 0.8, 0.4, seed);
			const last = w[w.length - 1];
			for (let i = 0; i < 30; i++) w.push([last[0] + Math.sin(i) * 1.2, last[1] + Math.cos(i * 1.7) * 1.2]);
			expect(recognizeShape(w), `cursive seed ${seed}`).toBeNull();
			const spiral = (t: number): XY => {
				const a = 1 + 14 * t;
				return [200 + 7 * a * Math.cos(a), 200 + 7 * a * Math.sin(a)];
			};
			expect(recognizeShape(handCurve(spiral, seed)), `spiral seed ${seed}`).toBeNull();
		}
	});

	it("adjust while the pen is down: curves scale relative to their start; arcs stay circular", () => {
		const f = (t: number): XY => [40 + 200 * t, 300 - 200 * Math.exp(-(200 * t) / 50)];
		const s = recognizeShape(handCurve(f, 1)) as ShapeSpec;
		const pts = shapeToPoints(s);
		const start = pts[0];
		const end = pts[pts.length - 1];
		const adj = adjustShape(s, end, [end[0] + 60, end[1] + 30]);
		const apts = shapeToPoints(adj);
		closePt(apts[0], start, 1e-6);
		closePt(apts[apts.length - 1], [end[0] + 60, end[1] + 30], 1e-6);
		expect(s.kind).not.toBe("arc");

		const arc: ShapeSpec = { kind: "arc", cx: 100, cy: 100, r: 50, start: Math.PI, sweep: Math.PI };
		const ap = shapeToPoints(arc);
		const aEnd = ap[ap.length - 1];
		const moved = adjustShape(arc, aEnd, [aEnd[0] + 50, aEnd[1]]) as Arc;
		expect(moved.kind).toBe("arc");
		close(moved.r, 75, 1e-6);
		close(moved.sweep, Math.PI, 1e-9);
		const mp = shapeToPoints(moved);
		closePt(mp[0], ap[0], 1e-6);
		closePt(mp[mp.length - 1], [aEnd[0] + 50, aEnd[1]], 1e-6);
	});
});
