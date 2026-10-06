"use strict";

/*
 * 渲染路径的冒烟测试：node tests/test_render.js
 *
 * 用极简 DOM 桩把 index.js 真正执行一遍，断言：
 * - 启动渲染不抛异常（抓「函数名写错 / 字段名拼错 / 取到 null」这类只有打开页面才会炸的问题）
 * - 候选项默认折叠：卡片上只有名字、只读的别名/标签预览和一个「编辑」按钮，没有输入框
 * - 「编辑」原地展开/收起两个输入框，可同时展开多张，加别名后不会自己收起来
 * - 列表内筛选按名字/别名/标签生效，筛选词和展开状态都扛得住整表重渲染
 * - 没提交的输入内容（草稿）不会因为筛选或在别处提交而被抹掉；提交成功清掉、失败留着
 * - 展开态和草稿按 `id|名字` 索引，整表被换掉时不会带到新候选项上
 * - focusMeta 是"一次性焦点请求"，刷新失败后不会在下一次重渲染时抢走光标
 * - 折叠态不写悬空的 aria-controls；收起时把焦点交回「编辑」按钮；live region 不空写
 * - 新加的候选项自动展开编辑器；筛选词不匹配时把筛选清掉，免得加完就"消失"
 * - 搜索框输入 KFC / 快餐 / 多关键词时结果和提示正确
 * - 历史记录编辑器能同时改食物和时间，且时间按本机时区换算
 * - 首页和可选项页的静态结构（欢迎语位置、筛选框在列表上方）
 *
 * 这不是浏览器回归测试：布局、CSS、真实焦点和滚动行为都不在覆盖范围内。
 * DOM 桩按契约实现了 index.js 用到的那几种能力（含 focus 与 document.activeElement
 * 的互斥语义、replaceChildren 摘掉旧子节点），改桩时要保持和浏览器一致。
 */

// 时区固定为 +08:00：UTC 存储 ↔ 本地控件的换算断言在 TZ=UTC 下会退化成恒真。
process.env.TZ = "Asia/Shanghai";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const AppSearch = require("../search.js");

if (new Date("2026-06-15T09:30:00Z").getTimezoneOffset() !== -480) {
    console.error("FAIL - 无法把测试时区固定为 Asia/Shanghai，本地时间换算的断言会失去意义");
    process.exit(1);
}

class FakeClassList {
    constructor() {
        this.values = new Set();
    }
    add(...names) {
        names.forEach((name) => this.values.add(name));
    }
    remove(...names) {
        names.forEach((name) => this.values.delete(name));
    }
    toggle(name, force) {
        if (force) {
            this.values.add(name);
        } else {
            this.values.delete(name);
        }
    }
    contains(name) {
        return this.values.has(name);
    }
}

class FakeElement {
    constructor(tagName) {
        this.tagName = String(tagName).toUpperCase();
        this.children = [];
        this.parentElement = null;
        this.classList = new FakeClassList();
        this.dataset = {};
        this.attributes = {};
        this.listeners = {};
        this.style = {};
        this.textContent = "";
        this.value = "";
        this.hidden = false;
        this.disabled = false;
        this.focused = false;
        this.files = null;
        this.scrolledIntoView = false;
    }

    appendChild(child) {
        child.parentElement = this;
        this.children.push(child);
        return child;
    }

    replaceChildren(...nodes) {
        // 真实 DOM 会把被移除的子节点从文档里摘掉（parentElement 变 null）。
        // 桩也要这么做，否则"元素还在文档里"的判断会失真。
        this.children.forEach((child) => {
            child.parentElement = null;
        });
        this.children = [];
        nodes.forEach((node) => this.appendChild(node));
    }

    setAttribute(name, value) {
        this.attributes[name] = String(value);
    }

    getAttribute(name) {
        return this.attributes[name];
    }

    removeAttribute(name) {
        delete this.attributes[name];
    }

    contains(node) {
        if (!node) {
            return false;
        }
        return this.descendants().includes(node);
    }

    addEventListener(type, handler) {
        (this.listeners[type] = this.listeners[type] || []).push(handler);
    }

    dispatch(type, event) {
        (this.listeners[type] || []).forEach((handler) => handler(event || {}));
    }

    focus() {
        this.focused = true;
        // 焦点是"当前文档里只有一个元素持有"的东西：桩里也照这个语义维护，
        // 否则 index.js 里 document.activeElement 的判断测不出来。
        if (this.ownerDocument) {
            if (this.ownerDocument.activeElement
                && this.ownerDocument.activeElement !== this) {
                this.ownerDocument.activeElement.focused = false;
            }
            this.ownerDocument.activeElement = this;
        }
    }

    scrollIntoView() {
        this.scrolledIntoView = true;
    }

    click() {
        this.dispatch("click");
    }

    remove() {
        if (!this.parentElement) {
            return;
        }
        const index = this.parentElement.children.indexOf(this);
        if (index >= 0) {
            this.parentElement.children.splice(index, 1);
        }
        this.parentElement = null;
    }

    closest(selector) {
        let node = this.parentElement;
        while (node) {
            if (node.matches(selector)) {
                return node;
            }
            node = node.parentElement;
        }
        return null;
    }

    matches(selector) {
        if (selector.charAt(0) === ".") {
            return this.classList.contains(selector.slice(1));
        }
        return selector === this.tagName.toLowerCase();
    }

    querySelector(selector) {
        // 只实现 index.js 用到的那几种选择器。
        const match = selector.match(
            /^input\[data-choice-id="([^"]+)"\]\[data-meta-kind="([^"]+)"\]$/
        );
        if (match) {
            return this.descendants().find(
                (node) =>
                    node.tagName === "INPUT" &&
                    String(node.dataset.choiceId) === match[1] &&
                    node.dataset.metaKind === match[2]
            ) || null;
        }
        // 单个类名选择器（原地展开/收起时找 .choice-meta 和 .edit-choice）。
        const byClass = selector.match(/^\.([A-Za-z0-9_-]+)$/);
        if (byClass) {
            return this.descendants().find(
                (node) => node.classList.contains(byClass[1])
            ) || null;
        }
        return null;
    }

    descendants() {
        const found = [];
        this.children.forEach((child) => {
            found.push(child);
            found.push(...child.descendants());
        });
        return found;
    }

    text() {
        const own = typeof this.textContent === "string" ? this.textContent : "";
        return own + this.children.map((child) => child.text()).join("");
    }
}

