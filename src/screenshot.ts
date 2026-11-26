/**
 * Screenshot of a lasso selection: a modal with a crop frame over a preview of the region around
 * the selection, rendered at 2–3× device pixels; optional typed text (the editor DOM rasterized via
 * SVG foreignObject using html-to-image) under the ink; Share / Copy image / Save to vault /
 * Insert into note / Discard.
 *
 * Text rasterization may fail on WebKit (tainted canvas, blank first render, missing fonts): the
 * modal then falls back to ink only and says so — it never errors out.
 */
import type { EditorView } from "@codemirror/view";
import { App, Modal, Notice, Platform, TFile, ToggleComponent, normalizePath, setIcon } from "obsidian";
import { toSvg } from "html-to-image";
import { CROP_HANDLES, CropHandle, Rect, cropPixels, dragCrop, fitScale, initialCrop, renderScale, screenshotName, withSuffix } from "./crop";
import { InkPaint, RenderStroke, drawInk } from "./inkRender";
import { ensureFolder } from "./vaultAdapter";

/** Give up on text rasterization after this long. */
const TEXT_TIMEOUT_MS = 10_000;
const TRANSPARENT_GIF = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";

/** What the ink view hands to the screenshot modal. */
export interface ScreenshotSource {
	/** The note (for the file name and link source path). */
	notePath: string;
	noteBasename: string;
	/** Selection bbox and the renderable stage around it (overlay space). */
	selection: Rect;
	stage: Rect;
	background: string;
	paint: InkPaint;
	/** Strokes intersecting `region` with their line tops. */
	strokes(region: Rect): RenderStroke[];
	/** Rasterize the editor text in `region` at `scale` (rejects on failure). */
	rasterizeText(region: Rect, scale: number): Promise<HTMLCanvasElement>;
	/** Insert markdown at the editor cursor (without focusing). False if the note is gone. */
	insertAtCursor(text: string): boolean;
}

// ---------------------------------------------------------------------------------------------
// Rendering helpers
// ---------------------------------------------------------------------------------------------

function makeCanvas(w: number, h: number): HTMLCanvasElement {
	const c = createEl("canvas");
	c.width = Math.max(1, Math.round(w));
	c.height = Math.max(1, Math.round(h));
	return c;
}

/** Release a canvas' backing store (iOS keeps a tight total canvas memory budget). */
export function freeCanvas(c: HTMLCanvasElement | null | undefined): void {
	if (!c) return;
	c.width = 0;
	c.height = 0;
}

function canvasToBlob(c: HTMLCanvasElement): Promise<Blob> {
	return new Promise((resolve, reject) => {
		try {
			c.toBlob((b) => (b ? resolve(b) : reject(new Error("toBlob returned null"))), "image/png");
		} catch (err) {
			reject(err instanceof Error ? err : new Error(String(err)));
		}
	});
}

function loadImage(src: string): Promise<HTMLImageElement> {
	return new Promise((resolve, reject) => {
		const img = new Image();
		img.decoding = "sync";
		img.onload = () => resolve(img);
		img.onerror = () => reject(new Error("image failed to load"));
		img.src = src;
	});
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
	return new Promise((resolve, reject) => {
		const t = window.setTimeout(() => reject(new Error("timed out")), ms);
		p.then(
			(v) => {
				window.clearTimeout(t);
				resolve(v);
			},
			(e: unknown) => {
				window.clearTimeout(t);
				reject(e instanceof Error ? e : new Error(String(e)));
			},
		);
	});
}

/** Does the canvas have any non-transparent pixel? Throws (SecurityError) if it is tainted. */
function hasContent(c: HTMLCanvasElement): boolean {
	const w = Math.min(256, c.width);
	const h = Math.max(1, Math.round((c.height * w) / Math.max(1, c.width)));
	const probe = makeCanvas(w, h);
	const ctx = probe.getContext("2d");
	if (!ctx) return false;
	ctx.drawImage(c, 0, 0, w, h);
	const data = ctx.getImageData(0, 0, w, h).data;
	freeCanvas(probe);
	for (let i = 3; i < data.length; i += 4) if (data[i] > 0) return true;
	return false;
}

