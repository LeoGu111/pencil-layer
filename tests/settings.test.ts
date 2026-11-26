import { describe, expect, it } from "vitest";
import {
	DEFAULT_PEN_WIDTHS,
	DEFAULT_SYNCED,
	HIGHLIGHTER_COLORS,
	HIGHLIGHTER_WIDTHS,
	PEN_COLORS,
	defaultLocal,
	erasable,
	lassoSelects,
	localOnly,
	toolTap,
	sanitizeHoldMs,
	sanitizeLocal,
	needsLocalMigration,
	sanitizeSynced,
	sanitizeFolder,
	sanitizeWidth,
	splitPatch,
	strokeParams,
	syncedOnly,
	toggleEraser,
} from "../src/settings";

describe("palettes", () => {
	it("pen colors are in the specified order, starting with theme ink", () => {
		expect(PEN_COLORS.map((c) => c.value)).toEqual(["ink", "#FF0000", "#03468F", "#F59A23", "#93419C", "#007355", "#F65353"]);
	});
	it("highlighter colors are the four neons", () => {
		expect(HIGHLIGHTER_COLORS.map((c) => c.value)).toEqual(["#39FF14", "#FFF01F", "#BC13FE", "#1F51FF"]);
	});
});

describe("defaults", () => {
	it("pen widths match GoodNotes on-screen thickness", () => {
		expect(DEFAULT_PEN_WIDTHS).toEqual({ thin: 1.6, dashed: 1.6, thick: 2.7 });
	});
	it("default pen is a thin black ballpoint", () => {
		expect(DEFAULT_SYNCED).toMatchObject({ tool: "pen", penPreset: "thin", penColor: "ink", penFeel: "ball" });
	});
	it("toolbar is shown on desktop (Stage F slim Select bar) and on mobile; mouse draws off", () => {
		expect(defaultLocal(false)).toMatchObject({ toolbarVisible: true, mouseDraws: false, toolbarPos: null, toolbarCollapsed: false });
		expect(defaultLocal(true)).toMatchObject({ toolbarVisible: true, mouseDraws: false, toolbarPos: null, toolbarCollapsed: false });
	});
});

describe("sanitizeSynced", () => {
	it("returns defaults for nothing / garbage", () => {
		for (const raw of [null, undefined, 42, "x", []]) expect(sanitizeSynced(raw)).toEqual(DEFAULT_SYNCED);
	});

	it("migrates M1 data.json: drops per-device and size keys, resets off-palette colors", () => {
		const m1 = {
			tool: "highlighter",
			penColor: "#2563eb",
			highlighterColor: "#facc15",
			penSize: "L",
			highlighterSize: "S",
			mouseDraws: true,
			inkVisible: false,
			toolbarVisible: true,
		};
		const s = sanitizeSynced(m1);
		expect(s.tool).toBe("highlighter");
		expect(s.penColor).toBe("ink");
		expect(s.highlighterColor).toBe(HIGHLIGHTER_COLORS[0].value);
		expect(s.inkVisible).toBe(false);
		expect(s).not.toHaveProperty("toolbarVisible");
		expect(s).not.toHaveProperty("mouseDraws");
		expect(s).not.toHaveProperty("penSize");
	});

	it("keeps valid values", () => {
		const s = sanitizeSynced({
			tool: "eraser",
			penPreset: "dashed",
			penColor: "#93419C",
			highlighterColor: "#BC13FE",
			highlighterWidth: "wide",
			penFeel: "notes",
			penWidths: { thin: 1.2, dashed: 2, thick: 3.333 },
		});
		expect(s).toMatchObject({
			tool: "eraser",
			penPreset: "dashed",
			penColor: "#93419C",
			highlighterColor: "#BC13FE",
			highlighterWidth: "wide",
			penFeel: "notes",
			penWidths: { thin: 1.2, dashed: 2, thick: 3.3 },
		});
	});

	it("migrates Stage A's dotted preset and width to dashed", () => {
		const s = sanitizeSynced({ penPreset: "dotted", penWidths: { thin: 1.6, dotted: 2.2, thick: 2.7 } });
		expect(s.penPreset).toBe("dashed");
		expect(s.penWidths).toEqual({ thin: 1.6, dashed: 2.2, thick: 2.7 });
		expect(s.penWidths).not.toHaveProperty("dotted");
	});

	it("repairs invalid widths individually", () => {
		const s = sanitizeSynced({ penWidths: { thin: -1, dashed: "abc", thick: 999 } });
		expect(s.penWidths).toEqual({ thin: 1.6, dashed: 1.6, thick: 20 });
	});
});

