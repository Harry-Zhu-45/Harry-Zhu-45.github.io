---
"title": "从 Orca 到 herdr：worktree 与七层并行"
"slug": "software/从Orca到herdr"
"description": "从「Git worktree 到底是什么」出发，一路查到 SSH 上的多 Agent 并行架构，把「并行」拆成七层，最后换掉了 Orca。"
"pubDate": "2026-10-02T22:00:00+08:00"
"categories": []
"tags":
  - "软件"
  - "AI"
  - "Orca"
---

> 一篇AI总结的探索笔记。起点是一个很具体的问题：「Orca 里的 Git Worktree 到底是什么意思」。中间绕了两个弯：代码不在本地，以及「能不能同时开两个 Claude」。终点是一张从 Git 到进程的七层并行地图，和一次从 Orca 到 herdr 的更换。

## 起因：一个仓库，四个实验，两个 Claude

事情的起点很朴素。我手上同时挂着几条互不相干的线：试一版新算法、优化一段性能、复现一篇文献、修一下分析脚本。

按以前的做法，这四条线很难一起做，做到一半大概率记不清哪些改动属于哪条线。后来听说 Orca 是每个任务一个 worktree，可以让多个 agent 同时干活。听起来正合我意，但我不确定自己是不是真的理解了 worktree。

所以我先问了最基础的那个问题。

## 第一站：worktree 到底是什么

我原以为「多开几个工作区」就是把仓库复制几份，但复制出来的东西是三个互不相关的仓库。后来发现 `git worktree` 是：**同一个仓库，多份工作目录。**

```bash
# 共享同一个 repository 的 Git 数据
git worktree add ../project-a feature-a
git worktree add ../project-b feature-b
```

```text
                shared Git repository
                       │
          ┌────────────┼────────────┐
          │            │            │
       main WT      feature WT    test WT
          │            │            │
       files A       files B      files C
```

于是：

```text
my-project/          -> main
my-project-fix/      -> fix-bug
my-project-exp1/     -> experiment-1
my-project-exp2/     -> experiment-2
```

这四个目录共享同一套 Git objects 和 refs，但各自有独立的 `HEAD`、index 和真实工作文件。也就是说，`my-project-fix/` 里 `git commit` 出来的东西，`my-project/` 立刻就能 `git log` 看到，因为它们本来就是同一个仓库。也因为没有重复的 Git 数据，worktree 比 clone 更适合**频繁创建临时开发环境**。

另一个容易混的点：**worktree 也不是 branch。**

这两个词在日常语境里经常被混着用，但它们根本不在一个维度上：

- **branch** 是逻辑上的一条开发线，存在于 Git 内部（`main`、`feature-a`）；
- **worktree** 是磁盘上真实存在的一个目录，存在于文件系统里。

它们通常是配对使用的：`worktree A -> branch feature-a`，`worktree B -> branch feature-b`。一句话概括就是：

> branch 是这个分支的逻辑身份，worktree 是这个分支在磁盘上实际展开的那套文件。

想清楚这一点之后，Orca 的设计忽然就顺了。它基本可以浓缩成一行：

```text
一个任务 ≈ 一个 worktree ≈ 一个 branch ≈ 一组 agent
```

于是同一个仓库可以同时长成这样：

```text
main
│
├── worktree: test-new-algorithm      -> Codex Agent A
├── worktree: optimize-performance    -> Claude Agent B
├── worktree: reproduce-paper         -> Codex Agent C
└── worktree: fix-analysis-script     -> Agent D
```

每个 agent 操作的其实是**不同的目录**，所以它们可以真的同时编辑 `src/`、跑 `pytest`、改 `pyproject.toml`、`git commit`，谁也不会踩到谁。

Orca 在 worktree 之上还加了一层东西。它替你做的不只是敲一句 `git worktree add`，一个 Orca worktree 同时还挂着一串状态：

```text
Git worktree + branch + agent terminals + editor tabs
          + browser tabs + diff/review 状态 + UI 状态
```

所以在 Orca 的语义里，worktree 更接近一个**独立任务工作区**，生命周期也完整得多：创建 -> 起 agent -> 改代码 -> review diff -> commit -> push -> PR/merge -> 删 worktree。而且删的时候它会处理对应 branch：如果还有未合并的 commit，它会保留并提示 review，而不是把成果直接扔掉。

