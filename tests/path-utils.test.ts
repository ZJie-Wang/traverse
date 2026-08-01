import assert from "node:assert/strict";
import test from "node:test";
import { isListingMutationPathRelevant, isPathWithinFolder, vaultParentPath, visibleSelectedPaths } from "../src/path-utils.ts";

test("vaultParentPath handles root and nested paths", () => {
	assert.equal(vaultParentPath("Note.md"), "/");
	assert.equal(vaultParentPath("Notes/Note.md"), "Notes");
	assert.equal(vaultParentPath("Notes/Child/Note.md"), "Notes/Child");
});

test("isPathWithinFolder handles the vault root and segment boundaries", () => {
	assert.equal(isPathWithinFolder("Notes/Note.md", "/"), true);
	assert.equal(isPathWithinFolder("Notes/Note.md", "Notes"), true);
	assert.equal(isPathWithinFolder("Notes2/Note.md", "Notes"), false);
});

test("listing mutations include direct entries and direct-child folder notes", () => {
	assert.equal(isListingMutationPathRelevant("Notes", "Notes/Note.md"), true);
	assert.equal(isListingMutationPathRelevant("Notes", "Notes/Child/Child.md"), true);
	assert.equal(isListingMutationPathRelevant("Notes", "Notes/Child/Deep/Note.md"), false);
});

test("listing mutations include the current folder and its ancestors", () => {
	assert.equal(isListingMutationPathRelevant("Notes/Child", "Notes/Child"), true);
	assert.equal(isListingMutationPathRelevant("Notes/Child", "Notes"), true);
	assert.equal(isListingMutationPathRelevant("Notes/Child", "Elsewhere/File.md"), false);
});

test("root listing includes direct entries and child folder notes", () => {
	assert.equal(isListingMutationPathRelevant("/", "PLAN.md"), true);
	assert.equal(isListingMutationPathRelevant("/", "Bookshelf/Bookshelf.md"), true);
	assert.equal(isListingMutationPathRelevant("/", "Bookshelf/Deep/Note.md"), false);
});

test("hidden selections cannot survive result filtering", () => {
	assert.deepEqual(visibleSelectedPaths(["Notes/A.md", "Notes/B.md"], ["Notes/B.md", "Notes/C.md"]), ["Notes/B.md"]);
	assert.deepEqual(visibleSelectedPaths(["Notes/A.md"], []), []);
});
