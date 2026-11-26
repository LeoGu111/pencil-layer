/**
 * InkStore — the in-memory ink model for every open note, keyed by note path, plus persistence
 * (debounced sidecar saves), per-file undo/redo and change notification.
 *
 * ## Contract for the view layer (CM6 ViewPlugin)
 *
 * Lifecycle per editor view showing note `path`:
 *   1. `const unsub = store.subscribe(path, onChange, { beforeSave })`
 *   2. `await store.load(path)` — then `store.get(path)` returns the shared InkFile. Mutating
 *      methods are no-ops for paths that are not loaded yet.
 *   3. Render `store.get(path).strokes`; re-render whenever `onChange` fires (it fires for changes
 *      made through *any* view of the same file, including undo/redo).
 *   4. When the view is destroyed or switches to another file: call `unsub()`. Unsubscribing the
 *      last listener of a path runs `beforeSave`, flushes pending saves and clears positions.
 *
 * ### Anchors and positions
 * Persisted anchors are `{line, hash}` (see model.ts). While a note is open the view should hold
 * each stroke's anchor as a live document position in the transient `stroke.pos` field
 * (start of the anchor line), which is never serialized:
 *   - After load (and whenever a stroke has `pos === undefined`, e.g. after another device's
 *     edits), resolve it: `line = resolveAnchor(lines, stroke.anchor)`, `stroke.pos = doc.line(line+1).from`.
 *     `store.allStrokes(path)` returns strokes on the canvas AND in the undo/redo stacks, so stacked
 *     strokes get valid positions too.
 *   - On every `docChanged` update: `store.mapPositions(path, (p) => tr.changes.mapPos(p, -1), onChange)`
 *     — passing your listener as the owner token. Several editor views of the same file each receive
 *     the change; only the *position owner* (oldest live subscriber) actually applies the mapping,
 *     so positions are not mapped twice. Then call `store.touch(path)` so the refreshed anchors get
 *     persisted (no write happens if the serialized content didn't change).
 *   - `beforeSave(ink)` (from the owner subscription) is called synchronously right before every
 *     save. It must refresh `stroke.anchor = { line, hash: hashLine(lineText) }` from `stroke.pos`
 *     for each stroke in `ink.strokes`.
 *   - For a newly drawn stroke the view fills in both `anchor` and `pos` before `addStroke`.
 *
 * ### Undo/redo
 * Per file, in memory only. Ops are `add` (one stroke), `erase` (a set of strokes), `replace`
 * (remove a set of strokes and insert others in one step — lasso move/scale/recolor/duplicate) and
 * `space` (Stage K: add/remove/resize drawing spaces together with stroke changes).
 * For an eraser drag pass the same `batchId` to every `removeStrokes` call during the drag;
 * consecutive erase calls with the same batchId merge into one undoable op, so strokes vanish live
 * while dragging but one undo restores them all (at their original z-order).
 *
 * `replaceStrokes` inserts the new strokes where the first removed one was (keeping the group's
 * z-position). Replacement strokes should carry NEW ids: live-sync merging is by id, so a moved
 * stroke is "old id deleted locally + new id added locally" and survives a concurrent remote edit.
 *
 * ### Vault events (wired in main.ts)
 * `rename(old, new)` moves the sidecar, the in-memory entry, undo history and listeners;
 * listeners get `{type: "rename"}` and should update any cached path. `delete(path)` drops
 * everything and removes the sidecar.
 *
 * ### Live sync (external changes)
 * When a sidecar changes on disk from outside (Obsidian Sync delivering another device's ink),
 * main.ts calls `reloadFromDisk(notePath)` for notes that are loaded. Echoes of our own writes are
 * skipped (disk content equal to `lastSaved`). Otherwise the remote strokes are merged with local
 * ones by id (`mergeStrokes`: base = what we last saved/loaded); the InkFile object is kept and its
 * `strokes` array replaced, undo/redo entries whose strokes no longer apply are dropped, and
 * listeners get `{type: "sync"}`. Strokes new to this device have `pos === undefined` and must be
 * resolved from their anchors against the current document (as after `load`). If local had
 * unsaved changes the merged result is saved back (debounced); otherwise nothing is written.
 *
 * ### Damaged sidecars
 * A sidecar that can't be parsed (or had strokes dropped) loads as empty/partial ink and is left
 * untouched until the ink changes; before the first overwrite/removal the original text is copied
 * to `<sidecar>.bak`. If reading fails outright (I/O error), the entry is read-only: saves are
 * skipped (reported via onError) so the unreadable file is never clobbered.
 */
import { InkFile, InkSpace, ParseReport, Stroke, isEmptyInk, mergeSpaces, mergeStrokes, parseInkFile, serializeInkFile } from "./model";

/** Minimal subset of Obsidian's `DataAdapter` (`app.vault.adapter`) used by the store. */
export interface InkAdapter {
	exists(path: string): Promise<boolean>;
	read(path: string): Promise<string>;
	write(path: string, data: string): Promise<void>;
	remove(path: string): Promise<void>;
	/** Should create intermediate folders (Obsidian's adapter does). */
	mkdir(path: string): Promise<void>;
}

