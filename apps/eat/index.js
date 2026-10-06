"use strict";

var foodChoiceInput = document.getElementById("user-food-choice");
var displayFoodChoice = document.getElementById("display-food-choice");
var formError = document.getElementById("form-error");
var choiceFormError = document.getElementById("choice-form-error");
var appStatus = document.getElementById("app-status");
var retryLoadBtn = document.getElementById("retry-load-btn");
var foodChosen = document.getElementById("food-choice");
var selectionActions = document.getElementById("selection-actions");
var foodSearchInput = document.getElementById("food-search-input");
var foodSearchResults = document.getElementById("food-search-results");
var randomChoiceBtn = document.getElementById("random-choice-btn");
var addFoodChoiceBtn = document.getElementById("add-food-choice-btn");
var choiceFilterInput = document.getElementById("choice-filter-input");
var choiceFilterNote = document.getElementById("choice-filter-note");
var confirmChoiceBtn = document.getElementById("confirm-choice-btn");
var cancelChoiceBtn = document.getElementById("cancel-choice-btn");
var foodHistoryList = document.getElementById("food-history");
var clearHistoryBtn = document.getElementById("clear-history-btn");
var totalCount = document.getElementById("total-count");
var uniqueCount = document.getElementById("unique-count");
var foodRanking = document.getElementById("food-ranking");
var rankingNote = document.getElementById("ranking-note");
var rankingFilters = document.querySelectorAll(".ranking-filter");
var trendSummary = document.getElementById("trend-summary");
var exportDataBtn = document.getElementById("export-data-btn");
var importFileInput = document.getElementById("import-file-input");
var importPreview = document.getElementById("import-preview");
var importSummary = document.getElementById("import-summary");
var mergeImportBtn = document.getElementById("merge-import-btn");
var replaceImportBtn = document.getElementById("replace-import-btn");
var navButtons = document.querySelectorAll(".nav-button");
var appViews = document.querySelectorAll(".app-view");

/*
 * 少数几处文案提到"本地服务""SQLite""data/backups"，那是桌面版的运行方式。
 * PWA 版跑在手机浏览器里、数据在 IndexedDB，同一句话就是错的（而且会让用户
 * 以为是电脑没开）。默认值保持桌面版原文，PWA 在 index.js 之前加载的
 * pwa-text.js 里整组覆盖——只有环境相关的文案走这张表，业务文案不动。
 */
var APP_TEXT = Object.assign({
    unavailable: "无法连接本地服务，数据没有加载。",
    reconnected: "已重新连接本地服务",
    clearHistoryConfirm: "将永久删除本机 SQLite 中的全部历史记录，且无法撤销。建议先导出备份。确定继续吗？",
    clearedWithSnapshot: function(target) {
        return "历史记录已清空，清空前的数据已备份到 " + target;
    },
    clearedWithoutSnapshot: "历史记录已清空（未能自动备份，请检查 data/backups 目录权限）",
    replaceWarning: "注意：未能自动备份，请检查 data/backups 目录权限"
}, window.AppText || {});

var state = {
    choices: [],
    history: [],
    pendingFoodChoice: null,
    loadFailed: false,
    // 添加别名/标签后要重新聚焦的输入框（列表会整体重渲染）。
    focusMeta: null,
    // 哪些候选项展开了编辑器。放在 state 里而不是 DOM 上：
    // 每加一个别名/标签列表都会整体重渲染，只认 DOM 的话编辑器会自己收起来。
    expandedChoices: {},
    // 展开的输入框里"打了字还没提交"的内容（键是 id + 类别）。
    // 筛选框每敲一个字、或在别处加一个别名，整张列表都会重建，
    // 不把草稿存在 state 里的话用户打了一半的字会被静默抹掉。
    metaDrafts: {},
    // 候选项列表的筛选词，同样要跨重渲染保留。
    choiceFilter: "",
    // 排行榜显示多少条；0 表示全部。只是界面偏好，不落库。
    rankingLimit: 10
};
var pendingImport = null;

function setStatus(message, type) {
    appStatus.textContent = message || "";
    appStatus.className = message ? "app-status " + (type || "info") : "app-status";
}

function setFormError(message) {
    formError.textContent = message || "";
}

function setChoiceFormError(message) {
    choiceFormError.textContent = message || "";
}

// 「写操作」和「重新拉取状态」必须分开处理：
// 写成功但刷新失败时，不能把结果报成失败，否则用户会重试并写出重复记录。
// 返回值里的 refreshed 表示界面是否已经跟着更新，调用方据此恢复按钮状态。
async function runAction(action, successMessage, onError) {
    var result;
    try {
        result = await action();
    } catch (error) {
        if (onError) {
            onError(error.message);
        } else {
            setStatus(error.message, "error");
        }
        return { ok: false, value: null, refreshed: false };
    }

    var message = typeof successMessage === "function"
        ? successMessage(result)
        : successMessage;
    setStatus(message, "success");

    try {
        await refreshState();
    } catch (error) {
        setStatus(message + "（但列表刷新失败，请手动刷新页面）", "error");
        return { ok: true, value: result, refreshed: false };
    }
    return { ok: true, value: result, refreshed: true };
}

function normalizeFoodName(value) {
    return value.trim().replace(/\s+/g, " ");
}

// 搜索规则（名字 / 别名 / 标签的匹配与打分）在 search.js 里，通过 AppSearch 使用。
// 放在独立文件是为了能用 node 直接跑 tests/test_search.js。

function showView(viewId) {
    appViews.forEach(function(view) {
        var isActive = view.id === viewId;
        view.hidden = !isActive;
        view.classList.toggle("active-view", isActive);
    });

    navButtons.forEach(function(button) {
        var isActive = button.dataset.view === viewId;
        button.classList.toggle("active", isActive);
        button.setAttribute("aria-current", isActive ? "page" : "false");
    });
}

