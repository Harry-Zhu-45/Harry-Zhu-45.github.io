import type {
	ExpressiveCodeConfig,
	LicenseConfig,
	NavBarConfig,
	ProfileConfig,
	SiteConfig,
} from './types/config';
import { LinkPreset } from './types/config';

export const siteConfig: SiteConfig = {
	title: "HarryZ's Blog",
	subtitle: '好好学习，天天向上！',
	lang: 'zh_CN',
	themeColor: { hue: 250, fixed: false },
	banner: {
		enable: false,
		src: '/img/head.png',
		position: 'center',
		credit: { enable: false, text: '', url: '' },
	},
	toc: { enable: true, depth: 2 },
	favicon: [{ src: '/favicon.svg' }],
};

export const navBarConfig: NavBarConfig = {
	links: [
		LinkPreset.Home,
		LinkPreset.Archive,
		{ name: '友链', url: '/link/' },
		{ name: 'GitHub', url: 'https://github.com/Harry-Zhu-45', external: true },
	],
};

export const profileConfig: ProfileConfig = {
	avatar: '/img/head.png',
	name: 'Harry Zhu',
	bio: '物理 · 数学 · 计算机',
	links: [
		{ name: 'GitHub', icon: 'fa6-brands:github', url: 'https://github.com/Harry-Zhu-45' },
		{ name: 'Email', icon: 'fa6-regular:envelope', url: 'mailto:hathbe245@163.com' },
	],
};

export const licenseConfig: LicenseConfig = {
	enable: false,
	name: 'CC BY-NC-SA 4.0',
	url: 'https://creativecommons.org/licenses/by-nc-sa/4.0/',
};

export const expressiveCodeConfig: ExpressiveCodeConfig = {
	theme: 'github-dark',
};
