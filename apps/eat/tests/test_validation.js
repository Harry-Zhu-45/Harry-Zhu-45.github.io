#!/usr/bin/env node
"use strict";

/*
 * pwa/validation.js 的单元测试。
 *
 * 规则一致性由 tests/test_validation_parity.py 对照 database.py 全量验证，
 * 这个文件负责另一件事：**接口契约**。index.js 会直接读 error.message、
 * 会依赖返回值的形状，这些在"结果对不对"里测不出来。
 *
 * 时间相关的用例把时区固定成 Asia/Shanghai（和 tests/test_render.js 一致）：
 * 不加时区的时间戳按本地时区解释，"本地时区"这条分支在 TZ=UTC 下会退化成
 * 恒真，等于没测。
 */

process.env.TZ = "Asia/Shanghai";

const assert = require("node:assert/strict");
const path = require("node:path");

const AppValidation = require(path.join(__dirname, "..", "pwa", "validation.js"));
const AppCasefold = require(path.join(__dirname, "..", "pwa", "casefold.js"));

let checks = 0;
const failures = [];

function test(name, body) {
    try {
        body();
        checks += 1;
        console.log("ok   - " + name);
    } catch (error) {
        failures.push({ name: name, error: error });
        console.log("FAIL - " + name);
        console.log("       " + (error && error.message));
    }
}

function throwsWith(kind, message, body) {
    let thrown = null;
    try {
        body();
    } catch (error) {
        thrown = error;
    }
    assert.ok(thrown, "期望抛出 " + kind.name + "，但没有抛");
    assert.ok(
        thrown instanceof kind,
        "期望 " + kind.name + "，实际是 " + thrown.name + "：" + thrown.message
    );
    assert.strictEqual(thrown.message, message);
}

// --------------------------------------------------------------------------
// normalizeFood
// --------------------------------------------------------------------------

test("normalizeFood 压掉多余空白并 trim", function() {
    assert.strictEqual(AppValidation.normalizeFood("  快餐  "), "快餐");
    // NBSP（U+00A0）和全角空格（U+3000）都是 Zs：JS 和 Python 的 \s 都认它们，
    // 会被压成一个普通空格。不压的话「KFC 炸鸡」会有一堆长得一样的变体。
    assert.strictEqual(AppValidation.normalizeFood("KFC\u00a0\u00a0炸鸡"), "KFC 炸鸡");
    assert.strictEqual(AppValidation.normalizeFood("KFC\u3000炸鸡"), "KFC 炸鸡");
    assert.strictEqual(AppValidation.normalizeFood("快餐\u3000"), "快餐");
});

test("制表符和换行属于控制字符，是拒绝而不是压成空格", function() {
    // 这一条容易想当然：\t 和 \n 看起来"只是空白"，但 Unicode 类别是 Cc，
    // 和 NUL 同类。database.py 走的是"先拒绝 Cc/Cs"，压根到不了压空白那一步，
    // 所以这里也必须拒绝，否则同一个名字电脑拒绝、手机收下。
    ["KFC\t\t炸鸡", "a\n\nb", "a\rb"].forEach(function(value) {
        throwsWith(AppValidation.ValidationError, "食物名称不能包含控制字符", function() {
            AppValidation.normalizeFood(value);
        });
    });
});

test("normalizeFood 做 NFC 归一，组合形和分解形是同一个名字", function() {
    assert.strictEqual(AppValidation.normalizeFood("é"), "é");
    assert.strictEqual(AppValidation.normalizeFood("e\u0301"), "é");
    // 这才是重点：两种写法去重键必须相同，否则会变成两个候选项。
    assert.strictEqual(
        AppValidation.foldedKey(AppValidation.normalizeFood("é")),
        AppValidation.foldedKey(AppValidation.normalizeFood("e\u0301"))
    );
});

test("normalizeFood 删掉不可见格式字符（Cf）", function() {
    // 零宽空格、BOM、soft hyphen 都是 Cf：不删的话「KFC」和「KFC」是两个名字。
    assert.strictEqual(AppValidation.normalizeFood("a\u200bb"), "ab");
    assert.strictEqual(AppValidation.normalizeFood("a\ufeffb"), "ab");
    assert.strictEqual(AppValidation.normalizeFood("a\u00adb"), "ab");
    // U+E0001 在星平面：这一条会用到 String.fromCodePoint 那一侧的分支。
    assert.strictEqual(AppValidation.normalizeFood("a\u{E0001}b"), "ab");
});

