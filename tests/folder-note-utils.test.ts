import assert from "node:assert/strict";
import test from "node:test";
import {
	buildFolderNotePath,
	folderNoteMutationPaths,
	isSafeFolderNoteTemplate,
	isValidFolderNoteTemplate,
	normalizeFolderNoteExtensions,
} from "../src/folder-note-utils.ts";
import type { FolderNoteSettings } from "../src/types.ts";

const settings: FolderNoteSettings = {
	folderNotesEnabled: true,
	folderNoteLocation: "inside",
	folderNoteName: "{{folder_name}}",
	folderNoteExtensions: ["base", "md"],
};

const folder = { path: "Projects/Traverse", name: "Traverse", parentPath: "Projects", isRoot: false };

test("folder note paths respect location, template, and configured extension", () => {
	assert.equal(buildFolderNotePath(folder, settings, "base"), "Projects/Traverse/Traverse.base");
	assert.equal(buildFolderNotePath(folder, { ...settings, folderNoteLocation: "parent", folderNoteName: "About {{folder_name}}" }, ".MD"), "Projects/About Traverse.md");
	assert.equal(buildFolderNotePath(folder, settings, "canvas"), null);
});

test("folder note creation rejects disabled, root, and unsafe configurations", () => {
	assert.equal(buildFolderNotePath(folder, { ...settings, folderNotesEnabled: false }, "md"), null);
	assert.equal(buildFolderNotePath({ ...folder, isRoot: true }, settings, "md"), null);
	assert.equal(buildFolderNotePath(folder, { ...settings, folderNoteName: "../{{folder_name}}" }, "md"), null);
	assert.equal(isSafeFolderNoteTemplate("Overview {{folder_name}}"), true);
});

test("beside-folder notes require a folder-specific name", () => {
	assert.equal(isValidFolderNoteTemplate("Index", "inside"), true);
	assert.equal(isValidFolderNoteTemplate("Index", "parent"), false);
	assert.equal(isValidFolderNoteTemplate("About {{folder_name}}", "parent"), true);
	assert.equal(buildFolderNotePath(folder, { ...settings, folderNoteLocation: "parent", folderNoteName: "Index" }, "md"), null);
});

test("folder-note mutation paths preserve inside and beside-folder relationships", () => {
	assert.deepEqual(folderNoteMutationPaths("Projects/Old", "Projects/New", settings, "md"), {
		targetNotePath: "Projects/New/New.md",
		sourceCollisionPath: "Projects/Old/New.md",
	});
	assert.deepEqual(folderNoteMutationPaths("Archive/Old", "Projects/Old 2", {
		...settings,
		folderNoteLocation: "parent",
	}, "md"), {
		targetNotePath: "Projects/Old 2.md",
		sourceCollisionPath: null,
	});
});

test("folder note extensions are normalized, deduplicated, and validated", () => {
	assert.deepEqual(normalizeFolderNoteExtensions([" .MD ", "base", "md", "bad/path", ""]), ["md", "base"]);
});
