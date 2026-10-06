#!/usr/bin/env python3
"""把仓库里的静态资源按显式白名单打成一个可以直接上传的纯静态 PWA 目录。

为什么需要这个脚本：桌面版靠 `server.py` 提供静态文件和 JSON API，页面加载的是
`api.js`；PWA 版要把数据层搬进浏览器（IndexedDB），入口要换成 `api-local.js` +
`bootstrap.js` 并注册 Service Worker。两边的文件集合不同，靠手工复制迟早出事：
多复制一个 `data/what-should-we-eat.sqlite3` 或 `backup.py` 就是把真实数据和本机
代码传上公网，少复制一个 JS 就是手机上白屏。所以这里只有一份白名单，每次都按
它产出 `dist/pwa/`，并且在动磁盘之前先把所有转换和校验做完。

三类校验都是「宁可停下来也不要发布半成品」：

- 入口 HTML 的两处锚点各必须恰好命中一次（脚本块、`main.css` 那一行），替换后
  不允许再出现 `api.js`——漏掉的话线上页面会去请求本机才有的 Python 服务。
- `sw.js` 的 `PRECACHE` 列表必须和产物文件集合完全相等。少列一个文件，离线时
  那个请求会穿透到网络，断网直接打不开；多列一个文件，install 阶段的 fetch 会
  404，整个 Service Worker 装不上，连在线访问都没有离线能力。
- 产物里不允许出现 `http(s)://` 的资源引用或 `import()`：静态托管上的页面不许
  依赖 CDN，也不许在运行时去拉别的模块（断网就废，还多一个外部依赖）。

用法：

    python3 tools/prepare_pwa.py [--project-root DIR] [--output DIR] [--zip]

`--project-root` 默认是本文件的上两级目录，`--output` 默认是
`<project_root>/dist/pwa`（相对路径按当前工作目录解析）。输出目录会被清理成只含
白名单产物，所以不要把它指向还需要保留别的东西的目录。
"""

from __future__ import annotations

import argparse
import hashlib
import os
import re
import sys
import zipfile
from pathlib import Path
from typing import Mapping

PROJECT_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_OUTPUT = PROJECT_ROOT / "dist" / "pwa"

ENTRY_HTML = "index.html"

# 显式白名单：只有这里列出的源文件会被复制，键是相对 project_root 的源路径，
# 值是产物里的相对路径（两者不同的话说明要改名，目前一致，保留成两列是为了
# 一眼能看出「源 → 产物」的对应关系）。
#
# 刻意不在这里的东西：api.js（桌面版直连本机 HTTP 服务的实现，PWA 里换成
# api-local.js）、server.py / database.py / backup.py（Python 后端，静态托管上
# 跑不了也没有意义）、tests/、.planning/、tools/、AGENTS.md、README.md
# （开发和规划资料，跟页面运行无关），以及 images/ 下除 1920 派生图以外的母版
# 图（母版 2752 宽只用于再缩图，上传纯属浪费带宽）。
COPY_WHITELIST: tuple[tuple[str, str], ...] = (
    # 页面本体与桌面版共用的实现：index.html 会被改写成 PWA 版入口。
    ("index.html", "index.html"),
    ("main.css", "main.css"),
    ("index.js", "index.js"),
    ("search.js", "search.js"),
    # PWA 运行时：样式、casefold 去重键、校验、IndexedDB 存储与数据层、入口引导。
    ("pwa/pwa.css", "pwa.css"),
    ("pwa/casefold.js", "casefold.js"),
    ("pwa/validation.js", "validation.js"),
    ("pwa/store.js", "store.js"),
    ("pwa/database.js", "database.js"),
    # 手机上"本地服务""SQLite""data/backups"这些说法都是错的，这个文件整组覆盖
    # index.js 的文案表；必须在 index.js 之前加载（index.js 加载时就会读它）。
    ("pwa/pwa-text.js", "pwa-text.js"),
    ("pwa/api-local.js", "api-local.js"),
    ("pwa/bootstrap.js", "bootstrap.js"),
    # Service Worker 与 Web App Manifest：离线能力和「添加到主屏幕」都靠它们。
    ("pwa/sw.js", "sw.js"),
    ("pwa/manifest.webmanifest", "manifest.webmanifest"),
    # 图标与头图派生图：main.css / manifest 里引用，缺一个页面就有可见缺陷。
    ("pwa/icons/icon-192.png", "icons/icon-192.png"),
    ("pwa/icons/icon-512.png", "icons/icon-512.png"),
    ("pwa/icons/icon-maskable-512.png", "icons/icon-maskable-512.png"),
    ("images/xinsanguo-csm-1920.jpg", "images/xinsanguo-csm-1920.jpg"),
)

