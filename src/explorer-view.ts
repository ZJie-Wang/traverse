import { App, ItemView, Notice, TAbstractFile, TFile, TFolder, WorkspaceLeaf, prepareFuzzySearch, setIcon } from "obsidian";
import { createFolderNoteResolver } from "./folder-notes";
import { normalizeFolderNoteExtensions } from "./folder-note-utils";
import { iconFor } from "./icons";
import { confirmAction, promptChoice, promptText } from "./modals";
import { ExplorerOperations, isProtectedPath } from "./operations";
import { isListingMutationPathRelevant, visibleSelectedPaths } from "./path-utils";
import { previewCardDimensions } from "./preview-layout";
import { PreviewRenderer } from "./preview-renderer";
import { canUsePinyin, hasHanText, searchItems } from "./search";
import type { PinyinMatcher } from "./search";
import type { ExplorerClipboard, ExplorerItem, ExplorerViewState, FolderNoteSettings, PaneFont } from "./types";

export const VIEW_TYPE_TRAVERSE = "traverse-view";

const VAULT_REFRESH_DELAY_MS = 150;
const VAULT_SEARCH_DELAY_MS = 35;
const VAULT_SEARCH_RESULT_LIMIT = 200;
const HISTORY_LIMIT = 200;
let nextExplorerViewId = 0;

export interface ExplorerHost {
	previewVisible(leaf: WorkspaceLeaf, requested: boolean): boolean;
	previewShownByDefault(): boolean;
	folderNoteSettings(): FolderNoteSettings;
	paneFont(): PaneFont;
	hideMarkdownExtensions(): boolean;
	previewCardSize(): number;
	previewCardAspectRatio(): number;
	openFolderInFileManager(folder: TFolder): Promise<void>;
	openFolderInTerminal(folder: TFolder): Promise<void>;
	runMutation<T>(action: () => Promise<T>): Promise<T>;
}

export class TraverseView extends ItemView {
	navigation = true;

	private folder: TFolder;
	private items: ExplorerItem[] = [];
	private filtered: ExplorerItem[] = [];
	private itemElements: HTMLElement[] = [];
	private cursor = 0;
	private cursorVisible = true;
	private selected = new Set<string>();
	private visualAnchor: number | null = null;
	private filter = "";
	private filterMode: "directory" | "vault" | null = null;
	private filterOriginCursor: string | undefined;
	private vaultItems: ExplorerItem[] | null = null;
	private pinyinMatch: PinyinMatcher | null = null;
	private pinyinLoadPromise: Promise<void> | null = null;
	private pinyinLoading = false;
	private pinyinUnavailable = false;
	private clipboard: ExplorerClipboard | null = null;
	private back: ExplorerViewState[] = [];
	private forward: ExplorerViewState[] = [];
	private pendingState: ExplorerViewState | null = null;
	private previewOverride: boolean | null = null;
	private returnPath: string | undefined;
	private rootEl!: HTMLElement;
	private pathEl!: HTMLElement;
	private areasEl!: HTMLElement;
	private listEl!: HTMLElement;
	private filterWrap!: HTMLElement;
	private filterInput!: HTMLInputElement;
	private previewPane!: HTMLElement;
	private previewCard!: HTMLElement;
	private previewContent!: HTMLElement;
	private preview!: PreviewRenderer;
	private operations: ExplorerOperations;
	private readonly domId = `traverse-${nextExplorerViewId++}`;
	private lastG = 0;
	private busy = false;
	private closed = false;
	private saveTimer: number | null = null;
	private refreshTimer: number | null = null;
	private searchTimer: number | null = null;
	private focusFrame: number | null = null;

	constructor(leaf: WorkspaceLeaf, private host: ExplorerHost) {
		super(leaf);
		this.folder = this.app.vault.getRoot();
		this.operations = new ExplorerOperations(this.app);
	}

	getViewType(): string { return VIEW_TYPE_TRAVERSE; }
	getDisplayText(): string { return this.folder.isRoot() ? "Traverse" : this.folder.name; }
	getIcon(): string { return "folder-tree"; }

	async onOpen(): Promise<void> {
		this.closed = false;
		this.contentEl.empty();
		this.contentEl.addClass("traverse-view");
		this.applyAppearance();
		this.buildDom();
		this.preview = new PreviewRenderer(this.app, this.previewContent);
		this.updatePreviewVisibility();
		this.registerDomEvent(this.rootEl, "keydown", (event) => { void this.onKeydown(event); });
		this.registerDomEvent(this.filterInput, "input", () => {
			this.filter = this.filterInput.value;
			this.cursor = 0;
			this.cursorVisible = this.filter.trim().length > 0;
			this.visualAnchor = null;
			this.updateItemStyles();
			const preferredPath = !this.filter.trim() && this.filterMode === "directory" ? this.filterOriginCursor : undefined;
			this.scheduleFilter(preferredPath);
		});
		this.registerDomEvent(this.filterInput, "focus", () => {
			if (this.filter.trim()) return;
			this.cursorVisible = false;
			this.updateItemStyles();
		});
		this.registerDomEvent(this.filterInput, "keydown", (event) => {
			if (event.isComposing) return;
			if (event.key === "Escape") {
				event.preventDefault();
				this.closeFilter();
			} else if (event.key === "Enter" || event.key === "ArrowDown") {
				event.preventDefault();
				void this.focusFilterResults().catch((error) => this.report(error));
			}
		});
		const observer = new (this.contentEl.ownerDocument.defaultView?.ResizeObserver ?? ResizeObserver)(() => {
			this.updatePreviewVisibility();
			this.updatePreviewCardSize();
			this.preview.updateLayout();
		});
		observer.observe(this.contentEl);
		this.register(() => observer.disconnect());
		this.registerEvent(this.app.vault.on("create", (file) => this.onVaultMutation(file)));
		this.registerEvent(this.app.vault.on("delete", (file) => this.onVaultMutation(file)));
		this.registerEvent(this.app.vault.on("rename", (file, oldPath) => this.onVaultMutation(file, oldPath)));
		this.registerEvent(this.app.vault.on("modify", (file) => this.preview.refresh(file)));
		this.registerEvent(this.app.workspace.on("css-change", () => this.updateReadableLineWidth()));
		this.registerEvent(this.app.workspace.on("active-leaf-change", (leaf) => {
			if (leaf === this.leaf) this.scheduleFocusExplorer();
		}));
		if (this.pendingState) this.restoreState(this.pendingState);
		else this.initializeFromActiveFile();
		this.refresh();
		this.rootEl.focus();
	}

