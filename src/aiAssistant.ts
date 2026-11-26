/**
 * In-app Google Gemini AI Assistant + Google AI Pro (gemini.google.com) quick handoff.
 *
 * - Direct in-app chat (supports text questions, current note context, and attached handwritten
 *   ink/formula PNG images from the Lasso menu) via the official Google Gemini API using Obsidian's
 *   `requestUrl` (bypasses iOS WKWebView CORS).
 * - Quick handoff to `https://gemini.google.com/app` for users who want to use their Google AI Pro
 *   consumer web subscription directly without an API key (copies prompt + context to clipboard).
 */
import { App, Modal, Notice, requestUrl } from "obsidian";

export type GeminiModel = "gemini-2.5-flash" | "gemini-2.5-pro";

export const GEMINI_MODELS: readonly { value: GeminiModel; label: string }[] = [
	{ value: "gemini-2.5-flash", label: "Gemini 2.5 Flash (schnell)" },
	{ value: "gemini-2.5-pro", label: "Gemini 2.5 Pro (tiefes Denken)" },
];

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

/** Call Google Gemini `generateContent` via Obsidian `requestUrl` (works on iPad & Desktop). */
export async function askGemini(req: GeminiRequest): Promise<string> {
	const key = req.apiKey.trim();
	if (!key) throw new Error("Kein Gemini API-Key hinterlegt.");

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
	{ label: "Als LaTeX", prompt: "Wandle diese handschriftliche Formel in sauberes Obsidian-LaTeX um." },
	{ label: "Weiterlösen", prompt: "Löse diese Aufgabe Schritt für Schritt weiter und erkläre jeden Schritt." },
] as const;

export class GeminiAssistantModal extends Modal {
	private history: GeminiMessage[] = [];
	private includeNoteContext = true;
	private busy = false;
	private threadEl!: HTMLElement;
	private inputEl!: HTMLTextAreaElement;
	private sendBtn!: HTMLButtonElement;
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
		this.titleEl.setText("Gemini KI-Assistent");

		// Model + API key quick status bar
		const topBar = contentEl.createDiv({ cls: "pl-ai-topbar" });
		const modelSelect = topBar.createEl("select", { cls: "dropdown pl-ai-model" });
		for (const m of GEMINI_MODELS) {
			const opt = modelSelect.createEl("option", { value: m.value, text: m.label });
			if (m.value === this.host.getModel()) opt.selected = true;
		}
		modelSelect.addEventListener("change", () => {
			this.host.setModel(modelSelect.value as GeminiModel);
		});

		const openProBtn = topBar.createEl("button", {
			cls: "pl-ai-pro-btn",
			text: "In Google AI Pro öffnen",
		});
		openProBtn.addEventListener("click", () => void this.openInGoogleAiPro());

		// Honest info banner when no Gemini API key is configured yet
		const keyRow = contentEl.createDiv({ cls: "pl-ai-key-box" });
		const renderKeyBox = () => {
			keyRow.empty();
			const hasKey = this.host.getApiKey().trim().length > 0;
			if (hasKey) {
				keyRow.addClass("pl-hidden");
				return;
			}
			keyRow.removeClass("pl-hidden");
			keyRow.createDiv({
				cls: "pl-ai-info",
				text: "Hinweis zum Google AI Pro Abo: Google erlaubt Drittanbieter-Apps leider keinen direkten Login ins Consumer-Abo (gemini.google.com). Für direkte Antworten in der App brauchst du einen kostenlosen Google AI Studio API-Key (funktioniert auch für den Formel-Umwandler!) — oder nutze oben „In Google AI Pro öffnen“.",
			});
			const row = keyRow.createDiv({ cls: "pl-ai-key-row" });
			const keyInput = row.createEl("input", {
				type: "password",
				placeholder: "Gemini API-Key einfügen (AIza...)",
				cls: "pl-ai-key-input",
			});
			const saveKeyBtn = row.createEl("button", { cls: "mod-cta", text: "Speichern" });
			saveKeyBtn.addEventListener("click", () => {
				const k = keyInput.value.trim();
				if (!k) return;
				this.host.setApiKey(k);
				new Notice("Gemini API-Key gespeichert (lokal auf diesem Gerät).");
				renderKeyBox();
			});
			const getKeyLink = row.createEl("a", {
				text: "Key holen ↗",
				href: GEMINI_API_KEY_URL,
				cls: "pl-ai-key-link",
			});
			getKeyLink.setAttribute("target", "_blank");
			getKeyLink.setAttribute("rel", "noopener");
		};
		renderKeyBox();

		// Attached handwritten selection preview (if launched from Lasso)
		if (this.opts.imageBase64Png) {
			const att = contentEl.createDiv({ cls: "pl-ai-attachment" });
			att.createEl("img", {
				cls: "pl-ai-attachment-img",
				attr: { src: `data:image/png;base64,${this.opts.imageBase64Png}`, alt: "Ausgewählte Handschrift" },
			});
			att.createSpan({ cls: "pl-ai-attachment-label", text: "Handschrift-Auswahl angehängt" });
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

		// Chat thread
		this.threadEl = contentEl.createDiv({ cls: "pl-ai-thread" });
		this.statusEl = contentEl.createDiv({ cls: "pl-ai-status pl-hidden" });

		// Input bar
		const composer = contentEl.createDiv({ cls: "pl-ai-composer" });
		this.inputEl = composer.createEl("textarea", {
			cls: "pl-ai-input",
			attr: {
				rows: "2",
				placeholder: this.opts.imageBase64Png
					? "Frage zur Auswahl stellen (z. B. Prüfe meine Rechnung)..."
					: "Frage an Gemini stellen...",
			},
		});
		if (this.opts.initialPrompt) this.inputEl.value = this.opts.initialPrompt;
		this.inputEl.addEventListener("keydown", (e) => {
			if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
				e.preventDefault();
				void this.send();
			}
		});
		this.sendBtn = composer.createEl("button", { cls: "mod-cta pl-ai-send", text: "Senden" });
		this.sendBtn.addEventListener("click", () => void this.send());
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
				new Notice("Frage & Kontext kopiert — einfach in Gemini (Google AI Pro) einfügen!", 3500);
			}
		} catch {
			/* ignore clipboard errors on restricted environments */
		}
		window.open(GEMINI_WEB_URL, "_blank", "noopener");
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
			new Notice("Bitte erst einen Gemini API-Key eingeben oder „In Google AI Pro öffnen“ nutzen.");
			return;
		}
		this.busy = true;
		this.sendBtn.disabled = true;
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
			this.sendBtn.disabled = false;
			this.statusEl.addClass("pl-hidden");
		}
	}
}
