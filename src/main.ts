import { shell } from "electron";
import { FileSystemAdapter, MarkdownView, Notice, Plugin, PluginSettingTab, Setting, TFile, TFolder, WorkspaceLeaf, WorkspaceParent } from "obsidian";
import { TraverseView, VIEW_TYPE_TRAVERSE } from "./explorer-view";
import { FOLDER_NAME_PLACEHOLDER, getFolderNoteOwner, isValidFolderNoteTemplate, normalizeFolderNoteExtensions } from "./folder-notes";
import {
	PREVIEW_ASPECT_DEFAULT,
	PREVIEW_ASPECT_MAX,
	PREVIEW_ASPECT_MIN,
	PREVIEW_SIZE_DEFAULT,
	PREVIEW_SIZE_MAX,
	PREVIEW_SIZE_MIN,
} from "./preview-layout";
import { currentDesktopPlatform, isTerminalAvailableOnPlatform, isTerminalProfile, launchTerminal, terminalOptions } from "./terminal-launch";
import type { FolderNoteLocation, FolderNoteSettings, PaneFont, TraverseSettings } from "./types";

const DEFAULT_SETTINGS: TraverseSettings = {
	openInNewTabs: false,
	openInEmptyWorkspace: false,
	showPreviewByDefault: false,
	autoHidePreview: true,
	previewGroupThreshold: 2,
	previewCardSize: PREVIEW_SIZE_DEFAULT,
	previewCardAspectRatio: PREVIEW_ASPECT_DEFAULT,
	paneFont: "monospace",
	hideMarkdownExtensions: false,
	preferredTerminal: "auto",
	customTerminalExecutable: "",
	folderNotesEnabled: true,
	folderNoteLocation: "inside",
	folderNoteName: FOLDER_NAME_PLACEHOLDER,
	folderNoteExtensions: ["base", "md"],
};

export default class TraversePlugin extends Plugin {
	settings: TraverseSettings = DEFAULT_SETTINGS;
	private mutationTail: Promise<void> = Promise.resolve();
	private operational = false;
	private layoutFrame: number | null = null;
	private lastActivatedFile: TFile | null = null;
	private pendingEmptyLeaves = new WeakSet<WorkspaceLeaf>();

	async onload(): Promise<void> {
		await this.loadSettings();
		this.operational = true;
		this.lastActivatedFile = this.app.workspace.getActiveFile();
		this.registerView(VIEW_TYPE_TRAVERSE, (leaf) => new TraverseView(leaf, this));
		this.addCommand({
			id: "open-current-pane",
			name: "Open in current pane",
			callback: () => { void this.openExplorer().catch((error) => this.report(error)); },
		});
		this.addRibbonIcon("folder-tree", "Open Traverse", () => { void this.openExplorer().catch((error) => this.report(error)); });
		this.addSettingTab(new TraverseSettingTab(this));
		this.registerEvent(this.app.workspace.on("file-open", (file) => {
			if (file) this.lastActivatedFile = file;
		}));
		this.registerEvent(this.app.workspace.on("active-leaf-change", (leaf) => this.scheduleNewTabActivation(leaf)));
		this.registerEvent(this.app.workspace.on("layout-change", () => this.scheduleViewUpdate()));
		this.registerEvent(this.app.workspace.on("resize", () => this.scheduleViewUpdate()));
	}

	onunload(): void {
		this.operational = false;
		if (this.layoutFrame !== null) window.cancelAnimationFrame(this.layoutFrame);
		this.layoutFrame = null;
	}

	previewVisible(explorerLeaf: WorkspaceLeaf, requested: boolean): boolean {
		if (!requested) return false;
		if (!this.settings.autoHidePreview) return true;
		const explorerRoot = getRoot(explorerLeaf);
		const groups = new Set<WorkspaceLeaf["parent"]>();
		this.app.workspace.iterateAllLeaves((leaf) => {
			if (getRoot(leaf) === explorerRoot && !hasAncestor(leaf, this.app.workspace.leftSplit) && !hasAncestor(leaf, this.app.workspace.rightSplit)) groups.add(leaf.parent);
		});
		return groups.size <= this.settings.previewGroupThreshold;
	}

	previewShownByDefault(): boolean {
		return this.settings.showPreviewByDefault;
	}

	async runMutation<T>(action: () => Promise<T>): Promise<T> {
		if (!this.operational) throw new Error("Traverse is unloading");
		const result = this.mutationTail.then(async () => {
			if (!this.operational) throw new Error("Traverse is unloading");
			return action();
		});
		this.mutationTail = result.then(() => undefined, () => undefined);
		return result;
	}