	async onClose(): Promise<void> {
		this.closed = true;
		const savePending = this.saveTimer !== null;
		const win = this.contentEl.ownerDocument.defaultView ?? window;
		if (this.saveTimer !== null) win.clearTimeout(this.saveTimer);
		if (this.refreshTimer !== null) win.clearTimeout(this.refreshTimer);
		if (this.searchTimer !== null) win.clearTimeout(this.searchTimer);
		if (this.focusFrame !== null) win.cancelAnimationFrame(this.focusFrame);
		this.saveTimer = null;
		this.refreshTimer = null;
		this.searchTimer = null;
		this.focusFrame = null;
		this.preview?.destroy();
		if (savePending) this.app.workspace.requestSaveLayout();
	}

	getState(): Record<string, unknown> {
		return {
			folder: this.folder.path,
			cursor: this.filterMode === "vault" ? this.filterOriginCursor : this.filtered[this.cursor]?.primary.path,
			preview: this.previewOverride ?? undefined,
			returnPath: this.returnPath,
		};
	}

	async setState(state: unknown): Promise<void> {
		if (isExplorerState(state)) {
			this.pendingState = state;
			if (this.rootEl) {
				this.restoreState(state);
				this.refresh(state.cursor);
			}
		}
	}

	focusExplorer(): void {
		this.rootEl?.focus();
	}

	private scheduleFocusExplorer(): void {
		if (this.focusFrame !== null) return;
		const win = this.contentEl.ownerDocument.defaultView ?? window;
		this.focusFrame = win.requestAnimationFrame(() => {
			this.focusFrame = null;
			if (this.closed || this.app.workspace.getActiveViewOfType(TraverseView) !== this) return;
			const doc = this.contentEl.ownerDocument;
			if (!doc.querySelector(".modal-container") && !this.contentEl.contains(doc.activeElement)) this.rootEl.focus();
		});
	}

	updatePreviewVisibility(): void {
		if (!this.previewCard) return;
		const requested = this.previewOverride ?? this.host.previewShownByDefault();
		const visible = this.host.previewVisible(this.leaf, requested);
		this.previewPane.toggleClass("is-hidden", !visible);
		this.areasEl.toggleClass("is-preview-hidden", !visible);
		this.preview?.setEnabled(visible);
		if (visible) this.updatePreviewCardSize();
	}

	applySettings(): void {
		this.vaultItems = null;
		this.applyAppearance();
		this.updatePreviewVisibility();
		this.preview?.updateLayout();
		this.refresh();
	}

	private applyAppearance(): void {
		const font = this.host.paneFont();
		this.contentEl.toggleClass("is-font-interface", font === "interface");
		this.contentEl.toggleClass("is-font-text", font === "text");
		this.updatePreviewCardSize();
	}

	private updatePreviewCardSize(): void {
		if (!this.previewPane || !this.previewCard) return;
		const dimensions = previewCardDimensions(
			this.previewPane.clientWidth,
			this.previewPane.clientHeight,
			this.host.previewCardSize(),
			this.host.previewCardAspectRatio(),
		);
		if (dimensions.width <= 0 || dimensions.height <= 0) return;
		this.previewCard.style.width = `${Math.round(dimensions.width)}px`;
		this.previewCard.style.height = `${Math.round(dimensions.height)}px`;
	}

	private buildDom(): void {
		const labelIds = {
			root: `${this.domId}-label`,
			list: `${this.domId}-list-label`,
			preview: `${this.domId}-preview-label`,
		};
		this.rootEl = this.contentEl.createDiv({ cls: "traverse", attr: { tabindex: "0", role: "application", "aria-labelledby": labelIds.root } });
		const labels = this.rootEl.createDiv({ cls: "traverse-sr-only" });
		labels.createSpan({ text: "Traverse", attr: { id: labelIds.root } });
		labels.createSpan({ text: "Files and folders", attr: { id: labelIds.list } });
		labels.createSpan({ text: "Preview", attr: { id: labelIds.preview } });
		this.areasEl = this.rootEl.createDiv({ cls: "traverse-areas" });
		const browser = this.areasEl.createDiv({ cls: "traverse-browser" });
		this.pathEl = browser.createDiv({ cls: "traverse-path" });
		this.filterWrap = browser.createDiv({ cls: "traverse-filter is-hidden" });
		this.filterInput = this.filterWrap.createEl("input", { type: "search", attr: { placeholder: "Filter this folder…", role: "combobox", "aria-label": "Filter the current folder", "aria-controls": `${this.domId}-list`, "aria-autocomplete": "list", "aria-expanded": "false" } });
		this.listEl = browser.createDiv({ cls: "traverse-list", attr: { id: `${this.domId}-list`, role: "listbox", "aria-labelledby": labelIds.list } });
		this.previewPane = this.areasEl.createDiv({ cls: "traverse-preview-pane" });
		this.previewCard = this.previewPane.createEl("section", { cls: "traverse-preview-card", attr: { "aria-labelledby": labelIds.preview } });
		this.previewContent = this.previewCard.createDiv({ cls: "traverse-preview markdown-preview-view markdown-rendered" });
		this.updateReadableLineWidth();
	}