export interface TimerApi {
	setTimeout(fn: () => void, ms: number): unknown;
	clearTimeout(handle: unknown): void;
}

export type InkChange =
	| { type: "load" }
	| { type: "add"; strokes: Stroke[] }
	| { type: "remove"; strokes: Stroke[] }
	/** One undoable step removed `removed` and inserted `added` (lasso edits, or their undo/redo). */
	| { type: "replace"; removed: Stroke[]; added: Stroke[] }
	| { type: "meta" }
	/** Stage K: spaces were added/removed/resized (with strokes removed/added in the same step). */
	| { type: "layout"; removed: Stroke[]; added: Stroke[] }
	/** Reloaded/merged from disk (external change): re-resolve positions of new strokes and re-render. */
	| { type: "sync"; added: Stroke[]; removed: Stroke[] }
	| { type: "rename"; oldPath: string; newPath: string }
	| { type: "delete" };

export type InkListener = (path: string, change: InkChange) => void;

export interface SubscribeOptions {
	/** Called synchronously before each save while this subscriber is the position owner. */
	beforeSave?: (ink: InkFile) => void;
}

export interface InkStoreOptions {
	/** Debounce delay for saves in ms (default 800). */
	debounceMs?: number;
	/** Injectable timers for tests (default: global setTimeout/clearTimeout). */
	timers?: TimerApi;
	/** Root folder for sidecars (default ".pencil"). */
	root?: string;
	/** Max undo depth per file (default 200). */
	maxUndo?: number;
	/** Error sink (default console.error). Saves never reject. */
	onError?: (err: unknown, context: string) => void;
}

interface OpItem {
	stroke: Stroke;
	/** Index in `ink.strokes` at the moment of insertion/removal. */
	index: number;
}

/** Stage K: a space with its index in `ink.spaces` at insertion/removal time. */
interface SpaceItem {
	space: InkSpace;
	index: number;
}

/** Stage K: a space's height before / after an op. */
interface Resize {
	space: InkSpace;
	from: number;
	to: number;
}

/** Stage K: one step that changes spaces (and strokes) together — see `editSpaces`. */
export interface SpaceEdit {
	/** New spaces (index in `ink.spaces`; default: appended). The caller sets `after` (and `pos`). */
	addSpaces?: { space: InkSpace; index?: number }[];
	/** Spaces to remove; every stroke in them is removed too. */
	removeSpaceIds?: string[];
	/** New heights. */
	resize?: { id: string; height: number }[];
	/** Strokes to remove / insert (inserted where the first removed one was, else appended). */
	removeStrokeIds?: string[];
	addStrokes?: readonly Stroke[];
}

type Op =
	| { kind: "add"; items: OpItem[] }
	| { kind: "erase"; items: OpItem[]; batchId?: string }
	/** `before` = removed (index at removal time), `after` = inserted (index at insertion time). */
	| { kind: "replace"; before: OpItem[]; after: OpItem[] }
	/**
	 * Stage K: spaces `removed` / `added` / `resized` and strokes `before` (removed) / `after`
	 * (inserted), as one step. Undo removes `after` and `added`, restores `removed`, the old heights
	 * and `before`; redo the inverse.
	 */
	| { kind: "space"; removed: SpaceItem[]; added: SpaceItem[]; resized: Resize[]; before: OpItem[]; after: OpItem[] };

function opItems(op: Op): OpItem[] {
	return op.kind === "replace" || op.kind === "space" ? [...op.before, ...op.after] : op.items;
}

function spaceItems(op: Op): InkSpace[] {
	return op.kind === "space" ? [...op.removed.map((i) => i.space), ...op.added.map((i) => i.space), ...op.resized.map((r) => r.space)] : [];
}

interface Entry {
	ink: InkFile;
	undo: Op[];
	redo: Op[];
	timer: unknown;
	dirty: boolean;
	/** Serialized content currently on disk; null when no sidecar exists. */
	lastSaved: string | null;
	/** Content currently being written by us (its modify event can arrive before the write resolves). */
	writing?: string;
	/** Tail of the per-file save chain (saves run strictly in order). */
	saving: Promise<void>;
	/** Original text of a damaged sidecar, backed up before the first write. */
	backup: string | null;
	/** Reading the sidecar failed: never write, to avoid clobbering it. */
	readOnly: boolean;
	/** A store rename is moving this entry's sidecar: ignore disk events meanwhile. */
	renaming: boolean;
}

interface Subscription {
	listener: InkListener;
	beforeSave?: (ink: InkFile) => void;
}

const defaultTimers: TimerApi = {
	setTimeout: (fn, ms) => window.setTimeout(fn, ms),
	clearTimeout: (h) => window.clearTimeout(h as number),
};

/** Sidecar path for a note: `.pencil/<notePath>.json`. */
export function sidecarPath(notePath: string, root = ".pencil"): string {
	return `${root}/${notePath}.json`;
}

function sameOrder<T>(a: readonly T[], b: readonly T[]): boolean {
	return a.length === b.length && a.every((x, i) => x === b[i]);
}

