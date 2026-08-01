import { execFile, spawn } from "child_process";
import { accessSync, constants } from "fs";
import { homedir } from "os";
import { posix, win32 } from "path";

export type DesktopPlatform = "darwin" | "win32" | "linux";

export type TerminalProfile =
	| "auto"
	| "terminal"
	| "ghostty"
	| "iterm"
	| "warp"
	| "kitty"
	| "wezterm"
	| "alacritty"
	| "windows-terminal"
	| "powershell"
	| "pwsh"
	| "cmd"
	| "gnome-terminal"
	| "konsole"
	| "xterm"
	| "custom";

export interface TerminalOption {
	value: TerminalProfile;
	label: string;
}

export interface TerminalLaunchSpec {
	executable: string;
	args: string[];
	cwd?: string;
	waitForExit?: boolean;
}

const PROFILES = new Set<TerminalProfile>([
	"auto", "terminal", "ghostty", "iterm", "warp", "kitty", "wezterm", "alacritty",
	"windows-terminal", "powershell", "pwsh", "cmd", "gnome-terminal", "konsole", "xterm", "custom",
]);

const OPTIONS: Record<DesktopPlatform, TerminalOption[]> = {
	darwin: [
		{ value: "auto", label: "Automatic (Terminal)" },
		{ value: "terminal", label: "Terminal" },
		{ value: "ghostty", label: "Ghostty" },
		{ value: "iterm", label: "iTerm2" },
		{ value: "warp", label: "Warp" },
		{ value: "kitty", label: "Kitty" },
		{ value: "wezterm", label: "WezTerm" },
		{ value: "alacritty", label: "Alacritty" },
		{ value: "custom", label: "Custom executable" },
	],
	win32: [
		{ value: "auto", label: "System default terminal" },
		{ value: "windows-terminal", label: "Windows Terminal" },
		{ value: "powershell", label: "Windows PowerShell" },
		{ value: "pwsh", label: "PowerShell 7" },
		{ value: "cmd", label: "Command Prompt" },
		{ value: "wezterm", label: "WezTerm" },
		{ value: "alacritty", label: "Alacritty" },
		{ value: "custom", label: "Custom executable" },
	],
	linux: [
		{ value: "auto", label: "Automatic" },
		{ value: "ghostty", label: "Ghostty" },
		{ value: "gnome-terminal", label: "GNOME Terminal" },
		{ value: "konsole", label: "Konsole" },
		{ value: "kitty", label: "Kitty" },
		{ value: "wezterm", label: "WezTerm" },
		{ value: "alacritty", label: "Alacritty" },
		{ value: "xterm", label: "xterm" },
		{ value: "custom", label: "Custom executable" },
	],
};

export function currentDesktopPlatform(platform: NodeJS.Platform = process.platform): DesktopPlatform {
	if (platform === "darwin" || platform === "win32" || platform === "linux") return platform;
	throw new Error(`Unsupported desktop platform: ${platform}`);
}

export function isTerminalProfile(value: unknown): value is TerminalProfile {
	return typeof value === "string" && PROFILES.has(value as TerminalProfile);
}

export function terminalOptions(platform: DesktopPlatform): readonly TerminalOption[] {
	return OPTIONS[platform];
}

export function isTerminalAvailableOnPlatform(profile: TerminalProfile, platform: DesktopPlatform): boolean {
	return OPTIONS[platform].some((option) => option.value === profile);
}

export function executableSearchCandidates(
	command: string,
	platform: DesktopPlatform,
	searchPath: string,
	pathExt = ".COM;.EXE;.BAT;.CMD",
): string[] {
	const pathApi = platform === "win32" ? win32 : posix;
	if (isFullyQualified(command, platform)) return [command];
	if (command.includes("/") || command.includes("\\")) throw new Error("Custom terminal paths must be fully qualified");
	const extensions = platform === "win32" && !win32.extname(command)
		? pathExt.split(";").filter(Boolean)
		: [""];
	return searchPath
		.split(platform === "win32" ? ";" : ":")
		.filter((entry) => isFullyQualified(entry, platform))
		.flatMap((entry) => extensions.map((extension) => pathApi.join(entry, `${command}${extension.toLowerCase()}`)));
}

function isFullyQualified(path: string, platform: DesktopPlatform): boolean {
	if (platform !== "win32") return posix.isAbsolute(path);
	return win32.isAbsolute(path) && win32.parse(path).root.length > 1;
}

export function terminalLaunchSpecs(
	profile: TerminalProfile,
	platform: DesktopPlatform,
	directory: string,
	customExecutable = "",
	home = homedir(),
): TerminalLaunchSpec[] {
	if (profile === "custom") {
		const executable = customExecutable.trim();
		if (!executable) throw new Error("Set a custom terminal executable in Traverse settings");
		return [{ executable, args: [], cwd: directory }];
	}
	if (profile === "auto") return automaticSpecs(platform, directory, home);
	return profileSpecs(profile, platform, directory, home);
}

export async function launchTerminal(
	profile: TerminalProfile,
	platform: DesktopPlatform,
	directory: string,
	customExecutable = "",
): Promise<void> {
	const specs = terminalLaunchSpecs(profile, platform, directory, customExecutable);
	let lastError: unknown;
	for (const spec of specs) {
		try {
			await launchSpec(spec);
			return;
		} catch (error) {
			lastError = error;
		}
	}
	const detail = lastError instanceof Error ? `: ${lastError.message}` : "";
	throw new Error(`Could not start the selected terminal${detail}`);
}

