import { VaultInkAdapter, ensureFolder } from "./vaultAdapter";
import { App, MarkdownView, Modal, Notice, Platform, Plugin, PluginSettingTab, Setting, TAbstractFile, TFile, TFolder, Vault, normalizePath } from "obsidian";
import { InkStore } from "./store";
import { InkPagesApi, createApi } from "./api";
import { InkHost, InkView, inkExtension } from "./inkView";
import { InkToolbar, ToolbarHost } from "./toolbar";
import type { InkClip } from "./clipboard";
import { ScreenshotModal, ScreenshotSource } from "./screenshot";
import { ReadingInk } from "./readingView"; // Stage D
import type { SmoothingLevel } from "./smoothing";
import { InkKeys } from "./inkKeys"; // [Stage F]
import { PdfExporter } from "./exportPdf"; // [Stage H]
import type { ExportChoice, ExportOptions } from "./exportOnce";
import { DocFont, ExportStyle, styleExportLabel } from "./docStyle";
import { PAGE_GUIDE_FORMATS, PAGE_GUIDE_LABELS, PageGuideFormat, nextPageGuide } from "./pageGuides";
import { PENCIL_GESTURE_ACTIONS, PencilGestureAction, PencilGestureDetail, resolvePencilAction, resolvePencilGesture } from "./pencilGestures";
import { AssistantLaunchOptions, GEMINI_MODELS, GEMINI_VIEW_TYPE, GEMINI_WEB_URL, GeminiAssistantModal, GeminiModel } from "./aiAssistant";
import { GeminiWebView } from "./geminiView";
import {
	ActiveTool,
	DEFAULT_PEN_WIDTHS,
	EraserMode,
	EraserSize,
	LassoFilter,
	MathDelimiters,
	MathVisionProvider,
	PenFeel,
	PenWidths,
	PencilSettings,
	DEFAULT_HOLD_MS,
	HOLD_MS_MAX,
	HOLD_MS_MIN,
	DEFAULT_INK_FOLDER,
	DEFAULT_SCREENSHOT_FOLDER,
	SETTINGS_VERSION,
	SelectMode,
	sanitizeFolder,
	localOnly,
	needsLocalMigration,
	sanitizeHoldMs,
	sanitizeLocal,
	sanitizeSynced,
	sanitizeWidth,
	splitPatch,
	syncedOnly,
	toggleEraser,
} from "./settings";

/** data.json keys from M1 that no longer belong there. */
const LEGACY_KEYS = ["toolbarVisible", "mouseDraws", "penSize", "highlighterSize"];
/** Per-device settings key (Obsidian scopes local storage per vault). */
const LOCAL_KEY = "ink-pages:device";
const PREVIOUS_LOCAL_KEY = "pencil-layer:device";

export default class InkPagesPlugin extends Plugin implements InkHost, ToolbarHost {
	store!: InkStore;
	/** Public API for other plugins: `app.plugins.plugins["ink-pages"].api` (see api.ts). */
	readonly api: InkPagesApi = createApi(this.app, () => this.store);
	settings: PencilSettings = { ...sanitizeSynced(null), ...sanitizeLocal(null, Platform.isMobile) };
	readonly showMouseToggle = !Platform.isMobile;
	/** Lasso Copy/Cut clipboard: plugin-internal, shared by all notes, session only. */
	clipboard: InkClip | null = null;
	/** Tool "Toggle eraser" / Pencil double-tap returns to (session only). */
	private previousTool: ActiveTool | null = null;

	private readonly inkViews = new Set<InkView>();
	/** [Stage D] Reading view / PDF export ink. */
	private reading: ReadingInk | null = null;
	/** [Stage H] One-shot PDF exports. */
	private pdfExport: PdfExporter | null = null;
	private readonly toolbars = new Map<MarkdownView, InkToolbar>();
	/** [Stage H] The file each Markdown view showed last (a rename keeps the TFile: not a switch). */
	private readonly shownFiles = new WeakMap<MarkdownView, TFile>();
	/** newPath → number of in-flight store renames targeting it. */
	private readonly renaming = new Map<string, number>();