function parentDir(path: string): string {
	const i = path.lastIndexOf("/");
	return i <= 0 ? "" : path.slice(0, i);
}

export class InkStore {
	private readonly entries = new Map<string, Entry>();
	private readonly loading = new Map<string, Promise<InkFile>>();
	private readonly subs = new Map<string, Subscription[]>();
	private readonly observers = new Set<InkListener>();
	private readonly debounceMs: number;
	private readonly timers: TimerApi;
	private root: string;
	private readonly maxUndo: number;
	private readonly onError: (err: unknown, context: string) => void;

	constructor(
		private readonly adapter: InkAdapter,
		opts: InkStoreOptions = {},
	) {
		this.debounceMs = opts.debounceMs ?? 800;
		this.timers = opts.timers ?? defaultTimers;
		this.root = opts.root ?? ".pencil";
		this.maxUndo = opts.maxUndo ?? 200;
		this.onError = opts.onError ?? ((err, ctx) => console.error(`[pencil-layer] ${ctx}`, err));
	}

	sidecarPath(notePath: string): string {
		return sidecarPath(notePath, this.root);
	}

	/** The folder sidecars are read from and written to. */
	get rootFolder(): string {
		return this.root;
	}

	/**
	 * Change the sidecar folder (the "Ink folder" setting). Later reads and writes use it; nothing is
	 * moved on disk (the caller moves files, see main.ts `changeInkFolder`). Call `flushAll` first so
	 * pending saves land in the old folder. Loaded notes keep their in-memory ink and write it to the
	 * new folder on their next save.
	 */
	setRoot(root: string): void {
		this.root = root;
	}

	/** Inverse of `sidecarPath`: the note a sidecar belongs to, or null if `path` isn't a sidecar. */
	notePathForSidecar(path: string): string | null {
		const prefix = `${this.root}/`;
		if (!path.startsWith(prefix) || !path.endsWith(".json")) return null;
		const note = path.slice(prefix.length, -".json".length);
		return note ? note : null;
	}

	// -------------------------------------------------------------------------------------------
	// Loading / access
	// -------------------------------------------------------------------------------------------

	/** Load (once) and return the shared InkFile for a note. Concurrent calls share one read. */
	load(path: string): Promise<InkFile> {
		const existing = this.entries.get(path);
		if (existing) return Promise.resolve(existing.ink);
		const pending = this.loading.get(path);
		if (pending) return pending;

		const p = (async () => {
			let text: string | null = null;
			let readOnly = false;
			try {
				const side = this.sidecarPath(path);
				if (await this.adapter.exists(side)) text = await this.adapter.read(side);
			} catch (err) {
				readOnly = true;
				this.onError(err, `failed to read ink for ${path}; saving disabled for this note`);
			}
			// A rename/delete/other load may have raced us; keep whichever entry got there first.
			const raced = this.entries.get(path);
			if (raced) return raced.ink;
			const report: ParseReport = { malformed: false, dropped: 0 };
			const entry: Entry = {
				ink: parseInkFile(text, report),
				undo: [],
				redo: [],
				timer: null,
				dirty: false,
				lastSaved: text,
				saving: Promise.resolve(),
				backup: report.malformed || report.dropped > 0 ? text : null,
				readOnly,
				renaming: false,
			};
			this.entries.set(path, entry);
			this.emit(path, { type: "load" });
			return entry.ink;
		})();
		this.loading.set(path, p);
		const clear = () => {
			if (this.loading.get(path) === p) this.loading.delete(path);
		};
		p.then(clear, clear);
		return p;
	}

	/** The shared InkFile if loaded. Treat as read-only except for `stroke.pos` / `stroke.anchor`. */
	get(path: string): InkFile | undefined {
		return this.entries.get(path)?.ink;
	}

	/** Paths of every loaded note. */
	loadedPaths(): string[] {
		return [...this.entries.keys()];
	}

	isLoaded(path: string): boolean {
		return this.entries.has(path);
	}

	/** Stage K: every space known for the path: in the note plus those in undo/redo stacks. */
	allSpaces(path: string): InkSpace[] {
		const e = this.entries.get(path);
		if (!e) return [];
		const seen = new Set<InkSpace>(e.ink.spaces ?? []);
		for (const op of [...e.undo, ...e.redo]) for (const sp of spaceItems(op)) seen.add(sp);
		return [...seen];
	}

	/** Every stroke known for the path: on the canvas plus those held in undo/redo stacks. */
	allStrokes(path: string): Stroke[] {
		const e = this.entries.get(path);
		if (!e) return [];
		const seen = new Set<Stroke>(e.ink.strokes);
		for (const op of [...e.undo, ...e.redo]) for (const it of opItems(op)) seen.add(it.stroke);
		return [...seen];
	}

	// -------------------------------------------------------------------------------------------
	// Mutations
	// -------------------------------------------------------------------------------------------

	/** Append a finished stroke (undoable). The caller sets `anchor` (and `pos`) first. */
	addStroke(path: string, stroke: Stroke): void {
		const e = this.entries.get(path);
		if (!e) return;
		const index = e.ink.strokes.length;
		e.ink.strokes.push(stroke);
		this.pushOp(e, { kind: "add", items: [{ stroke, index }] });
		this.changed(path, e, { type: "add", strokes: [stroke] });
	}