const IDS = [
    "user-food-choice", "display-food-choice", "form-error", "choice-form-error",
    "app-status", "retry-load-btn", "food-choice", "selection-actions",
    "food-search-input", "food-search-results", "random-choice-btn",
    "add-food-choice-btn", "confirm-choice-btn", "cancel-choice-btn",
    "choice-filter-input", "choice-filter-note",
    "food-history", "clear-history-btn", "total-count", "unique-count",
    "food-ranking", "trend-summary", "export-data-btn", "import-file-input",
    "import-preview", "import-summary", "merge-import-btn", "replace-import-btn"
];

const CHOICES = [
    { id: 9, name: "肯德基", aliases: [{ id: 1, alias: "KFC" }], tags: [{ id: 1, tag: "快餐" }] },
    { id: 10, name: "麦当劳", aliases: [{ id: 2, alias: "McDonalds" }], tags: [{ id: 2, tag: "快餐" }] },
    { id: 11, name: "米饭", aliases: [], tags: [] },
    { id: 12, name: "重庆小面", aliases: [], tags: [{ id: 3, tag: "面" }] }
];

const RECENT_WITH_MILLIS = new Date();
RECENT_WITH_MILLIS.setMilliseconds(123);

const STATE = {
    choices: CHOICES,
    history: [
        {
            id: "h1", food: "肯德基", selectedAt: RECENT_WITH_MILLIS.toISOString(),
            editable: true, deletable: true
        },
        {
            id: "h2", food: "米饭", selectedAt: new Date(Date.now() - 6 * 86400000).toISOString(),
            editable: false, deletable: false
        }
    ]
};

function createHarness(options) {
    const config = options || {};
    const elements = new Map();
    const historyUpdates = [];
    const baseState = config.state || STATE;
    let current = JSON.parse(JSON.stringify(baseState));
    let nextMetaId = 100;
    let nextChoiceId = 500;
    const snapshot = () => JSON.parse(JSON.stringify(current));
    const findChoice = (choiceId) => current.choices.find((choice) => choice.id === choiceId);

    // index.html 里的三个排行榜范围按钮：桩不解析 HTML，这里按同样的契约造出来。
    const rankingFilters = [10, 20, 0].map((limit) => {
        const button = new FakeElement("button");
        button.classList.add("ranking-filter");
        button.dataset.limit = limit;
        return button;
    });

    const document = {
        getElementById(id) {
            if (!elements.has(id)) {
                const element = new FakeElement("div");
                element.ownerDocument = document;
                elements.set(id, element);
            }
            return elements.get(id);
        },
        createElement(tagName) {
            const element = new FakeElement(tagName);
            // 每个元素都认得 document，focus() 才能统一维护 activeElement。
            element.ownerDocument = document;
            return element;
        },
        createTextNode(text) {
            const node = new FakeElement("text");
            node.textContent = text;
            return node;
        },
        querySelectorAll(selector) {
            return selector === ".ranking-filter" ? rankingFilters : [];
        },
        // 真实 DOM 里 focus() 会更新它，index.js 靠它判断"焦点是否还在要收起的编辑器里"。
        activeElement: null,
        body: new FakeElement("body")
    };

    const unusedApi = (name) => () => {
        throw new Error("渲染阶段不该调用 AppApi." + name);
    };
    const sandbox = {
        document,
        window: { confirm: () => true },
        AppSearch,
        AppApi: {
            initialize: async () => snapshot(),
            getState: async () => {
                if (config.failRefresh) {
                    throw new Error("刷新失败");
                }
                return snapshot();
            },
            addChoice: async (name) => {
                const record = { id: nextChoiceId, name: name, aliases: [], tags: [] };
                nextChoiceId += 1;
                current.choices.push(record);
                return { choice: record };
            },
            deleteChoice: unusedApi("deleteChoice"),
            addChoiceAlias: async (choiceId, alias) => {
                if (config.failAliasMutation) {
                    throw new Error("添加失败");
                }
                const record = { id: nextMetaId, alias: alias };
                nextMetaId += 1;
                findChoice(choiceId).aliases.push(record);
                return { alias: record };
            },
            deleteChoiceAlias: async (choiceId, aliasId) => {
                if (config.failAliasMutation) {
                    throw new Error("删除失败");
                }
                const choice = findChoice(choiceId);
                choice.aliases = choice.aliases.filter((item) => item.id !== aliasId);
                return { deleted: true };
            },
            addChoiceTag: async (choiceId, tag) => {
                if (config.failAliasMutation) {
                    throw new Error("添加失败");
                }
                const record = { id: nextMetaId, tag: tag };
                nextMetaId += 1;
                findChoice(choiceId).tags.push(record);
                return { tag: record };
            },
            deleteChoiceTag: async (choiceId, tagId) => {
                if (config.failAliasMutation) {
                    throw new Error("删除失败");
                }
                const choice = findChoice(choiceId);
                choice.tags = choice.tags.filter((item) => item.id !== tagId);
                return { deleted: true };
            },
            addHistory: unusedApi("addHistory"),
            updateHistory: async (id, food, selectedAt) => {
                if (config.failHistoryUpdate) {
                    throw new Error("更新失败");
                }
                historyUpdates.push({ id: id, food: food, selectedAt: selectedAt });
                const record = current.history.find((item) => item.id === id);
                record.food = food;
                record.selectedAt = selectedAt;
                return { record: record };
            },
            deleteHistory: unusedApi("deleteHistory"),
            clearHistory: unusedApi("clearHistory"),
            previewImport: unusedApi("previewImport"),
            applyImport: unusedApi("applyImport"),
            fetchExport: unusedApi("fetchExport")
        },
        URL: { createObjectURL: () => "blob:stub", revokeObjectURL: () => {} },
        console
    };

    const source = fs.readFileSync(path.join(__dirname, "..", "index.js"), "utf8");
    vm.createContext(sandbox);
    vm.runInContext(source, sandbox, { filename: "index.js" });

    return {
        elements,
        sandbox,
        options: config,
        historyUpdates: historyUpdates,
        rankingFilters: rankingFilters,
        element: (id) => document.getElementById(id),
        settle: async (times) => {
            const rounds = times || 2;
            for (let index = 0; index < rounds; index += 1) {
                await new Promise((resolve) => setTimeout(resolve, 0));
            }
        }
    };
}