### 顺手踩到的一个坑

新 worktree 是**干净 checkout**，`.gitignore` 里的东西默认不会跟过来：

```text
.venv/   .env   build/   data/   cache/
```

对科研代码来说这挺要命：一个没有 `.venv`、没有本地配置的新 worktree，agent 一进去就跑不起来。Orca 为此提供了 `Worktree Shared Paths`、`orca.yaml` 里的 `sharedDirectories`，以及 `.worktreeinclude`，用来共享大型依赖目录或者复制本地配置。记住这三个词，后面在服务器上会再遇到它们。

## 第二站：代码根本不在本地

第一站的结论让我很兴奋，直到我意识到一个问题：**我的项目在课题组的 Linux 服务器上。**

一开始我下意识想的是「那就同步到本地再开 worktree 呗」。但这个思路很快就崩了：同步本身就是个持续性的麻烦，而且服务器上有 GPU、有数据、有 `uv`/`micromamba` 环境，本地同步过来也只是个残缺的副本。

真正需要区分的是两件事：

1. **Orca 本身跑在哪台机器上？**
2. **worktree 创建在哪台机器的文件系统上？**

想通之后答案其实很直接：**让 Orca 在服务器上创建和管理 worktree。**

```text
Windows 本地
└── Orca GUI
      │  SSH
      ▼
Linux 服务器
├── /home/mzhu/project/            # 原始 Git repo
├── /home/mzhu/.../worktree-A/     # Orca 创建
├── /home/mzhu/.../worktree-B/
└── /home/mzhu/.../worktree-C/
      │
      ├── codex / claude / ai-cli
      ├── python
      └── uv / micromamba
```

Orca 的编辑器、Diff、控制界面留在 Windows 上，但**文件、Git worktree、agent 进程全部在服务器上**。被 agent 修改的文件从来没有离开过服务器。

### 配置方式

在 Windows 版 Orca 里打开 **Settings → SSH → Add Target**：

```text
Host: server.example.edu
User: mzhu
Port: 22
Identity file: C:\Users\<用户名>\.ssh\id_ed25519
```

Orca 也能直接读你已有的 `~/.ssh/config`，包括 `Include`、jump host / proxy 这些。如果你平时就是 `ssh myserver`，而 `C:\Users\mzhu\.ssh\config` 里有：

```sshconfig
Host myserver
    HostName 123.45.67.89
    User mzhu
    IdentityFile ~/.ssh/id_ed25519
```

那么 Orca 里基本直接选 `myserver` 就行，点 **Test** 确认连通。

加项目的时候注意别选 `Local`，选 `SSH → myserver`，然后指到服务器目录：

```text
/home/mzhu/projects/my-project
```

这里有个细节值得记下来：普通远程文件夹也能打开，但**worktree 功能要求它本身是 Git repository**。

于是创建 worktree 时，真正发生的事是在服务器上：

```text
服务器
my-project/
    main
worktrees/
├── feature-a/          -> branch: feature-a
├── feature-b/          -> branch: feature-b
└── feature-c/          -> branch: feature-c
```

而不是在 `C:\...` 下。Agent 也一样，SSH worktree 里的 terminal 调用的 `codex`、`claude`、`python`、`uv`、`micromamba` 全是服务器上那一份，跟 Windows 上装没装没关系。

这里还有一个我一开始想绕、后来发现完全没必要的弯：`Windows Orca -> WSL -> SSH -> Server`。既然项目本来就在服务器上，直接 `Windows Orca -> SSH -> Linux Server` 干净得多。

不过这里有个我一开始没算到的门槛：**服务器端得先把东西装齐。** SSH 连得上不等于能用，worktree 里要跑的 agent CLI、`python`、`uv`/`micromamba` 环境，都得在服务器上一个个装好、配好。如果服务器权限受限，或者你只是临时想试一下，这个前置成本可能比想象中高，甚至高到不值得。这一段我一开始讲得太轻巧了。

### 数据目录绝对不能复制

这是我在这一步最警惕的地方。假设仓库长这样：

```text
project/
├── src/
├── scripts/
├── data/             # 500 GB
├── trajectories/     # 2 TB
└── results/
```

