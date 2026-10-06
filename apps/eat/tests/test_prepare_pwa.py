"""`tools/prepare_pwa.py` 的回归测试。

这里的产物会整包上传到公网静态托管，两类错误代价最大，所以测试也围着它们转：

- **漏带或错带文件**：漏一个 JS 手机白屏，多带一份 `data/*.sqlite3` 就是把真实
  数据和本机代码传出去。因此断言产物集合「恰好等于」白名单，而不是「包含」。
- **离线能力悄悄失效**：Service Worker 的预缓存列表和实际产物漂移时，页面在线
  看着正常、断网才炸，所以专门造一份少列文件的 `sw.js` 断言脚本会拒绝发布。

仓库硬规则：测试不能往项目目录里写文件。所有输出都落在
`tempfile.TemporaryDirectory()` 里；需要假项目时用 `--project-root` 指向临时目录
（真实项目的端到端用例只读仓库、只往临时目录写）。
"""

from __future__ import annotations

import re
import subprocess
import sys
import tempfile
import unittest
import zipfile
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
TOOL_PATH = REPO_ROOT / "tools" / "prepare_pwa.py"

# 发布产物的完整清单（输出相对路径）。这里刻意和脚本内部的白名单各写一份：
# 脚本里的表被人不小心加一行时，这条断言会失败——白名单变宽就是真实数据、本机
# 代码或测试外泄的风险，必须有人显式确认过才改。
EXPECTED_OUTPUT_FILES = {
    "index.html",
    "main.css",
    "index.js",
    "search.js",
    "pwa.css",
    "casefold.js",
    "validation.js",
    "store.js",
    "database.js",
    "pwa-text.js",
    "api-local.js",
    "bootstrap.js",
    "sw.js",
    "manifest.webmanifest",
    "icons/icon-192.png",
    "icons/icon-512.png",
    "icons/icon-maskable-512.png",
    "images/xinsanguo-csm-1920.jpg",
}

# 缩进 8 空格，和真实 index.html 底部一致：脚本按原样匹配，缩进不同就不该命中。
SCRIPT_BLOCK = (
    '        <script src="search.js"></script>\n'
    '        <script src="api.js"></script>\n'
    '        <script src="index.js"></script>\n'
)

STYLESHEET_LINK = (
    '        <link rel="stylesheet" type="text/css" media="screen" href="main.css" />'
)

# 数据备份页那句说明，缩进 20 空格。它必须被换掉：PWA 里没有 SQLite 文件。
STORAGE_NOTE = (
    '                    <p class="view-note">数据保存在本机 SQLite 数据库中，'
    '可导出 JSON 文件进行备份或迁移。</p>'
)

# 假项目里的 index.html：只保留脚本要处理的两处真实锚点，其余内容与本次转换无关。
FIXTURE_INDEX_HTML = (
    "<!DOCTYPE html>\n"
    '<html lang="zh-CN">\n'
    "    <head>\n"
    f"{STYLESHEET_LINK}\n"
    "    </head>\n"
    "    <body>\n"
    f"{STORAGE_NOTE}\n"
    f"{SCRIPT_BLOCK}"
    "    </body>\n"
    "</html>\n"
)

PLACEHOLDER_JS = '"use strict";\n'
PLACEHOLDER_CSS = "body {}\n"
PLACEHOLDER_PNG = b"\x89PNG\r\n\x1a\n" + b"fixture-icon"
PLACEHOLDER_JPG = b"\xff\xd8\xff\xe0" + b"fixture-image"

# 文本类源文件：内容无所谓，脚本只检查扩展名和是否存在。
FIXTURE_TEXT_SOURCES = {
    "main.css": PLACEHOLDER_CSS,
    "index.js": PLACEHOLDER_JS,
    "search.js": PLACEHOLDER_JS,
    "pwa/pwa.css": PLACEHOLDER_CSS,
    "pwa/casefold.js": PLACEHOLDER_JS,
    "pwa/validation.js": PLACEHOLDER_JS,
    "pwa/store.js": PLACEHOLDER_JS,
    "pwa/database.js": PLACEHOLDER_JS,
    "pwa/pwa-text.js": PLACEHOLDER_JS,
    "pwa/api-local.js": PLACEHOLDER_JS,
    "pwa/bootstrap.js": PLACEHOLDER_JS,
    # 内容像 manifest 就行：脚本按 .webmanifest 之外的规则不解析它。
    "pwa/manifest.webmanifest": (
        '{"name": "今天吃什么", "start_url": "./", "display": "standalone"}\n'
    ),
}