	async onload(): Promise<void> {
		const current: unknown = await this.loadData();
		const raw: unknown = current ?? await this.loadPreviousSettings();
		const rawLocal = this.loadLocal();
		this.settings = { ...sanitizeSynced(raw), ...sanitizeLocal(rawLocal, Platform.isMobile) };
		const prevVersion = raw && typeof raw === "object" ? (raw as { settingsVersion?: unknown }).settingsVersion : undefined;
		if (raw == null || (typeof prevVersion === "number" ? prevVersion < SETTINGS_VERSION : true)) {
			this.settings.scribbleErase = true;
			if (Platform.isIosApp) this.settings.doubleTapEraser = true;
		}
		// [Stage F] pre-F device settings: the desktop toolbar (now the slim Select bar) is shown — persist once.
		if (current == null || needsLocalMigration(rawLocal)) this.saveLocal();
		// M1 kept per-device and size keys in data.json (synced to every device): drop them once.
		// Stage A's "dotted" preset is "dashed" since A2: rewrite once.
		const r = raw as { penPreset?: unknown; penWidths?: Record<string, unknown> } | null;
		const legacyDotted = !!r && typeof r === "object" && (r.penPreset === "dotted" || (!!r.penWidths && "dotted" in r.penWidths));
		// Older settings schemas are migrated once and persisted.
		const oldVersion = !!r && typeof r === "object" && (r as { settingsVersion?: unknown }).settingsVersion !== SETTINGS_VERSION;
		if (current == null || (raw && typeof raw === "object" && (legacyDotted || oldVersion || LEGACY_KEYS.some((k) => k in raw)))) {
			await this.saveData(syncedOnly(this.settings));
		}
		// "Ink folder" setting (default Attachments/Ink): a visible folder, because Obsidian Sync skips hidden ones.
		this.store = new InkStore(new VaultInkAdapter(this.app.vault), { root: normalizePath(this.settings.inkFolder) });

		this.registerEditorExtension(inkExtension(this));
		this.registerView(GEMINI_VIEW_TYPE, (leaf) => new GeminiWebView(leaf));
		// [Stage D] Ink in Reading view + PDF export (post-processor, export commands).
		this.reading = new ReadingInk(this);
		this.reading.install(this);
		// [Stage H] one-shot "Export PDF with / without ink" (commands + ⋯ menu); the toggle is untouched.
		this.pdfExport = new PdfExporter(this.app, () => ({ include: this.settings.includeInkInPdf, style: this.settings.defaultExportStyle }));
		this.register(() => this.pdfExport?.destroy());
		// Keep undo/redo buttons in sync with every file's history.
		this.register(this.store.observeAll(() => this.refreshHistory()));

		const sync = () => this.syncToolbars();
		this.registerEvent(this.app.workspace.on("layout-change", sync));
		this.registerEvent(this.app.workspace.on("active-leaf-change", sync));
		this.registerEvent(this.app.workspace.on("file-open", sync));
		this.app.workspace.onLayoutReady(sync);

		this.addRibbonIcon("pencil-line", "Toggle ink toolbar", () => this.toggleToolbar());
		this.addCommands();
		this.addSettingTab(new PencilSettingTab(this.app, this));

		this.registerEvent(this.app.vault.on("rename", (file, oldPath) => this.onRename(file, oldPath)));
		this.registerEvent(this.app.vault.on("delete", (file) => this.onDelete(file)));
		// Live sync: another device's ink (via Obsidian Sync) lands in the sidecar while the note is open.
		this.registerEvent(this.app.vault.on("modify", (file) => this.onInkFileChanged(file)));
		this.registerEvent(this.app.vault.on("create", (file) => this.onInkFileChanged(file)));

		// [Stage F] keyboard shortcuts for an ink selection (desktop, active leaf only; see inkKeys.ts).
		// Not on mobile: there nothing changes (a lingering lasso selection must not eat Backspace).
		if (!Platform.isMobile) {
			this.inkKeys = new InkKeys(this.app, this);
			this.register(() => this.inkKeys?.destroy());
			this.registerDomEvent(window, "keydown", this.inkKeys.onKeyDown, { capture: true });
		}

		// Native iPadOS Pencil gestures if forwarded by the host / a WKWebView bridge.
		const onNativePencil = (ev: Event) => {
			const detail = (ev as CustomEvent<Partial<PencilGestureDetail> & { type?: string }>).detail;
			const kind = detail?.kind ?? (detail?.type === "double-tap" ? "doubleTap" : detail?.type === "squeeze" ? "squeeze" : undefined);
			if (kind !== "doubleTap" && kind !== "squeeze") return;
			this.applyPencilResolution(
				resolvePencilGesture(
					{ kind, preferredAction: detail?.preferredAction, platform: detail?.platform ?? "ios" },
					this.settings.doubleTapAction,
					this.settings.squeezeAction,
					this.settings.tool,
					this.previousTool,
				),
			);
		};
		for (const name of ["pdf-notes-pencil-gesture", "obsidian-pencil-gesture", "applePencilGesture"] as const) {
			this.registerDomEvent(window, name as keyof WindowEventMap, onNativePencil);
		}
	}

	/** data.json changed on disk (another device's settings arrived through sync). */
	async onExternalSettingsChange(): Promise<void> {
		const synced = sanitizeSynced(await this.loadData());
		const folder = normalizePath(synced.inkFolder);
		if (folder !== this.store.rootFolder) {
			await this.store.flushAll();
			this.store.setRoot(folder);
		}
		this.settings = { ...this.settings, ...synced };
		this.refreshAll();
	}

	onunload(): void {
		for (const t of this.toolbars.values()) t.destroy();
		this.toolbars.clear();
		void this.store?.flushAll();
	}

	// -------------------------------------------------------------------------------------------
	// Settings
	// -------------------------------------------------------------------------------------------

	getSettings(): PencilSettings {
		return this.settings;
	}

	updateSettings(patch: Partial<PencilSettings>): void {
		if (patch.tool !== undefined && patch.tool !== this.settings.tool) this.previousTool = this.settings.tool;
		// [Stage F/H] Select switches off (and drops its selection) when the full drawing toolbar takes
		// over ("Mouse draws" toggled) or the ink is hidden — it never stays on behind the scenes.
		if (this.deskSelecting && (patch.mouseDraws !== undefined || patch.penDevice !== undefined || patch.inkVisible === false)) {
			this.deskSelecting = false;
			for (const v of this.inkViews) v.clearSelection();
		}
		this.settings = { ...this.settings, ...patch };
		const { synced, local } = splitPatch(patch);
		if (Object.keys(synced).length > 0) void this.saveData(syncedOnly(this.settings));
		if (Object.keys(local).length > 0) this.saveLocal();
		this.refreshAll();
	}

	/** Pencil double-tap / "Toggle eraser" command: current tool ↔ eraser. */
	toggleEraser(): void {
		this.updateSettings({ tool: toggleEraser(this.settings.tool, this.previousTool) });
	}

	/** Run a configured Pencil gesture action (tip double-tap or bridged hardware gesture). */
	runPencilGestureAction(action: PencilGestureAction): void {
		this.applyPencilResolution(resolvePencilAction(action, undefined, this.settings.tool, this.previousTool));
	}

	private applyPencilResolution(res: { tool?: ActiveTool; palette?: boolean; undo?: boolean }): void {
		if (res.tool) this.updateSettings({ tool: res.tool });
		if (res.undo) {
			const v = this.activeMarkdownView();
			if (v) this.undoInk(v);
		}
		if (res.palette) this.togglePalette();
	}

	private togglePalette(): void {
		const v = this.activeMarkdownView();
		if (v) this.toolbars.get(v)?.togglePalette();
	}

	private loadLocal(): unknown {
		try {
			const v: unknown = this.app.loadLocalStorage(LOCAL_KEY) ?? this.app.loadLocalStorage(PREVIOUS_LOCAL_KEY);
			if (v !== null && v !== undefined) return typeof v === "string" ? JSON.parse(v) : v;
		} catch {
			/* fall through */
		}
		return null;
	}

	private async loadPreviousSettings(): Promise<unknown> {
		const vault = this.app.vault;
		const path = normalizePath(`${vault.configDir}/plugins/pencil-layer/data.json`);
		try {
			if (await vault.adapter.exists(path)) return JSON.parse(await vault.adapter.read(path)) as unknown;
		} catch (err) {
			console.warn("[ink-pages] could not read Pencil Layer settings", err);
		}
		return null;
	}

	private saveLocal(): void {
		const data = localOnly(this.settings);
		try {
			this.app.saveLocalStorage(LOCAL_KEY, data);
		} catch (err) {
			console.error("[ink-pages] failed to save device settings", err);
		}
	}

	private refreshHistory(): void {
		for (const t of this.toolbars.values()) t.refreshHistory();
	}