	/**
	 * Remove strokes by id (undoable). Calls sharing a `batchId` merge into a single undo op when
	 * consecutive. Returns the strokes actually removed (unknown ids are ignored).
	 */
	removeStrokes(path: string, ids: Iterable<string>, batchId?: string): Stroke[] {
		const e = this.entries.get(path);
		if (!e) return [];
		const items: OpItem[] = [];
		for (const id of ids) {
			const index = e.ink.strokes.findIndex((s) => s.id === id);
			if (index < 0) continue;
			const [stroke] = e.ink.strokes.splice(index, 1);
			items.push({ stroke, index });
		}
		if (items.length === 0) return [];

		const top = e.undo[e.undo.length - 1];
		if (batchId !== undefined && top && top.kind === "erase" && top.batchId === batchId && e.redo.length === 0) {
			top.items.push(...items);
		} else {
			this.pushOp(e, { kind: "erase", items, batchId });
		}
		const removed = items.map((i) => i.stroke);
		this.changed(path, e, { type: "remove", strokes: removed });
		return removed;
	}

	/**
	 * Remove strokes by id and insert `add` in their place, as ONE undoable op (lasso move, scale,
	 * recolor; duplicate = nothing removed). The caller sets `anchor`/`pos` of the new strokes and
	 * gives them new ids (see class docs). Unknown ids are ignored. Returns false if nothing changed.
	 */
	replaceStrokes(path: string, removeIds: Iterable<string>, add: readonly Stroke[]): boolean {
		const e = this.entries.get(path);
		if (!e) return false;
		const before: OpItem[] = [];
		for (const id of removeIds) {
			const index = e.ink.strokes.findIndex((s) => s.id === id);
			if (index < 0) continue;
			const [stroke] = e.ink.strokes.splice(index, 1);
			before.push({ stroke, index });
		}
		if (before.length === 0 && add.length === 0) return false;
		let at = e.ink.strokes.length;
		for (const b of before) at = Math.min(at, b.index);
		const after: OpItem[] = add.map((stroke, i) => ({ stroke, index: at + i }));
		e.ink.strokes.splice(at, 0, ...add);
		this.pushOp(e, { kind: "replace", before, after });
		this.changed(path, e, { type: "replace", removed: before.map((i) => i.stroke), added: [...add] });
		return true;
	}

	/**
	 * Stage K: change spaces and strokes as ONE undoable op (add / remove / resize spaces; remove
	 * and insert strokes — e.g. a stroke drawn near a space's bottom that grows it, "Make drawing
	 * space", deleting a space with its ink). Removing a space removes every stroke in it. Unknown
	 * ids are ignored; a resize to the current height is dropped. Returns false if nothing changed.
	 */
	editSpaces(path: string, edit: SpaceEdit): boolean {
		const e = this.entries.get(path);
		if (!e) return false;
		const spaces = (e.ink.spaces ??= []);
		// Strokes first (their indices), then spaces.
		const dropSpaces = new Set(edit.removeSpaceIds ?? []);
		const dropIds = new Set(edit.removeStrokeIds ?? []);
		const before: OpItem[] = [];
		for (let i = 0; i < e.ink.strokes.length; ) {
			const st = e.ink.strokes[i];
			if (dropIds.has(st.id) || (st.space !== undefined && dropSpaces.has(st.space))) {
				e.ink.strokes.splice(i, 1);
				before.push({ stroke: st, index: i }); // index at removal time (restoreItems re-inserts in reverse)
			} else i++;
		}
		const add = edit.addStrokes ?? [];
		let at = e.ink.strokes.length;
		for (const b of before) at = Math.min(at, b.index);
		const after: OpItem[] = add.map((stroke, i) => ({ stroke, index: at + i }));
		e.ink.strokes.splice(at, 0, ...add);
		const removed: SpaceItem[] = [];
		for (const id of dropSpaces) {
			const index = spaces.findIndex((sp) => sp.id === id);
			if (index < 0) continue;
			const [space] = spaces.splice(index, 1);
			removed.push({ space, index });
		}
		const added: SpaceItem[] = [];
		for (const a of edit.addSpaces ?? []) {
			const index = Math.min(Math.max(a.index ?? spaces.length, 0), spaces.length);
			spaces.splice(index, 0, a.space);
			added.push({ space: a.space, index });
		}
		const resized: Resize[] = [];
		for (const r of edit.resize ?? []) {
			const space = spaces.find((sp) => sp.id === r.id);
			if (!space || space.a4 || !Number.isFinite(r.height) || space.height === r.height) continue;
			resized.push({ space, from: space.height, to: r.height });
			space.height = r.height;
		}
		if (before.length === 0 && after.length === 0 && removed.length === 0 && added.length === 0 && resized.length === 0) return false;
		this.pushOp(e, { kind: "space", removed, added, resized, before, after });
		this.changed(path, e, { type: "layout", removed: before.map((i) => i.stroke), added: [...add] });
		return true;
	}

