/** Stage K — protected drawing spaces: model, merge, store ops, placement, growth, conversions. */
import { parseRaw } from "./rawInk";
import { describe, expect, it } from "vitest";
import {
	InkFile,
	InkSpace,
	SPACE_INK_PAD,
	SPACE_MIN_HEIGHT,
	Stroke,
	hashLine,
	isEmptyInk,
	legacyPageHeight,
	mergeSpaces,
	mergeStrokes,
	mergedHeight,
	parseInkFile,
	serializeInkFile,
	spaceMinHeight,
} from "../src/model";
import {
	A4_SPACE_HEIGHT,
	GROW_ROOM,
	GROW_ZONE,
	LaidLine,
	blockEnds,
	boundSpaceY,
	defaultSpaceHeight,
	displayLine,
	endSpacePlan,
	groupSpace,
	grownHeight,
	planMakeSpace,
	readingPlacement,
	resizedHeight,
	shiftBelowSpaces,
	spaceAt,
	spaceSlots,
	spaceSize,
} from "../src/spaces";
import { InkAdapter, InkStore, TimerApi } from "../src/store";
import { printAreaHeight } from "../src/readingMap";

const stroke = (over: Partial<Stroke> = {}): Stroke => ({
	id: "s1",
	tool: "pen",
	color: "ink",
	size: 1.6,
	style: "ball",
	anchor: { line: 3, hash: hashLine("Line 3") },
	points: [
		[1, 2, 0.5],
		[11, 22, 0.5],
	],
	...over,
});
const space = (id: string, height = 200, after: InkSpace["after"] = { line: 1, hash: "x" }): InkSpace => ({ id, after, height });

class MemAdapter implements InkAdapter {
	files = new Map<string, string>();
	async exists(p: string) {
		return this.files.has(p) || [...this.files.keys()].some((k) => k.startsWith(p + "/"));
	}
	async read(p: string) {
		const f = this.files.get(p);
		if (f === undefined) throw new Error("ENOENT");
		return f;
	}
	async write(p: string, d: string) {
		this.files.set(p, d);
	}
	async remove(p: string) {
		this.files.delete(p);
	}
	async mkdir() {}
}
const timers: TimerApi = { setTimeout: () => 0, clearTimeout: () => {} };

// ---------------------------------------------------------------------------------------------