/** Ink-only render of `region` (with background) — also used for the clipboard PNG. */
export function renderInkCanvas(src: Pick<ScreenshotSource, "strokes" | "background" | "paint">, region: Rect, scale: number, text?: HTMLCanvasElement | null): HTMLCanvasElement {
	const c = makeCanvas(region.w * scale, region.h * scale);
	const ctx = c.getContext("2d");
	if (!ctx) return c;
	ctx.fillStyle = src.background;
	ctx.fillRect(0, 0, c.width, c.height);
	if (text) ctx.drawImage(text, 0, 0, c.width, c.height);
	drawInk(ctx, src.strokes(region), region, scale, src.paint);
	return c;
}

/**
 * Nodes to leave out of the text rasterization: CM's `<img class="cm-widgetBuffer">` has no src
 * (html-to-image would fetch "" = the app page and fail on it), and broken images would make the
 * whole render fail.
 */
function keepNode(n: HTMLElement): boolean {
	if (n.instanceOf(HTMLImageElement)) {
		if (!n.getAttribute("src")) return false;
		if (n.complete && n.naturalWidth === 0) return false;
	}
	return true;
}

/**
 * Rasterize the editor's text in `region` (overlay space) at `scale`, as a transparent canvas.
 * Clones `.cm-content` with inlined computed styles (html-to-image), shifts the clone so the
 * region's corner is at the SVG origin and draws the SVG into a canvas. Only lines inside CM's
 * rendered viewport exist in the DOM (the region is around a visible selection, so that's fine).
 *
 * Rejects when the canvas is tainted (WebKit) or comes out blank although the region has text.
 */
export async function rasterizeEditorText(view: EditorView, region: Rect, scale: number): Promise<HTMLCanvasElement> {
	const cd = view.contentDOM;
	const sx = view.scaleX || 1;
	const sy = view.scaleY || 1;
	const cRect = cd.getBoundingClientRect();
	const cs = getComputedStyle(cd);
	// Overlay origin inside the content element's border box (see InkView.readGeometry).
	const ox = (parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.borderLeftWidth) || 0);
	const oy = (view.documentTop - cRect.top) / sy;
	const fullW = cRect.width / sx;
	const fullH = cRect.height / sy;

	// Is there typed text in the region at all? (Blank output is then an error, not "no text".)
	const doc = view.state.doc;
	const a = view.lineBlockAtHeight(Math.max(0, region.y) * sy);
	const b = view.lineBlockAtHeight(Math.max(0, region.y + region.h) * sy);
	const expectText = doc.sliceString(a.from, b.to).trim().length > 0;

	const render = async (): Promise<HTMLCanvasElement> => {
		const url = await toSvg(cd, {
			width: region.w,
			height: region.h,
			// Applied after width/height: keep the clone at its real size, shift it into the window.
			style: {
				width: `${fullW}px`,
				height: `${fullH}px`,
				margin: "0",
				transform: `translate(${-(region.x + ox)}px, ${-(region.y + oy)}px)`,
				transformOrigin: "0 0",
			},
			cacheBust: false,
			imagePlaceholder: TRANSPARENT_GIF,
			filter: keepNode,
		});
		const img = await loadImage(url);
		const c = makeCanvas(region.w * scale, region.h * scale);
		const ctx = c.getContext("2d");
		if (!ctx) throw new Error("no 2d context");
		ctx.drawImage(img, 0, 0, c.width, c.height);
		return c;
	};

	let c = await withTimeout(render(), TEXT_TIMEOUT_MS);
	// Throws a SecurityError if WebKit tainted the canvas.
	if (expectText && !hasContent(c)) {
		// WebKit sometimes paints foreignObject blank the first time (fonts/images not ready).
		freeCanvas(c);
		c = await withTimeout(render(), TEXT_TIMEOUT_MS);
		if (!hasContent(c)) {
			freeCanvas(c);
			throw new Error("text rendered blank");
		}
	}
	return c;
}

// ---------------------------------------------------------------------------------------------
// Platform capabilities / actions
// ---------------------------------------------------------------------------------------------

type ShareNavigator = Navigator & {
	canShare?: (data: { files?: File[] }) => boolean;
	share?: (data: { files?: File[]; title?: string }) => Promise<void>;
};

export function canShareFiles(): boolean {
	const nav = navigator as ShareNavigator;
	if (typeof nav.share !== "function" || typeof nav.canShare !== "function" || typeof File === "undefined") return false;
	try {
		return nav.canShare({ files: [new File([new Uint8Array([0])], "probe.png", { type: "image/png" })] });
	} catch {
		return false;
	}
}

