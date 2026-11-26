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
		return "Gemini (Google-Konto)";
	}

	getIcon(): string {
		return "sparkles";
	}

	async onOpen(): Promise<void> {
		const container = this.contentEl;
		container.empty();
		container.addClass("pl-gemini-view");

		const header = container.createDiv({ cls: "pl-gemini-bar" });
		header.createSpan({ cls: "pl-gemini-title", text: "Google Gemini (Konto)" });
		const extBtn = header.createEl("button", { text: "Im Browser ↗" });
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
			const reloadBtn = header.createEl("button", { text: "Neu laden" });
			reloadBtn.addEventListener("click", () => {
				const wv = webview as HTMLElement & { reload?: () => void };
				wv.reload?.();
			});
		} else {
			const box = container.createDiv({ cls: "pl-gemini-mobile-info" });
			box.createEl("p", {
				text: "Auf dem iPad blockiert Google den direkten Konto-Login innerhalb von eingebetteten App-WebViews (X-Frame-Options / iPadOS WKWebView).",
			});
			box.createEl("p", {
				text: "Tipp für dein Google AI Pro Abo ohne API-Key: Öffne Gemini in Safari oder der Gemini-App per iPad Split View / Slide Over neben Obsidian. Über ✨ oder Lasso → „Frag KI“ kopiert Ink Pages deine Handschrift (als Bild) bzw. Frage + Notiz mit einem Tipp zum direkten Einfügen.",
			});
			const openBtn = box.createEl("button", { cls: "mod-cta", text: "Gemini (Google AI Pro) öffnen ↗" });
			openBtn.addEventListener("click", () => window.open(GEMINI_WEB_URL, "_blank", "noopener"));
		}
		await Promise.resolve();
	}

	async onClose(): Promise<void> {
		this.contentEl.empty();
		await Promise.resolve();
	}
}
