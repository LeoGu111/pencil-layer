/**
 * Public API for other plugins: `app.plugins.plugins["pencil-layer"].api` (see DESIGN.md
 * "Public API (for other plugins)"). Thin Obsidian glue; the remapping logic is in inkCopy.ts.
 */
import type { EditorView } from "@codemirror/view";
import { App, MarkdownView, TFile } from "obsidian";
import type { InkStore } from "./store";
import { isEmptyInk } from "./model";
import { copyInkData, inkLinesOf, splitLines } from "./inkCopy";
import { layoutDrawings } from "./inkDrawings";
import { renderDrawingPng } from "./drawingPng";

/** One drawing of a note rendered as an image (see `PencilLayerApi.inkDrawings`). */
export interface InkDrawing {
	/** 0-based line, numbered like `inkLines`: a space's display line / a margin cluster's first anchor line. */
	line: number;
	/** Every line the drawing hangs off (sorted; all of them are in `inkLines`). */
	lines: number[];
	kind: "space" | "margin";
	/** Base64 PNG (no `data:` prefix): white background, dark ink, cropped to the ink + a small margin. */
	png: string;
	/** Pixel size of the PNG. */
	width: number;
	height: number;
}

export interface PencilLayerApi {
	version: 1;
	/**
	 * 0-based lines of the note's CURRENT text that ink is attached to, sorted, unique:
	 * the anchor line of every line-anchored stroke (resolved against the current text with the
	 * same resolveAnchor logic the editor uses), and for every drawing space the line it is SHOWN
	 * after (block end per spaces.ts blockEnds/displayLine; an "end" space → the last line).
	 * Empty array if the note has no ink.
	 */
	inkLines(file: TFile): Promise<number[]>;
	/**
	 * Copy all ink of `src` into `dst` (dst must already exist with its final text; any ink dst
	 * already has is replaced). `lineMap`: src 0-based line → dst 0-based line, keyed by the lines
	 * inkLines(src) returned. Each stroke/space keeps its position relative to its line/space top
	 * (x unchanged). Ink whose src line is missing from lineMap, or maps out of range, goes to the
	 * end of dst (spaces become "end" spaces; line-anchored strokes anchor to dst's last line) and
	 * is counted in `unplaced`. The src note's ink is never modified.
	 */
	copyInk(src: TFile, dst: TFile, lineMap: ReadonlyMap<number, number>): Promise<{ strokes: number; spaces: number; unplaced: number }>;
	/**
	 * (Added within version 1 — callers must check it exists.) The note's drawings as PNGs: one per
	 * drawing space with pen ink, and one per cluster of line-anchored pen ink (strokes whose boxes
	 * are within about a line height of each other). Highlighters are skipped. Sorted by `line`.
	 * Margin clusters spanning several lines use the open editor's real line tops when the note is
	 * open in one, else an approximate fixed line height (see inkDrawings.ts). Long side ≤ 1500 px.
	 */
	inkDrawings(file: TFile): Promise<InkDrawing[]>;
}

export function createApi(app: App, store: () => InkStore): PencilLayerApi {
	/** The note's editor, if it is open in one (its text may be newer than the file). */
	const openView = (file: TFile): MarkdownView | null => {
		for (const leaf of app.workspace.getLeavesOfType("markdown")) {
			const v = leaf.view;
			if (v instanceof MarkdownView && v.file?.path === file.path) return v;
		}
		return null;
	};
	const textOf = async (file: TFile): Promise<string[]> => {
		const v = openView(file);
		return splitLines(v ? v.editor.getValue() : await app.vault.read(file));
	};
	/**
	 * The note's ink through the store, with anchors matching its current text: if it is open, the
	 * editor holds live positions — a save refreshes the anchors from them (`beforeSave`; nothing is
	 * written when they didn't change).
	 */
	const inkOf = async (file: TFile) => {
		const s = store();
		const ink = await s.load(file.path);
		if (openView(file) && !isEmptyInk(ink)) {
			s.touch(file.path);
			await s.flush(file.path);
		}
		return ink;
	};

	return {
		version: 1,
		async inkLines(file) {
			const [ink, lines] = await Promise.all([inkOf(file), textOf(file)]);
			return inkLinesOf(ink, lines);
		},
		async copyInk(src, dst, lineMap) {
			if (src.path === dst.path) throw new Error("Pencil Layer copyInk: src and dst are the same note");
			const s = store();
			const ink = await inkOf(src);
			const [srcLines, dstLines] = await Promise.all([textOf(src), textOf(dst)]);
			const res = copyInkData(ink, srcLines, dstLines, lineMap);
			const cur = await s.load(dst.path);
			// One ink undo step in dst; open views of dst get a "layout" change and resolve positions.
			s.editSpaces(dst.path, {
				removeSpaceIds: (cur.spaces ?? []).map((sp) => sp.id),
				removeStrokeIds: cur.strokes.map((st) => st.id),
				addSpaces: (res.ink.spaces ?? []).map((space) => ({ space })),
				addStrokes: res.ink.strokes,
			});
			s.setContentWidth(dst.path, res.ink.contentWidth);
			await s.flush(dst.path);
			return { strokes: res.strokes, spaces: res.spaces, unplaced: res.unplaced };
		},
		async inkDrawings(file) {
			const [ink, lines] = await Promise.all([inkOf(file), textOf(file)]);
			// Live layout when open: the same line tops the ink overlay uses (inkView `lineTop`).
			const cm = (openView(file)?.editor as unknown as { cm?: EditorView } | undefined)?.cm;
			const lineTop = cm
				? (line: number): number | null => {
						const doc = cm.state.doc;
						if (doc.lines !== lines.length || line < 0 || line >= doc.lines) return null;
						return cm.lineBlockAt(doc.line(line + 1).from).top;
					}
				: undefined;
			const out: InkDrawing[] = [];
			for (const d of layoutDrawings(ink, lines, { lineTop })) {
				const img = renderDrawingPng(d);
				if (img) out.push({ line: d.line, lines: d.lines, kind: d.kind, ...img });
			}
			return out;
		},
	};
}