function metaInputs(row) {
    return row.descendants().filter((node) => node.tagName === "INPUT" && node.dataset.metaKind);
}

function metaInput(row, kind) {
    return metaInputs(row).find((input) => input.dataset.metaKind === kind);
}

function metaAddButton(input) {
    return input.parentElement.children.find((node) => node.classList.contains("meta-add"));
}

function metaChip(row, text) {
    // 折叠预览里也有同名标签块，但只有编辑器里的那块带 × 按钮。
    return row.descendants().find(
        (node) => node.classList.contains("meta-chip")
            && !node.classList.contains("meta-chip-preview")
            && node.text().includes(text)
    );
}

function metaChipRemoveButton(chip) {
    return chip.children.find((node) => node.tagName === "BUTTON");
}

function previewChips(row) {
    return row.descendants().filter((node) => node.classList.contains("meta-chip-preview"));
}

function editChoiceButton(row) {
    return row.descendants().find(
        (node) => node.tagName === "BUTTON" && node.classList.contains("edit-choice")
    );
}

// 展开第 index 张卡片并返回重渲染之后的新行对象
// （renderFoodChoices 会整表重建，旧的元素已经脱离文档）。
function openEditor(harness, index) {
    const list = harness.element("display-food-choice");
    editChoiceButton(list.children[index]).click();
    return harness.element("display-food-choice").children[index];
}

// 添加成功后输入框焦点要回到原处（列表整体重渲染过），
// 这曾经是坏的：对还没挂到文档上的元素调用 focus() 是空操作。
async function checkFocusIsRestored() {
    const harness = createHarness();
    await harness.settle();
    const row = openEditor(harness, 0);
    const input = metaInput(row, "aliases");
    input.value = "KFC-新增";
    metaAddButton(input).click();
    await harness.settle(5);

    const refreshedRow = harness.element("display-food-choice").children[0];
    assert.ok(
        refreshedRow.text().includes("KFC-新增"),
        "新别名没有渲染出来：" + refreshedRow.text()
    );
    assert.strictEqual(
        metaInput(refreshedRow, "aliases").focused,
        true,
        "添加成功后焦点要回到同一个输入框"
    );
    assert.ok(
        refreshedRow.classList.contains("choice-expanded"),
        "加完别名之后编辑器不该自己收起来"
    );
}

// 删除失败时按钮必须重新可用，否则这个 × 只能靠刷新页面才能再点。
async function checkFailedRemovalReenablesTheButton() {
    const harness = createHarness();
    await harness.settle();
    const row = openEditor(harness, 0);
    const chip = metaChip(row, "KFC");
    const button = metaChipRemoveButton(chip);

    harness.options.failAliasMutation = true;
    button.click();
    await harness.settle(3);

    assert.strictEqual(button.disabled, false, "删除失败后 × 必须恢复可点");
    assert.ok(
        harness.element("display-food-choice").children[0].text().includes("KFC"),
        "删除失败时标签块不能从界面消失"
    );
}

// 服务端已经删掉、只是列表刷新失败时，标签块要从界面移走，不能留下僵尸。
async function checkRemovalWithFailedRefreshRemovesTheChip() {
    const harness = createHarness();
    await harness.settle();
    const row = openEditor(harness, 0);
    const chip = metaChip(row, "KFC");

    harness.options.failRefresh = true;
    metaChipRemoveButton(chip).click();
    await harness.settle(3);

    assert.ok(
        chip.parentElement === null,
        "服务端已删除的标签块必须从界面移除"
    );
}

// 历史记录编辑器要同时能改食物和时间，并且时间按本地时区预填/回写。
async function checkHistoryEditorEditsFoodAndTime() {
    const harness = createHarness();
    await harness.settle();
    const row = harness.element("food-history").children[0];
    const editButton = row.descendants().find(
        (node) => node.tagName === "BUTTON" && node.textContent === "编辑"
    );
    assert.ok(editButton, "可编辑的历史记录应该有编辑按钮");
    editButton.click();

    const inputs = row.descendants().filter((node) => node.tagName === "INPUT");
    const foodInput = inputs.find((node) => node.type === "text");
    const timeInput = inputs.find((node) => node.type === "datetime-local");
    assert.ok(foodInput && timeInput, "编辑态要同时有食物和时间两个输入框");

    // 预填值必须和原记录指向同一分钟（UTC 存储 → 本地控件）。
    const original = new Date(STATE.history[0].selectedAt);
    const prefilled = new Date(timeInput.value);
    assert.strictEqual(
        Math.floor(prefilled.getTime() / 60000),
        Math.floor(original.getTime() / 60000),
        "时间输入框没有按本地时区预填：" + timeInput.value
    );

    const target = new Date();
    target.setDate(target.getDate() - 2);
    target.setHours(18, 45, 0, 0);
    const pad = (value) => ("0" + value).slice(-2);
    foodInput.value = "  时间也改了  ";
    timeInput.value = target.getFullYear() + "-" + pad(target.getMonth() + 1) + "-"
        + pad(target.getDate()) + "T" + pad(target.getHours()) + ":" + pad(target.getMinutes());

    row.descendants()
        .find((node) => node.tagName === "BUTTON" && node.textContent === "保存")
        .click();
    await harness.settle(4);

    const call = harness.historyUpdates[0];
    assert.ok(call, "保存没有调用 updateHistory");
    assert.strictEqual(call.food, "时间也改了", "食物名要去掉首尾空白");
    assert.strictEqual(
        call.selectedAt,
        target.toISOString(),
        "本地时间没有换算成 UTC：" + call.selectedAt
    );
}

// 只改食物名时不能顺手改掉时间戳：datetime-local 只到分钟，
// 重算会截掉秒和毫秒（夏令时回拨那天还可能落到另一个瞬间）。
async function checkHistoryEditorKeepsTimeWhenOnlyTheFoodChanges() {
    const harness = createHarness();
    await harness.settle();
    const original = STATE.history[0].selectedAt;
    const row = harness.element("food-history").children[0];
    row.descendants()
        .find((node) => node.tagName === "BUTTON" && node.textContent === "编辑")
        .click();

    const foodInput = row.descendants().find(
        (node) => node.tagName === "INPUT" && node.type === "text"
    );
    foodInput.value = "只改了名字";
    row.descendants()
        .find((node) => node.tagName === "BUTTON" && node.textContent === "保存")
        .click();
    await harness.settle(4);

    const call = harness.historyUpdates[0];
    assert.ok(call, "保存没有调用 updateHistory");
    assert.strictEqual(call.food, "只改了名字");
    assert.strictEqual(call.selectedAt, original, "没动时间却被改写了时间戳");
}

