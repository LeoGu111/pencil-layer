/**
 * Stage H — "Export PDF with / without ink" (and "… (document style)", docStyle.ts) as one-shot
 * exports (state logic: exportOnce.ts).
 *
 * Obsidian's `workspace:export-pdf` opens its export dialog (a Modal). On desktop "Export" first
 * awaits a native save dialog (cancelling it leaves the dialog open), then closes the dialog and
 * renders the note in a hidden window, running our print post-processor once (readingView.ts asks
 * `takeOptions()`). On mobile the dialog closes and the note renders in a `.print` div.
 *
 * We arm the override, run the command and watch the dialog's `.modal-container` (MutationObserver
 * on <body>): when it goes away the override survives a short grace period for the render to start;
 * a new dialog after that, the render consuming it, or the timeouts drop it. The persisted
 * "Include ink in PDF export" toggle and the "Default export style" setting are never changed.
 */
import { App, MarkdownView } from "obsidian";
import { ExportChoice, ExportOptions, ExportOverride, arm, dialogClosed, otherDialog, pending, take } from "./exportOnce";

const EXPORT_COMMAND = "workspace:export-pdf";
/** No dialog appeared this long after the command ran: treat it as closed (grace only). */
const NO_DIALOG_MS = 2000;

interface Commands {
	findCommand?(id: string): unknown;
	executeCommandById(id: string): boolean;
}

export class PdfExporter {
	private override: ExportOverride | null = null;
	private observer: MutationObserver | null = null;
	private dialog: Element | null = null;
	private timers: number[] = [];

	constructor(
		private readonly app: App,
		/** The defaults: "Include ink in PDF export" toggle, "Default export style". */
		private readonly defaults: () => ExportOptions,
	) {}

	private commands(): Commands | null {
		return (this.app as unknown as { commands?: Commands }).commands ?? null;
	}

	/** Obsidian's export exists and `view` (default: the active Markdown view) shows a file. */
	canExport(view?: MarkdownView | null): boolean {
		const v = view ?? this.app.workspace.getActiveViewOfType(MarkdownView);
		return !!v?.file && !!this.commands()?.findCommand?.(EXPORT_COMMAND);
	}

	/** One-shot export of `view` (default: active) with / without ink and/or in a given style. */
	run(choice: ExportChoice, view?: MarkdownView | null): boolean {
		const v = view ?? this.app.workspace.getActiveViewOfType(MarkdownView);
		const commands = this.commands();
		if (!v || !commands || !this.canExport(v)) return false;
		// The export works on the active leaf (a toolbar of another pane exports its own note).
		if (this.app.workspace.getActiveViewOfType(MarkdownView) !== v) this.app.workspace.setActiveLeaf(v.leaf, { focus: false });
		this.reset();
		this.override = arm(choice, Date.now());
		const doc = activeDocument;
		const before = new Set(Array.from(doc.body.children).filter(isDialog));
		this.observer = new MutationObserver(() => this.onMutation(doc));
		this.observer.observe(doc.body, { childList: true });
		commands.executeCommandById(EXPORT_COMMAND);
		this.dialog = Array.from(doc.body.children).find((c) => isDialog(c) && !before.has(c)) ?? null;
		this.timers.push(
			window.setTimeout(() => {
				if (!this.dialog && this.override?.phase === "dialog") this.closed();
			}, NO_DIALOG_MS),
		);
		return true;
	}

	/** The print post-processor: ink and style of THIS export. Consumes the one-shot override. */
	takeOptions(): ExportOptions {
		const { include, style, next } = take(this.override, this.defaults(), Date.now());
		this.override = next;
		this.reset();
		return { include, style };
	}

	/** The armed one-shot export, if any (tests / smoke checks). */
	get armed(): ExportChoice | null {
		const o = this.override;
		return pending(o, Date.now()) ? { include: o.include, style: o.style } : null;
	}

	destroy(): void {
		this.override = null;
		this.reset();
	}

	private onMutation(doc: Document): void {
		if (!this.override) return this.reset();
		const dialogs = Array.from(doc.body.children).filter(isDialog);
		if (this.override.phase === "closed") {
			// A new dialog after ours closed: no render followed ours (cancelled, another export).
			if (dialogs.length > 0) this.setOverride(otherDialog(this.override));
			return;
		}
		// The dialog may open asynchronously: the first new one is ours.
		if (!this.dialog) this.dialog = dialogs.length > 0 ? dialogs[dialogs.length - 1] : null;
		else if (!this.dialog.isConnected) this.closed();
	}

	private closed(): void {
		this.dialog = null;
		this.setOverride(dialogClosed(this.override, Date.now()));
		if (!this.override) return;
		const left = Math.max(0, this.override.until - Date.now());
		this.timers.push(window.setTimeout(() => this.setOverride(null), left + 50));
	}

	private setOverride(o: ExportOverride | null): void {
		this.override = o;
		if (!o) this.reset();
	}

	private reset(): void {
		this.observer?.disconnect();
		this.observer = null;
		this.dialog = null;
		for (const t of this.timers) window.clearTimeout(t);
		this.timers = [];
	}
}

function isDialog(el: Element): boolean {
	return el.classList.contains("modal-container");
}
