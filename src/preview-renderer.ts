import { App, Component, MarkdownRenderer, TAbstractFile, TFile, TFolder, setIcon } from "obsidian";
import { iconFor } from "./icons";
import { isPathWithinFolder } from "./path-utils";

const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "avif"]);
const AUDIO_EXTENSIONS = new Set(["mp3", "wav", "m4a", "ogg", "flac", "webm"]);
const VIDEO_EXTENSIONS = new Set(["mp4", "webm", "ogv", "mov", "mkv"]);
const TEXT_EXTENSIONS = new Set(["txt", "json", "yaml", "yml", "css", "js", "ts", "html", "xml", "csv", "log"]);
const MAX_TEXT = 100_000;
const MAX_MARKDOWN_READ = 1_000_000;
const MAX_TEXT_READ = 1_000_000;
const PREVIEW_DELAY_MS = 50;
const DIRECT_PREVIEW_DELAY_MS = 8;
const HOVER_PREVIEW_DELAY_MS = 40;
const RAPID_PREVIEW_DELAY_MS = 70;

export class PreviewRenderer {
	private timer: number | null = null;
	private generation = 0;
	private child: Component | null = null;
	private rendering = false;
	private target: TAbstractFile | null = null;
	private targetPath: string | null = null;
	private scrollFrame: number | null = null;
	private scrollTarget: number | null = null;
	private scrollElement: HTMLElement | null = null;
	private scrollLastTime: number | null = null;
	private destroyed = false;
	private enabled = true;
	private readonly win: Window;

	constructor(private app: App, private container: HTMLElement) {
		this.win = container.ownerDocument.defaultView ?? window;
	}

	scheduleNavigation(target: TAbstractFile | null, rapid: boolean): void {
		this.schedule(target, false, rapid ? RAPID_PREVIEW_DELAY_MS : DIRECT_PREVIEW_DELAY_MS);
	}

	scheduleHover(target: TAbstractFile | null): void {
		this.schedule(target, false, HOVER_PREVIEW_DELAY_MS);
	}

	schedule(target: TAbstractFile | null, force = false, delayMs = PREVIEW_DELAY_MS): void {
		const nextPath = target?.path ?? null;
		const targetChanged = nextPath !== this.targetPath;
		this.target = target;
		if (!targetChanged && !force) return;
		this.targetPath = nextPath;
		this.generation++;
		if (this.timer !== null) this.win.clearTimeout(this.timer);
		this.timer = null;
		if (targetChanged) {
			this.cancelScroll();
			this.container.setAttr("aria-busy", "true");
		}
		if (!this.enabled || this.rendering) return;
		this.timer = this.win.setTimeout(() => {
			this.timer = null;
			void this.run();
		}, delayMs);
	}

	updateLayout(): void {
		const body = this.container.querySelector<HTMLElement>(".traverse-preview-body.is-markdown");
		if (!body || this.container.clientWidth <= 0) return;
		body.style.removeProperty("width");
		body.style.removeProperty("zoom");
		if (!this.container.hasClass("is-readable-line-width")) return;
		const bodyStyle = this.win.getComputedStyle(body);
		const padding = cssPixels(bodyStyle.paddingLeft, 0) + cssPixels(bodyStyle.paddingRight, 0);
		body.style.width = `calc(var(--file-line-width, 700px) + ${padding}px)`;
		const layoutWidth = body.getBoundingClientRect().width;
		const scale = Math.min(1, this.container.clientWidth / layoutWidth);
		body.style.setProperty("zoom", String(scale));
	}

	setEnabled(enabled: boolean): void {
		if (this.enabled === enabled) return;
		this.enabled = enabled;
		this.generation++;
		if (this.timer !== null) this.win.clearTimeout(this.timer);
		this.timer = null;
		if (!enabled) {
			this.cancelScroll();
			this.unloadChild();
			this.container.empty();
			this.container.removeAttribute("aria-busy");
			return;
		}
		this.schedule(this.target, true);
	}

	refresh(file: TAbstractFile, oldPath?: string): void {
		const target = this.target;
		if (!target) return;
		if (target instanceof TFile) {
			if (target !== file && target.path !== file.path && target.path !== oldPath) return;
			const current = file instanceof TFile ? this.app.vault.getAbstractFileByPath(file.path) : null;
			this.schedule(current instanceof TFile ? current : null, true);
			return;
		}
		if (isPathWithinFolder(file.path, target.path) || (oldPath !== undefined && isPathWithinFolder(oldPath, target.path))) {
			this.schedule(target, true);
		}
	}

	destroy(): void {
		this.destroyed = true;
		this.enabled = false;
		this.generation++;
		if (this.timer !== null) this.win.clearTimeout(this.timer);
		this.timer = null;
		this.cancelScroll();
		this.unloadChild();
		this.container.empty();
		this.container.removeAttribute("aria-busy");
	}

