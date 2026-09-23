import { getCollection } from 'astro:content';
import rss from '@astrojs/rss';
import { SITE_DESCRIPTION, SITE_TITLE } from '../consts';

export async function GET(context) {
	const posts = await getCollection('blog');
	return rss({
		title: SITE_TITLE,
		description: SITE_DESCRIPTION,
		site: context.site,
		items: posts.map((post) => ({
			...post.data,
			link: `/${String(post.data.pubDate.getUTCFullYear())}/${String(post.data.pubDate.getUTCMonth() + 1).padStart(2, '0')}/${String(post.data.pubDate.getUTCDate()).padStart(2, '0')}/${post.id}/`,
		})),
	});
}