	private updateReadableLineWidth(): void {
		this.previewContent?.toggleClass("is-readable-line-width", readableLineWidthEnabled(this.app));
		this.preview?.updateLayout();
	}

	private initializeFromActiveFile(): void {
		const active = this.app.workspace.getActiveFile();
		if (active?.parent) {
			this.folder = active.parent;
			this.pendingState = { cursor: active.path };
			this.returnPath = active.path;
		}
	}

	private restoreState(state: ExplorerViewState): void {
		if (state.folder !== undefined) {
			const folder = this.app.vault.getAbstractFileByPath(state.folder);
			if (folder instanceof TFolder) this.folder = folder;
		}
		this.previewOverride = state.preview ?? null;
		this.returnPath = state.returnPath;
		this.updatePreviewVisibility();
	}

	private onVaultMutation(file: TAbstractFile, oldPath?: string): void {
		if (this.closed) return;
		this.preview.refresh(file, oldPath);
		this.vaultItems = null;
		if (this.filterMode === "vault" || this.isListingMutationRelevant(file.path) || (oldPath !== undefined && this.isListingMutationRelevant(oldPath))) {
			this.scheduleRefresh();
		}
	}

	private isListingMutationRelevant(path: string): boolean {
		return isListingMutationPathRelevant(this.folder.isRoot() ? "/" : this.folder.path, path);
	}

	private scheduleRefresh(): void {
		const win = this.contentEl.ownerDocument.defaultView ?? window;
		if (this.refreshTimer !== null) win.clearTimeout(this.refreshTimer);
		this.refreshTimer = win.setTimeout(() => {
			this.refreshTimer = null;
			this.refresh();
		}, VAULT_REFRESH_DELAY_MS);
	}

	private cancelScheduledRefresh(): void {
		if (this.refreshTimer === null) return;
		(this.contentEl.ownerDocument.defaultView ?? window).clearTimeout(this.refreshTimer);
		this.refreshTimer = null;
	}

	private refresh(preferredPath?: string): void {
		if (!this.listEl || this.closed) return;
		this.cancelScheduledRefresh();
		const cursorPath = preferredPath ?? this.pendingState?.cursor ?? this.filtered[this.cursor]?.primary.path;
		this.pendingState = null;
		this.folder = this.existingFolder(this.folder.path);
		this.visualAnchor = null;
		const resolveFolderNote = createFolderNoteResolver(this.app, this.host.folderNoteSettings());
		const ownNote = resolveFolderNote(this.folder);
		const notes = new Set<string>();
		this.items = [];
		for (const child of this.folder.children) {
			if (!(child instanceof TFolder) || isProtectedPath(this.app, child.path)) continue;
			const note = resolveFolderNote(child);
			if (note) notes.add(note.path);
			this.items.push({ primary: child, folder: child, note, label: child.name });
		}
		for (const child of this.folder.children) {
			if (!(child instanceof TFile) || isProtectedPath(this.app, child.path) || child.path === ownNote?.path || notes.has(child.path)) continue;
			const label = this.host.hideMarkdownExtensions() && child.extension.toLowerCase() === "md" ? child.basename : child.name;
			this.items.push({ primary: child, folder: null, note: null, label });
		}
		this.items.sort((a, b) => Number(b.folder !== null) - Number(a.folder !== null) || a.label.localeCompare(b.label, undefined, { numeric: true, sensitivity: "base" }));
		const listedPaths = new Set(this.items.map((item) => item.primary.path));
		this.selected = new Set(Array.from(this.selected).filter((path) => listedPaths.has(path)));
		this.applyFilter(cursorPath);
	}

	private applyFilter(preferredPath?: string): void {
		const query = this.filter.trim();
		const vaultSearch = this.filterMode === "vault";
		const source = vaultSearch ? this.getVaultItems() : this.items;
		if (query && !this.pinyinMatch && !this.pinyinUnavailable && canUsePinyin(query) && source.some(hasHanText)) {
			void this.ensurePinyinMatcher();
		}
		this.filtered = vaultSearch && !query
			? []
			: query
				? searchItems(source, query, prepareFuzzySearch, this.pinyinMatch, vaultSearch ? VAULT_SEARCH_RESULT_LIMIT : Number.POSITIVE_INFINITY, vaultSearch)
				: source;
		this.selected = new Set(visibleSelectedPaths(this.selected, this.filtered.map((item) => item.primary.path)));
		const found = preferredPath ? this.filtered.findIndex((item) => item.primary.path === preferredPath || item.note?.path === preferredPath) : -1;
		this.cursor = found >= 0 ? found : Math.min(this.cursor, Math.max(0, this.filtered.length - 1));
		this.renderList();
		this.scheduleSave();
	}

	private scheduleFilter(preferredPath?: string): void {
		const win = this.contentEl.ownerDocument.defaultView ?? window;
		if (this.searchTimer !== null) win.clearTimeout(this.searchTimer);
		this.searchTimer = null;
		if (this.filterMode !== "vault") {
			this.applyFilter(preferredPath);
			return;
		}
		this.searchTimer = win.setTimeout(() => {
			this.searchTimer = null;
			this.applyFilter(preferredPath);
		}, VAULT_SEARCH_DELAY_MS);
	}

