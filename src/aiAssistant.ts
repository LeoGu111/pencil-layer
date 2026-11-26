/**
 * Account-first Google Gemini / Google AI Pro integration for Ink Pages.
 *
 * - **Desktop (Electron):** Native Obsidian sidebar pane (`GeminiWebView`) embedding
 *   `https://gemini.google.com/app` in a persistent `<webview>` partition so users sign in directly
 *   with their Google Account (Google AI Pro) — zero API key required.
 * - **iPad / iPadOS (WKWebView) & Desktop Modal:** Account-first workflow with 1-tap clipboard
 *   handoff (copies handwritten sketch/formula PNG image or question + note context directly to
 *   the system clipboard and opens `https://gemini.google.com/app` in your logged-in Google AI Pro
 *   account — ideal side-by-side in iPad Split View / Slide Over).
 * - **Optional Advanced Mode:** Collapsible direct Gemini API mode (`requestUrl`) for users who
 *   choose to paste an optional Google AI Studio key for direct in-app replies & Vision LaTeX.
 */
import { App, Modal, Notice, Platform, requestUrl } from "obsidian";
import { copyPngToClipboard } from "./screenshot";

export type GeminiModel = "gemini-2.5-flash" | "gemini-2.5-pro";

export const GEMINI_MODELS: readonly { value: GeminiModel; label: string }[] = [
	{ value: "gemini-2.5-flash", label: "Gemini 2.5 Flash (schnell)" },
	{ value: "gemini-2.5-pro", label: "Gemini 2.5 Pro (tiefes Denken)" },
];

export const GEMINI_VIEW_TYPE = "ink-pages-gemini-view";
export const GEMINI_WEB_URL = "https://gemini.google.com/app";
export const GEMINI_API_KEY_URL = "https://aistudio.google.com/apikey";

export interface GeminiMessage {
	role: "user" | "model";
	text: string;
}

export interface GeminiRequest {
	apiKey: string;
	model: GeminiModel;
	prompt: string;
	noteContext?: string;
	imageBase64Png?: string;
	history?: readonly GeminiMessage[];
}

export interface AssistantLaunchOptions {
	noteTitle?: string;
	noteContext?: string;
	/** Optional base64 PNG (without data URL prefix) of a handwritten lasso selection. */
	imageBase64Png?: string;
	initialPrompt?: string;
	insertAtCursor?: (text: string) => boolean;
}

export interface AssistantHost {
	getApiKey(): string;
	setApiKey(key: string): void;
	getModel(): GeminiModel;
	setModel(model: GeminiModel): void;
	/** Opens the embedded Gemini account sidebar pane (desktop Electron). */
	openSidebar?(): Promise<void>;
}

/** Build the combined text prompt sent to Gemini web (Google AI Pro) when handing off via clipboard. */
export function buildWebHandoffPrompt(question: string, noteTitle?: string, noteContext?: string): string {
	const parts: string[] = [];
	const q = question.trim();
	if (q) parts.push(q);
	if (noteContext && noteContext.trim()) {
		const trimmed = noteContext.trim().slice(0, 6000);
		parts.push(`\n---\nNotiz-Kontext${noteTitle ? ` (${noteTitle})` : ""}:\n${trimmed}`);
	}
	return parts.join("\n").trim();
}

/** Convert base64 PNG data (no prefix) into a PNG Blob for system clipboard copying. */
export function base64ToPngBlob(base64Png: string): Blob {
	const bin = atob(base64Png);
	const bytes = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
	return new Blob([bytes], { type: "image/png" });
}

/** Copy a handwritten PNG image to the system clipboard and open Gemini (Google AI Pro). */
export async function handoffImageToGeminiAccount(base64Png: string, openSidebar?: () => Promise<void>): Promise<void> {
	try {
		const blob = Promise.resolve(base64ToPngBlob(base64Png));
		const copied = await copyPngToClipboard(blob);
		if (copied) {
			new Notice("Handschrift als Bild kopiert — einfach in Gemini (Google-Konto) einfügen!", 4000);
		} else {
			new Notice("Gemini wird geöffnet — bitte Bild ggf. per Screenshot teilen.", 3500);
		}
	} catch {
		new Notice("Gemini wird geöffnet…", 2500);
	}
	if (!Platform.isMobile && openSidebar) {
		await openSidebar();
	} else {
		window.open(GEMINI_WEB_URL, "_blank", "noopener");
	}
}

