import assert from "node:assert/strict";
import test from "node:test";
import {
	executableSearchCandidates,
	isTerminalAvailableOnPlatform,
	isTerminalProfile,
	terminalLaunchSpecs,
	terminalOptions,
} from "../src/terminal-launch";

test("terminal choices are platform-specific", () => {
	assert.equal(isTerminalAvailableOnPlatform("ghostty", "darwin"), true);
	assert.equal(isTerminalAvailableOnPlatform("windows-terminal", "darwin"), false);
	assert.equal(isTerminalAvailableOnPlatform("windows-terminal", "win32"), true);
	assert.equal(isTerminalAvailableOnPlatform("gnome-terminal", "linux"), true);
	assert.equal(terminalOptions("darwin")[0]?.value, "auto");
});

test("terminal profile validation rejects arbitrary persisted values", () => {
	assert.equal(isTerminalProfile("ghostty"), true);
	assert.equal(isTerminalProfile("rm -rf"), false);
	assert.equal(isTerminalProfile(null), false);
});

test("Ghostty receives the current directory without shell interpolation", () => {
	const directory = "/Users/test/Vault/a folder; echo unsafe";
	const [spec] = terminalLaunchSpecs("ghostty", "darwin", directory, "", "/Users/test");
	assert.deepEqual(spec, {
		executable: "/Applications/Ghostty.app/Contents/MacOS/ghostty",
		args: [`--working-directory=${directory}`],
	});
});

test("Windows Terminal and Linux terminals receive explicit working directories", () => {
	const windows = terminalLaunchSpecs("windows-terminal", "win32", "C:\\Vault Folder");
	assert.deepEqual(windows, [{
		executable: "wt.exe",
		args: ["-d", "C:\\Vault Folder"],
		cwd: "C:\\Vault Folder",
	}]);
	const linux = terminalLaunchSpecs("konsole", "linux", "/home/test/Vault Folder");
	assert.deepEqual(linux, [{
		executable: "konsole",
		args: ["--workdir", "/home/test/Vault Folder"],
		cwd: "/home/test/Vault Folder",
	}]);
});

test("executable lookup never searches the current vault folder", () => {
	assert.deepEqual(
		executableSearchCandidates("wt.exe", "win32", ".;relative;\\Vault;C:\\Windows\\System32"),
		["C:\\Windows\\System32\\wt.exe"],
	);
	assert.throws(
		() => executableSearchCandidates(".\\terminal.exe", "win32", "C:\\Windows\\System32"),
		/paths must be fully qualified/,
	);
});

test("custom terminals require an executable and inherit the current directory", () => {
	assert.throws(() => terminalLaunchSpecs("custom", "linux", "/vault"), /custom terminal executable/);
	assert.deepEqual(terminalLaunchSpecs("custom", "linux", "/vault", "  my-terminal  "), [{
		executable: "my-terminal",
		args: [],
		cwd: "/vault",
	}]);
});