	private flushScheduledFilter(): void {
		if (this.searchTimer === null) return;
		(this.contentEl.ownerDocument.defaultView ?? window).clearTimeout(this.searchTimer);
		this.searchTimer = null;
		this.applyFilter();
	}

	private ensurePinyinMatcher(): Promise<void> {
		if (this.pinyinMatch || this.pinyinUnavailable) return Promise.resolve();
		if (this.pinyinLoadPromise) return this.pinyinLoadPromise;
		this.pinyinLoading = true;
		this.pinyinLoadPromise = import("pinyin-match")
			.then(({ default: PinyinMatch }) => {
				if (this.closed) return;
				this.pinyinMatch = (text, query) => PinyinMatch.match(text, query);
				this.applyFilter(this.filtered[this.cursor]?.primary.path);
			})
			.catch((error: unknown) => {
				this.pinyinUnavailable = true;
				console.warn("Traverse could not load pinyin matching", error);
			})
			.finally(() => {
				this.pinyinLoading = false;
				this.pinyinLoadPromise = null;
				if (!this.closed) this.renderList();
			});
		return this.pinyinLoadPromise;
	}

	private getVaultItems(): ExplorerItem[] {
		if (this.vaultItems) return this.vaultItems;
		const resolveFolderNote = createFolderNoteResolver(this.app, this.host.folderNoteSettings());
		const notes = new Set<string>();
		const items: ExplorerItem[] = [];
		for (const file of this.app.vault.getAllLoadedFiles()) {
			if (!(file instanceof TFolder) || file.isRoot() || isProtectedPath(this.app, file.path)) continue;
			const note = resolveFolderNote(file);
			if (note) notes.add(note.path);
			items.push({ primary: file, folder: file, note, label: file.name, detail: file.parent?.path || this.app.vault.getName() });
		}
		for (const file of this.app.vault.getFiles()) {
			if (isProtectedPath(this.app, file.path) || notes.has(file.path)) continue;
			const label = this.host.hideMarkdownExtensions() && file.extension.toLowerCase() === "md" ? file.basename : file.name;
			items.push({ primary: file, folder: null, note: null, label, detail: file.parent?.path || this.app.vault.getName() });
		}
		items.sort((a, b) => Number(b.folder !== null) - Number(a.folder !== null) || a.label.localeCompare(b.label, undefined, { numeric: true, sensitivity: "base" }) || a.primary.path.localeCompare(b.primary.path));
		this.vaultItems = items;
		return items;
	}

	private renderList(): void {
		const location = this.folder.isRoot() ? this.app.vault.getName() : `${this.app.vault.getName()}/${this.folder.path}`;
		this.pathEl.setText(`${location}/`);
		this.listEl.empty();
		this.itemElements = [];
		if (this.filtered.length === 0) {
			const emptyText = this.filterMode === "vault" && !this.filter
				? "Type to search the vault"
				: this.pinyinLoading && canUsePinyin(this.filter)
					? "Preparing pinyin search…"
					: this.filter
						? "No matching items"
						: "This folder is empty";
			this.listEl.createDiv({ cls: "traverse-empty", text: emptyText });
		}
		this.filtered.forEach((item, index) => this.renderItem(item, index));
		this.updateCursor(false);
		this.updateStatus();
	}

	private renderItem(item: ExplorerItem, index: number): void {
		const classes = ["traverse-item"];
		if (item.folder) classes.push("is-folder");
		if (item.note) classes.push("has-folder-note");
		const row = this.listEl.createDiv({ cls: classes.join(" "), attr: { id: `${this.domId}-item-${index}`, role: "option", "aria-selected": String(this.selected.has(item.primary.path)) } });
		row.dataset.index = String(index);
		this.itemElements.push(row);
		const icon = row.createSpan({ cls: "traverse-item-icon" });
		setIcon(icon, iconFor(item.primary));
		const text = row.createSpan({ cls: "traverse-item-text" });
		text.createSpan({ cls: "traverse-item-name", text: item.label });
		if (item.detail) text.createSpan({ cls: "traverse-item-detail", text: item.detail });
		row.addEventListener("mouseenter", () => {
			const previous = this.cursor;
			this.cursor = index;
			this.cursorVisible = true;
			this.updateCursor(false, previous, false, true);
		});
		row.addEventListener("mouseleave", () => {
			if (this.filter.trim() || this.contentEl.ownerDocument.activeElement !== this.filterInput) return;
			this.cursorVisible = false;
			this.updateItemStyles();
		});
		row.addEventListener("click", () => {
			this.cursor = index;
			this.cursorVisible = true;
			this.rootEl.focus();
			this.selected.clear();
			this.visualAnchor = null;
			this.updateCursor(true, undefined, false);
		});
		row.addEventListener("dblclick", () => {
			if (item.folder && !item.note) this.enterFolder(item.folder);
			else void this.openItem(item).catch((error) => this.report(error));
		});
	}

	private updateCursor(scroll = true, previousIndex?: number, rapidNavigation?: boolean, hover = false): void {
		let current: HTMLElement | undefined;
		if (previousIndex === undefined) {
			current = this.updateItemStyles();
		} else {
			this.updateRowStyle(previousIndex);
			current = this.updateRowStyle(this.cursor);
			if (!this.cursorVisible) current = undefined;
		}
		this.setActiveDescendant(current);
		if (scroll) current?.scrollIntoView({ block: "nearest" });
		const item = this.filtered[this.cursor];
		const target = item?.note ?? item?.primary ?? null;
		if (hover) this.preview.scheduleHover(target);
		else if (rapidNavigation === undefined) this.preview.schedule(target);
		else this.preview.scheduleNavigation(target, rapidNavigation);
		this.updateStatus();
		this.scheduleSave();
	}