// 排行榜条形图：条宽按相对最高次数缩放，段位选择（前 10 / 前 20 / 全部）真的切片。
function rankingState() {
    const history = [];
    for (let rank = 1; rank <= 12; rank += 1) {
        for (let picked = 0; picked < 13 - rank; picked += 1) {
            history.push({
                id: "rank" + rank + "-" + picked,
                food: "食物" + rank,
                selectedAt: RECENT_WITH_MILLIS.toISOString(),
                editable: true,
                deletable: true
            });
        }
    }
    return { choices: [], history: history };
}

function rankingBars(harness) {
    return harness.element("food-ranking").children.map((item) =>
        item.descendants().find((node) => node.classList.contains("ranking-bar")).style.width
    );
}

async function checkRankingChart() {
    const harness = createHarness({ state: rankingState() });
    await harness.settle();

    const ranking = harness.element("food-ranking");
    // 食物1 出现 12 次（最高），食物12 出现 1 次；总计 78 次。
    assert.strictEqual(ranking.children.length, 10, "默认应该只显示前 10 条");
    assert.strictEqual(harness.element("ranking-note").textContent,
        "共 12 种食物，显示前 10 种（按确认次数排序）。");
    assert.deepStrictEqual(rankingBars(harness).slice(0, 2), ["100%", "92%"]);
    assert.ok(ranking.text().includes("12 次 · 15%"), "第一名占比不对：" + ranking.text());
    assert.ok(ranking.text().includes("11 次 · 14%"), "第二名占比不对：" + ranking.text());
    assert.strictEqual(harness.element("total-count").textContent, 78);

    harness.rankingFilters[1].click(); // 前 20
    assert.strictEqual(ranking.children.length, 12);
    assert.strictEqual(harness.element("ranking-note").textContent, "共 12 种食物，已全部列出。");

    harness.rankingFilters[2].click(); // 全部
    assert.strictEqual(ranking.children.length, 12);
    assert.strictEqual(harness.rankingFilters[2].getAttribute("aria-pressed"), "true");
    assert.strictEqual(harness.rankingFilters[0].getAttribute("aria-pressed"), "false");

    harness.rankingFilters[0].click(); // 回到前 10
    assert.strictEqual(ranking.children.length, 10);
    assert.ok(harness.rankingFilters[0].classList.contains("active"));
    assert.ok(!harness.rankingFilters[2].classList.contains("active"));

    const emptyHarness = createHarness({ state: { choices: [], history: [] } });
    await emptyHarness.settle();
    assert.ok(
        emptyHarness.element("food-ranking").text().includes("还没有足够的数据"),
        "没有历史时排行榜要有空状态：" + emptyHarness.element("food-ranking").text()
    );
    assert.strictEqual(emptyHarness.element("ranking-note").textContent, "");
}

// 候选项列表默认折叠：卡片上只有名字、只读的别名/标签预览和一个「编辑」按钮。
// 这条同时守住"整页都是空输入框"的老问题：折叠态一个 input 都不该有。
async function checkChoicesAreCollapsedByDefault() {
    const harness = createHarness();
    await harness.settle();
    const display = harness.element("display-food-choice");

    assert.strictEqual(display.children.length, CHOICES.length);
    display.children.forEach((row, index) => {
        assert.strictEqual(
            row.descendants().filter((node) => node.tagName === "INPUT").length,
            0,
            "第 " + index + " 张卡片折叠时不该有输入框"
        );
        assert.ok(editChoiceButton(row), "第 " + index + " 张卡片要有「编辑」按钮");
        assert.strictEqual(
            editChoiceButton(row).getAttribute("aria-expanded"),
            "false",
            "折叠状态的 aria-expanded 要如实反映"
        );
    });

    const kfcRow = display.children[0];
    assert.ok(kfcRow.text().includes("肯德基"));
    // 别名和标签本身一直看得见，藏起来的只是输入框。
    const chips = previewChips(kfcRow);
    assert.deepStrictEqual(
        chips.map((chip) => chip.text()).sort(),
        ["KFC", "快餐"],
        "折叠态要预览已有的别名和标签，实际：" + JSON.stringify(chips.map((c) => c.text()))
    );
    chips.forEach((chip) => {
        assert.strictEqual(
            chip.children.some((node) => node.tagName === "BUTTON"),
            false,
            "折叠态的预览块不该带删除按钮，浏览时误点会直接删数据"
        );
    });

    // 没有别名和标签的候选项不该渲染空的预览行。
    const plainRow = display.children[2];
    assert.ok(plainRow.text().includes("米饭"));
    assert.strictEqual(previewChips(plainRow).length, 0);

    assert.strictEqual(
        harness.element("choice-filter-note").textContent,
        "共 4 个候选项。点「编辑」可以加别名或标签。"
    );
}

// 点「编辑」展开出两个输入框，点「收起」再折回去；展开时别名输入框直接拿到焦点。
async function checkEditorTogglesOpenAndClosed() {
    const harness = createHarness();
    await harness.settle();

    const row = openEditor(harness, 0);
    assert.ok(row.classList.contains("choice-expanded"), "展开后卡片要有展开态类名");
    assert.strictEqual(
        editChoiceButton(row).getAttribute("aria-expanded"),
        "true",
        "展开后 aria-expanded 要是 true"
    );
    assert.deepStrictEqual(
        metaInputs(row).map((input) => input.dataset.metaKind).sort(),
        ["aliases", "tags"],
        "展开后要同时有别名和标签两个输入框"
    );
    assert.strictEqual(
        metaInput(row, "aliases").focused,
        true,
        "展开就是为了改东西，别名输入框应该直接拿到焦点"
    );
    // 预览不因为展开而消失：编辑时也要看得见当前有哪些别名和标签。
    assert.strictEqual(previewChips(row).length, 2);

    // 两张卡片可以同时展开（NN/g：允许一次打开多个，不要互相踢掉）。
    const other = openEditor(harness, 1);
    assert.ok(other.classList.contains("choice-expanded"));
    assert.ok(
        harness.element("display-food-choice").children[0].classList.contains("choice-expanded"),
        "展开第二张卡片不该把第一张收起来"
    );

    editChoiceButton(harness.element("display-food-choice").children[0]).click();
    const collapsed = harness.element("display-food-choice").children[0];
    assert.ok(!collapsed.classList.contains("choice-expanded"), "再点一次应该收起");
    assert.strictEqual(metaInputs(collapsed).length, 0);
    assert.ok(
        harness.element("display-food-choice").children[1].classList.contains("choice-expanded"),
        "收起一张不该影响另一张"
    );
}