	private refreshAll(): void {
		for (const v of this.inkViews) v.refresh();
		for (const t of this.toolbars.values()) t.refresh();
		this.inkSelectionChanged(); // [Stage F]
		this.reading?.refresh(); // [Stage D]
	}

	// -------------------------------------------------------------------------------------------
	// InkHost
	// -------------------------------------------------------------------------------------------

	isRenaming(newPath: string): boolean {
		return (this.renaming.get(newPath) ?? 0) > 0;
	}

	showInk(): void {
		if (!this.settings.inkVisible) this.updateSettings({ inkVisible: true });
	}

	registerInkView(v: InkView): void {
		this.inkViews.add(v);
	}

	unregisterInkView(v: InkView): void {
		this.inkViews.delete(v);
	}

	openScreenshot(src: ScreenshotSource): void {
		new ScreenshotModal(this.app, src, this.settings.screenshotFolder).open();
	}

	openAssistant(opts: AssistantLaunchOptions = {}): void {
		new GeminiAssistantModal(
			this.app,
			{
				getApiKey: () => this.settings.geminiApiKey || this.settings.mathApiKey,
				setApiKey: (key) => this.updateSettings({ geminiApiKey: key }),
				getModel: () => this.settings.geminiModel,
				setModel: (model) => this.updateSettings({ geminiModel: model }),
				openSidebar: () => this.openGeminiSidebar(),
			},
			opts,
		).open();
	}

	async openGeminiSidebar(): Promise<void> {
		const { workspace } = this.app;
		let leaf = workspace.getLeavesOfType(GEMINI_VIEW_TYPE)[0];
		if (!leaf) {
			const right = workspace.getRightLeaf(false);
			if (!right) return;
			leaf = right;
			await leaf.setViewState({ type: GEMINI_VIEW_TYPE, active: true });
		}
		await workspace.revealLeaf(leaf);
	}

	openAssistantForView(view: MarkdownView): void {
		const noteTitle = view.file?.basename ?? "";
		const noteContext = view.editor?.getValue?.() ?? "";
		this.openAssistant({
			noteTitle,
			noteContext,
			insertAtCursor: (text) => {
				const ed = view.editor;
				if (!ed) return false;
				const cursor = ed.getCursor();
				const lineText = ed.getLine(cursor.line);
				const prefix = cursor.ch > 0 && lineText.trim().length > 0 ? "\n\n" : "";
				ed.replaceRange(`${prefix}${text}\n`, cursor);
				return true;
			},
		});
	}

	addBlankPage(view: MarkdownView): void {
		this.inkViewOf(view)?.addBlankPage();
		new Notice("Zusätzlicher Seitenbereich unten hinzugefügt.", 1800);
	}

	getZoom(view: MarkdownView): number {
		return this.inkViewOf(view)?.getZoom() ?? 1;
	}

	zoomIn(view: MarkdownView): void {
		this.inkViewOf(view)?.zoomIn();
	}

	zoomOut(view: MarkdownView): void {
		this.inkViewOf(view)?.zoomOut();
	}

	resetZoom(view: MarkdownView): void {
		this.inkViewOf(view)?.resetZoom();
	}

	// -------------------------------------------------------------------------------------------
	// [Stage F] Desktop Select tool (slim toolbar) — session state, not persisted: after a restart
	// the mouse behaves normally until Select is picked again.
	// -------------------------------------------------------------------------------------------

	private deskSelecting = false;
	private inkKeys: InkKeys | null = null;

	/** Some view's ink selection appeared/went away: the keyboard scope follows. */
	inkSelectionChanged(): void {
		let any = false;
		for (const v of this.inkViews) if (v.hasSelection) any = true;
		this.inkKeys?.sync(any);
	}

	/**
	 * Desktop with "Mouse draws" off and no pen seen on this device: the slim toolbar (Undo, Redo,
	 * Select, Show/Hide ink, ⋯). With a pen (Surface Pen, Wacom, …) the full drawing toolbar shows.
	 */
	isSlim(): boolean {
		return !Platform.isMobile && !this.settings.mouseDraws && !this.settings.penDevice;
	}

	penSeen(): void {
		if (!Platform.isMobile && !this.settings.penDevice) this.updateSettings({ penDevice: true });
	}

	isDeskSelecting(): boolean {
		return this.deskSelecting && this.isSlim();
	}

	setDeskSelect(on: boolean): void {
		if (on === this.deskSelecting) return;
		this.deskSelecting = on;
		// Leaving Select drops what it selected (the lasso tool may still be the synced tool).
		if (!on) for (const v of this.inkViews) v.clearSelection();
		if (on && !this.settings.inkVisible) this.updateSettings({ inkVisible: true });
		else this.refreshAll();
	}

	exitDeskSelect(): void {
		this.setDeskSelect(false);
	}

	deskSelect(): SelectMode | null {
		return this.isDeskSelecting() ? this.settings.selectMode : null;
	}

	selectionToolActive(): boolean {
		// The lasso (pen; mouse too when it draws) or the desktop Select tool.
		return this.isDeskSelecting() || this.settings.tool === "lasso";
	}

	clipboardFull(): boolean {
		return !!this.clipboard && this.clipboard.strokes.length > 0;
	}