function setState(nextState) {
    state.choices = Array.isArray(nextState.choices) ? nextState.choices : [];
    state.history = Array.isArray(nextState.history) ? nextState.history : [];
    // 展开态和草稿都是对当前列表的镜像，不能比列表活得更久：
    // 整表被换掉（重新加载、覆盖导入）之后，还留着旧键的状态会让
    // 用户从没打开过的新候选项自己展开，甚至带着上一份数据的草稿。
    var alive = {};
    state.choices.forEach(function(choice) {
        alive[choiceKey(choice)] = true;
    });
    Object.keys(state.expandedChoices).forEach(function(key) {
        if (!alive[key]) {
            delete state.expandedChoices[key];
        }
    });
    Object.keys(state.metaDrafts).forEach(function(key) {
        if (!alive[metaDraftOwner(key)]) {
            delete state.metaDrafts[key];
        }
    });
    state.loadFailed = false;
}

async function refreshState() {
    var nextState = await AppApi.getState();
    setState(nextState);
    renderAll();
}

// 加载失败时不能渲染「还没有选择记录」这类空状态文案：
// 那看起来和「数据丢了」一模一样。
function renderUnavailableStates() {
    var message = APP_TEXT.unavailable;
    [displayFoodChoice, foodSearchResults, foodHistoryList].forEach(function(container) {
        container.replaceChildren();
        var item = document.createElement("li");
        item.classList.add("empty-history");
        item.textContent = message;
        container.appendChild(item);
    });

    foodRanking.replaceChildren();
    var rankingItem = document.createElement("li");
    rankingItem.textContent = message;
    foodRanking.appendChild(rankingItem);
    rankingNote.textContent = "";
    // 列表已经被换成"无法连接"了，上面还留着"共 43 个候选项"会自相矛盾。
    setFilterNoteText("");

    totalCount.textContent = "—";
    uniqueCount.textContent = "—";
    trendSummary.textContent = message;
    clearHistoryBtn.disabled = true;
}

async function loadState() {
    retryLoadBtn.disabled = true;
    try {
        var initialState = await AppApi.initialize();
        setState(initialState);
        retryLoadBtn.hidden = true;
        renderAll();
        if (initialState.migrationWarning) {
            setStatus(initialState.migrationWarning, "error");
        }
        return true;
    } catch (error) {
        state.loadFailed = true;
        state.choices = [];
        state.history = [];
        retryLoadBtn.hidden = false;
        renderAll();
        setStatus(error.message, "error");
        return false;
    } finally {
        retryLoadBtn.disabled = false;
    }
}

// 别名和标签只有请求字段和文案不同，读写共用一套实现。
var META_CONFIG = {
    aliases: { field: "alias", label: "别名", placeholder: "加别名（如 KFC）" },
    tags: { field: "tag", label: "标签", placeholder: "加标签（如 快餐）" }
};

// /api/state 下发的是 {id, alias}/{id, tag}；这里同时容忍裸字符串，
// 免得一份手写的 state 把整个渲染打断。
function metaValue(item, key) {
    if (item && typeof item === "object" && typeof item[key] === "string") {
        return item[key];
    }
    return typeof item === "string" ? item : "";
}

function metaItems(value) {
    return Array.isArray(value) ? value : [];
}

// 展开态和草稿按「id + 名字」索引，不是只按 id：
// 重新加载或覆盖导入之后，同一个 id 可能落到另一个候选项上，
// 只认 id 的话新候选项会莫名带着上一个的展开状态和没提交的草稿。
function choiceKey(choice) {
    return choice.id + "|" + choice.name;
}

// 草稿的键：一个候选项的别名和标签各存一份。
function metaDraftKey(choice, kind) {
    return choiceKey(choice) + "|" + kind;
}

// 从草稿键取回它属于哪个候选项（去掉末尾的类别）。
function metaDraftOwner(key) {
    return String(key).slice(0, String(key).lastIndexOf("|"));
}

function setMetaDraft(key, value) {
    if (value) {
        state.metaDrafts[key] = value;
    } else {
        delete state.metaDrafts[key];
    }
}

// 折叠状态只显示"已经有什么"，不显示任何输入框和删除按钮：
// 预览块就是没有 × 的标签块，由 CSS 换成同名样式。
function createMetaChip(kind, item, choice, preview) {
    var config = META_CONFIG[kind];
    var value = metaValue(item, config.field);
    var chip = document.createElement("span");

    chip.classList.add("meta-chip");
    if (preview) {
        chip.classList.add("meta-chip-preview");
    }
    chip.appendChild(document.createTextNode(value));

    if (preview) {
        return chip;
    }

    var removeButton = document.createElement("button");
    var icon = document.createElement("span");
    removeButton.type = "button";
    removeButton.setAttribute("aria-label", "删除" + config.label + " " + value);
    icon.classList.add("delete-icon");
    icon.setAttribute("aria-hidden", "true");
    icon.textContent = "×";
    removeButton.appendChild(icon);
    removeButton.addEventListener("click", function() {
        removeChoiceMeta(choice.id, kind, item.id, removeButton);
    });

    chip.appendChild(removeButton);
    return chip;
}

// 一行只读预览：别名和标签分别成行，且带类别前缀。
// 没有值的类别不渲染空行，折叠态就不会被空格子撑高。
function createMetaPreviewRow(kind, choice) {
    var values = metaItems(choice[kind]);
    if (values.length === 0) {
        return null;
    }

    var row = document.createElement("div");
    var label = document.createElement("span");

    row.classList.add("meta-preview-row");
    row.classList.add(kind === "aliases" ? "meta-preview-aliases" : "meta-preview-tags");
    label.classList.add("meta-preview-label");
    label.textContent = META_CONFIG[kind].label;
    row.appendChild(label);

    values.forEach(function(item) {
        row.appendChild(createMetaChip(kind, item, choice, true));
    });
    return row;
}