	/** Record the content width (not undoable). */
	setContentWidth(path: string, width: number): void {
		const e = this.entries.get(path);
		if (!e || !Number.isFinite(width) || width <= 0 || e.ink.contentWidth === width) return;
		e.ink.contentWidth = width;
		this.changed(path, e, { type: "meta" }, false);
	}

	canUndo(path: string): boolean {
		return (this.entries.get(path)?.undo.length ?? 0) > 0;
	}

	canRedo(path: string): boolean {
		return (this.entries.get(path)?.redo.length ?? 0) > 0;
	}

	undo(path: string): boolean {
		const e = this.entries.get(path);
		const op = e?.undo.pop();
		if (!e || !op) return false;
		if (op.kind === "add") {
			this.removeItems(e, op.items);
			this.changed(path, e, { type: "remove", strokes: op.items.map((i) => i.stroke) });
		} else if (op.kind === "erase") {
			this.restoreItems(e, op.items);
			this.changed(path, e, { type: "add", strokes: op.items.map((i) => i.stroke) });
		} else if (op.kind === "space") {
			this.removeItems(e, op.after);
			this.removeSpaces(e, op.added);
			this.restoreSpaces(e, op.removed);
			for (let k = op.resized.length - 1; k >= 0; k--) op.resized[k].space.height = op.resized[k].from;
			this.restoreItems(e, op.before);
			this.changed(path, e, { type: "layout", removed: op.after.map((i) => i.stroke), added: op.before.map((i) => i.stroke) });
		} else {
			this.removeItems(e, op.after);
			this.restoreItems(e, op.before);
			this.changed(path, e, {
				type: "replace",
				removed: op.after.map((i) => i.stroke),
				added: op.before.map((i) => i.stroke),
			});
		}
		e.redo.push(op);
		return true;
	}

	redo(path: string): boolean {
		const e = this.entries.get(path);
		const op = e?.redo.pop();
		if (!e || !op) return false;
		if (op.kind === "add") {
			this.restoreItems(e, op.items);
			this.changed(path, e, { type: "add", strokes: op.items.map((i) => i.stroke) });
		} else if (op.kind === "erase") {
			this.removeItems(e, op.items);
			this.changed(path, e, { type: "remove", strokes: op.items.map((i) => i.stroke) });
		} else if (op.kind === "space") {
			this.removeItems(e, op.before);
			for (const r of op.resized) r.space.height = r.to;
			this.removeSpaces(e, op.removed);
			this.restoreSpaces(e, op.added);
			this.insertItems(e, op.after);
			this.changed(path, e, { type: "layout", removed: op.before.map((i) => i.stroke), added: op.after.map((i) => i.stroke) });
		} else {
			this.removeItems(e, op.before);
			this.insertItems(e, op.after);
			this.changed(path, e, {
				type: "replace",
				removed: op.before.map((i) => i.stroke),
				added: op.after.map((i) => i.stroke),
			});
		}
		e.undo.push(op);
		return true;
	}

	/** Mark the file dirty and schedule a save without changing strokes (e.g. after text edits moved anchors). */
	touch(path: string): void {
		const e = this.entries.get(path);
		if (!e) return;
		e.dirty = true;
		this.schedule(path, e);
	}

	// -------------------------------------------------------------------------------------------
	// Positions (see class docs)
	// -------------------------------------------------------------------------------------------

	/**
	 * Map every defined `stroke.pos` (canvas + undo/redo stacks) through `mapper`. When `owner` is
	 * given, the call is ignored unless that listener is the path's position owner.
	 * Returns true if the mapping was applied.
	 *
	 * `assoc` is -1 for `pos` (line starts) and a text highlight's `textRange.to`, +1 for
	 * `textRange.from` (text typed at either edge of a highlight stays outside it). With CM6:
	 * `(p, assoc) => tr.changes.mapPos(p, assoc)`.
	 */
	mapPositions(path: string, mapper: (pos: number, assoc: -1 | 1) => number, owner?: InkListener): boolean {
		if (owner && !this.isPositionOwner(path, owner)) return false;
		// Stage K: spaces follow their lines like stroke anchors.
		for (const sp of this.allSpaces(path)) if (sp.pos !== undefined) sp.pos = mapper(sp.pos, -1);
		for (const s of this.allStrokes(path)) {
			if (s.pos !== undefined) s.pos = mapper(s.pos, -1);
			if (s.textRange) {
				const from = mapper(s.textRange.from, 1);
				s.textRange = { from, to: Math.max(from, mapper(s.textRange.to, -1)) };
			}
			// Stage H: text typed right before the anchor character pushes it (and the ink) along.
			if (s.charPos !== undefined) s.charPos = mapper(s.charPos, 1);
		}
		return true;
	}

	/** Forget all transient positions (and text ranges) for the path (they'll be re-resolved from anchors). */
	clearPositions(path: string): void {
		for (const s of this.allStrokes(path)) {
			delete s.pos;
			delete s.textRange;
			delete s.charPos;
		}
		for (const sp of this.allSpaces(path)) delete sp.pos;
	}