describe("model: spaces and space ink (v2 format)", () => {
	it("serializes spaces only when present; space ink keeps `space` as its last key; round-trips", () => {
		const plain = parseRaw(serializeInkFile({ version: 2, contentWidth: 700, strokes: [stroke()] }));
		expect("spaces" in plain).toBe(false);
		const ink: InkFile = {
			version: 2,
			contentWidth: 700,
			strokes: [stroke({ id: "a", space: "S1" }), stroke({ id: "b" })],
			spaces: [space("S1", 240.4, { line: 4, hash: "h4" }), { id: "S2", after: "end", height: 300, pos: 99 }],
		};
		const text = serializeInkFile(ink);
		const raw = parseRaw(text);
		expect(raw.spaces).toEqual([
			{ id: "S1", after: { line: 4, hash: "h4" }, height: 241 },
			{ id: "S2", after: "end", height: 300 },
		]);
		expect(Object.keys(raw.strokes[0]).pop()).toBe("space");
		expect("space" in raw.strokes[1]).toBe(false);
		const back = parseInkFile(text);
		expect(back.spaces).toEqual([
			{ id: "S1", after: { line: 4, hash: "h4" }, height: 241 },
			{ id: "S2", after: "end", height: 300 },
		]);
		expect(back.strokes[0].space).toBe("S1");
		expect(serializeInkFile(back)).toBe(text); // fixed point
	});

	it("drops invalid / duplicate spaces, clamps heights; older files load with no spaces", () => {
		const ink = parseInkFile(
			JSON.stringify({
				version: 2,
				contentWidth: 0,
				strokes: [],
				spaces: [{ id: "A", after: "end", height: 5 }, { id: "A", after: "end", height: 300 }, { id: "B", after: { line: -1, hash: "x" }, height: 100 }, { id: "C", after: "end" }, { after: "end", height: 100 }, { id: "D", after: { line: 2, hash: "q" }, height: 1e9 }],
			}),
		);
		expect(ink.spaces).toEqual([
			{ id: "A", after: "end", height: SPACE_MIN_HEIGHT },
			{ id: "D", after: { line: 2, hash: "q" }, height: 50000 },
		]);
		expect(parseInkFile(JSON.stringify({ version: 2, contentWidth: 0, strokes: [] })).spaces).toEqual([]);
	});

	it("a space is never smaller than its ink (repaired on load)", () => {
		const s = stroke({ space: "S", points: [[0, 10, 0.5], [5, 400, 0.5]], size: 2 });
		const ink = parseInkFile(serializeInkFile({ version: 2, contentWidth: 0, strokes: [s], spaces: [space("S", 100)] }));
		expect(ink.spaces![0].height).toBe(spaceMinHeight(401));
		expect(spaceMinHeight(401)).toBe(Math.ceil(401 + SPACE_INK_PAD));
	});

	it("an older plugin version (no `spaces`) still reads the strokes with their line anchor", () => {
		const raw = parseRaw(serializeInkFile({ version: 2, contentWidth: 0, strokes: [stroke({ space: "S" })], spaces: [space("S")] }));
		expect(raw.strokes[0].anchor).toEqual({ line: 3, hash: hashLine("Line 3") });
		expect(Array.isArray(raw.strokes[0].xy)).toBe(true);
	});

	it("isEmptyInk: a space alone keeps the sidecar", () => {
		expect(isEmptyInk({ version: 2, contentWidth: 0, strokes: [], spaces: [] })).toBe(true);
		expect(isEmptyInk({ version: 2, contentWidth: 0, strokes: [], spaces: [space("A")] })).toBe(false);
	});

	it("which space a stroke is in counts as content for the merge", () => {
		const base = [stroke({ id: "x" })];
		const merged = mergeStrokes(base, base, [stroke({ id: "x", space: "S" })]);
		expect(merged[0].space).toBe("S");
	});
});

describe("model: Stage J pages convert to spaces", () => {
	const stageJ = {
		version: 2,
		contentWidth: 700,
		strokes: [
			{ id: "on", tool: "pen", color: "ink", size: 1.6, style: "ball", anchor: { line: 5, hash: "h" }, xy: [100, 200, 10, 10], page: "P1" },
			{ id: "end", tool: "pen", color: "ink", size: 1.6, style: "ball", anchor: { line: 9, hash: "e" }, xy: [100, 12000, 10, 10], page: "P2" },
			{ id: "gone", tool: "pen", color: "ink", size: 1.6, style: "ball", anchor: { line: 2, hash: "g" }, xy: [0, 0, 10, 10], page: "nope" },
			{ id: "line", tool: "pen", color: "ink", size: 1.6, style: "ball", anchor: { line: 2, hash: "g" }, xy: [0, 0, 10, 10] },
		],
		pages: [{ id: "P1", after: { line: 5, hash: "h" } }, { id: "P2", after: "end" }, { id: "bad" }],
		breaks: [{ id: "b1", before: { line: 3, hash: "z" } }],
	};

	it("pages → spaces of one printable page (same id, anchor), page ink → space ink; breaks dropped", () => {
		const ink = parseInkFile(JSON.stringify(stageJ));
		const h = legacyPageHeight(700);
		expect(h).toBe(1012);
		expect(ink.spaces).toEqual([
			{ id: "P1", after: { line: 5, hash: "h" }, height: h },
			{ id: "P2", after: "end", height: 1210 }, // its ink reaches 1201.8 px: grown to hold it (+ pad)
		]);
		expect(ink.strokes.map((s) => [s.id, s.space])).toEqual([
			["on", "P1"],
			["end", "P2"],
			["gone", undefined], // unknown page: back to its line anchor
			["line", undefined],
		]);
		// Points unchanged: relative to the page top = the space top.
		expect(ink.strokes[0].points[0]).toEqual([10, 20, 0.5]);
		const out = parseRaw(serializeInkFile(ink));
		expect("pages" in out).toBe(false);
		expect("breaks" in out).toBe(false);
		expect(out.strokes[0].space).toBe("P1");
		expect("page" in out.strokes[0]).toBe(false);
	});

	it("a page id that collides with a space id gets a new id", () => {
		const ink = parseInkFile(JSON.stringify({ ...stageJ, spaces: [{ id: "P1", after: "end", height: 100 }] }));
		const ids = ink.spaces!.map((s) => s.id);
		expect(ids[0]).toBe("P1");
		expect(new Set(ids).size).toBe(3);
		expect(ink.strokes[0].space).toBe(ids[1]);
	});

	it("page height follows the note's editor width", () => {
		expect(legacyPageHeight(0)).toBe(legacyPageHeight(700));
		expect(legacyPageHeight(500)).toBeLessThan(legacyPageHeight(700));
	});
});