test("normalizeFood 拒绝控制字符（Cc/Cs）而不是删掉", function() {
    throwsWith(AppValidation.ValidationError, "食物名称不能包含控制字符", function() {
        AppValidation.normalizeFood("a\u0000b");
    });
    throwsWith(AppValidation.ValidationError, "食物名称不能包含控制字符", function() {
        AppValidation.normalizeFood("a\u001fb");
    });
});

test("normalizeFood 只删 Cf 之后变空也要拒绝", function() {
    throwsWith(AppValidation.ValidationError, "食物名称不能为空", function() {
        AppValidation.normalizeFood("\u200b");
    });
    throwsWith(AppValidation.ValidationError, "食物名称不能为空", function() {
        AppValidation.normalizeFood("   ");
    });
    throwsWith(AppValidation.ValidationError, "食物名称不能为空", function() {
        AppValidation.normalizeFood("");
    });
});

test("normalizeFood 按码点数算长度，emoji 不算两个字符", function() {
    // 40 个 emoji 是 80 个 UTF-16 单元、但只有 40 个码点，必须通过；
    // 用 .length 判断的话这里会被错误地拒绝。
    assert.strictEqual(AppValidation.normalizeFood("😀".repeat(40)).length, 80);
    throwsWith(AppValidation.ValidationError, "食物名称不能超过 40 个字符", function() {
        AppValidation.normalizeFood("😀".repeat(41));
    });
    throwsWith(AppValidation.ValidationError, "食物名称不能超过 40 个字符", function() {
        AppValidation.normalizeFood("x".repeat(41));
    });
});

test("normalizeFood 拒绝非文本输入", function() {
    [null, undefined, 42, {}, [], true].forEach(function(value) {
        throwsWith(AppValidation.ValidationError, "食物名称必须是文本", function() {
            AppValidation.normalizeFood(value);
        });
    });
});

// --------------------------------------------------------------------------
// foldedKey
// --------------------------------------------------------------------------

test("foldedKey 用完整 casefold，不是 toLowerCase", function() {
    // 「ß」toLowerCase 之后还是「ß」，casefold 之后是「ss」。
    // 用 toLowerCase 的话「Straße」和「STRASSE」在电脑上算重复、手机上算两个。
    assert.strictEqual(AppValidation.foldedKey("Straße"), "strasse");
    assert.strictEqual(AppValidation.foldedKey("STRASSE"), "strasse");
    assert.strictEqual(AppValidation.foldedKey("ﬁle"), "file");
    assert.notStrictEqual("ß".toLowerCase(), AppValidation.foldedKey("ß"));
});

test("foldedKey 把希腊语尾 sigma 折叠成普通 sigma", function() {
    // casefold 没有上下文规则：词尾的 ς 也变成 σ（toLowerCase 反而会按词尾
    // 保留 ς）。这条差异说明"逐码点折叠 == 整串折叠"这个前提在 casefold 下成立，
    // 也说明大写 Σ 和小写 ς 写出来的同一个词必须共用一条去重键。
    assert.strictEqual(AppValidation.foldedKey("ΣΊΣΥΦΟΣ"), "σίσυφοσ");
    assert.strictEqual(AppValidation.foldedKey("σίσυφος"), "σίσυφοσ");
    assert.strictEqual(AppValidation.foldedKey("Σίσυφος"), "σίσυφοσ");
    // 反过来说：这里用 toLowerCase 会得到 "σίσυφος"，和上面不一致。
    assert.notStrictEqual("ΣΊΣΥΦΟΣ".toLowerCase(), "σίσυφοσ");
});

// --------------------------------------------------------------------------
// parseTimestamp
// --------------------------------------------------------------------------

test("parseTimestamp 统一输出毫秒精度 + Z", function() {
    assert.strictEqual(AppValidation.parseTimestamp("2026-10-05T18:08:24Z"), "2026-10-05T18:08:24.000Z");
    assert.strictEqual(
        AppValidation.parseTimestamp("2026-10-05T18:08:24.1Z"),
        "2026-10-05T18:08:24.100Z"
    );
    // 9 位小数截到毫秒，不是四舍五入、也不是报错。
    assert.strictEqual(
        AppValidation.parseTimestamp("2026-10-05T18:08:24.123456789Z"),
        "2026-10-05T18:08:24.123Z"
    );
});