function automaticSpecs(platform: DesktopPlatform, directory: string, home: string): TerminalLaunchSpec[] {
	switch (platform) {
		case "darwin": return profileSpecs("terminal", platform, directory, home);
		case "win32": return profileSpecs("powershell", platform, directory, home);
		case "linux": return [
			{ executable: "xdg-terminal-exec", args: [], cwd: directory },
			...profileSpecs("gnome-terminal", platform, directory, home),
			...profileSpecs("konsole", platform, directory, home),
			...profileSpecs("ghostty", platform, directory, home),
			...profileSpecs("kitty", platform, directory, home),
			...profileSpecs("wezterm", platform, directory, home),
			...profileSpecs("alacritty", platform, directory, home),
			...profileSpecs("xterm", platform, directory, home),
		];
	}
}

function profileSpecs(profile: TerminalProfile, platform: DesktopPlatform, directory: string, home: string): TerminalLaunchSpec[] {
	if (platform === "darwin") return macSpecs(profile, directory, home);
	if (platform === "win32") return windowsSpecs(profile, directory);
	return linuxSpecs(profile, directory);
}

function macSpecs(profile: TerminalProfile, directory: string, home: string): TerminalLaunchSpec[] {
	const appExecutables = (app: string, executable: string, args: string[]): TerminalLaunchSpec[] => [
		{ executable: `/Applications/${app}.app/Contents/MacOS/${executable}`, args },
		{ executable: `${home}/Applications/${app}.app/Contents/MacOS/${executable}`, args },
	];
	switch (profile) {
		case "terminal": return [{ executable: "/usr/bin/open", args: ["-a", "Terminal", directory], waitForExit: true }];
		case "ghostty": return appExecutables("Ghostty", "ghostty", [`--working-directory=${directory}`]);
		case "iterm": return [{ executable: "/usr/bin/open", args: ["-a", "iTerm", directory], waitForExit: true }];
		case "warp": return [{ executable: "/usr/bin/open", args: [`warp://action/new_window?path=${encodeURIComponent(directory)}`], waitForExit: true }];
		case "kitty": return appExecutables("kitty", "kitty", ["--directory", directory]);
		case "wezterm": return appExecutables("WezTerm", "wezterm-gui", ["start", "--cwd", directory]);
		case "alacritty": return appExecutables("Alacritty", "alacritty", ["--working-directory", directory]);
		default: throw new Error(`${profile} is not available on macOS`);
	}
}

function windowsSpecs(profile: TerminalProfile, directory: string): TerminalLaunchSpec[] {
	switch (profile) {
		case "windows-terminal": return [{ executable: "wt.exe", args: ["-d", directory], cwd: directory }];
		case "powershell": return [{ executable: "powershell.exe", args: ["-NoLogo"], cwd: directory }];
		case "pwsh": return [{ executable: "pwsh.exe", args: ["-NoLogo"], cwd: directory }];
		case "cmd": return [{ executable: "cmd.exe", args: [], cwd: directory }];
		case "wezterm": return [{ executable: "wezterm.exe", args: ["start", "--cwd", directory], cwd: directory }];
		case "alacritty": return [{ executable: "alacritty.exe", args: ["--working-directory", directory], cwd: directory }];
		default: throw new Error(`${profile} is not available on Windows`);
	}
}

function linuxSpecs(profile: TerminalProfile, directory: string): TerminalLaunchSpec[] {
	switch (profile) {
		case "ghostty": return [{ executable: "ghostty", args: [`--working-directory=${directory}`], cwd: directory }];
		case "gnome-terminal": return [{ executable: "gnome-terminal", args: ["--working-directory", directory], cwd: directory }];
		case "konsole": return [{ executable: "konsole", args: ["--workdir", directory], cwd: directory }];
		case "kitty": return [{ executable: "kitty", args: ["--directory", directory], cwd: directory }];
		case "wezterm": return [{ executable: "wezterm", args: ["start", "--cwd", directory], cwd: directory }];
		case "alacritty": return [{ executable: "alacritty", args: ["--working-directory", directory], cwd: directory }];
		case "xterm": return [{ executable: "xterm", args: [], cwd: directory }];
		default: throw new Error(`${profile} is not available on Linux`);
	}
}

function launchSpec(spec: TerminalLaunchSpec): Promise<void> {
	const executable = resolveExecutable(spec.executable);
	if (spec.waitForExit) {
		return new Promise((resolve, reject) => {
			execFile(executable, spec.args, { cwd: spec.cwd }, (error) => error ? reject(new Error(error.message)) : resolve());
		});
	}
	return new Promise((resolve, reject) => {
		const child = spawn(executable, spec.args, {
			cwd: spec.cwd,
			detached: true,
			stdio: "ignore",
			windowsHide: false,
		});
		child.once("error", (error) => reject(error));
		child.once("spawn", () => {
			child.unref();
			resolve();
		});
	});
}

function resolveExecutable(command: string): string {
	const platform = currentDesktopPlatform();
	const pathEntry = platform === "win32"
		? Object.entries(process.env).find(([key]) => key.toLowerCase() === "path")?.[1] ?? ""
		: process.env.PATH ?? "";
	const candidates = executableSearchCandidates(command, platform, pathEntry, process.env.PATHEXT);
	for (const candidate of candidates) {
		try {
			accessSync(candidate, platform === "win32" ? constants.F_OK : constants.X_OK);
			return candidate;
		} catch {
			// Try the next executable candidate.
		}
	}
	throw new Error(`Terminal executable not found: ${command}`);
}
