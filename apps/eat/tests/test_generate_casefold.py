#!/usr/bin/env python3
"""tools/generate_casefold.py 的命令行行为测试。

为什么值得单独一个测试文件：这个脚本的产物是**生成的**，所以"重新生成一遍结果
一样吗"和"参数用错的时候会不会悄悄做错事"都需要有人守着。写这个文件时就在
`--check` 上抓到一个真实缺陷：脚本原本直接把 `sys.argv[1]` 当输出路径，于是
`--check` 被当成文件名，在当前目录写下一个叫 `--check` 的文件、还打印"已写入
xxx"——命令看起来成功了，实际既没校验也没更新目标文件。这类"静默做错事"的
参数处理问题,只看退出码是发现不了的。

用 tempfile 建临时目录来跑，不往项目目录写任何文件。

用法：python3 tests/test_generate_casefold.py
"""

from __future__ import annotations

import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent
GENERATOR = PROJECT_ROOT / "tools" / "generate_casefold.py"
CASEFOLD_JS = PROJECT_ROOT / "pwa" / "casefold.js"

failures: list[str] = []
checks = 0


def check(name: str, condition: bool, detail: str = "") -> None:
    global checks
    checks += 1
    if condition:
        print("ok   - %s" % name)
    else:
        failures.append(name)
        print("FAIL - %s" % name)
        if detail:
            print("       " + detail)


def run(arguments: list[str]) -> subprocess.CompletedProcess:
    return subprocess.run(
        [sys.executable, str(GENERATOR)] + arguments,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        cwd=str(PROJECT_ROOT),
        check=False,
    )


def main() -> int:
    if not GENERATOR.exists():
        raise SystemExit("找不到 %s" % GENERATOR)

    # 先固定"真实文件是最新的"这个前提：后面几条对比都建立在它成立之上。
    fresh = run(["--check"])
    check(
        "--check 在文件最新时退出 0",
        fresh.returncode == 0,
        "退出码 %d，输出：%s" % (fresh.returncode, fresh.stdout.decode("utf-8", "replace")),
    )

    # 这一条就是当初的缺陷：--check 被当成文件名，在项目目录里写出一个叫
    # `--check` 的文件。断言项目目录里没有它。
    check(
        "--check 不会在项目目录里留下名为 --check 的文件",
        not (PROJECT_ROOT / "--check").exists(),
        "项目根目录出现了 --check 文件：参数被当成输出路径了",
    )

    with tempfile.TemporaryDirectory() as workdir:
        temporary = Path(workdir)

        # 生成到临时路径：内容必须和仓库里那份逐字节一致，否则说明生成结果
        # 依赖了输出路径之外的东西，或者有人手改过生成的产物。
        output = temporary / "casefold.js"
        generated = run([str(output)])
        check("生成到指定路径时退出 0", generated.returncode == 0)
        check("生成的文件存在", output.exists())
        check(
            "临时生成的产物与仓库里的 pwa/casefold.js 逐字节一致",
            output.exists() and output.read_bytes() == CASEFOLD_JS.read_bytes(),
            "生成结果和仓库里的不一致：要么有人手改了产物，要么生成逻辑不稳定",
        )

        # 对这个临时文件跑 --check 应该通过：说明 --check 认的是"内容一致"，
        # 而不是"路径是 pwa/casefold.js"。
        checked = run(["--check", str(output)])
        check(
            "--check 接受显式传入的路径",
            checked.returncode == 0,
            checked.stdout.decode("utf-8", "replace") + checked.stderr.decode("utf-8", "replace"),
        )

        # 内容被改动后必须报错，而且退出码非 0——否则 CI 里没人会发现漂移。
        drifted = temporary / "drifted.js"
        drifted.write_text(CASEFOLD_JS.read_text(encoding="utf-8") + "\n// 人为改动\n", encoding="utf-8")
        drift_check = run(["--check", str(drifted)])
        check(
            "内容不一致时 --check 退出非 0",
            drift_check.returncode != 0,
            "退出码 %d，期望非 0" % drift_check.returncode,
        )
        message = (drift_check.stdout + drift_check.stderr).decode("utf-8", "replace")
        check(
            "漂移的报错里给出了重新生成的命令",
            "generate_casefold.py" in message,
            "报错信息没有告诉人怎么修：%r" % message,
        )

        # 文件不存在时也要报错：不能"顺手帮你生成一份"，--check 的语义是校验。
        missing = run(["--check", str(temporary / "nope.js")])
        check(
            "--check 对不存在的文件退出非 0",
            missing.returncode != 0,
            "退出码 %d，期望非 0" % missing.returncode,
        )
        check(
            "--check 不会顺手创建缺失的文件",
            not (temporary / "nope.js").exists(),
            "校验模式下创建了文件：这会让调用方误以为校验通过了",
        )

        # 多余的参数要报错，不能猜。
        too_many = run([str(temporary / "a.js"), str(temporary / "b.js")])
        check(
            "多余的参数被拒绝",
            too_many.returncode != 0 and not (temporary / "a.js").exists(),
            "退出码 %d；a.js 存在=%s" % (too_many.returncode, (temporary / "a.js").exists()),
        )

        # 参数写错时也不能在当前工作目录（项目根）留下垃圾。
        before = set(PROJECT_ROOT.iterdir())
        run(["--chck"])
        run(["-x"])
        after = set(PROJECT_ROOT.iterdir())
        check(
            "非法参数不会在项目根目录留下文件",
            before == after,
            "多出来的条目：%s" % sorted(str(item) for item in after - before),
        )

    # 生成一次默认目标，确认不带参数时的行为仍然正确（这就是文档里写的用法）。
    # 先记下内容：重新生成必须得到逐字节相同的结果，否则"重新生成一次"本身
    # 就是在改产物，diff 里会出现看不懂的变化。
    before_bytes = CASEFOLD_JS.read_bytes()
    regenerated = run([])
    check("不带参数时按默认路径生成成功", regenerated.returncode == 0)
    check(
        "重新生成默认目标后内容逐字节不变",
        CASEFOLD_JS.read_bytes() == before_bytes,
        "重新生成改变了内容：生成逻辑不稳定，每次跑都会产生 diff",
    )
    # 顺手确认现在又能通过校验（生成和校验必须自洽）。
    check("重新生成后 --check 通过", run(["--check"]).returncode == 0)

    print("")
    if failures:
        print("%d 个用例失败，共 %d 个通过" % (len(failures), checks - len(failures)))
        return 1
    print("ok   - generate_casefold 测试全部通过（%d 个用例）" % checks)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
