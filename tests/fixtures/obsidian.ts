// Obsidian supplies these at runtime. Its npm package ships only type declarations.
export const Platform = { isIosApp: true };
export const editorInfoField = undefined;
export class Modal {}
export class Notice {
	constructor(_message: string, _timeout?: number) {}
}
export function setIcon(): void {}
export function setTooltip(): void {}
export async function loadMathJax(): Promise<void> {}
export function renderMath(source: string, _display: boolean): HTMLElement {
	const doc = (globalThis as unknown as { activeDocument?: { createElement?(tag: string): HTMLElement } }).activeDocument;
	const el = doc?.createElement?.("span");
	if (el) el.textContent = source;
	return el ?? ({ textContent: source } as unknown as HTMLElement);
}
export async function finishRenderMath(): Promise<void> {}