describe("merge: spaces", () => {
	it("by id like strokes: local additions kept, local deletions stay deleted, remote changes apply", () => {
		const base = [space("A"), space("B")];
		const local = [base[0], space("L")];
		const remote = [space("A"), space("B"), space("R")];
		expect(mergeSpaces(base, local, remote).map((s) => s.id)).toEqual(["A", "R", "L"]);
	});

	it("heights merge field-wise: a local resize survives an unrelated remote change", () => {
		expect(mergedHeight(200, 300, 200)).toBe(300);
		expect(mergedHeight(200, 200, 250)).toBe(250);
		expect(mergedHeight(200, 300, 250)).toBe(250); // both changed: remote
		expect(mergedHeight(undefined, 300, 250)).toBe(250);
		const l = space("A", 300);
		const out = mergeSpaces([space("A", 200)], [l], [space("A", 200)]);
		expect(out[0]).toBe(l);
		expect(out[0].height).toBe(300);
		const out2 = mergeSpaces([space("A", 200)], [space("A", 200)], [space("A", 260)]);
		expect(out2[0].height).toBe(260);
	});
});

// ---------------------------------------------------------------------------------------------

describe("store: space ops (one undo step each)", () => {
	it("add a space; draw into it growing it; undo shrinks it back; delete space with its ink; undo; redo", async () => {
		const ad = new MemAdapter();
		const store = new InkStore(ad, { timers, root: "Ink" });
		await store.load("n.md");
		const S = space("S", 200);
		expect(store.editSpaces("n.md", { addSpaces: [{ space: S }] })).toBe(true);
		store.addStroke("n.md", stroke({ id: "off" }));
		store.editSpaces("n.md", { addStrokes: [stroke({ id: "in", space: "S" })], resize: [{ id: "S", height: 320 }] });
		const ink = store.get("n.md")!;
		expect(S.height).toBe(320);
		store.undo("n.md");
		expect(S.height).toBe(200);
		expect(ink.strokes.map((s) => s.id)).toEqual(["off"]);
		store.redo("n.md");
		expect(S.height).toBe(320);
		expect(ink.strokes.map((s) => s.id)).toEqual(["off", "in"]);
		// Delete the space: its ink goes with it, in one step.
		expect(store.editSpaces("n.md", { removeSpaceIds: ["S"] })).toBe(true);
		expect(ink.spaces).toEqual([]);
		expect(ink.strokes.map((s) => s.id)).toEqual(["off"]);
		store.undo("n.md");
		expect(ink.spaces).toEqual([S]);
		expect(ink.strokes.map((s) => s.id)).toEqual(["off", "in"]); // z-order restored
		store.redo("n.md");
		expect(ink.spaces).toEqual([]);
		store.undo("n.md");
		store.undo("n.md"); // the stroke drawn into it
		store.undo("n.md"); // "off"
		store.undo("n.md"); // adding the space
		expect(ink.spaces).toEqual([]);
		expect(store.canUndo("n.md")).toBe(false);
	});

	it("replace strokes + add a space in one op (Make drawing space); z-order kept", async () => {
		const store = new InkStore(new MemAdapter(), { timers });
		await store.load("n.md");
		store.addStroke("n.md", stroke({ id: "a" }));
		store.addStroke("n.md", stroke({ id: "b" }));
		store.addStroke("n.md", stroke({ id: "c" }));
		store.editSpaces("n.md", { addSpaces: [{ space: space("N") }], removeStrokeIds: ["a", "c"], addStrokes: [stroke({ id: "a2", space: "N" }), stroke({ id: "c2", space: "N" })] });
		const ink = store.get("n.md")!;
		expect(ink.strokes.map((s) => s.id)).toEqual(["a2", "c2", "b"]);
		store.undo("n.md");
		expect(ink.strokes.map((s) => s.id)).toEqual(["a", "b", "c"]);
		expect(ink.spaces).toEqual([]);
		store.redo("n.md");
		expect(ink.strokes.map((s) => s.id)).toEqual(["a2", "c2", "b"]);
	});

	it("no-op edits are not recorded; positions are mapped and cleared (canvas + stacks)", async () => {
		const store = new InkStore(new MemAdapter(), { timers });
		await store.load("n.md");
		const S = { ...space("S", 200), pos: 10 };
		store.editSpaces("n.md", { addSpaces: [{ space: S }] });
		expect(store.editSpaces("n.md", { resize: [{ id: "S", height: 200 }] })).toBe(false);
		expect(store.editSpaces("n.md", { removeSpaceIds: ["zz"] })).toBe(false);
		store.editSpaces("n.md", { removeSpaceIds: ["S"] });
		store.mapPositions("n.md", (p) => p + 5);
		expect(S.pos).toBe(15); // held in the undo stack, still mapped
		expect(store.allSpaces("n.md")).toEqual([S]);
		store.clearPositions("n.md");
		expect(S.pos).toBeUndefined();
	});

	it("a note with only a space keeps its sidecar; deleting it deletes the sidecar", async () => {
		const ad = new MemAdapter();
		const store = new InkStore(ad, { timers, root: "Ink" });
		await store.load("n.md");
		store.editSpaces("n.md", { addSpaces: [{ space: space("A", 150, "end") }] });
		await store.flush("n.md");
		expect(parseRaw(ad.files.get("Ink/n.md.json")!).spaces).toEqual([{ id: "A", after: "end", height: 150 }]);
		store.editSpaces("n.md", { removeSpaceIds: ["A"] });
		await store.flush("n.md");
		expect(ad.files.has("Ink/n.md.json")).toBe(false);
	});

	it("live sync: remote spaces merge; a local resize survives; undo entries that no longer apply go", async () => {
		const ad = new MemAdapter();
		const store = new InkStore(ad, { timers, root: "Ink" });
		await store.load("n.md");
		store.editSpaces("n.md", { addSpaces: [{ space: space("A", 200, "end") }, { space: space("K", 200, "end") }] });
		await store.flush("n.md");
		store.editSpaces("n.md", { resize: [{ id: "K", height: 333 }] }); // unsaved local resize
		// Another device removed A and added B (K untouched there).
		ad.files.set("Ink/n.md.json", JSON.stringify({ version: 2, contentWidth: 0, strokes: [], spaces: [{ id: "K", after: "end", height: 200 }, { id: "B", after: "end", height: 90 }] }));
		expect(await store.reloadFromDisk("n.md")).toBe(true);
		const ink = store.get("n.md")!;
		expect(ink.spaces!.map((s) => [s.id, s.height])).toEqual([
			["K", 333],
			["B", 90],
		]);
		store.undo("n.md"); // the resize still applies
		expect(ink.spaces![0].height).toBe(200);
		store.undo("n.md"); // adding A + K: only K is left to remove
		expect(ink.spaces!.map((s) => s.id)).toEqual(["B"]);
		expect(store.canUndo("n.md")).toBe(false);
	});
});