// 列表内筛选：复用首页那套匹配，所以别名（KFC）和标签（快餐）都能当筛选词。
async function checkChoiceFilter() {
    const harness = createHarness();
    await harness.settle();
    const filter = harness.element("choice-filter-input");
    const note = harness.element("choice-filter-note");
    const display = harness.element("display-food-choice");

    filter.value = "KFC";
    filter.dispatch("input");
    assert.strictEqual(display.children.length, 1, "按别名筛选应该只剩肯德基");
    assert.ok(display.children[0].text().includes("肯德基"));
    assert.strictEqual(note.textContent, "筛选出 1 / 4 个候选项。");

    filter.value = "快餐";
    filter.dispatch("input");
    assert.strictEqual(display.children.length, 2, "标签命中两家：肯德基和麦当劳");
    assert.strictEqual(note.textContent, "筛选出 2 / 4 个候选项。");

    // 多关键词 AND 落空会回退到 OR，这时匹配结果按得分排序
    // （重庆小面精确命中标签拿 3100 分，排在两家「快餐」前面）。
    // 管理列表不能跟着重排：必须保持候选项目前的顺序。
    filter.value = "面 快餐";
    filter.dispatch("input");
    assert.strictEqual(display.children.length, 3);
    assert.deepStrictEqual(
        display.children.map((row) => row.text().includes("重庆小面") ? "重庆小面" : "两家快餐"),
        ["两家快餐", "两家快餐", "重庆小面"],
        "筛选结果要保持候选项目前的顺序，不能按匹配分重排"
    );
    assert.ok(display.children[0].text().includes("肯德基"), "第一个该是肯德基");
    assert.ok(display.children[1].text().includes("麦当劳"), "第二个该是麦当劳");
    assert.strictEqual(
        note.textContent,
        "筛选出 3 / 4 个候选项。没有候选项同时包含全部关键词，下面是部分匹配。",
        "回退到 OR 时要说明这是部分匹配"
    );

    filter.value = "不存在的食物";
    filter.dispatch("input");
    assert.strictEqual(display.children.length, 0);
    assert.ok(note.textContent.includes("没有匹配"), "筛不到要有空状态：" + note.textContent);

    filter.value = "";
    filter.dispatch("input");
    assert.strictEqual(display.children.length, CHOICES.length);
    assert.strictEqual(note.textContent, "共 4 个候选项。点「编辑」可以加别名或标签。");
}

// 加别名会让整张列表重渲染，筛选词和已经展开的编辑器都必须活下来。
async function checkFilterAndEditorSurviveRerender() {
    const harness = createHarness();
    await harness.settle();
    const filter = harness.element("choice-filter-input");
    filter.value = "快餐";
    filter.dispatch("input");

    const row = openEditor(harness, 0);
    const input = metaInput(row, "aliases");
    input.value = "KFC-两家都有";
    metaAddButton(input).click();
    await harness.settle(5);

    const display = harness.element("display-food-choice");
    assert.strictEqual(filter.value, "快餐", "筛选框里的词不该被清掉");
    assert.strictEqual(display.children.length, 2, "刷新后筛选结果应该还在");
    const refreshed = display.children[0];
    assert.ok(
        metaInput(refreshed, "aliases"),
        "刷新后展开的编辑器不该自己收起来"
    );
    assert.ok(refreshed.text().includes("KFC-两家都有"), "新别名没渲染出来");
}

// 新候选项排在列表最后：加完自动展开它的编辑器，不然长列表里根本找不到。
async function checkNewChoiceOpensItsEditor() {
    const harness = createHarness();
    await harness.settle();
    harness.element("user-food-choice").value = "老乡鸡";
    harness.element("add-food-choice-btn").click();
    await harness.settle(5);

    const display = harness.element("display-food-choice");
    assert.strictEqual(display.children.length, CHOICES.length + 1);
    const last = display.children[display.children.length - 1];
    assert.ok(last.text().includes("老乡鸡"), "新候选项要出现在列表里");
    assert.ok(last.classList.contains("choice-expanded"), "新候选项的编辑器应该自动展开");
    assert.deepStrictEqual(
        metaInputs(last).map((input) => input.dataset.metaKind).sort(),
        ["aliases", "tags"]
    );
    assert.strictEqual(harness.element("user-food-choice").value, "", "添加框要清空");
    assert.strictEqual(
        last.scrolledIntoView,
        true,
        "新候选项在列表最后，要滚到可见处，否则用户看不到加成功了"
    );
    assert.strictEqual(
        metaInput(last, "aliases").focused,
        false,
        "自动展开不能抢焦点：用户可能还要接着加下一个候选项"
    );
}

// 筛选词正好不匹配新候选项时，加完它会"消失"——这时要把筛选清掉让用户看得见。
async function checkNewChoiceClearsNonMatchingFilter() {
    const harness = createHarness();
    await harness.settle();
    const filter = harness.element("choice-filter-input");
    filter.value = "快餐";
    filter.dispatch("input");
    assert.strictEqual(harness.element("display-food-choice").children.length, 2);

    harness.element("user-food-choice").value = "老乡鸡";
    harness.element("add-food-choice-btn").click();
    await harness.settle(5);

    assert.strictEqual(filter.value, "", "新候选项不匹配筛选词时应该把筛选清掉");
    const display = harness.element("display-food-choice");
    assert.strictEqual(display.children.length, CHOICES.length + 1);
    assert.ok(display.text().includes("老乡鸡"), "加完必须看得见");
}

// 可选项页静态结构：筛选框在列表上方，状态说明在筛选框和列表之间。
function checkChoicesMarkup() {
    const html = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");
    const filter = html.indexOf('id="choice-filter-input"');
    const note = html.indexOf('id="choice-filter-note"');
    const list = html.indexOf('id="display-food-choice"');
    assert.ok(filter !== -1, "筛选输入框（#choice-filter-input）不见了");
    assert.ok(note !== -1, "筛选状态说明（#choice-filter-note）不见了");
    assert.ok(list !== -1, "候选项列表（#display-food-choice）不见了");
    assert.ok(filter < list, "筛选框必须在候选项列表上方");
    assert.ok(filter < note && note < list, "状态说明要夹在筛选框和列表之间");
    assert.ok(
        html.includes('for="choice-filter-input"'),
        "筛选输入框要有配对的 label"
    );
}

