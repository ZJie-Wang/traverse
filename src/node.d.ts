// Minimal Node.js declarations for the desktop terminal launcher, which only
// runs under Obsidian's desktop Electron shell. Declared locally (like
// electron.d.ts) so type-checking does not depend on @types/node.

declare namespace NodeJS {
	type Platform =
		| "aix" | "android" | "cygwin" | "darwin" | "freebsd" | "haiku"
		| "linux" | "netbsd" | "openbsd" | "sunos" | "win32";
}

declare const process: {
	platform: NodeJS.Platform;
	env: Record<string, string | undefined>;
};

declare module "child_process" {
	export interface ChildProcess {
		once(event: "error", listener: (error: Error) => void): this;
		once(event: "spawn", listener: () => void): this;
		unref(): void;
	}

	export interface SpawnOptions {
		cwd?: string;
		detached?: boolean;
		stdio?: "ignore";
		windowsHide?: boolean;
	}

	export function spawn(command: string, args: string[], options: SpawnOptions): ChildProcess;
	export function execFile(file: string, args: string[], options: { cwd?: string }, callback: (error: Error | null) => void): void;
}

declare module "fs" {
	export const constants: { F_OK: number; X_OK: number };
	export function accessSync(path: string, mode?: number): void;
}

declare module "os" {
	export function homedir(): string;
}

declare module "path" {
	export interface ParsedPath {
		root: string;
	}

	export interface PathModule {
		isAbsolute(path: string): boolean;
		join(...paths: string[]): string;
		extname(path: string): string;
		parse(path: string): ParsedPath;
	}

	export const posix: PathModule;
	export const win32: PathModule;
}