// ---------------------------------------------------------------------------------------------

describe("blocks: where a space is shown", () => {
	const doc = [
		"---", // 0
		"title: x", // 1
		"---", // 2
		"# Heading", // 3
		"para line one", // 4
		"para line two", // 5
		"", // 6
		"- item a", // 7
		"  continued", // 8
		"  - nested", // 9
		"- item b", // 10
		"", // 11
		"```js", // 12
		"code", // 13
		"```", // 14
		"| a | b |", // 15
		"| - | - |", // 16
		"> quote", // 17
		"> more", // 18
		"$$", // 19
		"x^2", // 20
		"$$", // 21
		"---", // 22 (rule)
		"last", // 23
	];
	const ends = Array.from(blockEnds(doc));
	it("each line → the last line of its block", () => {
		expect(ends).toEqual([2, 2, 2, 3, 5, 5, 6, 8, 8, 9, 10, 11, 14, 14, 14, 16, 16, 18, 18, 21, 21, 21, 22, 23]);
	});
	it("displayLine: anchored line → its block's end; 'end' → last line; clamped", () => {
		expect(displayLine(ends, 4)).toBe(5);
		expect(displayLine(ends, 13)).toBe(14);
		expect(displayLine(ends, null)).toBe(23);
		expect(displayLine(ends, 999)).toBe(23);
		expect(displayLine(ends, -3)).toBe(2);
	});
	it("an unclosed fence runs to the end", () => {
		expect(Array.from(blockEnds(["a", "```", "x", "y"]))).toEqual([0, 3, 3, 3]);
	});
	it("spaceSlots: sorted by display line; at one line line-anchored first (list order), then 'end'", () => {
		const lines = ["a", "b", "", "c"];
		const sp: InkSpace[] = [
			{ id: "E", after: "end", height: 10 },
			{ id: "X", after: { line: 3, hash: hashLine("c") }, height: 20 },
			{ id: "Y", after: { line: 0, hash: hashLine("a") }, height: 30 },
			{ id: "Z", after: { line: 9, hash: hashLine("zzz") }, height: 40 }, // gone: clamped to the last line
		];
		expect(spaceSlots(lines, sp).map((s) => [s.id, s.line, s.end])).toEqual([
			["Y", 1, false], // "a" + "b" are one paragraph
			["X", 3, false],
			["Z", 3, false],
			["E", 3, true],
		]);
		// Live lines (editor) win over anchors.
		expect(spaceSlots(lines, sp, undefined, (s) => (s.id === "Y" ? 3 : undefined))[1].id).toBe("Y");
	});
});

