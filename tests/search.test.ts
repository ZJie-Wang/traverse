import assert from "node:assert/strict";
import test from "node:test";
import PinyinMatch from "pinyin-match";
import { canUsePinyin, hasHanText, searchItems } from "../src/search.ts";
import type { FuzzyMatcher, SearchableItem } from "../src/search.ts";

function item(label: string, path = label): SearchableItem {
	return { label, primary: { name: label, path } };
}

function prepareSubsequence(query: string): FuzzyMatcher {
	return (text) => {
		const matches: [number, number][] = [];
		let from = 0;
		for (const character of query) {
			const index = text.indexOf(character, from);
			if (index < 0) return null;
			matches.push([index, index + 1]);
			from = index + 1;
		}
		return { matches };
	};
}

const pinyinMatch = (text: string, query: string): [number, number] | false => PinyinMatch.match(text, query);

test("search ranks exact, prefix, and compact fuzzy filename matches", () => {
	const items = [item("A-l-p-h-a archive"), item("Alphabet"), item("Alpha")];
	assert.deepEqual(searchItems(items, "alpha", prepareSubsequence).map(({ label }) => label), [
		"Alpha",
		"Alphabet",
		"A-l-p-h-a archive",
	]);
});

test("directory filtering searches names without leaking matches from parent paths", () => {
	const candidate = item("Report.md", "Projects/Chinese/Report.md");
	assert.deepEqual(searchItems([candidate], "Chinese", prepareSubsequence, null, 200, false), []);
	assert.deepEqual(searchItems([candidate], "Chinese", prepareSubsequence, null, 200, true), [candidate]);
});

test("pinyin search supports full pinyin, initials, and polyphonic characters", () => {
	const items = [item("重庆计划.md"), item("Notes.md")];
	assert.equal(searchItems(items, "chongqing", prepareSubsequence, pinyinMatch)[0]?.label, "重庆计划.md");
	assert.equal(searchItems(items, "cqjh", prepareSubsequence, pinyinMatch)[0]?.label, "重庆计划.md");
	assert.equal(searchItems(items, "zq", prepareSubsequence, pinyinMatch)[0]?.label, "重庆计划.md");
	assert.equal(searchItems([item("2025重庆计划.md")], "2025cq", prepareSubsequence, pinyinMatch)[0]?.label, "2025重庆计划.md");
});

test("vault search can match a pinyin parent path and bound rendered results", () => {
	const candidates = [
		item("Report.md", "知识库/Report.md"),
		item("Another.md", "知识库/Another.md"),
	];
	assert.deepEqual(searchItems(candidates, "zhishiku", prepareSubsequence, pinyinMatch, 1, true), [candidates[0]]);
});

test("pinyin detection is limited to useful queries and Han candidates", () => {
	assert.equal(canUsePinyin("cqjh"), true);
	assert.equal(canUsePinyin("lüe"), true);
	assert.equal(canUsePinyin("重庆"), false);
	assert.equal(canUsePinyin("plan-1"), true);
	assert.equal(canUsePinyin("2025"), false);
	assert.equal(hasHanText(item("重庆.md")), true);
	assert.equal(hasHanText(item("Notes.md")), false);
});
