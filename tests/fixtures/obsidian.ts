// Obsidian supplies these at runtime. Its npm package ships only type declarations.
export const Platform = { isIosApp: true };
export const editorInfoField = undefined;
export class Modal {}
export class TFile {
	constructor(public path = "") {}
}
export class TFolder {
	constructor(public path = "") {}
}
export function normalizePath(path: string): string {
	return path.replace(/\\/g, "/").replace(/\/+/g, "/").replace(/\/$/, "");
}