	scroll(amount: number): void {
		const element = this.getScrollElement();
		if (this.scrollElement !== element) {
			this.cancelScroll();
			this.scrollElement = element;
		}
		const maximum = Math.max(0, element.scrollHeight - element.clientHeight);
		const currentTarget = this.scrollTarget ?? element.scrollTop;
		this.scrollTarget = Math.max(0, Math.min(maximum, currentTarget + amount));
		if (Math.abs(this.scrollTarget - element.scrollTop) < 1 || this.scrollFrame !== null) return;
		this.scrollLastTime = null;
		this.scrollFrame = this.win.requestAnimationFrame((time) => this.animateScroll(time));
	}

	private animateScroll(time: number): void {
		this.scrollFrame = null;
		const element = this.scrollElement;
		const target = this.scrollTarget;
		if (!element || target === null) return;
		const elapsed = this.scrollLastTime === null ? 16 : Math.min(50, Math.max(1, time - this.scrollLastTime));
		this.scrollLastTime = time;
		const distance = target - element.scrollTop;
		if (Math.abs(distance) < 0.75) {
			element.scrollTop = target;
			this.scrollTarget = null;
			this.scrollLastTime = null;
			return;
		}
		const progress = 1 - Math.exp(-elapsed / 55);
		element.scrollTop += distance * progress;
		this.scrollFrame = this.win.requestAnimationFrame((nextTime) => this.animateScroll(nextTime));
	}

	private getScrollElement(): HTMLElement {
		const iframe = this.container.querySelector("iframe");
		if (iframe) {
			try {
				const scrolling = iframe.contentDocument?.scrollingElement;
				if (scrolling && scrolling.scrollHeight > scrolling.clientHeight) return scrolling as HTMLElement;
			} catch {
				// Chromium's PDF viewer is normally cross-origin; outer scrolling remains the safe fallback.
			}
		}
		return this.container;
	}

	private cancelScroll(): void {
		if (this.scrollFrame !== null) this.win.cancelAnimationFrame(this.scrollFrame);
		this.scrollFrame = null;
		this.scrollTarget = null;
		this.scrollElement = null;
		this.scrollLastTime = null;
	}

	private async run(): Promise<void> {
		if (this.rendering || this.destroyed || !this.enabled) return;
		this.rendering = true;
		try {
			let renderedGeneration = -1;
			while (!this.destroyed && this.enabled && renderedGeneration !== this.generation) {
				renderedGeneration = this.generation;
				await this.render(this.target, renderedGeneration);
			}
		} finally {
			this.rendering = false;
		}
	}

	private async render(target: TAbstractFile | null, generation: number): Promise<void> {
		const staging = this.container.ownerDocument.createDocumentFragment();
		let child: Component | null = null;
		if (!target) {
			staging.createDiv({ cls: "traverse-preview-empty", text: "Nothing to preview" });
		} else {
			const body = staging.createDiv({ cls: "traverse-preview-body" });
			try {
				if (target instanceof TFolder) this.renderFolder(target, body);
				else if (target instanceof TFile) child = await this.renderFile(target, body, generation);
				else body.createEl("p", { text: "Preview unavailable" });
			} catch (error) {
				body.empty();
				body.createDiv({ cls: "traverse-preview-error", text: error instanceof Error ? error.message : "Preview unavailable" });
			}
		}
		if (this.destroyed || !this.enabled || generation !== this.generation) {
			child?.unload();
			return;
		}
		this.cancelScroll();
		this.unloadChild();
		this.child = child;
		this.container.replaceChildren(...Array.from(staging.childNodes));
		this.container.scrollTop = 0;
		this.updateLayout();
		this.container.setAttr("aria-busy", "false");
	}

	private renderFolder(folder: TFolder, body: HTMLElement): void {
		body.addClass("is-folder");
		const directChildren = this.sortedChildren(folder);
		const folders = directChildren.filter((child) => child instanceof TFolder).length;
		const files = directChildren.length - folders;
		body.createDiv({ cls: "traverse-folder-summary", text: `${folders} folder${folders === 1 ? "" : "s"}, ${files} file${files === 1 ? "" : "s"}` });
		const tree = body.createDiv({ cls: "traverse-folder-tree" });
		const budget = { remaining: 90, truncated: false };
		this.renderFolderLevel(folder, tree, 0, budget, directChildren);
		if (budget.truncated) body.createDiv({ cls: "traverse-folder-more", text: "More items…" });
	}