function createMetaRow(kind, choice) {
    var config = META_CONFIG[kind];
    var row = document.createElement("div");
    var label = document.createElement("span");
    var input = document.createElement("input");
    var addButton = document.createElement("button");
    var values = metaItems(choice[kind]);

    row.classList.add("meta-row");
    label.classList.add("meta-label");
    label.textContent = config.label;
    row.appendChild(label);

    values.forEach(function(item) {
        row.appendChild(createMetaChip(kind, item, choice));
    });

    input.type = "text";
    input.classList.add("meta-input");
    input.maxLength = 40;
    input.placeholder = config.placeholder;
    input.setAttribute("aria-label", "为 " + choice.name + " 添加" + config.label);
    // 焦点在整张列表挂到 DOM 之后才恢复（见 renderFoodChoices）：
    // 对还没插入文档的元素调用 focus() 是空操作。
    input.dataset.metaKind = kind;
    input.dataset.choiceId = choice.id;
    // 把没提交的草稿填回去：列表会为了别的原因整体重建，
    // 用户打了一半的内容不该跟着消失。
    input.value = state.metaDrafts[metaDraftKey(choice, kind)] || "";
    input.addEventListener("input", function() {
        setMetaDraft(metaDraftKey(choice, kind), input.value);
    });
    addButton.type = "button";
    addButton.classList.add("meta-add");
    addButton.textContent = "添加";
    addButton.addEventListener("click", function() {
        addChoiceMeta(choice, kind, input);
    });
    input.addEventListener("keydown", function(event) {
        if (event.key === "Enter") {
            event.preventDefault();
            addChoiceMeta(choice, kind, input);
        }
    });

    row.appendChild(input);
    row.appendChild(addButton);
    return row;
}

// 列表里筛选是不是"没有同时包含所有词，退而显示部分匹配"。
// searchChoices 的 partial 就是这个意思，写下来给状态栏用文案说明。
var filterPartial = false;

// 按筛选词挑出要显示的候选项。没有筛选词就原样返回整个列表。
// 复用首页那套匹配（名字/别名/标签 + 归一化），而不是另写一遍 indexOf：
// 搜「kfc」能通过别名找到肯德基，「快餐」能通过标签找到它。
function visibleChoices() {
    var keyword = state.choiceFilter;
    filterPartial = false;
    if (!keyword) {
        return state.choices;
    }

    var result = AppSearch.searchChoices(state.choices, keyword);
    filterPartial = result.partial;
    // 管理列表要稳定顺序：按候选项目前的位置排，不按匹配得分排，
    // 否则筛选项的先后会随输入变化跳来跳去。
    return result.matches
        .slice()
        .sort(function(left, right) { return left.index - right.index; })
        .map(function(match) { return match.choice; });
}

function updateFilterNote(shown) {
    var total = state.choices.length;
    if (total === 0) {
        setFilterNoteText("还没有候选项，先在上面的输入框里添加。");
        return;
    }
    if (!state.choiceFilter) {
        setFilterNoteText("共 " + total + " 个候选项。点「编辑」可以加别名或标签。");
        return;
    }
    if (shown === 0) {
        setFilterNoteText("没有匹配「" + state.choiceFilter + "」的候选项。");
        return;
    }
    var note = "筛选出 " + shown + " / " + total + " 个候选项。";
    if (filterPartial) {
        note += "没有候选项同时包含全部关键词，下面是部分匹配。";
    }
    setFilterNoteText(note);
}

// #choice-filter-note 是 aria-live 区域：内容没变就不要重新赋值，
// 否则每次和筛选无关的重渲染都会让屏幕阅读器念一遍同样的句子。
function setFilterNoteText(text) {
    if (choiceFilterNote.textContent !== text) {
        choiceFilterNote.textContent = text;
    }
}

// 展开/收起就在原地改这一张卡片，不走整表重渲染。
// 重渲染会把其它已经展开的卡片里"输入到一半、还没提交"的文字一起抹掉。
// focusInput 只在用户主动展开时为真：渲染时恢复已展开的卡片不能抢焦点，
// 否则添加候选项之后，焦点会被列表从添加框里拽走。
function setChoiceEditorOpen(choice, listItem, open, focusInput) {
    var meta = listItem.querySelector(".choice-meta");
    var button = listItem.querySelector(".edit-choice");

    if (open) {
        if (meta) {
            return;
        }
        meta = document.createElement("div");
        meta.classList.add("choice-meta");
        meta.id = "choice-meta-" + choice.id;
        meta.appendChild(createMetaRow("aliases", choice));
        meta.appendChild(createMetaRow("tags", choice));
        listItem.appendChild(meta);
        listItem.classList.add("choice-expanded");
        if (focusInput) {
            // 展开就是为了改东西，别让用户再点一次输入框。
            var input = meta.querySelector(
                'input[data-choice-id="' + choice.id + '"][data-meta-kind="aliases"]'
            );
            if (input) {
                input.focus();
            }
        }
    } else {
        if (!meta) {
            return;
        }
        // 收起会把输入框从文档里删掉。如果焦点正落在里面，浏览器会把焦点
        // 丢回 <body>，键盘用户就"迷路"了——把焦点交回那个「编辑」按钮。
        if (focusInput && meta.contains(document.activeElement)) {
            if (button) {
                button.focus();
            }
        }
        meta.remove();
        listItem.classList.remove("choice-expanded");
    }

    if (button) {
        button.setAttribute("aria-expanded", open ? "true" : "false");
        // aria-controls 只在目标真的存在时才写：折叠态下 .choice-meta 还没建，
        // 指着一个不存在的 id 是无效引用。
        if (open) {
            button.setAttribute("aria-controls", "choice-meta-" + choice.id);
        } else {
            button.removeAttribute("aria-controls");
        }
        button.textContent = open ? "收起" : "编辑";
        button.setAttribute("aria-label",
            (open ? "收起 " : "编辑 ") + choice.name + " 的别名和标签");
    }
}

function findChoice(choiceId) {
    return state.choices.find(function(choice) {
        return String(choice.id) === String(choiceId);
    }) || null;
}

function toggleChoiceEditor(choiceId, listItem) {
    var choice = findChoice(choiceId);
    if (!choice) {
        return;
    }
    var open = !state.expandedChoices[choiceKey(choice)];

    if (open) {
        state.expandedChoices[choiceKey(choice)] = true;
    } else {
        delete state.expandedChoices[choiceKey(choice)];
    }
    setChoiceEditorOpen(choice, listItem, open, true);
}