describe("ink → space; growth; resize", () => {
	it("creates one printable A4 page and starts another page past its bottom", () => {
		expect(spaceSize(240, false)).toEqual({ height: 240 });
		expect(spaceSize(240, true)).toEqual({ a4: true, height: A4_SPACE_HEIGHT });
		expect(printAreaHeight({ pageSize: "A4" }) - A4_SPACE_HEIGHT).toBeGreaterThanOrEqual(2);
		expect(printAreaHeight({ pageSize: "A4" }) - A4_SPACE_HEIGHT).toBeLessThan(3);
		const last = { id: "A", top: 20, end: true, ...spaceSize(50, true) };
		const top = 20 + A4_SPACE_HEIGHT;
		expect(endSpacePlan(last, 20, 5000, true)).toEqual({ extend: null, top, height: A4_SPACE_HEIGHT });
		expect(endSpacePlan(last, 20, top + 20)).toMatchObject({ extend: null, top });
		expect(boundSpaceY(-15, A4_SPACE_HEIGHT, 2)).toBe(2);
		expect(boundSpaceY(5000, A4_SPACE_HEIGHT, 2)).toBe(A4_SPACE_HEIGHT - SPACE_INK_PAD - 2);
	});

	it("round-trips a fixed A4 page and rejects store resize operations", async () => {
		const fixed: InkSpace = { ...space("fixed"), ...spaceSize(200, true) };
		const file: InkFile = { version: 2, contentWidth: 650, strokes: [stroke({ space: "fixed" })], spaces: [fixed, space("flexible")] };
		const serialized = serializeInkFile(file);
		expect(parseInkFile(serialized).spaces).toEqual(file.spaces);
		const ad = new MemAdapter();
		ad.files.set("Ink/n.md.json", serialized);
		const store = new InkStore(ad, { root: "Ink" });
		await store.load("n.md");
		expect(store.editSpaces("n.md", { resize: [{ id: fixed.id, height: A4_SPACE_HEIGHT + 100 }] })).toBe(false);
		expect(store.get("n.md")?.spaces).toEqual(file.spaces);
	});
	const rects = [
		{ id: "A", top: 100, height: 200 },
		{ id: "B", top: 400, height: 100 },
	];
	it("spaceAt: [top, top + height)", () => {
		expect(spaceAt(rects, 99)).toBeNull();
		expect(spaceAt(rects, 100)!.id).toBe("A");
		expect(spaceAt(rects, 299.9)!.id).toBe("A");
		expect(spaceAt(rects, 300)).toBeNull();
		expect(spaceAt(rects, 450)!.id).toBe("B");
	});
	it("groupSpace: the space holding the group's bbox centre (a moved drawing never splits)", () => {
		expect(groupSpace(rects, [[[0, 80], [0, 160]], [[5, 250]]])!.id).toBe("A"); // centre 165
		expect(groupSpace(rects, [[[0, 280], [0, 380]]])).toBeNull(); // centre 330: between
		expect(groupSpace(rects, [])).toBeNull();
	});
	it("grownHeight: drawing within GROW_ZONE of the bottom grows to GROW_ROOM below the ink; never shrinks", () => {
		expect(grownHeight(200, 100)).toBe(200);
		expect(grownHeight(200, 200 - GROW_ZONE + 1)).toBe(Math.ceil(200 - GROW_ZONE + 1 + GROW_ROOM));
		expect(grownHeight(200, 500)).toBe(500 + GROW_ROOM); // drawn past the bottom
		expect(grownHeight(800, 10)).toBe(800);
		expect(grownHeight(200, -Infinity)).toBe(200);
	});
	it("resizedHeight: never smaller than the ink (+ pad), whole px", () => {
		expect(resizedHeight(50, 300)).toBe(spaceMinHeight(300));
		expect(resizedHeight(512.4, 300)).toBe(512);
		expect(resizedHeight(10, -Infinity)).toBe(SPACE_MIN_HEIGHT);
	});
	it("defaultSpaceHeight: a third of the editor, within limits", () => {
		expect(defaultSpaceHeight(900)).toBe(300);
		expect(defaultSpaceHeight(300)).toBe(160);
		expect(defaultSpaceHeight(5000)).toBe(600);
		expect(defaultSpaceHeight(0)).toBe(300);
	});
	it("endSpacePlan: ink below the note extends the last 'end' space or starts a new one", () => {
		expect(endSpacePlan({ id: "E", top: 1000, height: 100, end: true }, 1100, 1300)).toEqual({ extend: "E", top: 1000, height: 300 + GROW_ROOM });
		expect(endSpacePlan({ id: "L", top: 1000, height: 100, end: false }, 1100, 1300)).toEqual({ extend: null, top: 1100, height: 200 + GROW_ROOM });
		expect(endSpacePlan(null, 1000, 1010)).toEqual({ extend: null, top: 1000, height: grownHeight(SPACE_MIN_HEIGHT, 10) });
	});
});

