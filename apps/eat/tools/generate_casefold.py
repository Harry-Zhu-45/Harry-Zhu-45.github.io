#!/usr/bin/env python3
"""从 Python 的 unicodedata 生成 pwa/casefold.js。

为什么需要这个文件：SQLite 侧的去重键是 `str.casefold()`，浏览器里没有等价的
API，而 `toLowerCase()` 和 casefold 有 1530 个码点不一致（`ß` -> `ss`、
`ﬁ` -> `fi`、`ŉ` -> `ʼn`、结尾 sigma 等）。用 toLowerCase 顶替的话，电脑版
拒绝的重复名在手机上能被加进去，两边数据会分叉。

所以把差异表原样搬到 JS 里，并且用 tests/test_casefold_parity.py 逐码点比对
Python 的当前结果——表一旦和 Python 漂移，测试就会失败。

生成的数据用三段紧凑文本表示（格式写在文件头里）：
- ranges：连续且偏移量相同的单码点映射，压成 `起-止:偏移`
- singles：零散的单码点映射 `码点:目标`
- multi：折叠成多个码点的映射 `码点:目标1 目标2 ...`（用定长十六进制拼接）
- format：不可见格式字符（Unicode 类别 Cf），写库前要过滤掉

用法：python3 tools/generate_casefold.py [输出路径]
默认写 pwa/casefold.js。没有构建步骤，这个脚本只在 Unicode 数据需要更新时手动跑。
"""

from __future__ import annotations

import sys
import unicodedata
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_OUTPUT = PROJECT_ROOT / "pwa" / "casefold.js"
# multi 段用定长十六进制拼接目标串，长度按当前数据的最大值留出余量。
MULTI_WIDTH = 5

HEADER = '''"use strict";

/*
 * 由 tools/generate_casefold.py 从 Python 的 unicodedata 生成，不要手改。
 *
 * 浏览器没有和 `str.casefold()` 等价的 API，而 `toLowerCase()` 在 1530 个码点
 * 上和它不一致（`ß` 不会变成 `ss`，`ﬁ` 不会变成 `fi`，词尾 sigma 不会归到
 * `σ`）。候选项去重键必须和 SQLite 侧一致，否则「Straße」和「STRASSE」在电脑
 * 上算重复、在手机上算两个不同的东西。
 *
 * 数据格式（都是逗号分隔的条目）：
 *   ranges   `起-止:偏移`  该区间内每个码点折叠成 `码点 + 偏移`，偏移可带 `-`
 *   singles  `码点:目标`   零散的单码点映射
 *   multi    `码点:目标`   折叠成多个码点，目标按 5 位十六进制一段拼接
 *
 * 正例和边界都钉在 tests/test_casefold.js 里；逐码点与 Python 的一致性由
 * tests/test_casefold_parity.py 校验。
 */
(function(root, factory) {
    var api = factory();
    if (typeof module === "object" && module.exports) {
        module.exports = api;
    }
    if (root) {
        root.AppCasefold = api;
    }
}(typeof window === "undefined" ? null : window, function() {
'''