test("parseTimestamp 把带偏移的时间换算成 UTC", function() {
    assert.strictEqual(
        AppValidation.parseTimestamp("2026-10-05T18:08:24+08:00"),
        "2026-10-05T10:08:24.000Z"
    );
    assert.strictEqual(
        AppValidation.parseTimestamp("2026-10-05T18:08:24+0800"),
        "2026-10-05T10:08:24.000Z"
    );
    assert.strictEqual(
        AppValidation.parseTimestamp("2026-10-05T18:08:24+08"),
        "2026-10-05T10:08:24.000Z"
    );
});

test("parseTimestamp 把不带时区的时间按本地时区解释", function() {
    // Asia/Shanghai 是 UTC+8：18:08 本地 = 10:08 UTC。
    assert.strictEqual(
        AppValidation.parseTimestamp("2026-10-05T18:08:24"),
        "2026-10-05T10:08:24.000Z"
    );
    assert.strictEqual(AppValidation.parseTimestamp("2026-10-05"), "2026-10-04T16:00:00.000Z");
});

test("parseTimestamp 年份校验在换算成 UTC 之后", function() {
    // 本地看是 1970 年，UTC 之后是 1969 年：必须拒绝，否则导出的备份
    // 再导入时会被自己的校验拒绝。
    throwsWith(
        AppValidation.ValidationError,
        "选择时间必须在 1970 至 2100 年之间",
        function() {
            AppValidation.parseTimestamp("1970-01-01T00:00:00+14:00");
        }
    );
    // 边界本身要接受。
    assert.strictEqual(
        AppValidation.parseTimestamp("1970-01-01T00:00:00Z"),
        "1970-01-01T00:00:00.000Z"
    );
    assert.strictEqual(
        AppValidation.parseTimestamp("2100-12-31T23:59:59Z"),
        "2100-12-31T23:59:59.000Z"
    );
});

test("parseTimestamp 区分「压根没法表示」和「超出年限」", function() {
    // Python 的 datetime 到 9999 年为止，时区换算越界抛 OverflowError，
    // 报的是"超出允许范围"；9999 年本身能表示、只是超过 2100，报的是年限。
    throwsWith(AppValidation.ValidationError, "选择时间超出允许范围", function() {
        AppValidation.parseTimestamp("9999-12-31T23:59:59-14:00");
    });
    throwsWith(
        AppValidation.ValidationError,
        "选择时间必须在 1970 至 2100 年之间",
        function() {
            AppValidation.parseTimestamp("9999-12-31T23:59:59Z");
        }
    );
});

test("parseTimestamp 拒绝不存在的日期和时间", function() {
    ["2026-02-30T00:00:00Z", "2026-13-01T00:00:00Z", "2026-02-29T00:00:00Z",
     "2026-10-05T25:00:00Z", "2026-10-05T18:60:00Z"].forEach(function(value) {
        throwsWith(AppValidation.ValidationError, "选择时间无效", function() {
            AppValidation.parseTimestamp(value);
        });
    });
    // 闰年的 2 月 29 日要接受。
    assert.strictEqual(
        AppValidation.parseTimestamp("2024-02-29T00:00:00Z"),
        "2024-02-29T00:00:00.000Z"
    );
});

test("parseTimestamp 只接受大写的 T/Z", function() {
    // 小写 t/z 在 Python 的 fromisoformat 里也是非法的：两边都要拒绝，
    // 否则手写的备份在电脑上被拒、在手机上被收下。
    throwsWith(AppValidation.ValidationError, "选择时间无效", function() {
        AppValidation.parseTimestamp("2026-10-05t18:08:24z");
    });
});

test("parseTimestamp 的 fallback 只在格式不认识时生效", function() {
    const fallback = "2026-01-01T00:00:00.000Z";
    assert.strictEqual(AppValidation.parseTimestamp("", fallback), fallback);
    assert.strictEqual(AppValidation.parseTimestamp("不是时间", fallback), fallback);
    assert.strictEqual(AppValidation.parseTimestamp(undefined, fallback), fallback);
    // 年份越界**不能**被 fallback 盖过去：那是真实数据，静默改成兜底值
    // 等于把用户的记录时间悄悄换掉。
    throwsWith(
        AppValidation.ValidationError,
        "选择时间必须在 1970 至 2100 年之间",
        function() {
            AppValidation.parseTimestamp("2101-01-01T00:00:00Z", fallback);
        }
    );
});

