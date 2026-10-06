#!/usr/bin/env node
"use strict";

/*
 * PWA 的端到端接线测试：node tests/test_pwa_integration.js
 *
 * 别的测试各测一层（validation 的规则、store 的状态转换、database 的持久化、
 * prepare_pwa 的产物），这个测试回答一个它们都回答不了的问题：
 * **把这些文件按 dist/pwa/index.html 的真实顺序装进一个页面环境之后，应用到底能不能用。**
 *
 * 分层重构最容易出的问题就是"每层单测都过、装到一起不工作"：脚本顺序排错、
 * UMD 的全局名对不上、index.js 读的返回值形状和适配器给的不一致——
 * 这些在单层测试里全是绿的，只有把整套东西接起来才会暴露。
 *
 * 装载的是**真实的模块文件**（不是桩），数据层挂在**内存版 IndexedDB** 上，
 * DOM 用 tests/helpers/mini-dom.js 的极简桩。所以这不是浏览器回归测试：
 * 布局、CSS、真实焦点、Service Worker 的实际注册行为都不在覆盖范围内。
 * 它验证的是"接线"和"契约"。
 */

process.env.TZ = "Asia/Shanghai";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const PROJECT_ROOT = path.join(__dirname, "..");
const DIST = path.join(PROJECT_ROOT, "dist", "pwa");

const { createDom } = require("./helpers/mini-dom.js");
const { createFakeIndexedDB } = require("./helpers/fake-indexeddb.js");

let checks = 0;
const failures = [];

async function test(name, body) {
    try {
        await body();
        checks += 1;
        console.log("ok   - " + name);
    } catch (error) {
        failures.push({ name: name, error: error });
        console.log("FAIL - " + name);
        console.log("       " + (error && error.message));
    }
}

function fail(message) {
    throw new Error(message);
}

/*
 * 把 sandbox（vm 上下文）里造出来的对象转成宿主 realm 的普通对象。
 *
 * 为什么需要：`vm.createContext` 里的模块有自己的 `Object.prototype`，
 * 直接对跨 realm 的对象做 `assert.deepStrictEqual` 会因为"原型不同"而失败，
 * 报错是 "same structure but are not reference-equal"——看着像数据不一致，
 * 其实结构完全一样。这是测试环境的产物，不是产品缺陷。
 *
 * JSON 往返既能对齐原型，又只保留可序列化的字段，正好是我们要比的形状。
 */
function plain(value) {
    return JSON.parse(JSON.stringify(value));
}

// --------------------------------------------------------------------------
// 装载
// --------------------------------------------------------------------------

/*
 * 从 dist/pwa/index.html 解析出脚本顺序。
 *
 * 这里刻意读**产物**而不是写死一份清单：脚本顺序是 prepare_pwa.py 生成的，
 * 写死清单等于把"生成器改了但测试没跟上"这种情况放过——而顺序错了正是
 * 这个测试要抓的问题之一。
 */
function readScriptOrder() {
    const html = fs.readFileSync(path.join(DIST, "index.html"), "utf8");
    const order = [];
    const pattern = /<script\s+src="([^"]+)"\s*><\/script>/g;
    let match = pattern.exec(html);
    while (match) {
        order.push(match[1]);
        match = pattern.exec(html);
    }
    return { html: html, order: order };
}

/*
 * 造一个"像浏览器"的 sandbox 并把模块按顺序装进去。
 *
 * 关键点是 `sandbox.window = sandbox`：这些模块是 UMD，浏览器分支走的是
 * `root.AppXxx = ...`，而 index.js 读的是裸全局名（`AppApi`、`document`）。
 * 让 window 指向 sandbox 本身，两边就落在同一个对象上，和浏览器里一致。
 *
 * 没有 `module`/`require` 也是故意的：模块的 UMD 会因此走浏览器分支，
 * 正是我们想测的那条。
 */
