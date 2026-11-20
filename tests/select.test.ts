import { describe, expect, it } from "vitest";
import type { Point, Stroke, Tool } from "../src/model";
import {
	CLICK_MOVE,
	KeyContext,
	KeyInput,
	consumesKey,
	deskPress,
	deskRegionRelease,
	pickTopmost,
	rectPolygon,
	routeInkKey,
	selectInRect,
	strokeNear,
} from "../src/select";

function stroke(id: string, pts: [number, number][], tool: Tool = "pen", size = 2): Stroke {
	return {
		id,
		tool,
		color: "ink",
		size,
		anchor: { line: 0, hash: "" },
		points: pts.map((p): Point => [p[0], p[1], 0.5]),
	};
}

/** Densely sampled segment a → b. */
function line(a: [number, number], b: [number, number], step = 2): [number, number][] {
	const n = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / step));
	const out: [number, number][] = [];
	for (let i = 0; i <= n; i++) out.push([a[0] + ((b[0] - a[0]) * i) / n, a[1] + ((b[1] - a[1]) * i) / n]);
	return out;
}

describe("rectPolygon", () => {
	it("normalizes any drag direction to a clockwise rectangle", () => {
		const exp = [
			[10, 20],
			[50, 20],
			[50, 60],
			[10, 60],
		];
		expect(rectPolygon([10, 20], [50, 60])).toEqual(exp);
		expect(rectPolygon([50, 60], [10, 20])).toEqual(exp);
		expect(rectPolygon([50, 20], [10, 60])).toEqual(exp);
	});
});

describe("selectInRect (touch rule)", () => {
	const top0 = () => 0;
	it("selects strokes with any point inside and skips strokes outside", () => {
		const inside = stroke("in", line([20, 30], [40, 35]));
		const partly = stroke("partly", line([45, 40], [120, 40])); // starts inside, mostly outside
		const outside = stroke("out", line([200, 200], [240, 210]));
		const sel = selectInRect([inside, partly, outside], [10, 20], [50, 60], top0);
		expect(sel.map((s) => s.id)).toEqual(["in", "partly"]);
	});
	it("selects a sparse line that only crosses the rectangle (no point inside)", () => {
		const through = stroke("through", [
			[0, 40],
			[300, 40],
		]);
		expect(selectInRect([through], [100, 30], [120, 50], top0).map((s) => s.id)).toEqual(["through"]);
		// Passing beside it: not selected.
		expect(selectInRect([through], [100, 50], [120, 70], top0)).toEqual([]);
	});
	it("uses each stroke's line top", () => {
		const s = stroke("s", line([20, 5], [30, 5]));
		expect(selectInRect([s], [10, 100], [50, 120], () => 100)).toHaveLength(1);
		expect(selectInRect([s], [10, 100], [50, 120], () => 0)).toHaveLength(0);
	});
	it("a zero-area rectangle selects nothing it doesn't touch", () => {
		const s = stroke("s", line([20, 30], [40, 30]));
		expect(selectInRect([s], [100, 100], [100, 100], top0)).toEqual([]);
	});
});

describe("click hit-testing", () => {
	it("hits within a few px of the line (plus half its width), not beyond", () => {
		const s = stroke("s", line([0, 0], [100, 0]), "pen", 2);
		expect(strokeNear(s, 0, 50, 0)).toBe(true);
		expect(strokeNear(s, 0, 50, 5)).toBe(true); // 1 (half width) + 5 tolerance
		expect(strokeNear(s, 0, 50, 7)).toBe(false);
		expect(strokeNear(s, 0, 104, 0)).toBe(true); // past the end, within tolerance
		expect(strokeNear(s, 0, 110, 0)).toBe(false);
		expect(strokeNear(s, 200, 50, 200)).toBe(true); // anchor line offset
	});
	it("a single-point stroke (dot) is clickable", () => {
		expect(strokeNear(stroke("dot", [[10, 10]]), 0, 13, 12)).toBe(true);
	});
	it("picks the topmost: pens above highlighters, later strokes above earlier", () => {
		const hl = stroke("hl", line([0, 0], [100, 0]), "highlighter", 12);
		const pen1 = stroke("pen1", line([0, 0], [100, 0]));
		const pen2 = stroke("pen2", line([0, 0], [100, 0]));
		const all = [pen1, hl, pen2];
		expect(pickTopmost(all, (s) => strokeNear(s, 0, 50, 0))?.id).toBe("pen2");
		// Only the wide highlighter is within reach at y = 8.
		expect(pickTopmost(all, (s) => strokeNear(s, 0, 50, 8))?.id).toBe("hl");
		expect(pickTopmost(all, (s) => strokeNear(s, 0, 50, 40))).toBeNull();
	});
});

