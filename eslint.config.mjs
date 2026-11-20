// eslint.config.mjs
import { defineConfig, globalIgnores } from "eslint/config";
import obsidianmd from "eslint-plugin-obsidianmd";

export default defineConfig([
	// Build output, Node build scripts and the local test vault are not plugin code.
	globalIgnores(["node_modules", "dist", "main.js", "esbuild.config.mjs", "version-bump.mjs", "test-vault", "vitest.config.ts"]),
	...obsidianmd.configs.recommended,
	{
		languageOptions: {
			parserOptions: {
				projectService: {
					allowDefaultProject: ["eslint.config.*"],
				},
			},
		},
	},
]);