describe("sanitizeWidth", () => {
	it("parses strings from the settings text field and clamps", () => {
		expect(sanitizeWidth("2.25", 1)).toBe(2.3);
		expect(sanitizeWidth("0.1", 1)).toBe(0.5);
		expect(sanitizeWidth("", 1)).toBe(1);
		expect(Number.isNaN(sanitizeWidth("x", NaN))).toBe(true);
	});
});

describe("sanitizeLocal", () => {
	it("uses platform defaults when nothing is stored", () => {
		expect(sanitizeLocal(null, false).toolbarVisible).toBe(true);
		expect(sanitizeLocal(null, true).toolbarVisible).toBe(true);
	});
	it("keeps stored values; mouse draws is forced off on mobile", () => {
		expect(sanitizeLocal({ toolbarVisible: true, mouseDraws: true }, false)).toMatchObject({ toolbarVisible: true, mouseDraws: true });
		expect(sanitizeLocal({ toolbarVisible: false, mouseDraws: true }, true)).toMatchObject({ toolbarVisible: false, mouseDraws: false });
		expect(sanitizeLocal({ toolbarVisible: false, localVersion: 2 }, false).toolbarVisible).toBe(false);
	});
	it("keeps the floating toolbar position/collapsed state (per device), repairing garbage", () => {
		expect(sanitizeLocal({ toolbarPos: { x: 0.25, y: 0.9 }, toolbarCollapsed: true }, true)).toMatchObject({
			toolbarPos: { x: 0.25, y: 0.9 },
			toolbarCollapsed: true,
		});
		expect(sanitizeLocal({ toolbarPos: { x: 5, y: -1 } }, true).toolbarPos).toEqual({ x: 1, y: 0 });
		expect(sanitizeLocal({ toolbarPos: { x: "a", y: 1 }, toolbarCollapsed: "yes" }, true)).toMatchObject({
			toolbarPos: null,
			toolbarCollapsed: false,
		});
		const { local, synced } = splitPatch({ toolbarPos: null, toolbarCollapsed: true, smoothing: "strong" });
		expect(Object.keys(local).sort()).toEqual(["toolbarCollapsed", "toolbarPos"]);
		expect(synced).toEqual({ smoothing: "strong" });
	});
	it("Stage D: include ink in PDF export is per device, default on", () => {
		expect(sanitizeLocal(null, false).includeInkInPdf).toBe(true);
		expect(sanitizeLocal(null, true).includeInkInPdf).toBe(true);
		expect(sanitizeLocal({ includeInkInPdf: false }, true).includeInkInPdf).toBe(false);
		expect(sanitizeLocal({ includeInkInPdf: "no" }, false).includeInkInPdf).toBe(true);
		expect(splitPatch({ includeInkInPdf: false }).local).toEqual({ includeInkInPdf: false });
	});
	it("Stage K: page view is gone (a stored value is ignored)", () => {
		expect("pageView" in sanitizeLocal({ pageView: true }, true)).toBe(false);
	});
	it("document-style export: font and default style are synced, sanitized, default themed/serif", () => {
		expect(sanitizeSynced(null)).toMatchObject({ defaultExportStyle: "themed", docExportFont: "serif" });
		expect(sanitizeSynced({ defaultExportStyle: "document", docExportFont: "sans" })).toMatchObject({ defaultExportStyle: "document", docExportFont: "sans" });
		expect(sanitizeSynced({ defaultExportStyle: "word", docExportFont: "comic" })).toMatchObject({ defaultExportStyle: "themed", docExportFont: "serif" });
		expect(splitPatch({ docExportFont: "sans", defaultExportStyle: "document" }).synced).toEqual({ docExportFont: "sans", defaultExportStyle: "document" });
	});
	it("smoothing defaults to medium and rejects unknown levels", () => {
		expect(sanitizeSynced(null).smoothing).toBe("medium");
		expect(sanitizeSynced({ smoothing: "light" }).smoothing).toBe("light");
		expect(sanitizeSynced({ smoothing: "max" }).smoothing).toBe("medium");
	});
});

