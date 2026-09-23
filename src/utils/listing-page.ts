import { PAGE_SIZE } from "../constants/constants";

export function listingPage<T>(entries: T[], firstPageUrl: string) {
	const lastPage = Math.ceil(entries.length / PAGE_SIZE);
	const basePath = `${firstPageUrl === "/" ? "" : firstPageUrl.replace(/\/$/, "")}/page/`;
	const pageUrl = (page: number) => page === 1 ? firstPageUrl : `${basePath}${page}/`;

	return {
		data: entries.slice(0, PAGE_SIZE),
		currentPage: 1,
		lastPage,
		url: {
			current: firstPageUrl,
			prev: undefined,
			next: lastPage > 1 ? pageUrl(2) : undefined,
		},
	};
}