	/** The oldest live subscriber of a path owns position mapping and `beforeSave`. */
	isPositionOwner(path: string, listener: InkListener): boolean {
		return this.subs.get(path)?.[0]?.listener === listener;
	}

	// -------------------------------------------------------------------------------------------
	// Subscriptions
	// -------------------------------------------------------------------------------------------

	/**
	 * Observe changes to EVERY path (e.g. to refresh undo/redo buttons). Observers never become
	 * position owners and get no `beforeSave`. Returns an unsubscribe function.
	 */
	observeAll(listener: InkListener): () => void {
		this.observers.add(listener);
		return () => {
			this.observers.delete(listener);
		};
	}

	/** Listen for changes to a path (may be called before `load`). Returns an unsubscribe function. */
	subscribe(path: string, listener: InkListener, opts: SubscribeOptions = {}): () => void {
		const sub: Subscription = { listener, beforeSave: opts.beforeSave };
		const list = this.subs.get(path) ?? [];
		list.push(sub);
		this.subs.set(path, list);
		let active = true;
		// Looked up by identity at call time, since rename() may move the subscription to a new key.
		return () => {
			if (!active) return;
			active = false;
			for (const [key, subs] of this.subs) {
				const i = subs.indexOf(sub);
				if (i < 0) continue;
				const wasOwner = i === 0;
				const e = this.entries.get(key);
				if (wasOwner && e && sub.beforeSave) this.runHook(sub, e, key);
				subs.splice(i, 1);
				if (subs.length === 0) {
					this.subs.delete(key);
					if (e) {
						// Persist anchors refreshed by beforeSave (write is skipped if unchanged).
						if (!isEmptyInk(e.ink)) e.dirty = true;
						void this.flush(key);
						this.clearPositions(key);
					}
				}
				return;
			}
		};
	}

	// -------------------------------------------------------------------------------------------
	// Persistence
	// -------------------------------------------------------------------------------------------

	/** Save now if dirty (cancels the debounce) and wait for any in-flight save. Never rejects. */
	flush(path: string): Promise<void> {
		const e = this.entries.get(path);
		if (!e) return Promise.resolve();
		if (e.timer !== null) {
			this.timers.clearTimeout(e.timer);
			e.timer = null;
		}
		if (e.dirty) {
			e.dirty = false;
			// Snapshot anchors synchronously so the write reflects the document as of now.
			this.beforeSave(path, e);
			const data = isEmptyInk(e.ink) ? null : serializeInkFile(e.ink);
			e.saving = e.saving.then(() => this.write(path, e, data));
		}
		return e.saving;
	}

	flushAll(): Promise<void> {
		return Promise.all([...this.entries.keys()].map((p) => this.flush(p))).then(() => undefined);
	}

	/**
	 * The sidecar of `path` changed on disk from outside (see "Live sync" above). No-op unless the
	 * note is loaded. Runs after any in-flight save. Resolves to true if the in-memory ink changed.
	 */
	reloadFromDisk(path: string): Promise<boolean> {
		const e = this.entries.get(path);
		if (!e || e.renaming) return Promise.resolve(false);
		let changed = false;
		const run = async () => {
			if (this.entries.get(path) !== e || e.renaming) return;
			const side = this.sidecarPath(path);
			let text: string | null = null;
			try {
				if (await this.adapter.exists(side)) text = await this.adapter.read(side);
			} catch (err) {
				this.onError(err, `failed to re-read ink for ${path}`);
				return;
			}
			if (this.entries.get(path) !== e || e.renaming) return;
			if ((text === e.lastSaved || (text !== null && text === e.writing)) && !e.readOnly) return; // our own write echoing back, or no change
			const report: ParseReport = { malformed: false, dropped: 0 };
			const remote = parseInkFile(text, report);
			if (report.malformed) {
				// Possibly a partially synced file; keep what we have and wait for the next event.
				this.onError(new Error("malformed sidecar"), `ignoring unreadable external change to ${side}`);
				return;
			}
			const baseInk = e.readOnly ? null : parseInkFile(e.lastSaved);
			const base = baseInk?.strokes ?? [];
			const before = e.ink.strokes.slice();
			const merged = mergeStrokes(base, before, remote.strokes);
			// Stage K: spaces merge by id the same way (heights field-wise).
			const spacesBefore = (e.ink.spaces ?? []).slice();
			const heightsBefore = spacesBefore.map((sp) => sp.height);
			const spaces = mergeSpaces(baseInk?.spaces ?? [], spacesBefore, remote.spaces ?? []);
			const layoutChanged = !sameOrder(spacesBefore, spaces) || spacesBefore.some((sp, i) => sp.height !== heightsBefore[i]);
			e.ink.spaces = spaces;
			e.lastSaved = text;
			e.readOnly = false;
			e.backup = report.dropped > 0 ? text : null;
			if (remote.contentWidth > 0) e.ink.contentWidth = remote.contentWidth;
			const kept = new Set(merged);
			const removed = before.filter((st) => !kept.has(st));
			const old = new Set(before);
			const added = merged.filter((st) => !old.has(st));
			e.ink.strokes.splice(0, e.ink.strokes.length, ...merged);
			this.pruneHistory(e);
			// Unsaved local edits survive the merge and get written back on the normal debounce.
			if (e.dirty) this.schedule(path, e);
			changed = added.length > 0 || removed.length > 0 || !sameOrder(before, merged) || layoutChanged;
			if (changed) this.emit(path, { type: "sync", added, removed });
		};
		e.saving = e.saving.then(run, run).catch((err) => this.onError(err, `reload failed for ${path}`));
		return e.saving.then(() => changed);
	}