export function canCopyImage(): boolean {
	return typeof ClipboardItem !== "undefined" && typeof navigator.clipboard?.write === "function";
}

/**
 * Put a PNG on the system clipboard. The blob may be a promise so this can be called synchronously
 * inside the user gesture (Safari requires that). Never throws; resolves false on failure.
 */
export async function copyPngToClipboard(png: Blob | Promise<Blob>): Promise<boolean> {
	if (!canCopyImage()) return false;
	try {
		await navigator.clipboard.write([new ClipboardItem({ "image/png": png })]);
		return true;
	} catch (err) {
		console.warn("[ink-pages] copying the image to the clipboard failed", err);
		return false;
	}
}

/** Save a PNG in `folder` (the "Screenshot folder" setting) through the Vault API (unique name). */
export async function savePng(app: App, png: Blob, noteBasename: string, folder: string): Promise<TFile> {
	const vault = app.vault;
	await ensureFolder(vault, normalizePath(folder));
	const base = screenshotName(noteBasename, new Date());
	let path = "";
	for (let n = 1; n < 1000; n++) {
		path = normalizePath(`${folder}/${withSuffix(base, n)}`);
		if (!vault.getAbstractFileByPath(path) && !(await vault.adapter.exists(path))) break;
	}
	return vault.createBinary(path, await png.arrayBuffer());
}

// ---------------------------------------------------------------------------------------------
// Modal
// ---------------------------------------------------------------------------------------------

export class ScreenshotModal extends Modal {
	private readonly scale: number;
	private crop: Rect;
	private includeText = true;
	private textFailed: string | null = null;
	private inkStage: HTMLCanvasElement | null = null;
	private textStage: HTMLCanvasElement | null = null;
	private textLayer: HTMLCanvasElement | null = null;
	private textPending = false;
	private closed = false;

	private previewEl!: HTMLCanvasElement;
	private cropEl!: HTMLElement;
	private holeEl!: HTMLElement;
	private statusEl!: HTMLElement;
	private toggle!: ToggleComponent;
	private display = 1;
	private blob: { key: string; p: Promise<Blob> } | null = null;
	private blobTimer: number | null = null;
	private drag: { id: number; handle: CropHandle; x: number; y: number; start: Rect } | null = null;

	constructor(
		app: App,
		private readonly src: ScreenshotSource,
		/** Vault folder for "Save to vault" / "Insert into note". */
		private readonly folder: string,
	) {
		super(app);
		this.shouldRestoreSelection = true;
		this.scale = renderScale(window.devicePixelRatio || 1, src.stage.w, src.stage.h);
		this.crop = initialCrop(src.selection, src.stage);
	}

	onOpen(): void {
		this.modalEl.addClass("pl-shot-modal");
		this.titleEl.setText("Screenshot");
		const root = this.contentEl;
		root.empty();

		const opts = root.createDiv({ cls: "pl-shot-options" });
		const label = opts.createEl("label", { cls: "pl-shot-toggle" });
		this.toggle = new ToggleComponent(label);
		this.toggle.setValue(this.includeText).onChange((v) => {
			this.includeText = v;
			this.updateStage();
		});
		label.createSpan({ text: "Include text" });
		this.statusEl = opts.createDiv({ cls: "pl-shot-status" });

		const wrap = root.createDiv({ cls: "pl-shot-stage" });
		this.previewEl = wrap.createEl("canvas", { cls: "pl-shot-preview" });
		// Dims everything outside the crop (clipped to the stage); the frame + handles sit above it
		// and may overhang the stage edge so edge handles stay fully touchable.
		this.holeEl = wrap.createDiv({ cls: "pl-shot-shade" }).createDiv({ cls: "pl-shot-hole" });
		this.cropEl = wrap.createDiv({ cls: "pl-shot-crop" });
		this.cropEl.dataset.h = "move";
		for (const h of CROP_HANDLES) {
			const el = this.cropEl.createDiv({ cls: `pl-shot-handle pl-shot-handle-${h}` });
			el.dataset.h = h;
		}
		wrap.addEventListener("pointerdown", this.onDown);
		wrap.addEventListener("pointermove", this.onMove);
		wrap.addEventListener("pointerup", this.onUp);
		wrap.addEventListener("pointercancel", this.onUp);

		this.buildActions(root.createDiv({ cls: "pl-shot-actions" }));

		this.inkStage = renderInkCanvas(this.src, this.src.stage, this.scale);
		this.layout();
		this.updateStage();
		// Layout after the modal is in the DOM (sizes known).
		window.requestAnimationFrame(() => this.layout());
	}

