import { App, TFile, TFolder } from "obsidian";
import { buildFolderNotePath, isValidFolderNoteTemplate, normalizeFolderNoteExtensions } from "./folder-note-utils";
import type { FolderNoteSettings } from "./types";

export { FOLDER_NAME_PLACEHOLDER, isValidFolderNoteTemplate, normalizeFolderNoteExtensions } from "./folder-note-utils";

type FolderNoteResolver = (folder: TFolder) => TFile | null;

const noFolderNote: FolderNoteResolver = () => null;

export function createFolderNoteResolver(app: App, settings: FolderNoteSettings): FolderNoteResolver {
	if (!settings.folderNotesEnabled) return noFolderNote;
	const extensions = normalizeFolderNoteExtensions(settings.folderNoteExtensions);
	if (!extensions.length || !isValidFolderNoteTemplate(settings.folderNoteName, settings.folderNoteLocation)) return noFolderNote;

	return (folder: TFolder): TFile | null => {
		for (const extension of extensions) {
			const path = buildFolderNotePath(folderDetails(folder), settings, extension);
			if (!path) continue;
			const found = app.vault.getAbstractFileByPath(path);
			if (found instanceof TFile) return found;
		}
		return null;
	};
}

export function getFolderNoteOwner(app: App, file: TFile, settings: FolderNoteSettings): TFolder | null {
	const resolveFolderNote = createFolderNoteResolver(app, settings);
	if (file.parent && resolveFolderNote(file.parent)?.path === file.path) return file.parent;
	for (const child of file.parent?.children ?? []) {
		if (child instanceof TFolder && resolveFolderNote(child)?.path === file.path) return child;
	}
	return null;
}

export function folderDetails(folder: TFolder): { path: string; name: string; parentPath: string | null; isRoot: boolean } {
	return { path: folder.path, name: folder.name, parentPath: folder.parent?.path ?? null, isRoot: folder.isRoot() };
}