	private updateItemStyles(): HTMLElement | undefined {
		for (let index = 0; index < this.itemElements.length; index++) this.updateRowStyle(index);
		const current = this.cursorVisible ? this.itemElements[this.cursor] : undefined;
		this.setActiveDescendant(current);
		return current;
	}

	private setActiveDescendant(current: HTMLElement | undefined): void {
		if (current) {
			this.listEl.setAttr("aria-activedescendant", current.id);
			this.rootEl.setAttr("aria-activedescendant", current.id);
			if (this.filterMode !== null) this.filterInput.setAttr("aria-activedescendant", current.id);
			else this.filterInput.removeAttribute("aria-activedescendant");
		} else {
			this.listEl.removeAttribute("aria-activedescendant");
			this.rootEl.removeAttribute("aria-activedescendant");
			this.filterInput.removeAttribute("aria-activedescendant");
		}
	}

	private updateRowStyle(index: number): HTMLElement | undefined {
		const element = this.itemElements[index];
		if (!element) return undefined;
		const selected = this.selected.has(this.filtered[index]?.primary.path ?? "");
		element.toggleClass("is-cursor", this.cursorVisible && index === this.cursor);
		element.toggleClass("is-selected", selected);
		element.setAttr("aria-selected", String(selected));
		return element;
	}

	private updateStatus(): void {
		this.rootEl?.toggleClass("is-busy", this.busy);
	}

	private existingFolder(path: string): TFolder {
		let candidate = path;
		while (candidate) {
			const found = this.app.vault.getAbstractFileByPath(candidate);
			if (found instanceof TFolder) return found;
			candidate = candidate.includes("/") ? candidate.slice(0, candidate.lastIndexOf("/")) : "";
		}
		return this.app.vault.getRoot();
	}

	private onKeydown(event: KeyboardEvent): void {
		const target = hasClosest(event.target) ? event.target : null;
		if (event.defaultPrevented
			|| target?.closest(".traverse-preview, input, textarea, select, [contenteditable]:not([contenteditable='false'])")
			|| this.rootEl.ownerDocument.querySelector(".modal-container")) return;
		const mod = event.metaKey || event.ctrlKey;
		if (event.altKey || (mod && event.key.toLowerCase() !== "a" && event.key !== "Enter")) return;
		if (event.shiftKey && !(event.key === "A" || event.key === "C" || event.key === "G" || event.key === "D" || event.key === "H" || event.key === "L" || event.key === "J" || event.key === "K" || event.key === "P" || event.key === "F" || event.key === "T" || event.key === "?" || event.key === "~")) return;
		const handled = new Set(["j", "ArrowDown", "k", "ArrowUp", "h", "ArrowLeft", "l", "ArrowRight", "Enter", "g", "G", "~", "/", "s", "Escape", " ", "a", "A", "C", "q", "v", "r", "y", "x", "p", "d", "D", "H", "L", "J", "K", "P", "F", "T", "?"]);
		if (!handled.has(event.key)) return;
		event.preventDefault();
		const operationKeys = new Set(["a", "A", "C", "r", "y", "x", "p", "d", "D", "F", "T"]);
		if ((event.repeat || this.busy) && operationKeys.has(event.key)) return;
		switch (event.key) {
			case "j": case "ArrowDown": this.moveCursor(1, event.repeat); break;
			case "k": case "ArrowUp": this.moveCursor(-1, event.repeat); break;
			case "h": case "ArrowLeft": this.goParent(); break;
			case "l": case "ArrowRight": this.enterCurrentFolder(); break;
			case "Enter": if (mod) this.enterCurrentFolder(); else void this.openCurrent().catch((error) => this.report(error)); break;
			case "g": this.handleG(); break;
			case "~": this.goRoot(); break;
			case "G": {
				const last = Math.max(0, this.filtered.length - 1);
				if (this.cursor !== last) {
					const previous = this.cursor;
					this.cursor = last;
					this.updateCursor(true, previous, false);
				}
				break;
			}
			case "/": this.openFilter("directory"); break;
			case "s": this.openFilter("vault"); break;
			case "Escape": this.escape(); break;
			case " ": this.toggleSelection(); break;
			case "a": if (mod) this.selectAll(); else void this.createItem(false); break;
			case "A": if (mod) this.selectAll(); else void this.createItem(true); break;
			case "C": void this.createFolderNote(); break;
			case "q": void this.returnToPreviousNote().catch((error) => this.report(error)); break;
			case "v": this.visualSelect(); break;
			case "r": void this.renameCurrent(); break;
			case "y": this.stage("copy"); break;
			case "x": this.stage("cut"); break;
			case "p": void this.paste(); break;
			case "d": void this.deleteItems(false); break;
			case "D": void this.deleteItems(true); break;
			case "H": this.goHistory(false); break;
			case "L": this.goHistory(true); break;
			case "J": this.preview.scroll(180); break;
			case "K": this.preview.scroll(-180); break;
			case "P": this.togglePreview(); break;
			case "F": void this.host.openFolderInFileManager(this.folder).catch((error) => this.report(error)); break;
			case "T": void this.host.openFolderInTerminal(this.folder).catch((error) => this.report(error)); break;
			// eslint-disable-next-line obsidianmd/ui/sentence-case
			case "?": new Notice("j/k move · h/l parent/enter · / filter · s vault search · q back to note · ~ root · gg/G ends · Space/v select · a/A file/folder · C folder note · r rename · y/x/p copy/cut/paste · d file/note · D folder · F file manager · T terminal · P preview · J/K scroll"); break;
		}
	}

