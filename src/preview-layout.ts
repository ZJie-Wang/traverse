export const PREVIEW_SIZE_MIN = 40;
export const PREVIEW_SIZE_MAX = 100;
export const PREVIEW_SIZE_DEFAULT = 95;
export const PREVIEW_ASPECT_MIN = 0.5;
export const PREVIEW_ASPECT_MAX = 1.5;
export const PREVIEW_ASPECT_DEFAULT = 0.8;

export interface PreviewCardDimensions {
	width: number;
	height: number;
}

export function previewCardDimensions(containerWidth: number, containerHeight: number, scalePercent: number, aspectRatio: number): PreviewCardDimensions {
	const width = Math.max(0, containerWidth);
	const height = Math.max(0, containerHeight);
	const scale = clamp(scalePercent, PREVIEW_SIZE_MIN, PREVIEW_SIZE_MAX, PREVIEW_SIZE_DEFAULT) / 100;
	const ratio = clamp(aspectRatio, PREVIEW_ASPECT_MIN, PREVIEW_ASPECT_MAX, PREVIEW_ASPECT_DEFAULT);
	const maximumWidth = Math.min(width, height * ratio);
	const maximumHeight = maximumWidth / ratio;
	return { width: maximumWidth * scale, height: maximumHeight * scale };
}

function clamp(value: number, minimum: number, maximum: number, fallback: number): number {
	return Math.max(minimum, Math.min(maximum, Number.isFinite(value) ? value : fallback));
}