	private renderFolderLevel(folder: TFolder, container: HTMLElement, depth: number, budget: { remaining: number; truncated: boolean }, sorted?: TAbstractFile[]): void {
		if (budget.remaining <= 0) {
			budget.truncated = true;
			return;
		}
		for (const child of sorted ?? this.sortedChildren(folder)) {
			if (budget.remaining <= 0) {
				budget.truncated = true;
				return;
			}
			budget.remaining--;
			const node = container.createDiv({ cls: "traverse-folder-node" });
			const row = node.createDiv({ cls: `traverse-folder-entry${child instanceof TFolder ? " is-folder" : ""}` });
			const icon = row.createSpan({ cls: "traverse-folder-entry-icon" });
			setIcon(icon, iconFor(child));
			row.createSpan({ cls: "traverse-folder-entry-name", text: child.name });
			if (child instanceof TFolder && child.children.length > 0 && depth < 2) {
				const children = node.createDiv({ cls: "traverse-folder-children" });
				this.renderFolderLevel(child, children, depth + 1, budget);
			}
		}
	}

	private sortedChildren(folder: TFolder): TAbstractFile[] {
		return [...folder.children].sort((a, b) => Number(b instanceof TFolder) - Number(a instanceof TFolder) || a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }));
	}

	private async renderFile(file: TFile, body: HTMLElement, generation: number): Promise<Component | null> {
		const extension = file.extension.toLowerCase();
		if (extension === "base") return this.renderBase(file, body);
		if (extension === "canvas") {
			body.createDiv({ cls: "traverse-preview-large", text: "Canvas preview unavailable" });
			body.createDiv({ cls: "traverse-preview-large-hint", text: "Open the file to view its contents." });
			return null;
		}
		if (extension === "md") {
			body.addClass("is-markdown");
			if (file.stat.size > MAX_MARKDOWN_READ) {
				this.renderLargeFile(body, file, "Markdown");
				return null;
			}
			const markdown = await this.app.vault.cachedRead(file);
			if (!this.isCurrent(generation)) return null;
			const markdownTarget = body.createDiv({ cls: "traverse-markdown-sizer markdown-preview-sizer markdown-preview-section" });
			const child = new Component();
			child.load();
			try {
				await MarkdownRenderer.render(this.app, markdown, markdownTarget, file.path, child);
				return child;
			} catch (error) {
				child.unload();
				throw error;
			}
		}
		const resource = this.app.vault.getResourcePath(file);
		if (IMAGE_EXTENSIONS.has(extension)) {
			body.addClass("is-media");
			body.createEl("img", { attr: { src: resource, alt: file.basename, decoding: "async" } });
		} else if (AUDIO_EXTENSIONS.has(extension)) {
			body.addClass("is-media");
			body.createEl("audio", { attr: { src: resource, controls: "", preload: "metadata" } });
		} else if (VIDEO_EXTENSIONS.has(extension)) {
			body.addClass("is-media");
			body.createEl("video", { attr: { src: resource, controls: "", preload: "metadata" } });
		} else if (extension === "pdf") {
			body.addClass("is-pdf");
			body.createEl("iframe", { attr: { src: `${resource}#toolbar=0&navpanes=0&view=FitH`, title: `Preview of ${file.name}` } });
		} else if (TEXT_EXTENSIONS.has(extension) || file.stat.size <= MAX_TEXT) {
			if (file.stat.size > MAX_TEXT_READ) {
				this.renderLargeFile(body, file, extension.toUpperCase() || "Text");
				return null;
			}
			const text = await this.app.vault.cachedRead(file);
			if (!this.isCurrent(generation)) return null;
			body.createEl("pre", { text: text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}\n\n…truncated` : text });
		} else body.createEl("p", { text: `${extension.toUpperCase() || "Binary"} file · ${formatBytes(file.stat.size)}` });
		return null;
	}

	private renderLargeFile(body: HTMLElement, file: TFile, type: string): void {
		body.createDiv({ cls: "traverse-preview-large", text: `${type} file · ${formatBytes(file.stat.size)}` });
		body.createDiv({ cls: "traverse-preview-large-hint", text: "Open the file to view its contents." });
	}

	private isCurrent(generation: number): boolean {
		return !this.destroyed && this.enabled && generation === this.generation;
	}

	private async renderBase(file: TFile, body: HTMLElement): Promise<Component> {
		body.addClass("is-base");
		const child = new Component();
		child.load();
		const sourcePath = file.parent?.path ? `${file.parent.path}/Traverse Preview.md` : "Traverse Preview.md";
		const embed = `!${this.app.fileManager.generateMarkdownLink(file, sourcePath)}`;
		try {
			await MarkdownRenderer.render(this.app, embed, body, sourcePath, child);
			return child;
		} catch (error) {
			child.unload();
			throw error;
		}
	}

	private unloadChild(): void {
		this.child?.unload();
		this.child = null;
	}
}

function cssPixels(value: string, fallback: number): number {
	const parsed = Number.parseFloat(value);
	return Number.isFinite(parsed) ? parsed : fallback;
}

function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