describe("routeInkKey", () => {
	const key = (k: string, o: Partial<KeyInput> = {}): KeyInput => ({
		key: k,
		mod: false,
		otherMod: false,
		shift: false,
		alt: false,
		composing: false,
		repeat: false,
		...o,
	});
	const sel: KeyContext = { hasSelection: true, selectActive: true, clipboardFull: true, focus: "editor" };
	const none: KeyContext = { hasSelection: false, selectActive: true, clipboardFull: false, focus: "editor" };
	const off: KeyContext = { hasSelection: false, selectActive: false, clipboardFull: true, focus: "editor" };

	it("with an ink selection: Esc, Delete/Backspace and Mod+C/X/D act on the ink", () => {
		expect(routeInkKey(key("Escape"), sel)).toBe("deselect");
		expect(routeInkKey(key("Delete"), sel)).toBe("delete");
		expect(routeInkKey(key("Backspace"), sel)).toBe("delete");
		expect(routeInkKey(key("c", { mod: true }), sel)).toBe("copy");
		expect(routeInkKey(key("C", { mod: true }), sel)).toBe("copy"); // caps lock
		expect(routeInkKey(key("x", { mod: true }), sel)).toBe("cut");
		expect(routeInkKey(key("d", { mod: true }), sel)).toBe("duplicate");
		expect(routeInkKey(key("v", { mod: true }), sel)).toBe("paste");
	});
	it("never takes typing", () => {
		for (const k of ["a", "c", "x", "v", "d", " ", "Enter", "Tab", "ArrowLeft"]) expect(routeInkKey(key(k), sel)).toBeNull();
		expect(routeInkKey(key("Backspace", { shift: true }), sel)).toBeNull();
		expect(routeInkKey(key("a", { mod: true }), sel)).toBeNull(); // select all stays Obsidian's
		expect(routeInkKey(key("z", { mod: true }), sel)).toBeNull();
		expect(routeInkKey(key("c", { mod: true, shift: true }), sel)).toBeNull();
		expect(routeInkKey(key("c", { mod: true, alt: true }), sel)).toBeNull();
		expect(routeInkKey(key("c", { otherMod: true }), sel)).toBeNull(); // Ctrl+C on a Mac
		expect(routeInkKey(key("Backspace", { composing: true }), sel)).toBeNull();
	});
	it("without a selection Obsidian behaves normally (except paste / leaving Select)", () => {
		expect(routeInkKey(key("Delete"), none)).toBeNull();
		expect(routeInkKey(key("Backspace"), none)).toBeNull();
		expect(routeInkKey(key("c", { mod: true }), none)).toBeNull();
		expect(routeInkKey(key("x", { mod: true }), none)).toBeNull();
		expect(routeInkKey(key("d", { mod: true }), none)).toBeNull();
		expect(routeInkKey(key("Escape"), none)).toBe("exit-select");
		expect(routeInkKey(key("Escape"), off)).toBeNull();
	});
	it("Mod+V pastes ink only with Select active and a non-empty ink clipboard", () => {
		expect(routeInkKey(key("v", { mod: true }), { ...none, clipboardFull: true })).toBe("paste");
		expect(routeInkKey(key("v", { mod: true }), none)).toBeNull(); // empty ink clipboard
		expect(routeInkKey(key("v", { mod: true }), off)).toBeNull(); // Select inactive
		expect(routeInkKey(key("v", { mod: true, repeat: true }), { ...none, clipboardFull: true })).toBeNull();
	});
	it("keys aimed elsewhere (inputs, modals, other panes) are never routed", () => {
		const elsewhere: KeyContext = { ...sel, focus: "other" };
		for (const k of [key("Escape"), key("Delete"), key("c", { mod: true }), key("v", { mod: true })]) {
			expect(routeInkKey(k, elsewhere)).toBeNull();
		}
	});
	it("leaving Select lets Escape through; everything else consumes the key", () => {
		expect(consumesKey("exit-select")).toBe(false);
		for (const a of ["deselect", "delete", "copy", "cut", "paste", "duplicate"] as const) expect(consumesKey(a)).toBe(true);
	});
});

describe("deskPress / deskRegionRelease (Stage H: a click on empty space leaves Select)", () => {
	it("primary press: handle scales, selection moves, a stroke is selected, empty space starts a region", () => {
		expect(deskPress("handle", 0, false)).toBe("scale");
		expect(deskPress("selection", 0, false)).toBe("move");
		expect(deskPress("stroke", 0, false)).toBe("select-stroke");
		expect(deskPress("empty", 0, false)).toBe("region");
		expect(deskPress("empty", 0, true)).toBe("region"); // the clipboard never matters for the left button
	});
	it("right-click: Paste on empty space with ink on the clipboard, else Obsidian's menu", () => {
		expect(deskPress("empty", 2, true)).toBe("paste-menu");
		expect(deskPress("empty", 2, false)).toBe("pass");
		expect(deskPress("selection", 2, true)).toBe("pass");
		expect(deskPress("handle", 2, true)).toBe("pass");
	});
	it("other buttons are never ours", () => {
		expect(deskPress("empty", 1, true)).toBe("pass");
		expect(deskPress("stroke", 1, false)).toBe("pass");
	});
	it("a region release under CLICK_MOVE is a click: back to the text cursor; a drag selects", () => {
		expect(deskRegionRelease(0)).toBe("exit-to-text");
		expect(deskRegionRelease(CLICK_MOVE - 0.5)).toBe("exit-to-text");
		expect(deskRegionRelease(CLICK_MOVE)).toBe("region");
		expect(deskRegionRelease(40)).toBe("region");
	});
});