# 桌面版入口的 script 块（缩进 8 空格）。顺序和缩进都要原样匹配，命中不了一次
# 就说明 index.html 动过、这里的锚点过期了，必须让人来看一眼，不能靠模糊匹配猜。
SCRIPT_BLOCK_OLD = (
    '        <script src="search.js"></script>\n'
    '        <script src="api.js"></script>\n'
    '        <script src="index.js"></script>\n'
)

# PWA 版的加载顺序有依赖：casefold/validation/store/database 都是给 index.js 用的
# 全局对象，必须在 index.js 之前；pwa-text.js 定义 window.AppText，而 index.js
# 在**加载时**就把它合并进文案表，所以也必须排在 index.js 之前（排后面的话手机上
# 会显示"无法连接本地服务""本机 SQLite"这些桌面版说法）；bootstrap.js 负责在
# index.js 初始化完之后注册 Service Worker，必须排最后。
SCRIPT_BLOCK_NEW = (
    '        <script src="search.js"></script>\n'
    '        <script src="casefold.js"></script>\n'
    '        <script src="validation.js"></script>\n'
    '        <script src="store.js"></script>\n'
    '        <script src="database.js"></script>\n'
    '        <script src="pwa-text.js"></script>\n'
    '        <script src="api-local.js"></script>\n'
    '        <script src="index.js"></script>\n'
    '        <script src="bootstrap.js"></script>\n'
)

# 样式表那一行：PWA 额外的样式、manifest、主屏图标和主题色都插在它后面。
STYLESHEET_LINK = (
    '        <link rel="stylesheet" type="text/css" media="screen" href="main.css" />'
)

# 数据备份页那句说明。桌面版说的是 SQLite 文件，可手机上根本找不到那个文件，
# 照着找只会白费工夫，所以这句要一起换掉。
STORAGE_NOTE_OLD = (
    '                    <p class="view-note">数据保存在本机 SQLite 数据库中，'
    '可导出 JSON 文件进行备份或迁移。</p>'
)
STORAGE_NOTE_NEW = (
    '                    <p class="view-note">数据保存在这台手机浏览器里，'
    '可导出 JSON 文件进行备份或迁移。</p>'
)

# theme-color 决定手机浏览器地址栏配色；icon/apple-touch-icon 指向 192 图标，
# 两者都用相对路径，站点放在子路径（GitHub Pages 的项目站点）下也能解析。
HEAD_ADDITIONS = (
    '        <link rel="stylesheet" type="text/css" media="screen" href="pwa.css" />\n'
    '        <link rel="manifest" href="manifest.webmanifest" />\n'
    '        <meta name="theme-color" content="#6b6b33">\n'
    '        <link rel="icon" href="icons/icon-192.png" sizes="192x192" type="image/png">\n'
    '        <link rel="apple-touch-icon" href="icons/icon-192.png">'
)

# 产物里需要按文本检查的扩展名：这三类是浏览器直接解析的页面资源。
TEXT_SUFFIXES = (".js", ".html", ".css")

PRECACHE_BLOCK = re.compile(r"var\s+PRECACHE\s*=\s*\[(.*?)\]\s*;", re.DOTALL)
# 引号两种都接受：这里只关心列表内容，不负责管代码风格。
ARRAY_STRING = re.compile(r"""["']([^"']*)["']""")

# 资源引用必须以 ./ 之外的相对路径或本机路径出现；命中就意味着断网时这一项拿不到。
REMOTE_REFERENCE = re.compile(
    r"""(?:href|src)\s*=\s*["']?(?:https?://|//)|url\(\s*["']?(?:https?://|//)""",
    re.IGNORECASE,
)
DYNAMIC_IMPORT = re.compile(r"\bimport\s*\(")


