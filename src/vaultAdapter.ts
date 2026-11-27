import { type FileManager, normalizePath, TFile, TFolder, type Vault } from "obsidian";
import type { InkAdapter } from "./store";

/**
 * InkAdapter backed by the Vault API instead of the raw filesystem adapter.
 *
 * Writing through `vault.adapter` bypasses Obsidian's file index. On iOS there is no
 * filesystem watcher, so Obsidian (and therefore Obsidian Sync) only noticed sidecar
 * changes at its next periodic rescan (~90 s, all at once). Going through
 * `vault.create` / `vault.modify` makes every save visible to Sync immediately.
 *
 * Falls back to the raw adapter for paths the vault index doesn't know yet
 * (e.g. a sidecar that just arrived from Sync and hasn't been indexed).
 */
export class VaultInkAdapter implements InkAdapter {
	constructor(
		private readonly vault: Vault,
		private readonly fileManager: FileManager,
	) {}

	private file(path: string): TFile | null {
		const f = this.vault.getAbstractFileByPath(normalizePath(path));
		return f instanceof TFile ? f : null;
	}

	async exists(path: string): Promise<boolean> {
		if (this.file(path)) return true;
		return this.vault.adapter.exists(normalizePath(path));
	}

	async read(path: string): Promise<string> {
		const f = this.file(path);
		// cachedRead may serve stale data right after a Sync write; read fresh.
		return f ? this.vault.read(f) : this.vault.adapter.read(normalizePath(path));
	}

	async write(path: string, data: string): Promise<void> {
		const p = normalizePath(path);
		const f = this.file(p);
		if (f) {
			await this.vault.modify(f, data);
			return;
		}
		if (await this.vault.adapter.exists(p)) {
			// On disk but not indexed yet: write raw, the index will catch up.
			await this.vault.adapter.write(p, data);
			return;
		}
		await this.mkdir(parentOf(p));
		await this.vault.create(p, data);
	}

	async remove(path: string): Promise<void> {
		const p = normalizePath(path);
		const f = this.file(p);
		if (f) await this.fileManager.trashFile(f);
		else if (await this.vault.adapter.exists(p)) await this.vault.adapter.remove(p);
	}

	async mkdir(path: string): Promise<void> {
		await ensureFolder(this.vault, path);
	}
}

/** Create a folder (and its parents) through the Vault API; no-op if it exists. */
export async function ensureFolder(vault: Vault, path: string): Promise<void> {
	const p = normalizePath(path);
	if (!p || p === "/") return;
	if (vault.getAbstractFileByPath(p) instanceof TFolder) return;
	if (await vault.adapter.exists(p)) return;
	await ensureFolder(vault, parentOf(p));
	try {
		await vault.createFolder(p);
	} catch (err) {
		// Raced with another create, or exists on disk but not yet indexed.
		if (!(await vault.adapter.exists(p))) throw err;
	}
}

function parentOf(path: string): string {
	const i = path.lastIndexOf("/");
	return i <= 0 ? "" : path.slice(0, i);
}
