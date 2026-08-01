import { App, Modal } from "obsidian";

let nextDialogId = 0;

export function promptText(app: App, title: string, placeholder = "", initialValue = "", selectionEnd?: number): Promise<string | null> {
	return new Promise((resolve) => new TextPromptModal(app, title, placeholder, initialValue, selectionEnd, resolve).open());
}

export function confirmAction(app: App, title: string, message: string, button: string, destructive = false): Promise<boolean> {
	return new Promise((resolve) => new ConfirmModal(app, title, message, button, destructive, resolve).open());
}

export function promptChoice(app: App, title: string, label: string, options: readonly string[]): Promise<string | null> {
	return new Promise((resolve) => new ChoicePromptModal(app, title, label, options, resolve).open());
}

class TextPromptModal extends Modal {
	private settled = false;
	private readonly titleId = `traverse-dialog-title-${nextDialogId++}`;

	constructor(
		app: App,
		private titleText: string,
		private placeholder: string,
		private initialValue: string,
		private selectionEnd: number | undefined,
		private done: (value: string | null) => void,
	) {
		super(app);
	}

	onOpen(): void {
		this.modalEl.addClass("traverse-dialog");
		this.setTitle(this.titleText);
		this.titleEl.id = this.titleId;
		const form = this.contentEl.createEl("form", { cls: "traverse-dialog-form" });
		const input = form.createEl("input", {
			cls: "traverse-dialog-input",
			type: "text",
			value: this.initialValue,
			placeholder: this.placeholder,
			attr: { "aria-labelledby": this.titleId, autocomplete: "off", spellcheck: "false" },
		});
		const actions = form.createDiv({ cls: "traverse-dialog-actions" });
		const cancel = actions.createEl("button", { text: "Cancel", type: "button" });
		actions.createEl("button", { cls: "mod-cta", text: "Confirm", type: "submit" });
		cancel.addEventListener("click", () => this.finish(null));
		input.addEventListener("keydown", (event) => {
			if (event.key !== "Enter" || event.isComposing) return;
			event.preventDefault();
			this.finish(input.value.trim() || null);
		});
		form.addEventListener("submit", (event) => {
			event.preventDefault();
			this.finish(input.value.trim() || null);
		});
		const win = this.modalEl.ownerDocument.defaultView ?? window;
		win.requestAnimationFrame(() => {
			input.focus();
			input.setSelectionRange(0, this.selectionEnd ?? input.value.length);
		});
	}

	onClose(): void {
		this.contentEl.empty();
		if (!this.settled) this.done(null);
	}

	private finish(value: string | null): void {
		if (this.settled) return;
		this.settled = true;
		this.done(value);
		this.close();
	}
}

class ChoicePromptModal extends Modal {
	private settled = false;
	private readonly titleId = `traverse-dialog-title-${nextDialogId++}`;
	private readonly labelId = `traverse-dialog-label-${nextDialogId++}`;

	constructor(
		app: App,
		private titleText: string,
		private labelText: string,
		private options: readonly string[],
		private done: (value: string | null) => void,
	) {
		super(app);
	}

	onOpen(): void {
		this.modalEl.addClass("traverse-dialog");
		this.setTitle(this.titleText);
		this.titleEl.id = this.titleId;
		const form = this.contentEl.createEl("form", { cls: "traverse-dialog-form" });
		form.createEl("label", { cls: "traverse-dialog-label", text: this.labelText, attr: { id: this.labelId } });
		const select = form.createEl("select", { cls: "traverse-dialog-select", attr: { "aria-labelledby": `${this.titleId} ${this.labelId}` } });
		for (const option of this.options) select.createEl("option", { text: `.${option}`, value: option });
		const actions = form.createDiv({ cls: "traverse-dialog-actions" });
		const cancel = actions.createEl("button", { text: "Cancel", type: "button" });
		actions.createEl("button", { cls: "mod-cta", text: "Create", type: "submit" });
		cancel.addEventListener("click", () => this.finish(null));
		form.addEventListener("submit", (event) => {
			event.preventDefault();
			this.finish(select.value || null);
		});
		(this.modalEl.ownerDocument.defaultView ?? window).requestAnimationFrame(() => select.focus());
	}

	onClose(): void {
		this.contentEl.empty();
		if (!this.settled) this.done(null);
	}

	private finish(value: string | null): void {
		if (this.settled) return;
		this.settled = true;
		this.done(value);
		this.close();
	}
}

class ConfirmModal extends Modal {
	private settled = false;

	constructor(
		app: App,
		private titleText: string,
		private message: string,
		private buttonText: string,
		private destructive: boolean,
		private done: (value: boolean) => void,
	) {
		super(app);
	}

	onOpen(): void {
		this.modalEl.addClass("traverse-dialog");
		this.setTitle(this.titleText);
		const form = this.contentEl.createEl("form", { cls: "traverse-dialog-form" });
		form.createEl("p", { cls: "traverse-dialog-message", text: this.message });
		const actions = form.createDiv({ cls: "traverse-dialog-actions" });
		const cancel = actions.createEl("button", { text: "Cancel", type: "button" });
		const confirm = actions.createEl("button", { cls: this.destructive ? "mod-warning" : "mod-cta", text: this.buttonText, type: "submit" });
		cancel.addEventListener("click", () => this.finish(false));
		form.addEventListener("submit", (event) => {
			event.preventDefault();
			this.finish(true);
		});
		const win = this.modalEl.ownerDocument.defaultView ?? window;
		win.requestAnimationFrame(() => confirm.focus());
	}

	onClose(): void {
		this.contentEl.empty();
		if (!this.settled) this.done(false);
	}

	private finish(value: boolean): void {
		if (this.settled) return;
		this.settled = true;
		this.done(value);
		this.close();
	}
}