	onClose(): void {
		this.closed = true;
		if (this.blobTimer !== null) window.clearTimeout(this.blobTimer);
		freeCanvas(this.inkStage);
		freeCanvas(this.textStage);
		freeCanvas(this.textLayer);
		freeCanvas(this.previewEl);
		this.contentEl.empty();
	}

	private buildActions(row: HTMLElement): void {
		const btn = (icon: string, text: string, run: () => void, cls = "") => {
			const b = row.createEl("button", { cls: `pl-shot-btn ${cls}`.trim() });
			setIcon(b.createSpan({ cls: "pl-shot-btn-icon" }), icon);
			b.createSpan({ text });
			b.addEventListener("click", (e) => {
				e.preventDefault();
				run();
			});
			return b;
		};
		if (canShareFiles()) {
			btn("share", Platform.isIosApp || Platform.isMobile ? "Share / Save to Photos" : "Share", () => this.share());
		}
		if (canCopyImage()) btn("copy", "Copy image", () => this.copy());
		btn("download", "Save to vault", () => void this.save(false));
		btn("image-plus", "Insert into note", () => void this.save(true), "mod-cta");
		btn("x", "Discard", () => this.close());
	}

	// ----- stage / preview ---------------------------------------------------------------------

	private currentStage(): HTMLCanvasElement | null {
		return this.includeText && this.textStage ? this.textStage : this.inkStage;
	}

	private updateStage(): void {
		if (this.includeText && !this.textStage && !this.textFailed && !this.textPending) void this.loadText();
		this.status();
		const st = this.currentStage();
		if (st) {
			this.previewEl.width = st.width;
			this.previewEl.height = st.height;
			this.previewEl.getContext("2d")?.drawImage(st, 0, 0);
		}
		this.scheduleBlob();
	}

	private status(): void {
		this.statusEl.removeClass("is-warning");
		if (this.textFailed) {
			this.statusEl.setText(this.textFailed);
			this.statusEl.addClass("is-warning");
		} else if (this.includeText && this.textPending) {
			this.statusEl.setText("Rendering text…");
		} else {
			this.statusEl.setText("");
		}
	}

	private async loadText(): Promise<void> {
		this.textPending = true;
		this.status();
		try {
			const layer = await this.src.rasterizeText(this.src.stage, this.scale);
			if (this.closed) {
				freeCanvas(layer);
				return;
			}
			this.textLayer = layer;
			this.textStage = renderInkCanvas(this.src, this.src.stage, this.scale, layer);
			// Final check: drawing the text layer must not have tainted the composite.
			this.textStage.getContext("2d")?.getImageData(0, 0, 1, 1);
		} catch (err) {
			console.warn("[ink-pages] screenshot: text rasterization failed, using ink only", err);
			freeCanvas(this.textStage);
			this.textStage = null;
			this.textFailed = "Text couldn't be rendered on this device — the screenshot contains ink only.";
			this.includeText = false;
			if (!this.closed) {
				this.toggle.setValue(false);
				this.toggle.setDisabled(true);
			}
		} finally {
			this.textPending = false;
		}
		if (!this.closed) this.updateStage();
	}

	/** Fit the stage into the modal and position the crop frame. */
	private layout(): void {
		const stage = this.src.stage;
		const wrap = this.previewEl.parentElement;
		if (!wrap) return;
		const availW = Math.max(200, (this.contentEl.clientWidth || window.innerWidth * 0.8) - 2);
		const availH = Math.max(160, window.innerHeight * 0.55);
		this.display = fitScale(stage.w, stage.h, availW, availH);
		wrap.style.width = `${Math.round(stage.w * this.display)}px`;
		wrap.style.height = `${Math.round(stage.h * this.display)}px`;
		this.positionCrop();
	}

