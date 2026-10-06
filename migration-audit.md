# 两次迁移核查报告

核查日期：2026-10-06。核查基于当前工作区和 GitHub Pages 线上产物；初次核查提交为 `5b08884`。既有 `tsconfig.json` 修改保留。本文路径及命令均以仓库根目录为基准。

## 当前维护状态

博客内容位于 `src/content/blog/`，吃什么网页版源码、生成器和测试位于 `apps/eat/`，发布产物位于 `public/eat/`。旧数据在 `.local-backups/eat-20261006/` 备份并核验。两次迁移已完成，旧独立项目目录已清理；今后仅维护网页版，旧项目源码归档（含 Python 服务、Android 工程及旧 Git 历史）已删除。

## 需要补齐或决定的内容

### 导航改变

旧导航有 `/tags/` 和 `/categories/`，当前 `navBarConfig.links` 没有这两个入口，首页也没有直接链接到这两个总览页。总览页面和各标签/分类页面仍存在，文章元数据及侧栏仍可访问具体分类/标签。如要保留旧导航能力，应恢复两个入口。

### 吃什么的源码和数据已整理

`public/eat/` 是静态 PWA，不包含原 Python/SQLite 应用。浏览器使用 IndexedDB，与桌面版 SQLite 是两套独立数据；原桌面数据没有自动迁入网站。要迁入原桌面数据，在 `/eat/` 手动导入 `.local-backups/eat-20261006/what-should-we-eat.v2.json`；换域名或从 localhost 搬到 GitHub Pages 也不会自动共享浏览器数据。

同步默认读取 `apps/eat/tools/prepare_pwa.py`。修改源码后运行 `npm --prefix apps/eat test` 和 `npm run sync:eat`，GitHub Pages 构建继续使用提交的 `public/eat/`。迁入后生成的 18 个文件与原发布产物逐字节一致，网页测试和博客构建通过，56 个旧 URL 保留。检查模式临时目录清理和跨文件系统输出问题已修复。

旧源码归档 `original-repository.tar.gz` 已删除；删除前将其中 `data/backups/` 的 6 个历史数据文件提取到备份目录的 `backups/` 并逐字节核验。保留一致性 SQLite 快照和可导入的 v2 JSON：48 个候选菜、20 条历史、6 个别名、31 个标签；此前数据库完整性和 JSON 网页版导入校验通过，无无效或重复条目。数据文件的 SHA256 清单已更新并核验。备份目录已被 Git 忽略，也不在发布目录内。该备份目前仅存本机，建议另存到备份盘。

## 其他小项与核查边界

- 版权区块、网页版源码整理、文档清理及 404 元信息修复已分批纳入本地 Git 提交，尚未部署。
