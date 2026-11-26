import { parseRaw } from "./rawInk";
import { describe, expect, it } from "vitest";
import {
	BLANK_HASH,
	InkFile,
	ParseReport,
	Stroke,
	emptyInk,
	hashLine,
	newId,
	parseInkFile,
	resolveAnchor,
	mergeStrokes,
	penStyleOf,
	serializeInkFile,
	serializeStroke,
	Point,
} from "../src/model";
import { cursive, letterM, letterW, noisy, rng } from "./handdrawn";

const anchorFor = (lines: string[], line: number) => ({ line, hash: hashLine(lines[line]) });

describe("hashLine", () => {
	it("is stable and deterministic", () => {
		expect(hashLine("Hello world")).toBe(hashLine("Hello world"));
		// Pinned value (FNV-1a("abc") = 0x1a47e90b): changing the hash would orphan saved drawings.
		expect(hashLine("abc")).toBe((0x1a47e90b).toString(36));
	});
	it("differs for different text", () => {
		expect(hashLine("line one")).not.toBe(hashLine("line two"));
		expect(hashLine("ab")).not.toBe(hashLine("ba"));
	});
	it("ignores surrounding whitespace", () => {
		expect(hashLine("  text\t ")).toBe(hashLine("text"));
		expect(hashLine("   ")).toBe(BLANK_HASH);
	});
	it("returns a short base36 string", () => {
		const h = hashLine("x".repeat(5000));
		expect(h).toMatch(/^[0-9a-z]{1,7}$/);
	});
});

describe("newId", () => {
	it("produces unique strings", () => {
		const ids = new Set(Array.from({ length: 5000 }, () => newId()));
		expect(ids.size).toBe(5000);
	});
});

describe("penStyleOf", () => {
	it("defaults pens to ballpoint and ignores highlighters", () => {
		expect(penStyleOf({ tool: "pen" })).toBe("ball");
		expect(penStyleOf({ tool: "pen", style: "dotted" })).toBe("dotted");
		expect(penStyleOf({ tool: "pen", style: "bogus" as never })).toBe("ball");
		expect(penStyleOf({ tool: "highlighter", style: "notes" })).toBeUndefined();
	});
});

describe("resolveAnchor", () => {
	const doc = ["# Title", "", "alpha", "beta", "", "gamma", "delta"];

	it("returns the saved line when its hash matches", () => {
		expect(resolveAnchor(doc, anchorFor(doc, 3))).toBe(3);
	});

	it("works with an accessor line source", () => {
		const src = { count: doc.length, get: (i: number) => doc[i] };
		expect(resolveAnchor(src, anchorFor(doc, 5))).toBe(5);
	});

	it("follows a line shifted down by inserted lines", () => {
		const a = anchorFor(doc, 5); // gamma
		const shifted = ["new 1", "new 2", "new 3", ...doc];
		expect(resolveAnchor(shifted, a)).toBe(8);
	});

	it("follows a line shifted up by deleted lines", () => {
		const a = anchorFor(doc, 6); // delta
		const shrunk = doc.slice(3);
		expect(resolveAnchor(shrunk, a)).toBe(3);
	});

	it("prefers the nearest match", () => {
		const d = ["x", "dup", "a", "b", "c", "d", "dup"];
		expect(resolveAnchor(d, { line: 5, hash: hashLine("dup") })).toBe(6);
		expect(resolveAnchor(d, { line: 2, hash: hashLine("dup") })).toBe(1);
	});

	it("prefers below on ties", () => {
		const d = ["dup", "x", "dup"];
		expect(resolveAnchor(d, { line: 1, hash: hashLine("dup") })).toBe(2);
	});

	it("clamps when the line was deleted", () => {
		const a = { line: 4, hash: hashLine("gone forever") };
		expect(resolveAnchor(doc, a)).toBe(4);
		expect(resolveAnchor(["a", "b"], a)).toBe(1);
		expect(resolveAnchor(doc, { line: -3, hash: "zzz" })).toBe(0);
		expect(resolveAnchor(doc, { line: Number.NaN, hash: "zzz" })).toBe(0);
	});

	it("does not search for blank-line anchors", () => {
		const a = { line: 1, hash: BLANK_HASH };
		// Line 1 is now text; nearby blank lines must not "match".
		const d = ["a", "changed", "", "b"];
		expect(resolveAnchor(d, a)).toBe(1);
		// Exact blank match at the same index still resolves.
		expect(resolveAnchor(doc, a)).toBe(1);
	});

	it("ignores blank lines during the search even if hash collides", () => {
		const d = ["a", "b", "   ", "c"];
		expect(resolveAnchor(d, { line: 0, hash: BLANK_HASH + "" })).toBe(0);
		expect(resolveAnchor(d, { line: 1, hash: hashLine("missing") })).toBe(1);
	});

	it("respects the search radius", () => {
		const d = Array.from({ length: 500 }, (_, i) => `line ${i}`);
		const target = { line: 0, hash: hashLine("line 300") };
		expect(resolveAnchor(d, target)).toBe(0); // outside ±200 → clamp
		expect(resolveAnchor(d, { line: 150, hash: hashLine("line 300") })).toBe(300);
		expect(resolveAnchor(d, target, 400)).toBe(300);
	});

	it("handles an empty document", () => {
		expect(resolveAnchor([], { line: 5, hash: "abc" })).toBe(0);
	});
});