function createPage(options) {
    const settings = options || {};
    const dom = createDom();
    const fake = settings.indexedDB === undefined
        ? createFakeIndexedDB()
        : settings.indexedDB;
    const registrations = [];

    const sandbox = {
        console,
        setTimeout,
        clearTimeout,
        queueMicrotask,
        Promise,
        JSON,
        Object,
        Array,
        String,
        Number,
        Math,
        Date,
        Error,
        RegExp,
        Boolean,
        isFinite,
        Blob,
        URL: {
            createObjectURL: () => "blob:stub",
            revokeObjectURL: () => undefined
        },
        indexedDB: fake,
        document: dom.document,
        navigator: Object.assign({
            onLine: true,
            userAgent: "test"
        }, settings.storage === undefined ? {} : { storage: settings.storage }),
        location: settings.location || {
            protocol: "https:",
            hostname: "example.test",
            href: "https://example.test/pwa/"
        },
        isSecureContext: settings.isSecureContext === undefined ? true : settings.isSecureContext,
        addEventListener() {},
        removeEventListener() {},
        confirm: settings.confirm === undefined ? () => true : settings.confirm,
        alert() {}
    };
    // UMD 的浏览器分支和 index.js 的裸全局名靠这一行对齐。
    sandbox.window = sandbox;
    sandbox.self = sandbox;
    sandbox.globalThis = sandbox;
    vm.createContext(sandbox);

    return {
        sandbox,
        dom,
        fake,
        registrations,
        settle: dom.settle,
        async load(order) {
            for (const name of order) {
                const file = path.join(DIST, name);
                const source = fs.readFileSync(file, "utf8");
                // 每个文件单独 runInContext：和浏览器按 <script> 逐个执行一致。
                // 文件名带上，语法错误时能一眼看出是哪个模块。
                vm.runInContext(source, sandbox, { filename: "dist/pwa/" + name });
            }
            await dom.settle();
        }
    };
}

function requireDist() {
    if (!fs.existsSync(path.join(DIST, "index.html"))) {
        // 不写成 "Cannot find module"：那是产物没构建，不是代码坏了。
        fail(
            "找不到 " + DIST + "/index.html。先运行：python3 tools/prepare_pwa.py"
        );
    }
}

// --------------------------------------------------------------------------
// 1. 模块接线
// --------------------------------------------------------------------------

async function checkModuleWiring() {
    const { order } = readScriptOrder();
    const page = createPage();
    await page.load(order);
    const sandbox = page.sandbox;

    for (const name of ["AppCasefold", "AppValidation", "AppStore", "AppDatabase", "AppText", "AppApi"]) {
        assert.ok(
            sandbox[name],
            name + " 没有挂到 window 上：UMD 的全局名和 index.js 读的名字对不上，"
            + "页面会在加载时就报 undefined"
        );
    }

    // AppApi 的方法集合必须和桌面版 api.js 完全一致：index.js 只认这一层，
    // 少一个方法是运行到那一步才炸，多一个没人用也没意义。
    const expected = [
        "initialize", "getState", "addChoice", "deleteChoice",
        "addChoiceAlias", "deleteChoiceAlias", "addChoiceTag", "deleteChoiceTag",
        "addHistory", "updateHistory", "deleteHistory", "clearHistory",
        "previewImport", "applyImport", "fetchExport"
    ].sort();
    const actual = Object.keys(sandbox.AppApi).filter(function(key) {
        return key !== "database";
    }).sort();
    assert.deepStrictEqual(actual, expected, "AppApi 的方法集合和 api.js 的契约不一致");
}

// --------------------------------------------------------------------------
// 2. AppText 覆盖生效
// --------------------------------------------------------------------------

