# 今天吃什么：网页版源码

静态 PWA，发布路径为 `/eat/`。Python 3 用于生成和测试。本文的路径和命令均以博客仓库根目录为基准。

在博客根目录运行 `npm run sync:eat` 更新 `public/eat/`，再运行 `npm run build`。`npm run sync:eat -- --check` 仅检查 `apps/eat/` 能否生成合法产物，不比较现有发布文件。

`apps/eat/index.html` 是构建模板，保留旧脚本锚点供 `apps/eat/tools/prepare_pwa.py` 替换。运行生成器后才会得到可直接访问的 PWA 页面；无需提供模板中的 `api.js`。`apps/eat/pwa/` 包含 IndexedDB、离线缓存、导入导出及本地 API。

运行 `npm --prefix apps/eat test` 验证生成器、Unicode casefold、UI、数据库和离线缓存。测试产物位于 `apps/eat/dist/pwa/`，不提交。

数据保存在每个浏览器自己的 IndexedDB 中。旧桌面 SQLite 数据需通过 schemaVersion=2 JSON 在目标网站手动导入。迁移恢复备份在博客根目录 `.local-backups/eat-20261006/`，该目录已被 Git 忽略，不属于网站发布内容；建议另存一份到备份盘。
