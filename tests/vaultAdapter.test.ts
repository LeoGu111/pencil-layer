import { describe, expect, it, vi } from "vitest";
import { TFile, type FileManager, type Vault } from "obsidian";
import { VaultInkAdapter } from "../src/vaultAdapter";

describe("VaultInkAdapter", () => {
	it("uses FileManager.trashFile when removing an indexed sidecar", async () => {
		const file = Object.assign(new TFile(), { path: "Attachments/Ink/Note.md.json" });
		const trashFile = vi.fn().mockResolvedValue(undefined);
		const rawRemove = vi.fn().mockResolvedValue(undefined);
		const vault = {
			getAbstractFileByPath: vi.fn((p: string) => (p === file.path ? file : null)),
			adapter: { exists: vi.fn().mockResolvedValue(false), remove: rawRemove },
		} as unknown as Vault;
		const fileManager = { trashFile } as unknown as FileManager;

		const adapter = new VaultInkAdapter(vault, fileManager);
		await adapter.remove(file.path);

		expect(trashFile).toHaveBeenCalledTimes(1);
		expect(trashFile).toHaveBeenCalledWith(file);
		expect(rawRemove).not.toHaveBeenCalled();
	});

	it("falls back to raw adapter remove when file is not indexed", async () => {
		const trashFile = vi.fn().mockResolvedValue(undefined);
		const rawRemove = vi.fn().mockResolvedValue(undefined);
		const vault = {
			getAbstractFileByPath: vi.fn().mockReturnValue(null),
			adapter: { exists: vi.fn().mockResolvedValue(true), remove: rawRemove },
		} as unknown as Vault;
		const fileManager = { trashFile } as unknown as FileManager;

		const adapter = new VaultInkAdapter(vault, fileManager);
		await adapter.remove("Attachments/Ink/Unindexed.md.json");

		expect(trashFile).not.toHaveBeenCalled();
		expect(rawRemove).toHaveBeenCalledWith("Attachments/Ink/Unindexed.md.json");
	});
});