def _is_within(path: Path, parent: Path) -> bool:
    """判断 path 是否就是 parent 或落在 parent 下面（按已解析的绝对路径比较）。"""
    return path == parent or parent in path.parents


def _assert_safe_output(project_root: Path, output: Path) -> None:
    """拒绝几个会把仓库或真实数据删掉的输出位置。

    清理步骤会删掉输出目录里一切不在白名单里的东西，所以输出目录绝不能是仓库
    本身、仓库的上级，也绝不能落在 `data/` 里——那里是业务数据和备份的唯一副本，
    发布脚本不该往里写任何字节。

    比较用的是「解析掉父级符号链接、但保留最后一段」的路径：`data-link/out`
    这种绕过方式（`data-link` 指向真实的 `data/`）在纯文本比较下看着不在数据目录
    里，落到磁盘上却在。最后一段刻意不解析，否则输出目录自身的链接会被解开，
    `_assert_output_not_symlink()` 就看不到它了。
    """
    resolved = output.parent.resolve() / output.name
    for candidate in {output, resolved}:
        if candidate == project_root:
            raise SystemExit(
                f"输出目录不能是项目根目录本身：{candidate}。"
                "清理步骤会删掉白名单之外的所有文件，等于把整个仓库删掉。"
            )
        if _is_within(project_root, candidate):
            raise SystemExit(
                f"输出目录 {candidate} 是项目根目录 {project_root} 的上级："
                "清理步骤会把整个仓库当成多余文件删掉。"
            )
    data_dir = (project_root / "data").resolve()
    for candidate in {output, resolved}:
        if _is_within(candidate, data_dir):
            raise SystemExit(
                f"输出目录 {candidate} 落在数据目录 {data_dir} 里："
                "那里是真实 SQLite 数据和 data/backups/ 的唯一副本，"
                "发布脚本不会往数据目录写任何东西。请换一个输出目录。"
            )


def _resolve_without_following(path: Path) -> Path:
    """绝对化输出路径，但**不**跟随最后一级符号链接。

    `Path.resolve()` 会把符号链接解开：`--output dist-link`（指向 /srv/site）会被
    悄悄变成 `/srv/site`，后面的「不许跟随符号链接」检查就再也看不到这个链接了，
    清理步骤会去删托管目录里的真实文件。所以这里只做绝对化和纯文本的 `..` 折叠，
    把链接本身留给检查那一步处理。
    """
    return Path(os.path.normpath(path if path.is_absolute() else Path.cwd() / path))


def _assert_output_not_symlink(output: Path) -> None:
    """输出目录自身是符号链接时直接拒绝。

    只查最后一级，不查父级：`os.makedirs` 在父级链接下建目录是文件系统的常规
    行为（macOS 的 `/tmp` 本身就是指向 `/private/tmp` 的链接），拒绝父级链接会
    让正常路径也用不了。真正的危险在输出目录这一级——清理步骤会对着它 scandir
    并删除白名单之外的文件，跟随链接删掉的就是托管目录里的真实文件，而发布的人
    以为删的只是 dist 里的副本。
    """
    if output.is_symlink():
        raise SystemExit(
            f"输出目录 {output} 是一个符号链接（指向 {os.readlink(output)}）："
            "拒绝跟随，否则清理和写入会作用到链接指向的目录，"
            "把那边的东西当成 dist 里的多余文件删掉。"
        )


def _decode_text(rel: str, data: bytes) -> str:
    """按 UTF-8 解码产物文本，失败时报清楚是哪个文件。"""
    try:
        return data.decode("utf-8")
    except UnicodeDecodeError as exc:
        raise SystemExit(
            f"{rel} 不是合法的 UTF-8 文本（{exc}）：页面资源必须是 UTF-8，"
            "否则托管后中文会变成乱码。"
        ) from exc