describe("splitPatch / syncedOnly", () => {
	it("routes per-device keys to local storage and the rest to data.json", () => {
		const { synced, local } = splitPatch({ toolbarVisible: true, tool: "pen", mouseDraws: false, penColor: "ink" });
		expect(local).toEqual({ toolbarVisible: true, mouseDraws: false });
		expect(synced).toEqual({ tool: "pen", penColor: "ink" });
	});
	it("syncedOnly never contains device keys", () => {
		const s = syncedOnly({ ...DEFAULT_SYNCED, ...defaultLocal(true), toolbarPos: { x: 0.2, y: 1 }, toolbarCollapsed: true });
		expect(s).toEqual(DEFAULT_SYNCED);
		expect(localOnly({ ...DEFAULT_SYNCED, ...defaultLocal(false) })).toEqual(defaultLocal(false));
	});
});

describe("strokeParams", () => {
	const base = { ...DEFAULT_SYNCED };
	it("pen presets map to widths and styles", () => {
		expect(strokeParams({ ...base, penPreset: "thin" }, "pen")).toEqual({ tool: "pen", color: "ink", size: 1.6, style: "ball" });
		expect(strokeParams({ ...base, penPreset: "thick" }, "pen")).toMatchObject({ size: 2.7, style: "ball" });
		expect(strokeParams({ ...base, penPreset: "dashed" }, "pen")).toMatchObject({ size: 1.6, style: "dashed" });
	});
	it("Notes feel applies to thin/thick but dashed stays ballpoint", () => {
		const notes = { ...base, penFeel: "notes" as const };
		expect(strokeParams({ ...notes, penPreset: "thin" }, "pen").style).toBe("notes");
		expect(strokeParams({ ...notes, penPreset: "thick" }, "pen").style).toBe("notes");
		expect(strokeParams({ ...notes, penPreset: "dashed" }, "pen").style).toBe("dashed");
	});
	it("uses custom widths", () => {
		expect(strokeParams({ ...base, penWidths: { thin: 1, dashed: 2, thick: 3 }, penPreset: "dashed" }, "pen").size).toBe(2);
	});
	it("highlighter has no style and uses its own width/color", () => {
		const p = strokeParams({ ...base, highlighterWidth: "wide", highlighterColor: "#FFF01F" }, "highlighter");
		expect(p).toEqual({ tool: "highlighter", color: "#FFF01F", size: HIGHLIGHTER_WIDTHS.wide });
	});
});

describe("toolTap (Stage E)", () => {
	it("first tap on an inactive tool selects it", () => {
		expect(toolTap("pen", "eraser")).toEqual({ select: "eraser" });
		expect(toolTap("eraser", "pen")).toEqual({ select: "pen" });
	});
	it("tap on the active tool opens its popover (no more eraser → previous tool)", () => {
		expect(toolTap("eraser", "eraser")).toEqual({ popover: "eraser" });
		expect(toolTap("lasso", "lasso")).toEqual({ popover: "lasso" });
	});
});

describe("Stage E tool options", () => {
	it("defaults: stroke eraser M, erases everything, freehand highlighter, lasso selects both", () => {
		expect(defaultLocal(true)).toMatchObject({
			toolbarEdge: "bottom",
			eraserMode: "stroke",
			eraserSize: "m",
			eraseHighlighterOnly: false,
			highlighterStraight: false,
			highlighterSnapText: true,
			lassoFilter: "both",
		});
	});
	it("are per device and sanitized", () => {
		const { local, synced } = splitPatch({ eraserMode: "precise", lassoFilter: "pen", toolbarEdge: "left", penFeel: "notes" });
		expect(Object.keys(local).sort()).toEqual(["eraserMode", "lassoFilter", "toolbarEdge"]);
		expect(synced).toEqual({ penFeel: "notes" });
		expect(
			sanitizeLocal({ eraserMode: "precise", eraserSize: "l", eraseHighlighterOnly: true, highlighterStraight: true, lassoFilter: "highlighter", toolbarEdge: "right" }, true),
		).toMatchObject({ eraserMode: "precise", eraserSize: "l", eraseHighlighterOnly: true, highlighterStraight: true, lassoFilter: "highlighter", toolbarEdge: "right" });
		expect(sanitizeLocal({ eraserMode: "x", eraserSize: 3, lassoFilter: "all", toolbarEdge: "middle", highlighterSnapText: "no" }, true)).toMatchObject({
			eraserMode: "stroke",
			eraserSize: "m",
			lassoFilter: "both",
			toolbarEdge: "bottom",
			highlighterSnapText: true,
		});
	});
	it("eraser and lasso filters", () => {
		expect(erasable("pen", false)).toBe(true);
		expect(erasable("pen", true)).toBe(false);
		expect(erasable("highlighter", true)).toBe(true);
		expect(lassoSelects("pen", "both")).toBe(true);
		expect(lassoSelects("highlighter", "pen")).toBe(false);
		expect(lassoSelects("highlighter", "highlighter")).toBe(true);
	});
});