FOOTER = '''    // multi 段每个目标码点占的十六进制位数，必须和生成端的 MULTI_WIDTH 一致。
    var MULTI_WIDTH = __MULTI_WIDTH__;
    var singleMap = null;
    var rangeMap = null;

    function buildMaps() {
        if (singleMap) {
            return;
        }
        singleMap = {};
        rangeMap = DATA.ranges.split(",").map(function(entry) {
            var bounds = entry.split(":");
            var span = bounds[0].split("-");
            return {
                start: parseInt(span[0], 16),
                end: parseInt(span[1], 16),
                delta: bounds[1].charAt(0) === "-"
                    ? -parseInt(bounds[1].slice(1), 16)
                    : parseInt(bounds[1], 16)
            };
        });
        DATA.singles.split(",").forEach(function(entry) {
            var parts = entry.split(":");
            singleMap[parseInt(parts[0], 16)] = String.fromCodePoint(parseInt(parts[1], 16));
        });
        Object.keys(DATA.multi).forEach(function(key) {
            var chunk = DATA.multi[key];
            var value = "";
            for (var index = 0; index < chunk.length; index += MULTI_WIDTH) {
                value += String.fromCodePoint(parseInt(chunk.slice(index, index + MULTI_WIDTH), 16));
            }
            singleMap[parseInt(key, 16)] = value;
        });
    }

    // 折叠单个码点：full case folding 是逐字符映射，没有上下文规则
    // （词尾 sigma 那种是 lower 才有的），所以逐点折叠再拼接和整串 casefold 等价。
    function foldCodePoint(codePoint) {
        buildMaps();
        if (typeof codePoint !== "number" || !isFinite(codePoint)) {
            return "";
        }
        var direct = singleMap[codePoint];
        if (direct !== undefined) {
            return direct;
        }
        for (var index = 0; index < rangeMap.length; index += 1) {
            var range = rangeMap[index];
            if (codePoint >= range.start && codePoint <= range.end) {
                return String.fromCodePoint(codePoint + range.delta);
            }
        }
        return String.fromCodePoint(codePoint);
    }

    // 输入必须是已经做过 NFC 的字符串（normalize_food 的顺序就是先 NFC 再折叠）。
    function foldString(value) {
        if (typeof value !== "string") {
            return "";
        }
        var result = "";
        for (var index = 0; index < value.length; index += 1) {
            var codePoint = value.codePointAt(index);
            if (codePoint > 0xFFFF) {
                index += 1;
            }
            result += foldCodePoint(codePoint);
        }
        return result;
    }

    function inRanges(codePoint, ranges) {
        for (var index = 0; index < ranges.length; index += 1) {
            if (codePoint >= ranges[index][0] && codePoint <= ranges[index][1]) {
                return true;
            }
        }
        return false;
    }

    // Unicode 类别 Cf：零宽连接符、方向标记这类"看不见但存在"的字符。
    function isFormatCodePoint(codePoint) {
        return inRanges(codePoint, DATA.format);
    }

    // 类别 Cc（控制字符）与 Cs（代理字符）。换行和制表也在 Cc 里，
    // 和 Python 侧一样属于"不能出现在食物名里"。
    function isForbiddenCodePoint(codePoint) {
        if (codePoint >= 0xD800 && codePoint <= 0xDFFF) {
            return true;
        }
        return codePoint <= 0x1F || (codePoint >= 0x7F && codePoint <= 0x9F);
    }

    return {
        DATA: DATA,
        foldCodePoint: foldCodePoint,
        foldString: foldString,
        isFormatCodePoint: isFormatCodePoint,
        isForbiddenCodePoint: isForbiddenCodePoint
    };
}));
'''


def hex_of(value: int) -> str:
    return format(value, "x").upper()


def build_data() -> dict[str, object]:
    singles: dict[int, str] = {}
    multi: dict[int, str] = {}
    for code_point in range(0x110000):
        if 0xD800 <= code_point <= 0xDFFF:
            continue
        char = chr(code_point)
        folded = char.casefold()
        if folded == char:
            continue
        if len(folded) == 1:
            singles[code_point] = folded
        else:
            multi[code_point] = folded

    # 连续码点且偏移量相同的映射压成区间；剩下的零散条目单独列。
    runs: list[tuple[int, int, int]] = []
    keys = sorted(singles)
    index = 0
    while index < len(keys):
        start = keys[index]
        delta = ord(singles[start]) - start
        end = start
        cursor = index + 1
        while cursor < len(keys):
            code_point = keys[cursor]
            if code_point == end + 1 and ord(singles[code_point]) - code_point == delta:
                end = code_point
                cursor += 1
            else:
                break
        runs.append((start, end, delta))
        index = cursor

    ranges = [run for run in runs if run[1] > run[0]]
    lone = [run for run in runs if run[1] == run[0]]

    format_ranges: list[tuple[int, int]] = []
    for code_point in range(0x110000):
        if 0xD800 <= code_point <= 0xDFFF:
            continue
        if unicodedata.category(chr(code_point)) != "Cf":
            continue
        if format_ranges and format_ranges[-1][1] == code_point - 1:
            format_ranges[-1] = (format_ranges[-1][0], code_point)
        else:
            format_ranges.append((code_point, code_point))

    return {
        "ranges": ",".join(
            "%s-%s:%s" % (hex_of(start), hex_of(end), hex_of(delta) if delta >= 0 else "-" + hex_of(-delta))
            for start, end, delta in ranges
        ),
        "singles": ",".join("%s:%s" % (hex_of(start), hex_of(ord(singles[start]))) for start, _, _ in lone),
        "multi": {hex_of(code_point): "".join(hex_of(ord(char)).rjust(MULTI_WIDTH, "0") for char in folded)
                  for code_point, folded in sorted(multi.items())},
        "format": "[%s]" % ",".join(
            "[0x%s,0x%s]" % (hex_of(start), hex_of(end)) for start, end in format_ranges
        ),
        "unicodeVersion": unicodedata.unidata_version,
        "counts": {
            "rangeCount": len(ranges),
            "rangePoints": sum(end - start + 1 for start, end, _ in ranges),
            "singleCount": len(lone),
            "multiCount": len(multi),
            "formatRangeCount": len(format_ranges),
        },
    }


