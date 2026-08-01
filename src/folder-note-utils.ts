import type { FolderNoteLocation, FolderNoteSettings } from "./types";

export const FOLDER_NAME_PLACEHOLDER = "{{folder_name}}";

export interface FolderNoteFolder {
	path: string;
	name: string;
	parentPath: string | null;
	isRoot: boolean;
}

export function buildFolderNotePath(folder: FolderNoteFolder, settings: FolderNoteSettings, extension: string): string | null {
	if (!settings.folderNotesEnabled || folder.isRoot || !isValidFolderNoteTemplate(settings.folderNoteName, settings.folderNoteLocation)) return null;
	const normalizedExtension = cleanExtension(extension);
	const supported = normalizeFolderNoteExtensions(settings.folderNoteExtensions);
	if (!normalizedExtension || !supported.includes(normalizedExtension)) return null;
	const name = settings.folderNoteName.split(FOLDER_NAME_PLACEHOLDER).join(folder.name);
	if (settings.folderNoteLocation === "parent") {
		return folder.parentPath ? `${folder.parentPath}/${name}.${normalizedExtension}` : `${name}.${normalizedExtension}`;
	}
	return `${folder.path}/${name}.${normalizedExtension}`;
}

function folderDetailsFromPath(path: string): FolderNoteFolder {
	const separator = path.lastIndexOf("/");
	return {
		path,
		name: separator < 0 ? path : path.slice(separator + 1),
		parentPath: separator < 0 ? "" : path.slice(0, separator),
		isRoot: path.length === 0,
	};
}

export function folderNoteMutationPaths(
	sourceFolderPath: string,
	targetFolderPath: string,
	settings: FolderNoteSettings,
	extension: string,
): { targetNotePath: string; sourceCollisionPath: string | null } | null {
	const targetNotePath = buildFolderNotePath(folderDetailsFromPath(targetFolderPath), settings, extension);
	if (!targetNotePath) return null;
	const name = targetNotePath.slice(targetNotePath.lastIndexOf("/") + 1);
	return {
		targetNotePath,
		sourceCollisionPath: settings.folderNoteLocation === "inside" ? `${sourceFolderPath}/${name}` : null,
	};
}

export function normalizeFolderNoteExtensions(values: readonly string[]): string[] {
	const normalized: string[] = [];
	for (const value of values) {
		const extension = cleanExtension(value);
		if (extension && !normalized.includes(extension)) normalized.push(extension);
		if (normalized.length === 16) break;
	}
	return normalized;
}

export function isSafeFolderNoteTemplate(template: string): boolean {
	return template.length > 0 && template.length <= 200 && !template.includes("/") && !template.includes("\\");
}

export function isValidFolderNoteTemplate(template: string, location: FolderNoteLocation): boolean {
	return isSafeFolderNoteTemplate(template) && (location === "inside" || template.includes(FOLDER_NAME_PLACEHOLDER));
}

function cleanExtension(value: string): string | null {
	const extension = value.trim().replace(/^\./, "").toLowerCase();
	return /^[a-z0-9][a-z0-9._-]{0,31}$/.test(extension) ? extension : null;
}
