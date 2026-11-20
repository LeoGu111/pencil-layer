import { parseRaw } from "./rawInk";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { InkFile, Stroke, hashLine, parseInkFile, serializeInkFile } from "../src/model";
import { InkAdapter, InkChange, InkStore, TimerApi, sidecarPath } from "../src/store";

class FakeAdapter implements InkAdapter {
	files = new Map<string, string>();
	dirs = new Set<string>();
	writes = 0;
	failRead = false;
	failWrite = false;

	async exists(p: string) {
		return this.files.has(p) || this.dirs.has(p);
	}
	async read(p: string) {
		if (this.failRead) throw new Error("EIO");
		const f = this.files.get(p);
		if (f === undefined) throw new Error("ENOENT " + p);
		return f;
	}
	async write(p: string, data: string) {
		if (this.failWrite) throw new Error("EROFS");
		const dir = p.slice(0, p.lastIndexOf("/"));
		if (dir && !this.dirs.has(dir)) throw new Error("no parent dir " + dir);
		this.writes++;
		this.files.set(p, data);
	}
	async remove(p: string) {
		this.files.delete(p);
	}
	async mkdir(p: string) {
		const parts = p.split("/");
		for (let i = 1; i <= parts.length; i++) this.dirs.add(parts.slice(0, i).join("/"));
	}
}

class FakeTimers implements TimerApi {
	private next = 1;
	pending = new Map<number, { fn: () => void; at: number }>();
	now = 0;
	setTimeout(fn: () => void, ms: number) {
		const id = this.next++;
		this.pending.set(id, { fn, at: this.now + ms });
		return id;
	}
	clearTimeout(h: unknown) {
		this.pending.delete(h as number);
	}
	advance(ms: number) {
		this.now += ms;
		for (const [id, t] of [...this.pending]) {
			if (t.at <= this.now) {
				this.pending.delete(id);
				t.fn();
			}
		}
	}
}

/** Let queued promise chains settle. */
const settle = async () => {
	for (let i = 0; i < 20; i++) await Promise.resolve();
};

let n = 0;
const mk = (over: Partial<Stroke> = {}): Stroke => ({
	id: `s${++n}`,
	tool: "pen",
	color: "ink",
	size: 3,
	anchor: { line: 0, hash: hashLine("hello") },
	points: [
		[0, 0, 0.5],
		[10, 10, 0.5],
	],
	...over,
});

const NOTE = "School/Physics/Lec 3.md";
const SIDE = ".pencil/School/Physics/Lec 3.md.json";