async function checkPwaTextOverride() {
    const { order } = readScriptOrder();
    // 让 initialize 失败：这样页面会渲染"不可用"文案，正好验证用的是哪一套。
    const brokenFactory = createFakeIndexedDB();
    brokenFactory.open = function() {
        throw new Error("故意让本地数据库打不开");
    };
    const page = createPage({ indexedDB: brokenFactory });
    await page.load(order);
    await page.settle(20);

    const message = page.dom.element("trend-summary").textContent;
    assert.strictEqual(
        message,
        page.sandbox.AppText.unavailable,
        "加载失败时要显示 PWA 版的文案（AppText.unavailable），说明 pwa-text.js 没生效"
    );
    // 这三样在手机上都不存在：照搬桌面版说法会让用户去找一个没有的东西。
    ["本地服务", "SQLite", "data/backups"].forEach(function(phrase) {
        assert.ok(
            message.indexOf(phrase) === -1,
            "PWA 版文案里出现了桌面版说法「" + phrase + "」：" + message
        );
    });
}

// --------------------------------------------------------------------------
// 3. 首次启动渲染
// --------------------------------------------------------------------------

async function checkFirstRunRenders() {
    const { order } = readScriptOrder();
    const page = createPage();
    await page.load(order);
    await page.settle(20);

    const cards = page.dom.element("display-food-choice");
    assert.strictEqual(
        cards.children.length, 8,
        "首次启动要播种并渲染 8 个默认候选项，实际渲染了 " + cards.children.length + " 个"
    );
    // 真的进了渲染流程，而不是停在空壳上。
    assert.ok(
        page.dom.element("total-count").textContent !== "",
        "统计数字没有渲染，页面可能停在初始化之前"
    );
}

// --------------------------------------------------------------------------
// 4. 完整业务流（走真实 AppApi + 真实 IndexedDB）
// --------------------------------------------------------------------------

async function checkBusinessFlow() {
    const { order } = readScriptOrder();
    const page = createPage();
    await page.load(order);
    const api = page.sandbox.AppApi;

    const initial = await api.initialize();
    assert.strictEqual(initial.choices.length, 8, "初始化要有 8 个默认候选项");
    assert.ok(
        initial.migrationWarning === null || initial.migrationWarning === undefined,
        "PWA 版不做浏览器 v1 迁移，不该有迁移警告"
    );

    // 返回形状逐个对：index.js 直接读这些字段。
    const added = await api.addChoice("  肯德基  ");
    assert.ok(added && added.choice, "addChoice 要返回 {choice}");
    assert.strictEqual(added.choice.name, "肯德基", "名字要规范化");
    const choiceId = added.choice.id;

    const alias = await api.addChoiceAlias(choiceId, "KFC");
    assert.deepStrictEqual(
        Object.keys(alias).sort(), ["alias"],
        "addChoiceAlias 要返回 {alias: {id, alias}}"
    );
    assert.deepStrictEqual(
        plain(alias.alias), { id: alias.alias.id, alias: "KFC" },
        "index.js 读的是 added.alias.id，形状错了就取不到"
    );

    const tag = await api.addChoiceTag(choiceId, "快餐");
    assert.deepStrictEqual(
        Object.keys(tag).sort(), ["tag"],
        "addChoiceTag 要返回 {tag: {id, tag}}"
    );

    const history = await api.addHistory("肯德基");
    assert.ok(history && history.record, "addHistory 要返回 {record}");
    ["id", "food", "selectedAt", "editable", "deletable"].forEach(function(field) {
        assert.ok(
            history.record[field] !== undefined,
            "历史记录缺字段 " + field + "：index.js 靠 editable/deletable 决定显示哪些按钮"
        );
    });
    assert.strictEqual(history.record.editable, true);

    const state = await api.getState();
    assert.strictEqual(state.choices.length, 9, "getState 要能看到刚加的候选项");
    const found = state.choices.find(function(choice) { return choice.id === choiceId; });
    assert.deepStrictEqual(plain(found.aliases), [{ id: alias.alias.id, alias: "KFC" }]);
    assert.deepStrictEqual(plain(found.tags), [{ id: tag.tag.id, tag: "快餐" }]);
    assert.strictEqual(state.history.length, 1);

    const newTime = new Date(Date.now() - 3600000).toISOString();
    const updated = await api.updateHistory(history.record.id, "麦当劳", newTime);
    assert.strictEqual(updated.record.food, "麦当劳");
    assert.strictEqual(updated.record.selectedAt, newTime);

    // 这三个删除的返回形状也要对：index.js 用 result.deleted 判断成功。
    assert.deepStrictEqual(plain(await api.deleteChoiceAlias(choiceId, alias.alias.id)),
        { deleted: true });
    assert.deepStrictEqual(plain(await api.deleteChoiceTag(choiceId, tag.tag.id)),
        { deleted: true });
    assert.deepStrictEqual(plain(await api.deleteHistory(history.record.id)),
        { deleted: true });

    // 删候选项不能动历史：吃过什么是发生过的事。
    await api.addHistory("肯德基");
    await api.deleteChoice(choiceId);
    const afterDelete = await api.getState();
    assert.strictEqual(afterDelete.choices.length, 8);
    assert.strictEqual(
        afterDelete.history.length, 1,
        "删候选项不该连带删历史记录"
    );
}