	private moveCursor(delta: number, rapid = false): void {
		if (!this.filtered.length) return;
		this.cursorVisible = true;
		const next = Math.max(0, Math.min(this.filtered.length - 1, this.cursor + delta));
		if (next === this.cursor) return;
		const previous = this.cursor;
		this.cursor = next;
		if (this.visualAnchor !== null) {
			this.selectRange(this.visualAnchor, this.cursor);
			this.updateCursor();
		} else {
			this.updateCursor(true, previous, rapid);
		}
	}

	private handleG(): void {
		const now = Date.now();
		if (now - this.lastG < 500) {
			if (this.cursor !== 0) {
				const previous = this.cursor;
				this.cursor = 0;
				this.updateCursor(true, previous, false);
			}
			this.lastG = 0;
		} else this.lastG = now;
	}

	private goParent(): void {
		if (this.folder.parent) this.navigate(this.folder.parent, true, this.folder.path);
	}

	private goRoot(): void {
		if (this.folder.isRoot()) return;
		this.navigate(this.app.vault.getRoot(), true, this.folder.path.split("/", 1)[0]);
	}

	private enterCurrentFolder(): void {
		const folder = this.filtered[this.cursor]?.folder;
		if (folder) this.navigate(folder, true);
	}

	private enterFolder(folder: TFolder): void { this.navigate(folder, true); }

	private navigate(folder: TFolder, record: boolean, cursorPath?: string): void {
		if (folder.path === this.folder.path) return;
		if (record) {
			this.pushHistory(this.back, this.historyLocation());
			this.forward = [];
		}
		this.folder = folder;
		this.cursor = 0;
		this.cursorVisible = true;
		this.selected.clear();
		this.visualAnchor = null;
		this.filter = "";
		this.filterMode = null;
		this.filterOriginCursor = undefined;
		this.filterInput.value = "";
		this.filterWrap.addClass("is-hidden");
		this.filterInput.setAttr("aria-expanded", "false");
		this.pathEl.removeClass("is-hidden");
		this.refresh(cursorPath);
	}

	private historyLocation(): ExplorerViewState {
		return { folder: this.folder.path, cursor: this.filterMode === "vault" ? this.filterOriginCursor : this.filtered[this.cursor]?.primary.path };
	}

	private pushHistory(stack: ExplorerViewState[], state: ExplorerViewState): void {
		stack.push(state);
		if (stack.length > HISTORY_LIMIT) stack.splice(0, stack.length - HISTORY_LIMIT);
	}

	private goHistory(forward: boolean): void {
		const source = forward ? this.forward : this.back;
		const destination = forward ? this.back : this.forward;
		let state = source.pop();
		while (state?.folder !== undefined) {
			const folder = this.app.vault.getAbstractFileByPath(state.folder);
			if (folder instanceof TFolder) {
				this.pushHistory(destination, this.historyLocation());
				this.navigate(folder, false, state.cursor);
				return;
			}
			// Skip entries whose folder no longer exists instead of dropping the rest of the history.
			state = source.pop();
		}
	}

	private async returnToPreviousNote(): Promise<void> {
		const file = this.returnPath ? this.app.vault.getAbstractFileByPath(this.returnPath) : null;
		if (!(file instanceof TFile)) {
			new Notice("No previous note to return to");
			return;
		}
		await this.leaf.openFile(file);
	}

	private async openCurrent(): Promise<void> {
		const item = this.filtered[this.cursor];
		if (item) await this.openItem(item);
	}

	private async focusFilterResults(): Promise<void> {
		this.flushScheduledFilter();
		const mode = this.filterMode;
		const query = this.filter;
		if (this.pinyinLoadPromise) await this.pinyinLoadPromise;
		if (this.closed || this.filterMode !== mode || this.filter !== query) return;
		this.cursorVisible = true;
		this.rootEl.focus();
		this.updateItemStyles();
	}

	private async openItem(item: ExplorerItem): Promise<void> {
		const file = item.note ?? (item.primary instanceof TFile ? item.primary : null);
		if (file) await this.leaf.openFile(file);
		else if (item.folder) this.navigate(item.folder, true);
	}

	private openFilter(mode: "directory" | "vault"): void {
		if (this.filterMode !== mode) {
			if (mode === "vault" || this.filterMode === null) this.filterOriginCursor = this.filtered[this.cursor]?.primary.path;
			this.filterMode = mode;
			this.filter = "";
			this.cursorVisible = false;
			this.filterInput.value = "";
			this.filterInput.placeholder = mode === "vault" ? "Search the vault…" : "Filter this folder…";
			this.applyFilter(mode === "vault" ? undefined : this.filterOriginCursor);
		}
		this.filterInput.setAttr("aria-label", mode === "vault" ? "Search the vault" : "Filter the current folder");
		this.filterInput.setAttr("aria-expanded", "true");
		this.pathEl.addClass("is-hidden");
		this.filterWrap.removeClass("is-hidden");
		this.filterInput.focus();
	}

	private closeFilter(): void {
		const preferredPath = this.filterMode === "vault" ? this.filterOriginCursor : this.filtered[this.cursor]?.primary.path;
		if (this.searchTimer !== null) (this.contentEl.ownerDocument.defaultView ?? window).clearTimeout(this.searchTimer);
		this.searchTimer = null;
		this.filter = "";
		this.filterMode = null;
		this.filterOriginCursor = undefined;
		this.cursorVisible = true;
		this.visualAnchor = null;
		this.filterInput.value = "";
		this.filterWrap.addClass("is-hidden");
		this.filterInput.setAttr("aria-expanded", "false");
		this.pathEl.removeClass("is-hidden");
		this.applyFilter(preferredPath);
		this.rootEl.focus();
	}

	private togglePreview(): void {
		const requested = this.previewOverride ?? this.host.previewShownByDefault();
		this.previewOverride = !requested;
		this.updatePreviewVisibility();
		this.scheduleSave();
	}

