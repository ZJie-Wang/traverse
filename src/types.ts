import type { TAbstractFile, TFile, TFolder } from "obsidian";
import type { TerminalProfile } from "./terminal-launch";

export type FolderNoteLocation = "inside" | "parent";

export type PaneFont = "monospace" | "interface" | "text";

export interface FolderNoteSettings {
	folderNotesEnabled: boolean;
	folderNoteLocation: FolderNoteLocation;
	folderNoteName: string;
	folderNoteExtensions: string[];
}

export interface TraverseSettings extends FolderNoteSettings {
	openInNewTabs: boolean;
	openInEmptyWorkspace: boolean;
	showPreviewByDefault: boolean;
	autoHidePreview: boolean;
	previewGroupThreshold: number;
	previewCardSize: number;
	previewCardAspectRatio: number;
	paneFont: PaneFont;
	hideMarkdownExtensions: boolean;
	preferredTerminal: TerminalProfile;
	customTerminalExecutable: string;
}

export interface ExplorerItem {
	primary: TAbstractFile;
	folder: TFolder | null;
	note: TFile | null;
	label: string;
	detail?: string;
}

export interface ExplorerViewState {
	folder?: string;
	cursor?: string;
	preview?: boolean;
	returnPath?: string;
}

export type ClipboardMode = "copy" | "cut";

export interface ExplorerClipboard {
	mode: ClipboardMode;
	paths: string[];
}