function createExpandButton(choice, expanded, listItem) {
    var button = document.createElement("button");
    button.type = "button";
    button.classList.add("edit-choice");
    button.dataset.id = choice.id;
    button.setAttribute("aria-expanded", expanded ? "true" : "false");
    // 折叠态还没有 .choice-meta 这个元素，先不写 aria-controls（展开时补上）。
    if (expanded) {
        button.setAttribute("aria-controls", "choice-meta-" + choice.id);
    }
    button.setAttribute("aria-label",
        (expanded ? "收起 " : "编辑 ") + choice.name + " 的别名和标签");
    button.textContent = expanded ? "收起" : "编辑";
    button.addEventListener("click", function() {
        toggleChoiceEditor(choice.id, listItem);
    });
    return button;
}

// 折叠态：一行名字（加只读的别名/标签预览）加一个「编辑」。
// 别名和标签本身一直看得见，藏起来的只是输入框——
// 浏览是常事，改别名是偶发操作，不能让每个候选项都摊着两个空输入框。
function renderFoodChoices() {
    var choices = visibleChoices();
    displayFoodChoice.replaceChildren();
    updateFilterNote(choices.length);

    choices.forEach(function(choice) {
        var expanded = Boolean(state.expandedChoices[choiceKey(choice)]);
        var listItem = document.createElement("li");
        var head = document.createElement("div");
        var name = document.createElement("span");
        var actions = document.createElement("div");
        var button = document.createElement("button");
        var icon = document.createElement("span");

        listItem.dataset.id = choice.id;
        head.classList.add("choice-head");
        name.classList.add("choice-name");
        name.textContent = choice.name;
        head.appendChild(name);

        actions.classList.add("choice-actions");
        actions.appendChild(createExpandButton(choice, expanded, listItem));

        button.type = "button";
        button.classList.add("delete-choice");
        button.dataset.id = choice.id;
        button.setAttribute("aria-label", "删除 " + choice.name);
        // 用文字符号而不是图标字体：断网时图标字体会整个失效，
        // 按钮只剩一个没有符号的红色方块。
        icon.classList.add("delete-icon");
        icon.setAttribute("aria-hidden", "true");
        icon.textContent = "×";
        button.appendChild(icon);
        button.addEventListener("click", function() {
            deleteFoodChoice(choice.id, button);
        });
        actions.appendChild(button);

        head.appendChild(actions);
        listItem.appendChild(head);

        var preview = document.createElement("div");
        preview.classList.add("choice-preview");
        // 别名在前：搜「KFC」靠的就是它，比标签更常看。
        ["aliases", "tags"].forEach(function(kind) {
            var row = createMetaPreviewRow(kind, choice);
            if (row) {
                preview.appendChild(row);
            }
        });
        if (preview.children.length > 0) {
            listItem.appendChild(preview);
        }

        displayFoodChoice.appendChild(listItem);
        // 走和点击「编辑」同一条路径，省得"首次渲染的展开态"和"点击展开"
        // 各写一份，将来改了一处忘了另一处。这里不传 focusInput：
        // 渲染时恢复展开态不该抢焦点（加完候选项焦点要留在添加框里）。
        if (expanded) {
            setChoiceEditorOpen(choice, listItem, true);
        }
    });

    restoreMetaFocus();
}

// 刚加进去的候选项排在列表最后，多半在视口外：滚到可见处，用户才看得到加成功了。
// 刻意不抢焦点：用户刚在添加框里打完字，可能还要接着加下一个，
// 把焦点拽到新卡片的别名输入框会让他下一次输入落到错的地方。
function revealChoice(choiceId) {
    var items = displayFoodChoice.children;
    for (var index = 0; index < items.length; index += 1) {
        if (String(items[index].dataset.id) !== String(choiceId)) {
            continue;
        }
        var item = items[index];
        // node 的 DOM 桩没有 scrollIntoView，浏览器里才有。
        if (typeof item.scrollIntoView === "function") {
            item.scrollIntoView({ block: "nearest" });
        }
        return;
    }
}

// 添加别名/标签后列表会整体重渲染：把焦点放回同一个输入框，方便连续加几条。
function restoreMetaFocus() {
    var pending = state.focusMeta;
    if (!pending) {
        return;
    }
    state.focusMeta = null;
    var selector = 'input[data-choice-id="' + pending.choiceId
        + '"][data-meta-kind="' + pending.kind + '"]';
    var target = displayFoodChoice.querySelector(selector);
    if (target) {
        target.focus();
    }
}

function searchMetaSummary(choice) {
    var parts = [];
    var aliases = metaItems(choice.aliases);
    var tags = metaItems(choice.tags);
    if (aliases.length) {
        parts.push("别名 " + aliases.map(function(item) {
            return metaValue(item, "alias");
        }).join("、"));
    }
    if (tags.length) {
        parts.push("标签 " + tags.map(function(item) {
            return metaValue(item, "tag");
        }).join("、"));
    }
    return parts.join(" · ");
}

function renderFoodSearchResults() {
    foodSearchResults.replaceChildren();
    var result = AppSearch.searchChoices(state.choices, foodSearchInput.value);

    if (!result.keyword) {
        var promptItem = document.createElement("li");
        promptItem.classList.add("empty-search");
        promptItem.textContent = "输入关键词开始搜索。";
        foodSearchResults.appendChild(promptItem);
        return;
    }

    if (result.matches.length === 0) {
        var emptyItem = document.createElement("li");
        emptyItem.classList.add("empty-search");
        emptyItem.textContent = "没有找到匹配的候选项。可以在「可选项」里添加它，或给已有候选项加一个别名/标签。";
        foodSearchResults.appendChild(emptyItem);
        return;
    }

    if (result.partial) {
        var noteItem = document.createElement("li");
        noteItem.classList.add("search-partial-note");
        noteItem.textContent = "没有同时匹配全部关键词的候选项，以下是匹配任一关键词的结果：";
        foodSearchResults.appendChild(noteItem);
    }

    result.matches.forEach(function(match) {
        var choice = match.choice;
        var resultItem = document.createElement("li");
        var resultButton = document.createElement("button");
        var nameSpan = document.createElement("span");
        var metaText = searchMetaSummary(choice);

        resultButton.type = "button";
        nameSpan.textContent = choice.name;
        resultButton.appendChild(nameSpan);
        if (metaText) {
            var metaSpan = document.createElement("span");
            metaSpan.classList.add("search-result-meta");
            metaSpan.textContent = metaText;
            resultButton.appendChild(metaSpan);
        }
        resultButton.addEventListener("click", function() {
            selectFoodChoice(choice.name);
        });
        resultItem.appendChild(resultButton);
        foodSearchResults.appendChild(resultItem);
    });
}