	private escape(): void {
		if (this.filterMode !== null) this.closeFilter();
		else if (this.visualAnchor !== null) { this.visualAnchor = null; this.updateStatus(); }
		else if (this.selected.size) { this.selected.clear(); this.updateItemStyles(); }
	}

	private toggleSelection(): void {
		const path = this.filtered[this.cursor]?.primary.path;
		if (!path) return;
		if (this.selected.has(path)) this.selected.delete(path); else this.selected.add(path);
		const previous = this.cursor;
		this.moveCursor(1);
		if (this.cursor === previous) this.updateItemStyles();
	}

	private selectAll(): void {
		this.selected = new Set(this.filtered.map((item) => item.primary.path));
		this.updateItemStyles();
	}

	private visualSelect(): void {
		if (this.visualAnchor === null) this.visualAnchor = this.cursor;
		else this.visualAnchor = null;
		if (this.visualAnchor !== null) this.selectRange(this.visualAnchor, this.cursor);
		this.updateItemStyles();
	}

	private selectRange(start: number, end: number): void {
		this.selected.clear();
		for (let index = Math.min(start, end); index <= Math.max(start, end); index++) {
			const path = this.filtered[index]?.primary.path;
			if (path) this.selected.add(path);
		}
	}

	private targets(): TAbstractFile[] {
		const selected = visibleSelectedPaths(this.selected, this.filtered.map((item) => item.primary.path));
		const paths = selected.length ? selected : [this.filtered[this.cursor]?.primary.path].filter((path): path is string => path !== undefined);
		return paths.map((path) => this.app.vault.getAbstractFileByPath(path)).filter((file): file is TAbstractFile => file !== null);
	}

	private isCurrentFile(file: TAbstractFile): boolean {
		return file instanceof TFolder && file.isRoot()
			? this.app.vault.getRoot() === file
			: this.app.vault.getAbstractFileByPath(file.path) === file;
	}

	private async createItem(folder: boolean): Promise<void> {
		await this.withBusy(async () => {
			const parent = this.folder;
			const input = await promptText(this.app, folder ? "New folder" : "New file", folder ? "Folder name" : "File name");
			if (!input || this.closed) return;
			if (!this.isCurrentFile(parent)) throw new Error("The destination folder changed while the prompt was open");
			const created = await this.operations.create(parent, input, folder);
			this.refresh(created.path);
		});
	}

	private async createFolderNote(): Promise<void> {
		await this.withBusy(async () => {
			const item = this.filtered[this.cursor];
			const folder = item?.folder;
			if (!folder) {
				new Notice("Select a folder to create a folder note");
				return;
			}
			const settings = this.host.folderNoteSettings();
			if (!settings.folderNotesEnabled) {
				new Notice("Enable folder notes in Traverse settings first");
				return;
			}
			if (createFolderNoteResolver(this.app, settings)(folder)) {
				new Notice("This folder already has a folder note");
				return;
			}
			const extensions = normalizeFolderNoteExtensions(settings.folderNoteExtensions);
			if (!extensions.length) {
				new Notice("Add a folder note extension in Traverse settings first");
				return;
			}
			const extension = await promptChoice(this.app, "Create folder note", "File extension", extensions);
			if (!extension || this.closed) return;
			if (!this.isCurrentFile(folder)) throw new Error("The folder changed while the prompt was open");
			await this.operations.createFolderNote(folder, settings, extension);
			this.vaultItems = null;
			this.refresh(folder.path);
		});
	}

	private async renameCurrent(): Promise<void> {
		await this.withBusy(async () => {
			const file = this.filtered[this.cursor]?.primary;
			if (!file) return;
			const selectionEnd = file instanceof TFile ? file.basename.length : file.name.length;
			const name = await promptText(this.app, `Rename ${file.name}`, "Name", file.name, selectionEnd);
			if (!name || name === file.name || this.closed) return;
			if (!this.isCurrentFile(file)) throw new Error(`${file.name} changed while the prompt was open`);
			await this.operations.rename(file, name, this.host.folderNoteSettings());
			this.selected.clear();
			this.refresh();
		});
	}

	private stage(mode: "copy" | "cut"): void {
		const paths = this.targets().map((file) => file.path);
		if (!paths.length) return;
		this.clipboard = { mode, paths };
		new Notice(`${mode === "copy" ? "Yanked" : "Cut"} ${paths.length} item${paths.length === 1 ? "" : "s"}`);
	}

	private async paste(): Promise<void> {
		await this.withBusy(async () => {
			const clipboard = this.clipboard;
			if (!clipboard) return;
			const sources = clipboard.paths
				.map((path) => this.app.vault.getAbstractFileByPath(path))
				.filter((file): file is TAbstractFile => file !== null);
			if (sources.length === 0) return;
			if (clipboard.mode === "cut" && sources.every((file) => file.parent?.path === this.folder.path)) {
				new Notice("Items are already in this folder");
				return;
			}
			const verb = clipboard.mode === "copy" ? "Copy" : "Move";
			const destination = this.folder;
			const confirmed = await confirmAction(this.app, `${verb} items?`, `${verb} ${sources.length} item${sources.length === 1 ? "" : "s"} to ${destination.isRoot() ? this.app.vault.getName() : destination.path}?`, verb);
			if (!confirmed || this.closed) return;
			if (!this.isCurrentFile(destination) || sources.some((file) => !this.isCurrentFile(file))) {
				throw new Error("The source or destination changed while the prompt was open");
			}
			const result = await this.operations.paste(clipboard.mode, sources, destination, this.host.folderNoteSettings());
			if (clipboard.mode === "cut" && this.clipboard === clipboard) {
				this.clipboard = result.failures.length > 0 ? { mode: "cut", paths: result.failures.map((failure) => failure.path) } : null;
			}
			this.selected = new Set(result.failures.map((failure) => failure.path));
			this.refresh();
			if (result.failures.length > 0) {
				new Notice(`${result.completed} completed; ${result.failures.length} failed. ${result.failures[0].name}: ${result.failures[0].message}`);
			}
		});
	}