/** Call Google Gemini `generateContent` via Obsidian `requestUrl` (optional API mode). */
export async function askGemini(req: GeminiRequest): Promise<string> {
	const key = req.apiKey.trim();
	if (!key) throw new Error("Kein optionaler Gemini API-Key hinterlegt.");

	const contents: { role: "user" | "model"; parts: Record<string, unknown>[] }[] = [];
	for (const h of req.history ?? []) {
		contents.push({ role: h.role, parts: [{ text: h.text }] });
	}

	const userParts: Record<string, unknown>[] = [];
	const contextPrefix = req.noteContext?.trim()
		? `Kontext aus der aktuellen Obsidian-Notiz:\n"""\n${req.noteContext.trim().slice(0, 8000)}\n"""\n\n`
		: "";
	userParts.push({ text: `${contextPrefix}${req.prompt.trim()}` });
	if (req.imageBase64Png) {
		userParts.push({
			inline_data: {
				mime_type: "image/png",
				data: req.imageBase64Png,
			},
		});
	}
	contents.push({ role: "user", parts: userParts });

	const res = await requestUrl({
		url: `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(req.model)}:generateContent?key=${encodeURIComponent(key)}`,
		method: "POST",
		headers: { "Content-Type": "application/json" },
		throw: false,
		body: JSON.stringify({
			systemInstruction: {
				parts: [
					{
						text: "Du bist ein hilfreicher Studien- und Notiz-Assistent in Obsidian. Antworte klar, präzise und in der Sprache der Frage. Verwende für mathematische Formeln sauberes LaTeX ($...$ für inline, $$...$$ für Blöcke).",
					},
				],
			},
			contents,
		}),
	});

	if (res.status < 200 || res.status >= 300) {
		const errJson = res.json as { error?: { message?: string } } | undefined;
		const msg = errJson?.error?.message ?? `HTTP ${res.status}`;
		throw new Error(`Gemini API Fehler: ${msg}`);
	}
	const json = res.json as {
		candidates?: { content?: { parts?: { text?: string }[] } }[];
	};
	const text = (json?.candidates?.[0]?.content?.parts ?? [])
		.map((p) => p.text ?? "")
		.join("")
		.trim();
	if (!text) throw new Error("Gemini hat keine Antwort zurückgegeben.");
	return text;
}

const QUICK_PROMPTS_TEXT = [
	{ label: "Erklären", prompt: "Erkläre den Inhalt dieser Notiz einfach und verständlich." },
	{ label: "Zusammenfassen", prompt: "Fasse diese Notiz in klaren Stichpunkten zusammen." },
	{ label: "Prüfen", prompt: "Prüfe meine Notizen und Rechnungen auf Fehler und gib hilfreiche Hinweise." },
	{ label: "Übungsfragen", prompt: "Erstelle 3 kurze Verständnisfragen zu dieser Notiz." },
] as const;

const QUICK_PROMPTS_IMAGE = [
	{ label: "Rechnung prüfen", prompt: "Prüfe diese handschriftliche Rechnung Schritt für Schritt auf Fehler." },
	{ label: "Erklären", prompt: "Erkläre diese handschriftliche Skizze / Formel verständlich." },
	{ label: "Als LaTeX", prompt: "Wandle diese handschriftliche Formel in sauberes Obsidian-LaTeX ($...$ / $$...$$) um." },
	{ label: "Weiterlösen", prompt: "Löse diese Aufgabe Schritt für Schritt weiter und erkläre jeden Schritt." },
] as const;

export class GeminiAssistantModal extends Modal {
	private history: GeminiMessage[] = [];
	private includeNoteContext = true;
	private busy = false;
	private threadEl!: HTMLElement;
	private inputEl!: HTMLTextAreaElement;
	private sendBtn: HTMLButtonElement | null = null;
	private statusEl!: HTMLElement;