	/** One ink selection at a time: other views deselect; the view's leaf becomes active (no focus). */
	deskSelectionMade(v: InkView): void {
		for (const o of this.inkViews) if (o !== v && o.hasSelection) o.clearSelection();
		for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
			const view = leaf.view;
			if (view instanceof MarkdownView && (view.editor as { cm?: unknown }).cm === v.view) {
				if (this.app.workspace.getActiveViewOfType(MarkdownView) !== view) this.app.workspace.setActiveLeaf(leaf, { focus: false });
				break;
			}
		}
	}

	/** The ink view of the active Markdown leaf (keyboard routing). */
	activeInkView(): InkView | null {
		const md = this.app.workspace.getActiveViewOfType(MarkdownView);
		const cm = md ? (md.editor as { cm?: unknown }).cm : null;
		if (!cm) return null;
		for (const v of this.inkViews) if (v.view === cm) return v;
		return null;
	}

	// -------------------------------------------------------------------------------------------
	// Toolbar / actions
	// -------------------------------------------------------------------------------------------

	private syncToolbars(): void {
		const live = new Set<MarkdownView>();
		for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
			const view = leaf.view;
			if (!(view instanceof MarkdownView)) continue;
			live.add(view);
			// [Stage H] Another note opened in a leaf: Select switches off (back to the text cursor).
			const file = view.file;
			const shown = this.shownFiles.get(view);
			if (file) {
				if (shown && shown !== file && this.deskSelecting) this.setDeskSelect(false);
				this.shownFiles.set(view, file);
			}
			const existing = this.toolbars.get(view);
			if (existing && existing.el.isConnected) {
				existing.refreshHistory(); // the leaf may now show another file
				continue;
			}
			existing?.destroy();
			this.toolbars.set(view, new InkToolbar(view, this));
		}
		for (const [view, t] of this.toolbars) {
			if (!live.has(view)) {
				t.destroy();
				this.toolbars.delete(view);
			}
		}
	}

	// [Stage H] one-shot PDF export (toolbar ⋯ menu, commands, print post-processor)
	canExportPdf(view: MarkdownView): boolean {
		return !!this.pdfExport?.canExport(view);
	}

	exportPdf(view: MarkdownView, choice: ExportChoice): void {
		this.pdfExport?.run(choice, view);
	}

	printOptions(): ExportOptions {
		if (this.pdfExport) return this.pdfExport.takeOptions();
		return { include: this.settings.includeInkInPdf, style: this.settings.defaultExportStyle };
	}

	private toggleToolbar(): void {
		this.updateSettings({ toolbarVisible: !this.settings.toolbarVisible });
	}

	undoInk(view: MarkdownView): void {
		if (view.file) this.store.undo(view.file.path);
	}

	canUndoInk(view: MarkdownView): boolean {
		return !!view.file && this.store.canUndo(view.file.path);
	}

	canRedoInk(view: MarkdownView): boolean {
		return !!view.file && this.store.canRedo(view.file.path);
	}

	redoInk(view: MarkdownView): void {
		if (view.file) this.store.redo(view.file.path);
	}

	private inkViewOf(view: MarkdownView): InkView | null {
		const cm = (view.editor as { cm?: unknown }).cm;
		for (const v of this.inkViews) if (v.view === cm) return v;
		return null;
	}

	private activeMarkdownView(): MarkdownView | null {
		const v = this.app.workspace.getActiveViewOfType(MarkdownView);
		return v && v.file ? v : null;
	}

	private addCommands(): void {
		this.addCommand({ id: "toggle-toolbar", name: "Toggle ink toolbar", callback: () => this.toggleToolbar() });
		this.addCommand({
			id: "toggle-ink-visibility",
			name: "Show/hide ink",
			callback: () => this.updateSettings({ inkVisible: !this.settings.inkVisible }),
		});
		const viewCommand = (id: string, name: string, run: (v: MarkdownView) => void) =>
			this.addCommand({
				id,
				name,
				checkCallback: (checking) => {
					const v = this.activeMarkdownView();
					if (!v) return false;
					if (!checking) run(v);
					return true;
				},
			});
		viewCommand("undo-ink", "Undo ink", (v) => this.undoInk(v));
		viewCommand("redo-ink", "Redo ink", (v) => this.redoInk(v));
		this.addCommand({ id: "select-pen", name: "Select pen", callback: () => this.updateSettings({ tool: "pen" }) });
		this.addCommand({
			id: "select-highlighter",
			name: "Select highlighter",
			callback: () => this.updateSettings({ tool: "highlighter" }),
		});
		this.addCommand({ id: "select-eraser", name: "Select eraser", callback: () => this.updateSettings({ tool: "eraser" }) });
		this.addCommand({ id: "select-lasso", name: "Select lasso", callback: () => this.updateSettings({ tool: "lasso" }) });
		this.addCommand({
			id: "toggle-eraser",
			name: "Toggle eraser",
			callback: () => this.toggleEraser(),
		});
		this.addCommand({
			id: "switch-previous-tool",
			name: "Switch to previous tool",
			callback: () => this.runPencilGestureAction("previous-tool"),
		});
		this.addCommand({
			id: "toggle-pencil-palette",
			name: "Toggle quick tool palette",
			callback: () => this.togglePalette(),
		});
		this.addCommand({
			id: "toggle-math-mode",
			name: "Toggle formula mode (handwrite to LaTeX)",
			callback: () => {
				const next = !this.settings.mathMode;
				this.updateSettings({
					mathMode: next,
					...(next && this.settings.tool !== "pen" ? { tool: "pen" } : {}),
				});
			},
		});
		this.addCommand({
			id: "convert-selection-to-latex",
			name: "Convert selected ink formula to LaTeX",
			checkCallback: (checking) => {
				const v = this.activeInkView();
				if (!v || !v.hasSelection) return false;
				if (!checking) void v.convertSelectionToLatex();
				return true;
			},
		});
		this.addCommand({
			id: "cycle-page-guide",
			name: "Cycle page boundary guides (A4 / A3 / Off)",
			callback: () => {
				const next = nextPageGuide(this.settings.pageGuide);
				this.updateSettings({ pageGuide: next });
				new Notice(`Page boundary guide: ${PAGE_GUIDE_LABELS[next]}`, 1800);
			},
		});
		this.addCommand({
			id: "toggle-ruler",
			name: "Toggle straight ruler (Lineal)",
			callback: () => {
				const next = !this.settings.ruler;
				this.updateSettings({
					ruler: next,
					...(next ? { setSquare: false, compass: false, tool: "pen", penShape: "freehand", inkVisible: true } : {}),
				});
			},
		});
		viewCommand("add-blank-page", "Add blank page space below note", (v) => this.addBlankPage(v));
		viewCommand("zoom-in-page", "Zoom page in", (v) => this.zoomIn(v));
		viewCommand("zoom-out-page", "Zoom page out", (v) => this.zoomOut(v));
		viewCommand("zoom-reset-page", "Reset page zoom (100%)", (v) => this.resetZoom(v));
		this.addCommand({
			id: "open-gemini-assistant",
			name: "Open Gemini AI assistant",
			callback: () => {
				const v = this.activeMarkdownView();
				if (v) this.openAssistantForView(v);
				else this.openAssistant();
			},
		});
		this.addCommand({
			id: "open-gemini-sidebar",
			name: "Open Gemini account sidebar (Google AI Pro)",
			callback: () => {
				void this.openGeminiSidebar();
			},
		});
		// [Stage H] one-shot: they apply to that export only ("Include ink in PDF export" stays as set).
		const exportCmd = (id: string, name: string, choice: ExportChoice) =>
			this.addCommand({
				id,
				name,
				checkCallback: (checking) => {
					if (!this.pdfExport?.canExport()) return false;
					if (!checking) this.pdfExport.run(choice);
					return true;
				},
			});
		exportCmd("export-pdf-with-ink", "Export to PDF with ink", { include: true });
		exportCmd("export-pdf-without-ink", "Export to PDF without ink", { include: false });
		// Document style: a plain word-processor look for this one export (ink per the toggle).
		exportCmd("export-pdf-document-style", "Export to PDF (document style)", { style: "document" });
		exportCmd("export-pdf-themed-style", "Export to PDF (themed style)", { style: "themed" });
		if (!Platform.isMobile) {
			// [Stage F]
			this.addCommand({
				id: "toggle-select-tool",
				name: "Toggle select tool (mouse selects ink)",
				checkCallback: (checking) => {
					if (!this.isSlim()) return false;
					if (!checking) this.setDeskSelect(!this.deskSelecting);
					return true;
				},
			});
			this.addCommand({
				id: "toggle-mouse-draws",
				name: "Toggle mouse draws",
				callback: () => this.updateSettings({ mouseDraws: !this.settings.mouseDraws }),
			});
		}
	}

	// -------------------------------------------------------------------------------------------
	// Ink folder setting
	// -------------------------------------------------------------------------------------------

	/** Sidecar files under the current ink folder (from the vault index). */
	inkFilesIn(folder: string): TFile[] {
		const root = this.app.vault.getAbstractFileByPath(normalizePath(folder));
		const out: TFile[] = [];
		if (root instanceof TFolder) {
			Vault.recurseChildren(root, (f) => {
				if (f instanceof TFile && f.extension === "json") out.push(f);
			});
		}
		return out;
	}

	/**
	 * Switch the ink folder to `next` and optionally move the existing sidecars there (through the
	 * Vault API, so Sync sees the move). Pending saves are flushed to the old folder first. A sidecar
	 * whose destination already exists is left where it is (counted in `skipped`). Returns null if
	 * `next` is unusable (empty, hidden, or nested in / containing the current folder).
	 */
	async changeInkFolder(next: string, move: boolean): Promise<{ moved: number; skipped: number } | null> {
		const from = this.store.rootFolder;
		const clean = sanitizeFolder(next, "");
		if (!clean) return null;
		const to = normalizePath(clean);
		if (to === from) return { moved: 0, skipped: 0 };
		if (to.startsWith(`${from}/`) || from.startsWith(`${to}/`)) return null;
		await this.store.flushAll();
		const files = move ? this.inkFilesIn(from) : [];
		this.store.setRoot(to);
		this.updateSettings({ inkFolder: to });
		let moved = 0;
		let skipped = 0;
		const vault = this.app.vault;
		for (const f of files) {
			const dest = normalizePath(to + f.path.slice(from.length));
			if (vault.getAbstractFileByPath(dest) || (await vault.adapter.exists(dest))) {
				skipped++;
				continue;
			}
			try {
				const i = dest.lastIndexOf("/");
				if (i > 0) await ensureFolder(vault, dest.slice(0, i));
				await vault.rename(f, dest);
				moved++;
			} catch (err) {
				console.error("[ink-pages] failed to move ink file", f.path, err);
				skipped++;
			}
		}
		// Drop the old folder if the move emptied it (only folders are left).
		const old = vault.getAbstractFileByPath(from);
		if (move && old instanceof TFolder && this.inkFilesIn(from).length === 0) {
			let onlyFolders = true;
			Vault.recurseChildren(old, (c) => {
				if (c instanceof TFile) onlyFolders = false;
			});
			if (onlyFolders) await this.app.fileManager.trashFile(old).catch((err) => console.error("[ink-pages] failed to remove old ink folder", from, err));
		}
		// Open notes re-read their ink from the new folder.
		for (const note of this.store.loadedPaths()) void this.store.reloadFromDisk(note);
		return { moved, skipped };
	}

	// -------------------------------------------------------------------------------------------
	// Vault events
	// -------------------------------------------------------------------------------------------

	private onRename(file: TAbstractFile, oldPath: string): void {
		const pairs: [string, string][] = [];
		if (file instanceof TFile) {
			if (file.extension === "md" || oldPath.toLowerCase().endsWith(".md")) pairs.push([oldPath, file.path]);
		} else if (file instanceof TFolder) {
			Vault.recurseChildren(file, (child) => {
				if (child instanceof TFile && child.extension === "md") {
					pairs.push([oldPath + child.path.slice(file.path.length), child.path]);
				}
			});
		}
		for (const [from, to] of pairs) {
			// Mark synchronously so editor views don't mistake the path change for a file switch.
			this.renaming.set(to, (this.renaming.get(to) ?? 0) + 1);
			void this.store.rename(from, to).finally(() => {
				const n = (this.renaming.get(to) ?? 1) - 1;
				if (n > 0) this.renaming.set(to, n);
				else this.renaming.delete(to);
			});
		}
	}

	/** A sidecar was written/created/deleted: if its note is open, reload (echoes are ignored). */
	private onInkFileChanged(file: TAbstractFile): void {
		if (!(file instanceof TFile) || file.extension !== "json") return;
		const note = this.store.notePathForSidecar(file.path);
		if (note && this.store.isLoaded(note)) void this.store.reloadFromDisk(note);
	}

	private onDelete(file: TAbstractFile): void {
		if (file instanceof TFile) {
			if (file.extension === "md") void this.store.delete(file.path);
			else this.onInkFileChanged(file);
		} else if (file instanceof TFolder) {
			// Remove the folder's ink (files inside may not get individual delete events).
			const dir = this.store.sidecarPath(file.path).replace(/\.json$/, "");
			const inkDir = this.app.vault.getAbstractFileByPath(normalizePath(dir));
			if (inkDir instanceof TFolder) {
				this.app.fileManager.trashFile(inkDir).catch((err) => console.error("[ink-pages] failed to remove ink folder", dir, err));
			}
		}
	}
}

