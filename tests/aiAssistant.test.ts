import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { notices, mockRequestUrl, mockPlatform, MockEl } = vi.hoisted(() => {
	const notices: string[] = [];
	const mockRequestUrl = vi.fn();
	const mockPlatform = { isDesktopApp: false, isMobile: true, isIosApp: true };

	class MockEl {
		readonly tagName: string;
		readonly children: MockEl[] = [];
		readonly classList = new Set<string>();
		readonly attributes = new Map<string, string>();
		readonly listeners = new Map<string, ((ev?: unknown) => void)[]>();
		parentElement: MockEl | null = null;
		textContent = "";
		value = "";
		checked = false;
		disabled = false;
		scrollTop = 0;
		scrollHeight = 100;
		type = "";
		placeholder = "";
		href = "";
		selected = false;
		focused = false;

		constructor(tagName: string) {
			this.tagName = tagName.toLowerCase();
		}

		empty(): void {
			for (const c of this.children) c.parentElement = null;
			this.children.length = 0;
			this.textContent = "";
		}

		addClass(...cls: string[]): void {
			for (const c of cls) {
				for (const part of c.split(/\s+/)) {
					if (part) this.classList.add(part);
				}
			}
		}

		removeClass(...cls: string[]): void {
			for (const c of cls) this.classList.delete(c);
		}

		setText(text: string): void {
			this.textContent = text;
		}

		setAttribute(name: string, value: string): void {
			this.attributes.set(name, value);
		}

		remove(): void {
			if (!this.parentElement) return;
			const idx = this.parentElement.children.indexOf(this);
			if (idx >= 0) this.parentElement.children.splice(idx, 1);
			this.parentElement = null;
		}

		focus(): void {
			this.focused = true;
		}

		addEventListener(type: string, fn: (ev?: unknown) => void): void {
			const list = this.listeners.get(type) ?? [];
			list.push(fn);
			this.listeners.set(type, list);
		}

		trigger(type: string, ev?: unknown): void {
			for (const fn of this.listeners.get(type) ?? []) fn(ev);
		}

		click(): void {
			this.trigger("click");
		}

		createDiv(opts?: { cls?: string; text?: string }): MockEl {
			return this.createEl("div", opts);
		}

		createSpan(opts?: { cls?: string; text?: string }): MockEl {
			return this.createEl("span", opts);
		}

		createEl(
			tag: string,
			opts?: {
				cls?: string;
				text?: string;
				type?: string;
				value?: string;
				placeholder?: string;
				href?: string;
				attr?: Record<string, string>;
			},
		): MockEl {
			const el = new MockEl(tag);
			if (opts?.cls) el.addClass(opts.cls);
			if (opts?.text !== undefined) el.textContent = opts.text;
			if (opts?.type !== undefined) el.type = opts.type;
			if (opts?.value !== undefined) el.value = opts.value;
			if (opts?.placeholder !== undefined) el.placeholder = opts.placeholder;
			if (opts?.href !== undefined) el.href = opts.href;
			if (opts?.attr) {
				for (const [k, v] of Object.entries(opts.attr)) el.setAttribute(k, v);
			}
			el.parentElement = this;
			this.children.push(el);
			return el;
		}

		findAll(predicate: (el: MockEl) => boolean): MockEl[] {
			const out: MockEl[] = [];
			const visit = (node: MockEl): void => {
				if (predicate(node)) out.push(node);
				for (const c of node.children) visit(c);
			};
			visit(this);
			return out;
		}

		findOne(predicate: (el: MockEl) => boolean): MockEl | undefined {
			return this.findAll(predicate)[0];
		}

		fullText(): string {
			return this.textContent + this.children.map((c) => c.fullText()).join("");
		}
	}

	return { notices, mockRequestUrl, mockPlatform, MockEl };
});

type MockEl = InstanceType<typeof MockEl>;

vi.mock("obsidian", () => {
	class Modal {
		app: unknown;
		contentEl = new MockEl("div");
		modalEl = new MockEl("div");
		titleEl = new MockEl("div");
		constructor(app: unknown) {
			this.app = app;
		}
		onOpen(): void {}
		onClose(): void {}
		open(): void {
			this.onOpen();
		}
		close(): void {
			this.onClose();
		}
	}
	class Notice {
		constructor(message: string) {
			notices.push(message);
		}
	}
	return {
		App: class {},
		Modal,
		Notice,
		Platform: mockPlatform,
		requestUrl: mockRequestUrl,
	};
});