// 草稿：展开的输入框里"打了字还没提交"的内容，不能因为别的原因重渲染而消失。
// 筛选框每敲一个字都会重建整张列表，这条曾经是坏的（用户打了一半的字被抹掉）。
async function checkDraftsSurviveRerender() {
    const harness = createHarness();
    await harness.settle();

    const row = openEditor(harness, 0);
    const aliasInput = metaInput(row, "aliases");
    aliasInput.value = "还没提交的草稿";
    aliasInput.dispatch("input");

    // 筛选词仍然匹配这一项，卡片会留在列表里（只是被重建）
    const filter = harness.element("choice-filter-input");
    filter.value = "肯德基";
    filter.dispatch("input");

    const afterFilter = harness.element("display-food-choice").children[0];
    assert.ok(afterFilter.classList.contains("choice-expanded"), "筛选后卡片应该还开着");
    assert.strictEqual(
        metaInput(afterFilter, "aliases").value,
        "还没提交的草稿",
        "在筛选框里打字不该抹掉别的卡片里打了一半的内容"
    );

    // 在另一张卡片上真的加一个别名：整表重渲染
    filter.value = "";
    filter.dispatch("input");
    const second = openEditor(harness, 1);
    const otherInput = metaInput(second, "aliases");
    otherInput.value = "另一张卡的草稿";
    otherInput.dispatch("input");
    const tagInput = metaInput(openEditor(harness, 2), "tags");
    tagInput.value = "触发重渲染";
    metaAddButton(tagInput).click();
    await harness.settle(5);

    const list = harness.element("display-food-choice");
    assert.ok(
        metaInput(list.children[1], "aliases"),
        "加完标签后第 2 张卡应该还开着"
    );
    assert.strictEqual(
        metaInput(list.children[1], "aliases").value,
        "另一张卡的草稿",
        "别处加别名导致重渲染时，草稿也要留着"
    );

    // 提交成功后草稿要清掉，否则下次展开会看到上一次的残留
    const kfc = list.children[0];
    const submitInput = metaInput(kfc, "aliases");
    submitInput.value = "已提交的别名";
    submitInput.dispatch("input");
    metaAddButton(submitInput).click();
    await harness.settle(5);
    assert.strictEqual(
        metaInput(harness.element("display-food-choice").children[0], "aliases").value,
        "",
        "提交成功后草稿要清掉"
    );

    // 提交失败时草稿要留着，用户改一下就能重试
    const failHarness = createHarness();
    await failHarness.settle();
    const failRow = openEditor(failHarness, 0);
    const failInput = metaInput(failRow, "aliases");
    failInput.value = "提交会失败的别名";
    failInput.dispatch("input");
    failHarness.options.failAliasMutation = true;
    metaAddButton(failInput).click();
    await failHarness.settle(5);
    assert.strictEqual(
        metaInput(failHarness.element("display-food-choice").children[0], "aliases").value,
        "提交会失败的别名",
        "提交失败时不能连用户输入一起丢掉"
    );

    // 光看上面那条还不够：失败时列表根本没重渲染，输入框本来就还在。
    // 真正的考验是"之后因为别的原因重渲染"——这时草稿必须还在。
    failHarness.options.failAliasMutation = false;
    const failFilter = failHarness.element("choice-filter-input");
    failFilter.value = "肯德基";
    failFilter.dispatch("input");
    assert.strictEqual(
        metaInput(failHarness.element("display-food-choice").children[0], "aliases").value,
        "提交会失败的别名",
        "提交失败后再触发重渲染，没提交的内容也不能丢"
    );
}

// 展开态和草稿都是对当前列表的镜像，整表被换掉之后不能还留着旧 id 的状态。
async function checkChoiceStateDoesNotOutliveTheList() {
    const harness = createHarness();
    await harness.settle();
    const row = openEditor(harness, 0);
    const input = metaInput(row, "aliases");
    input.value = "旧列表的草稿";
    input.dispatch("input");

    // 模拟重新加载：同一批 id 被换成了完全不同的候选项
    harness.sandbox.AppApi.initialize = async () => ({
        choices: [{ id: 9, name: "完全不同的新菜", aliases: [], tags: [] }],
        history: []
    });
    harness.element("retry-load-btn").dispatch("click");
    await harness.settle(6);

    const list = harness.element("display-food-choice");
    assert.strictEqual(list.children.length, 1);
    assert.ok(list.children[0].text().includes("完全不同的新菜"));
    assert.ok(
        !list.children[0].classList.contains("choice-expanded"),
        "用户从没打开过的新候选项不该自己展开"
    );
    assert.strictEqual(
        metaInputs(list.children[0]).length,
        0,
        "旧列表的展开态不该带到新列表上"
    );

    // 展开态和草稿的剪枝：让同一个候选项（id 和名字都没变）先离开列表，
    // 再原样装回来。不剪枝的话，它会带着上次的展开状态和草稿回来。
    harness.sandbox.AppApi.initialize = async () => ({
        choices: [CHOICES[1]],
        history: []
    });
    harness.element("retry-load-btn").dispatch("click");
    await harness.settle(6);
    assert.strictEqual(harness.element("display-food-choice").children.length, 1);

    harness.sandbox.AppApi.initialize = async () => ({ choices: CHOICES, history: [] });
    harness.element("retry-load-btn").dispatch("click");
    await harness.settle(6);

    const back = harness.element("display-food-choice").children[0];
    assert.ok(back.text().includes("肯德基"), "候选项应该被装回来");
    assert.strictEqual(
        metaInputs(back).length,
        0,
        "候选项离开过列表，它的展开态就该被剪掉"
    );
    // 再展开时不能看到上一份数据的草稿
    const reopened = openEditor(harness, 0);
    assert.strictEqual(
        metaInput(reopened, "aliases").value,
        "",
        "候选项离开过列表，它的草稿就该被剪掉"
    );
}

