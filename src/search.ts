export interface SearchableItem {
	label: string;
	primary: { name: string; path: string };
	note?: { name: string } | null;
}

export interface FuzzyMatch {
	matches: readonly (readonly [number, number])[];
}

export type FuzzyMatcher = (text: string) => FuzzyMatch | null;
export type PinyinMatcher = (text: string, query: string) => [number, number] | false;

interface RankedItem<T> {
	item: T;
	order: readonly number[];
	originalIndex: number;
}

const HAN_PATTERN = /[\u3400-\u9fff\uf900-\ufaff]/u;
const LATIN_QUERY_PATTERN = /[a-z]/iu;

export function searchItems<T extends SearchableItem>(
	items: readonly T[],
	rawQuery: string,
	prepareFuzzy: (query: string) => FuzzyMatcher,
	pinyinMatch: PinyinMatcher | null = null,
	limit = Number.POSITIVE_INFINITY,
	includePath = true,
): T[] {
	const query = normalize(rawQuery);
	if (!query) return items.slice(0, limit);
	const fuzzy = prepareFuzzy(query);
	const usePinyin = pinyinMatch !== null && canUsePinyin(query);
	const ranked: RankedItem<T>[] = [];

	items.forEach((item, originalIndex) => {
		const order = rankItem(item, query, fuzzy, usePinyin ? pinyinMatch : null, includePath);
		if (order) ranked.push({ item, order, originalIndex });
	});

	ranked.sort(compareRankedItems);
	return ranked.slice(0, limit).map(({ item }) => item);
}

export function canUsePinyin(rawQuery: string): boolean {
	return LATIN_QUERY_PATTERN.test(rawQuery.trim());
}

export function hasHanText(item: SearchableItem): boolean {
	return HAN_PATTERN.test(`${item.label}\n${item.primary.name}\n${item.note?.name ?? ""}\n${item.primary.path}`);
}

function rankItem(item: SearchableItem, query: string, fuzzy: FuzzyMatcher, pinyinMatch: PinyinMatcher | null, includePath: boolean): readonly number[] | null {
	const names = unique([item.label, item.primary.name, item.note?.name].filter((value): value is string => Boolean(value)));
	let best: readonly number[] | null = null;
	for (const name of names) {
		const normalized = normalize(name);
		if (normalized === query) best = better(best, [0, name.length]);
		else if (normalized.startsWith(query)) best = better(best, [1, name.length]);
		const match = fuzzy(normalized);
		if (match) best = better(best, [2, ...matchQuality(match, normalized.length)]);
		if (pinyinMatch && HAN_PATTERN.test(name)) {
			const pinyin = pinyinMatch(name, query);
			if (pinyin) best = better(best, [3, pinyin[0], pinyin[1] - pinyin[0], name.length]);
		}
	}

	if (includePath) {
		const path = normalize(item.primary.path);
		const pathMatch = fuzzy(path);
		if (pathMatch) best = better(best, [4, ...matchQuality(pathMatch, path.length)]);
		if (pinyinMatch && HAN_PATTERN.test(item.primary.path)) {
			const pinyin = pinyinMatch(item.primary.path, query);
			if (pinyin) best = better(best, [5, pinyin[0], pinyin[1] - pinyin[0], path.length]);
		}
	}
	return best;
}

function matchQuality(match: FuzzyMatch, textLength: number): readonly number[] {
	if (!match.matches.length) return [textLength, textLength, textLength];
	const start = match.matches[0][0];
	const end = match.matches[match.matches.length - 1][1];
	let matchedLength = 0;
	for (const [from, to] of match.matches) matchedLength += Math.max(0, to - from);
	return [Math.max(0, end - start - matchedLength), start, textLength];
}

function compareRankedItems<T>(left: RankedItem<T>, right: RankedItem<T>): number {
	const length = Math.max(left.order.length, right.order.length);
	for (let index = 0; index < length; index++) {
		const difference = (left.order[index] ?? 0) - (right.order[index] ?? 0);
		if (difference !== 0) return difference;
	}
	return left.originalIndex - right.originalIndex;
}

function better(current: readonly number[] | null, candidate: readonly number[]): readonly number[] {
	if (!current) return candidate;
	const length = Math.max(current.length, candidate.length);
	for (let index = 0; index < length; index++) {
		const difference = (candidate[index] ?? 0) - (current[index] ?? 0);
		if (difference < 0) return candidate;
		if (difference > 0) return current;
	}
	return current;
}

function unique(values: readonly string[]): string[] {
	return Array.from(new Set(values));
}

function normalize(value: string): string {
	return value.trim().toLocaleLowerCase();
}
