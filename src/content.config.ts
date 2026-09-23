import { defineCollection } from 'astro:content';
import { glob } from 'astro/loaders';
import { z } from 'astro/zod';

// Hexo 的 date/updated 无时区（如 `2024-02-16 14:50`）。
// 裸解析会跟随构建机本地时区，本地(UTC+8)与 CI(UTC) 结果不同。
// 全部钉死为东八区，保证 URL 的年月日永远与旧站一致。
// 迁移脚本输出的值形如 "2024-07-04T22:38:00+08:00"（带引号的字符串）。
const shDate = z
	.string()
	.transform((s) => new Date(s.replace(' ', 'T')));

const blog = defineCollection({
	loader: glob({ base: './src/content/blog', pattern: '**/*.md' }),
	schema: z.object({
		title: z.string(),
		// 显式 slug = Hexo 的 :title（相对路径去扩展名），glob loader 会原样采用
		slug: z.string(),
		description: z.string().optional(),
		pubDate: shDate,
		updatedDate: shDate.optional(),
		// Hexo 里 categories 是单个字符串、tags 是字符串或列表，迁移脚本已统一为数组
		categories: z.array(z.string()).default([]),
		tags: z.array(z.string()).default([]),
	}),
});

export const collections = { blog };