describe("InkStore", () => {
	let fs: FakeAdapter;
	let timers: FakeTimers;
	let store: InkStore;
	let errors: unknown[];

	beforeEach(() => {
		fs = new FakeAdapter();
		timers = new FakeTimers();
		errors = [];
		store = new InkStore(fs, { timers, onError: (e) => errors.push(e) });
	});

	const onDisk = (p = SIDE): InkFile | undefined => {
		const t = fs.files.get(p);
		return t === undefined ? undefined : parseInkFile(t);
	};

	it("computes sidecar paths", () => {
		expect(sidecarPath(NOTE)).toBe(SIDE);
		expect(store.sidecarPath("a.md")).toBe(".pencil/a.md.json");
	});

	it("setRoot: later reads and writes use the new folder", async () => {
		expect(store.rootFolder).toBe(".pencil");
		await fs.mkdir("Ink/School/Physics");
		fs.files.set(`Ink/${NOTE}.json`, serializeInkFile({ version: 2, contentWidth: 640, strokes: [mk({ id: "moved" })] }));
		store.setRoot("Ink");
		expect(store.rootFolder).toBe("Ink");
		expect(store.sidecarPath("a.md")).toBe("Ink/a.md.json");
		expect(store.notePathForSidecar(`Ink/${NOTE}.json`)).toBe(NOTE);
		expect(store.notePathForSidecar(SIDE)).toBeNull();
		expect((await store.load(NOTE)).strokes.map((s) => s.id)).toEqual(["moved"]);
		store.addStroke(NOTE, mk({ id: "new" }));
		await store.flushAll();
		expect(parseRaw(fs.files.get(`Ink/${NOTE}.json`)!).strokes).toHaveLength(2);
		expect(fs.files.has(SIDE)).toBe(false);
	});

	it("loads a missing file as empty ink without writing", async () => {
		const ink = await store.load(NOTE);
		expect(ink.strokes).toEqual([]);
		expect(store.get(NOTE)).toBe(ink);
		await store.flushAll();
		expect(fs.writes).toBe(0);
	});

	it("dedupes concurrent loads and returns the same instance", async () => {
		const [a, b] = await Promise.all([store.load(NOTE), store.load(NOTE)]);
		expect(a).toBe(b);
		expect(await store.load(NOTE)).toBe(a);
	});

	it("loads an existing sidecar", async () => {
		await fs.mkdir(".pencil/School/Physics");
		fs.files.set(SIDE, serializeInkFile({ version: 1, contentWidth: 640, strokes: [mk({ id: "x" })] }));
		const ink = await store.load(NOTE);
		expect(ink.contentWidth).toBe(640);
		expect(ink.strokes.map((s) => s.id)).toEqual(["x"]);
	});

	it("loads a v1 sidecar without rewriting it; the next save writes v2", async () => {
		await fs.mkdir(".pencil/School/Physics");
		const v1 =
			'{"version":1,"contentWidth":640,"strokes":[{"id":"x","tool":"pen","color":"ink","size":3,"style":"ball",' +
			'"anchor":{"line":0,"hash":"' + hashLine("hello") + '"},"points":[[0,0,0.5],[10.12,10.04,0.71]]}]}';
		fs.files.set(SIDE, v1);
		const ink = await store.load(NOTE);
		expect(ink.strokes[0].points).toEqual([[0, 0, 0.5], [10.12, 10.04, 0.71]]);
		await store.flushAll();
		expect(fs.writes).toBe(0);
		expect(fs.files.get(SIDE)).toBe(v1);
		// Unchanged v1 file re-delivered by sync is not treated as a change.
		expect(await store.reloadFromDisk(NOTE)).toBe(false);
		store.addStroke(NOTE, mk({ id: "y" }));
		await store.flush(NOTE);
		const raw = parseRaw(fs.files.get(SIDE)!);
		expect(raw.version).toBe(2);
		expect(raw.strokes[0].xy).toEqual([0, 0, 101, 100]);
		expect(onDisk()!.strokes.map((s) => s.id)).toEqual(["x", "y"]);
		// Our own v2 write echoing back is ignored.
		expect(await store.reloadFromDisk(NOTE)).toBe(false);
	});

	it("ignores mutations on unloaded paths", () => {
		store.addStroke("nope.md", mk());
		expect(store.get("nope.md")).toBeUndefined();
		expect(store.undo("nope.md")).toBe(false);
	});

	it("debounces saves (800ms) and creates parent folders", async () => {
		await store.load(NOTE);
		store.addStroke(NOTE, mk());
		timers.advance(500);
		store.addStroke(NOTE, mk());
		timers.advance(500);
		await settle();
		expect(fs.writes).toBe(0);
		timers.advance(300);
		await settle();
		expect(fs.writes).toBe(1);
		expect(onDisk()!.strokes).toHaveLength(2);
		expect(fs.dirs.has(".pencil/School/Physics")).toBe(true);
	});

	it("flush writes immediately and skips unchanged content", async () => {
		await store.load(NOTE);
		store.addStroke(NOTE, mk());
		await store.flush(NOTE);
		expect(fs.writes).toBe(1);
		expect(timers.pending.size).toBe(0);
		store.touch(NOTE);
		await store.flush(NOTE);
		expect(fs.writes).toBe(1);
	});

	it("never persists pos", async () => {
		await store.load(NOTE);
		store.addStroke(NOTE, mk({ pos: 123 }));
		await store.flush(NOTE);
		expect(fs.files.get(SIDE)).not.toContain("pos");
	});

	it("undo/redo add", async () => {
		await store.load(NOTE);
		const a = mk();
		const b = mk();
		store.addStroke(NOTE, a);
		store.addStroke(NOTE, b);
		expect(store.canRedo(NOTE)).toBe(false);
		expect(store.undo(NOTE)).toBe(true);
		expect(store.get(NOTE)!.strokes).toEqual([a]);
		expect(store.canRedo(NOTE)).toBe(true);
		expect(store.redo(NOTE)).toBe(true);
		expect(store.get(NOTE)!.strokes).toEqual([a, b]);
		expect(store.redo(NOTE)).toBe(false);
		store.undo(NOTE);
		store.undo(NOTE);
		expect(store.undo(NOTE)).toBe(false);
		expect(store.canUndo(NOTE)).toBe(false);
	});

	it("a new op clears redo", async () => {
		await store.load(NOTE);
		store.addStroke(NOTE, mk());
		store.undo(NOTE);
		store.addStroke(NOTE, mk());
		expect(store.canRedo(NOTE)).toBe(false);
	});

	it("erase restores original z-order on undo", async () => {
		await store.load(NOTE);
		const [a, b, c, d] = [mk(), mk(), mk(), mk()];
		[a, b, c, d].forEach((s) => store.addStroke(NOTE, s));
		const removed = store.removeStrokes(NOTE, [c.id, a.id, "missing"]);
		expect(removed).toEqual([c, a]);
		expect(store.get(NOTE)!.strokes).toEqual([b, d]);
		store.undo(NOTE);
		expect(store.get(NOTE)!.strokes).toEqual([a, b, c, d]);
		store.redo(NOTE);
		expect(store.get(NOTE)!.strokes).toEqual([b, d]);
	});

	it("erase calls with the same batchId merge into one undo op", async () => {
		await store.load(NOTE);
		const [a, b, c] = [mk(), mk(), mk()];
		[a, b, c].forEach((s) => store.addStroke(NOTE, s));
		store.removeStrokes(NOTE, [b.id], "drag1");
		store.removeStrokes(NOTE, [], "drag1");
		store.removeStrokes(NOTE, [a.id], "drag1");
		store.removeStrokes(NOTE, [c.id], "drag1");
		expect(store.get(NOTE)!.strokes).toEqual([]);
		store.undo(NOTE);
		expect(store.get(NOTE)!.strokes).toEqual([a, b, c]);
		store.undo(NOTE); // now undoing the adds
		expect(store.get(NOTE)!.strokes).toEqual([a, b]);
	});

	it("different batchIds are separate ops", async () => {
		await store.load(NOTE);
		const [a, b] = [mk(), mk()];
		store.addStroke(NOTE, a);
		store.addStroke(NOTE, b);
		store.removeStrokes(NOTE, [a.id], "d1");
		store.removeStrokes(NOTE, [b.id], "d2");
		store.undo(NOTE);
		expect(store.get(NOTE)!.strokes).toEqual([b]);
	});

	describe("replace op (lasso edits)", () => {
		const moved = (s: Stroke, dx: number) => ({ ...s, id: `${s.id}'`, points: s.points.map((p) => [p[0] + dx, p[1], p[2]] as Stroke["points"][number]) });

		it("replaces in place (z-order kept) and is one undo step", async () => {
			await store.load(NOTE);
			const [a, b, c, d] = [mk(), mk(), mk(), mk()];
			[a, b, c, d].forEach((s) => store.addStroke(NOTE, s));
			const changes: InkChange[] = [];
			store.subscribe(NOTE, (_p, ch) => changes.push(ch));
			const b2 = moved(b, 10);
			const c2 = moved(c, 10);
			expect(store.replaceStrokes(NOTE, [b.id, c.id], [b2, c2])).toBe(true);
			expect(store.get(NOTE)!.strokes).toEqual([a, b2, c2, d]);
			expect(changes).toEqual([{ type: "replace", removed: [b, c], added: [b2, c2] }]);
			expect(store.undo(NOTE)).toBe(true);
			expect(store.get(NOTE)!.strokes).toEqual([a, b, c, d]);
			expect(changes[1]).toEqual({ type: "replace", removed: [b2, c2], added: [b, c] });
			expect(store.redo(NOTE)).toBe(true);
			expect(store.get(NOTE)!.strokes).toEqual([a, b2, c2, d]);
			// The adds below are separate ops.
			store.undo(NOTE);
			store.undo(NOTE);
			expect(store.get(NOTE)!.strokes).toEqual([a, b, c]);
		});

		it("non-adjacent selection: new strokes go where the first removed one was; undo restores exactly", async () => {
			await store.load(NOTE);
			const [a, b, c, d] = [mk(), mk(), mk(), mk()];
			[a, b, c, d].forEach((s) => store.addStroke(NOTE, s));
			const [d2, b2] = [moved(d, 5), moved(b, 5)];
			store.replaceStrokes(NOTE, [d.id, b.id], [d2, b2]);
			expect(store.get(NOTE)!.strokes).toEqual([a, d2, b2, c]);
			store.undo(NOTE);
			expect(store.get(NOTE)!.strokes).toEqual([a, b, c, d]);
			store.redo(NOTE);
			expect(store.get(NOTE)!.strokes).toEqual([a, d2, b2, c]);
		});

		it("duplicate: nothing removed, copies appended as one op", async () => {
			await store.load(NOTE);
			const a = mk();
			store.addStroke(NOTE, a);
			const copies = [moved(a, 20), { ...moved(a, 40), id: "copy2" }];
			expect(store.replaceStrokes(NOTE, [], copies)).toBe(true);
			expect(store.get(NOTE)!.strokes).toEqual([a, ...copies]);
			store.undo(NOTE);
			expect(store.get(NOTE)!.strokes).toEqual([a]);
		});

		it("no-op replace creates no undo entry; clears redo otherwise", async () => {
			await store.load(NOTE);
			expect(store.replaceStrokes(NOTE, ["ghost"], [])).toBe(false);
			expect(store.canUndo(NOTE)).toBe(false);
			const a = mk();
			store.addStroke(NOTE, a);
			store.addStroke(NOTE, mk());
			store.undo(NOTE);
			store.replaceStrokes(NOTE, [a.id], [moved(a, 1)]);
			expect(store.canRedo(NOTE)).toBe(false);
		});

		it("persists the replacement (and the shape field) and tracks positions of both sides", async () => {
			await store.load(NOTE);
			const a = mk({ pos: 5 });
			store.addStroke(NOTE, a);
			const a2 = { ...moved(a, 3), pos: 50, shape: "line" as const };
			store.replaceStrokes(NOTE, [a.id], [a2]);
			// allStrokes includes the replaced (undo-able) stroke so its position keeps being mapped.
			expect(store.allStrokes(NOTE)).toEqual(expect.arrayContaining([a, a2]));
			store.mapPositions(NOTE, (p) => p + 1);
			expect(a.pos).toBe(6);
			expect(a2.pos).toBe(51);
			await store.flush(NOTE);
			const disk = onDisk()!;
			expect(disk.strokes.map((s) => s.id)).toEqual([a2.id]);
			expect(disk.strokes[0].shape).toBe("line");
		});

		it("maps text highlight ranges (from assoc +1, to assoc -1) incl. undo stacks; clearPositions forgets them", async () => {
			await store.load(NOTE);
			const t = mk({ tool: "highlighter", pos: 0, text: { ch: 4, endLine: 0, endCh: 9 }, textRange: { from: 4, to: 9 } });
			const u = mk({ tool: "highlighter", pos: 0, text: { ch: 1, endLine: 0, endCh: 3 }, textRange: { from: 1, to: 3 } });
			store.addStroke(NOTE, t);
			store.addStroke(NOTE, u);
			store.undo(NOTE); // u now lives in the redo stack
			const calls: [number, number][] = [];
			// "insert 2 chars at 4": positions at 4 move only with assoc +1
			store.mapPositions(NOTE, (p, assoc) => {
				calls.push([p, assoc]);
				return p > 4 || (p === 4 && assoc === 1) ? p + 2 : p;
			});
			expect(t.textRange).toEqual({ from: 6, to: 11 });
			expect(u.textRange).toEqual({ from: 1, to: 3 });
			expect(calls).toContainEqual([0, -1]); // pos
			expect(calls).toContainEqual([4, 1]);
			expect(calls).toContainEqual([9, -1]);
			// a deletion over the whole range collapses it (never inverted)
			store.mapPositions(NOTE, (p, assoc) => (p >= 5 && p <= 12 ? (assoc === 1 ? 12 : 5) : p));
			expect(t.textRange!.to).toBe(t.textRange!.from);
			store.clearPositions(NOTE);
			expect(t.textRange).toBeUndefined();
			expect(u.textRange).toBeUndefined();
			expect(t.pos).toBeUndefined();
			await store.flush(NOTE);
			expect(onDisk()!.strokes[0].text).toEqual({ ch: 4, endLine: 0, endCh: 9 });
		});

		it("[Stage H] maps a character position with assoc +1; clearPositions forgets it; char is persisted", async () => {
			await store.load(NOTE);
			const c = mk({ pos: 0, char: { line: 0, ch: 4, dx: -40, dy: -2 }, charPos: 4 });
			store.addStroke(NOTE, c);
			const calls: [number, number][] = [];
			store.mapPositions(NOTE, (p, assoc) => {
				calls.push([p, assoc]);
				return p > 4 || (p === 4 && assoc === 1) ? p + 2 : p;
			});
			expect(c.charPos).toBe(6);
			expect(calls).toContainEqual([4, 1]);
			store.clearPositions(NOTE);
			expect(c.charPos).toBeUndefined();
			await store.flush(NOTE);
			expect(onDisk()!.strokes[0].char).toEqual({ line: 0, ch: 4, dx: -40, dy: -2 });
		});

		describe("with live sync", () => {
			const remoteWrite = async (strokes: Stroke[]) => {
				await fs.mkdir(".pencil/School/Physics");
				fs.files.set(SIDE, serializeInkFile({ version: 1, contentWidth: 700, strokes }));
			};
			const ids = () => store.get(NOTE)!.strokes.map((s) => s.id);

			it("an unsaved move survives a concurrent remote addition; undo still works", async () => {
				await remoteWrite([mk({ id: "a" })]);
				await store.load(NOTE);
				const a = store.get(NOTE)!.strokes[0];
				const a2 = moved(a, 30);
				store.replaceStrokes(NOTE, ["a"], [a2]); // unsaved
				await remoteWrite([mk({ id: "a" }), mk({ id: "r" })]);
				await store.reloadFromDisk(NOTE);
				expect(ids()).toEqual(["r", "a'"]); // local move kept (old id stays deleted), remote add applied
				timers.advance(800);
				await settle();
				expect(onDisk()!.strokes.map((s) => s.id)).toEqual(["r", "a'"]);
				expect(store.undo(NOTE)).toBe(true);
				expect(ids()).toEqual(["a", "r"]); // original back at its old z-position
				expect(store.redo(NOTE)).toBe(true);
				expect(ids().sort()).toEqual(["a'", "r"]);
			});

			it("a saved move: remote deletion of the moved stroke prunes the op's after-side", async () => {
				await store.load(NOTE);
				const a = mk({ id: "a" });
				const b = mk({ id: "b" });
				store.addStroke(NOTE, a);
				store.addStroke(NOTE, b);
				store.replaceStrokes(NOTE, ["a", "b"], [moved(a, 9), moved(b, 9)]);
				await store.flush(NOTE);
				// Another device erased a' only.
				await remoteWrite([moved(b, 9)]);
				await store.reloadFromDisk(NOTE);
				expect(ids()).toEqual(["b'"]);
				// Undo of the move: b' → b back; a stays gone? Its "before" item (a) is restorable since
				// id "a" isn't on the canvas — the undo brings the original back as the user expects.
				expect(store.undo(NOTE)).toBe(true);
				expect(ids().sort()).toEqual(["a", "b"]);
			});

			it("undo-replace whose original came back remotely is dropped (no duplicates)", async () => {
				await store.load(NOTE);
				const a = mk({ id: "a" });
				store.addStroke(NOTE, a);
				await store.flush(NOTE);
				store.replaceStrokes(NOTE, ["a"], [moved(a, 9)]);
				await store.flush(NOTE);
				// Remote device that never saw the move writes both a and a'.
				await remoteWrite([mk({ id: "a" }), moved(a, 9)]);
				await store.reloadFromDisk(NOTE);
				expect(ids().sort()).toEqual(["a", "a'"]);
				expect(store.undo(NOTE)).toBe(true); // only the "remove a'" half remains
				expect(ids()).toEqual(["a"]);
			});
		});
	});

	it("erasing nothing creates no undo op", async () => {
		await store.load(NOTE);
		expect(store.removeStrokes(NOTE, ["ghost"])).toEqual([]);
		expect(store.canUndo(NOTE)).toBe(false);
	});

	it("empty ink removes the sidecar", async () => {
		await store.load(NOTE);
		const a = mk();
		store.addStroke(NOTE, a);
		await store.flush(NOTE);
		expect(fs.files.has(SIDE)).toBe(true);
		store.removeStrokes(NOTE, [a.id]);
		await store.flush(NOTE);
		expect(fs.files.has(SIDE)).toBe(false);
		store.undo(NOTE);
		await store.flush(NOTE);
		expect(onDisk()!.strokes).toHaveLength(1);
	});

	it("notifies subscribers and supports unsubscribe", async () => {
		const seen: InkChange["type"][] = [];
		const unsub = store.subscribe(NOTE, (_p, c) => seen.push(c.type));
		await store.load(NOTE);
		const a = mk();
		store.addStroke(NOTE, a);
		store.removeStrokes(NOTE, [a.id]);
		store.undo(NOTE);
		store.redo(NOTE);
		expect(seen).toEqual(["load", "add", "remove", "add", "remove"]);
		unsub();
		store.undo(NOTE);
		expect(seen).toHaveLength(5);
	});

	it("rename moves sidecar, entry, history and listeners", async () => {
		const events: InkChange[] = [];
		const listener = vi.fn((_p: string, c: InkChange) => events.push(c));
		store.subscribe(NOTE, listener);
		await store.load(NOTE);
		const a = mk();
		store.addStroke(NOTE, a);
		await store.flush(NOTE);
		const b = mk();
		store.addStroke(NOTE, b); // pending (unsaved) change at rename time

		await store.rename(NOTE, "Archive/Lec 3.md");
		const NEW = ".pencil/Archive/Lec 3.md.json";
		expect(fs.files.has(SIDE)).toBe(false);
		expect(onDisk(NEW)!.strokes.map((s) => s.id)).toEqual([a.id, b.id]);
		expect(store.get(NOTE)).toBeUndefined();
		expect(store.get("Archive/Lec 3.md")!.strokes).toHaveLength(2);
		expect(events.at(-1)).toEqual({ type: "rename", oldPath: NOTE, newPath: "Archive/Lec 3.md" });

		store.undo("Archive/Lec 3.md");
		expect(events.at(-1)?.type).toBe("remove");
		await store.flush("Archive/Lec 3.md");
		expect(onDisk(NEW)!.strokes).toHaveLength(1);
		expect(timers.pending.size).toBe(0);
	});

	it("rename of a note that was never loaded still moves its sidecar", async () => {
		await fs.mkdir(".pencil");
		fs.files.set(".pencil/a.md.json", serializeInkFile({ version: 1, contentWidth: 0, strokes: [mk()] }));
		await store.rename("a.md", "b/c.md");
		expect(fs.files.has(".pencil/a.md.json")).toBe(false);
		expect(onDisk(".pencil/b/c.md.json")!.strokes).toHaveLength(1);
	});

	it("delete removes sidecar and memory, cancels pending save", async () => {
		const listener = vi.fn();
		store.subscribe(NOTE, listener);
		await store.load(NOTE);
		store.addStroke(NOTE, mk());
		await store.flush(NOTE);
		store.addStroke(NOTE, mk());
		await store.delete(NOTE);
		expect(fs.files.has(SIDE)).toBe(false);
		expect(store.get(NOTE)).toBeUndefined();
		expect(listener).toHaveBeenLastCalledWith(NOTE, { type: "delete" });
		timers.advance(5000);
		await settle();
		expect(fs.files.has(SIDE)).toBe(false);
	});

	it("loads malformed JSON as empty and backs it up before overwriting", async () => {
		await fs.mkdir(".pencil/School/Physics");
		fs.files.set(SIDE, "{ this is not json");
		const ink = await store.load(NOTE);
		expect(ink.strokes).toEqual([]);
		// Untouched until something changes.
		store.touch(NOTE);
		await store.flush(NOTE);
		expect(fs.files.get(SIDE)).toBe("{ this is not json");
		store.addStroke(NOTE, mk());
		await store.flush(NOTE);
		expect(fs.files.get(SIDE + ".bak")).toBe("{ this is not json");
		expect(onDisk()!.strokes).toHaveLength(1);
	});

	it("never writes when the sidecar could not be read", async () => {
		await fs.mkdir(".pencil/School/Physics");
		fs.files.set(SIDE, "original");
		fs.failRead = true;
		await store.load(NOTE);
		store.addStroke(NOTE, mk());
		await store.flush(NOTE);
		expect(fs.files.get(SIDE)).toBe("original");
		expect(errors.length).toBeGreaterThan(0);
	});

	it("save failures are reported, not thrown, and retried on next flush", async () => {
		await store.load(NOTE);
		store.addStroke(NOTE, mk());
		fs.failWrite = true;
		await expect(store.flush(NOTE)).resolves.toBeUndefined();
		expect(errors).toHaveLength(1);
		fs.failWrite = false;
		await store.flush(NOTE);
		expect(onDisk()!.strokes).toHaveLength(1);
	});

	it("setContentWidth persists without an undo op", async () => {
		await store.load(NOTE);
		store.addStroke(NOTE, mk());
		store.setContentWidth(NOTE, 720);
		await store.flush(NOTE);
		expect(onDisk()!.contentWidth).toBe(720);
		store.undo(NOTE);
		expect(store.canUndo(NOTE)).toBe(false);
		expect(store.get(NOTE)!.contentWidth).toBe(720);
	});

	describe("positions and beforeSave", () => {
		it("only the oldest subscriber maps positions", async () => {
			const v1 = vi.fn();
			const v2 = vi.fn();
			store.subscribe(NOTE, v1);
			const unsub2 = store.subscribe(NOTE, v2);
			await store.load(NOTE);
			const s = mk({ pos: 10 });
			store.addStroke(NOTE, s);
			expect(store.isPositionOwner(NOTE, v1)).toBe(true);
			expect(store.mapPositions(NOTE, (p) => p + 5, v2)).toBe(false);
			expect(store.mapPositions(NOTE, (p) => p + 5, v1)).toBe(true);
			expect(s.pos).toBe(15);
			unsub2();
			expect(store.isPositionOwner(NOTE, v1)).toBe(true);
		});

		it("maps strokes held in undo/redo stacks too", async () => {
			const v = vi.fn();
			store.subscribe(NOTE, v);
			await store.load(NOTE);
			const s = mk({ pos: 100 });
			store.addStroke(NOTE, s);
			store.undo(NOTE);
			expect(store.allStrokes(NOTE)).toContain(s);
			store.mapPositions(NOTE, (p) => p + 1, v);
			expect(s.pos).toBe(101);
		});

		it("calls the owner's beforeSave to refresh anchors before writing", async () => {
			const doc = ["new first line", "hello"];
			const beforeSave = vi.fn((ink: InkFile) => {
				for (const st of ink.strokes) st.anchor = { line: 1, hash: hashLine(doc[1]) };
			});
			store.subscribe(NOTE, vi.fn(), { beforeSave });
			await store.load(NOTE);
			store.addStroke(NOTE, mk({ pos: 15 }));
			await store.flush(NOTE);
			expect(beforeSave).toHaveBeenCalledTimes(1);
			expect(onDisk()!.strokes[0].anchor).toEqual({ line: 1, hash: hashLine("hello") });
		});

		it("last unsubscribe runs beforeSave, flushes, and clears positions", async () => {
			let line = 0;
			const unsub = store.subscribe(NOTE, vi.fn(), {
				beforeSave: (ink) => ink.strokes.forEach((s) => (s.anchor = { line, hash: "h" })),
			});
			await store.load(NOTE);
			const s = mk({ pos: 5 });
			store.addStroke(NOTE, s);
			await store.flush(NOTE);
			line = 7; // text was inserted above since the last save
			unsub();
			await settle();
			expect(s.pos).toBeUndefined();
			expect(onDisk()!.strokes[0].anchor.line).toBe(7);
		});

		it("clearPositions forgets pos everywhere", async () => {
			await store.load(NOTE);
			const s = mk({ pos: 3 });
			store.addStroke(NOTE, s);
			store.clearPositions(NOTE);
			expect(s.pos).toBeUndefined();
		});
	});

	it("observeAll sees changes for every path without taking position ownership", async () => {
		const seen: [string, InkChange["type"]][] = [];
		const stop = store.observeAll((p, c) => seen.push([p, c.type]));
		const owner = vi.fn();
		store.subscribe(NOTE, owner);
		await store.load(NOTE);
		await store.load("b.md");
		store.addStroke(NOTE, mk({ id: "o1" }));
		store.undo(NOTE);
		expect(seen).toEqual([
			[NOTE, "load"],
			["b.md", "load"],
			[NOTE, "add"],
			[NOTE, "remove"],
		]);
		expect(store.isPositionOwner(NOTE, owner)).toBe(true);
		stop();
		store.redo(NOTE);
		expect(seen.length).toBe(4);
		expect(owner).toHaveBeenCalledTimes(4);
	});

	describe("live sync (reloadFromDisk)", () => {
		/** Simulate Obsidian Sync writing another device's version of the sidecar. */
		const remoteWrite = async (strokes: Stroke[], contentWidth = 700) => {
			await fs.mkdir(".pencil/School/Physics");
			fs.files.set(SIDE, serializeInkFile({ version: 1, contentWidth, strokes }));
		};
		const ids = () => store.get(NOTE)!.strokes.map((s) => s.id);

		it("maps sidecar paths back to note paths", () => {
			expect(store.notePathForSidecar(SIDE)).toBe(NOTE);
			expect(store.notePathForSidecar(".pencil/a.md.json.bak")).toBeNull();
			expect(store.notePathForSidecar("Other/a.md.json")).toBeNull();
			expect(store.notePathForSidecar(".pencil/.json")).toBeNull();
		});

		it("ignores the modify event our own write fires before the write resolves", async () => {
			// Vault.modify emits "modify" synchronously during the write, before lastSaved is updated.
			await store.load(NOTE);
			let reload: Promise<boolean> | null = null;
			const orig = fs.write.bind(fs);
			fs.write = async (p: string, d: string) => {
				await orig(p, d);
				if (p === SIDE) reload = store.reloadFromDisk(NOTE);
			};
			store.addStroke(NOTE, mk({ id: "x" }));
			await store.flush(NOTE);
			expect(reload).not.toBeNull();
			expect(await reload!).toBe(false);
			expect(ids()).toEqual(["x"]);
			expect(fs.writes).toBe(1);
		});

		it("is a no-op for notes that are not loaded", async () => {
			await remoteWrite([mk({ id: "r" })]);
			expect(await store.reloadFromDisk(NOTE)).toBe(false);
			expect(store.isLoaded(NOTE)).toBe(false);
		});

		it("applies a remote change and notifies with type sync", async () => {
			await remoteWrite([mk({ id: "a" })]);
			await store.load(NOTE);
			const changes: InkChange[] = [];
			store.subscribe(NOTE, (_p, c) => changes.push(c));
			const ink = store.get(NOTE)!;
			const a = ink.strokes[0];
			await remoteWrite([mk({ id: "a" }), mk({ id: "b" })], 820);
			expect(await store.reloadFromDisk(NOTE)).toBe(true);
			expect(store.get(NOTE)).toBe(ink); // same InkFile object
			expect(ids()).toEqual(["a", "b"]);
			expect(ink.strokes[0]).toBe(a); // unchanged stroke keeps its identity
			expect(ink.contentWidth).toBe(820);
			expect(changes).toHaveLength(1);
			expect(changes[0]).toMatchObject({ type: "sync" });
			expect((changes[0] as { added: Stroke[] }).added.map((s) => s.id)).toEqual(["b"]);
			// Nothing local was pending: no write back.
			await store.flushAll();
			timers.advance(1000);
			await settle();
			expect(fs.writes).toBe(0);
		});

		it("ignores echoes of our own writes (no reload loop)", async () => {
			await store.load(NOTE);
			const listener = vi.fn();
			store.subscribe(NOTE, listener);
			store.addStroke(NOTE, mk({ id: "mine" }));
			await store.flush(NOTE);
			expect(fs.writes).toBe(1);
			listener.mockClear();
			// The vault "modify" event for our own write arrives.
			expect(await store.reloadFromDisk(NOTE)).toBe(false);
			expect(listener).not.toHaveBeenCalled();
			timers.advance(5000);
			await settle();
			expect(fs.writes).toBe(1);
		});

		it("waits for an in-flight save before comparing (echo during write)", async () => {
			await store.load(NOTE);
			store.addStroke(NOTE, mk({ id: "mine" }));
			const saving = store.flush(NOTE);
			const reload = store.reloadFromDisk(NOTE); // event fired while the write is still pending
			await saving;
			expect(await reload).toBe(false);
			expect(ids()).toEqual(["mine"]);
		});

		it("merges with unsaved local changes and writes the union back", async () => {
			await remoteWrite([mk({ id: "a" }), mk({ id: "b" })]);
			await store.load(NOTE);
			// Local, unsaved: draw L, erase b.
			store.addStroke(NOTE, mk({ id: "L" }));
			store.removeStrokes(NOTE, ["b"]);
			// Remote: drew R and erased a.
			await remoteWrite([mk({ id: "b" }), mk({ id: "R" })]);
			await store.reloadFromDisk(NOTE);
			expect(ids()).toEqual(["R", "L"]);
			timers.advance(800);
			await settle();
			expect(onDisk()!.strokes.map((s) => s.id)).toEqual(["R", "L"]);
		});

		it("a remote deletion of the whole sidecar clears clean local ink", async () => {
			await remoteWrite([mk({ id: "a" })]);
			await store.load(NOTE);
			fs.files.delete(SIDE);
			expect(await store.reloadFromDisk(NOTE)).toBe(true);
			expect(ids()).toEqual([]);
			await store.flushAll();
			expect(fs.files.has(SIDE)).toBe(false);
		});

		it("drops undo/redo entries whose strokes were deleted remotely", async () => {
			await store.load(NOTE);
			store.addStroke(NOTE, mk({ id: "a" }));
			store.addStroke(NOTE, mk({ id: "b" }));
			await store.flush(NOTE);
			// Remote erased a.
			await remoteWrite([mk({ id: "b" })]);
			await store.reloadFromDisk(NOTE);
			expect(ids()).toEqual(["b"]);
			expect(store.undo(NOTE)).toBe(true); // undo add b
			expect(ids()).toEqual([]);
			expect(store.canUndo(NOTE)).toBe(false); // "add a" was dropped
			expect(store.redo(NOTE)).toBe(true);
			expect(ids()).toEqual(["b"]);
		});

		it("drops undo-erase entries for strokes that reappeared remotely (no duplicates)", async () => {
			await remoteWrite([mk({ id: "a" })]);
			await store.load(NOTE);
			store.removeStrokes(NOTE, ["a"]);
			await store.flush(NOTE);
			// Another device (that hadn't seen the erase) re-adds a with different content.
			await remoteWrite([mk({ id: "a", points: [[5, 5, 0.5]] })]);
			await store.reloadFromDisk(NOTE);
			// Our save removed the sidecar (base is empty), so the remote a counts as a remote addition.
			expect(ids()).toEqual(["a"]);
			expect(store.canUndo(NOTE)).toBe(false);
		});

		it("ignores malformed external content (e.g. a partially synced file)", async () => {
			await remoteWrite([mk({ id: "a" })]);
			await store.load(NOTE);
			fs.files.set(SIDE, '{"version":1,"strok');
			expect(await store.reloadFromDisk(NOTE)).toBe(false);
			expect(ids()).toEqual(["a"]);
			expect(errors.length).toBe(1);
		});

		it("new remote strokes come without positions; existing ones keep theirs", async () => {
			await remoteWrite([mk({ id: "a" })]);
			await store.load(NOTE);
			store.get(NOTE)!.strokes[0].pos = 10;
			await remoteWrite([mk({ id: "a" }), mk({ id: "b" })]);
			await store.reloadFromDisk(NOTE);
			const [a, b] = store.get(NOTE)!.strokes;
			expect(a.pos).toBe(10);
			expect(b.pos).toBeUndefined();
		});

		it("round-trips the style field through a remote reload", async () => {
			await store.load(NOTE);
			await remoteWrite([mk({ id: "d", style: "dotted" })]);
			await store.reloadFromDisk(NOTE);
			expect(store.get(NOTE)!.strokes[0].style).toBe("dotted");
		});
	});
});