def _build_entry_html(data: bytes) -> bytes:
    """把桌面版入口 HTML 改写成 PWA 版入口，两处锚点各必须恰好命中一次。

    命中 0 次说明 index.html 改过、锚点过期；命中多次说明同一段结构在文件里出现
    了不止一次，替换哪一处都不确定。两种情况都必须停下：猜错的结果是线上页面
    加载了错误的实现，而且从产物上看不出问题。
    """
    text = _decode_text(ENTRY_HTML, data)

    hits = text.count(SCRIPT_BLOCK_OLD)
    if hits != 1:
        raise SystemExit(
            f"{ENTRY_HTML} 里桌面版的 script 块（search.js + api.js + index.js，"
            f"缩进 8 空格）命中 {hits} 次，期望恰好 1 次：无法确定该把哪一段换成 "
            "PWA 版的加载顺序，请先核对 index.html 的底部脚本块。"
        )
    text = text.replace(SCRIPT_BLOCK_OLD, SCRIPT_BLOCK_NEW)

    hits = text.count(STYLESHEET_LINK)
    if hits != 1:
        raise SystemExit(
            f"{ENTRY_HTML} 里 {STYLESHEET_LINK.strip()!r} 命中 {hits} 次，"
            "期望恰好 1 次：manifest 和主屏图标要插在它后面，"
            "锚点不唯一就无法确定插入位置。"
        )
    text = text.replace(STYLESHEET_LINK, STYLESHEET_LINK + "\n" + HEAD_ADDITIONS)

    hits = text.count(STORAGE_NOTE_OLD)
    if hits != 1:
        raise SystemExit(
            f"{ENTRY_HTML} 里「数据保存在本机 SQLite 数据库中…」那句说明命中 {hits} 次，"
            "期望恰好 1 次：PWA 版的数据在手机浏览器的 IndexedDB 里，"
            "留着这句话会让人去找一个不存在的 SQLite 文件。"
        )
    text = text.replace(STORAGE_NOTE_OLD, STORAGE_NOTE_NEW)

    # 替换完还留着 api.js 就说明脚本块换得不干净（比如页面别处又引了一次）。
    # 这一条比命中次数更硬：PWA 里没有本机 Python 服务，留着它必然 404。
    if "api.js" in text:
        raise SystemExit(
            f"{ENTRY_HTML} 转换后仍然出现 api.js：PWA 里没有本机 Python 服务，"
            "这个引用在静态托管上一定 404，请检查是否还有别处引用了桌面版的数据层。"
        )

    # 同上，这条防的是"锚点换了、别处还留着一句提到 SQLite 的文案"。
    # 手机上根本没有这个文件，用户照着找只会白费工夫。
    if "SQLite" in text:
        raise SystemExit(
            f"{ENTRY_HTML} 转换后仍然提到 SQLite：PWA 版没有 SQLite 文件，"
            "请检查是否还有别处的文案在描述桌面版的存储方式。"
        )

    return text.encode("utf-8")


def _build_products(project_root: Path) -> dict[str, bytes]:
    """在内存里准备好全部产物，一个字节都不写盘。

    先把缺的源文件一次性报全：pwa/ 下的文件由另一条线提供，逐个报错会让人来回
    跑好几趟。任何缺失都在这里停下，输出目录保持原样，不会留下半个 dist。
    """
    missing = [
        source_rel
        for source_rel, _ in COPY_WHITELIST
        if not (project_root / source_rel).is_file()
    ]
    if missing:
        listing = "\n".join(f"  {source_rel}" for source_rel in missing)
        raise SystemExit(
            f"以下源文件不存在或不是普通文件，无法准备发布产物：\n{listing}\n"
            "白名单里的每一项都是页面运行必需的，缺任何一个都不要照常发布"
            "（漏掉 JS 会在手机上白屏，漏掉图标或头图会让页面有可见缺陷）。"
        )

    products: dict[str, bytes] = {}
    for source_rel, output_rel in COPY_WHITELIST:
        data = (project_root / source_rel).read_bytes()
        if output_rel == ENTRY_HTML:
            data = _build_entry_html(data)
        products[output_rel] = data
    _stamp_service_worker_version(products)
    return products


# sw.js 里缓存名的版本占位符。手工维护这个版本号是"用户永远看到旧页面"的
# 经典成因：改了 JS 却忘了把 v1 改成 v2，Service Worker 就认为缓存还是最新的，
# 于是所有人继续拿旧文件，而且没有任何报错。这里改成按产物内容自动算。
CACHE_VERSION_PLACEHOLDER = re.compile(r'__CACHE_VERSION__')