// --------------------------------------------------------------------------
// 5. 错误消息原样透出
// --------------------------------------------------------------------------

async function checkErrorMessagesSurface() {
    const { order } = readScriptOrder();
    const page = createPage();
    await page.load(order);
    const api = page.sandbox.AppApi;
    await api.initialize();

    let thrown = null;
    try {
        await api.addChoice("Yam and egg");
    } catch (error) {
        thrown = error;
    }
    assert.ok(thrown, "重复候选项必须被拒绝");
    // index.js 直接把 error.message 显示给用户：包装成"数据库操作失败"
    // 等于把"为什么被拒绝"这个信息弄丢了。
    assert.strictEqual(thrown.message, "不能添加重复的食物");

    let missing = null;
    try {
        await api.deleteChoice(999999);
    } catch (error) {
        missing = error;
    }
    assert.ok(missing && missing.message === "候选项不存在");
}

// --------------------------------------------------------------------------
// 6. 导出 / 导入闭环
// --------------------------------------------------------------------------

async function checkExportImportRoundTrip() {
    const { order } = readScriptOrder();
    const page = createPage();
    await page.load(order);
    const api = page.sandbox.AppApi;
    await api.initialize();
    const choice = (await api.addChoice("寿司")).choice;
    await api.addChoiceAlias(choice.id, "sushi");
    await api.addChoiceTag(choice.id, "日料");
    await api.addHistory("寿司");

    const exported = await api.fetchExport();
    assert.ok(exported.blob, "fetchExport 要返回 blob");
    assert.match(
        exported.filename,
        /^what-should-we-eat-\d{4}-\d{2}-\d{2}\.json$/,
        "导出文件名要和桌面版同一套命名，实际是 " + exported.filename
    );

    const text = await exported.blob.text();
    const payload = JSON.parse(text);
    assert.strictEqual(payload.app, "what-should-we-eat");
    assert.strictEqual(payload.schemaVersion, 2);
    const sushi = payload.choices.find(function(entry) { return entry.name === "寿司"; });
    assert.deepStrictEqual(plain(sushi), { name: "寿司", aliases: ["sushi"], tags: ["日料"] });
    assert.deepStrictEqual(
        Object.keys(payload.history[0]).sort(), ["food", "id", "selectedAt"],
        "导出历史只能有 id/food/selectedAt：editable/deletable 是后端算出来的"
    );

    // previewImport 的入参是 File：只要有 text() 就够，index.js 传的就是它。
    const file = { text: async function() { return text; } };
    const preview = await api.previewImport(file);
    assert.ok(preview.payload, "previewImport 要回传解析后的 payload");
    const summary = preview.preview.summary;
    [
        "choiceCount", "historyCount", "aliasCount", "tagCount",
        "invalidCount", "duplicateCount", "existingChoiceCount", "historyIdConflictCount"
    ].forEach(function(field) {
        assert.strictEqual(
            typeof summary[field], "number",
            "预览摘要缺字段 " + field + "：index.js 的预览会显示 undefined"
        );
    });
    // 这份备份就是刚导出的，所以候选项全都"已存在"，历史 id 全都"内容相同"。
    assert.strictEqual(summary.existingChoiceCount, summary.choiceCount);
    assert.strictEqual(summary.historyIdConflictCount, 0);

    const applied = await api.applyImport(preview.payload, "merge");
    assert.ok(applied.state, "applyImport 要返回最新 state");
    [
        "insertedAliasCount", "insertedTagCount", "skippedMetaCount", "skippedConflictCount"
    ].forEach(function(field) {
        assert.strictEqual(
            typeof applied.summary[field], "number",
            "导入摘要缺字段 " + field
        );
    });
    // 幂等：同一份备份再导一次，候选项和别名都不翻倍。
    assert.strictEqual(applied.summary.insertedChoiceCount, 0);
    assert.strictEqual(applied.summary.insertedAliasCount, 0);
    assert.strictEqual(applied.state.choices.length, 9);
}

