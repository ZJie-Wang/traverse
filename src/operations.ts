import { App, normalizePath, TAbstractFile, TFile, TFolder } from "obsidian";
import { buildFolderNotePath, folderNoteMutationPaths } from "./folder-note-utils";
import { createFolderNoteResolver, folderDetails } from "./folder-notes";
import type { ClipboardMode, FolderNoteSettings } from "./types";

export interface PasteFailure {
	path: string;
	name: string;
	message: string;
}

export interface PasteResult {
	completed: number;
	failures: PasteFailure[];
}

interface FolderNotePlan {
	source: TFile;
	sourcePath: string;
	targetPath: string;
	sourceCollisionPath: string | null;
	location: "inside" | "parent";
}

interface PastePlan {
	source: TAbstractFile;
	sourcePath: string;
	target: string;
	folderNote: FolderNotePlan | null;
}

let nextCopyStageId = 0;

export class ExplorerOperations {
	constructor(private app: App) {}

	async create(parent: TFolder, input: string, folder: boolean): Promise<TAbstractFile> {
		const trimmed = input.trim();
		if (!isSafeName(trimmed) || trimmed === this.app.vault.configDir) throw new Error("Enter one valid, visible name");
		const name = folder || trimmed.includes(".") ? trimmed : `${trimmed}.md`;
		const path = normalizePath(parent.path ? `${parent.path}/${name}` : name);
		if (isProtectedPath(this.app, parent.path) || isProtectedPath(this.app, path)) throw new Error("Hidden and configuration paths are protected");
		if (this.app.vault.getAbstractFileByPath(path)) throw new Error("That path already exists");
		return folder ? this.app.vault.createFolder(path) : this.app.vault.create(path, "");
	}

	async createFolderNote(folder: TFolder, settings: FolderNoteSettings, extension: string): Promise<TFile> {
		const path = buildFolderNotePath(folderDetails(folder), settings, extension);
		if (!path) throw new Error("That folder note extension is not supported");
		if (isProtectedPath(this.app, folder.path) || isProtectedPath(this.app, path)) throw new Error("Hidden and configuration paths are protected");
		if (this.app.vault.getAbstractFileByPath(path)) throw new Error("That folder note already exists");
		return this.app.vault.create(path, "");
	}

	async rename(file: TAbstractFile, name: string, settings: FolderNoteSettings): Promise<void> {
		if (!isSafeName(name) || name === this.app.vault.configDir) throw new Error("Enter one valid, visible name");
		const parentPath = file.parent?.path ?? "";
		const path = normalizePath(parentPath ? `${parentPath}/${name}` : name);
		if (isProtectedPath(this.app, file.path) || isProtectedPath(this.app, path)) throw new Error("Hidden and configuration paths are protected");
		if (this.app.vault.getAbstractFileByPath(path)) throw new Error("That name already exists");
		if (!(file instanceof TFolder)) {
			await this.app.fileManager.renameFile(file, path);
			return;
		}
		const resolveFolderNote = createFolderNoteResolver(this.app, settings);
		const folderNote = this.folderNotePlan(file, path, settings, resolveFolderNote);
		if (folderNote && !this.folderNoteTargetAvailable(folderNote)) throw new Error("The renamed folder note would conflict with an existing file");
		await this.moveFolder(file, path, folderNote);
	}

	async paste(
		mode: ClipboardMode,
		inputSources: readonly TAbstractFile[],
		destination: TFolder,
		settings: FolderNoteSettings,
	): Promise<PasteResult> {
		if (isProtectedPath(this.app, destination.path)) throw new Error("Hidden and configuration paths are protected");
		const resolveFolderNote = createFolderNoteResolver(this.app, settings);
		const logicalSources = withoutNestedChildren(inputSources);
		const includedFolderNotes = new Set(logicalSources
			.filter((source): source is TFolder => source instanceof TFolder)
			.map((folder) => resolveFolderNote(folder)?.path)
			.filter((path): path is string => path !== undefined));
		const sources = logicalSources.filter((source) => source instanceof TFolder || !includedFolderNotes.has(source.path));
		for (const source of sources) {
			if (isProtectedPath(this.app, source.path)) throw new Error("Protected hidden or configuration items cannot be pasted");
			if (source instanceof TFolder && isWithin(destination.path, source.path)) throw new Error("A folder cannot be moved or copied into itself");
		}
		const reserved = new Set<string>();
		const plans = sources
			.filter((source) => mode !== "cut" || source.parent?.path !== destination.path)
			.map((source) => this.availablePlan(destination, source, settings, resolveFolderNote, reserved));
		const failures: PasteFailure[] = [];
		let completed = 0;
		for (const plan of plans) {
			try {
				this.assertCurrent(plan);
				this.assertTargetsAvailable(plan);
				if (mode === "cut") await this.movePlan(plan);
				else await this.copyPlan(plan);
				completed++;
			} catch (error) {
				failures.push({
					path: mode === "cut" ? plan.source.path : plan.sourcePath,
					name: plan.source.name,
					message: errorMessage(error),
				});
			}
		}
		return { completed, failures };
	}

