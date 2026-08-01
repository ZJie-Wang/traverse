import { TFile, TFolder } from "obsidian";
import type { TAbstractFile } from "obsidian";

const IMAGE = new Set(["avif", "bmp", "gif", "heic", "jpeg", "jpg", "png", "svg", "webp"]);
const AUDIO = new Set(["aac", "flac", "m4a", "mp3", "ogg", "wav"]);
const VIDEO = new Set(["mkv", "mov", "mp4", "ogv", "webm"]);
const CODE = new Set(["c", "cpp", "css", "go", "html", "java", "js", "jsx", "lua", "py", "rb", "rs", "sh", "swift", "ts", "tsx"]);
const ARCHIVE = new Set(["7z", "bz2", "gz", "rar", "tar", "zip"]);
const SHEET = new Set(["csv", "numbers", "ods", "xls", "xlsx"]);
const SLIDES = new Set(["key", "odp", "ppt", "pptx"]);

export function iconFor(file: TAbstractFile): string {
	if (file instanceof TFolder) return "folder";
	if (!(file instanceof TFile)) return "file";
	const extension = file.extension.toLowerCase();
	const name = file.name.toLowerCase();
	if (name.endsWith(".excalidraw.md")) return "pen-tool";
	if (extension === "md" || extension === "txt" || extension === "rtf") return "file-text";
	if (extension === "pdf") return "file-type-2";
	if (extension === "svg") return "pen-tool";
	if (extension === "canvas") return "network";
	if (extension === "base") return "table-2";
	if (extension === "db" || extension === "sqlite") return "database";
	if (extension === "json" || extension === "jsonl") return "braces";
	if (extension === "yaml" || extension === "yml" || extension === "toml") return "file-cog";
	if (IMAGE.has(extension)) return "image";
	if (AUDIO.has(extension)) return "file-audio";
	if (VIDEO.has(extension)) return "file-video";
	if (CODE.has(extension)) return "file-code-2";
	if (ARCHIVE.has(extension)) return "file-archive";
	if (SHEET.has(extension)) return "sheet";
	if (SLIDES.has(extension)) return "presentation";
	return "file";
}