// --------------------------------------------------------------------------
// 7. 覆盖导入的 snapshot 必须是字符串
// --------------------------------------------------------------------------

async function checkReplaceImportSnapshotIsString() {
    const { order } = readScriptOrder();
    const page = createPage();
    await page.load(order);
    const api = page.sandbox.AppApi;
    await api.initialize();
    await api.addHistory("Yam and egg");

    const payload = {
        app: "what-should-we-eat",
        schemaVersion: 2,
        choices: [{ name: "甲", aliases: [], tags: [] }],
        history: []
    };
    const result = await api.applyImport(payload, "replace");
    // index.js 做 `"覆盖前的数据已备份到 " + summary.snapshot`：
    // 给对象会渲染成 [object Object]，用户看到的就是一句坏掉的话。
    assert.strictEqual(
        typeof result.summary.snapshot, "string",
        "覆盖导入的 summary.snapshot 必须是字符串，实际是 " + typeof result.summary.snapshot
    );
    assert.strictEqual(result.state.choices.length, 1);
    assert.strictEqual(result.state.history.length, 0);
}

// --------------------------------------------------------------------------
// 8. 持久化：关掉页面再打开
// --------------------------------------------------------------------------

async function checkPersistenceAcrossReopen() {
    const { order } = readScriptOrder();
    const fake = createFakeIndexedDB();

    const first = createPage({ indexedDB: fake });
    await first.load(order);
    const choice = (await first.sandbox.AppApi.addChoice("小笼包")).choice;
    await first.sandbox.AppApi.addHistory("小笼包");
    // 模拟关掉页面：连接放掉，但存储（fake）留着。
    first.sandbox.AppDatabase.closeAndReset
        ? first.sandbox.AppDatabase.closeAndReset()
        : null;
    for (const connection of fake.connections || []) {
        if (connection && typeof connection.close === "function") {
            connection.close();
        }
    }

    const second = createPage({ indexedDB: fake });
    await second.load(order);
    const reopened = await second.sandbox.AppApi.initialize();
    assert.ok(
        reopened.choices.some(function(item) { return item.id === choice.id; }),
        "重开页面后手动添加的候选项要还在"
    );
    // 关键：不能把"库已经有数据"误判成"首次启动"而重新播种一遍。
    assert.strictEqual(
        reopened.choices.length, 9,
        "重开页面不该重新播种默认候选项，实际有 " + reopened.choices.length + " 个"
    );
    assert.strictEqual(reopened.history.length, 1, "历史记录也要还在");
}

// --------------------------------------------------------------------------
// 9. bootstrap.js 在不支持 Service Worker 的环境里不能炸
// --------------------------------------------------------------------------