function formatHistoryDate(selectedAt) {
    return new Date(selectedAt).toLocaleString("zh-CN", {
        year: "numeric",
        month: "numeric",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit"
    });
}

function padTwo(value) {
    return ("0" + value).slice(-2);
}

// <input type="datetime-local"> 只认本机时区的 "YYYY-MM-DDTHH:MM"，不带时区信息。
// 存的是 UTC，所以进出这个控件都要显式换算，不能直接 slice ISO 字符串。
function toLocalDateTimeValue(selectedAt) {
    var date = new Date(selectedAt);
    if (isNaN(date.getTime())) {
        return "";
    }
    return date.getFullYear() + "-" + padTwo(date.getMonth() + 1) + "-" + padTwo(date.getDate())
        + "T" + padTwo(date.getHours()) + ":" + padTwo(date.getMinutes());
}

function fromLocalDateTimeValue(value) {
    // 不带时区的日期时间按本机时区解释，再转成 UTC ISO 发给后端。
    var date = new Date(value);
    if (isNaN(date.getTime())) {
        return null;
    }
    return date.toISOString();
}

function renderHistory() {
    foodHistoryList.replaceChildren();
    clearHistoryBtn.disabled = state.history.length === 0;

    if (state.history.length === 0) {
        var emptyItem = document.createElement("li");
        emptyItem.classList.add("empty-history");
        emptyItem.textContent = "还没有选择记录。";
        foodHistoryList.appendChild(emptyItem);
        return;
    }

    state.history.forEach(function(item) {
        var historyItem = document.createElement("li");
        var details = document.createElement("span");
        var actions = document.createElement("span");

        details.classList.add("history-details");
        actions.classList.add("history-actions");
        historyItem.dataset.id = item.id;
        details.textContent = item.food + " · " + formatHistoryDate(item.selectedAt);
        historyItem.appendChild(details);

        if (item.editable || item.deletable) {
            var editButton = document.createElement("button");
            var deleteButton = document.createElement("button");

            if (item.editable) {
                editButton.type = "button";
                editButton.textContent = "编辑";
                editButton.addEventListener("click", function() {
                    editHistoryItem(item.id);
                });
                actions.appendChild(editButton);
            }

            // deletable 由后端计算：编辑窗口（五天）内的记录、以及时间戳损坏或落在未来的
            // 垃圾记录都可删（后者如果不可删，用户只能清空全部历史）。
            if (item.deletable) {
                deleteButton.type = "button";
                deleteButton.textContent = "删除";
                deleteButton.addEventListener("click", function() {
                    deleteHistoryItem(item.id, deleteButton);
                });
                actions.appendChild(deleteButton);
            }

            historyItem.appendChild(actions);
        }

        foodHistoryList.appendChild(historyItem);
    });
}

// 排行榜用原生 DOM + CSS 画横向条形图：条形长度按「相对最高次数」缩放，
// 这样榜首永远是满格，后面几条的差距一眼能看出来；百分比按总次数算在文字里。
// 不引入图表库、SVG 或 canvas：断网要能用，node 的 DOM 桩也要能验证。
function buildRanking(counts) {
    return Object.keys(counts)
        .sort(function(a, b) {
            return counts[b] - counts[a] || a.localeCompare(b);
        })
        .map(function(food) {
            return { food: food, count: counts[food] };
        });
}

function renderRanking(ranking, total) {
    foodRanking.replaceChildren();

    rankingFilters.forEach(function(button) {
        var isActive = Number(button.dataset.limit) === state.rankingLimit;
        button.classList.toggle("active", isActive);
        button.setAttribute("aria-pressed", isActive ? "true" : "false");
    });

    if (ranking.length === 0) {
        rankingNote.textContent = "";
        var emptyRanking = document.createElement("li");
        emptyRanking.classList.add("empty-history");
        emptyRanking.textContent = "还没有足够的数据。";
        foodRanking.appendChild(emptyRanking);
        return;
    }

    var limit = state.rankingLimit;
    var visible = limit > 0 ? ranking.slice(0, limit) : ranking;
    var maxCount = ranking[0].count;

    visible.forEach(function(entry) {
        var item = document.createElement("li");
        var label = document.createElement("span");
        var track = document.createElement("span");
        var bar = document.createElement("span");
        var value = document.createElement("span");

        item.classList.add("ranking-item");
        label.classList.add("ranking-label");
        label.textContent = entry.food;
        // 条形本身是装饰，次数和占比已经写在文字里，别让读屏器重复念一遍。
        track.classList.add("ranking-bar-track");
        track.setAttribute("aria-hidden", "true");
        bar.classList.add("ranking-bar");
        bar.style.width = Math.round((entry.count / maxCount) * 100) + "%";
        value.classList.add("ranking-count");
        value.textContent = entry.count + " 次 · " + Math.round((entry.count / total) * 100) + "%";

        track.appendChild(bar);
        item.appendChild(label);
        item.appendChild(track);
        item.appendChild(value);
        foodRanking.appendChild(item);
    });

    rankingNote.textContent = limit > 0 && ranking.length > limit
        ? "共 " + ranking.length + " 种食物，显示前 " + limit + " 种（按确认次数排序）。"
        : "共 " + ranking.length + " 种食物，已全部列出。";
}

