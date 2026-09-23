# HarryZ's Blog

个人博客，Astro 构建，部署在 GitHub Pages。

从 Hexo + Butterfly 迁移而来。旧站源码保留在 `../blog/`（只作备份，不再维护）。

## 命令

```bash
npm install
npm run dev       # 本地开发 http://localhost:4321
npm run build     # 产出到 dist/
npm run preview   # 预览 dist/
```

## 内容

文章放在 `src/content/blog/`，纯 Markdown。

**子目录会进入 URL。** 例如 `src/content/blog/translate/维度：数学漫步.md`
对应 `/YYYY/MM/DD/translate/维度：数学漫步/`。

frontmatter：

```yaml
---
"title": "标题"
"slug": "translate/维度：数学漫步"   # 必须显式写，= 相对 src/content/blog 的路径去扩展名
"pubDate": "2024-02-17T21:58:00+08:00"
"updatedDate": "2024-02-18T20:07:00+08:00"   # 可选
"categories": ["数学"]
"tags": ["拓扑", "维度"]
---
```

⚠️ **`slug` 不能省。** Astro 的 glob loader 在没有 `slug` 时会对文件名做 slugify
（小写化、丢弃标点），中文文件名会被改写成完全不同的 URL。写死 `slug` 才能保住 URL。

⚠️ **日期必须带 `+08:00`。** 裸时间戳会跟随构建机时区解析，CI 上是 UTC，
可能导致 URL 里的日期偏移一天。

## URL 契约

**这些 URL 与旧 Hexo 站逐字节一致，不可随意改动**（外链已积累多年）：

```
/                                  首页
/YYYY/MM/DD/<slug>/                文章
/archives/                         归档
/archives/<年>/                    按年
/archives/<年>/<月>/               按月
/archives/page/2/                  归档分页
/tags/  /tags/<tag>/               标签
/categories/  /categories/<cat>/   分类
/link/                             友链
/page/2/                           首页分页
```

共 56 条。改动路由后必须回归验证：

```bash
npm run build
find dist -name index.html | sed 's|^dist||; s|index.html$||' | sort > /tmp/new.txt
comm -3 /tmp/urls-baseline.txt /tmp/new.txt   # 应为空
```

关键配置依赖（改错会毁掉全部 URL）：

- `build.format: 'directory'` —— 必须。默认 `'file'` 会产出 `/foo.html`
- `trailingSlash: 'always'`
- frontmatter 的显式 `slug`

## 数学公式

`remark-math` + `rehype-katex`，语法 `$...$` / `$$...$$`。
KaTeX 的 CSS 在 `src/components/BaseHead.astro` 里引入，字体随 Vite 打包进 `_astro/`。

## 代码块

`astro-expressive-code`，明暗双主题。
在 `astro.config.mjs` 里用 `themeCssSelector` 按**主题类型**（dark/light）匹配，
对齐本站 `<html data-theme="dark|light">` —— 默认是按主题名匹配的，不改会失效。

## 明暗模式

`BaseHead.astro` 里有一段 `is:inline` 脚本，在绘制前把最终主题写进
`<html data-theme>`（读 localStorage，无记录则跟随系统），避免闪白。
`global.css` 里 `:root[data-theme='dark']` 覆盖 CSS 变量。切换按钮在 `Header.astro`。

## PDF 内嵌

- `public/pdfjs/` —— pdf.js 官方预构建发行版（v6.3.289），已删 source map
- `public/pdf/` —— PDF 文件本体
- 正文里直接写裸 HTML（Astro 的 Markdown 默认放行）：

```html
<iframe src="/pdfjs/web/viewer.html?file=/pdf/foo.pdf"
        style="width:100%;height:80vh;border:0"></iframe>
```

pdf.js 只跑在 iframe 内部，**不进宿主页面的 JS 预算** —— 没有嵌 PDF 的文章零开销。

升级 pdf.js：从 https://github.com/mozilla/pdf.js/releases 下 `pdfjs-<ver>-dist.zip`，
解压覆盖 `public/pdfjs/{build,web}/`，再删掉其中的 `*.map`。

## 部署

推 `main` 分支 → GitHub Actions 自动构建部署（`.github/workflows/deploy.yml`）。

仓库 Settings → Pages → Source 必须是 **GitHub Actions**。

⚠️ 走 Actions 部署时 GitHub 不跑 Jekyll，所以 `_astro/` 目录安全，**不需要 `.nojekyll`**。
只有退回「Deploy from a branch」模式才需要。

## 从旧站迁移内容

```bash
node scripts/migrate.mjs --force
```

只读 `../blog/source/_posts/`，写入 `src/content/blog/`。
做三件事：`date`→`pubDate`（补 `+08:00`）、`categories`/`tags` 归一为数组、写入显式 `slug`。
正文逐字节原样拷贝。脚本会断言源目录恰好 19 篇。

## Credit

初始模板来自 Astro 官方 blog starter，其样式基于 [Bear Blog](https://github.com/HermanMartinus/bearblog/)。