	private async deleteItems(deleteFolders: boolean): Promise<void> {
		await this.withBusy(async () => {
			const logicalTargets = this.targets();
			if (!logicalTargets.length) return;
			if (logicalTargets.some((file) => isProtectedPath(this.app, file.path))) throw new Error("Protected hidden or configuration items cannot be deleted");

			const plans: { file: TAbstractFile; selectionPath: string }[] = [];
			let folderNoteCount = 0;
			let skippedFolders = 0;
			if (deleteFolders) {
				if (logicalTargets.some((file) => !(file instanceof TFolder))) {
					new Notice("D deletes folders only");
					return;
				}
				for (const folder of withoutNestedFolders(logicalTargets)) plans.push({ file: folder, selectionPath: folder.path });
			} else {
				const resolveFolderNote = createFolderNoteResolver(this.app, this.host.folderNoteSettings());
				const plannedPaths = new Set<string>();
				for (const target of logicalTargets) {
					const file = target instanceof TFolder ? resolveFolderNote(target) : target;
					if (!file) {
						skippedFolders++;
						continue;
					}
					if (target instanceof TFolder) folderNoteCount++;
					if (plannedPaths.has(file.path)) continue;
					plannedPaths.add(file.path);
					plans.push({ file, selectionPath: target.path });
				}
			}
			if (!plans.length) {
				new Notice(deleteFolders ? "Select a folder to delete" : "This folder has no folder note to delete");
				return;
			}
			if (plans.some(({ file }) => isProtectedPath(this.app, file.path))) throw new Error("Protected hidden or configuration items cannot be deleted");

			const count = plans.length;
			const message = deleteFolders
				? `Delete ${count} folder${count === 1 ? "" : "s"} and everything inside?`
				: `Delete ${count} file${count === 1 ? "" : "s"}?${folderNoteCount > 0 ? " Folder notes will be removed; their folders will remain." : ""}${skippedFolders > 0 ? ` ${skippedFolders} folder${skippedFolders === 1 ? " has" : "s have"} no folder note and will not be changed.` : ""}`;
			const confirmed = await confirmAction(this.app, deleteFolders ? "Delete folder?" : "Delete file?", message, "Delete", true);
			if (!confirmed || this.closed) return;
			if (plans.some(({ file }) => !this.isCurrentFile(file))) throw new Error("The selection changed while the prompt was open");

			const failures: { selectionPath: string; name: string; message: string }[] = [];
			let completed = 0;
			for (const plan of plans) {
				try {
					await this.app.fileManager.trashFile(plan.file);
					completed++;
				} catch (error) {
					failures.push({ selectionPath: plan.selectionPath, name: plan.file.name, message: error instanceof Error ? error.message : "Unknown deletion error" });
				}
			}
			this.selected = new Set(failures.map((failure) => failure.selectionPath));
			this.vaultItems = null;
			this.refresh();
			if (failures.length > 0) new Notice(`${completed} completed; ${failures.length} failed. ${failures[0].name}: ${failures[0].message}`);
		});
	}

	private async withBusy(action: () => Promise<void>): Promise<void> {
		if (this.busy || this.closed) return;
		this.busy = true;
		this.updateStatus();
		try {
			await this.host.runMutation(async () => {
				if (!this.closed) await action();
			});
		} catch (error) {
			if (!this.closed) this.report(error);
		} finally {
			this.busy = false;
			if (!this.closed) this.updateStatus();
		}
	}

	private scheduleSave(): void {
		if (!this.rootEl) return;
		const win = this.rootEl.ownerDocument.defaultView ?? window;
		if (this.saveTimer !== null) win.clearTimeout(this.saveTimer);
		this.saveTimer = win.setTimeout(() => {
			this.saveTimer = null;
			this.app.workspace.requestSaveLayout();
		}, 250);
	}

	private report(error: unknown): void {
		console.error("Traverse operation failed", error);
		new Notice(error instanceof Error ? error.message : "Traverse operation failed");
	}
}

function withoutNestedFolders(files: readonly TAbstractFile[]): TFolder[] {
	const folders = files.filter((file): file is TFolder => file instanceof TFolder);
	const selectedPaths = new Set(folders.map((folder) => folder.path));
	return folders.filter((folder) => {
		let parent = folder.parent;
		while (parent) {
			if (selectedPaths.has(parent.path)) return false;
			parent = parent.parent;
		}
		return true;
	});
}

function readableLineWidthEnabled(app: App): boolean {
	const vault = app.vault as typeof app.vault & { getConfig?: (key: string) => unknown };
	return vault.getConfig?.("readableLineLength") === true;
}

function hasClosest(target: EventTarget | null): target is EventTarget & { closest(selector: string): Element | null } {
	return target !== null && "closest" in target && typeof target.closest === "function";
}

function isExplorerState(state: unknown): state is ExplorerViewState {
	if (typeof state !== "object" || state === null) return false;
	const value = state as Record<string, unknown>;
	return (value.folder === undefined || typeof value.folder === "string")
		&& (value.cursor === undefined || typeof value.cursor === "string")
		&& (value.preview === undefined || typeof value.preview === "boolean")
		&& (value.returnPath === undefined || typeof value.returnPath === "string");
}