	/** Note renamed: move sidecar, in-memory entry, undo history and listeners. */
	async rename(oldPath: string, newPath: string): Promise<void> {
		if (oldPath === newPath) return;
		const e = this.entries.get(oldPath);
		if (e) e.renaming = true;
		try {
			await this.renameInner(oldPath, newPath, e);
		} finally {
			if (e) e.renaming = false;
		}
	}

	private async renameInner(oldPath: string, newPath: string, e: Entry | undefined): Promise<void> {
		if (e) {
			if (e.timer !== null) {
				this.timers.clearTimeout(e.timer);
				e.timer = null;
				e.dirty = true;
			}
			await e.saving;
			this.entries.delete(oldPath);
			this.entries.set(newPath, e);
		}
		const subs = this.subs.get(oldPath);
		if (subs) {
			this.subs.delete(oldPath);
			this.subs.set(newPath, [...(this.subs.get(newPath) ?? []), ...subs]);
		}

		const from = this.sidecarPath(oldPath);
		const to = this.sidecarPath(newPath);
		let moved: string | null = null;
		try {
			if (await this.adapter.exists(from)) {
				moved = await this.adapter.read(from);
				await this.ensureParent(to);
				await this.adapter.write(to, moved);
				await this.adapter.remove(from);
			}
		} catch (err) {
			this.onError(err, `failed to move ink ${from} -> ${to}`);
		}
		if (e) {
			e.lastSaved = moved;
			if (e.dirty) await this.flush(newPath);
		}
		this.emit(newPath, { type: "rename", oldPath, newPath });
	}

	/** Note deleted: drop in-memory state and remove the sidecar. */
	async delete(path: string): Promise<void> {
		const e = this.entries.get(path);
		if (e) {
			if (e.timer !== null) this.timers.clearTimeout(e.timer);
			e.timer = null;
			e.dirty = false;
			await e.saving;
			this.entries.delete(path);
		}
		try {
			const side = this.sidecarPath(path);
			if (await this.adapter.exists(side)) await this.adapter.remove(side);
		} catch (err) {
			this.onError(err, `failed to delete ink for ${path}`);
		}
		this.emit(path, { type: "delete" });
	}

	/** Flush everything and cancel timers (call from Plugin.onunload). */
	async dispose(): Promise<void> {
		await this.flushAll();
	}

	// -------------------------------------------------------------------------------------------
	// Internals
	// -------------------------------------------------------------------------------------------

	/**
	 * After an external merge, drop undo/redo items that no longer make sense. Items that the op
	 * would REMOVE must be on the canvas (by identity): undo-add, redo-erase, undo-replace `after`,
	 * redo-replace `before`. Items it would RESTORE must have an id NOT on the canvas (else restoring
	 * would duplicate): undo-erase, redo-add, undo-replace `before`, redo-replace `after`. Empty ops go.
	 */
	private pruneHistory(e: Entry): void {
		const onCanvas = new Set(e.ink.strokes);
		const ids = new Set(e.ink.strokes.map((st) => st.id));
		const present = (it: OpItem) => onCanvas.has(it.stroke);
		const absent = (it: OpItem) => !ids.has(it.stroke.id);
		const prune = (ops: Op[], isUndo: boolean) => {
			for (let i = ops.length - 1; i >= 0; i--) {
				const op = ops[i];
				let empty: boolean;
				if (op.kind === "space") continue; // pruned by pruneSpaces below
				if (op.kind === "replace") {
					op.before = op.before.filter(isUndo ? absent : present);
					op.after = op.after.filter(isUndo ? present : absent);
					empty = op.before.length === 0 && op.after.length === 0;
				} else {
					const removes = (op.kind === "add") === isUndo;
					op.items = op.items.filter(removes ? present : absent);
					empty = op.items.length === 0;
				}
				if (empty) ops.splice(i, 1);
			}
		};
		prune(e.undo, true);
		prune(e.redo, false);
		// Stage K: space ops. Undo removes `added` and `after` (must be present) and restores
		// `removed` and `before` (must be absent); resizes need their space on the canvas.
		const spacesOn = new Set<InkSpace>(e.ink.spaces ?? []);
		const spaceIds = new Set<string>((e.ink.spaces ?? []).map((sp) => sp.id));
		const sPresent = (it: SpaceItem) => spacesOn.has(it.space);
		const sAbsent = (it: SpaceItem) => !spaceIds.has(it.space.id);
		const pruneSpaces = (ops: Op[], isUndo: boolean) => {
			for (let i = ops.length - 1; i >= 0; i--) {
				const op = ops[i];
				if (op.kind !== "space") continue;
				op.added = op.added.filter(isUndo ? sPresent : sAbsent);
				op.removed = op.removed.filter(isUndo ? sAbsent : sPresent);
				op.before = op.before.filter(isUndo ? absent : present);
				op.after = op.after.filter(isUndo ? present : absent);
				const kept = new Set<InkSpace>([...spacesOn, ...op.added.map((x) => x.space), ...op.removed.map((x) => x.space)]);
				op.resized = op.resized.filter((r) => kept.has(r.space));
				if (op.added.length + op.removed.length + op.before.length + op.after.length + op.resized.length === 0) ops.splice(i, 1);
			}
		};
		pruneSpaces(e.undo, true);
		pruneSpaces(e.redo, false);
	}

