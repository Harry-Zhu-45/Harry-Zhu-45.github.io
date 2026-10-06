#!/usr/bin/env python3
"""逐码点校验 pwa/casefold.js 与 Python str.casefold() 是否一致。

为什么值得单独一个测试：候选项的去重键在 SQLite 侧是 `casefold()`，浏览器侧是
casefold.js 里的差异表。两者一旦漂移，「Straße」和「STRASSE」在电脑上算重复、
在手机上会变成两个候选项，导出的备份互相导入也会多出重复行——而且不会有任何
报错，只是数据慢慢分叉。

这里不抽查样例，而是把全部 1114112 个码点跑一遍：0x110000 个码点分块喂给
node，进程内只起一次，靠一张压缩表（区间-偏移 / 零散条目 / 多码点映射）传数据。

用法：python3 tests/test_casefold_parity.py
失败时退出码非 0，并打印前若干个不一致的码点。
"""

from __future__ import annotations

import json
import subprocess
import sys
import unicodedata
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent
CASEFOLD_JS = PROJECT_ROOT / "pwa" / "casefold.js"
# 分块大小：一次 65536 个码点，整轮 17 次 IPC，够快也不会撞上命令行长度限制。
CHUNK_SIZE = 0x10000

HARNESS = """
const AppCasefold = require(%s);
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", () => {
    const request = JSON.parse(input);
    const mismatch = [];
    const missing = [];
    for (const [codePoint, expected] of request.pairs) {
        const char = String.fromCodePoint(codePoint);
        const actual = AppCasefold.foldString(char);
        if (actual !== expected) {
            mismatch.push([codePoint, expected, actual]);
        }
    }
    for (const [codePoint, ranges] of request.format) {
        if (!AppCasefold.isFormatCodePoint(codePoint)) {
            missing.push(codePoint);
        }
    }
    for (const [codePoint, ranges] of request.forbidden) {
        if (!AppCasefold.isForbiddenCodePoint(codePoint)) {
            missing.push(codePoint);
        }
    }
    process.stdout.write(JSON.stringify({ mismatch: mismatch, missing: missing }));
});
"""


def python_expected() -> tuple[list[tuple[int, str]], list[int], list[int]]:
    pairs: list[tuple[int, str]] = []
    format_points: list[int] = []
    forbidden_points: list[int] = []
    for code_point in range(0x110000):
        # 代理码点在 JS 里根本不能单独成字符，Python 的 chr() 也生成不了合法的
        # UTF-8，两边都不该出现。
        if 0xD800 <= code_point <= 0xDFFF:
            continue
        char = chr(code_point)
        pairs.append((code_point, char.casefold()))
        category = unicodedata.category(char)
        if category == "Cf":
            format_points.append(code_point)
        if category in {"Cc", "Cs"}:
            forbidden_points.append(code_point)
    return pairs, format_points, forbidden_points


def run_node(harness: str, pairs: list[tuple[int, str]], format_points, forbidden_points):
    """跑一次 node，返回 (mismatch, missing)。"""
    request = json.dumps(
        {
            "pairs": [[cp, expected] for cp, expected in pairs],
            "format": [[cp, None] for cp in format_points],
            "forbidden": [[cp, None] for cp in forbidden_points],
        },
        ensure_ascii=False,
    )
    result = subprocess.run(
        ["node", "-e", harness],
        input=request.encode("utf-8"),
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        cwd=str(PROJECT_ROOT),
        check=False,
    )
    if result.returncode != 0:
        raise SystemExit(
            "node 执行失败（退出码 %d）：\n%s"
            % (result.returncode, result.stderr.decode("utf-8", "replace"))
        )
    return json.loads(result.stdout.decode("utf-8"))


def main() -> int:
    if not CASEFOLD_JS.exists():
        raise SystemExit("找不到 %s，先运行 python3 tools/generate_casefold.py" % CASEFOLD_JS)

    harness = HARNESS % json.dumps(str(CASEFOLD_JS))
    pairs, format_points, forbidden_points = python_expected()
    print(
        "对照 %d 个码点（Unicode %s）：Cf %d 个、Cc/Cs %d 个"
        % (len(pairs), unicodedata.unidata_version, len(format_points), len(forbidden_points))
    )

    mismatches: list[list[object]] = []
    missing: list[int] = []
    for start in range(0, len(pairs), CHUNK_SIZE):
        chunk = pairs[start:start + CHUNK_SIZE]
        chunk_format = [cp for cp in format_points if cp in range(chunk[0][0], chunk[-1][0] + 1)]
        chunk_forbidden = [cp for cp in forbidden_points if cp in range(chunk[0][0], chunk[-1][0] + 1)]
        outcome = run_node(harness, chunk, chunk_format, chunk_forbidden)
        mismatches.extend(outcome["mismatch"])
        missing.extend(outcome["missing"])

    if missing:
        print("FAIL - 类别判定漏了 %d 个码点：%s" % (len(missing), [hex(cp) for cp in missing[:10]]))
        return 1
    if mismatches:
        print("FAIL - %d 个码点的折叠结果和 Python 不一致：" % len(mismatches))
        for code_point, expected, actual in mismatches[:20]:
            print(
                "  U+%04X  Python=%r  JS=%r"
                % (code_point, expected, actual)
            )
        return 1

    print("OK - 全部 %d 个码点的 casefold 与 Cf/Cc/Cs 判定和 Python 一致" % len(pairs))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