function renderStatistics() {
    var counts = {};
    var today = new Date();
    var sevenDaysAgo = new Date(today);
    var thirtyDaysAgo = new Date(today);
    sevenDaysAgo.setHours(0, 0, 0, 0);
    thirtyDaysAgo.setHours(0, 0, 0, 0);
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 6);
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 29);

    state.history.forEach(function(item) {
        counts[item.food] = (counts[item.food] || 0) + 1;
    });

    totalCount.textContent = state.history.length;
    uniqueCount.textContent = Object.keys(counts).length;
    renderRanking(buildRanking(counts), state.history.length);

    var recentSeven = state.history.filter(function(item) {
        return new Date(item.selectedAt) >= sevenDaysAgo;
    }).length;
    var recentThirty = state.history.filter(function(item) {
        return new Date(item.selectedAt) >= thirtyDaysAgo;
    }).length;
    trendSummary.textContent = "近 7 天：" + recentSeven + " 次　|　近 30 天：" + recentThirty + " 次";
}

function renderAll() {
    if (state.loadFailed) {
        renderUnavailableStates();
        return;
    }
    renderFoodChoices();
    renderFoodSearchResults();
    renderHistory();
    renderStatistics();
}

async function editHistoryItem(id) {
    var item = state.history.find(function(historyItem) {
        return historyItem.id === id;
    });
    var historyItemElement = Array.from(foodHistoryList.children).find(function(element) {
        return element.dataset.id === id;
    });

    if (!item || !item.editable || !historyItemElement) {
        return;
    }

    var input = document.createElement("input");
    var timeInput = document.createElement("input");
    var saveButton = document.createElement("button");
    var cancelButton = document.createElement("button");
    var editor = document.createElement("span");
    var originalTimeValue = toLocalDateTimeValue(item.selectedAt);

    input.type = "text";
    input.value = item.food;
    input.maxLength = 40;
    input.setAttribute("aria-label", "食物名称");
    timeInput.type = "datetime-local";
    timeInput.value = originalTimeValue;
    timeInput.setAttribute("aria-label", "选择时间");
    saveButton.type = "button";
    saveButton.textContent = "保存";
    cancelButton.type = "button";
    cancelButton.textContent = "取消";
    editor.classList.add("history-editor");
    editor.appendChild(input);
    editor.appendChild(timeInput);
    editor.appendChild(saveButton);
    editor.appendChild(cancelButton);
    historyItemElement.replaceChildren(editor);
    input.focus();

    saveButton.addEventListener("click", async function() {
        var updatedFood = normalizeFoodName(input.value);
        if (!updatedFood) {
            setStatus("食物名称不能为空", "error");
            input.focus();
            return;
        }
        // 没动时间就直接回传存的原值：datetime-local 只到分钟，重算会截掉秒和毫秒；
        // 夏令时回拨那天，同一个本地字符串还可能被解析成另一个瞬间。
        var updatedTime = timeInput.value === originalTimeValue
            ? item.selectedAt
            : fromLocalDateTimeValue(timeInput.value);
        if (!updatedTime) {
            setStatus("请选择有效的日期和时间", "error");
            timeInput.focus();
            return;
        }
        saveButton.disabled = true;
        var outcome = await runAction(function() {
            return AppApi.updateHistory(id, updatedFood, updatedTime);
        }, "历史记录已更新");
        if (outcome.ok && outcome.refreshed) {
            return; // 成功且已刷新，整行会被 renderAll 重建
        }
        // 失败时保留输入框和用户已经输入的内容；
        // 写成功但刷新失败时也要恢复按钮，否则它会永久禁用。
        saveButton.disabled = false;
        if (!outcome.ok) {
            input.focus();
        }
    });

    [input, timeInput].forEach(function(field) {
        field.addEventListener("keydown", function(event) {
            if (event.key === "Enter") {
                event.preventDefault();
                saveButton.click();
            } else if (event.key === "Escape") {
                event.preventDefault();
                renderHistory();
            }
        });
    });

    cancelButton.addEventListener("click", renderHistory);
}

async function deleteHistoryItem(id, button) {
    // 单条删除没有快照，删掉就找不回来了，所以必须二次确认。
    if (!window.confirm("删除这条历史记录？此操作无法撤销。")) {
        return;
    }
    button.disabled = true;
    var outcome = await runAction(function() {
        return AppApi.deleteHistory(id);
    }, "历史记录已删除");
    if (!outcome.ok) {
        button.disabled = false;
        return;
    }
    if (!outcome.refreshed) {
        // 记录确实已经删掉，只是列表没刷新成功：
        // 本地同步一次，别留下"删不掉又删不动"的僵尸行。
        state.history = state.history.filter(function(item) {
            return item.id !== id;
        });
        renderAll();
    }
}

async function addFoodChoice() {
    var normalizedValue = normalizeFoodName(foodChoiceInput.value);
    setChoiceFormError("");

    if (!normalizedValue) {
        setChoiceFormError("输入内容不能为空");
        return;
    }

    addFoodChoiceBtn.disabled = true;
    var outcome = await runAction(function() {
        return AppApi.addChoice(normalizedValue);
    }, "候选项已添加", setChoiceFormError);
    addFoodChoiceBtn.disabled = false;
    if (outcome.ok) {
        foodChoiceInput.value = "";
        // 新候选项排在列表最后，长列表里很容易找不到；直接把它的编辑器打开。
        // POST 的响应里带 id，所以不依赖"刷新后重新查一遍"。
        // 注意 runAction 内部已经重渲染过了，改完展开状态必须自己再渲染一次。
        var created = outcome.value && outcome.value.choice;
        if (created && created.id !== undefined && created.id !== null) {
            state.expandedChoices[choiceKey(created)] = true;
            // 筛选词可能正好不匹配新加的这一项，那样它加完就"消失"了：
            // 把筛选彻底清掉（输入框里的词也一起清），让用户看得见刚加的东西。
            if (state.choiceFilter
                && !visibleChoices().some(function(choice) { return choice.id === created.id; })) {
                state.choiceFilter = "";
                choiceFilterInput.value = "";
            }
            renderFoodChoices();
            revealChoice(created.id);
        }
    }
}

