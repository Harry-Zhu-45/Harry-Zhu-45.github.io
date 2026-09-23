import { getCollection } from "astro:content";
import I18nKey from "@i18n/i18nKey";
import { i18n } from "@i18n/translation";
import { getCategoryUrl, getPostUrlBySlug } from "@utils/url-utils.ts";
import { dateParts, formatDate } from "./date";

// // Retrieve posts and sort them by publication date
async function getRawSortedPosts() {
	const allBlogPosts = await getCollection("blog", ({ id, data }) => {
		return !id.startsWith("_") && (import.meta.env.PROD ? data.draft !== true : true);
	});

	const sorted = allBlogPosts.sort((a, b) => {
		const dateA = a.data.pubDate;
		const dateB = b.data.pubDate;
		return dateA > dateB ? -1 : 1;
	});
	return sorted;
}

export async function getSortedPosts() {
	const sorted = await getRawSortedPosts();

	for (let i = 1; i < sorted.length; i++) {
		sorted[i].data.nextUrl = getPostUrlBySlug(sorted[i - 1].id, sorted[i - 1].data.pubDate);
		sorted[i].data.nextTitle = sorted[i - 1].data.title;
	}
	for (let i = 0; i < sorted.length - 1; i++) {
		sorted[i].data.prevUrl = getPostUrlBySlug(sorted[i + 1].id, sorted[i + 1].data.pubDate);
		sorted[i].data.prevTitle = sorted[i + 1].data.title;
	}

	return sorted;
}
export type PostForList = {
	slug: string;
	data: {
		title: string;
		tags: string[];
		categories: string[];
		year: number;
		date: string;
	};
	url: string;
};
export async function getSortedPostsList(): Promise<PostForList[]> {
	const sortedFullPosts = await getRawSortedPosts();

	return sortedFullPosts.map((post) => ({
		slug: post.id,
		url: getPostUrlBySlug(post.id, post.data.pubDate),
		data: {
			title: post.data.title,
			tags: post.data.tags,
			categories: post.data.categories,
			year: Number(dateParts(post.data.pubDate).year),
			date: formatDate(post.data.pubDate),
		},
	}));
}
export type Tag = {
	name: string;
	count: number;
};

export async function getTagList(): Promise<Tag[]> {
	const allBlogPosts = await getCollection<"blog">("blog", ({ id, data }) => {
		return !id.startsWith("_") && (import.meta.env.PROD ? data.draft !== true : true);
	});

	const countMap: { [key: string]: number } = {};
	allBlogPosts.forEach((post: { data: { tags: string[] } }) => {
		post.data.tags.forEach((tag: string) => {
			if (!countMap[tag]) countMap[tag] = 0;
			countMap[tag]++;
		});
	});

	// sort tags
	const keys: string[] = Object.keys(countMap).sort((a, b) => {
		return a.toLowerCase().localeCompare(b.toLowerCase());
	});

	return keys.map((key) => ({ name: key, count: countMap[key] }));
}

export type Category = {
	name: string;
	count: number;
	url: string;
};

export async function getCategoryList(): Promise<Category[]> {
	const allBlogPosts = await getCollection<"blog">("blog", ({ id, data }) => {
		return !id.startsWith("_") && (import.meta.env.PROD ? data.draft !== true : true);
	});
	const count: { [key: string]: number } = {};
	allBlogPosts.forEach((post) => {
		if (post.data.categories.length === 0) {
			const ucKey = i18n(I18nKey.uncategorized);
			count[ucKey] = count[ucKey] ? count[ucKey] + 1 : 1;
			return;
		}

		for (const category of post.data.categories) {
			const categoryName = category.trim();
			count[categoryName] = count[categoryName] ? count[categoryName] + 1 : 1;
		}
	});

	const lst = Object.keys(count).sort((a, b) => {
		return a.toLowerCase().localeCompare(b.toLowerCase());
	});

	const ret: Category[] = [];
	for (const c of lst) {
		ret.push({
			name: c,
			count: count[c],
			url: getCategoryUrl(c),
		});
	}
	return ret;
}
