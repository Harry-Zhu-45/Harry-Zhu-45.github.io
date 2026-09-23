// @ts-check

import mdx from '@astrojs/mdx';
import sitemap from '@astrojs/sitemap';
import expressiveCode from 'astro-expressive-code';
import { defineConfig } from 'astro/config';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';

// https://astro.build/config
export default defineConfig({
	site: 'https://Harry-Zhu-45.github.io',
	trailingSlash: 'always',
	// 必须 'directory'：产出 /foo/index.html 而不是 /foo.html，
	// 与旧 Hexo 站的 /YYYY/MM/DD/<slug>/ URL 形态保持一致
	build: { format: 'directory' },
	integrations: [
		expressiveCode({
			themes: ['github-light', 'github-dark'],
			// 关掉 prefers-color-scheme 媒体查询：本站在 <head> 内联脚本里
			// 把最终主题写进 <html data-theme>，由它统一裁决
			useDarkModeMediaQuery: false,
			// 默认按主题名匹配（[data-theme='github-dark']），
			// 改为按明暗类型匹配，对齐本站的 data-theme="dark|light"
			themeCssSelector: (theme) => `[data-theme='${theme.type}']`,
		}),
		mdx(),
		sitemap(),
	],
	markdown: {
		remarkPlugins: [remarkMath],
		rehypePlugins: [rehypeKatex],
		// 站内有一个 ```mathematica 代码块；Shiki 无此语言名，别名到 wolfram
		shikiConfig: { langAlias: { mathematica: 'wolfram' } },
	},
});