class PencilSettingTab extends PluginSettingTab {
	constructor(
		app: App,
		private readonly plugin: InkPagesPlugin,
	) {
		super(app, plugin);
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();
		const s = this.plugin.getSettings();
		new Setting(containerEl)
			.setName("Show ink toolbar on this device")
			.setDesc("Floating toolbar over the note (drag it by its grip, tap the grip to collapse or expand, hold or right-click it to snap to a preset position). Stored per device (default: shown). On desktop without \"Mouse draws\" it is the slim toolbar: Undo, Redo, Select, Show/Hide ink.")
			.addToggle((t) => t.setValue(s.toolbarVisible).onChange((v) => this.plugin.updateSettings({ toolbarVisible: v })));
		new Setting(containerEl)
			.setName("Show ink")
			.addToggle((t) => t.setValue(s.inkVisible).onChange((v) => this.plugin.updateSettings({ inkVisible: v })));
		// [Stage D]
		new Setting(containerEl)
			.setName("Include ink in PDF export (this device)")
			.setDesc("Draw the ink in Obsidian's \"Export to PDF\". The commands \"Export to PDF with ink\" / \"without ink\" set this and start the export.")
			.addToggle((t) => t.setValue(s.includeInkInPdf).onChange((v) => this.plugin.updateSettings({ includeInkInPdf: v })));
		new Setting(containerEl)
			.setName("Page boundary guides (A4 / A3)")
			.setDesc("Shows dashed sheet limits (right edge and page breaks) matching PDF export dimensions so drawings stay cleanly on each page.")
			.addDropdown((d) => {
				for (const f of PAGE_GUIDE_FORMATS) d.addOption(f, PAGE_GUIDE_LABELS[f]);
				return d.setValue(s.pageGuide).onChange((v) => this.plugin.updateSettings({ pageGuide: v as PageGuideFormat }));
			});
		new Setting(containerEl)
			.setName("Tap empty space to type (this device)")
			.setDesc("Tapping open space inserts temporary line/space padding so you can start typing at that spot; unused padding is removed automatically if you move away or draw without typing.")
			.addToggle((t) => t.setValue(s.tapToType).onChange((v) => this.plugin.updateSettings({ tapToType: v })));
		new Setting(containerEl)
			.setName("Default export style")
			.setDesc(`Themed: the PDF looks like the note in Obsidian (theme, snippets). Document: a plain document look (white page, black text, 12 pt, plain headings), handy for handing in work. Used by Obsidian's own export and "Export PDF with / without ink"; the ⋯ menu also offers the other style ("${styleExportLabel("document")}" / "${styleExportLabel("themed")}") for one export.`)
			.addDropdown((d) =>
				d
					.addOption("themed", "Themed")
					.addOption("document", "Document")
					.setValue(s.defaultExportStyle)
					.onChange((v) => this.plugin.updateSettings({ defaultExportStyle: v as ExportStyle })),
			);
		new Setting(containerEl)
			.setName("Document style font")
			.setDesc("Font of the document-style PDF export (12 pt). Serif: Times New Roman (or Times, Georgia). Sans: Calibri (or Aptos, Carlito, Arial).")
			.addDropdown((d) =>
				d
					.addOption("serif", "Serif (Times New Roman)")
					.addOption("sans", "Sans (Calibri)")
					.setValue(s.docExportFont)
					.onChange((v) => this.plugin.updateSettings({ docExportFont: v as DocFont })),
			);
		if (!Platform.isMobile) {
			new Setting(containerEl)
				.setName("Mouse draws (this device)")
				.setDesc("Draw with the primary mouse button (shows the full drawing toolbar). Off: the mouse reads, and the Select tool rearranges ink. Pens always draw; fingers always scroll.")
				.addToggle((t) => t.setValue(s.mouseDraws).onChange((v) => this.plugin.updateSettings({ mouseDraws: v })));
			new Setting(containerEl)
				.setName("Pen on this device")
				.setDesc("Show the full drawing toolbar (tools, colors) for a pen such as a Surface Pen, even when the mouse doesn't draw. Turns on by itself the first time a pen touches a note. Off: the slim toolbar with the mouse Select tool.")
				.addToggle((t) => t.setValue(s.penDevice).onChange((v) => this.plugin.updateSettings({ penDevice: v })));
		}

		new Setting(containerEl).setName("Pen").setHeading();
		new Setting(containerEl)
			.setName("Pen feel")
			.setDesc("Ballpoint: constant width. Fountain pen: pressure and speed vary the width, soft tapered ends. Pencil: soft graphite shading with tilt. Marker: bold smooth felt-tip. Calligraphy: expressive high-contrast ribbon. Dashed is always ballpoint.")
			.addDropdown((d) =>
				d
					.addOption("ball", "Ballpoint")
					.addOption("notes", "Fountain pen")
					.addOption("pencil", "Pencil")
					.addOption("marker", "Marker")
					.addOption("calligraphy", "Calligraphy")
					.setValue(s.penFeel)
					.onChange((v) => this.plugin.updateSettings({ penFeel: v as PenFeel })),
			);
		new Setting(containerEl)
			.setName("Tilt shading (Neigung)")
			.setDesc("Tilting the Apple Pencil widens strokes for shading (works with Ballpoint, Fountain pen, Pencil, and Highlighter).")
			.addToggle((t) => t.setValue(s.tiltShading).onChange((v) => this.plugin.updateSettings({ tiltShading: v })));
		new Setting(containerEl)
			.setName("Smoothing")
			.setDesc("Filters pen jitter and pixel steps while you write (strong when slow, almost no lag when fast). Lines are always drawn as smooth curves. Shapes are never smoothed.")
			.addDropdown((d) =>
				d
					.addOption("off", "Off")
					.addOption("light", "Light")
					.addOption("medium", "Medium (default)")
					.addOption("strong", "Strong")
					.setValue(s.smoothing)
					.onChange((v) => this.plugin.updateSettings({ smoothing: v as SmoothingLevel })),
			);
		const widths: { key: keyof PenWidths; name: string }[] = [
			{ key: "thin", name: "Thin width (px)" },
			{ key: "dashed", name: "Dashed width (px)" },
			{ key: "thick", name: "Thick width (px)" },
		];
		for (const w of widths) {
			new Setting(containerEl)
				.setName(w.name)
				.setDesc(`Default ${DEFAULT_PEN_WIDTHS[w.key]}. Applies to new strokes.`)
				.addText((t) => {
					t.inputEl.type = "number";
					t.inputEl.step = "0.1";
					t.inputEl.min = "0.5";
					t.setValue(String(s.penWidths[w.key])).onChange((v) => {
						const n = sanitizeWidth(v, NaN);
						if (Number.isNaN(n)) return;
						this.plugin.updateSettings({ penWidths: { ...this.plugin.getSettings().penWidths, [w.key]: n } });
					});
				});
		}

		new Setting(containerEl).setName("Gestures").setHeading();
		new Setting(containerEl)
			.setName("Snap to shape")
			.setDesc("Draw a line, arrow, rectangle, triangle, polygon or ellipse and keep the pen still: it snaps to a clean shape. Keep the pen down to adjust it.")
			.addToggle((t) => t.setValue(s.shapeSnap).onChange((v) => this.plugin.updateSettings({ shapeSnap: v })));
		new Setting(containerEl)
			.setName("Hold delay (ms)")
			.setDesc(`How long the pen must stay still before snapping. Default ${DEFAULT_HOLD_MS} (${HOLD_MS_MIN}–${HOLD_MS_MAX}).`)
			.addText((t) => {
				t.inputEl.type = "number";
				t.inputEl.step = "50";
				t.inputEl.min = String(HOLD_MS_MIN);
				t.inputEl.max = String(HOLD_MS_MAX);
				t.setValue(String(s.shapeHoldMs)).onChange((v) => {
					const n = sanitizeHoldMs(v, NaN);
					if (!Number.isNaN(n)) this.plugin.updateSettings({ shapeHoldMs: n });
				});
			});
		new Setting(containerEl)
			.setName("Double-tap with the Pencil tip")
			.setDesc("Tap the screen twice quickly with the Pencil tip to run the double-tap action below. Taps leave no dots, and taps beside recent handwriting are ignored.")
			.addToggle((t) => t.setValue(s.doubleTapEraser).onChange((v) => this.plugin.updateSettings({ doubleTapEraser: v })));
		new Setting(containerEl)
			.setName("Double-tap action")
			.setDesc("Action triggered by Pencil tip double-tap (and bridged barrel double-tap if provided by the host).")
			.addDropdown((d) => {
				for (const a of PENCIL_GESTURE_ACTIONS) {
					if (a.value !== "system" && a.value !== "none") d.addOption(a.value, a.label);
				}
				return d.setValue(s.doubleTapAction).onChange((v) => this.plugin.updateSettings({ doubleTapAction: v as PencilGestureAction }));
			});
		new Setting(containerEl)
			.setName("Apple Pencil Pro squeeze action")
			.setDesc("Action when a squeeze event is forwarded to the WebView. Important: Apple's iPadOS WKWebView never exposes native hardware barrel Squeeze or barrel Double-tap (UIPencilInteraction) to Obsidian JS plugins; use screen tip double-tap, toolbar buttons, or commands instead.")
			.addDropdown((d) => {
				for (const a of PENCIL_GESTURE_ACTIONS) d.addOption(a.value, a.label);
				return d.setValue(s.squeezeAction).onChange((v) => this.plugin.updateSettings({ squeezeAction: v as PencilGestureAction }));
			});
		new Setting(containerEl).setName("Google Gemini & KI-Assistent (this device)").setHeading();
		new Setting(containerEl)
			.setName("Gemini API-Key (lokal auf diesem Gerät)")
			.setDesc("Hinweis zum Google AI Pro Abo: Google erlaubt Drittanbieter-Apps keinen direkten Login in das Consumer-Abo (gemini.google.com). Mit einem kostenlosen Google AI Studio API-Key (aistudio.google.com/apikey) funktionieren sowohl der In-App KI-Assistent als auch die handschriftliche Formel-Erkennung direkt in Obsidian. Alternativ kannst du im KI-Assistenten jederzeit „In Google AI Pro öffnen“ nutzen.")
			.addText((t) => {
				t.inputEl.type = "password";
				t.setPlaceholder("AIza...");
				t.setValue(s.geminiApiKey);
				t.onChange((v) => this.plugin.updateSettings({ geminiApiKey: v }));
			})
			.addButton((b) =>
				b.setButtonText("Google AI Pro ↗").onClick(() => {
					window.open(GEMINI_WEB_URL, "_blank", "noopener");
				}),
			);
		new Setting(containerEl)
			.setName("Gemini Modell")
			.setDesc("Modell für den In-App KI-Assistenten.")
			.addDropdown((d) => {
				for (const m of GEMINI_MODELS) d.addOption(m.value, m.label);
				return d.setValue(s.geminiModel).onChange((v) => this.plugin.updateSettings({ geminiModel: v as GeminiModel }));
			});

		new Setting(containerEl).setName("Formulas (LaTeX)").setHeading();
		new Setting(containerEl)
			.setName("Formula mode (auto LaTeX)")
			.setDesc("When enabled (or via the fx button on the toolbar), pausing after writing a math equation converts it into LaTeX ($...$ / $$...$$) at that spot in the note.")
			.addToggle((t) => t.setValue(s.mathMode).onChange((v) => this.plugin.updateSettings({ mathMode: v })));
		new Setting(containerEl)
			.setName("Auto-convert pause (ms)")
			.setDesc("How long after the last stroke Formula mode waits before converting (600–3500 ms, default 1200).")
			.addText((t) => {
				t.inputEl.type = "number";
				t.inputEl.step = "100";
				t.inputEl.min = "600";
				t.inputEl.max = "3500";
				t.setValue(String(s.mathAutoDelayMs)).onChange((v) => {
					const n = Number(v);
					if (Number.isFinite(n)) this.plugin.updateSettings({ mathAutoDelayMs: n });
				});
			});
		new Setting(containerEl)
			.setName("LaTeX delimiters")
			.addDropdown((d) =>
				d
					.addOption("auto", "Auto ($$ for fractions/roots, $ inline)")
					.addOption("inline", "Inline ($...$)")
					.addOption("block", "Block ($$...$$)")
					.setValue(s.mathDelimiters)
					.onChange((v) => this.plugin.updateSettings({ mathDelimiters: v as MathDelimiters })),
			);
		new Setting(containerEl)
			.setName("Formula recognizer (this device)")
			.setDesc("Built-in offline recognizer works with no API key. Optional Gemini or OpenAI Vision improves complex handwritten equations.")
			.addDropdown((d) =>
				d
					.addOption("offline", "Built-in offline recognizer")
					.addOption("gemini", "Gemini Vision API")
					.addOption("openai", "OpenAI Vision API")
					.setValue(s.mathProvider)
					.onChange((v) => this.plugin.updateSettings({ mathProvider: v as MathVisionProvider })),
			);
		new Setting(containerEl)
			.setName("Vision API key (this device)")
			.setDesc("Stored locally on this device only (never synced to your vault). Optional, only used when Gemini or OpenAI is selected.")
			.addText((t) => {
				t.inputEl.type = "password";
				t.setPlaceholder("Paste API key");
				t.setValue(s.mathApiKey);
				t.onChange((v) => this.plugin.updateSettings({ mathApiKey: v }));
			});
		new Setting(containerEl)
			.setName("Scribble to erase")
			.setDesc("Scribble quickly back and forth over strokes to erase them. Conservative: only strokes the scribble covers almost completely are erased — outlines around shading and lines running through (graph axes) are kept. If nothing qualifies, the scribble stays as ink.")
			.addToggle((t) => t.setValue(s.scribbleErase).onChange((v) => this.plugin.updateSettings({ scribbleErase: v })));

		new Setting(containerEl).setName("Tools (this device)").setHeading();
		containerEl.createEl("p", {
			cls: "setting-item-description",
			text: "Also in the toolbar: tap the active tool to open its options.",
		});
		new Setting(containerEl)
			.setName("Eraser")
			.setDesc("Whole stroke, or precise: erase only the part you touch.")
			.addDropdown((d) =>
				d
					.addOption("stroke", "Whole stroke")
					.addOption("precise", "Precise")
					.setValue(s.eraserMode)
					.onChange((v) => this.plugin.updateSettings({ eraserMode: v as EraserMode })),
			);
		new Setting(containerEl).setName("Precise eraser size").addDropdown((d) =>
			d
				.addOption("s", "Small")
				.addOption("m", "Medium")
				.addOption("l", "Large")
				.setValue(s.eraserSize)
				.onChange((v) => this.plugin.updateSettings({ eraserSize: v as EraserSize })),
		);
		new Setting(containerEl)
			.setName("Erase highlighter only")
			.addToggle((t) => t.setValue(s.eraseHighlighterOnly).onChange((v) => this.plugin.updateSettings({ eraseHighlighterOnly: v })));
		new Setting(containerEl)
			.setName("Straight-line highlighter")
			.setDesc("The highlighter draws a straight line from where you start (snapped to horizontal within a few degrees).")
			.addToggle((t) => t.setValue(s.highlighterStraight).onChange((v) => this.plugin.updateSettings({ highlighterStraight: v })));
		if (!Platform.isMobile) {
			// [Stage F]
			new Setting(containerEl)
				.setName("Select tool (mouse)")
				.setDesc("Drag a rectangle, or draw a freeform lasso. A click on a stroke selects it.")
				.addDropdown((d) =>
					d
						.addOption("rect", "Rectangle")
						.addOption("lasso", "Freeform lasso")
						.setValue(s.selectMode)
						.onChange((v) => this.plugin.updateSettings({ selectMode: v as SelectMode })),
				);
		}
		new Setting(containerEl).setName("Lasso selects").addDropdown((d) =>
			d
				.addOption("both", "Pen and highlighter")
				.addOption("pen", "Pen only")
				.addOption("highlighter", "Highlighter only")
				.setValue(s.lassoFilter)
				.onChange((v) => this.plugin.updateSettings({ lassoFilter: v as LassoFilter })),
		);

		new Setting(containerEl).setName("Files").setHeading();
		let pending = s.inkFolder;
		new Setting(containerEl)
			.setName("Ink folder")
			.setDesc(`Ink is stored as one JSON file per note: <folder>/<note path>.json. Use a visible folder so sync includes it. Current folder: ${s.inkFolder}`)
			.addText((t) => t.setPlaceholder(DEFAULT_INK_FOLDER).setValue(s.inkFolder).onChange((v) => (pending = v)))
			.addButton((b) =>
				b.setButtonText("Change").onClick(() => {
					const to = sanitizeFolder(pending, "");
					const from = this.plugin.store.rootFolder;
					if (!to || to.startsWith(`${from}/`) || from.startsWith(`${to}/`)) {
						new Notice("Choose a visible vault folder that is not inside (or around) the current ink folder.");
						return;
					}
					if (to === from) return;
					new InkFolderModal(this.app, this.plugin, from, to, () => this.display()).open();
				}),
			);
		new Setting(containerEl)
			.setName("Screenshot folder")
			.setDesc("Where lasso screenshots go (\"Save to vault\" and \"Insert into note\").")
			.addText((t) =>
				t
					.setPlaceholder(DEFAULT_SCREENSHOT_FOLDER)
					.setValue(s.screenshotFolder)
					.onChange((v) => this.plugin.updateSettings({ screenshotFolder: sanitizeFolder(v, DEFAULT_SCREENSHOT_FOLDER) })),
			);

		containerEl.createEl("p", {
			cls: "setting-item-description",
			text: "Tip: keep \"Readable line length\" on so drawings line up across devices.",
		});
	}
}