async function addChoiceMeta(choice, kind, input) {
    var config = META_CONFIG[kind];
    var value = normalizeFoodName(input.value);
    setChoiceFormError("");

    if (!value) {
        setChoiceFormError(config.label + "不能为空");
        return;
    }

    state.focusMeta = { choiceId: choice.id, kind: kind };
    // 提交前先把草稿清掉：runAction 内部的重渲染会拿草稿回填输入框，
    // 留着的话刚提交的内容会被重新填回输入框里。
    var draftKey = metaDraftKey(choice, kind);
    setMetaDraft(draftKey, "");
    var outcome = await runAction(function() {
        return kind === "aliases"
            ? AppApi.addChoiceAlias(choice.id, value)
            : AppApi.addChoiceTag(choice.id, value);
    }, config.label + "已添加", setChoiceFormError);
    if (!outcome.ok) {
        // 失败时列表没重渲染，输入框里还是用户打的内容；把草稿放回去，
        // 免得之后因为别的原因重渲染时把这段输入弄丢。
        setMetaDraft(draftKey, input.value);
    }
    // 只有"重渲染过"才算用掉了这次焦点请求。写成功但列表没刷新成功时
    // 这个标记会一直留着，下一次因为别的原因重渲染（比如在筛选框里打字）
    // 就会突然把光标塞进这个输入框。
    if (!outcome.ok || !outcome.refreshed) {
        state.focusMeta = null;
    }
}

async function removeChoiceMeta(choiceId, kind, metaId, button) {
    var config = META_CONFIG[kind];
    // 防重复点击：双击会连发两次请求。
    button.disabled = true;
    var outcome = await runAction(function() {
        return kind === "aliases"
            ? AppApi.deleteChoiceAlias(choiceId, metaId)
            : AppApi.deleteChoiceTag(choiceId, metaId);
    }, config.label + "已删除", setChoiceFormError);
    if (!outcome.ok) {
        // 没删成就必须把按钮放开：runAction 失败时不会重渲染，
        // 否则这个 × 会一直点不动，用户只能刷新页面。
        button.disabled = false;
    } else if (!outcome.refreshed) {
        // 服务端已经删掉了，只是列表没刷新成功：至少把这个标签块从界面上移走。
        var chip = button.closest(".meta-chip");
        if (chip) {
            chip.remove();
        }
    }
}

async function deleteFoodChoice(id, button) {
    // 防重复点击：双击会连发两次请求。
    button.disabled = true;
    var outcome = await runAction(function() {
        return AppApi.deleteChoice(id);
    }, "候选项已删除");
    if (!outcome.ok) {
        button.disabled = false;
    }
    // 展开态和草稿不在这里清：刷新成功时 setState 会统一按"候选项还在不在"
    // 剪掉，不需要第二处再各清一遍。
    if (outcome.ok && !outcome.refreshed) {
        // 已经删掉了，只是列表没刷新成功：至少把这一行从界面上移走。
        // 删除按钮嵌在 .choice-head 里，所以要往上找到整个 li，
        // 否则别名/标签那两行会留在页面上。
        var listItem = button.closest("li");
        if (listItem) {
            listItem.remove();
        }
    }
}

function selectFoodChoice(foodName) {
    state.pendingFoodChoice = foodName;
    foodChosen.textContent = foodName;
    selectionActions.hidden = false;
    setFormError("");
}

function generateRandomFood() {
    setFormError("");
    if (state.choices.length === 0) {
        setFormError("没有可选的食物，无法进行随机选择");
        return;
    }

    var randomIndex = Math.floor(Math.random() * state.choices.length);
    selectFoodChoice(state.choices[randomIndex].name);
}

async function confirmFoodChoice() {
    if (!state.pendingFoodChoice) {
        return;
    }

    confirmChoiceBtn.disabled = true;
    // 只有写入成功才清空待确认结果；否则刷新失败会让用户重复写入同一条历史。
    var outcome = await runAction(function() {
        return AppApi.addHistory(state.pendingFoodChoice);
    }, "已加入历史记录");
    confirmChoiceBtn.disabled = false;

    if (outcome.ok) {
        state.pendingFoodChoice = null;
        selectionActions.hidden = true;
    }
}

function cancelFoodChoice() {
    state.pendingFoodChoice = null;
    foodChosen.textContent = "";
    selectionActions.hidden = true;
}

async function clearHistory() {
    if (state.history.length === 0) {
        return;
    }
    if (!window.confirm(APP_TEXT.clearHistoryConfirm)) {
        return;
    }

    clearHistoryBtn.disabled = true;
    var outcome = await runAction(function() {
        return AppApi.clearHistory();
    }, function(result) {
        return result && result.snapshot
            ? APP_TEXT.clearedWithSnapshot(result.snapshot)
            : APP_TEXT.clearedWithoutSnapshot;
    });
    if (outcome.ok && !outcome.refreshed) {
        // 历史确实已经清空，只是列表没刷新成功：本地同步一次，避免界面继续显示旧记录。
        state.history = [];
        renderHistory();
    }
    if (!outcome.ok || !outcome.refreshed) {
        clearHistoryBtn.disabled = state.history.length === 0;
    }
}

function hideImportPreview() {
    pendingImport = null;
    importPreview.hidden = true;
    importSummary.textContent = "";
    mergeImportBtn.disabled = false;
    replaceImportBtn.disabled = false;
}

function showImportPreview(result) {
    pendingImport = result.payload;
    var summary = result.preview.summary;
    importSummary.textContent = [
        "候选项：" + summary.choiceCount + " 条（现有重复 " + summary.existingChoiceCount
            + " 条；含别名 " + summary.aliasCount + " 条、标签 " + summary.tagCount + " 条）",
        "历史记录：" + summary.historyCount + " 条（ID 冲突 " + summary.historyIdConflictCount + " 条）",
        "无效项：" + summary.invalidCount + " 条，文件内重复：" + summary.duplicateCount + " 条"
    ].join("；");
    importPreview.hidden = false;
}