如果 worktree 各复制一份，那三个 worktree 就是 6 TB。好在 Git worktree 只 checkout **Git tracked 文件**，所以只要一开始就把代码和数据分开：

```text
/home/mzhu/project/          # 代码，进 Git
    src/

/data/group/my-datasets/     # 数据，不进 Git
    trajectories/
    datasets/
    simulations/
```

代码里通过 `DATA_ROOT=/data/group/my-datasets` 访问，于是：

```text
worktree-A ─┐
worktree-B ─┼──→ /data/group/my-datasets
worktree-C ─┘
```

几个 agent 共享 TB 级数据，每个 worktree 只复制几十 MB 源码。至于那些 gitignored 的缓存和依赖目录，就交给第一站里记下的 `sharedDirectories` / Worktree Shared Paths。

到这里，我脑子里已经有一套完整的架构了：

```text
Windows
└── Orca
     │ SSH
     ▼
Linux 服务器
├── ~/projects/my-project          # main repo
├── Orca worktree: feature-a        -> Claude / Codex
├── Orca worktree: feature-b        -> Claude / Codex
├── Orca worktree: feature-c        -> Claude / Codex
└── Orca worktree: validation       -> Claude / Codex

共享:  /data/...  ~/.cache/...  micromamba env  uv cache
```

还有一个意外收获：SSH worktree 的远程 terminal session 有恢复机制。笔记本断网或者 Orca 关掉之后，远程 agent session 可以继续存在，重连时 Orca 会尝试恢复 terminal 和 scrollback。对长时间跑的科研任务来说，这一点比想象中重要。

## 第三站：那能同时开两个 Claude 吗

能，而且这本来就是 Orca 常见的用法。最推荐的形态：

```text
repo
├── worktree-A  ->  Claude Code #1
└── worktree-B  ->  Claude Code #2
```

两个 Claude 从同一个 `main` 出发，各走一条 branch。比如让它们解同一个问题但给不同策略：

```text
Claude #1: "尝试从算法复杂度和数据结构方向优化性能"
Claude #2: "保持算法不变，只从 NumPy/Numba/并行化角度优化"
```

跑完之后分别看两个 worktree 的 diff，再决定 cherry-pick 哪个。这种「同题并行比较」是 Orca 官方推荐的 workflow。

### 按角色分工

对科研场景，我更倾向于按角色分工，而不是按数量堆：

```text
研究问题
├── Claude A -> 理论/算法方案 A
├── Claude B -> 理论/算法方案 B
├── Codex A  -> 独立实现 / code review
└── Claude C -> 测试、验证、找反例
```

> Orca 的价值在于让两个 Claude 在**隔离的 worktree 里并行探索**，同时打开两个只是顺带的结果。

## 第四站：把「并行」拆成七层

走到这里我发现，前面所有讨论都挤在「并行」这一个词里，其实它们根本不是一回事。按「谁有独立上下文、谁能改同一份代码、谁负责协调」，能拆成七层：

```text
Level 0   Machine / SSH host
Level 1   Git Worktree            文件 + branch 隔离
Level 2   Agent Session           Claude / Codex 独立上下文
Level 3   Agent Team              多个完整 agent 协作
Level 4   Subagent                临时子任务 worker
Level 5   Parallel Tool Calls     一次并发多个 read / grep / bash
Level 6   OS Process              Python / pytest 进程
```

| 层级 | 典型对象 | 独立上下文 | 文件隔离 | 谁协调 | 适合什么 |
|  |  | : | : |  |  |
| **Worktree** | `method-A`, `method-B` | ✅ | **✅ 强** | 你 / Orca | 不同方案、不同 branch |
| **Agent Session** | Claude #1 / Claude #2 | **✅ 强** | ❌ 同 WT 时共享文件 | 你 | 独立长任务 |
| **Agent Team** | lead + teammates | ✅ 每个 teammate | 通常 ❌ | **Lead Claude** | 多角色协作 |
| **Subagent** | research / debug / test | ✅ 临时/局部 | ❌ | Parent Agent | 快速委派子问题 |
| **Parallel tools** | grep / read / bash / test | ❌ 主要共享父上下文 | ❌ | 模型 | 小粒度加速 |
| **Processes / jobs** | Python / `pytest` | 进程级 | 取决于目录 | shell | 真正计算并行 |

