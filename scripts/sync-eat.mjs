// 从只读源仓库重新打包「今天吃什么」PWA，原子同步到 public/eat/
//
// 用法:
//   node scripts/sync-eat.mjs [--source DIR] [--output DIR] [--check]
//
//   --source  源项目根目录（默认 <repo>/apps/eat）
//             也可用环境变量 EAT_SOURCE 覆盖
//   --output  目标目录（默认 <repo>/public/eat）
//   --check   只生成到临时目录做校验，不写盘
//
// 源项目全程只读：只调用它自己的 tools/prepare_pwa.py。

import {
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	renameSync,
	rmSync,
	statSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_SOURCE = join(repoRoot, 'apps', 'eat');

// prepare_pwa.py 的 COPY_WHITELIST 产物，逐项列出以便漂移时报错
const EXPECTED = [
	'index.html',
	'main.css',
	'index.js',
	'search.js',
	'pwa.css',
	'casefold.js',
	'validation.js',
	'store.js',
	'database.js',
	'pwa-text.js',
	'api-local.js',
	'bootstrap.js',
	'sw.js',
	'manifest.webmanifest',
	'icons/icon-192.png',
	'icons/icon-512.png',
	'icons/icon-maskable-512.png',
	'images/xinsanguo-csm-1920.jpg',
];

const argv = process.argv.slice(2);
const flag = (name) => {
	const i = argv.indexOf(name);
	return i >= 0 ? argv[i + 1] : undefined;
};

const check = argv.includes('--check');
const source = resolve(flag('--source') ?? process.env.EAT_SOURCE ?? DEFAULT_SOURCE);
const publicDir = join(repoRoot, 'public');
const output = resolve(flag('--output') ?? join(publicDir, 'eat'));

function fail(message) {
	throw new Error(message);
}

function walk(root, dir = root, out = []) {
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) walk(root, path, out);
		else out.push(relative(root, path).split(sep).join('/'));
	}
	return out;
}

function main() {
	const generator = join(source, 'tools', 'prepare_pwa.py');
	if (!existsSync(generator)) fail(`找不到生成器: ${generator}`);
	if (existsSync(output) && lstatSync(output).isSymbolicLink()) {
		fail(`拒绝: ${output} 是符号链接`);
	}

	mkdirSync(dirname(output), { recursive: true });
	// 暂存目录与目标同文件系统，替换时可原子 rename
	const staging = mkdtempSync(join(dirname(output), '.eat-staging-'));

	try {
		const result = spawnSync(
			'python3',
			[generator, '--project-root', source, '--output', staging],
			{ cwd: source, stdio: 'inherit' },
		);
		if (result.error) fail(`无法运行 python3: ${result.error.message}`);
		if (result.status !== 0) fail(`生成器失败: ${result.status ?? 1}`);

		const found = walk(staging).sort();
		const missing = EXPECTED.filter((f) => !found.includes(f));
		const extra = found.filter((f) => !EXPECTED.includes(f));
		if (missing.length || extra.length) {
			fail(`产物集合与白名单不一致\n  missing: ${missing.join(', ') || '(无)'}\n  extra: ${extra.join(', ') || '(无)'}`);
		}

		const sensitive = found.filter((f) => /sqlite|backup|^data\//i.test(f));
		if (sensitive.length) fail(`产物含敏感文件: ${sensitive.join(', ')}`);

		if (statSync(join(staging, 'sw.js')).size === 0) fail('sw.js 为空');

		const bytes = found.reduce((n, f) => n + statSync(join(staging, f)).size, 0);
		console.log(`生成 OK: ${found.length} 个文件, ${(bytes / 1024).toFixed(0)} KiB`);

		if (check) {
			console.log('--check: 未写盘');
			return;
		}

		// 替换：先把旧目录挪开，再 rename 暂存目录进来，最后删旧的
		const backup = `${output}.eat-old`;
		rmSync(backup, { recursive: true, force: true });
		if (existsSync(output)) renameSync(output, backup);
		renameSync(staging, output);
		rmSync(backup, { recursive: true, force: true });
		console.log(`同步完成 -> ${output}`);
	} finally {
		rmSync(staging, { recursive: true, force: true });
	}
}

try {
	main();
} catch (error) {
	console.error(error.message);
	process.exitCode = 1;
}