// 写成功但列表刷新失败时，focusMeta 不能留着——否则下一次因为别的原因
// 重渲染（比如在筛选框里打字）会突然把光标塞进那个输入框。
async function checkStaleFocusRequestIsDropped() {
    const harness = createHarness();
    await harness.settle();
    const row = openEditor(harness, 0);
    const aliasInput = metaInput(row, "aliases");
    aliasInput.value = "西式";
    aliasInput.dispatch("input");
    harness.options.failRefresh = true;
    metaAddButton(aliasInput).click();
    await harness.settle(5);

    const filter = harness.element("choice-filter-input");
    filter.focus();
    filter.value = "肯";
    filter.dispatch("input");

    // 焦点必须还在筛选框里：泄漏的 focusMeta 会在这次重渲染时
    // 把光标塞进新渲染出来的别名输入框。
    assert.strictEqual(
        harness.sandbox.document.activeElement,
        filter,
        "在筛选框里打字，焦点不该被列表抢走"
    );
}

// 折叠时 aria-controls 指向的容器还不存在，这时不能写这个属性（无效引用）。
async function checkAriaControlsOnlyWhenExpanded() {
    const harness = createHarness();
    await harness.settle();
    const collapsed = harness.element("display-food-choice").children[0];
    const collapsedButton = editChoiceButton(collapsed);
    assert.strictEqual(
        collapsedButton.getAttribute("aria-controls"),
        undefined,
        "折叠态没有 .choice-meta 元素，不该写 aria-controls"
    );

    const expanded = openEditor(harness, 0);
    const expandedButton = editChoiceButton(expanded);
    const target = expandedButton.getAttribute("aria-controls");
    assert.strictEqual(target, "choice-meta-" + CHOICES[0].id);
    assert.ok(
        expanded.descendants().some((node) => node.id === target),
        "展开后 aria-controls 必须指向真实存在的元素"
    );

    // 再收起时属性要撤掉，不能留着指向已经不存在的元素
    expandedButton.click();
    assert.strictEqual(
        editChoiceButton(harness.element("display-food-choice").children[0])
            .getAttribute("aria-controls"),
        undefined,
        "收起后要撤掉 aria-controls"
    );
}

// 收起编辑器时，如果焦点正在被删掉的输入框里，要把焦点交回「编辑」按钮，
// 否则浏览器会把焦点丢回 <body>，键盘用户就迷路了。
async function checkCollapseKeepsFocusInTheCard() {
    const harness = createHarness();
    await harness.settle();
    const row = openEditor(harness, 0);
    metaInput(row, "aliases").focus();

    const openRow = harness.element("display-food-choice").children[0];
    assert.strictEqual(
        harness.sandbox.document.activeElement,
        metaInput(openRow, "aliases"),
        "桩里 focus() 要真的更新 activeElement"
    );

    editChoiceButton(openRow).click();
    const closed = harness.element("display-food-choice").children[0];
    assert.strictEqual(metaInputs(closed).length, 0, "收起后输入框要移除");
    assert.strictEqual(
        editChoiceButton(closed).focused,
        true,
        "收起时焦点要交回「编辑」按钮，不能掉到 body 上"
    );
}

// 加载失败时列表被换成「无法连接本地服务」，上面那句"共 N 个候选项"必须一起清掉。
async function checkFilterNoteIsClearedOnLoadFailure() {
    const harness = createHarness();
    await harness.settle();
    assert.ok(harness.element("choice-filter-note").textContent.includes("共 4 个候选项"));

    harness.sandbox.AppApi.initialize = async () => {
        throw new Error("连不上");
    };
    harness.element("retry-load-btn").dispatch("click");
    await harness.settle(6);

    assert.ok(
        harness.element("display-food-choice").children[0].textContent
            .includes("无法连接本地服务"),
        "加载失败要显示不可用状态"
    );
    assert.strictEqual(
        harness.element("choice-filter-note").textContent,
        "",
        "列表已经换成失败状态，候选人数量的说明不能还留着"
    );
}

// 和筛选无关的重渲染不该反复重写 aria-live 区域，否则屏幕阅读器会重复播报。
async function checkFilterNoteIsNotRewrittenUnnecessarily() {
    const harness = createHarness();
    await harness.settle();
    const note = harness.element("choice-filter-note");
    let writes = 0;
    let value = note.textContent;
    Object.defineProperty(note, "textContent", {
        get() { return value; },
        set(next) { writes += 1; value = next; },
        configurable: true
    });

    const row = openEditor(harness, 0);
    const input = metaInput(row, "aliases");
    input.value = "不改变数量的别名";
    metaAddButton(input).click();
    await harness.settle(5);

    assert.strictEqual(writes, 0, "内容没变就不该重写 live region，实际写了 " + writes + " 次");

    // 内容真的变了还是要写
    const filter = harness.element("choice-filter-input");
    filter.value = "肯德基";
    filter.dispatch("input");
    assert.strictEqual(writes, 1, "筛选结果变化时要更新说明");
    assert.ok(value.includes("筛选出 1 / 4"));
}

// 页头：头图由 CSS 提供，页面里不再叠装饰文字（图上本来就写着「吃什么」），
// 但屏幕阅读器可见的 h1 必须留着。
function checkHeaderMarkup() {
    const html = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");
    const css = fs.readFileSync(path.join(__dirname, "..", "main.css"), "utf8");
    const header = html
        .slice(html.indexOf("<header>"), html.indexOf("</header>"))
        // 注释里提到 <span> 不算标记，先剥掉注释再判断。
        .replace(/<!--[\s\S]*?-->/g, "");
    assert.ok(header.includes('class="visually-hidden"'), "页头必须保留屏幕阅读器可见的 h1");
    assert.ok(header.includes("今天吃什么"), "h1 文案被改动了");
    assert.ok(
        !/<span/.test(header),
        "页头不该再叠装饰文字：头图里已经写着「吃什么」"
    );

    const url = css.match(/background:\s*url\(([^)]+)\)/);
    assert.ok(url, "header 没有引用头图");
    const image = url[1].trim();
    assert.ok(
        image.startsWith("images/"),
        "头图路径应该相对于 main.css 放在 images/ 下，实际：" + image
    );
    // 静态服务只允许 images/ 与 fonts/ 两个目录，引用别的目录会 404。
    const file = path.join(__dirname, "..", image);
    assert.ok(fs.existsSync(file), "头图文件不存在：" + image);
    const size = fs.statSync(file).size;
    assert.ok(
        size < 600 * 1024,
        "头图是首屏资源，不该超过 600KB（当前 " + Math.round(size / 1024) + "KB）：" + image
    );
    assert.ok(!css.includes("header > span"), "header > span 的样式已经没用了，不该留着");
}

