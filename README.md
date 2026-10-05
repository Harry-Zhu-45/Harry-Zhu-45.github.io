# HarryZ's Blog

基于 Astro 和 Fuwari 的个人博客，部署在 GitHub Pages。文章位于 `src/content/blog/`。

## 开发

```bash
npm install
npm run dev
npm run build
npm run preview
```

构建会同时生成 Pagefind 搜索索引。项目使用 Astro 5.13.10，开发服务器在终端按 Ctrl+C 停止。

提交前检查可使用 [prek](https://prek.j178.dev/installation/)：

```bash
prek install
prek run --all-files
```

钩子会检查合并冲突标记及新增文件大小（上限 10 MiB）。

## 文章

文章使用 Markdown 和以下 frontmatter：

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

显式 `slug` 和 `+08:00` 时区可保持旧链接及本机、CI 日期一致。`src/config.ts` 保存站点和主题设置。草稿可设 `draft: true`；以下划线开头的文章不会发布。

数学公式使用 `$...$` 或 `$$...$$`。PDF 查看器和文件分别放在 `public/pdfjs/`、`public/pdf/`。

## URL 兼容

修改路由后，确认基线中的 56 条旧地址仍存在：

```bash
npm run build
find dist -name index.html | sed 's|^dist||; s|index.html$||' | sort > /tmp/new.txt
comm -23 urls-baseline.txt /tmp/new.txt
```

最后一条命令应无输出。新增页面可以超出基线。静态 URL 依赖 `build.format: 'directory'` 和 `trailingSlash: 'always'`。

## 部署与迁移

推送 `main` 后，GitHub Actions 部署到 GitHub Pages；Pages 来源需设为 **GitHub Actions**。Fuwari 源码和 MIT 许可保留在 `LICENSE-Fuwari`。

`node scripts/migrate.mjs --force` 从相邻的 Hexo 仓库 `../blog/source/_posts/` 迁移 19 篇文章，复制正文并生成带时区的日期、分类、标签和显式 slug。
