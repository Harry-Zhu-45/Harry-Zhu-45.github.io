#!/usr/bin/env node
"use strict";

/*
 * pwa/store.js 的单元测试：业务状态的纯函数层。
 *
 * 为什么要单独测这一层（而不是只测 database.js）：database.js 的每个操作
 * 都开一个事务，出问题时很难说清是"规则算错了"还是"事务没提交"。
 * store.js 全是同步纯函数，能直接摆出状态、调一次、断言结果——
 * 「覆盖导入之后 position 有没有重排」「合并导入两次会不会翻倍」这类问题
 * 在这里一眼就能看清。
 *
 * 数据全部是合成的，不碰任何真实文件。
 */

process.env.TZ = "Asia/Shanghai";

const assert = require("node:assert/strict");
const path = require("node:path");

const AppStore = require(path.join(__dirname, "..", "pwa", "store.js"));
const AppValidation = require(path.join(__dirname, "..", "pwa", "validation.js"));

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
    if (message !== undefined) {
        assert.strictEqual(thrown.message, message);
    }
}

// 固定业务测试数据，避免业务规则测试依赖产品默认可选项。
const TEST_CHOICES = [
    "Yam and egg", "Jollof rice", "Bread and egg", "Cereal",
    "Indomie", "Beans", "Efo riro", "Ofada rice and stew"
];
function seededState() {
    const state = AppStore.createEmptyState();
    TEST_CHOICES.forEach(function(name) { AppStore.addChoice(state, name); });
    state.meta.initialized = true;
    return state;
}

function timestampDaysAgo(days) {
    return new Date(Date.now() - days * 86400000).toISOString();
}

// --------------------------------------------------------------------------
// 初始化
// --------------------------------------------------------------------------

test("initializeIfNeeded 只在第一次播种默认候选项", function() {
    const state = AppStore.createEmptyState();
    const first = AppStore.initializeIfNeeded(state);
    assert.strictEqual(first.seeded, AppValidation.DEFAULT_CHOICES.length);
    assert.strictEqual(state.choices.length, AppValidation.DEFAULT_CHOICES.length);
    // 位置从 0 开始连续，渲染顺序才是稳定的。
    assert.deepStrictEqual(state.choices.map(function(choice) { return choice.position; }),
        AppValidation.DEFAULT_CHOICES.map(function(_, index) { return index; }));

    assert.deepStrictEqual(AppStore.buildExport(state).choices, AppValidation.DEFAULT_CHOICE_DATA);
    assert.deepStrictEqual(state.history, []);

    const second = AppStore.initializeIfNeeded(state);
    assert.strictEqual(second.seeded, 0);
    assert.strictEqual(state.choices.length, AppValidation.DEFAULT_CHOICES.length);
});

test("候选项被删光之后不会再重新播种", function() {
    const state = seededState();
    state.choices.slice().forEach(function(choice) {
        AppStore.deleteChoice(state, choice.id);
    });
    assert.strictEqual(state.choices.length, 0);

    // 判据必须是 initialized 标记，不能是"列表为空"：用户删光候选项
    // 是合法状态，重新种一遍等于把删除操作撤销了。
    const outcome = AppStore.initializeIfNeeded(state);
    assert.strictEqual(outcome.seeded, 0);
    assert.strictEqual(state.choices.length, 0);
});

// --------------------------------------------------------------------------
// 候选项
// --------------------------------------------------------------------------

test("addChoice 规范化名字并按 casefold 去重", function() {
    const state = seededState();
    const added = AppStore.addChoice(state, "  肯德基  ");
    assert.strictEqual(added.choice.name, "肯德基");
    assert.strictEqual(added.choice.position, 8, "新候选项排在最后");

    // 大小写、全角、零宽字符都不能绕过去重。
    ["肯德基", "  肯德基", "肯德基\u200b"].forEach(function(variant) {
        throwsWith(AppStore.ConflictError, "不能添加重复的食物", function() {
            AppStore.addChoice(state, variant);
        });
    });
});