const stroke = (over: Partial<Stroke> = {}): Stroke => ({
	id: "s1",
	tool: "pen",
	color: "ink",
	size: 3,
	anchor: { line: 2, hash: "abc" },
	points: [
		[1, 2, 0.5],
		[3.14159, 4.987654, 0.33333],
	],
	...over,
});

describe("serialize / parse", () => {
	it("round-trips and drops transient pos", () => {
		const ink: InkFile = { version: 1, contentWidth: 700, strokes: [stroke({ pos: 42 })] };
		const text = serializeInkFile(ink);
		expect(text).not.toContain("pos");
		const back = parseInkFile(text);
		expect(back.contentWidth).toBe(700);
		expect(back.strokes).toHaveLength(1);
		expect(back.strokes[0].pos).toBeUndefined();
		// v2: 0.1 px quantization; a ballpoint stroke stores no pressure (implied 0.5).
		expect(back.strokes[0].points[1]).toEqual([3.1, 5, 0.5]);
		expect(back.strokes[0].anchor).toEqual({ line: 2, hash: "abc" });
		// Serialization does not mutate the source.
		expect(ink.strokes[0].pos).toBe(42);
	});

	it("never throws on bad input", () => {
		for (const bad of [null, undefined, "", "{", "null", "[]", "42", '"str"', '{"strokes":5}']) {
			expect(parseInkFile(bad as string)).toEqual(emptyInk());
		}
	});

	it("reports malformed files", () => {
		const r: ParseReport = { malformed: false, dropped: 0 };
		parseInkFile("{not json", r);
		expect(r.malformed).toBe(true);
		parseInkFile(serializeInkFile(emptyInk()), r);
		expect(r).toEqual({ malformed: false, dropped: 0 });
	});

	it("repairs and drops invalid strokes", () => {
		const r: ParseReport = { malformed: false, dropped: 0 };
		const ink = parseInkFile(
			JSON.stringify({
				version: 1,
				contentWidth: "wide",
				strokes: [
					null,
					{ id: "a", points: [] },
					{ id: "b", points: [[1, 2]], tool: "laser", size: -1, color: 3, anchor: { line: -2 } },
					{ id: "b", points: [[1, 2, 7], ["x", 1, 1], [5, 6, 0.2]] },
					{ points: [[NaN, 1, 1]] },
				],
			}),
			r,
		);
		expect(r.dropped).toBe(3);
		expect(ink.contentWidth).toBe(0);
		expect(ink.strokes).toHaveLength(2);
		const [b1, b2] = ink.strokes;
		expect(b1).toMatchObject({ id: "b", tool: "pen", color: "ink", anchor: { line: 0, hash: "" } });
		expect(b1.size).toBeGreaterThan(0);
		expect(b1.points).toEqual([[1, 2, 0.5]]);
		expect(b2.id).not.toBe("b"); // duplicate id regenerated
		expect(b2.points).toEqual([
			[1, 2, 1],
			[5, 6, 0.2],
		]);
	});
});