	folderNoteSettings(): FolderNoteSettings {
		return this.settings;
	}

	paneFont(): PaneFont {
		return this.settings.paneFont;
	}

	hideMarkdownExtensions(): boolean {
		return this.settings.hideMarkdownExtensions;
	}

	previewCardSize(): number {
		return this.settings.previewCardSize;
	}

	previewCardAspectRatio(): number {
		return this.settings.previewCardAspectRatio;
	}

	async openFolderInFileManager(folder: TFolder): Promise<void> {
		const result = await shell.openPath(this.localFolderPath(folder));
		if (result) throw new Error(`Could not open the system file manager: ${result}`);
	}

	async openFolderInTerminal(folder: TFolder): Promise<void> {
		await launchTerminal(
			this.settings.preferredTerminal,
			currentDesktopPlatform(),
			this.localFolderPath(folder),
			this.settings.customTerminalExecutable,
		);
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
		for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_TRAVERSE)) {
			if (leaf.view instanceof TraverseView) leaf.view.applySettings();
		}
	}

	private async loadSettings(): Promise<void> {
		const loaded = await this.loadData() as Record<string, unknown> | null;
		const threshold = Number(loaded?.previewGroupThreshold ?? DEFAULT_SETTINGS.previewGroupThreshold);
		const cardSize = Number(loaded?.previewCardSize ?? loaded?.previewScale ?? DEFAULT_SETTINGS.previewCardSize);
		const cardAspectRatio = Number(loaded?.previewCardAspectRatio ?? DEFAULT_SETTINGS.previewCardAspectRatio);
		const legacyLocationDisabled = loaded?.folderNoteLocation === "disabled";
		const location = isFolderNoteLocation(loaded?.folderNoteLocation) ? loaded.folderNoteLocation : DEFAULT_SETTINGS.folderNoteLocation;
		const name = typeof loaded?.folderNoteName === "string" && isValidFolderNoteTemplate(loaded.folderNoteName, location)
			? loaded.folderNoteName
			: DEFAULT_SETTINGS.folderNoteName;
		const extensions = Array.isArray(loaded?.folderNoteExtensions)
			? normalizeFolderNoteExtensions(loaded.folderNoteExtensions.filter((value): value is string => typeof value === "string"))
			: [...DEFAULT_SETTINGS.folderNoteExtensions];
		const paneFont = isPaneFont(loaded?.paneFont) ? loaded.paneFont : DEFAULT_SETTINGS.paneFont;
		const platform = currentDesktopPlatform();
		const preferredTerminal = isTerminalProfile(loaded?.preferredTerminal)
			&& isTerminalAvailableOnPlatform(loaded.preferredTerminal, platform)
			? loaded.preferredTerminal
			: DEFAULT_SETTINGS.preferredTerminal;
		this.settings = {
			openInNewTabs: typeof loaded?.openInNewTabs === "boolean" ? loaded.openInNewTabs : DEFAULT_SETTINGS.openInNewTabs,
			openInEmptyWorkspace: typeof loaded?.openInEmptyWorkspace === "boolean" ? loaded.openInEmptyWorkspace : DEFAULT_SETTINGS.openInEmptyWorkspace,
			showPreviewByDefault: typeof loaded?.showPreviewByDefault === "boolean" ? loaded.showPreviewByDefault : DEFAULT_SETTINGS.showPreviewByDefault,
			autoHidePreview: typeof loaded?.autoHidePreview === "boolean" ? loaded.autoHidePreview : DEFAULT_SETTINGS.autoHidePreview,
			previewGroupThreshold: clamp(threshold, 1, 4, DEFAULT_SETTINGS.previewGroupThreshold),
			previewCardSize: clamp(cardSize, PREVIEW_SIZE_MIN, PREVIEW_SIZE_MAX, DEFAULT_SETTINGS.previewCardSize),
			previewCardAspectRatio: clamp(cardAspectRatio, PREVIEW_ASPECT_MIN, PREVIEW_ASPECT_MAX, DEFAULT_SETTINGS.previewCardAspectRatio),
			paneFont,
			hideMarkdownExtensions: typeof loaded?.hideMarkdownExtensions === "boolean" ? loaded.hideMarkdownExtensions : DEFAULT_SETTINGS.hideMarkdownExtensions,
			preferredTerminal,
			customTerminalExecutable: typeof loaded?.customTerminalExecutable === "string" ? loaded.customTerminalExecutable : DEFAULT_SETTINGS.customTerminalExecutable,
			folderNotesEnabled: typeof loaded?.folderNotesEnabled === "boolean" ? loaded.folderNotesEnabled : !legacyLocationDisabled,
			folderNoteLocation: location,
			folderNoteName: name,
			folderNoteExtensions: extensions,
		};
	}

	private localFolderPath(folder: TFolder): string {
		const adapter = this.app.vault.adapter;
		if (!(adapter instanceof FileSystemAdapter)) throw new Error("This action requires a local filesystem vault");
		return adapter.getFullPath(folder.path);
	}

	private async openExplorer(): Promise<void> {
		const activeExplorer = this.app.workspace.getActiveViewOfType(TraverseView);
		if (activeExplorer) {
			activeExplorer.focusExplorer();
			void this.app.workspace.revealLeaf(activeExplorer.leaf);
			return;
		}
		const activeMarkdown = this.app.workspace.getActiveViewOfType(MarkdownView);
		const leaf = activeMarkdown?.leaf ?? this.app.workspace.getMostRecentLeaf() ?? this.app.workspace.getLeaf(false);
		const activeFile = this.app.workspace.getActiveFile();
		const owner = activeFile ? getFolderNoteOwner(this.app, activeFile, this.settings) : null;
		const folder = owner?.parent ?? activeFile?.parent ?? this.app.vault.getRoot();
		const cursor = owner?.path ?? activeFile?.path;
		await leaf.setViewState({ type: VIEW_TYPE_TRAVERSE, active: true, state: { folder: folder.path, cursor, returnPath: activeFile?.path } });
		void this.app.workspace.revealLeaf(leaf);
	}

	private scheduleNewTabActivation(leaf: WorkspaceLeaf | null): void {
		if (!this.settings.openInNewTabs
			|| !leaf
			|| leaf.view.getViewType() !== "empty"
			|| hasAncestor(leaf, this.app.workspace.leftSplit)
			|| hasAncestor(leaf, this.app.workspace.rightSplit)
			|| this.pendingEmptyLeaves.has(leaf)) return;
		const previousFile = this.lastActivatedFile;
		this.pendingEmptyLeaves.add(leaf);
		leaf.getContainer().win.requestAnimationFrame(() => {
			this.pendingEmptyLeaves.delete(leaf);
			if (!this.operational || !this.settings.openInNewTabs || leaf.view.getViewType() !== "empty") return;
			const emptyWorkspace = this.isSoleMainLeaf(leaf);
			if (emptyWorkspace && !this.settings.openInEmptyWorkspace) return;
			const currentFile = !emptyWorkspace && previousFile && this.app.vault.getAbstractFileByPath(previousFile.path) === previousFile ? previousFile : null;
			const folder = currentFile?.parent ?? this.app.vault.getRoot();
			void leaf.setViewState({ type: VIEW_TYPE_TRAVERSE, active: true, state: { folder: folder.path, cursor: currentFile?.path, returnPath: currentFile?.path } })
				.catch((error) => this.report(error));
		});
	}

	private isSoleMainLeaf(target: WorkspaceLeaf): boolean {
		const root = getRoot(target);
		let count = 0;
		this.app.workspace.iterateAllLeaves((leaf) => {
			if (getRoot(leaf) === root
				&& !hasAncestor(leaf, this.app.workspace.leftSplit)
				&& !hasAncestor(leaf, this.app.workspace.rightSplit)) count++;
		});
		return count === 1;
	}

	private scheduleViewUpdate(): void {
		if (this.layoutFrame !== null) return;
		this.layoutFrame = window.requestAnimationFrame(() => {
			this.layoutFrame = null;
			this.updateViews();
		});
	}

	private updateViews(): void {
		for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_TRAVERSE)) {
			if (leaf.view instanceof TraverseView) leaf.view.updatePreviewVisibility();
		}
	}

	private report(error: unknown): void {
		console.error("Could not open Traverse", error);
		new Notice("Could not open Traverse");
	}
}

