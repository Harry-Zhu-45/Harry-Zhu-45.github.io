// 一次性迁移脚本：Hexo → Astro content collections
// 用法：node scripts/migrate.mjs [--force]
//
// 只读  ../blog/source/_posts/**.md
// 写入 src/content/blog/<相同相对路径>.md
//
// 规则：
//   - 正文逐字节原样拷贝，不改写
//   - date → pubDate、updated → updatedDate，补 +08:00 时区
//   - categories（字符串）→ 数组；tags（字符串或列表）→ 数组
//   - slug 不需要生成：Astro glob loader 的 post.id = 相对路径去扩展名，
//     与 Hexo :title 语义一致，保持目录结构即 URL 对齐

import { readdirSync, readFileSync, writeFileSync, mkdirSync, statSync } from 'node:fs';
import { join, dirname, relative, resolve } from 'node:path';
import { parse, stringify } from 'yaml';

const SRC = resolve(import.meta.dirname, '../../blog/source/_posts');
const DEST = resolve(import.meta.dirname, '../src/content/blog');
const FORCE = process.argv.includes('--force');

// ---- 收集源文件 ----
function walk(dir) {
	const out = [];
	for (const name of readdirSync(dir)) {
		const p = join(dir, name);
		if (statSync(p).isDirectory()) out.push(...walk(p));
		else if (name.endsWith('.md')) out.push(p);
	}
	return out;
}

const files = walk(SRC);
console.log(`找到 ${files.length} 篇 Hexo post`);

// 现有 19 篇；数量不符说明源目录被改动，停下防止误迁
if (files.length !== 19) {
	console.error(`预期 19 篇，实际 ${files.length}，中止`);
	process.exit(1);
}

// 已迁移过且未加 --force 则跳过，避免覆盖手工修改
if (!FORCE) {
	const existing = readdirSync(DEST, { recursive: true }).filter((f) => f.endsWith('.md'));
	if (existing.length > 0) {
		console.error(`src/content/blog 已有 ${existing.length} 个文件，--force 覆盖`);
		process.exit(1);
	}
}

// ---- frontmatter 处理 ----
// `2024-02-16 14:50` / `2024-02-16 14:50:15` → `2024-02-16T14:50:00+08:00`
function toShDate(v) {
	if (typeof v === 'string') {
		const m = v.match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/);
		if (m) {
			return `${m[1]}T${m[2]}:${m[3]}:${m[4] ?? '00'}+08:00`;
		}
		// yaml 库可能已把无时区时间戳解析为 Date，转回东八区墙钟
		if (v instanceof Date) return formatShDate(v);
	}
	if (v instanceof Date) return formatShDate(v);
	throw new Error(`无法解析日期: ${JSON.stringify(v)}`);
}

function formatShDate(d) {
	// 用 Asia/Shanghai 墙钟时间格式化（东八区无夏令时，固定 +8）
	const t = new Date(d.getTime() + 8 * 3600_000);
	const pad = (n) => String(n).padStart(2, '0');
	return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(
		t.getUTCDate(),
	)}T${pad(t.getUTCHours())}:${pad(t.getUTCMinutes())}:${pad(t.getUTCSeconds())}+08:00`;
}

function toArray(v) {
	if (v == null) return [];
	if (Array.isArray(v)) return v;
	return [v];
}

const urls = [];

for (const file of files) {
	const rel = relative(SRC, file);
	const raw = readFileSync(file, 'utf8');

	const fmMatch = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
	if (!fmMatch) {
		console.error(`跳过（无 frontmatter）: ${rel}`);
		continue;
	}

	const fm = parse(fmMatch[1]);
	const body = raw.slice(fmMatch[0].length);

	const pubDate = toShDate(fm.date);
	const updatedDate = fm.updated != null ? toShDate(fm.updated) : undefined;

	const out = {
		title: fm.title,
		// slug = Hexo :title（相对 _posts 的路径去扩展名）。
		// glob loader 优先读 frontmatter 的 slug，原样使用不做 slugify，
		// 以此保证 URL 与旧站逐字节一致（中文、括号、全角冒号、空格全保留）。
		slug: rel.replace(/\.md$/, ''),
		pubDate,
		...(updatedDate ? { updatedDate } : {}),
		categories: toArray(fm.categories),
		tags: toArray(fm.tags),
	};

	const front = stringify(out, { lineWidth: 0, defaultStringType: 'QUOTE_DOUBLE' });
	const content = `---\n${front}---\n${body}`;

	const destPath = join(DEST, rel);
	mkdirSync(dirname(destPath), { recursive: true });
	writeFileSync(destPath, content);

	// 打印 URL 对照表（年月日应与旧站 public/ 下的目录一致）
	const m = pubDate.match(/^(\d{4})-(\d{2})-(\d{2})/);
	urls.push(`${rel}  →  /${m[1]}/${m[2]}/${m[3]}/${rel.replace(/\.md$/, '')}/`);
}

console.log(`\n迁移完成 ${urls.length} 篇，URL 对照：`);
for (const u of urls.sort()) console.log(u);