真正值得分清的是 Level 1 到 4 这四层：

- **Worktree** 隔离文件。每个 worktree 一套 branch 和磁盘文件，不同方案各占一个，互不干扰。官方推荐的用法就是同一 prompt 发到 3 个 worktree，跑完比 diff。
- **Agent Session** 隔离上下文，不隔离文件。同一 worktree 里跑两个 Claude，各有各的 conversation 和 context window，但改的是同一批磁盘文件。
- **Agent Team** 是协作。一个 Lead 拆任务、派发、收拢，几个并列的 teammate 各管一块（API / tests / docs），teammate 是长期、完整的协作者。
- **Subagent** 是委派。主 Claude 把局部独立问题甩出去，拿结果回来，不新开 workspace。打个类比：Agent Team ≈ PI + 几个研究生，Subagent ≈ 一个研究生临时派几个 research assistant。

后两层已经不是 AI agent 并行，而是被 agent 调用的并行：**Parallel Tool Calls** 是一个 Claude 同时读多个文件、跑多个 grep；**OS Process** 是它提交一批独立 Python 进程同时跑。这时 AI 并没有那么多个 agent，只是 `1 Claude -> 一次提交 -> N 个进程`，和自己那套并行概念要分开。

## 收尾

对科研场景，好用的是一个**三尺度设计**：

```text
研究路线级  ->  Worktree
复杂任务级  ->  Agent / Agent Team
局部调查级  ->  Subagent
```

如果只记一句话：

> **Worktree 用于「竞争 / 独立路线」；Agent Team 用于「合作」；Subagent 用于「委派」。**

由此推出的两条反直觉结论：

- **不要用 Agent Team 替代 worktree 隔离。** 想让 Claude A 和 Claude B 独立实现同一个算法再比谁更好，就该开两个 worktree，而不是塞进同一个 Team。Team 的成员是协作关系，不是竞争关系。
- **也不要为了并行而并行。** 理论上确实可以做到 `3 worktrees × 每 WT 1 team × 每 team 3 teammates × 每 teammate 若干 subagents`，但这不是越多越好。真正该先回答的问题是：**在哪一层拆任务。**

## 还有点问题

- **服务器端的安装成本。** Remote Worktree 要求服务器上装好一堆 agent CLI 和运行环境，权限受限或者只是临时试用时，这一步很容易劝退。它值不值得，取决于你是不是真的长期在这台服务器上开工，而不是偶尔连上去跑一下。
- **Agent Team 目前默认关闭**，需要手动在设置里开启。它在长任务里的实际稳定性，我还没有体感。
- **额度是共享的。** 多个 Claude session 并行很好看，但 rate limit 是同一个账号的。多账号 hot-swap 能缓解，不能消除。
- **worktree 的数量不是免费的。** 每个都是完整 checkout，仓库一大、依赖一多，磁盘和 `uv`/`micromamba` 环境的复用策略需要专门设计，`sharedDirectories` 能覆盖一部分，但不是全部。
- **`.worktreeinclude` 该包含什么**，其实取决于哪些文件是「环境」、哪些是「状态」。这条线我还没划清楚。

## 后来：换成了 herdr

Orca 我用了一段时间就卸了，劝退我的就是上面那条服务器端的安装成本。我的代码在课题组的服务器上，要让它的 worktree 跑起来，得先把各种 agent CLI 和运行环境装齐。

现在用的是 [herdr](https://herdr.dev)，一个终端里的 workspace 管理器，自己也带 worktree 管理。我平时本来就待在终端里，装完不用再单开一个 GUI。

## 参考资料

- [Git — git worktree](https://git-scm.com/docs/git-worktree)
- [Orca — Worktrees](https://www.onorca.dev/docs/model/worktrees)
- [Orca — Agents & Sessions](https://www.onorca.dev/docs/model/agents-sessions)
- [Orca — SSH](https://www.onorca.dev/docs/ssh)
- [Orca — Remote Worktrees](https://www.onorca.dev/docs/recipes/remote-worktrees)
- [Orca — Parallel Agents](https://www.onorca.dev/docs/recipes/parallel-agents)
- [Orca — Claude Code](https://www.onorca.dev/docs/agents/claude-code)