describe("Stage B settings", () => {
	it("defaults: shape snap on (500 ms), double-tap eraser OFF, scribble erase ON", () => {
		const d = sanitizeSynced(null);
		expect(d.shapeSnap).toBe(true);
		expect(d.shapeHoldMs).toBe(500);
		expect(d.doubleTapEraser).toBe(false);
		expect(d.scribbleErase).toBe(true);
	});

	it("migrates pre-Stage-E data.json once: double-tap off, 450 ms default → 500 ms", () => {
		const old = sanitizeSynced({ doubleTapEraser: true, shapeHoldMs: 450 });
		expect(old).toMatchObject({ doubleTapEraser: false, shapeHoldMs: 500, settingsVersion: 4 });
		// A custom hold delay is kept.
		expect(sanitizeSynced({ shapeHoldMs: 700 }).shapeHoldMs).toBe(700);
		// Version 2 files keep what the user chose.
		expect(sanitizeSynced({ settingsVersion: 2, doubleTapEraser: true, shapeHoldMs: 450 })).toMatchObject({ doubleTapEraser: true, shapeHoldMs: 450 });
	});

	it("keeps valid values and repairs invalid ones", () => {
		const s = sanitizeSynced({ settingsVersion: 2, shapeSnap: false, shapeHoldMs: 700, doubleTapEraser: true, scribbleErase: true, tool: "lasso" });
		expect(s).toMatchObject({ shapeSnap: false, shapeHoldMs: 700, doubleTapEraser: true, scribbleErase: true, tool: "lasso" });
		const bad = sanitizeSynced({ shapeSnap: "yes", shapeHoldMs: "abc", scribbleErase: 1 });
		expect(bad).toMatchObject({ shapeSnap: true, shapeHoldMs: 500, scribbleErase: true });
	});

	it("hold delay is clamped and parsed from text", () => {
		expect(sanitizeHoldMs("600")).toBe(600);
		expect(sanitizeHoldMs(10)).toBe(200);
		expect(sanitizeHoldMs(99999)).toBe(1500);
		expect(sanitizeHoldMs(NaN, 333)).toBe(333);
	});

	it("new keys are synced (data.json), not per device", () => {
		const { synced, local } = splitPatch({ shapeSnap: false, scribbleErase: true });
		expect(Object.keys(local)).toEqual([]);
		expect(Object.keys(synced).sort()).toEqual(["scribbleErase", "shapeSnap"]);
	});

	it("toggleEraser: tool ↔ eraser", () => {
		expect(toggleEraser("pen", null)).toBe("eraser");
		expect(toggleEraser("lasso", "pen")).toBe("eraser");
		expect(toggleEraser("eraser", "highlighter")).toBe("highlighter");
		expect(toggleEraser("eraser", "lasso")).toBe("lasso");
		expect(toggleEraser("eraser", null)).toBe("pen");
	});
});

describe("Stage F per-device settings", () => {
	it("select mode defaults to rectangle and is per device", () => {
		expect(defaultLocal(false).selectMode).toBe("rect");
		expect(sanitizeLocal({ selectMode: "lasso" }, false).selectMode).toBe("lasso");
		expect(sanitizeLocal({ selectMode: "circle" }, false).selectMode).toBe("rect");
		expect(Object.keys(splitPatch({ selectMode: "lasso" }).local)).toEqual(["selectMode"]);
	});
	it("migrates pre-Stage-F desktop storage: the old hidden default becomes shown", () => {
		// Every local save wrote all keys, so false here was (almost always) the old desktop default.
		expect(needsLocalMigration({ toolbarVisible: false, mouseDraws: false })).toBe(true);
		expect(sanitizeLocal({ toolbarVisible: false, mouseDraws: false }, false).toolbarVisible).toBe(true);
		expect(sanitizeLocal({ toolbarVisible: true }, false).toolbarVisible).toBe(true);
		// Mobile values are kept.
		expect(sanitizeLocal({ toolbarVisible: false }, true).toolbarVisible).toBe(false);
		// Once migrated (version 2 written), hiding sticks.
		expect(needsLocalMigration({ toolbarVisible: false, localVersion: 2 })).toBe(false);
		expect(sanitizeLocal({ toolbarVisible: false, localVersion: 2 }, false).toolbarVisible).toBe(false);
		// Nothing stored: nothing to migrate; output always carries the current version.
		expect(needsLocalMigration(null)).toBe(false);
		expect(sanitizeLocal({ toolbarVisible: false }, false).localVersion).toBe(2);
	});
});