test("parseTimestamp 拒绝非文本输入", function() {
    [null, 42, {}, []].forEach(function(value) {
        throwsWith(AppValidation.ValidationError, "选择时间无效", function() {
            AppValidation.parseTimestamp(value);
        });
    });
});

// --------------------------------------------------------------------------
// 编辑 / 删除窗口
// --------------------------------------------------------------------------

test("可编辑窗口是今天加前 4 个本地日", function() {
    const now = new Date();
    function daysAgo(days) {
        const moment = new Date(now.getTime() - days * 86400000);
        return moment.toISOString();
    }
    assert.strictEqual(AppValidation.isEditableTimestamp(daysAgo(0)), true, "今天可编辑");
    assert.strictEqual(AppValidation.isEditableTimestamp(daysAgo(4)), true, "第 5 天（含今天）可编辑");
    assert.strictEqual(AppValidation.isEditableTimestamp(daysAgo(6)), false, "第 6 天以上不可编辑");
});

test("损坏和未来的时间戳不可编辑但可删除", function() {
    ["坏掉了", "", "2026-13-45T00:00:00Z"].forEach(function(timestamp) {
        assert.strictEqual(AppValidation.isEditableTimestamp(timestamp), false, "损坏的不可编辑");
        assert.strictEqual(
            AppValidation.isDeletableTimestamp(timestamp), true,
            "损坏的必须可删除，否则用户只能清空全部历史"
        );
    });
    const tomorrow = new Date(Date.now() + 86400000).toISOString();
    assert.strictEqual(AppValidation.isEditableTimestamp(tomorrow), false, "未来时间不可编辑");
    assert.strictEqual(AppValidation.isDeletableTimestamp(tomorrow), true, "未来时间可删除");
});

test("窗口外的旧记录可查看但不可编辑/删除", function() {
    const old = new Date(Date.now() - 30 * 86400000).toISOString();
    assert.strictEqual(AppValidation.isEditableTimestamp(old), false);
    assert.strictEqual(AppValidation.isDeletableTimestamp(old), false);
});

// --------------------------------------------------------------------------
// normalizeHistoryItem
// --------------------------------------------------------------------------

test("normalizeHistoryItem 接受驼峰和下划线两种时间字段", function() {
    const camel = AppValidation.normalizeHistoryItem({
        id: "a", food: "快餐", selectedAt: "2026-10-05T18:08:24.123Z"
    });
    const snake = AppValidation.normalizeHistoryItem({
        id: "a", food: "快餐", selected_at: "2026-10-05T18:08:24.123Z"
    });
    assert.deepStrictEqual(camel, snake);
});

test("normalizeHistoryItem 缺 id 时生成 32 位十六进制 id", function() {
    const record = AppValidation.normalizeHistoryItem({
        food: "快餐", selectedAt: "2026-10-05T18:08:24.123Z"
    });
    assert.match(record.id, /^[0-9a-f]{32}$/);
    // 两次生成必须不同，否则两条记录会互相覆盖。
    const other = AppValidation.normalizeHistoryItem({
        food: "快餐", selectedAt: "2026-10-05T18:08:24.123Z"
    });
    assert.notStrictEqual(record.id, other.id);
});

test("normalizeHistoryItem 拒绝过长的 id 和非对象输入", function() {
    throwsWith(AppValidation.ValidationError, "历史记录 ID 无效", function() {
        AppValidation.normalizeHistoryItem({ id: "x".repeat(201), food: "快餐" });
    });
    throwsWith(AppValidation.ValidationError, "历史记录格式无效", function() {
        AppValidation.normalizeHistoryItem([1, 2, 3]);
    });
    throwsWith(AppValidation.ValidationError, "历史记录格式无效", function() {
        AppValidation.normalizeHistoryItem(42);
    });
});

test("normalizeHistoryItem 的 allowString 处理旧的纯字符串历史", function() {
    const record = AppValidation.normalizeHistoryItem("  快餐  ", { allowString: true });
    assert.strictEqual(record.food, "快餐");
    assert.match(record.id, /^[0-9a-f]{32}$/);
    // 没开这个选项时，字符串必须被当作格式无效。
    throwsWith(AppValidation.ValidationError, "历史记录格式无效", function() {
        AppValidation.normalizeHistoryItem("快餐");
    });
});