def _stamp_service_worker_version(products: dict[str, bytes]) -> None:
    """把 sw.js 里的 __CACHE_VERSION__ 换成产物内容的指纹。

    指纹覆盖除 sw.js 自身以外的**全部**产物：任何一个页面资源变了，指纹就变，
    缓存名跟着变，新版本才能被真正取到。用 sw.js 自己的内容算指纹是不行的——
    它在写指纹的时候还在变，会自己咬自己。
    """
    if "sw.js" not in products:
        return
    text = _decode_text("sw.js", products["sw.js"])
    if not CACHE_VERSION_PLACEHOLDER.search(text):
        # 没有占位符说明 sw.js 用了别的方式管理版本，不做猜测。
        return

    digest = hashlib.sha256()
    for rel in sorted(products):
        if rel == "sw.js":
            continue
        digest.update(rel.encode("utf-8"))
        digest.update(b"\0")
        digest.update(products[rel])
        digest.update(b"\0")
    version = digest.hexdigest()[:12]

    products["sw.js"] = CACHE_VERSION_PLACEHOLDER.sub(version, text).encode("utf-8")


def _check_precache(products: Mapping[str, bytes], present: set[str], stage: str) -> None:
    """断言 sw.js 的 PRECACHE 列表恰好等于产物文件集合（sw.js 自身除外）。

    这是离线可用性的守门人，两边漂移都会让「离线可用」这个承诺落空：少列一个
    文件，断网时那个请求拿不到，页面直接残缺；多列一个文件，安装阶段会去请求
    一个不存在的地址（用 addAll 的写法整个安装就失败，逐条 add 的宽容写法也会
    留下一条永远失败的重试）。所以只要求两边完全相等，不做「至少包含」这种
    宽松判断——缓存列表和实际产物一旦允许「大致对上」，就再也发现不了真正的漂移。
    """
    if "sw.js" not in products:
        raise SystemExit("产物里没有 sw.js：白名单配置有问题，离线能力无从校验。")
    text = _decode_text("sw.js", products["sw.js"])
    match = PRECACHE_BLOCK.search(text)
    if match is None:
        raise SystemExit(
            "sw.js 里找不到 `var PRECACHE = [ ... ];`：没有这份列表就无法确认"
            "离线缓存覆盖了哪些产物，请先补上（或同步这里的解析规则）。"
        )

    listed: set[str] = set()
    for entry in ARRAY_STRING.findall(match.group(1)):
        if entry == "./":
            # Service Worker 在站点根作用域下用 "./" 指的就是入口 HTML。
            listed.add(ENTRY_HTML)
        elif entry.startswith("./"):
            listed.add(entry[2:])
        else:
            raise SystemExit(
                f"sw.js 的 PRECACHE 条目 {entry!r} 不是 ./ 开头的相对路径："
                "站点可能被放在子路径下（GitHub Pages 的项目站点就是 /<repo>/），"
                "绝对或裸相对路径会指向错误的位置，缓存整体失效。"
            )
    if not listed:
        raise SystemExit("sw.js 的 PRECACHE 列表是空的：等于没有离线缓存，请补齐产物清单。")

    expected = present - {"sw.js"}
    missing = sorted(expected - listed)
    extra = sorted(listed - expected)
    if missing or extra:
        lines = [
            f"sw.js 的 PRECACHE 列表和{stage}不一致："
            "少列的文件断网时打不开（页面残缺），多列的文件会在安装时白白请求一个"
            "不存在的地址（用 addAll 时整个安装失败）。"
        ]
        if missing:
            lines.append("  产物里有、PRECACHE 没列：" + "、".join(missing))
        if extra:
            lines.append("  PRECACHE 列了、产物里没有：" + "、".join(extra))
        raise SystemExit("\n".join(lines))


