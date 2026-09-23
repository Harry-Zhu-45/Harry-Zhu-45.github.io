# HarryZ's Blog

个人博客，采用 [Fuwari](https://github.com/saicaca/fuwari) 主题，使用 Astro 构建并部署在 GitHub Pages。文章仍保存在 `src/content/blog/`，主题适配层保留本站 frontmatter 和旧链接结构。

## 本地开发

```bash
npm install
npx astro dev --background
npm run build
npm run preview
```

开发服务器可用 `astro dev status`、`astro dev logs` 和 `astro dev stop` 管理。构建同时生成 Pagefind 搜索索引。

## 文章

文章放在 `src/content/blog/`，使用 Markdown。子目录会保留在 URL 的 slug 里。

```yaml
---
title: 标题
slug: translate/中文文章标题
pubDate: "2024-02-17T21:58:00+08:00"
updatedDate: "2024-02-18T20:07:00+08:00"
categories: [数学]
tags: [拓扑, 维度]
---
```

`slug` 必须显式填写，避免中文文件名被自动改写。日期必须带 `+08:00`，让本机和 CI 构建出相同的日期与文章链接。`src/config.ts` 保存站名、导航、头像、社交链接和主题颜色。临时草稿可用 `draft: true` 标记；以下划线开头的文件不会作为文章发布。

## URL 契约

以下旧地址必须保持不变，改动路由后需与 `urls-baseline.txt` 比较：

```text
/                                  首页
/YYYY/MM/DD/<slug>/                文章
/archives/  /archives/<年>/  /archives/<年>/<月>/
/archives/page/2/                  归档分页
/tags/  /tags/<tag>/               标签
/categories/  /categories/<cat>/   分类
/link/                             友链
/page/2/                           首页分页
```

构建后验证：

```bash
npm run build
find dist -name index.html | sed 's|^dist||; s|index.html$||' | sort > /tmp/new.txt
comm -23 urls-baseline.txt /tmp/new.txt
```

最后一条命令应无输出，表示原有 56 条 URL 均被保留。新增页面允许超出基线，例如 `/categories/未分类/` 用于列出没有设置分类的文章。`astro.config.mjs` 中的 `build.format: 'directory'` 和 `trailingSlash: 'always'` 是这些静态路径的一部分，不要删除。

## 内容渲染

- 数学公式使用 `remark-math` 和 `rehype-katex`，写作 `$...$` 或 `$$...$$`。
- Fuwari 提供代码高亮、明暗主题、文章目录、标签与分类导航和站内搜索。
- 正文中的 HTML iframe 可用于嵌入 PDF；查看器放在 `public/pdfjs/`，PDF 文件放在 `public/pdf/`。

## 部署与主题维护

推送 `main` 分支后，GitHub Actions 会构建并部署到 GitHub Pages。仓库 Pages 来源应设置为 **GitHub Actions**。

Fuwari 源码以 MIT 许可随仓库保留在 `LICENSE-Fuwari`。当前 Astro 版本固定为 `5.13.10`，与上游主题使用的 Astro 集成版本对齐。升级 Astro 或 Fuwari 时，应先在本地构建，再核对上述 URL 清单。

## 从旧站迁移文章

```bash
node scripts/migrate.mjs --force
```

脚本从相邻的旧 Hexo 仓库 `../blog/source/_posts/` 读取 19 篇文章，写入 `src/content/blog/`。它会补上海时区、归一化分类和标签，并写入显式 slug；正文原样复制。