// --------------------------------------------------------------------------
// cleanMetaValues / prepareImport
// --------------------------------------------------------------------------

test("cleanMetaValues 分别统计无效和重复", function() {
    const outcome = AppValidation.cleanMetaValues(["KFC", "kfc", " KFC ", "", 42, "x".repeat(41)], "alias");
    assert.deepStrictEqual(outcome.values, ["KFC"]);
    assert.strictEqual(outcome.duplicate, 2, "kfc 和 ' KFC ' 是重复");
    assert.strictEqual(outcome.invalid, 3, "空串、非文本、超长各算一条无效");
});

test("cleanMetaValues 超过上限的条目算无效", function() {
    const outcome = AppValidation.cleanMetaValues(
        Array.from({ length: 25 }, function(unused, index) { return "别名" + index; }), "alias"
    );
    assert.strictEqual(outcome.values.length, AppValidation.MAX_CHOICE_META_ITEMS);
    assert.strictEqual(outcome.invalid, 25 - AppValidation.MAX_CHOICE_META_ITEMS);
    assert.strictEqual(outcome.duplicate, 0);
});

test("cleanMetaValues 容忍缺失和非数组", function() {
    assert.deepStrictEqual(AppValidation.cleanMetaValues(undefined, "alias"), {
        values: [], invalid: 0, duplicate: 0
    });
    assert.deepStrictEqual(AppValidation.cleanMetaValues("不是数组", "alias"), {
        values: [], invalid: 1, duplicate: 0
    });
});

test("prepareImport 拒绝各种不合法的备份", function() {
    throwsWith(AppValidation.ValidationError, "备份文件必须是 JSON 对象", function() {
        AppValidation.prepareImport(null);
    });
    throwsWith(AppValidation.ValidationError, "备份文件必须是 JSON 对象", function() {
        AppValidation.prepareImport([1, 2]);
    });
    throwsWith(AppValidation.ValidationError, "不是本应用的备份文件", function() {
        AppValidation.prepareImport({ app: "别的应用", schemaVersion: 2, choices: [], history: [] });
    });
    throwsWith(AppValidation.ValidationError, "不支持的备份版本", function() {
        // v1 备份不再被接受：字段结构不同，硬导会把别名标签丢掉。
        AppValidation.prepareImport({ app: "what-should-we-eat", schemaVersion: 1, choices: [], history: [] });
    });
    throwsWith(AppValidation.ValidationError, "备份必须包含 choices 和 history 数组", function() {
        AppValidation.prepareImport({ app: "what-should-we-eat", schemaVersion: 2 });
    });
    throwsWith(AppValidation.ValidationError, "备份中没有可导入的有效数据", function() {
        AppValidation.prepareImport({
            app: "what-should-we-eat", schemaVersion: 2,
            choices: [null, 42, { name: "" }], history: [{ food: "" }]
        });
    });
});

test("prepareImport 的摘要在重复导入时统计正确", function() {
    const outcome = AppValidation.prepareImport({
        app: "what-should-we-eat",
        schemaVersion: 2,
        choices: [
            { name: "快餐", aliases: ["KFC", "kfc"], tags: ["油腻"] },
            { name: "快餐", aliases: [], tags: [] },
            { name: "ＫＦＣ", aliases: [], tags: [] },
            { name: "x".repeat(41) }
        ],
        history: [
            { id: "h1", food: "快餐", selectedAt: "2026-10-05T18:08:24.123Z" },
            { id: "h1", food: "快餐", selectedAt: "2026-10-05T18:08:24.123Z" },
            { id: "h2", food: "快餐", selectedAt: "坏时间" }
        ]
    });
    assert.deepStrictEqual(outcome.summary, {
        choiceCount: 2,       // 快餐、ＫＦＣ（全角和半角是两个不同的名字）
        historyCount: 1,
        aliasCount: 1,        // "kfc" 是 "KFC" 的重复
        tagCount: 1,
        // 超长的名字 1 条 + 时间戳坏掉的 h2 1 条。
        invalidCount: 2,
        // 重复的候选项「快餐」、重复的别名「kfc」、重复的 history id「h1」。
        duplicateCount: 3
    });
    // 和 database.py 的实际输出对齐过（tests/test_validation_parity.py
    // 里同一份载荷是逐字段对照的），这里只是把数字固定在测试里，
    // 免得有人"顺手修正"成看起来更整齐的值。
});