test("addChoice 用 casefold 而不是 toLowerCase 判定重复", function() {
    const state = AppStore.createEmptyState();
    AppStore.addChoice(state, "Straße");
    // toLowerCase 下 "STRASSE" 不等于 "straße"，会变成第二个候选项；
    // casefold 下两者相同，必须拒绝。
    throwsWith(AppStore.ConflictError, "不能添加重复的食物", function() {
        AppStore.addChoice(state, "STRASSE");
    });
    assert.strictEqual(state.choices.length, 1);
});

test("deleteChoice 删掉候选项和它的别名标签，但不动历史", function() {
    const state = seededState();
    const choice = AppStore.addChoice(state, "肯德基").choice;
    AppStore.addChoiceMeta(state, "aliases", choice.id, "KFC");
    AppStore.addChoiceMeta(state, "tags", choice.id, "快餐");
    AppStore.addHistory(state, "肯德基");
    assert.strictEqual(state.history.length, 1);

    AppStore.deleteChoice(state, choice.id);
    assert.strictEqual(AppStore.findChoice(state, choice.id), null);
    assert.strictEqual(state.choices.length, 8);
    // 吃过什么是发生过的事，不该因为改候选列表而消失。
    assert.strictEqual(state.history.length, 1);
    assert.strictEqual(state.history[0].food, "肯德基");
});

test("deleteChoice 对不存在的 id 抛 NotFoundError", function() {
    const state = seededState();
    throwsWith(AppStore.NotFoundError, "候选项不存在", function() {
        AppStore.deleteChoice(state, 99999);
    });
});

test("候选项 id 不会因为删除后重加而重复", function() {
    const state = seededState();
    const first = AppStore.addChoice(state, "临时").choice;
    AppStore.deleteChoice(state, first.id);
    const second = AppStore.addChoice(state, "另一个").choice;
    // 计数器只前进不后退：复用旧 id 会让别名挂到错的候选项上。
    assert.notStrictEqual(second.id, first.id);
    assert.ok(second.id > first.id);
});

// --------------------------------------------------------------------------
// 别名 / 标签
// --------------------------------------------------------------------------

test("addChoiceMeta 返回的形状和 server.py 一致", function() {
    const state = seededState();
    const choice = state.choices[0];
    const aliasResult = AppStore.addChoiceMeta(state, "aliases", choice.id, "KFC");
    assert.deepStrictEqual(aliasResult, { alias: { id: 1, alias: "KFC" } });
    const tagResult = AppStore.addChoiceMeta(state, "tags", choice.id, "快餐");
    assert.deepStrictEqual(tagResult, { tag: { id: 1, tag: "快餐" } });
});

test("addChoiceMeta 和食物名走同一套规范化", function() {
    const state = seededState();
    const choice = state.choices[0];
    AppStore.addChoiceMeta(state, "aliases", choice.id, "  KFC  ");
    // 零宽字符绕不过去重：否则同一个别名能挂两遍。
    throwsWith(AppStore.ConflictError, "该候选项已有这个别名", function() {
        AppStore.addChoiceMeta(state, "aliases", choice.id, "KFC\u200b");
    });
    throwsWith(AppStore.ConflictError, "该候选项已有这个别名", function() {
        AppStore.addChoiceMeta(state, "aliases", choice.id, "kfc");
    });
});

test("addChoiceMeta 的上限是每个候选项每种 20 个", function() {
    const state = seededState();
    const choice = state.choices[0];
    for (let index = 0; index < AppValidation.MAX_CHOICE_META_ITEMS; index += 1) {
        AppStore.addChoiceMeta(state, "aliases", choice.id, "别名" + index);
    }
    throwsWith(AppStore.ConflictError, "每个候选项最多 20 个别名", function() {
        AppStore.addChoiceMeta(state, "aliases", choice.id, "别名多一个");
    });
    // 标签是另一个配额，不该被别名占用。
    AppStore.addChoiceMeta(state, "tags", choice.id, "标签");
    assert.strictEqual(choice.tags.length, 1);
});