async function handleImportFile() {
    hideImportPreview();
    if (!importFileInput.files || !importFileInput.files[0]) {
        return;
    }

    try {
        var result = await AppApi.previewImport(importFileInput.files[0]);
        showImportPreview(result);
        setStatus("备份校验完成，请选择导入方式", "success");
    } catch (error) {
        setStatus(error.message, "error");
        importFileInput.value = "";
    }
}

function importSummaryMessage(mode, summary) {
    var parts = [mode === "replace" ? "数据已覆盖导入" : "数据已合并导入"];
    parts.push("候选项 " + summary.choiceCount + " 条");
    parts.push("历史 " + summary.historyCount + " 条");
    if (summary.insertedAliasCount || summary.insertedTagCount) {
        parts.push("别名 " + summary.insertedAliasCount + " 条、标签 " + summary.insertedTagCount + " 条");
    }
    if (summary.skippedMetaCount) {
        parts.push("跳过已存在或超出上限的别名/标签 " + summary.skippedMetaCount + " 条");
    }
    if (summary.skippedConflictCount) {
        parts.push("跳过 ID 冲突 " + summary.skippedConflictCount + " 条");
    }
    if (summary.invalidCount) {
        parts.push("忽略无效项 " + summary.invalidCount + " 条");
    }
    if (summary.snapshot) {
        parts.push("覆盖前的数据已备份到 " + summary.snapshot);
    } else if (mode === "replace") {
        parts.push(APP_TEXT.replaceWarning);
    }
    return parts.join("；");
}

async function applyPendingImport(mode) {
    if (!pendingImport) {
        return;
    }
    if (mode === "replace" && !window.confirm("覆盖导入会替换本机现有候选项和全部历史记录，确定继续吗？")) {
        return;
    }

    mergeImportBtn.disabled = true;
    replaceImportBtn.disabled = true;
    try {
        var result = await AppApi.applyImport(pendingImport, mode);
    } catch (error) {
        mergeImportBtn.disabled = false;
        replaceImportBtn.disabled = false;
        setStatus(error.message, "error");
        return;
    }

    // 导入接口已经返回最新状态，不需要再请求一次 /api/state。
    setState(result.state);
    renderAll();
    hideImportPreview();
    importFileInput.value = "";
    setStatus(importSummaryMessage(mode, result.summary), "success");
}

function triggerDownload(blob, filename) {
    var url = URL.createObjectURL(blob);
    var link = document.createElement("a");
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();

    // revoke 必须等一会儿再调：手机上（尤其装到主屏之后）点击会把下载交给
    // 另一个进程，紧接着 revoke 会让它拿到一个已经失效的 URL，表现为
    // "点了导出没反应"或者下载一个 0 字节的文件。桌面浏览器不等也常常没事，
    // 所以这个坑只在手机上出现。这个 URL 指向内存里的 Blob，等一分钟不算什么。
    //
    // 判断一下有没有定时器：极简 DOM 桩里没有 setTimeout，缺了就干脆不 revoke。
    // 少 revoke 只是多占一点内存，revoke 太早会让用户的备份下载不出来，
    // 两害相权取轻。
    if (typeof setTimeout === "function") {
        setTimeout(function() {
            URL.revokeObjectURL(url);
        }, 60000);
    }
}

function bindEvents() {
    navButtons.forEach(function(button) {
        button.addEventListener("click", function() {
            showView(button.dataset.view);
        });
    });

    rankingFilters.forEach(function(button) {
        button.addEventListener("click", function() {
            state.rankingLimit = Number(button.dataset.limit);
            renderStatistics();
        });
    });

    randomChoiceBtn.addEventListener("click", generateRandomFood);
    retryLoadBtn.addEventListener("click", async function() {
        setStatus("正在重新加载…", "info");
        if (await loadState()) {
            setStatus(APP_TEXT.reconnected, "success");
        }
    });
    foodSearchInput.addEventListener("input", renderFoodSearchResults);
    choiceFilterInput.addEventListener("input", function() {
        state.choiceFilter = normalizeFoodName(choiceFilterInput.value);
        renderFoodChoices();
    });
    addFoodChoiceBtn.addEventListener("click", addFoodChoice);
    foodChoiceInput.addEventListener("keydown", function(event) {
        if (event.key === "Enter") {
            event.preventDefault();
            addFoodChoice();
        }
    });
    confirmChoiceBtn.addEventListener("click", confirmFoodChoice);
    cancelChoiceBtn.addEventListener("click", cancelFoodChoice);
    clearHistoryBtn.addEventListener("click", clearHistory);
    exportDataBtn.addEventListener("click", async function() {
        exportDataBtn.disabled = true;
        try {
            // api.js 只负责取数据，触发下载这种 DOM 操作留在这一层。
            var file = await AppApi.fetchExport();
            if (window.AppFiles && typeof window.AppFiles.saveExport === "function") {
                // APK 用系统保存窗口，必须等文件写入成功才提示导出完成。
                await window.AppFiles.saveExport(file.blob, file.filename);
            } else {
                triggerDownload(file.blob, file.filename);
            }
            setStatus("数据已导出", "success");
        } catch (error) {
            setStatus(error.message, "error");
        } finally {
            exportDataBtn.disabled = false;
        }
    });
    importFileInput.addEventListener("change", handleImportFile);
    mergeImportBtn.addEventListener("click", function() {
        applyPendingImport("merge");
    });
    replaceImportBtn.addEventListener("click", function() {
        applyPendingImport("replace");
    });
}

async function initializeApp() {
    bindEvents();
    await loadState();
}

initializeApp().catch(function(error) {
    // 兜底：任何未被处理的启动异常都要让用户看到，而不是白屏。
    state.loadFailed = true;
    try {
        renderAll();
    } catch (renderError) {
        // 渲染本身失败时无能为力，至少保证下面的状态提示能显示。
    }
    setStatus("应用启动失败：" + error.message, "error");
});