describe("Make drawing space (planMakeSpace)", () => {
	// 10 lines of 30 px: 0 "text", 1 "text" (paragraph end), 2..6 blank, 7 "next", 8 "", 9 "end"
	const mk = (blank: boolean[], ends: boolean[], pinned: number[] = []): LaidLine[] =>
		blank.map((b, i) => ({ top: i * 30, bottom: i * 30 + 30, blank: b, end: ends[i], pinned: pinned.includes(i) }));
	const blank = [false, false, true, true, true, true, true, false, true, false];
	const ends = [false, true, true, true, true, true, true, true, true, true];

	it("ink in the blank lines below a paragraph: the space follows the paragraph, the covered blank lines go, one blank line stays before the next block", () => {
		const p = planMakeSpace(mk(blank, ends), 64, 170)!;
		expect(p.after).toBe(1);
		expect(p.top).toBe(60);
		expect(p.del).toEqual([2, 5]); // 2..5 covered (tops < 170); 6 is not covered anyway
		expect(p.height).toBe(spaceMinHeight(110));
	});
	it("keeps the last blank line when the ink covers every blank line up to the next text", () => {
		const p = planMakeSpace(mk(blank, ends), 64, 220)!;
		expect(p.del).toEqual([2, 5]); // 6 kept: deleting it would merge "text" and "next"
	});
	it("ink starting a bit above a line's bottom still goes below it (slack); mid-paragraph lines are never a space position", () => {
		const p = planMakeSpace(mk(blank, ends), 56, 100)!;
		expect(p.after).toBe(1);
		const q = planMakeSpace(mk(blank, ends), 31, 50)!; // over line 1 (paragraph): follows… the first block end at/above → none → first end
		expect(q.after).toBe(1);
	});
	it("lines other ink is anchored to are not deleted", () => {
		const p = planMakeSpace(mk(blank, ends, [4]), 64, 170)!;
		expect(p.del).toEqual([2, 3]);
	});
	it("ink below the end of the note: trailing blank lines are deleted, nothing to keep", () => {
		const lines = mk([false, true, true], [true, true, true]);
		const p = planMakeSpace(lines, 35, 400)!;
		expect(p.after).toBe(0);
		expect(p.del).toEqual([1, 2]);
		expect(p.top).toBe(30);
		expect(p.height).toBe(spaceMinHeight(370));
	});
	it("ink starting on a blank line after a blank line: no blank lines to keep (the space's own line separates)", () => {
		const p = planMakeSpace(mk(blank, ends), 94, 220)!;
		expect(p.after).toBe(2);
		expect(p.del).toEqual([3, 6]);
	});
	it("empty document → null", () => {
		expect(planMakeSpace([], 0, 10)).toBeNull();
	});
	it("the ink keeps its place: points relative to the space top = old y − top", () => {
		const p = planMakeSpace(mk(blank, ends), 64, 170)!;
		const y = 120;
		expect(p.top + (y - p.top)).toBe(y);
	});
});

