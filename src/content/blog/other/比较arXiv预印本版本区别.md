---
"title": "比较arXiv预印本版本区别"
"slug": "other/比较arXiv预印本版本区别"
"pubDate": "2026-03-05T15:35:00+08:00"
"updatedDate": "2026-03-05T15:38:00+08:00"
"categories": []
"tags": []
---

## 比较arXiv预印本版本区别

直接在网上搜索大概率会发现一个 github 的项目：[Compare two version of an arXiv preprint with a single command](https://github.com/temken/comparxiv)，这个项目对自己的介绍是

> A wrapper of [**latexdiff**](https://ctan.org/pkg/latexdiff?lang=en) to compare two version of an [arXiv](https://arxiv.org) preprint with a single command.

但是我在使用之后发现不能正常使用，应该是因为这个项目很久没有更新了，`https://github.com/temken/comparxiv/blob/main/setup.py` 中的依赖 `arxiv==1.4.2` 太老了

我发现原来仓库的一个 fork：[roppinhoppin/comparxiv](https://github.com/roppinhoppin/comparxiv) 已经发现并解决了问题，经测试可以正常使用。

如果以后这个 fork 也出现了问题，可以尝试更新依赖中 `arxiv` 的版本。