	/** Stage K: remove spaces by identity. */
	private removeSpaces(e: Entry, items: SpaceItem[]): void {
		const list = (e.ink.spaces ??= []);
		for (const it of items) {
			const i = list.indexOf(it.space);
			if (i >= 0) list.splice(i, 1);
		}
	}

	/** Stage K: re-insert spaces at their recorded indices (reverse order: inverse of removal). */
	private restoreSpaces(e: Entry, items: SpaceItem[]): void {
		const list = (e.ink.spaces ??= []);
		for (let k = items.length - 1; k >= 0; k--) list.splice(Math.min(Math.max(items[k].index, 0), list.length), 0, items[k].space);
	}

	private pushOp(e: Entry, op: Op): void {
		e.undo.push(op);
		if (e.undo.length > this.maxUndo) e.undo.shift();
		e.redo.length = 0;
	}

	/** Remove op items by identity (in recorded order). */
	private removeItems(e: Entry, items: OpItem[]): void {
		for (const it of items) {
			const i = e.ink.strokes.indexOf(it.stroke);
			if (i >= 0) e.ink.strokes.splice(i, 1);
		}
	}

	/** Insert items at their recorded indices in recorded (ascending) order — redo of an insertion. */
	private insertItems(e: Entry, items: OpItem[]): void {
		for (const it of items) {
			const at = Math.min(Math.max(it.index, 0), e.ink.strokes.length);
			e.ink.strokes.splice(at, 0, it.stroke);
		}
	}

	/** Re-insert items at their recorded indices — exact inverse of removal (reverse order). */
	private restoreItems(e: Entry, items: OpItem[]): void {
		for (let k = items.length - 1; k >= 0; k--) {
			const it = items[k];
			const at = Math.min(Math.max(it.index, 0), e.ink.strokes.length);
			e.ink.strokes.splice(at, 0, it.stroke);
		}
	}

	private changed(path: string, e: Entry, change: InkChange, notify = true): void {
		e.dirty = true;
		this.schedule(path, e);
		if (notify) this.emit(path, change);
	}

	private schedule(path: string, e: Entry): void {
		if (e.timer !== null) this.timers.clearTimeout(e.timer);
		e.timer = this.timers.setTimeout(() => {
			e.timer = null;
			void this.flush(path);
		}, this.debounceMs);
	}

	private emit(path: string, change: InkChange): void {
		const listeners = [...(this.subs.get(path) ?? []).map((s) => s.listener), ...this.observers];
		for (const l of listeners) {
			try {
				l(path, change);
			} catch (err) {
				this.onError(err, "ink listener threw");
			}
		}
	}

	private beforeSave(path: string, e: Entry): void {
		const owner = this.subs.get(path)?.[0];
		if (owner?.beforeSave) this.runHook(owner, e, path);
	}

	private runHook(sub: Subscription, e: Entry, path: string): void {
		try {
			sub.beforeSave?.(e.ink);
		} catch (err) {
			this.onError(err, `beforeSave threw for ${path}`);
		}
	}

	private async write(path: string, e: Entry, data: string | null): Promise<void> {
		const side = this.sidecarPath(path);
		if (e.readOnly) {
			this.onError(new Error("sidecar could not be read"), `not saving ink for ${path}`);
			return;
		}
		try {
			// A damaged sidecar is never deleted just because nothing could be parsed from it.
			if (data === null && e.backup !== null) return;
			if (e.backup !== null && data !== e.lastSaved) {
				await this.adapter.write(`${side}.bak`, e.backup);
				e.backup = null;
			}
			if (data === null) {
				if (await this.adapter.exists(side)) await this.adapter.remove(side);
				e.lastSaved = null;
			} else if (data !== e.lastSaved) {
				await this.ensureParent(side);
				e.writing = data;
				try {
					await this.adapter.write(side, data);
				} finally {
					e.writing = undefined;
				}
				e.lastSaved = data;
			}
		} catch (err) {
			// Keep the change pending so the next flush retries.
			e.dirty = true;
			this.onError(err, `failed to save ink for ${path}`);
		}
	}

	private async ensureParent(file: string): Promise<void> {
		const dir = parentDir(file);
		if (dir && !(await this.adapter.exists(dir))) await this.adapter.mkdir(dir);
	}
}