	private positionCrop(): void {
		const s = this.display;
		const c = this.crop;
		for (const el of [this.cropEl, this.holeEl]) {
			const st = el.style;
			st.left = `${(c.x - this.src.stage.x) * s}px`;
			st.top = `${(c.y - this.src.stage.y) * s}px`;
			st.width = `${c.w * s}px`;
			st.height = `${c.h * s}px`;
		}
	}

	// ----- crop dragging -----------------------------------------------------------------------

	private readonly onDown = (e: PointerEvent): void => {
		if (this.drag) return;
		const target = e.target as Node | null;
		const t = target?.instanceOf(HTMLElement) ? target.closest<HTMLElement>("[data-h]") : null;
		const handle = t?.dataset.h as CropHandle | undefined;
		if (!handle) return;
		e.preventDefault();
		try {
			(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
		} catch {
			/* ignore */
		}
		this.drag = { id: e.pointerId, handle, x: e.clientX, y: e.clientY, start: { ...this.crop } };
	};

	private readonly onMove = (e: PointerEvent): void => {
		const d = this.drag;
		if (!d || e.pointerId !== d.id) return;
		e.preventDefault();
		const k = 1 / (this.display || 1);
		this.crop = dragCrop(d.start, d.handle, (e.clientX - d.x) * k, (e.clientY - d.y) * k, this.src.stage);
		this.positionCrop();
	};

	private readonly onUp = (e: PointerEvent): void => {
		if (!this.drag || e.pointerId !== this.drag.id) return;
		this.drag = null;
		this.scheduleBlob();
	};

	// ----- output ------------------------------------------------------------------------------

	private outputKey(): string {
		const c = this.crop;
		return `${this.includeText && this.textStage ? 1 : 0}:${c.x},${c.y},${c.w},${c.h}`;
	}

	private makeBlob(): Promise<Blob> {
		const key = this.outputKey();
		if (this.blob && this.blob.key === key) return this.blob.p;
		const st = this.currentStage();
		const p = (async () => {
			if (!st) throw new Error("nothing rendered");
			const { sx, sy, sw, sh } = cropPixels(this.crop, this.src.stage, this.scale);
			const out = makeCanvas(sw, sh);
			out.getContext("2d")?.drawImage(st, sx, sy, sw, sh, 0, 0, sw, sh);
			try {
				return await canvasToBlob(out);
			} finally {
				freeCanvas(out);
			}
		})();
		this.blob = { key, p };
		p.catch(() => {
			if (this.blob?.p === p) this.blob = null;
		});
		return p;
	}

	/** Pre-render the PNG so Share/Copy can run synchronously inside the tap (Safari gesture rules). */
	private scheduleBlob(): void {
		if (this.blobTimer !== null) window.clearTimeout(this.blobTimer);
		this.blobTimer = window.setTimeout(() => {
			this.blobTimer = null;
			if (!this.closed && !this.drag) this.makeBlob().catch(() => undefined);
		}, 150);
	}

	private fileName(): string {
		return screenshotName(this.src.noteBasename, new Date());
	}

	private share(): void {
		const nav = navigator as ShareNavigator;
		const name = this.fileName();
		void this.makeBlob()
			.then((blob) => nav.share?.({ files: [new File([blob], name, { type: "image/png" })] }))
			.catch((err: unknown) => {
				if (err instanceof Error && err.name === "AbortError") return; // user dismissed the sheet
				console.warn("[ink-pages] share failed", err);
				new Notice("Sharing failed. Try “Save to vault” instead.");
			});
	}

	private copy(): void {
		// Pass the promise straight to ClipboardItem: the write starts within the tap.
		void copyPngToClipboard(this.makeBlob()).then((ok) => new Notice(ok ? "Image copied." : "Copying the image isn't supported here."));
	}

	private async save(insert: boolean): Promise<void> {
		try {
			const file = await savePng(this.app, await this.makeBlob(), this.src.noteBasename, this.folder);
			if (insert) {
				const link = "!" + this.app.fileManager.generateMarkdownLink(file, this.src.notePath);
				if (!this.src.insertAtCursor(link)) new Notice(`Saved to ${file.path} (the note is no longer open).`);
			} else {
				new Notice(`Saved to ${file.path}`);
			}
			this.close();
		} catch (err) {
			console.error("[ink-pages] saving the screenshot failed", err);
			new Notice("Saving the screenshot failed.");
		}
	}
}
