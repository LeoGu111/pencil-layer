import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		include: ["tests/**/*.test.ts"],
		environment: "node",
		alias: { obsidian: fileURLToPath(new URL("./tests/fixtures/obsidian.ts", import.meta.url)) },
	},
});