test("deleteChoiceMeta 删条目不删候选项", function() {
    const state = seededState();
    const choice = state.choices[0];
    const added = AppStore.addChoiceMeta(state, "aliases", choice.id, "KFC");
    assert.deepStrictEqual(AppStore.deleteChoiceMeta(state, "aliases", choice.id, added.alias.id),
        { deleted: true });
    assert.strictEqual(choice.aliases.length, 0);
    throwsWith(AppStore.NotFoundError, "别名不存在", function() {
        AppStore.deleteChoiceMeta(state, "aliases", choice.id, added.alias.id);
    });
});

test("别名只能在它所属的候选项上删除", function() {
    const state = seededState();
    const [first, second] = state.choices;
    const added = AppStore.addChoiceMeta(state, "aliases", first.id, "KFC");
    // 在另一个候选项上删同一个 id 必须报"不存在"，不能把别人的条目删掉。
    throwsWith(AppStore.NotFoundError, "别名不存在", function() {
        AppStore.deleteChoiceMeta(state, "aliases", second.id, added.alias.id);
    });
    assert.strictEqual(first.aliases.length, 1);
});

// --------------------------------------------------------------------------
// 和 database.py 的校验顺序 / id 强转
// --------------------------------------------------------------------------

test("addChoiceMeta 先校验食物名再查候选项（和 database.py 同序）", function() {
    // database.py 的 _add_choice_meta 顺序是：强转 id -> normalize_food -> 查候选项。
    // 反过来的话，"候选项不存在 + 值是空的"会报"候选项不存在"，
    // 而电脑版报"食物名称不能为空"。
    const state = seededState();
    throwsWith(AppValidation.ValidationError, "食物名称不能为空", function() {
        AppStore.addChoiceMeta(state, "aliases", 99999, "");
    });
    // 值合法时，才轮到"候选项不存在"。
    throwsWith(AppStore.NotFoundError, "候选项不存在", function() {
        AppStore.addChoiceMeta(state, "aliases", 99999, "KFC");
    });
});

test("deleteChoiceMeta 在候选项不存在时报「别名不存在」", function() {
    // database.py 的 _delete_choice_meta 只按 (id, choice_id) 删，
    // **不**先查候选项存不存在，所以两种情况都是"别名不存在"。
    const state = seededState();
    throwsWith(AppStore.NotFoundError, "别名不存在", function() {
        AppStore.deleteChoiceMeta(state, "aliases", 99999, 1);
    });
    throwsWith(AppStore.NotFoundError, "标签不存在", function() {
        AppStore.deleteChoiceMeta(state, "tags", 99999, 1);
    });
});

test("id 只能按十进制整数解析，不能像 Number() 那样乱转", function() {
    // 这是审查时抓到的真实缺陷：`Number("0x10")` 是 16，于是"删 id 0x10"
    // 会真的删掉 id 16 那条记录——不是报错文案不同，而是**静默操作到另一行**。
    // 电脑版的 int("0x10") 直接抛"条目 ID 无效"。
    const state = seededState();
    const choice = state.choices[0];
    const alias = AppStore.addChoiceMeta(state, "aliases", choice.id, "KFC").alias;

    // 十六进制、"3.0"、空串、null 一律拒绝。
    throwsWith(AppValidation.ValidationError, "条目 ID 无效", function() {
        AppStore.deleteChoiceMeta(state, "aliases", choice.id, "0x10");
    });
    ["3.0", "", "  ", null, undefined, true, {}, []].forEach(function(bad) {
        throwsWith(AppValidation.ValidationError, "条目 ID 无效", function() {
            AppStore.deleteChoiceMeta(state, "aliases", choice.id, bad);
        });
    });
    // 别名必须原样还在。
    assert.strictEqual(choice.aliases.length, 1);
    assert.strictEqual(choice.aliases[0].id, alias.id);

    // 候选项 id 同理。
    ["0x10", "", "3.0", null, true].forEach(function(bad) {
        throwsWith(AppValidation.ValidationError, "候选项 ID 无效", function() {
            AppStore.deleteChoice(state, bad);
        });
    });
    assert.strictEqual(state.choices.length, 8, "拒绝之后候选项一个都不能少");

    // 正常的十进制写法（数字、带空白的字符串、带正号）仍然接受。
    assert.deepStrictEqual(AppStore.deleteChoiceMeta(state, "aliases", choice.id, String(alias.id)),
        { deleted: true });
    const added = AppStore.addChoiceMeta(state, "aliases", choice.id, "KFC").alias;
    assert.deepStrictEqual(
        AppStore.deleteChoiceMeta(state, "aliases", String(choice.id), " " + added.id + " "),
        { deleted: true }
    );
});