	private availablePlan(
		parent: TFolder,
		source: TAbstractFile,
		settings: FolderNoteSettings,
		resolveFolderNote: ReturnType<typeof createFolderNoteResolver>,
		reserved: Set<string>,
	): PastePlan {
		const extension = source instanceof TFile && source.extension ? `.${source.extension}` : "";
		const stem = source instanceof TFile ? source.basename : source.name;
		let counter = 1;
		while (true) {
			const name = counter === 1 ? source.name : `${stem} ${counter}${extension}`;
			const target = normalizePath(parent.path ? `${parent.path}/${name}` : name);
			const folderNote = source instanceof TFolder ? this.folderNotePlan(source, target, settings, resolveFolderNote) : null;
			if (!this.app.vault.getAbstractFileByPath(target)
				&& !reserved.has(target)
				&& (!folderNote || this.folderNoteTargetAvailable(folderNote, reserved))) {
				reserved.add(target);
				if (folderNote) reserved.add(folderNote.targetPath);
				return { source, sourcePath: source.path, target, folderNote };
			}
			counter++;
		}
	}

	private folderNotePlan(
		folder: TFolder,
		targetFolderPath: string,
		settings: FolderNoteSettings,
		resolveFolderNote: ReturnType<typeof createFolderNoteResolver>,
	): FolderNotePlan | null {
		const note = resolveFolderNote(folder);
		if (!note) return null;
		const paths = folderNoteMutationPaths(folder.path, targetFolderPath, settings, note.extension);
		if (!paths) throw new Error("The folder note settings are not valid");
		if (isProtectedPath(this.app, note.path) || isProtectedPath(this.app, paths.targetNotePath)) {
			throw new Error("Protected hidden or configuration items cannot be moved");
		}
		return {
			source: note,
			sourcePath: note.path,
			targetPath: normalizePath(paths.targetNotePath),
			sourceCollisionPath: paths.sourceCollisionPath ? normalizePath(paths.sourceCollisionPath) : null,
			location: settings.folderNoteLocation,
		};
	}

	private folderNoteTargetAvailable(plan: FolderNotePlan, reserved: ReadonlySet<string> = new Set()): boolean {
		if (reserved.has(plan.targetPath)) return false;
		const target = this.app.vault.getAbstractFileByPath(plan.targetPath);
		if (target && target !== plan.source) return false;
		if (!plan.sourceCollisionPath) return true;
		const sourceCollision = this.app.vault.getAbstractFileByPath(plan.sourceCollisionPath);
		return !sourceCollision || sourceCollision === plan.source;
	}

	private assertCurrent(plan: PastePlan): void {
		if (this.app.vault.getAbstractFileByPath(plan.sourcePath) !== plan.source) throw new Error("Source changed before the operation completed");
		if (plan.folderNote && this.app.vault.getAbstractFileByPath(plan.folderNote.sourcePath) !== plan.folderNote.source) {
			throw new Error("Folder note changed before the operation completed");
		}
	}

	private assertTargetsAvailable(plan: PastePlan): void {
		if (this.app.vault.getAbstractFileByPath(plan.target)) throw new Error("Destination changed before the operation completed");
		if (plan.folderNote && !this.folderNoteTargetAvailable(plan.folderNote)) {
			throw new Error("Folder note destination changed before the operation completed");
		}
	}

	private async movePlan(plan: PastePlan): Promise<void> {
		if (plan.source instanceof TFolder) await this.moveFolder(plan.source, plan.target, plan.folderNote);
		else await this.app.fileManager.renameFile(plan.source, plan.target);
	}

	private async moveFolder(folder: TFolder, target: string, folderNote: FolderNotePlan | null): Promise<void> {
		const sourcePath = folder.path;
		try {
			await this.app.fileManager.renameFile(folder, target);
			if (folderNote && folderNote.source.path !== folderNote.targetPath) {
				await this.app.fileManager.renameFile(folderNote.source, folderNote.targetPath);
			}
		} catch (error) {
			const rollbackErrors: string[] = [];
			await this.rollbackFile(folder, sourcePath, rollbackErrors);
			if (folderNote) await this.rollbackFile(folderNote.source, folderNote.sourcePath, rollbackErrors);
			if (rollbackErrors.length) throw rollbackError(error, rollbackErrors);
			throw error;
		}
	}

