import assert from "node:assert/strict";
import test from "node:test";
import { PREVIEW_ASPECT_DEFAULT, PREVIEW_SIZE_DEFAULT, previewCardDimensions } from "../src/preview-layout.ts";

test("preview sizing preserves aspect ratio and fits the available pane", () => {
	assert.deepEqual(previewCardDimensions(600, 800, PREVIEW_SIZE_DEFAULT, PREVIEW_ASPECT_DEFAULT), { width: 570, height: 712.5 });
	assert.deepEqual(previewCardDimensions(600, 800, 100, 1.5), { width: 600, height: 400 });
	assert.deepEqual(previewCardDimensions(600, 800, 50, 0.5), { width: 200, height: 400 });
});

test("preview sizing clamps persisted values and falls back to defaults", () => {
	assert.deepEqual(previewCardDimensions(600, 800, 10, 4), { width: 240, height: 160 });
	assert.deepEqual(previewCardDimensions(600, 800, Number.NaN, Number.NaN), { width: 570, height: 712.5 });
});