test("导入过数据之后不会再播种默认候选项", function() {
    // 对着 database.py 的 apply_import：它会把 browser_v1_migrated 置成 true，
    // 之后 migrate_browser_data 不再播种。不置位的话，"先导入、再 initialize"
    // 会把默认候选项追加到用户刚导入的数据后面。
    const state = AppStore.createEmptyState();
    assert.strictEqual(state.meta.initialized, false);
    AppStore.applyImport(state, {
        app: "what-should-we-eat",
        schemaVersion: 2,
        choices: [{ name: "Zed", aliases: [], tags: [] }],
        history: []
    }, "merge");
    assert.strictEqual(state.meta.initialized, true, "导入之后要标记成已初始化");
    const outcome = AppStore.initializeIfNeeded(state);
    assert.strictEqual(outcome.seeded, 0);
    assert.strictEqual(state.choices.length, 1, "只剩导入进来的那一条");
});

// --------------------------------------------------------------------------
// 历史记录
// --------------------------------------------------------------------------

test("addHistory 记的是现在，并且立刻可编辑可删除", function() {
    const state = seededState();
    const added = AppStore.addHistory(state, "  肯德基  ");
    assert.strictEqual(added.record.food, "肯德基");
    assert.match(added.record.id, /^[0-9a-f]{32}$/);
    assert.strictEqual(added.record.editable, true);
    assert.strictEqual(added.record.deletable, true);
    // 时间戳是毫秒精度 + Z，和 Python 的 utc_now() 同一种口径。
    assert.match(added.record.selectedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
});

test("updateHistory 改食物和时间，窗口外的记录改不了", function() {
    const state = seededState();
    const record = AppStore.addHistory(state, "肯德基").record;
    const newTime = timestampDaysAgo(2);
    const updated = AppStore.updateHistory(state, record.id, "麦当劳", newTime);
    assert.strictEqual(updated.record.food, "麦当劳");
    assert.strictEqual(updated.record.selectedAt, newTime);

    // 窗口外的记录只能看：既不能改也不能删（"最近五天"的说法对两者都成立）。
    state.history.push({ id: "old", food: "很久以前", selectedAt: timestampDaysAgo(30), seq: 999 });
    throwsWith(AppValidation.ValidationError,
        "只能编辑最近 5 天（含今天）的历史记录", function() {
            AppStore.updateHistory(state, "old", "改了", newTime);
        });
    throwsWith(AppValidation.ValidationError,
        "只能删除最近 5 天（含今天）的历史记录", function() {
            AppStore.deleteHistory(state, "old");
        });
    assert.strictEqual(state.history.length, 2, "拒绝之后记录还在");
});

test("updateHistory 拒绝未来时间，以及对损坏时间戳的记录", function() {
    const state = seededState();
    const record = AppStore.addHistory(state, "肯德基").record;
    const tomorrow = new Date(Date.now() + 86400000).toISOString();
    throwsWith(AppValidation.ValidationError, "选择时间不能晚于现在", function() {
        AppStore.updateHistory(state, record.id, "肯德基", tomorrow);
    });

    // 时间戳损坏的记录不可编辑（但可删除），否则用户只能清空全部历史。
    state.history.push({ id: "broken", food: "坏了", selectedAt: "不是时间", seq: 998 });
    throwsWith(AppValidation.ValidationError,
        "只能编辑最近 5 天（含今天）的历史记录", function() {
            AppStore.updateHistory(state, "broken", "修好了", timestampDaysAgo(1));
        });
    assert.deepStrictEqual(AppStore.deleteHistory(state, "broken"), { deleted: true });
});

test("deleteHistory 对不存在的 id 抛 NotFoundError", function() {
    const state = seededState();
    throwsWith(AppStore.NotFoundError, "历史记录不存在", function() {
        AppStore.deleteHistory(state, "不存在");
    });
});

test("updateHistory 先校验食物名再查记录（和 database.py 同序）", function() {
    // 这条是审查时抓到的真实分叉：JS 原本先查记录，于是"id 不存在 + 食物名为空"
    // 报"历史记录不存在"，而电脑版报"食物名称不能为空"。
    // 同一个请求在两边的解释不同，且用户拿到的提示会把人引向错误的方向。
    const state = seededState();
    throwsWith(AppValidation.ValidationError, "食物名称不能为空", function() {
        AppStore.updateHistory(state, "不存在的 id", "", "2026-10-05T18:08:24.000Z");
    });
    // 食物名合法时，才轮到"记录不存在"。
    throwsWith(AppStore.NotFoundError, "历史记录不存在", function() {
        AppStore.updateHistory(state, "不存在的 id", "快餐", "2026-10-05T18:08:24.000Z");
    });
});

test("历史排序是 selectedAt 倒序，同一时间按插入顺序倒序", function() {
    const state = seededState();
    const base = "2026-10-05T12:00:00.000Z";
    // 直接造内部记录：这里要验的是排序，不是写入路径。
    state.history = [
        { id: "a", food: "A", selectedAt: base, seq: 1 },
        { id: "b", food: "B", selectedAt: base, seq: 2 },
        { id: "c", food: "C", selectedAt: "2026-10-05T13:00:00.000Z", seq: 3 },
        { id: "d", food: "D", selectedAt: "2026-10-05T11:00:00.000Z", seq: 4 }
    ];
    const ordered = state.history.slice().sort(AppStore.compareHistory).map(function(record) {
        return record.id;
    });
    // 对应 SQLite 的 ORDER BY selected_at DESC, rowid DESC：
    // 时间相同的两条里，后插入的（seq 大）排在前面。
    assert.deepStrictEqual(ordered, ["c", "b", "a", "d"]);
});

test("clearHistory 只清历史，不动候选项", function() {
    const state = seededState();
    AppStore.addHistory(state, "肯德基");
    AppStore.addHistory(state, "麦当劳");
    assert.deepStrictEqual(AppStore.clearHistory(state), { cleared: true });
    assert.strictEqual(state.history.length, 0);
    assert.strictEqual(state.choices.length, 8);
});

// --------------------------------------------------------------------------
// 快照
// --------------------------------------------------------------------------

test("buildSnapshot 是深拷贝，之后改状态不会污染快照", function() {
    const state = seededState();
    AppStore.addChoiceMeta(state, "aliases", state.choices[0].id, "KFC");
    const snapshot = AppStore.buildSnapshot(state, "2026-10-05T00:00:00.000Z");
    assert.strictEqual(snapshot.createdAt, "2026-10-05T00:00:00.000Z");
    assert.strictEqual(snapshot.schemaVersion, AppStore.SNAPSHOT_SCHEMA_VERSION);
    assert.strictEqual(snapshot.choices.length, 8);
    assert.strictEqual(snapshot.choices[0].aliases.length, 1);

    // 快照必须和后续修改脱钩，否则"备份"会跟着数据一起变。
    AppStore.addChoice(state, "新候选项");
    AppStore.clearHistory(state);
    assert.strictEqual(snapshot.choices.length, 8);
    assert.strictEqual(snapshot.choices[0].aliases.length, 1);
});

// --------------------------------------------------------------------------
// 导入
// --------------------------------------------------------------------------

function v2Payload(choices, history) {
    return {
        app: "what-should-we-eat",
        schemaVersion: 2,
        choices: choices || [],
        history: history || []
    };
}

test("applyImport merge 不覆盖已有历史，并按 id 跳过冲突", function() {
    const state = seededState();
    const existing = AppStore.addHistory(state, "肯德基").record;
    const payload = v2Payload(
        [{ name: "麦当劳", aliases: ["M"], tags: ["快餐"] }],
        [
            { id: existing.id, food: "肯德基", selectedAt: existing.selectedAt },
            { id: "new-id", food: "寿司", selectedAt: "2026-10-05T12:00:00.000Z" }
        ]
    );
    const outcome = AppStore.applyImport(state, payload, "merge");
    assert.strictEqual(outcome.summary.insertedChoiceCount, 1);
    assert.strictEqual(outcome.summary.insertedAliasCount, 1);
    assert.strictEqual(outcome.summary.insertedTagCount, 1);
    assert.strictEqual(outcome.summary.skippedConflictCount, 1, "同 id 的历史要跳过");
    assert.strictEqual(state.history.length, 2);
    assert.strictEqual(state.choices.length, 9);
});

test("applyImport merge 幂等：同一份备份导两次不会翻倍", function() {
    const state = seededState();
    const payload = v2Payload(
        [{ name: "麦当劳", aliases: ["M"], tags: [] }],
        [{ id: "h1", food: "寿司", selectedAt: "2026-10-05T12:00:00.000Z" }]
    );
    const first = AppStore.applyImport(state, payload, "merge");
    assert.strictEqual(first.summary.insertedChoiceCount, 1);
    assert.strictEqual(first.summary.insertedAliasCount, 1);

    const second = AppStore.applyImport(state, payload, "merge");
    assert.strictEqual(second.summary.insertedChoiceCount, 0, "候选项要复用而不是新建");
    assert.strictEqual(second.summary.insertedAliasCount, 0, "别名不能翻倍");
    assert.strictEqual(second.summary.skippedMetaCount, 1);
    assert.strictEqual(second.summary.skippedConflictCount, 1);
    assert.strictEqual(state.choices.length, 9);
    assert.strictEqual(state.history.length, 1);
});

test("applyImport merge 的别名合并到已有候选项上，而不是新建一个", function() {
    const state = seededState();
    const existing = state.choices.find(function(choice) {
        return choice.name === "Jollof rice";
    });
    const payload = v2Payload([
        { name: "jollof RICE", aliases: ["Jollof"], tags: [] }
    ], []);
    AppStore.applyImport(state, payload, "merge");
    // 复用之后别名必须挂在原来那个 id 上：挂到"新 id"等于挂给一个不存在的候选项。
    assert.strictEqual(existing.aliases.length, 1);
    assert.strictEqual(existing.aliases[0].alias, "Jollof");
    assert.strictEqual(state.choices.length, 8);
});

test("applyImport replace 整体替换并让 position 从 0 重排", function() {
    const state = seededState();
    AppStore.addHistory(state, "肯德基");
    const payload = v2Payload(
        [{ name: "甲", aliases: [], tags: [] }, { name: "乙", aliases: [], tags: [] }],
        [{ id: "h1", food: "丙", selectedAt: "2026-10-05T12:00:00.000Z" }]
    );
    const outcome = AppStore.applyImport(state, payload, "replace");
    assert.strictEqual(outcome.summary.insertedChoiceCount, 2);
    assert.strictEqual(state.choices.length, 2);
    assert.deepStrictEqual(state.choices.map(function(choice) { return choice.position; }), [0, 1]);
    assert.strictEqual(state.history.length, 1, "旧历史要被替换掉");
    assert.strictEqual(state.history[0].food, "丙");
});

test("覆盖导入之后新增候选项不会撞上导入进来的 id", function() {
    const state = seededState();
    const payload = v2Payload([{ name: "甲", aliases: [], tags: [] }], []);
    AppStore.applyImport(state, payload, "replace");
    const importedId = state.choices[0].id;
    const added = AppStore.addChoice(state, "新的").choice;
    assert.notStrictEqual(added.id, importedId);
});

test("空备份不能覆盖导入", function() {
    const state = seededState();
    AppStore.addHistory(state, "肯德基");
    // 这几乎总是"选错文件"，而不是本意要清空数据。
    throwsWith(AppValidation.ValidationError, "备份中没有数据，已阻止覆盖导入", function() {
        AppStore.applyImport(state, v2Payload([], []), "replace");
    });
    assert.strictEqual(state.choices.length, 8, "拒绝之后状态必须原样不动");
    assert.strictEqual(state.history.length, 1);
});

test("导入模式只接受 merge 和 replace", function() {
    const state = seededState();
    ["", "MERGE", "overwrite", null].forEach(function(mode) {
        throwsWith(AppValidation.ValidationError, "导入模式无效", function() {
            AppStore.applyImport(state, v2Payload([{ name: "甲" }], []), mode);
        });
    });
});

test("previewImport 只读，不改状态", function() {
    const state = seededState();
    const before = JSON.stringify(state);
    const outcome = AppStore.previewImport(state, v2Payload(
        [{ name: "Jollof rice", aliases: [], tags: [] }, { name: "新食物", aliases: [], tags: [] }],
        [{ id: "h1", food: "寿司", selectedAt: "2026-10-05T12:00:00.000Z" }]
    ));
    assert.strictEqual(outcome.summary.existingChoiceCount, 1);
    assert.strictEqual(outcome.summary.historyIdConflictCount, 0);
    assert.strictEqual(outcome.summary.choiceCount, 2);
    assert.strictEqual(JSON.stringify(state), before, "预览不能有副作用");
});

// --------------------------------------------------------------------------
// 导出与状态形状
// --------------------------------------------------------------------------

test("buildExport 输出能被自己导入", function() {
    const state = seededState();
    const choice = AppStore.addChoice(state, "肯德基").choice;
    AppStore.addChoiceMeta(state, "aliases", choice.id, "KFC");
    AppStore.addChoiceMeta(state, "tags", choice.id, "快餐");
    AppStore.addHistory(state, "肯德基");

    const payload = AppStore.buildExport(state);
    assert.strictEqual(payload.app, "what-should-we-eat");
    assert.strictEqual(payload.schemaVersion, 2);
    const kfc = payload.choices.find(function(entry) { return entry.name === "肯德基"; });
    assert.deepStrictEqual(kfc, { name: "肯德基", aliases: ["KFC"], tags: ["快餐"] });
    assert.strictEqual(payload.history[0].food, "肯德基");
    // 后端算出来的字段不能进备份，否则两边口径会分叉。
    assert.deepStrictEqual(Object.keys(payload.history[0]).sort(), ["food", "id", "selectedAt"]);

    const roundTrip = AppValidation.prepareImport(payload);
    assert.strictEqual(roundTrip.summary.choiceCount, payload.choices.length);
    assert.strictEqual(roundTrip.summary.historyCount, payload.history.length);
    assert.strictEqual(roundTrip.summary.invalidCount, 0);
});

test("toApiState 的形状和 /api/state 一致", function() {
    const state = seededState();
    const choice = AppStore.addChoice(state, "肯德基").choice;
    AppStore.addChoiceMeta(state, "aliases", choice.id, "KFC");
    AppStore.addHistory(state, "肯德基");
    const apiState = AppStore.toApiState(state);

    assert.deepStrictEqual(Object.keys(apiState).sort(), ["choices", "history"]);
    const kfc = apiState.choices[apiState.choices.length - 1];
    assert.deepStrictEqual(Object.keys(kfc).sort(), ["aliases", "id", "name", "tags"]);
    // aliases 是 {id, alias} 对象数组：index.js 的 metaValue() 读的是 item.alias。
    assert.deepStrictEqual(kfc.aliases, [{ id: 1, alias: "KFC" }]);
    // 历史带 editable/deletable：前端不自己判断日期。
    assert.deepStrictEqual(
        Object.keys(apiState.history[0]).sort(),
        ["deletable", "editable", "food", "id", "selectedAt"]
    );
});

test("toApiState 的候选项按 position 排序", function() {
    const state = seededState();
    // 打乱内部顺序：渲染顺序必须由 position 决定，而不是数组下标。
    state.choices.reverse();
    const names = AppStore.toApiState(state).choices.map(function(choice) { return choice.name; });
    assert.deepStrictEqual(names, TEST_CHOICES);
});

// --------------------------------------------------------------------------
// 从存储读回时的容错
// --------------------------------------------------------------------------

test("normalizeState 补齐缺字段的记录", function() {
    // 手改过的库、结构升级中途都可能留下缺字段的记录：
    // 这里补不齐，渲染层就会到处判 undefined。
    const state = AppStore.normalizeState({
        choices: [
            { id: 3, name: "有别名", position: 0, aliases: [{ id: 7, alias: "A" }] },
            { id: 4, name: "缺标签", position: 1 },
            { id: 5, name: "" },
            null
        ],
        history: [
            { id: "h1", food: "有", selectedAt: "2026-10-05T12:00:00.000Z" },
            { food: "缺 id" },
            null
        ]
    });
    assert.strictEqual(state.choices.length, 2, "空名字和 null 要被丢掉");
    assert.deepStrictEqual(state.choices[1].tags, [], "缺的 tags 补成空数组");
    // 缺 seq 的记录补 0：不能让它拿到 undefined 参与排序。
    assert.strictEqual(state.history.length, 1);
    assert.strictEqual(state.history[0].seq, 0);
    assert.strictEqual(state.meta.initialized, false);
});

test("normalizeState 把落后的计数器顶到实际数据之后", function() {
    const state = AppStore.normalizeState({
        choices: [{ id: 50, name: "甲", position: 0, aliases: [{ id: 80, alias: "A" }], tags: [] }],
        history: [{ id: "h1", food: "乙", selectedAt: "2026-10-05T12:00:00.000Z", seq: 90 }],
        // 计数器比实际数据小（比如库是从别处复制的）。
        meta: { nextChoiceId: 1, nextAliasId: 1, nextTagId: 1, nextSeq: 1 }
    });
    assert.ok(state.meta.nextChoiceId > 50, "否则新增候选项会撞上已有的 id");
    assert.ok(state.meta.nextAliasId > 80);
    assert.ok(state.meta.nextSeq > 90);
});

test("normalizeState 容忍完全空的输入", function() {
    [null, undefined, {}, "不是对象", 42].forEach(function(raw) {
        const state = AppStore.normalizeState(raw);
        assert.deepStrictEqual(state.choices, []);
        assert.deepStrictEqual(state.history, []);
        assert.strictEqual(state.meta.initialized, false);
    });
});

test("normalizeState 丢掉重复的别名但保留第一个", function() {
    const state = AppStore.normalizeState({
        choices: [{
            id: 1, name: "甲", position: 0,
            // 大小写不同但 casefold 后相同：重复的那条要丢掉。
            aliases: [{ id: 1, alias: "KFC" }, { id: 2, alias: "kfc" }],
            tags: []
        }]
    });
    assert.deepStrictEqual(state.choices[0].aliases, [{ id: 1, alias: "KFC" }]);
});

test("normalizeState 给缺 id 的别名一个不会冲突的负数 id", function() {
    const state = AppStore.normalizeState({
        choices: [{ id: 1, name: "甲", position: 0, aliases: ["没有 id"], tags: [] }]
    });
    const alias = state.choices[0].aliases[0];
    assert.strictEqual(alias.alias, "没有 id");
    assert.ok(alias.id < 0, "负数不可能和真实 id 冲突");
});

// --------------------------------------------------------------------------
// 修订号
// --------------------------------------------------------------------------

test("每个写操作都会推进修订号", function() {
    const state = seededState();
    const before = state.meta.revision;
    AppStore.addChoice(state, "甲");
    AppStore.addHistory(state, "甲");
    assert.ok(state.meta.revision > before + 1);
});

test("只读操作不推进修订号", function() {
    const state = seededState();
    const before = state.meta.revision;
    AppStore.toApiState(state);
    AppStore.buildExport(state);
    AppStore.previewImport(state, v2Payload([{ name: "甲" }], []));
    AppStore.existingIndex(state);
    assert.strictEqual(state.meta.revision, before);
});

console.log("");
if (failures.length) {
    console.log(failures.length + " 个用例失败，共 " + checks + " 个通过");
    process.exitCode = 1;
} else {
    console.log("ok   - store 测试全部通过（" + checks + " 个用例）");
}