describe("stroke style serialization", () => {
	it("round-trips every pen style", () => {
		for (const style of ["ball", "dotted", "notes"] as const) {
			const back = parseInkFile(serializeInkFile({ version: 1, contentWidth: 0, strokes: [stroke({ style })] }));
			expect(back.strokes[0].style).toBe(style);
		}
	});

	it("loads M1 files (no style) as ballpoint and writes the style back explicitly", () => {
		const m1 =
			'{"version":1,"contentWidth":700,"strokes":[' +
			'{"id":"a","tool":"pen","color":"ink","size":3.5,"anchor":{"line":0,"hash":"x"},"points":[[1,2,0.5]]},' +
			'{"id":"b","tool":"highlighter","color":"#facc15","size":10.5,"anchor":{"line":1,"hash":"y"},"points":[[1,2,0.5]]}]}';
		const ink = parseInkFile(m1);
		expect(ink.strokes[0].style).toBe("ball");
		expect(ink.strokes[0].size).toBe(3.5); // old sizes are kept as-is
		expect(ink.strokes[1].style).toBeUndefined();
		const out = parseRaw(serializeInkFile(ink));
		expect(out.strokes[0].style).toBe("ball");
		expect("style" in out.strokes[1]).toBe(false);
		expect(out.version).toBe(2);
	});

	it("unknown styles (from a newer version) fall back to ballpoint; highlighters drop style", () => {
		const ink = parseInkFile(
			JSON.stringify({
				version: 1,
				contentWidth: 0,
				strokes: [
					{ id: "a", tool: "pen", style: "fountain", points: [[0, 0, 0.5]] },
					{ id: "b", tool: "highlighter", style: "dotted", points: [[0, 0, 0.5]] },
				],
			}),
		);
		expect(ink.strokes[0].style).toBe("ball");
		expect(ink.strokes[1].style).toBeUndefined();
	});

	it("serializes with a stable key order (style after size)", () => {
		const text = serializeInkFile({ version: 1, contentWidth: 0, strokes: [stroke({ style: "dotted" })] });
		expect(text).toContain('"size":3,"style":"dotted","anchor"');
	});
});

describe("mergeStrokes", () => {
	const s = (id: string, x = 0): Stroke => stroke({ id, points: [[x, 0, 0.5]] });

	it("with no local changes the result is exactly the remote list", () => {
		const base = [s("a"), s("b")];
		const remote = [s("b"), s("c"), s("a")];
		const out = mergeStrokes(base, base, remote);
		expect(out.map((x) => x.id)).toEqual(["b", "c", "a"]);
	});

	it("reuses local objects for unchanged strokes, takes remote for changed ones", () => {
		const la = s("a", 1);
		const lb = s("b", 2);
		const ra = s("a", 1);
		const rb = s("b", 99);
		const out = mergeStrokes([la, lb], [la, lb], [ra, rb]);
		expect(out[0]).toBe(la);
		expect(out[1]).toBe(rb);
	});

	it("ignores anchor-only differences (anchors are re-derived from live positions)", () => {
		const la = s("a");
		const ra = { ...s("a"), anchor: { line: 9, hash: "zzz" } };
		expect(mergeStrokes([la], [la], [ra])[0]).toBe(la);
	});

	it("keeps local additions and local deletions; applies remote additions and deletions", () => {
		const base = [s("a"), s("b"), s("c")];
		// Local: erased b, drew d.  Remote: erased c, drew e.
		const local = [base[0], base[2], s("d")];
		const remote = [s("a"), s("b"), s("e")];
		const out = mergeStrokes(base, local, remote);
		expect(out.map((x) => x.id)).toEqual(["a", "e", "d"]);
	});

	it("remote deletion of a stroke we never saved does not delete it", () => {
		const out = mergeStrokes([], [s("new")], []);
		expect(out.map((x) => x.id)).toEqual(["new"]);
	});
});

describe("shape metadata", () => {
	const base = { id: "s", tool: "pen", color: "ink", size: 1.6, style: "ball", anchor: { line: 0, hash: "x" }, points: [[0, 0, 0.5], [10, 0, 0.5]] };

	it("round-trips a valid shape kind", () => {
		const ink = parseInkFile(JSON.stringify({ version: 1, contentWidth: 700, strokes: [{ ...base, shape: "rectangle" }] }));
		expect(ink.strokes[0].shape).toBe("rectangle");
		const again = parseInkFile(serializeInkFile(ink));
		expect(again.strokes[0].shape).toBe("rectangle");
	});

	it("round-trips the curve kinds (arc, parabola, curve)", () => {
		for (const shape of ["arc", "parabola", "curve"]) {
			const ink = parseInkFile(JSON.stringify({ version: 1, contentWidth: 700, strokes: [{ ...base, shape }] }));
			expect(parseInkFile(serializeInkFile(ink)).strokes[0].shape).toBe(shape);
		}
	});

	it("drops unknown shape kinds and omits the key for freehand strokes", () => {
		const ink = parseInkFile(JSON.stringify({ version: 1, contentWidth: 700, strokes: [{ ...base, shape: "blob" }, base] }));
		expect(ink.strokes[0].shape).toBeUndefined();
		expect(serializeInkFile(ink)).not.toContain("shape");
	});

	it("a shape change is a content change for merging", () => {
		const s = parseInkFile(JSON.stringify({ version: 1, contentWidth: 1, strokes: [base] })).strokes[0];
		const withShape = { ...s, shape: "line" as const };
		expect(mergeStrokes([s], [s], [withShape])[0]).toBe(withShape);
	});
});

