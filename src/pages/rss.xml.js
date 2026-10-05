import rss from '@astrojs/rss';
import { render } from 'astro:content';
import { siteConfig } from '@/config';
import { getSortedPosts } from '@utils/content-utils';
import { getPostUrlBySlug } from '@utils/url-utils';

export async function GET(context) {
	const posts = await getSortedPosts();
	const items = await Promise.all(posts.map(async (post) => {
		const { remarkPluginFrontmatter } = await render(post);
		return {
			title: post.data.title,
			pubDate: post.data.pubDate,
			description: post.data.description || remarkPluginFrontmatter.excerpt || post.data.title,
			link: getPostUrlBySlug(post.id, post.data.pubDate),
		};
	}));
	return rss({
		title: siteConfig.title,
		description: siteConfig.subtitle,
		site: context.site ?? 'https://harry-zhu-45.github.io',
		items,
		customData: `<language>${siteConfig.lang}</language>`,
	});
}