/** Confirm an ink folder change: move the existing ink files, or switch without moving them. */
class InkFolderModal extends Modal {
	constructor(
		app: App,
		private readonly plugin: InkPagesPlugin,
		private readonly from: string,
		private readonly to: string,
		private readonly done: () => void,
	) {
		super(app);
	}

	onOpen(): void {
		const count = this.plugin.inkFilesIn(this.from).length;
		this.titleEl.setText("Change ink folder");
		const { contentEl } = this;
		contentEl.createEl("p", { text: `New ink folder: ${this.to}` });
		contentEl.createEl("p", {
			text:
				count > 0
					? `${count} ink file${count === 1 ? " is" : "s are"} in ${this.from}. Move them to the new folder? If you switch without moving, existing ink stays in ${this.from} and does not show until it is moved.`
					: `There is no ink in ${this.from} yet.`,
		});
		contentEl.createEl("p", {
			cls: "setting-item-description",
			text: "The setting syncs to your other devices. Let sync finish on every device before drawing there.",
		});
		const row = contentEl.createDiv({ cls: "modal-button-container" });
		const run = (move: boolean) => {
			this.close();
			void this.plugin.changeInkFolder(this.to, move).then((r) => {
				if (!r) new Notice("The ink folder was not changed.");
				else if (move) new Notice(`Moved ${r.moved} ink file${r.moved === 1 ? "" : "s"} to ${this.to}.${r.skipped ? ` ${r.skipped} skipped (already there or failed; still in ${this.from}).` : ""}`);
				this.done();
			});
		};
		if (count > 0) {
			row.createEl("button", { text: "Move ink and switch", cls: "mod-cta" }).addEventListener("click", () => run(true));
			row.createEl("button", { text: "Switch without moving" }).addEventListener("click", () => run(false));
		} else {
			row.createEl("button", { text: "Switch", cls: "mod-cta" }).addEventListener("click", () => run(false));
		}
		row.createEl("button", { text: "Cancel" }).addEventListener("click", () => this.close());
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