	constructor(
		app: App,
		private readonly host: AssistantHost,
		private readonly opts: AssistantLaunchOptions = {},
	) {
		super(app);
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();
		this.modalEl.addClass("pl-ai-modal");
		this.titleEl.setText("Gemini (Google AI Pro)");

		const hasKey = this.host.getApiKey().trim().length > 0;

		// Account-first hero card (zero API key needed!)
		const accountCard = contentEl.createDiv({ cls: "pl-ai-account-card" });
		const accountText = accountCard.createDiv({ cls: "pl-ai-account-desc" });
		if (Platform.isDesktopApp) {
			accountText.setText(
				"Melde dich direkt mit deinem Google-Konto (Google AI Pro) in der Obsidian-Seitenleiste an — ganz ohne API-Key.",
			);
		} else {
			accountText.setText(
				"Nutze dein Google AI Pro Konto ohne API-Key: Frage oder Handschrift-Bild wird kopiert und direkt in Gemini (ideal im iPad Split View) geöffnet. (Hinweis: Google blockiert Konto-Logins in eingebetteten iPadOS-WebViews.)",
			);
		}
		const accountActions = accountCard.createDiv({ cls: "pl-ai-account-actions" });
		if (this.opts.imageBase64Png) {
			const imgBtn = accountActions.createEl("button", {
				cls: "mod-cta",
				text: Platform.isDesktopApp ? "Bild kopieren & Gemini-Seitenleiste öffnen" : "Bild kopieren & in Gemini (Konto) öffnen ↗",
			});
			imgBtn.addEventListener("click", () => {
				const openSidebar = this.host.openSidebar ? () => this.host.openSidebar!() : undefined;
				void handoffImageToGeminiAccount(this.opts.imageBase64Png!, openSidebar).then(() => this.close());
			});
		}
		const textProBtn = accountActions.createEl("button", {
			cls: this.opts.imageBase64Png ? "" : "mod-cta",
			text: Platform.isDesktopApp ? "Frage kopieren & Gemini-Seitenleiste öffnen" : "Frage + Kontext kopieren & Gemini öffnen ↗",
		});
		textProBtn.addEventListener("click", () => void this.openInGoogleAiPro());

		// Attached handwritten selection preview (if launched from Lasso)
		if (this.opts.imageBase64Png) {
			const att = contentEl.createDiv({ cls: "pl-ai-attachment" });
			att.createEl("img", {
				cls: "pl-ai-attachment-img",
				attr: { src: `data:image/png;base64,${this.opts.imageBase64Png}`, alt: "Ausgewählte Handschrift" },
			});
			att.createSpan({ cls: "pl-ai-attachment-label", text: "Handschrift-Auswahl bereit zum Kopieren / Senden" });
		}

		// Context toggle if note text exists
		if (this.opts.noteContext?.trim()) {
			const ctxRow = contentEl.createEl("label", { cls: "pl-ai-ctx-toggle" });
			const cb = ctxRow.createEl("input", { type: "checkbox" });
			cb.checked = this.includeNoteContext;
			cb.addEventListener("change", () => {
				this.includeNoteContext = cb.checked;
			});
			ctxRow.createSpan({
				text: `Notiz-Kontext mitsenden${this.opts.noteTitle ? ` (${this.opts.noteTitle})` : ""}`,
			});
		}

		// Quick prompt chips
		const chips = contentEl.createDiv({ cls: "pl-ai-chips" });
		const presets = this.opts.imageBase64Png ? QUICK_PROMPTS_IMAGE : QUICK_PROMPTS_TEXT;
		for (const p of presets) {
			const chip = chips.createEl("button", { cls: "pl-ai-chip", text: p.label });
			chip.addEventListener("click", () => {
				this.inputEl.value = p.prompt;
				if (this.host.getApiKey().trim()) void this.send();
				else this.inputEl.focus();
			});
		}

		// Input bar
		const composer = contentEl.createDiv({ cls: "pl-ai-composer" });
		this.inputEl = composer.createEl("textarea", {
			cls: "pl-ai-input",
			attr: {
				rows: "2",
				placeholder: this.opts.imageBase64Png
					? "Frage zur Auswahl (z. B. Prüfe meine Rechnung / Wandle in LaTeX um)..."
					: "Frage an dein Gemini-Konto schreiben...",
			},
		});
		if (this.opts.initialPrompt) this.inputEl.value = this.opts.initialPrompt;
		this.inputEl.addEventListener("keydown", (e) => {
			if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
				e.preventDefault();
				if (this.host.getApiKey().trim()) void this.send();
				else void this.openInGoogleAiPro();
			}
		});
		if (hasKey) {
			this.sendBtn = composer.createEl("button", { cls: "mod-cta pl-ai-send", text: "Direkt senden" });
			this.sendBtn.addEventListener("click", () => void this.send());
		}

		// Chat thread (used when optional API key is active)
		this.threadEl = contentEl.createDiv({ cls: "pl-ai-thread" });
		this.statusEl = contentEl.createDiv({ cls: "pl-ai-status pl-hidden" });