// ---------------------------------------------------------------------------------------------
// Stage G — compact (v2) ink files
// ---------------------------------------------------------------------------------------------

/** v1 serializer as shipped before Stage G (2-digit coords, 3-digit pressure, `[x,y,p][]`). */
function serializeV1(ink: InkFile): string {
	const r = (v: number, d: number) => Math.round(v * 10 ** d) / 10 ** d;
	return JSON.stringify({
		version: 1,
		contentWidth: r(ink.contentWidth || 0, 2),
		strokes: ink.strokes.map((s) => ({
			id: s.id,
			tool: s.tool,
			color: s.color,
			size: s.size,
			...(penStyleOf(s) ? { style: penStyleOf(s) } : {}),
			anchor: { line: s.anchor.line, hash: s.anchor.hash },
			points: s.points.map((p) => [r(p[0], 2), r(p[1], 2), r(p[2], 3)]),
			...(s.shape ? { shape: s.shape } : {}),
		})),
	});
}

/**
 * A realistic page of handwriting as raw Pencil input: full-precision float coordinates (x across a
 * ~700 px column, y relative to the anchor line), real (varying) pressure on every point. 34 strokes,
 * mostly ballpoint, a few dashed, one highlighter — mirrors the user's real 34-stroke / 2.5k-point file.
 */
function realisticInk(): InkFile {
	const rand = rng(42);
	const strokes: Stroke[] = [];
	const shapes = [
		(x: number, y: number, i: number) => noisy(cursive(x, y, 2 + (i % 3), 16, i + 1), 0.8, 0.25, i + 9),
		(x: number, y: number) => noisy(letterM(x, y), 0.5, 0.2, 5),
		(x: number, y: number) => noisy(letterW(x, y), 0.5, 0.2, 6),
	];
	for (let i = 0; i < 34; i++) {
		const xy = shapes[i % 3](40 + rand() * 600, 10 + rand() * 30, i);
		let pr = 0.3 + rand() * 0.3;
		const points: Point[] = xy.map(([x, y]) => {
			pr = Math.min(1, Math.max(0.05, pr + (rand() - 0.5) * 0.06));
			return [x + rand() * 1e-3, y + rand() * 1e-3, pr];
		});
		const tool = i === 33 ? "highlighter" : "pen";
		strokes.push({
			id: newId(),
			tool,
			color: i % 7 === 0 ? "#e03131" : "ink",
			size: tool === "highlighter" ? 12 : 1.6,
			...(tool === "pen" ? { style: i % 5 === 0 ? ("dashed" as const) : ("ball" as const) } : {}),
			anchor: { line: i * 2, hash: hashLine("line " + i) },
			points,
		});
	}
	return { version: 2, contentWidth: 700, strokes };
}

const maxErr = (a: readonly Point[], b: readonly Point[]) => {
	expect(b).toHaveLength(a.length);
	let m = 0;
	for (let i = 0; i < a.length; i++) m = Math.max(m, Math.abs(a[i][0] - b[i][0]), Math.abs(a[i][1] - b[i][1]));
	return m;
};