// 首页静态结构：欢迎语和装饰引号都已经删掉，选择框直接跟在视图开头。
function checkHomeMarkup() {
    const html = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");
    const css = fs.readFileSync(path.join(__dirname, "..", "main.css"), "utf8");
    assert.ok(
        html.includes('class="home-choice-layout"'),
        "选择框容器（.home-choice-layout）不见了"
    );
    assert.ok(!html.includes('class="welcome-line"'), "欢迎语已经删掉，不该再加回来");
    assert.ok(
        !html.includes("想好要点什么了吗"),
        "欢迎语文案已经删掉，不该再加回来"
    );
    assert.ok(!html.includes('class="quote"'), "装饰引号应该已经删掉");
    assert.ok(!css.includes(".welcome-line"), "欢迎语的样式已经没用了，不该留着");
    // 欢迎语原来是 home-view 的第一行，删掉后选择框应该紧跟在 section 之后。
    const view = html.slice(html.indexOf('id="home-view"'), html.indexOf('class="home-choice-layout"'));
    assert.ok(
        !/<p\b/.test(view),
        "home-view 里在选择框之前不该再有段落：删掉欢迎语之后这里应该是空的"
    );
}

async function main() {
    checkHomeMarkup();
    checkHeaderMarkup();
    checkChoicesMarkup();
    await checkChoicesAreCollapsedByDefault();
    await checkEditorTogglesOpenAndClosed();
    await checkChoiceFilter();
    await checkFilterAndEditorSurviveRerender();
    await checkDraftsSurviveRerender();
    await checkChoiceStateDoesNotOutliveTheList();
    await checkStaleFocusRequestIsDropped();
    await checkAriaControlsOnlyWhenExpanded();
    await checkCollapseKeepsFocusInTheCard();
    await checkFilterNoteIsClearedOnLoadFailure();
    await checkFilterNoteIsNotRewrittenUnnecessarily();
    await checkNewChoiceOpensItsEditor();
    await checkNewChoiceClearsNonMatchingFilter();
    await checkFocusIsRestored();
    await checkFailedRemovalReenablesTheButton();
    await checkRemovalWithFailedRefreshRemovesTheChip();
    await checkHistoryEditorEditsFoodAndTime();
    await checkHistoryEditorKeepsTimeWhenOnlyTheFoodChanges();
    await checkRankingChart();

    const harness = createHarness();
    await harness.settle();
    await harness.settle();

    const display = harness.element("display-food-choice");
    assert.strictEqual(
        display.children.length,
        CHOICES.length,
        "候选项列表没有全部渲染出来"
    );
    assert.strictEqual(
        harness.element("app-status").textContent,
        "",
        "启动不应产生错误状态：" + harness.element("app-status").textContent
    );

    // 折叠态没有输入框，展开之后别名和标签两个输入框都要在。
    display.children.forEach((row, index) => {
        editChoiceButton(row).click();
        const expandedRow = harness.element("display-food-choice").children[index];
        const kinds = metaInputs(expandedRow).map((input) => input.dataset.metaKind).sort();
        assert.deepStrictEqual(
            kinds,
            ["aliases", "tags"],
            "第 " + index + " 个候选项展开后要有别名和标签两个输入框，实际："
                + JSON.stringify(kinds)
        );
        editChoiceButton(expandedRow).click();
    });
    assert.strictEqual(
        display.children.length,
        CHOICES.length,
        "展开/收起不该改变列表条数"
    );
    display.children.forEach((row, index) => {
        assert.strictEqual(
            metaInputs(row).length,
            0,
            "第 " + index + " 张卡片收起后又出现了输入框"
        );
    });

    const kfcRow = display.children[0];
    assert.strictEqual(
        editChoiceButton(kfcRow).dataset.id,
        CHOICES[0].id,
        "「编辑」按钮要带上对应的候选项 id"
    );
    assert.ok(kfcRow.text().includes("肯德基"), "第一行应该是肯德基，实际：" + kfcRow.text());
    assert.ok(kfcRow.text().includes("KFC"), "已有别名应该渲染成标签块：" + kfcRow.text());
    assert.ok(kfcRow.text().includes("快餐"), "已有标签应该渲染成标签块：" + kfcRow.text());

    const searchInput = harness.element("food-search-input");
    const results = harness.element("food-search-results");

    searchInput.value = "KFC";
    searchInput.dispatch("input");
    assert.ok(results.text().includes("肯德基"), "搜 KFC 应该出肯德基，实际：" + results.text());
    assert.ok(results.text().includes("别名 KFC"), "结果里要说明为什么命中：" + results.text());

    searchInput.value = "快餐";
    searchInput.dispatch("input");
    assert.strictEqual(results.children.length, 2, "「快餐」应该命中两个候选项：" + results.text());

    searchInput.value = "没有这个东西";
    searchInput.dispatch("input");
    assert.strictEqual(results.children.length, 1);
    assert.ok(results.text().includes("没有找到匹配的候选项"), "空结果要有提示：" + results.text());

    searchInput.value = "kfc 面";
    searchInput.dispatch("input");
    assert.ok(
        results.text().includes("没有同时匹配全部关键词"),
        "AND 落空时要提示已回退到 OR：" + results.text()
    );
    assert.ok(results.text().includes("肯德基") && results.text().includes("重庆小面"));

    searchInput.value = "";
    searchInput.dispatch("input");
    assert.ok(results.text().includes("输入关键词开始搜索"), "空输入要有引导文案：" + results.text());

    assert.ok(
        harness.element("food-history").text().includes("肯德基"),
        "历史记录没有渲染"
    );
    const rankingText = harness.element("food-ranking").text();
    assert.ok(
        rankingText.includes("肯德基") && rankingText.includes("1 次 · 50%"),
        "统计排名（条形图）没有渲染：" + rankingText
    );
    assert.strictEqual(harness.element("total-count").textContent, 2);
    assert.strictEqual(harness.element("unique-count").textContent, 2);

    console.log(
        "ok   - 渲染冒烟测试全部通过（" + CHOICES.length + " 个候选项、"
        + STATE.history.length + " 条历史、排行榜 12 种食物）"
    );
}

main().catch((error) => {
    console.error("FAIL - " + error.message);
    process.exit(1);
});