import {
	GeminiAssistantModal,
	buildWebHandoffPrompt,
	copyWebHandoffToClipboard,
	type AssistantHost,
	type GeminiModel,
} from "../src/aiAssistant";

class FakeClipboardItem {
	constructor(public readonly data: Record<string, Blob | Promise<Blob>>) {}
}

describe("aiAssistant", () => {
	beforeEach(() => {
		notices.length = 0;
		mockRequestUrl.mockReset();
		mockPlatform.isDesktopApp = false;
		mockPlatform.isMobile = true;
		mockPlatform.isIosApp = true;
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("formats question and note context cleanly for Google AI Pro web handoff", () => {
		const text = buildWebHandoffPrompt("Erkläre Satz 2", "Analysis", "Satz 2: Jede stetige Funktion...");
		expect(text).toContain("Erkläre Satz 2");
		expect(text).toContain("Notiz-Kontext (Analysis):");
		expect(text).toContain("Satz 2: Jede stetige Funktion...");
	});

	it("omits context section when note is blank", () => {
		expect(buildWebHandoffPrompt("Hallo", "Leer", "   ")).toBe("Hallo");
	});

	it("preserves rendered chat thread and draft input when saving an API key", async () => {
		let apiKey = "AIza-initial";
		let model: GeminiModel = "gemini-4-hydrogen";
		const host: AssistantHost = {
			getApiKey: () => apiKey,
			setApiKey: (k) => {
				apiKey = k;
			},
			getModel: () => model,
			setModel: (m) => {
				model = m;
			},
		};
		mockRequestUrl.mockResolvedValue({
			status: 200,
			json: { candidates: [{ content: { parts: [{ text: "42 ist korrekt." }] } }] },
		});

		const modal = new GeminiAssistantModal({} as never, host, { noteTitle: "Test", noteContext: "x = 42" });
		modal.open();

		const root = modal.contentEl as unknown as MockEl;
		const input = root.findOne((el) => el.classList.has("pl-ai-input"))!;
		const sendBtn = root.findOne((el) => el.classList.has("pl-ai-send"))!;
		input.value = "Stimmt x = 42?";
		sendBtn.click();
		await new Promise((r) => setTimeout(r, 0));

		const threadBefore = root.findOne((el) => el.classList.has("pl-ai-thread"))!;
		expect(threadBefore.findAll((el) => el.classList.has("pl-ai-msg"))).toHaveLength(2);

		// User types a follow-up draft, then updates the API key and clicks Speichern
		input.value = "Und warum?";
		const keyInput = root.findOne((el) => el.classList.has("pl-ai-key-input"))!;
		const saveBtn = root.findAll((el) => el.tagName === "button").find((el) => el.textContent === "Speichern")!;
		keyInput.value = "AIza-updated";
		saveBtn.click();

		expect(apiKey).toBe("AIza-updated");
		const threadAfter = root.findOne((el) => el.classList.has("pl-ai-thread"))!;
		const bubbles = threadAfter.findAll((el) => el.classList.has("pl-ai-msg"));
		expect(bubbles).toHaveLength(2);
		expect(bubbles[0]?.fullText()).toContain("Stimmt x = 42?");
		expect(bubbles[1]?.fullText()).toContain("42 ist korrekt.");
		expect(root.findOne((el) => el.classList.has("pl-ai-input"))?.value).toBe("Und warum?");
	});

	it("toggles Direkt senden button and summary cleanly when adding or clearing an API key", () => {
		let apiKey = "";
		let model: GeminiModel = "gemini-4-hydrogen";
		const host: AssistantHost = {
			getApiKey: () => apiKey,
			setApiKey: (k) => {
				apiKey = k;
			},
			getModel: () => model,
			setModel: (m) => {
				model = m;
			},
		};

		const modal = new GeminiAssistantModal({} as never, host, {});
		modal.open();
		const root = modal.contentEl as unknown as MockEl;

		expect(root.findOne((el) => el.classList.has("pl-ai-send"))).toBeUndefined();
		const summary = root.findOne((el) => el.tagName === "summary")!;
		expect(summary.textContent).toContain("Optional");

		const input = root.findOne((el) => el.classList.has("pl-ai-input"))!;
		input.value = "Meine Frage";
		const keyInput = root.findOne((el) => el.classList.has("pl-ai-key-input"))!;
		const saveBtn = root.findAll((el) => el.tagName === "button").find((el) => el.textContent === "Speichern")!;

		keyInput.value = "AIza-new";
		saveBtn.click();
		expect(root.findOne((el) => el.classList.has("pl-ai-send"))).toBeDefined();
		expect(summary.textContent).toContain("Direkt-Modus aktiv");
		expect(input.value).toBe("Meine Frage");

		// Clearing the API key removes the send button while preserving input and thread
		keyInput.value = "   ";
		saveBtn.click();
		expect(apiKey).toBe("");
		expect(root.findOne((el) => el.classList.has("pl-ai-send"))).toBeUndefined();
		expect(summary.textContent).toContain("Optional");
		expect(input.value).toBe("Meine Frage");
	});

	it("copies both text prompt and attached handwriting image on Google AI Pro text handoff", async () => {
		const write = vi.fn().mockResolvedValue(undefined);
		const writeText = vi.fn().mockResolvedValue(undefined);
		const winOpen = vi.fn();
		vi.stubGlobal("ClipboardItem", FakeClipboardItem);
		vi.stubGlobal("navigator", { clipboard: { write, writeText } });
		vi.stubGlobal("window", { open: winOpen });

		const host: AssistantHost = {
			getApiKey: () => "",
			setApiKey: () => {},
			getModel: () => "gemini-4-hydrogen",
			setModel: () => {},
		};
		// 1x1 transparent PNG base64
		const pngBase64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
		const modal = new GeminiAssistantModal({} as never, host, {
			noteTitle: "Mathe",
			noteContext: "Aufgabe 1: Berechne f'(x)",
			imageBase64Png: pngBase64,
			initialPrompt: "Prüfe meine Ableitung",
		});
		modal.open();

		const root = modal.contentEl as unknown as MockEl;
		const actions = root.findOne((el) => el.classList.has("pl-ai-account-actions"))!;
		const textProBtn = actions.children[1];
		expect(textProBtn.textContent).toContain("Bild");
		textProBtn.click();
		await new Promise((r) => setTimeout(r, 0));

		expect(write).toHaveBeenCalledTimes(1);
		const items = write.mock.calls[0]?.[0] as FakeClipboardItem[];
		expect(items).toHaveLength(1);
		expect(items[0]?.data["image/png"]).toBeInstanceOf(Blob);
		expect(items[0]?.data["text/plain"]).toBeInstanceOf(Blob);
		const copiedText = await (items[0]?.data["text/plain"] as Blob).text();
		expect(copiedText).toContain("Prüfe meine Ableitung");
		expect(copiedText).toContain("Aufgabe 1: Berechne f'(x)");
		expect(winOpen).toHaveBeenCalledTimes(1);
	});

	it("falls back to text-only clipboard write if multi-type ClipboardItem fails", async () => {
		const write = vi.fn().mockRejectedValue(new Error("multi-type unsupported"));
		const writeText = vi.fn().mockResolvedValue(undefined);
		vi.stubGlobal("ClipboardItem", FakeClipboardItem);
		vi.stubGlobal("navigator", { clipboard: { write, writeText } });

		const pngBase64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
		const result = await copyWebHandoffToClipboard("Prüfe diese Formel", pngBase64);
		expect(result).toBe("text");
		expect(writeText).toHaveBeenCalledWith("Prüfe diese Formel");
	});

	it("uses writeText for text-only handoff without attached image", async () => {
		const write = vi.fn().mockResolvedValue(undefined);
		const writeText = vi.fn().mockResolvedValue(undefined);
		vi.stubGlobal("ClipboardItem", FakeClipboardItem);
		vi.stubGlobal("navigator", { clipboard: { write, writeText } });

		const result = await copyWebHandoffToClipboard("Erkläre Satz 2");
		expect(result).toBe("text");
		expect(writeText).toHaveBeenCalledWith("Erkläre Satz 2");
		expect(write).not.toHaveBeenCalled();
	});
});