function isFolderNoteLocation(value: unknown): value is FolderNoteLocation {
	return value === "inside" || value === "parent";
}

function clamp(value: number, minimum: number, maximum: number, fallback: number): number {
	return Math.max(minimum, Math.min(maximum, Number.isFinite(value) ? value : fallback));
}

function isPaneFont(value: unknown): value is PaneFont {
	return value === "monospace" || value === "interface" || value === "text";
}

function getRoot(leaf: WorkspaceLeaf): WorkspaceParent {
	let current: WorkspaceParent = leaf.parent;
	while ("parent" in current && current.parent) current = current.parent;
	return current;
}

function hasAncestor(leaf: WorkspaceLeaf, ancestor: WorkspaceParent): boolean {
	let current: WorkspaceParent = leaf.parent;
	while (true) {
		if (current === ancestor) return true;
		if (!("parent" in current) || !current.parent) return false;
		current = current.parent;
	}
}

class TraverseSettingTab extends PluginSettingTab {
	constructor(private plugin: TraversePlugin) { super(plugin.app, plugin); }

	display(): void {
		this.renderSettings();
	}

	private renderSettings(): void {
		this.containerEl.empty();
		new Setting(this.containerEl).setName("Tabs").setHeading();
		new Setting(this.containerEl)
			.setName("Open Traverse in new tabs")
			.setDesc("Replace intentionally opened empty tabs with Traverse, starting in the folder of the last active file.")
			.addToggle((toggle) => toggle
				.setValue(this.plugin.settings.openInNewTabs)
				.onChange(async (value) => {
					this.plugin.settings.openInNewTabs = value;
					await this.plugin.saveSettings();
					this.renderSettings();
				}));
		if (this.plugin.settings.openInNewTabs) {
			new Setting(this.containerEl)
				.setName("Open in an empty workspace")
				.setDesc("Show Traverse at the vault root instead of Obsidian’s empty view when no tabs remain.")
				.addToggle((toggle) => toggle
					.setValue(this.plugin.settings.openInEmptyWorkspace)
					.onChange(async (value) => {
						this.plugin.settings.openInEmptyWorkspace = value;
						await this.plugin.saveSettings();
					}));
		}

		new Setting(this.containerEl).setName("Appearance").setHeading();
		new Setting(this.containerEl)
			.setName("Pane font")
			.setDesc("Font used for the file list, path bar, and filter.")
			.addDropdown((dropdown) => dropdown
				.addOption("monospace", "Monospace")
				.addOption("interface", "Interface font")
				.addOption("text", "Text font")
				.setValue(this.plugin.settings.paneFont)
				.onChange(async (value) => {
					if (!isPaneFont(value)) return;
					this.plugin.settings.paneFont = value;
					await this.plugin.saveSettings();
				}));
		new Setting(this.containerEl)
			.setName("Hide Markdown extensions")
			.setDesc("Show Markdown filenames without the .md extension.")
			.addToggle((toggle) => toggle
				.setValue(this.plugin.settings.hideMarkdownExtensions)
				.onChange(async (value) => {
					this.plugin.settings.hideMarkdownExtensions = value;
					await this.plugin.saveSettings();
				}));

		new Setting(this.containerEl).setName("System integration").setHeading();
		new Setting(this.containerEl)
			.setName("Preferred terminal")
			.setDesc("Terminal opened by the T shortcut in Traverse.")
			.addDropdown((dropdown) => {
				for (const option of terminalOptions(currentDesktopPlatform())) dropdown.addOption(option.value, option.label);
				dropdown
					.setValue(this.plugin.settings.preferredTerminal)
					.onChange(async (value) => {
						if (!isTerminalProfile(value)) return;
						this.plugin.settings.preferredTerminal = value;
						await this.plugin.saveSettings();
						this.renderSettings();
					});
			});
		if (this.plugin.settings.preferredTerminal === "custom") {
			new Setting(this.containerEl)
				.setName("Custom terminal executable")
				.setDesc("Full path or executable name. Traverse starts it in the current folder without using a shell.")
				.addText((text) => text
					.setPlaceholder("/path/to/terminal")
					.setValue(this.plugin.settings.customTerminalExecutable)
					.onChange(async (value) => {
						this.plugin.settings.customTerminalExecutable = value.trim();
						await this.plugin.saveSettings();
					}));
		}

		new Setting(this.containerEl).setName("Preview").setHeading();
		new Setting(this.containerEl)
			.setName("Show preview by default")
			.setDesc("Show the preview automatically when a pane opens. Otherwise, use the preview shortcut to show it manually.")
			.addToggle((toggle) => toggle
				.setValue(this.plugin.settings.showPreviewByDefault)
				.onChange(async (value) => {
					this.plugin.settings.showPreviewByDefault = value;
					await this.plugin.saveSettings();
					this.renderSettings();
				}));
		new Setting(this.containerEl)
			.setName("Preview size")
			.setDesc("Overall size of the preview card within its half of the pane.")
			.addSlider((slider) => slider
				.setLimits(PREVIEW_SIZE_MIN, PREVIEW_SIZE_MAX, 1)
				.setValue(this.plugin.settings.previewCardSize)
				// Keep numeric feedback on the minimum supported Obsidian version.
				// eslint-disable-next-line @typescript-eslint/no-deprecated
				.setDynamicTooltip()
				.onChange(async (value) => {
					this.plugin.settings.previewCardSize = value;
					await this.plugin.saveSettings();
				}));
		new Setting(this.containerEl)
			.setName("Preview width / height")
			.setDesc("Width as a percentage of height. 80% is portrait, 100% is square, and higher values are landscape.")
			.addSlider((slider) => slider
				.setLimits(PREVIEW_ASPECT_MIN * 100, PREVIEW_ASPECT_MAX * 100, 5)
				.setValue(Math.round(this.plugin.settings.previewCardAspectRatio * 100))
				// Keep numeric feedback on the minimum supported Obsidian version.
				// eslint-disable-next-line @typescript-eslint/no-deprecated
				.setDynamicTooltip()
				.onChange(async (value) => {
					this.plugin.settings.previewCardAspectRatio = value / 100;
					await this.plugin.saveSettings();
				}));
		new Setting(this.containerEl)
			.setName("Auto-hide preview")
			.setDesc("Hide previews when the main workspace becomes crowded.")
			.addToggle((toggle) => toggle
				.setValue(this.plugin.settings.autoHidePreview)
				.onChange(async (value) => {
					this.plugin.settings.autoHidePreview = value;
					await this.plugin.saveSettings();
					this.renderSettings();
				}));
		if (this.plugin.settings.autoHidePreview) {
			new Setting(this.containerEl)
				.setName("Tab-group threshold")
				.setDesc("Automatically hide the preview above this number of visible tab groups.")
				.addSlider((slider) => slider
					.setLimits(1, 4, 1)
					.setValue(this.plugin.settings.previewGroupThreshold)
					// Keep numeric feedback on the minimum supported Obsidian version.
					// eslint-disable-next-line @typescript-eslint/no-deprecated
					.setDynamicTooltip()
					.onChange(async (value) => {
						this.plugin.settings.previewGroupThreshold = value;
						await this.plugin.saveSettings();
					}));
		}

		new Setting(this.containerEl).setName("Folder notes").setHeading();
		new Setting(this.containerEl)
			.setName("Enable folder notes")
			.setDesc("Treat a matching note as the note for its folder.")
			.addToggle((toggle) => toggle
				.setValue(this.plugin.settings.folderNotesEnabled)
				.onChange(async (value) => {
					this.plugin.settings.folderNotesEnabled = value;
					await this.plugin.saveSettings();
					this.renderSettings();
				}));
		if (!this.plugin.settings.folderNotesEnabled) return;
		new Setting(this.containerEl)
			.setName("Folder note location")
			.setDesc("Recognize folder notes stored inside their folder or beside it.")
			.addDropdown((dropdown) => dropdown
				.addOption("inside", "Inside the folder")
				.addOption("parent", "Beside the folder")
				.setValue(this.plugin.settings.folderNoteLocation)
				.onChange(async (value) => {
					if (!isFolderNoteLocation(value)) return;
					this.plugin.settings.folderNoteLocation = value;
					if (!isValidFolderNoteTemplate(this.plugin.settings.folderNoteName, value)) {
						this.plugin.settings.folderNoteName = FOLDER_NAME_PLACEHOLDER;
					}
					await this.plugin.saveSettings();
					this.renderSettings();
				}));
		new Setting(this.containerEl)
			.setName("Folder note name")
			.setDesc("Use {{folder_name}} as a placeholder for the folder name.")
			.addText((text) => text
				.setPlaceholder(FOLDER_NAME_PLACEHOLDER)
				.setValue(this.plugin.settings.folderNoteName)
				.onChange(async (value) => {
					const name = value.trim();
					if (!isValidFolderNoteTemplate(name, this.plugin.settings.folderNoteLocation)) return;
					this.plugin.settings.folderNoteName = name;
					await this.plugin.saveSettings();
				}));
		new Setting(this.containerEl)
			.setName("Folder note extensions")
			.setDesc("Comma-separated file extensions, checked from left to right.")
			.addText((text) => text
				.setPlaceholder(".base, .md")
				.setValue(this.plugin.settings.folderNoteExtensions.join(", "))
				.onChange(async (value) => {
					this.plugin.settings.folderNoteExtensions = normalizeFolderNoteExtensions(value.split(","));
					await this.plugin.saveSettings();
				}));
	}
}
