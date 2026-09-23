import rss from '@astrojs/rss';
import { siteConfig } from '@/config';
import { getSortedPosts } from '@utils/content-utils';
import { getPostUrlBySlug } from '@utils/url-utils';

export async function GET(context) {
	const posts = await getSortedPosts();
	return rss({
		title: siteConfig.title,
		description: siteConfig.subtitle,
		site: context.site ?? 'https://Harry-Zhu-45.github.io',
		items: posts.map((post) => ({
			title: post.data.title,
			pubDate: post.data.pubDate,
			description: post.data.description,
			link: getPostUrlBySlug(post.id, post.data.pubDate),
		})),
		customData: `<language>${siteConfig.lang}</language>`,
	});
}