def render(data: dict[str, object]) -> str:
    # 键一律加引号：以数字开头的码点（如 "1F0"）在对象字面量里是非法标识符。
    multi_entries = ",\n".join(
        '            "%s": "%s"' % (key, value) for key, value in data["multi"].items()
    )
    body = (
        '    var DATA = {\n'
        '        unicodeVersion: "%s",\n'
        '        ranges: "%s",\n'
        '        singles: "%s",\n'
        '        multi: {\n%s\n        },\n'
        '        format: %s\n'
        '    };\n\n'
    ) % (
        data["unicodeVersion"],
        data["ranges"],
        data["singles"],
        multi_entries,
        data["format"],
    )
    return HEADER + body + FOOTER.replace("__MULTI_WIDTH__", str(MULTI_WIDTH))


def main() -> int:
    """重新生成 pwa/casefold.js，或用 --check 确认现有文件是最新的。

    之前这里只读 sys.argv[1] 当输出路径，于是 `--check` 会被当成文件名，
    在当前目录写下一个叫 `--check` 的文件、还打印"已写入"——看上去像成功，
    实际既没校验也没更新目标文件。参数必须显式识别。
    """
    arguments = [item for item in sys.argv[1:]]
    check_only = False
    if arguments and arguments[0] in {"--check", "-c"}:
        check_only = True
        arguments = arguments[1:]
    if len(arguments) > 1:
        raise SystemExit("用法：python3 tools/generate_casefold.py [--check] [输出路径]")
    # 任何以 - 开头的残余参数都是拼错的选择项（比如 --chck）。必须报错：
    # 当成路径处理会在当前目录写下一个叫 "--chck" 的文件，命令还退出 0，
    # 看起来像成功，实际什么都没做。
    if arguments and arguments[0].startswith("-"):
        raise SystemExit(
            "无法识别的选项 %r。用法：python3 tools/generate_casefold.py [--check] [输出路径]"
            % arguments[0]
        )

    output = Path(arguments[0]) if arguments else DEFAULT_OUTPUT
    data = build_data()
    rendered = render(data)

    if check_only:
        # 没有文件时报错而不是"帮你生成一份"：调用方要的是校验结果。
        if not output.exists():
            raise SystemExit("pwa/casefold.js 不存在，先运行：python3 tools/generate_casefold.py")
        if output.read_text(encoding="utf-8") != rendered:
            raise SystemExit(
                "%s 与当前 Python 的 Unicode 数据不一致，请重新生成：\n"
                "  python3 tools/generate_casefold.py\n"
                "  python3 tests/test_casefold_parity.py" % output
            )
        print("OK - %s 与 Python %s 的 Unicode 数据一致" % (output, data["unicodeVersion"]))
        return 0

    output.write_text(rendered, encoding="utf-8")
    counts = data["counts"]
    print(
        "已写入 %s（Unicode %s）：单点映射 %d 个（%d 个区间覆盖 %d 个码点 + %d 个零散条目），"
        "多点映射 %d 个，Cf 区间 %d 段"
        % (
            output,
            data["unicodeVersion"],
            counts["rangePoints"] + counts["singleCount"],
            counts["rangeCount"],
            counts["rangePoints"],
            counts["singleCount"],
            counts["multiCount"],
            counts["formatRangeCount"],
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