test("summarizeAgainstExisting 只把内容不同的同 id 算作冲突", function() {
    const summary = { choiceCount: 2, historyCount: 2, aliasCount: 0, tagCount: 0, invalidCount: 0, duplicateCount: 0 };
    const cleaned = {
        choices: [{ name: "快餐", aliases: [], tags: [] }, { name: "新食物", aliases: [], tags: [] }],
        history: [
            { id: "h1", food: "快餐", selectedAt: "2026-10-05T18:08:24.123Z" },
            { id: "h2", food: "改过了", selectedAt: "2026-10-05T18:08:24.123Z" }
        ]
    };
    const outcome = AppValidation.summarizeAgainstExisting(
        summary, cleaned,
        { [AppValidation.foldedKey("快餐")]: true },
        { h1: ["快餐", "2026-10-05T18:08:24.123Z"], h2: ["原来的", "2026-10-05T18:08:24.123Z"] }
    );
    assert.strictEqual(outcome.existingChoiceCount, 1);
    // 幂等重放（同一个 id、同样的内容）不算冲突，否则用户会以为出了问题。
    assert.strictEqual(outcome.historyIdConflictCount, 1);
    // 原摘要的字段不能丢：index.js 的预览要用它们。
    assert.strictEqual(outcome.choiceCount, 2);
});

// --------------------------------------------------------------------------
// buildExportPayload
// --------------------------------------------------------------------------

test("buildExportPayload 只写后端无关的字段", function() {
    const payload = AppValidation.buildExportPayload(
        [{ name: "快餐", aliases: [{ id: 1, alias: "KFC" }], tags: [{ id: 2, tag: "油腻" }] }],
        [{ id: "h1", food: "快餐", selectedAt: "2026-10-05T18:08:24.123Z", editable: true, deletable: true }],
        "2026-10-05T00:00:00.000Z"
    );
    assert.strictEqual(payload.app, "what-should-we-eat");
    assert.strictEqual(payload.schemaVersion, 2);
    assert.deepStrictEqual(payload.choices, [{ name: "快餐", aliases: ["KFC"], tags: ["油腻"] }]);
    // editable/deletable 是后端算出来的，写进备份会让两边口径分叉。
    assert.deepStrictEqual(payload.history, [
        { id: "h1", food: "快餐", selectedAt: "2026-10-05T18:08:24.123Z" }
    ]);
    // 导出的东西必须能被自己导入（版本、app 字段一致）。
    const roundTrip = AppValidation.prepareImport(payload);
    assert.strictEqual(roundTrip.summary.choiceCount, 1);
    assert.strictEqual(roundTrip.summary.historyCount, 1);
});

test("utcNow 是毫秒精度 + Z，且能被自己解析", function() {
    const now = AppValidation.utcNow();
    assert.match(now, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    assert.strictEqual(AppValidation.parseTimestamp(now), now);
});

test("错误类都是 Error 的子类，且 instanceof 可用", function() {
    // index.js 只读 message，但 database.js 要按类型区分"业务拒绝"和"存储故障"。
    [AppValidation.ValidationError, AppValidation.ConflictError, AppValidation.NotFoundError]
        .forEach(function(Kind) {
            const error = new Kind("试试");
            assert.ok(error instanceof Error);
            assert.ok(error instanceof Kind);
            assert.strictEqual(error.message, "试试");
            assert.strictEqual(error.name, Kind.name);
        });
});

// --------------------------------------------------------------------------
// 和 casefold.js 的接线
// --------------------------------------------------------------------------

test("validation 依赖的 casefold 接口齐全", function() {
    ["foldString", "isFormatCodePoint", "isForbiddenCodePoint"].forEach(function(name) {
        assert.strictEqual(typeof AppCasefold[name], "function", name + " 应该存在");
    });
});

console.log("");
if (failures.length) {
    console.log(failures.length + " 个用例失败，共 " + checks + " 个通过");
    process.exitCode = 1;
} else {
    console.log("ok   - validation 测试全部通过（" + checks + " 个用例）");
}