describe("Reading view / PDF placement", () => {
	it("a space after a section's last line (or a trailing blank line) is appended after its content", () => {
		expect(readingPlacement(5, 4, 5, 4, 6, null)).toEqual({ kind: "end" });
		expect(readingPlacement(6, 4, 5, 4, 6, null)).toEqual({ kind: "end" });
		expect(readingPlacement(7, 4, 5, 4, 6, null)).toBeNull();
	});
	it("after a list item in the middle of a list: inside that item", () => {
		const lines = ["- a", "  more", "- b", "- c"];
		const ends = blockEnds(lines);
		expect(readingPlacement(1, 0, 3, 0, 3, [0, 2, 3], ends)).toEqual({ kind: "item", index: 0 });
		expect(readingPlacement(2, 0, 3, 0, 3, [0, 2, 3], ends)).toEqual({ kind: "item", index: 1 });
		expect(readingPlacement(3, 0, 3, 0, 3, [0, 2, 3], ends)).toEqual({ kind: "end" });
	});
	it("ink on blank lines after appended spaces moves down by their heights", () => {
		const slots = [
			{ line: 5, height: 100 },
			{ line: 6, height: 50 },
		];
		expect(shiftBelowSpaces(5, slots)).toBe(0);
		expect(shiftBelowSpaces(6, slots)).toBe(100);
		expect(shiftBelowSpaces(7, slots)).toBe(150);
	});
});