	private async copyPlan(plan: PastePlan): Promise<void> {
		if (!(plan.source instanceof TFolder)) {
			await this.app.vault.copy(plan.source, plan.target);
			return;
		}
		let stage: TFolder | null = null;
		let copied: TAbstractFile | null = null;
		let copiedNote: TFile | null = null;
		try {
			stage = await this.createCopyStage(plan.target);
			copied = await this.app.vault.copy(plan.source, normalizePath(`${stage.path}/${plan.source.name}`));
			if (plan.folderNote?.location === "parent") {
				copiedNote = await this.app.vault.copy(plan.folderNote.source, normalizePath(`${stage.path}/${plan.folderNote.source.name}`));
			} else if (plan.folderNote) {
				const relativePath = plan.folderNote.sourcePath.slice(plan.sourcePath.length + 1);
				const found = this.app.vault.getAbstractFileByPath(normalizePath(`${copied.path}/${relativePath}`));
				if (!(found instanceof TFile)) throw new Error("The copied folder note could not be found");
				copiedNote = found;
				const targetName = plan.folderNote.targetPath.slice(plan.folderNote.targetPath.lastIndexOf("/") + 1);
				const stagedTarget = normalizePath(`${copied.path}/${targetName}`);
				if (copiedNote.path !== stagedTarget) await this.app.vault.rename(copiedNote, stagedTarget);
			}

			this.assertTargetsAvailable(plan);
			await this.app.vault.rename(copied, plan.target);
			if (copiedNote && plan.folderNote?.location === "parent") {
				await this.app.vault.rename(copiedNote, plan.folderNote.targetPath);
			}
			const stageCleanupErrors: string[] = [];
			await this.deleteRollbackFile(stage, stageCleanupErrors);
			if (stageCleanupErrors.length) throw new Error(`Copy staging cleanup failed: ${stageCleanupErrors.join("; ")}`);
		} catch (error) {
			const cleanupErrors: string[] = [];
			if (copiedNote) await this.deleteRollbackFile(copiedNote, cleanupErrors);
			if (copied) await this.deleteRollbackFile(copied, cleanupErrors);
			if (stage) await this.deleteRollbackFile(stage, cleanupErrors);
			if (cleanupErrors.length) throw cleanupError(error, cleanupErrors);
			throw error;
		}
	}

	private async createCopyStage(target: string): Promise<TFolder> {
		const separator = target.lastIndexOf("/");
		const parentPath = separator < 0 ? "" : target.slice(0, separator);
		while (true) {
			const id = `${Date.now().toString(36)}-${nextCopyStageId++}`;
			const name = `Traverse copy in progress ${id}`;
			const path = normalizePath(parentPath ? `${parentPath}/${name}` : name);
			try {
				return await this.app.vault.createFolder(path);
			} catch (error) {
				if (!this.app.vault.getAbstractFileByPath(path)) throw error;
			}
		}
	}

	private async rollbackFile(file: TAbstractFile, path: string, failures: string[]): Promise<void> {
		if (file.path === path) return;
		try {
			await this.app.fileManager.renameFile(file, path);
		} catch (error) {
			failures.push(errorMessage(error));
		}
	}

	private async deleteRollbackFile(file: TAbstractFile, failures: string[]): Promise<void> {
		if (this.app.vault.getAbstractFileByPath(file.path) !== file) return;
		try {
			// Rollback only removes partial output that Traverse itself just created, so
			// delete it permanently: routing it through FileManager.trashFile would drop a
			// staging folder in the user's trash on every folder copy.
			if (file instanceof TFolder) await this.app.vault.adapter.rmdir(file.path, true);
			else await this.app.vault.adapter.remove(file.path);
		} catch (error) {
			failures.push(`${file.path}: ${errorMessage(error)}`);
		}
	}
}

export function isProtectedPath(app: App, path: string): boolean {
	const normalized = normalizePath(path);
	if (!normalized) return false;
	const configDir = normalizePath(app.vault.configDir);
	return normalized === configDir
		|| normalized.startsWith(`${configDir}/`)
		|| normalized.split("/").some((segment) => segment.startsWith("."));
}

function isSafeName(name: string): boolean {
	return Boolean(name) && name === name.trim() && !name.startsWith(".") && name !== "." && name !== ".." && !name.includes("/") && !name.includes("\\");
}

function withoutNestedChildren(files: readonly TAbstractFile[]): TAbstractFile[] {
	const folderPaths = new Set(files.filter((file): file is TFolder => file instanceof TFolder).map((folder) => folder.path));
	return files.filter((file) => {
		let parent = file.parent;
		while (parent) {
			if (folderPaths.has(parent.path)) return false;
			parent = parent.parent;
		}
		return true;
	});
}

function isWithin(path: string, folderPath: string): boolean {
	return path === folderPath || path.startsWith(`${folderPath}/`);
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : "Unknown operation error";
}

function rollbackError(error: unknown, failures: readonly string[]): Error {
	return new Error(`${errorMessage(error)} Rollback failed: ${failures.join("; ")}`);
}

function cleanupError(error: unknown, failures: readonly string[]): Error {
	return new Error(`${errorMessage(error)} Incomplete output could not be removed: ${failures.join("; ")}`);
}
