import tsParser from "@typescript-eslint/parser";
import tseslint from "typescript-eslint";
import obsidianmd from "eslint-plugin-obsidianmd";

export default [
	{ ignores: ["node_modules/**", "main.js", "*.mjs"] },
	...tseslint.configs.recommendedTypeChecked.map((config) => ({
		...config,
		files: ["src/**/*.ts"],
	})),
	...obsidianmd.configs.recommended,
	{
		files: ["src/**/*.ts"],
		languageOptions: {
			parser: tsParser,
			parserOptions: { project: "./tsconfig.json", sourceType: "module" },
		},
		rules: {
			"no-console": ["error", { "allow": ["warn", "error"] }],
			"@typescript-eslint/no-unused-vars": ["error", { "argsIgnorePattern": "^_" }],
			"obsidianmd/ui/sentence-case": ["error", {
				ignoreWords: ["Traverse", "T"],
				enforceCamelCaseLower: true,
			}],
		}
	}
];
