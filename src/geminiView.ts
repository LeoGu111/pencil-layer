/**
 * Embedded Google Gemini (Google AI Pro Konto-Login) sidebar view for Obsidian Desktop (Electron).
 * On iPadOS, Apple's WKWebView + Google's X-Frame-Options disallow embedded Google sign-in iframes,
 * so the view provides a 1-tap button to open Gemini in Split View / Safari alongside Obsidian.
 */
import { ItemView, Platform, WorkspaceLeaf } from "obsidian";
import { GEMINI_VIEW_TYPE, GEMINI_WEB_URL } from "./aiAssistant";

export class GeminiWebView extends ItemView {
	constructor(leaf: WorkspaceLeaf) {
		super(leaf);
	}

	getViewType(): string {
		return GEMINI_VIEW_TYPE;
	}

	getDisplayText(): string {
		return "Gemini (Google account)";
	}

	getIcon(): string {
		return "sparkles";
	}

	async onOpen(): Promise<void> {
		const container = this.contentEl;
		container.empty();
		container.addClass("pl-gemini-view");

		const header = container.createDiv({ cls: "pl-gemini-bar" });
		header.createSpan({ cls: "pl-gemini-title", text: "Google Gemini (account)" });
		const extBtn = header.createEl("button", { text: "Open in browser ↗" });
		extBtn.addEventListener("click", () => window.open(GEMINI_WEB_URL, "_blank", "noopener"));

		if (Platform.isDesktopApp) {
			// Electron <webview> persists Google Account login natively in its own session partition.
			const webview = container.createEl("webview" as keyof HTMLElementTagNameMap, {
				cls: "pl-gemini-webview",
				attr: {
					src: GEMINI_WEB_URL,
					partition: "persist:ink-pages-gemini",
					allowpopups: "true",
				},
			});
			const reloadBtn = header.createEl("button", { text: "Reload" });
			reloadBtn.addEventListener("click", () => {
				const wv = webview as HTMLElement & { reload?: () => void };
				wv.reload?.();
			});
		} else {
			const box = container.createDiv({ cls: "pl-gemini-mobile-info" });
			box.createEl("p", {
				text: "On iPad, Google blocks direct account sign-in inside embedded app WebViews (X-Frame-Options / iPadOS WKWebView).",
			});
			box.createEl("p", {
				text: "Tip for your Google AI Pro subscription without an API key: open Gemini in Safari or the Gemini app in iPad Split View / Slide Over next to Obsidian. Using ✨ or Lasso → “Ask AI”, Ink Pages copies your handwriting (as an image) or question + note in one tap for instant pasting.",
			});
			const openBtn = box.createEl("button", { cls: "mod-cta", text: "Open Gemini (Google AI Pro) ↗" });
			openBtn.addEventListener("click", () => window.open(GEMINI_WEB_URL, "_blank", "noopener"));
		}
		await Promise.resolve();
	}

	async onClose(): Promise<void> {
		this.contentEl.empty();
		await Promise.resolve();
	}
}
