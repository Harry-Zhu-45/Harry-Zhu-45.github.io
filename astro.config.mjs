// @ts-check

import { globSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import sitemap from '@astrojs/sitemap';
import svelte from '@astrojs/svelte';
import tailwind from '@astrojs/tailwind';
import { pluginCollapsibleSections } from '@expressive-code/plugin-collapsible-sections';
import { pluginLineNumbers } from '@expressive-code/plugin-line-numbers';
import swup from '@swup/astro';
import expressiveCode from 'astro-expressive-code';
import icon from 'astro-icon';
import { defineConfig } from 'astro/config';
import rehypeAutolinkHeadings from 'rehype-autolink-headings';
import rehypeComponents from 'rehype-components';
import rehypeKatex from 'rehype-katex';
import rehypeSlug from 'rehype-slug';
import remarkDirective from 'remark-directive';
import remarkGithubAdmonitionsToDirectives from 'remark-github-admonitions-to-directives';
import remarkMath from 'remark-math';
import remarkSectionize from 'remark-sectionize';
import { parse } from 'yaml';
import { expressiveCodeConfig } from './src/config.ts';
import { pluginLanguageBadge } from './src/plugins/expressive-code/language-badge.ts';
import { pluginCustomCopyButton } from './src/plugins/expressive-code/custom-copy-button.js';
import { AdmonitionComponent } from './src/plugins/rehype-component-admonition.mjs';
import { GithubCardComponent } from './src/plugins/rehype-component-github-card.mjs';
import { parseDirectiveNode } from './src/plugins/remark-directive-rehype.js';
import { remarkExcerpt } from './src/plugins/remark-excerpt.js';
import { remarkReadingTime } from './src/plugins/remark-reading-time.mjs';

const site = 'https://harry-zhu-45.github.io';
const articleLastmod = new Map();
for (const file of globSync(join(import.meta.dirname, 'src/content/blog/**/*.md'))) {
	const frontmatter = readFileSync(file, 'utf8').match(/^---\r?\n([\s\S]*?)\r?\n---/);
	if (!frontmatter) continue;
	const { slug, pubDate, updatedDate, draft } = parse(frontmatter[1]);
	if (!slug || slug.startsWith('_') || draft) continue;
	const articlePath = `/${pubDate.slice(0, 10).replaceAll('-', '/')}/${slug}/`;
	articleLastmod.set(new URL(articlePath, site).pathname, new Date(updatedDate ?? pubDate).toISOString());
}

export default defineConfig({
	site,
	base: '/',
	trailingSlash: 'always',
	build: { format: 'directory' },
	integrations: [
		tailwind({ nesting: true }),
		swup({
			theme: false,
			animationClass: 'transition-swup-',
			containers: ['main', '#toc'],
			smoothScrolling: true,
			cache: true,
			preload: true,
			accessibility: true,
			updateHead: true,
			updateBodyClass: false,
			globalInstance: true,
		}),
		icon({
			include: {
				'fa6-brands': ['*'],
				'fa6-regular': ['*'],
				'fa6-solid': ['*'],
				'material-symbols': ['*'],
			},
		}),
		expressiveCode({
			themes: ['github-light', 'github-dark'],
			useDarkModeMediaQuery: false,
			themeCssSelector: (theme) =>
				theme.type === 'dark' ? ':root.dark' : ':root:not(.dark)',
			plugins: [
				pluginCollapsibleSections(),
				pluginLineNumbers(),
				pluginLanguageBadge(),
				pluginCustomCopyButton(),
			],
			defaultProps: {
				wrap: true,
				overridesByLang: { shellsession: { showLineNumbers: false } },
			},
			styleOverrides: {
				codeBackground: 'var(--codeblock-bg)',
				borderRadius: '0.75rem',
				borderColor: 'transparent',
				codeFontSize: '0.875rem',
				codeFontFamily: "'JetBrains Mono Variable', ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace",
				codeLineHeight: '1.5rem',
				frames: {
					editorBackground: 'var(--codeblock-bg)',
					terminalBackground: 'var(--codeblock-bg)',
					terminalTitlebarBackground: 'var(--codeblock-topbar-bg)',
					editorTabBarBackground: 'var(--codeblock-topbar-bg)',
					editorActiveTabBackground: 'none',
					editorActiveTabIndicatorBottomColor: 'var(--primary)',
					editorActiveTabIndicatorTopColor: 'none',
					editorTabBarBorderBottomColor: 'var(--codeblock-topbar-bg)',
					terminalTitlebarBorderBottomColor: 'none',
				},
				textMarkers: { delHue: 0, insHue: 180, markHue: 250 },
			},
			frames: { showCopyToClipboardButton: false },
		}),
		svelte(),
		sitemap({
			serialize(item) {
				const lastmod = articleLastmod.get(new URL(item.url).pathname);
				if (lastmod) item.lastmod = lastmod;
				return item;
			},
		}),
	],
	markdown: {
		remarkPlugins: [
			remarkMath,
			remarkReadingTime,
			remarkExcerpt,
			remarkGithubAdmonitionsToDirectives,
			remarkDirective,
			remarkSectionize,
			parseDirectiveNode,
		],
		rehypePlugins: [
			rehypeKatex,
			rehypeSlug,
			[
				rehypeComponents,
				{
					components: {
						github: GithubCardComponent,
						note: (node, file) => AdmonitionComponent(node, file, 'note'),
						tip: (node, file) => AdmonitionComponent(node, file, 'tip'),
						important: (node, file) => AdmonitionComponent(node, file, 'important'),
						caution: (node, file) => AdmonitionComponent(node, file, 'caution'),
						warning: (node, file) => AdmonitionComponent(node, file, 'warning'),
					},
				},
			],
			[
				rehypeAutolinkHeadings,
				{
					behavior: 'append',
					properties: { className: ['anchor'] },
					content: {
						type: 'element',
						tagName: 'span',
						properties: { className: ['anchor-icon'], 'data-pagefind-ignore': true },
						children: [{ type: 'text', value: '#' }],
					},
				},
			],
		],
		shikiConfig: { langAlias: { mathematica: 'wolfram' } },
	},
});