def _check_offline_only(products: Mapping[str, bytes], stage: str) -> None:
    """断言产物不依赖外部网络：没有 CDN 资源，也没有运行时动态 import。

    静态托管上的页面一旦引用 CDN，断网或对方挂掉时字体、图标就没了；动态 import
    还会在离线时静默失败，页面看起来「加载成功但少了功能」。
    """
    problems: list[str] = []
    for rel, data in products.items():
        if not rel.endswith(TEXT_SUFFIXES):
            continue
        text = _decode_text(rel, data)
        for pattern, reason in (
            (REMOTE_REFERENCE, "引用了 http(s):// 或协议相对地址的外部资源"),
            (DYNAMIC_IMPORT, "使用了 import() 动态加载"),
        ):
            for found in pattern.finditer(text):
                line = text.count("\n", 0, found.start()) + 1
                problems.append(f"  {rel}:{line} {reason}：{found.group(0)!r}")
    if problems:
        raise SystemExit(
            f"{stage}里有依赖外部网络的写法，静态托管断网时会失效：\n"
            + "\n".join(problems)
        )


def _validate_products(
    products: Mapping[str, bytes], present: set[str], stage: str
) -> None:
    """两类内容校验：离线缓存清单对得上、页面不依赖外网。

    stage 只用于说明是哪一步失败的——写盘前先在内存里查一遍（失败就不碰磁盘），
    写盘后再读回磁盘查一遍（确认落盘的真的是校验过的那份内容）。
    """
    _check_precache(products, present, stage)
    _check_offline_only(products, stage)


def _prune(directory: Path, prefix: str, keep_files: set[str],
           keep_dirs: set[str], removed: list[str]) -> bool:
    """自底向上清理输出目录，返回该目录里还有没有需要保留的内容。

    不在白名单里的文件一律删掉：以前发布过的旧文件留在托管目录里，下次上传时
    很容易连同新产物一起传上去（比如上一版还在用的 api.js）。
    遇到符号链接只删链接本身、不跟进去——跟进去删的就是托管目录之外的文件了。
    """
    kept = False
    with os.scandir(directory) as entries:
        for entry in entries:
            rel = f"{prefix}{entry.name}"
            path = Path(entry.path)
            if entry.is_symlink():
                path.unlink()
                removed.append(rel)
                continue
            if entry.is_dir():
                child_kept = _prune(path, rel + "/", keep_files, keep_dirs, removed)
                if child_kept or rel in keep_dirs:
                    kept = True
                else:
                    path.rmdir()
                    removed.append(rel + "/")
                continue
            if rel in keep_files:
                kept = True
            else:
                path.unlink()
                removed.append(rel)
    return kept


def _clean_output_dir(output: Path, products: Mapping[str, bytes]) -> list[str]:
    """把输出目录清成「只剩这次要写的东西」，返回被删掉的相对路径。"""
    keep_files = set(products)
    keep_dirs: set[str] = set()
    for rel in keep_files:
        parent = Path(rel).parent
        while str(parent) not in ("", "."):
            keep_dirs.add(parent.as_posix())
            parent = parent.parent
    removed: list[str] = []
    _prune(output, "", keep_files, keep_dirs, removed)
    return removed


def _ensure_directory(directory: Path) -> None:
    """逐级创建目录。

    父级里出现符号链接（比如 macOS 的 /tmp）是正常情况，不去干涉；输出目录
    自身是不是链接由 `_assert_output_not_symlink()` 在动磁盘之前拦住。
    """
    missing: list[Path] = []
    current = directory
    while not (current.is_symlink() or current.exists()):
        missing.append(current)
        current = current.parent
    for path in reversed(missing):
        path.mkdir()


def _write_products(output: Path, products: Mapping[str, bytes]) -> None:
    """把内存里的产物逐文件写盘（不用整目录复制，白名单之外的永远不进来）。"""
    for rel, data in products.items():
        target = output.joinpath(*rel.split("/"))
        _ensure_directory(target.parent)
        if target.is_symlink():
            # 清理阶段应该已经删掉了，这里只是兜底：绝不顺着链接写出去。
            target.unlink()
        target.write_bytes(data)


def _list_output_files(output: Path) -> set[str]:
    """列出输出目录里的所有条目（相对路径，不跟随符号链接）。"""
    found: set[str] = set()

    def walk(directory: Path, prefix: str) -> None:
        with os.scandir(directory) as entries:
            for entry in entries:
                rel = f"{prefix}{entry.name}"
                if entry.is_dir(follow_symlinks=False):
                    walk(Path(entry.path), rel + "/")
                else:
                    found.add(rel)

    walk(output, "")
    return found


