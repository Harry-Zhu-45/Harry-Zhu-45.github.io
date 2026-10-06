# HarryZ's Blog

基于 Astro 和 Fuwari 的个人博客，部署在 GitHub Pages。文章位于 `src/content/blog/`。本文的路径和命令均以仓库根目录（当前 `pwd`）为基准。

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

## 部署

推送 `main` 后，GitHub Actions 部署到 GitHub Pages；Pages 来源需设为 **GitHub Actions**。Fuwari 源码和 MIT 许可保留在 `LICENSE-Fuwari`。

## 今天吃什么

网页版源码位于 `apps/eat/`，发布产物位于 `public/eat/`。生成和测试需要 Python 3。修改后运行 `npm --prefix apps/eat test` 和 `npm run sync:eat`，再构建博客。详见 [源码维护说明](apps/eat/README.md)。