describe("folder settings", () => {
	it("default to the folders used before they were configurable", () => {
		expect(sanitizeSynced(null).inkFolder).toBe("Attachments/Ink");
		expect(sanitizeSynced({}).screenshotFolder).toBe("Attachments/Screenshots");
	});
	it("are kept (normalized) when valid", () => {
		const s = sanitizeSynced({ inkFolder: " /Ink data//sub/ ", screenshotFolder: "Pics\\Shots" });
		expect(s.inkFolder).toBe("Ink data/sub");
		expect(s.screenshotFolder).toBe("Pics/Shots");
	});
	it("fall back for empty, hidden, out-of-vault or non-string values", () => {
		for (const v of ["", "  ", "/", ".pencil", "a/.hidden", "../x", 5, null]) expect(sanitizeFolder(v, "D")).toBe("D");
		expect(sanitizeFolder("./a/./b", "D")).toBe("a/b");
	});
	it("are synced, not per device", () => {
		expect(Object.keys(splitPatch({ inkFolder: "X", screenshotFolder: "Y" }).synced)).toEqual(["inkFolder", "screenshotFolder"]);
	});
});

describe("penDevice (desktop pen detected)", () => {
	it("defaults off, is per device, and never applies on mobile", () => {
		expect(sanitizeLocal(null, false).penDevice).toBe(false);
		expect(sanitizeLocal({ penDevice: true }, false).penDevice).toBe(true);
		expect(sanitizeLocal({ penDevice: true }, true).penDevice).toBe(false);
		expect(Object.keys(splitPatch({ penDevice: true }).local)).toEqual(["penDevice"]);
	});
});

describe("Apple Pencil feel, tilt & gestures settings", () => {
	it("supports pencil/marker/calligraphy feel, tiltShading, doubleTapAction, and squeezeAction", () => {
		const d = sanitizeSynced(null);
		expect(d.settingsVersion).toBe(4);
		expect(d.tiltShading).toBe(true);
		expect(d.doubleTapAction).toBe("eraser");
		expect(d.squeezeAction).toBe("palette");

		const custom = sanitizeSynced({
			settingsVersion: 4,
			penFeel: "pencil",
			tiltShading: false,
			doubleTapAction: "previous-tool",
			squeezeAction: "undo",
		});
		expect(custom).toMatchObject({
			settingsVersion: 4,
			penFeel: "pencil",
			tiltShading: false,
			doubleTapAction: "previous-tool",
			squeezeAction: "undo",
		});
		expect(sanitizeSynced({ penFeel: "marker" }).penFeel).toBe("marker");
		expect(sanitizeSynced({ penFeel: "calligraphy" }).penFeel).toBe("calligraphy");

		const invalid = sanitizeSynced({
			penFeel: "crayon",
			tiltShading: "yes",
			doubleTapAction: "fly",
			squeezeAction: 42,
		});
		expect(invalid).toMatchObject({
			penFeel: "ball",
			tiltShading: true,
			doubleTapAction: "eraser",
			squeezeAction: "palette",
		});
	});

	it("stores per-device Formula (LaTeX) and pageGuide settings cleanly in local storage", () => {
		const def = defaultLocal(true);
		expect(def).toMatchObject({
			mathMode: false,
			mathAutoDelayMs: 1200,
			mathDelimiters: "auto",
			mathProvider: "offline",
			mathApiKey: "",
			pageGuide: "A4",
		});
		const loc = sanitizeLocal(
			{ mathMode: true, mathAutoDelayMs: 5000, mathDelimiters: "block", mathProvider: "gemini", mathApiKey: "secret", pageGuide: "A3-landscape" },
			true,
		);
		expect(loc).toMatchObject({
			mathMode: true,
			mathAutoDelayMs: 3500,
			mathDelimiters: "block",
			mathProvider: "gemini",
			mathApiKey: "secret",
			pageGuide: "A3-landscape",
		});
		expect(sanitizeLocal({ pageGuide: "A5" }, true).pageGuide).toBe("A4");
		expect(Object.keys(splitPatch({ mathApiKey: "k", mathMode: true, pageGuide: "A3" }).synced)).toEqual([]);
	});
});