def _verify_written(output: Path, products: Mapping[str, bytes]) -> dict[str, int]:
    """写盘后逐个复核：文件真的在、不是空的，并且内容校验依然通过。

    空文件在浏览器里加载会失败，但对上传工具来说「文件存在」看不出问题，所以
    必须在脚本里拦住。
    """
    sizes: dict[str, int] = {}
    for rel in products:
        target = output.joinpath(*rel.split("/"))
        if target.is_symlink() or not target.is_file():
            raise SystemExit(f"写盘后找不到 {target}：产物不完整，上传上去会 404。")
        size = target.stat().st_size
        if size <= 0:
            raise SystemExit(
                f"产出的 {rel} 是空文件：空文件在浏览器里加载会失败，"
                "不要把它发布出去。"
            )
        sizes[rel] = size

    on_disk = {
        rel: output.joinpath(*rel.split("/")).read_bytes() for rel in products
    }
    _validate_products(on_disk, _list_output_files(output), "输出目录")
    return sizes


def _print_summary(output: Path, sizes: Mapping[str, int], removed: list[str]) -> None:
    """打印摘要：输出目录、文件数、总字节数、每个文件的路径和大小。"""
    print("PWA 发布产物已准备完成")
    print(f"输出目录：{output}")
    print(f"文件数：{len(sizes)}")
    print(f"总字节数：{sum(sizes.values())}")
    if removed:
        print(f"已清理 {len(removed)} 个多余条目：" + "、".join(sorted(removed)))
    print("产物清单：")
    for rel, size in sizes.items():
        print(f"  {rel:<40}{size:>10} 字节")


def _parse_args(argv: list[str] | None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "按白名单把仓库里的静态资源准备成可以上传的纯静态 PWA 目录"
            "（入口 HTML 会从桌面版切换到 PWA 版）。"
        ),
        epilog=(
            "输出目录会被清理成只含白名单产物：不要指向还需要保留别的东西的目录。"
        ),
    )
    parser.add_argument(
        "--project-root",
        type=Path,
        default=PROJECT_ROOT,
        help="要打包的仓库根目录（默认是本脚本的上两级目录）",
    )
    parser.add_argument(
        "--output",
        type=Path,
        default=None,
        help="产物目录（默认 <project-root>/dist/pwa，相对路径按当前工作目录解析）",
    )
    parser.add_argument(
        "--zip", action="store_true",
        help="同时生成产物目录旁的 ZIP（入口在压缩包根目录，适合直接上传）",
    )
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = _parse_args(argv)
    project_root = args.project_root.resolve()
    # 输出路径刻意不用 resolve()：那会解开最后一级符号链接，让下面的检查失效。
    output = (
        _resolve_without_following(args.output)
        if args.output is not None
        else project_root / "dist" / "pwa"
    )

    # 顺序有讲究：安全检查 → 内存里备齐并校验 → 才动磁盘。
    # 任何一步失败都直接退出，输出目录保持原样，不会留下半个 dist。
    _assert_output_not_symlink(output)
    _assert_safe_output(project_root, output)
    products = _build_products(project_root)
    _validate_products(products, set(products), "内存里的产物")

    removed: list[str] = []
    if output.exists():
        if not output.is_dir():
            raise SystemExit(f"输出路径 {output} 已被同名文件占住，请先处理它。")
        removed = _clean_output_dir(output, products)
    _ensure_directory(output)
    _write_products(output, products)

    sizes = _verify_written(output, products)
    _print_summary(output, sizes, removed)
    if args.zip:
        archive_path = output.parent / (output.name + ".zip")
        # 不遍历仓库或任意目录：ZIP 只使用已验证的白名单产物。
        # 从内存产品写入，入口直接位于根目录，不套一层 pwa/。
        if archive_path.is_symlink() or archive_path.exists() and not archive_path.is_file():
            raise SystemExit(f"ZIP 路径 {archive_path} 不是普通文件，请先处理它。")
        with zipfile.ZipFile(archive_path, "w", compression=zipfile.ZIP_DEFLATED) as archive:
            for rel in sorted(products):
                archive.writestr(rel, products[rel])
        print(f"上传 ZIP：{archive_path}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