# 二进制类源文件：只需要「存在且非空」，用最少的字节占位。
FIXTURE_BINARY_SOURCES = {
    "pwa/icons/icon-192.png": PLACEHOLDER_PNG,
    "pwa/icons/icon-512.png": PLACEHOLDER_PNG,
    "pwa/icons/icon-maskable-512.png": PLACEHOLDER_PNG,
    "images/xinsanguo-csm-1920.jpg": PLACEHOLDER_JPG,
}


def make_sw_js(precache_entries: list[str]) -> str:
    """造一份可以乱真的 sw.js：脚本要的正则认 `var PRECACHE = [ ... ];` 和
    `__CACHE_VERSION__` 占位符（真实 sw.js 就长这样）。"""
    body = "\n".join(f'  "{entry}",' for entry in precache_entries)
    return (
        '"use strict";\n'
        "\n"
        'var VERSION = "__CACHE_VERSION__";\n'
        'var CACHE_NAME = "what-should-we-eat-shell-" + VERSION;\n'
        "\n"
        "var PRECACHE = [\n" + body + "\n];\n"
        "\n"
        "self.addEventListener('install', function (event) {\n"
        "  event.waitUntil(caches.open(CACHE_NAME).then(function (cache) {\n"
        "    return cache.addAll(PRECACHE);\n"
        "  }));\n"
        "});\n"
    )


def default_precache_entries() -> list[str]:
    """默认列表：覆盖除 sw.js 自身以外的全部产物，其中入口用 "./" 写法。"""
    return sorted(
        "./" if rel == "index.html" else f"./{rel}"
        for rel in EXPECTED_OUTPUT_FILES - {"sw.js"}
    )


def build_fixture_root(
    root: Path,
    *,
    index_html: str | None = None,
    sw_js: str | None = None,
) -> Path:
    """在 root 里按白名单造齐所有源文件的假项目。

    五个用例共用这一份 fixture，改动白名单时只需要改这里和
    `EXPECTED_OUTPUT_FILES` 两处。注意这不等于「复制真实仓库」：真实仓库里的
    server.py、data/、tests/ 等正因为不在白名单里，才必须由用例确认它们没被带出去。
    """
    root.mkdir(parents=True, exist_ok=True)

    sources: dict[str, str | bytes] = dict(FIXTURE_TEXT_SOURCES)
    sources.update(FIXTURE_BINARY_SOURCES)
    sources["index.html"] = (
        FIXTURE_INDEX_HTML if index_html is None else index_html
    )
    sources["pwa/sw.js"] = (
        make_sw_js(default_precache_entries()) if sw_js is None else sw_js
    )

    for rel, content in sources.items():
        path = root.joinpath(*rel.split("/"))
        path.parent.mkdir(parents=True, exist_ok=True)
        if isinstance(content, bytes):
            path.write_bytes(content)
        else:
            path.write_text(content, encoding="utf-8")
    return root


def run_tool(*args: str) -> subprocess.CompletedProcess[str]:
    """跑一次脚本，合并捕获输出：报错信息走 stderr，摘要走 stdout。"""
    return subprocess.run(
        [sys.executable, str(TOOL_PATH), *args],
        capture_output=True,
        text=True,
    )


def message_of(result: subprocess.CompletedProcess[str]) -> str:
    """把一次运行的 stderr 和 stdout 拼起来，方便断言「报错有没有说清原因」。"""
    return result.stderr + result.stdout


def collect_files(root: Path) -> set[str]:
    """列出目录下所有文件的相对路径（用 / 分隔），用于和白名单做集合比较。"""
    return {
        path.relative_to(root).as_posix()
        for path in root.rglob("*")
        if path.is_file()
    }