async function checkBootstrapWithoutServiceWorker() {
    const { order } = readScriptOrder();
    // navigator 上没有 serviceWorker：老浏览器、或明文 HTTP 下的某些实现。
    // 应用必须照常可用，只是没有离线能力。
    const page = createPage();
    await page.load(order);
    await page.settle(5);

    assert.ok(
        page.sandbox.AppApi,
        "bootstrap.js 不该影响 AppApi 的装载"
    );
    // 页面主体仍然渲染出来了。
    assert.strictEqual(page.dom.element("display-food-choice").children.length, 8);
}

// --------------------------------------------------------------------------
// 10. 持久化存储申请：有就调，没有也不炸
// --------------------------------------------------------------------------

/*
 * 这三条守的是同一件事：persist() 是"锦上添花"，不能因为拿不到它就让页面起不来。
 *
 * persist() 是尽力申请，缺失、返回 false、异步拒绝或同步抛错都不能阻断启动。
 */
async function checkPersistRequestedWhenAvailable() {
    const { order } = readScriptOrder();
    let calls = 0;
    const page = createPage({
        storage: {
            persist() {
                calls += 1;
                return Promise.resolve(true);
            }
        }
    });
    await page.load(order);
    await page.settle(5);

    assert.strictEqual(
        calls,
        1,
        "有 navigator.storage.persist 时应该调用它一次；"
        + "漏掉的后果是数据停在 best-effort，浏览器可以静默清除"
    );
}

async function checkPersistRejectionDoesNotBreakPage() {
    const { order } = readScriptOrder();
    // 被拒绝是最常见的结果（Chrome 按站点互动程度自动判定），
    // 也可能是直接抛错。两种情况都不许影响应用可用性。
    const page = createPage({
        storage: {
            persist() {
                return Promise.reject(new Error("denied"));
            }
        }
    });
    await page.load(order);
    await page.settle(5);

    assert.ok(page.sandbox.AppApi, "persist() 被拒绝后 AppApi 仍应装好");
    assert.strictEqual(
        page.dom.element("display-food-choice").children.length,
        8,
        "persist() 被拒绝后页面仍应正常渲染"
    );
}

async function checkPersistMissingDoesNotBreakPage() {
    const { order } = readScriptOrder();
    // 明文 HTTP（非安全上下文）下 navigator.storage.persist 不存在；
    // 老浏览器、无痕模式也可能没有。这正是用户第一次真机测试的环境。
    const page = createPage();
    await page.load(order);
    await page.settle(5);

    assert.ok(page.sandbox.AppApi, "没有 persist() 时 AppApi 仍应装好");
    assert.strictEqual(
        page.dom.element("display-food-choice").children.length,
        8,
        "没有 persist() 时页面仍应正常渲染（明文 HTTP 下的手机就是这个情形）"
    );
}

async function checkPersistFalseDoesNotBreakPage() {
    const { order } = readScriptOrder();
    const page = createPage({ storage: { persist() { return Promise.resolve(false); } } });
    await page.load(order);
    await page.settle(5);
    assert.strictEqual(page.dom.element("display-food-choice").children.length, 8);
}

async function checkPersistSynchronousThrowDoesNotBreakPage() {
    const { order } = readScriptOrder();
    const page = createPage({ storage: { persist() { throw new Error("unavailable"); } } });
    await page.load(order);
    await page.settle(5);
    assert.strictEqual(page.dom.element("display-food-choice").children.length, 8);
}

async function checkPersistSkippedInInsecureContext() {
    const { order } = readScriptOrder();
    let calls = 0;
    const page = createPage({
        isSecureContext: false,
        location: { protocol: "http:", hostname: "192.168.1.2", href: "http://192.168.1.2/" },
        storage: { persist() { calls += 1; return Promise.resolve(true); } }
    });
    await page.load(order);
    await page.settle(5);
    assert.strictEqual(calls, 0, "非安全 LAN HTTP 上不申请持久化");
    assert.strictEqual(page.dom.element("display-food-choice").children.length, 8);
}