		// Collapsible optional API section (tucked away, never nags!)
		const adv = contentEl.createEl("details", { cls: "pl-ai-advanced" });
		adv.createEl("summary", {
			text: hasKey ? "Direkt-Modus aktiv (API-Key / Modell ändern)" : "Optional: Direktantwort in Obsidian ohne App-Wechsel (API-Key)",
		});
		const advBody = adv.createDiv({ cls: "pl-ai-advanced-body" });
		const modelSelect = advBody.createEl("select", { cls: "dropdown pl-ai-model" });
		for (const m of GEMINI_MODELS) {
			const opt = modelSelect.createEl("option", { value: m.value, text: m.label });
			if (m.value === this.host.getModel()) opt.selected = true;
		}
		modelSelect.addEventListener("change", () => {
			this.host.setModel(modelSelect.value as GeminiModel);
		});
		const row = advBody.createDiv({ cls: "pl-ai-key-row" });
		const keyInput = row.createEl("input", {
			type: "password",
			placeholder: "Optionaler Gemini API-Key (AIza...)",
			cls: "pl-ai-key-input",
			value: this.host.getApiKey(),
		});
		const saveKeyBtn = row.createEl("button", { text: "Speichern" });
		saveKeyBtn.addEventListener("click", () => {
			this.host.setApiKey(keyInput.value.trim());
			new Notice("Gespeichert.");
			this.onOpen();
		});
		const getKeyLink = row.createEl("a", {
			text: "Kostenloser Key ↗",
			href: GEMINI_API_KEY_URL,
			cls: "pl-ai-key-link",
		});
		getKeyLink.setAttribute("target", "_blank");
		getKeyLink.setAttribute("rel", "noopener");
	}

	onClose(): void {
		this.contentEl.empty();
	}

	private async openInGoogleAiPro(): Promise<void> {
		const q = this.inputEl?.value.trim() || "Hilf mir bei dieser Notiz:";
		const payload = buildWebHandoffPrompt(q, this.opts.noteTitle, this.includeNoteContext ? this.opts.noteContext : undefined);
		try {
			if (payload && navigator.clipboard?.writeText) {
				await navigator.clipboard.writeText(payload);
				new Notice("Frage & Notiz-Kontext kopiert — einfach in Gemini (Google-Konto) einfügen!", 3800);
			}
		} catch {
			/* ignore */
		}
		if (Platform.isDesktopApp && this.host.openSidebar) {
			await this.host.openSidebar();
			this.close();
		} else {
			window.open(GEMINI_WEB_URL, "_blank", "noopener");
			this.close();
		}
	}

	private appendMessage(msg: GeminiMessage): void {
		const bubble = this.threadEl.createDiv({ cls: `pl-ai-msg is-${msg.role}` });
		bubble.createDiv({ cls: "pl-ai-msg-role", text: msg.role === "user" ? "Du" : "Gemini" });
		bubble.createDiv({ cls: "pl-ai-msg-body", text: msg.text });
		if (msg.role === "model") {
			const actions = bubble.createDiv({ cls: "pl-ai-msg-actions" });
			const copyBtn = actions.createEl("button", { text: "Kopieren" });
			copyBtn.addEventListener("click", () => {
				void navigator.clipboard?.writeText(msg.text).then(() => new Notice("Antwort kopiert."));
			});
			if (this.opts.insertAtCursor) {
				const insBtn = actions.createEl("button", { cls: "mod-cta", text: "In Notiz einfügen" });
				insBtn.addEventListener("click", () => {
					if (this.opts.insertAtCursor?.(msg.text)) {
						new Notice("Antwort in die Notiz eingefügt.");
						this.close();
					}
				});
			}
		}
		this.threadEl.scrollTop = this.threadEl.scrollHeight;
	}

	private async send(): Promise<void> {
		if (this.busy) return;
		const prompt = this.inputEl.value.trim();
		if (!prompt) return;
		const apiKey = this.host.getApiKey().trim();
		if (!apiKey) {
			await this.openInGoogleAiPro();
			return;
		}
		this.busy = true;
		if (this.sendBtn) this.sendBtn.disabled = true;
		this.inputEl.value = "";
		this.appendMessage({ role: "user", text: prompt });
		this.statusEl.removeClass("pl-hidden");
		this.statusEl.setText("Gemini denkt nach…");
		try {
			const reply = await askGemini({
				apiKey,
				model: this.host.getModel(),
				prompt,
				noteContext: this.includeNoteContext && this.history.length === 0 ? this.opts.noteContext : undefined,
				imageBase64Png: this.history.length === 0 ? this.opts.imageBase64Png : undefined,
				history: this.history,
			});
			this.history.push({ role: "user", text: prompt }, { role: "model", text: reply });
			this.appendMessage({ role: "model", text: reply });
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			new Notice(msg, 5000);
			this.appendMessage({ role: "model", text: `Fehler: ${msg}` });
		} finally {
			this.busy = false;
			if (this.sendBtn) this.sendBtn.disabled = false;
			this.statusEl.addClass("pl-hidden");
		}
	}
}