class RealProjectEndToEndTest(unittest.TestCase):
    """对真实仓库跑一次：这是「用户真的会执行的那条命令」的等价物。"""

    def test_upload_zip_has_exact_products_at_root(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            output = Path(tmp) / "pwa"
            result = run_tool("--output", str(output), "--zip")
            self.assertEqual(result.returncode, 0, message_of(result))
            with zipfile.ZipFile(output.parent / "pwa.zip") as archive:
                self.assertEqual(set(archive.namelist()), EXPECTED_OUTPUT_FILES)
                self.assertIsNone(archive.testzip())
                for rel in EXPECTED_OUTPUT_FILES:
                    self.assertEqual(archive.read(rel), (output / rel).read_bytes())

    def test_upload_zip_replaces_stale_entries(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            output = Path(tmp) / "pwa"
            archive_path = output.parent / "pwa.zip"
            with zipfile.ZipFile(archive_path, "w") as archive:
                archive.writestr("data/private.json", "old contents")
            result = run_tool("--output", str(output), "--zip")
            self.assertEqual(result.returncode, 0, message_of(result))
            with zipfile.ZipFile(archive_path) as archive:
                self.assertEqual(set(archive.namelist()), EXPECTED_OUTPUT_FILES)

    def test_upload_zip_does_not_follow_symlink(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            output = Path(tmp) / "pwa"
            protected = Path(tmp) / "do-not-touch"
            protected.write_bytes(b"protected")
            (Path(tmp) / "pwa.zip").symlink_to(protected)
            result = run_tool("--output", str(output), "--zip")
            self.assertNotEqual(result.returncode, 0)
            self.assertEqual(protected.read_bytes(), b"protected")

    def test_real_project_builds_exactly_the_whitelist(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            output = Path(tmp) / "pwa"
            result = run_tool("--output", str(output))

            # pwa/ 下的文件由另一条线提供，缺失时脚本会明确报「源文件不存在」；
            # 那种失败要原样暴露出来，不能在这里静默跳过。
            self.assertEqual(
                result.returncode,
                0,
                msg=f"准备发布产物失败：\n{message_of(result)}",
            )

            # 集合相等而不是「包含」：多带一个文件就是不该上传的东西外泄了。
            self.assertEqual(collect_files(output), EXPECTED_OUTPUT_FILES)

            html = (output / "index.html").read_text(encoding="utf-8")
            self.assertIn("api-local.js", html)
            self.assertIn("bootstrap.js", html)
            self.assertNotIn("api.js", html)

            # 数据库、后端代码、测试、规划文档一律不许出现在产物里。
            relative_paths = collect_files(output)
            forbidden = {"server.py", "database.py", "data", "tests", ".planning", "api.js"}
            leaked = {
                rel
                for rel in relative_paths
                if forbidden.intersection(Path(rel).parts)
            }
            self.assertEqual(leaked, set(), msg=f"产物里混进了不该发布的路径：{leaked}")

            # 页面运行必需的静态资源：存在且非空（0 字节在浏览器里等于加载失败）。
            for rel in (
                "icons/icon-192.png",
                "images/xinsanguo-csm-1920.jpg",
            ):
                target = output.joinpath(*rel.split("/"))
                self.assertTrue(target.is_file(), msg=f"缺少产物：{rel}")
                self.assertGreater(target.stat().st_size, 0, msg=f"产物是空文件：{rel}")

    def test_font_is_not_published(self) -> None:
        """stylu.ttf 是 Bitstream 的商业字体，而且没有任何 CSS 规则真的用它。

        它曾经在发布清单里：@font-face 声明了 `stylus`，但 body/button 用的一直是
        Georgia 和 Segoe UI，没有一条规则引用这个字体族——46KB 商业字体只是为了
        被打包下载。撤掉它之后，产物里就不含任何需要确认分发权的字体。
        这条断言防的是"以后有人照抄旧清单又把它加回来"。
        """
        with tempfile.TemporaryDirectory() as tmp:
            output = Path(tmp) / "pwa"
            result = run_tool("--output", str(output))
            self.assertEqual(result.returncode, 0, msg=message_of(result))
            self.assertFalse(
                (output / "fonts").exists(),
                msg="产物里又出现了 fonts/：stylu.ttf 没有使用方，不该发布",
            )


class AnchorFailureTest(unittest.TestCase):
    """入口 HTML 的锚点找不到时必须停下，而不是产出一个坏的 index.html。"""

    def test_missing_script_block_fails_with_reason(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = build_fixture_root(Path(tmp) / "project")
            # 用真实 index.html 做底，再删掉底部脚本块：这样断言的是真实锚点，
            # 而不是 fixture 里自己写的那份。
            real_html = (REPO_ROOT / "index.html").read_text(encoding="utf-8")
            self.assertIn(SCRIPT_BLOCK, real_html, msg="真实 index.html 的脚本块变了")
            (root / "index.html").write_text(
                real_html.replace(SCRIPT_BLOCK, ""), encoding="utf-8"
            )
            output = Path(tmp) / "pwa"

            result = run_tool(
                "--project-root", str(root), "--output", str(output)
            )

            self.assertNotEqual(result.returncode, 0)
            message = message_of(result)
            # 报错要指出是哪个锚点、命中了几次，否则排错全靠猜。
            self.assertIn("script 块", message)
            self.assertIn("0 次", message)
            # 校验在写盘之前完成：失败的运行不该留下半个 dist。
            self.assertFalse(output.exists(), msg="失败的运行留下了输出目录")

    def test_leftover_api_js_reference_fails(self) -> None:
        """脚本块之外还引着 api.js 时必须报错。

        这是「命中次数」检查抓不到的情况：底部脚本块正常换掉了，但页面别处（比如
        有人加了个预加载，或者顶端又写了一次）仍指向 api.js。静态托管上没有本机
        Python 服务，这个引用必然 404。
        """
        with tempfile.TemporaryDirectory() as tmp:
            root = build_fixture_root(Path(tmp) / "project")
            html = (root / "index.html").read_text(encoding="utf-8")
            (root / "index.html").write_text(
                html.replace(
                    "    <body>\n",
                    '    <body>\n        <link rel="preload" href="api.js" as="script">\n',
                ),
                encoding="utf-8",
            )
            output = Path(tmp) / "pwa"

            result = run_tool(
                "--project-root", str(root), "--output", str(output)
            )

            self.assertNotEqual(result.returncode, 0)
            self.assertIn("api.js", message_of(result))
            self.assertFalse(output.exists(), msg="校验失败却写出了产物")


class StaleOutputTest(unittest.TestCase):
    """输出目录里的旧文件必须清掉，否则下次上传会把上一版的产物一起带上去。"""
    def test_extra_file_in_output_dir_is_removed(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = build_fixture_root(Path(tmp) / "project")
            output = Path(tmp) / "pwa"
            output.mkdir(parents=True)
            (output / "junk.txt").write_text("上一版遗留\n", encoding="utf-8")
            # 顺带验证子目录里的旧文件也会被清掉（多层清理是分开写的代码路径）。
            stale_dir = output / "old"
            stale_dir.mkdir()
            (stale_dir / "api.js").write_text("桌面版遗留\n", encoding="utf-8")

            result = run_tool("--project-root", str(root), "--output", str(output))

            self.assertEqual(
                result.returncode, 0, msg=f"运行失败：\n{message_of(result)}"
            )
            self.assertFalse((output / "junk.txt").exists())
            self.assertFalse(stale_dir.exists())
            self.assertEqual(collect_files(output), EXPECTED_OUTPUT_FILES)


class UnsafeOutputTest(unittest.TestCase):
    """输出目录落在数据目录里时必须拒绝：那里是真实 SQLite 数据的唯一副本。"""

    def test_output_inside_data_dir_is_refused(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = build_fixture_root(Path(tmp) / "project")
            data_dir = root / "data"
            data_dir.mkdir()
            keep = data_dir / "what-should-we-eat.sqlite3"
            keep.write_bytes(b"real data")
            output = data_dir / "pwa"

            result = run_tool(
                "--project-root", str(root), "--output", str(output)
            )

            self.assertNotEqual(result.returncode, 0)
            self.assertIn("数据目录", message_of(result))
            self.assertFalse(output.exists(), msg="被拒绝的运行仍然写了输出目录")
            # 拒绝必须是「什么都没做」：现有数据一个字节都不能动。
            self.assertEqual(keep.read_bytes(), b"real data")

    def test_output_equal_to_project_root_is_refused(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = build_fixture_root(Path(tmp) / "project")

            result = run_tool("--project-root", str(root), "--output", str(root))

            self.assertNotEqual(result.returncode, 0)
            self.assertIn("项目根目录", message_of(result))
            # 仓库不能被自己的发布脚本清空。
            self.assertTrue((root / "index.html").is_file())

    def test_symlinked_output_dir_is_refused(self) -> None:
        """输出目录是符号链接时必须拒绝。

        跟随链接清理会去删链接指向的真实文件——用户以为删的只是 dist 里的副本，
        实际删掉的是托管目录里的线上内容。清理步骤只删不在白名单里的文件，
        所以用「目标目录里有个不在白名单的文件」来验证它确实没被动过。
        """
        with tempfile.TemporaryDirectory() as tmp:
            root = build_fixture_root(Path(tmp) / "project")
            target = Path(tmp) / "real-site"
            target.mkdir()
            bystander = target / "线上文件.txt"
            bystander.write_text("不能被删", encoding="utf-8")
            link = Path(tmp) / "pwa"
            link.symlink_to(target, target_is_directory=True)

            result = run_tool("--project-root", str(root), "--output", str(link))

            self.assertNotEqual(result.returncode, 0)
            self.assertIn("符号链接", message_of(result))
            self.assertEqual(bystander.read_text(encoding="utf-8"), "不能被删")
            self.assertTrue(link.is_symlink(), msg="链接本身不该被替换成真实目录")


class PrecacheDriftTest(unittest.TestCase):
    """预缓存列表和产物漂移必须报错：这类问题在线看着正常，断网才暴露。"""

    def test_precache_missing_entry_fails_and_names_it(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / "project"
            # 少列 main.css：断网时样式表拿不到，页面会退化成无样式的白底黑字。
            entries = [
                entry
                for entry in default_precache_entries()
                if entry != "./main.css"
            ]
            build_fixture_root(root, sw_js=make_sw_js(entries))
            output = Path(tmp) / "pwa"

            result = run_tool(
                "--project-root", str(root), "--output", str(output)
            )

            self.assertNotEqual(result.returncode, 0)
            message = message_of(result)
            self.assertIn("main.css", message)
            self.assertIn("PRECACHE", message)
            self.assertFalse(output.exists(), msg="校验失败却已经写出了产物")

    def test_precache_extra_entry_fails_and_names_it(self) -> None:
        """多列一个文件同样致命：install 阶段会去请求不存在的地址。"""
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / "project"
            entries = default_precache_entries() + ["./ghost.js"]
            build_fixture_root(root, sw_js=make_sw_js(entries))
            output = Path(tmp) / "pwa"

            result = run_tool(
                "--project-root", str(root), "--output", str(output)
            )

            self.assertNotEqual(result.returncode, 0)
            self.assertIn("ghost.js", message_of(result))

    def test_precache_entry_outside_dot_slash_is_refused(self) -> None:
        """条目必须是 ./ 开头的相对路径，否则站点放在子路径下时缓存会全错。"""
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / "project"
            entries = [
                "/index.html" if entry == "./" else entry
                for entry in default_precache_entries()
            ]
            build_fixture_root(root, sw_js=make_sw_js(entries))
            output = Path(tmp) / "pwa"

            result = run_tool(
                "--project-root", str(root), "--output", str(output)
            )

            self.assertNotEqual(result.returncode, 0)
            self.assertIn("/index.html", message_of(result))


class OfflineOnlyTest(unittest.TestCase):
    """产物不许依赖 CDN：静态托管的断网可用性是 PWA 的全部意义。"""

    def test_remote_reference_in_source_is_refused(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = build_fixture_root(Path(tmp) / "project")
            (root / "pwa" / "pwa.css").write_text(
                '@import url("https://fonts.example.com/x.css");\nbody {}\n',
                encoding="utf-8",
            )
            output = Path(tmp) / "pwa"

            result = run_tool(
                "--project-root", str(root), "--output", str(output)
            )

            self.assertNotEqual(result.returncode, 0)
            self.assertIn("pwa.css", message_of(result))
            self.assertFalse(output.exists())


class MissingSourceTest(unittest.TestCase):
    """白名单里的源文件缺失时要一次报全，并指出是哪些，且不留下半个 dist。"""

    def test_missing_sources_are_all_reported(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = build_fixture_root(Path(tmp) / "project")
            (root / "pwa" / "store.js").unlink()
            (root / "images" / "xinsanguo-csm-1920.jpg").unlink()
            output = Path(tmp) / "pwa"

            result = run_tool(
                "--project-root", str(root), "--output", str(output)
            )

            self.assertNotEqual(result.returncode, 0)
            message = message_of(result)
            self.assertIn("pwa/store.js", message)
            self.assertIn("images/xinsanguo-csm-1920.jpg", message)
            self.assertFalse(output.exists())


if __name__ == "__main__":
    unittest.main()


class CacheVersionTest(unittest.TestCase):
    """sw.js 的缓存版本必须是产物内容算出来的，而不是手写的。

    手写版本号（原来是 "v1"）是「用户永远看到旧页面」的经典成因：改了 JS
    却忘了加版本，Service Worker 就认为缓存还是最新的，所有人继续拿旧文件，
    而且没有任何报错。这里守住三件事：指纹被替换、内容变了指纹就变、
    内容没变指纹就不变（确定性）。
    """

    VERSION_PATTERN = re.compile(r'var VERSION = "([^"]+)";')

    def build(self) -> tuple[Path, Path]:
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        root = build_fixture_root(Path(temporary.name) / "repo")
        output = Path(temporary.name) / "dist"
        result = run_tool("--project-root", str(root), "--output", str(output))
        self.assertEqual(result.returncode, 0, result.stderr + result.stdout)
        return root, output

    def version_of(self, output: Path) -> str:
        text = (output / "sw.js").read_text(encoding="utf-8")
        match = self.VERSION_PATTERN.search(text)
        self.assertIsNotNone(match, "产物 sw.js 里找不到 var VERSION = \"...\";")
        return match.group(1)

    def test_placeholder_is_replaced_with_a_fingerprint(self) -> None:
        _, output = self.build()
        version = self.version_of(output)
        self.assertNotIn(
            "__CACHE_VERSION__", version,
            "占位符没被替换：所有用户的缓存名会变成字面量 __CACHE_VERSION__，"
            "看起来能跑，但每次发布都命中同一个缓存名，等于永远不更新",
        )
        self.assertRegex(version, r"^[0-9a-f]{12}$", "指纹应该是内容哈希的前 12 位")

    def test_changing_any_product_changes_the_version(self) -> None:
        root, output = self.build()
        before = self.version_of(output)

        # 改一个**被缓存**的产物（不是 sw.js 自己）：这正是「改了 JS 忘了加版本」
        # 那个场景。指纹变了，浏览器才会认为 sw.js 也变了、才会去装新版本。
        css = root / "main.css"
        css.write_text(css.read_text(encoding="utf-8") + "\n/* probe */\n", encoding="utf-8")
        result = run_tool("--project-root", str(root), "--output", str(output))
        self.assertEqual(result.returncode, 0, result.stderr + result.stdout)

        self.assertNotEqual(
            before, self.version_of(output),
            "页面资源变了但缓存版本没变：用户会一直看到旧页面，且没有任何提示",
        )

    def test_same_content_gives_the_same_version(self) -> None:
        root, output = self.build()
        first = self.version_of(output)
        # 重复构建同样的内容：指纹必须一样，否则每次发布都会产生一次
        # 无意义的「有新版本」提示。
        result = run_tool("--project-root", str(root), "--output", str(output))
        self.assertEqual(result.returncode, 0, result.stderr + result.stdout)
        self.assertEqual(first, self.version_of(output), "同样内容算出了不同指纹")

    def test_sw_js_without_placeholder_is_left_alone(self) -> None:
        # 没有占位符时不做猜测（可能是别的版本管理方式）：
        # 既不该报错，也不该把别人的代码改坏。
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        plain_sw = (
            "var CACHE_NAME = \"fixed-name\";\n"
            "var PRECACHE = [%s];\n"
            % ", ".join(f'"{entry}"' for entry in default_precache_entries())
        )
        root = build_fixture_root(Path(temporary.name) / "repo", sw_js=plain_sw)
        output = Path(temporary.name) / "dist"
        result = run_tool("--project-root", str(root), "--output", str(output))
        self.assertEqual(result.returncode, 0, result.stderr + result.stdout)
        self.assertIn(
            "fixed-name", (output / "sw.js").read_text(encoding="utf-8"),
            "没有占位符时不该改动别人的版本管理方式",
        )