describe("v2 compact format", () => {
	it("writes version 2 with delta-encoded 0.1 px integers and no pressure for ballpoint", () => {
		const text = serializeInkFile({
			version: 2,
			contentWidth: 700,
			strokes: [stroke({ style: "ball", points: [[1, 2, 0.5], [3.14159, 4.987654, 0.33], [2.96, 5.04, 0.9]] })],
		});
		const out = parseRaw(text);
		expect(out.version).toBe(2);
		expect(out.strokes[0].xy).toEqual([10, 20, 21, 30, -1, 0]);
		expect("p" in out.strokes[0]).toBe(false);
		expect("points" in out.strokes[0]).toBe(false);
		expect(text).toContain('"anchor":{"line":2,"hash":"abc"},"xy":[10,20,21,30,-1,0]}');
	});

	it("round-trips coordinates within 0.05 px with no drift over long strokes", () => {
		const rand = rng(1);
		const points: Point[] = [];
		let x = 350.123456;
		let y = -12.98765;
		for (let i = 0; i < 5000; i++) {
			x += (rand() - 0.5) * 7.77777;
			y += (rand() - 0.5) * 7.77777;
			points.push([x, y, 0.5]);
		}
		const back = parseInkFile(serializeInkFile({ version: 2, contentWidth: 0, strokes: [stroke({ points })] }));
		expect(maxErr(points, back.strokes[0].points)).toBeLessThanOrEqual(0.05 + 1e-9);
		for (const p of back.strokes[0].points) expect(p[2]).toBe(0.5);
	});

	it("ballpoint, dashed, highlighter and shape strokes drop pressure (implied 0.5)", () => {
		const pts: Point[] = [[0, 0, 0.2], [5, 5, 0.9], [9, 1, 0.4]];
		const ink: InkFile = {
			version: 2,
			contentWidth: 0,
			strokes: [
				stroke({ id: "a", style: "ball", points: pts }),
				stroke({ id: "b", style: "dashed", points: pts }),
				stroke({ id: "c", tool: "highlighter", points: pts }),
				stroke({ id: "d", style: "notes", shape: "line", points: pts }),
			],
		};
		const raw = parseRaw(serializeInkFile(ink));
		for (const s of raw.strokes) expect("p" in s).toBe(false);
		for (const s of parseInkFile(serializeInkFile(ink)).strokes) expect(s.points.map((p) => p[2])).toEqual([0.5, 0.5, 0.5]);
	});

	it("notes-style strokes keep their pressure (0.01 resolution, delta-encoded)", () => {
		const pts: Point[] = [[0, 0, 0.123], [5, 5, 0.9], [9, 1, 0.41], [10, 2, 1], [11, 3, 0]];
		const ink: InkFile = { version: 2, contentWidth: 0, strokes: [stroke({ style: "notes", points: pts })] };
		const raw = parseRaw(serializeInkFile(ink));
		expect(raw.strokes[0].p).toEqual([12, 78, -49, 59, -100]);
		const back = parseInkFile(serializeInkFile(ink)).strokes[0].points;
		for (let i = 0; i < pts.length; i++) expect(Math.abs(back[i][2] - pts[i][2])).toBeLessThanOrEqual(0.005 + 1e-9);
		expect(maxErr(pts, back)).toBeLessThanOrEqual(0.05);
	});

	it("notes-style strokes with constant 0.5 pressure (mouse) store no pressure channel", () => {
		const ink: InkFile = { version: 2, contentWidth: 0, strokes: [stroke({ style: "notes", points: [[0, 0, 0.5], [3, 3, 0.5]] })] };
		expect("p" in parseRaw(serializeInkFile(ink)).strokes[0]).toBe(false);
	});

	it("v1 files load; load → save (v2) → load equals the v1 load within quantization", () => {
		const ink = realisticInk();
		ink.strokes[1].style = "notes"; // one notes stroke keeps pressure
		const v1 = parseInkFile(serializeV1(ink));
		expect(v1.strokes).toHaveLength(34);
		const v2text = serializeInkFile(v1);
		expect(parseRaw(v2text).version).toBe(2);
		const v2 = parseInkFile(v2text);
		expect(v2.contentWidth).toBe(700);
		expect(v2.strokes.map((s) => s.id)).toEqual(v1.strokes.map((s) => s.id));
		for (let i = 0; i < v1.strokes.length; i++) {
			const a = v1.strokes[i];
			const b = v2.strokes[i];
			expect({ ...b, points: [] }).toEqual({ ...a, points: [] });
			expect(maxErr(a.points, b.points)).toBeLessThanOrEqual(0.05 + 1e-9);
			for (let j = 0; j < a.points.length; j++) {
				const want = a.style === "notes" ? a.points[j][2] : 0.5;
				expect(Math.abs(b.points[j][2] - want)).toBeLessThanOrEqual(0.005 + 1e-9);
			}
		}
	});

	it("serialization is a fixed point after one save (stable bytes for echo suppression / no churn)", () => {
		const ink = realisticInk();
		ink.strokes[4].style = "notes";
		const once = serializeInkFile(ink);
		const twice = serializeInkFile(parseInkFile(once));
		expect(twice).toBe(once);
	});

	it("mixed files: v1 point arrays inside a v2 file still load", () => {
		const ink = parseInkFile(
			JSON.stringify({
				version: 2,
				contentWidth: 0,
				strokes: [
					{ id: "a", tool: "pen", style: "ball", points: [[1, 2, 0.5]] },
					{ id: "b", tool: "pen", style: "ball", xy: [10, 20, 5, -5] },
				],
			}),
		);
		expect(ink.strokes[0].points).toEqual([[1, 2, 0.5]]);
		expect(ink.strokes[1].points).toEqual([[1, 2, 0.5], [1.5, 1.5, 0.5]]);
	});

	it("repairs malformed v2 point data", () => {
		const r: ParseReport = { malformed: false, dropped: 0 };
		const ink = parseInkFile(
			JSON.stringify({
				version: 2,
				contentWidth: 0,
				strokes: [
					{ id: "a", xy: [] },
					{ id: "b", xy: ["x", 1] },
					{ id: "c", xy: [10, 20, 10, "bad", 1, 1] }, // truncated at the first invalid value
					{ id: "d", xy: [10, 20, 10], style: "notes", p: [80, "z"] }, // odd tail ignored, bad p → 0.5
					{ id: "e", xy: [0, 0, 0, 0], style: "notes", p: [300, -900] }, // pressure clamped
				],
			}),
			r,
		);
		expect(r.dropped).toBe(2);
		const byId = Object.fromEntries(ink.strokes.map((s) => [s.id, s.points]));
		expect(byId.c).toEqual([[1, 2, 0.5]]);
		expect(byId.d).toEqual([[1, 2, 0.8]]);
		expect(byId.e).toEqual([[0, 0, 1], [0, 0, 0]]);
	});

	it("merging: a local full-precision stroke equals its own v2 round-trip (local object reused)", () => {
		const ink = realisticInk();
		ink.strokes[2].style = "notes";
		const remote = parseInkFile(serializeInkFile(ink)).strokes;
		const out = mergeStrokes(ink.strokes, ink.strokes, remote);
		for (let i = 0; i < out.length; i++) expect(out[i]).toBe(ink.strokes[i]);
		// A real change (one point moved by 1 px) is still detected.
		remote[3] = { ...remote[3], points: remote[3].points.map((p, j): Point => (j === 0 ? [p[0] + 1, p[1], p[2]] : p)) };
		expect(mergeStrokes(ink.strokes, ink.strokes, remote)[3]).toBe(remote[3]);
	});

	it("serializeStroke gives the v2 disk form", () => {
		const d = serializeStroke(stroke({ style: "notes", points: [[1, 2, 0.25], [2, 2, 0.75]] }));
		expect(d).toEqual({ id: "s1", tool: "pen", color: "ink", size: 3, style: "notes", anchor: { line: 2, hash: "abc" }, xy: [10, 20, 10, 0], p: [25, 50] });
	});

	it("round-trips pencil tilt channel t in v2 and omits it when absent", () => {
		const tilted = stroke({
			style: "pencil",
			points: [[1, 2, 0.4], [3, 4, 0.6], [6, 8, 0.8]],
			tilts: [0, 0.5, 0.9],
		});
		const d = serializeStroke(tilted);
		expect(d.t).toEqual([0, 50, 40]);
		const parsed = parseInkFile(serializeInkFile({ version: 2, contentWidth: 0, strokes: [tilted] }));
		expect(parsed.strokes[0].style).toBe("pencil");
		expect(parsed.strokes[0].tilts).toEqual([0, 0.5, 0.9]);

		const upright = stroke({ style: "ball", points: [[1, 2, 0.5], [3, 4, 0.5]] });
		expect(serializeStroke(upright).t).toBeUndefined();
	});

	it("is at least 2.5x smaller than v1 on a realistic page of handwriting", () => {
		const ink = realisticInk();
		const nPts = ink.strokes.reduce((n, s) => n + s.points.length, 0);
		expect(nPts).toBeGreaterThan(2000);
		const v1 = serializeV1(ink).length;
		const v2 = serializeInkFile(ink).length;
		const ratio = v1 / v2;
		console.log(`Stage G size: ${nPts} pts, v1 ${v1} B (${(v1 / nPts).toFixed(1)} B/pt), v2 ${v2} B (${(v2 / nPts).toFixed(1)} B/pt), ratio ${ratio.toFixed(2)}x`);
		expect(ratio).toBeGreaterThanOrEqual(2.5);
	});
});