// --------------------------------------------------------------------------
// 11. index.html 的脚本顺序和模块依赖一致
// --------------------------------------------------------------------------
async function checkScriptOrderMatchesDependencies() {
    const { order, html } = readScriptOrder();

    assert.ok(
        order.indexOf("api.js") === -1,
        "产物里不能出现 api.js：静态托管上没有本机 Python 服务，它一定 404"
    );

    // 依赖顺序：每个模块都必须在它读取的全局对象之后加载。
    // 用相对顺序断言而不是写死整个数组，避免以后插入无关脚本就失败。
    const dependencies = [
        // [后加载的文件, 必须先加载的文件]
        ["validation.js", "casefold.js"],
        ["store.js", "validation.js"],
        ["database.js", "store.js"],
        ["api-local.js", "database.js"],
        ["index.js", "api-local.js"],
        // pwa-text.js 定义 window.AppText，而 index.js 在**加载时**就合并它。
        ["index.js", "pwa-text.js"],
        ["bootstrap.js", "index.js"]
    ];
    dependencies.forEach(function(pair) {
        const later = order.indexOf(pair[0]);
        const earlier = order.indexOf(pair[1]);
        assert.ok(
            later !== -1 && earlier !== -1,
            "index.html 里找不到 " + pair[0] + " 或 " + pair[1]
        );
        assert.ok(
            earlier < later,
            pair[1] + " 必须排在 " + pair[0] + " 之前，实际顺序是 " + order.join(" → ")
        );
    });

    // 手机上不许出现桌面版的说法（prepare_pwa.py 也查，两边都守住）。
    assert.ok(html.indexOf("SQLite") === -1, "产物 index.html 里还留着 SQLite 字样");
}

// --------------------------------------------------------------------------

async function main() {
    requireDist();

    await test("1. 按 index.html 的顺序装载后，各层全局对象接线正确、AppApi 契约完整", checkModuleWiring);
    await test("2. pwa-text.js 覆盖生效：失败文案不含桌面版说法", checkPwaTextOverride);
    await test("3. 首次启动播种并渲染 8 个默认候选项", checkFirstRunRenders);
    await test("4. 完整业务流（增删改查）走真实 AppApi + IndexedDB", checkBusinessFlow);
    await test("5. 业务错误消息原样透出，不被包装成通用错误", checkErrorMessagesSurface);
    await test("6. 导出 / 预览 / 合并导入闭环，且重复导入幂等", checkExportImportRoundTrip);
    await test("7. 覆盖导入的 summary.snapshot 是字符串", checkReplaceImportSnapshotIsString);
    await test("8. 关掉页面再打开，数据还在且不会重新播种", checkPersistenceAcrossReopen);
    await test("9. 没有 serviceWorker 时 bootstrap.js 不炸、应用照常可用", checkBootstrapWithoutServiceWorker);
    await test("10. 有 persist() 时申请持久化存储一次", checkPersistRequestedWhenAvailable);
    await test("11. persist() 被拒绝时页面照常可用", checkPersistRejectionDoesNotBreakPage);
    await test("12. 没有 persist() 时页面照常可用（明文 HTTP 的情形）", checkPersistMissingDoesNotBreakPage);
    await test("13. 产物脚本顺序满足模块依赖，且不含 api.js / SQLite", checkScriptOrderMatchesDependencies);
    await test("14. persist() 返回 false 不阻断启动", checkPersistFalseDoesNotBreakPage);
    await test("15. persist() 同步抛错不阻断启动", checkPersistSynchronousThrowDoesNotBreakPage);
    await test("16. 非安全上下文跳过 persist() 且页面可用", checkPersistSkippedInInsecureContext);

    console.log("");
    if (failures.length) {
        console.log(failures.length + " 项失败，共 " + checks + " 项通过");
        process.exitCode = 1;
    } else {
        console.log("ok   - PWA 端到端接线测试全部通过（" + checks + " 项）");
    }
}

main().catch(function(error) {
    console.error("测试自身崩溃：" + (error && error.stack ? error.stack : error));
    process.exitCode = 1;
});
