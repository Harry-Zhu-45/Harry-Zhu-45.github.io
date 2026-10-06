"use strict";

/*
 * 业务状态的纯函数层：候选项/别名/标签/历史的增删改查、导入合并与覆盖、
 * 快照构建。全部是同步的、只依赖传进来的 state 对象，不碰 DOM、不碰网络、
 * 不碰 IndexedDB——持久化在 database.js 里。
 *
 * 拆成这一层的原因和 search.js 一样：index.js 只能靠 DOM 桩在 node 里跑，
 * 而"加了重复候选项之后 id 会不会串位""覆盖导入之后 position 是不是从 0
 * 重排"这类问题必须能用 node 直接断言（tests/test_store.js，合成数据）。
 *
 * state 的形状（database.js 原样存取，不额外包装）：
 *   choices: [{id, name, position, aliases: [{id, alias}], tags: [{id, tag}]}]
 *   history: [{id, food, selectedAt, seq}]        seq 用来替代 SQLite 的 rowid
 *   meta:    {nextChoiceId, nextAliasId, nextTagId, nextSeq, initialized, revision}
 *
 * 调用约定：函数直接修改传入的 state（在 IndexedDB 事务里读出来的那份），
 * 并把结果返回给调用方。不做写时复制是因为写入方本来就持有事务内的最新数据，
 * 复制只会让"改了哪几个 store"变得难以判断。
 */
(function(root, factory) {
    var api = factory(
        typeof module === "object" && module.exports ? require("./validation.js") : root.AppValidation
    );
    if (typeof module === "object" && module.exports) {
        module.exports = api;
    }
    if (root) {
        root.AppStore = api;
    }
}(typeof window === "undefined" ? null : window, function(AppValidation) {
    if (!AppValidation) {
        throw new Error("store.js 依赖 validation.js，请确认它在前面加载");
    }

    // 内部快照的结构版本。和 SQLite 结构版本（2）、JSON 导出格式版本（2）
    // 都是独立的事，不要合并。
    var SNAPSHOT_SCHEMA_VERSION = 1;

    var META_KINDS = {
        aliases: { field: "alias", label: "别名", idField: "nextAliasId", store: "choices" },
        tags: { field: "tag", label: "标签", idField: "nextTagId", store: "choices" }
    };

    function createMeta() {
        return {
            nextChoiceId: 1,
            nextAliasId: 1,
            nextTagId: 1,
            nextSeq: 1,
            initialized: false,
            revision: 0
        };
    }

    function createEmptyState() {
        return { choices: [], history: [], meta: createMeta() };
    }

    // 从存储里读回的对象不能直接信：结构升级、手改过的库、写入中断都可能
    // 留下缺字段的记录，缺字段在这里补齐，避免渲染层到处判 undefined。
    function normalizeState(raw) {
        var state = createEmptyState();
        if (!raw || typeof raw !== "object") {
            return state;
        }
        var rawMeta = raw.meta && typeof raw.meta === "object" ? raw.meta : {};
        var meta = createMeta();
        Object.keys(meta).forEach(function(key) {
            if (typeof rawMeta[key] === typeof meta[key]) {
                meta[key] = rawMeta[key];
            }
        });
        state.meta = meta;

        (Array.isArray(raw.choices) ? raw.choices : []).forEach(function(item) {
            if (!item || typeof item !== "object") {
                return;
            }
            var choice = {
                id: Number(item.id),
                name: String(item.name === undefined ? "" : item.name),
                position: Number(item.position),
                aliases: normalizeMetaList(item.aliases, "alias"),
                tags: normalizeMetaList(item.tags, "tag")
            };
            if (!isFinite(choice.id) || !choice.name) {
                return;
            }
            if (!isFinite(choice.position)) {
                choice.position = state.choices.length;
            }
            state.choices.push(choice);
        });
        state.choices.sort(compareChoices);

        (Array.isArray(raw.history) ? raw.history : []).forEach(function(item) {
            if (!item || typeof item !== "object" || item.id === undefined || item.id === null) {
                return;
            }
            var seq = Number(item.seq);
            state.history.push({
                id: String(item.id),
                food: String(item.food === undefined ? "" : item.food),
                selectedAt: String(item.selectedAt === undefined ? "" : item.selectedAt),
                seq: isFinite(seq) ? seq : 0
            });
        });
        state.history.sort(compareHistory);

        // 计数器可能落后于实际数据（比如库是从别处复制来的）：取两者的较大值，
        // 否则新记录会撞上已经存在的 id。
        meta.nextChoiceId = Math.max(meta.nextChoiceId, maxOf(state.choices, "id") + 1);
        meta.nextAliasId = Math.max(meta.nextAliasId, maxOfMeta(state.choices, "aliases") + 1);
        meta.nextTagId = Math.max(meta.nextTagId, maxOfMeta(state.choices, "tags") + 1);
        meta.nextSeq = Math.max(meta.nextSeq, maxOf(state.history, "seq") + 1);
        return state;
    }

    function normalizeMetaList(raw, field) {
        var items = [];
        var seen = {};
        (Array.isArray(raw) ? raw : []).forEach(function(item) {
            var value = typeof item === "string" ? item : (item && item[field]);
            var id = typeof item === "object" && item ? Number(item.id) : NaN;
            if (typeof value !== "string" || !value) {
                return;
            }
            var key = AppValidation.foldedKey(value);
            if (Object.prototype.hasOwnProperty.call(seen, key)) {
                return;
            }
            seen[key] = true;
            // 没有 id 的条目（手改过的库、更早的结构）给一个负数占位：
            // 它不可能和真实 id 冲突，删除时也不会误删别的条目。
            var record = { id: isFinite(id) ? id : -(items.length + 1) };
            record[field] = value;
            items.push(record);
        });
        return items;
    }

    function maxOf(items, field) {
        return items.reduce(function(acc, item) {
            return item[field] > acc ? item[field] : acc;
        }, 0);
    }

    function maxOfMeta(choices, kind) {
        return choices.reduce(function(acc, choice) {
            return Math.max(acc, maxOf(choice[kind], "id"));
        }, 0);
    }

    // SQLite 侧是 `ORDER BY position, id`。
    function compareChoices(left, right) {
        if (left.position !== right.position) {
            return left.position - right.position;
        }
        return left.id - right.id;
    }

    // SQLite 侧是 `ORDER BY selected_at DESC, rowid DESC`。
    // 字符串比较对同一种口径的 ISO 时间戳就是时间比较（都是 UTC、等长）；
    // rowid 用 seq 替代，seq 大的后插入的排在前面。
    function compareHistory(left, right) {
        if (left.selectedAt !== right.selectedAt) {
            return left.selectedAt < right.selectedAt ? 1 : -1;
        }
        return right.seq - left.seq;
    }

    /*
     * 把外部传来的 id 转成整数，语义对着 database.py 的 `int()`。
     *
     * **不能**用 `Number()`：它把 "0x10" 当十六进制 16、把 "" 和 null 当 0。
     * 后果不是"报错文案不同"，而是**静默操作到另一行**——请求删 id "0x10"
     * 会真的删掉 id 16 那条记录，而电脑版会拒绝。这类错误不会有人发现，
     * 直到用户说"我的别名自己没了"。
     *
     * 只接受十进制整数：数字本身要是整数，字符串去掉首尾空白后要匹配
     * `[+-]?\d+`。比 Python 的 int() 更严一点（它接受 16.0 和 True），
     * 那是故意的：宽进来的都是"本来就不该传"的东西，拒绝比猜安全。
     */
    function coerceId(rawId, message) {
        if (typeof rawId === "number") {
            if (!Number.isSafeInteger(rawId)) {
                throw new AppValidation.ValidationError(message);
            }
            return rawId;
        }
        if (typeof rawId === "string" && /^[+-]?\d+$/.test(rawId.trim())) {
            var parsed = Number(rawId.trim());
            if (Number.isSafeInteger(parsed)) {
                return parsed;
            }
        }
        throw new AppValidation.ValidationError(message);
    }

    function findChoice(state, choiceId) {
        var id = Number(choiceId);
        for (var index = 0; index < state.choices.length; index += 1) {
            if (state.choices[index].id === id) {
                return state.choices[index];
            }
        }
        return null;
    }

    function requireChoice(state, choiceId) {
        var id = coerceId(choiceId, "候选项 ID 无效");
        var choice = findChoice(state, id);
        if (!choice) {
            throw new AppValidation.NotFoundError("候选项不存在");
        }
        return choice;
    }

    function findHistory(state, recordId) {
        var id = String(recordId);
        for (var index = 0; index < state.history.length; index += 1) {
            if (state.history[index].id === id) {
                return state.history[index];
            }
        }
        return null;
    }

    function requireHistory(state, recordId) {
        var record = findHistory(state, recordId);
        if (!record) {
            throw new AppValidation.NotFoundError("历史记录不存在");
        }
        return record;
    }

    function touch(state) {
        state.meta.revision += 1;
        return state;
    }

    // 下一个 position 取当前最大值 +1。SQLite 侧是在 INSERT 内部用子查询算的；
    // 这里读的是同一个事务里刚取出来的 state，等价于那次子查询。
    function nextPosition(state) {
        return state.choices.reduce(function(acc, choice) {
            return choice.position > acc ? choice.position : acc;
        }, -1) + 1;
    }

    function addChoice(state, rawName) {
        var name = AppValidation.normalizeFood(rawName);
        var key = AppValidation.foldedKey(name);
        var duplicated = state.choices.some(function(choice) {
            return AppValidation.foldedKey(choice.name) === key;
        });
        if (duplicated) {
            throw new AppValidation.ConflictError("不能添加重复的食物");
        }
        var choice = {
            id: state.meta.nextChoiceId,
            name: name,
            position: nextPosition(state),
            aliases: [],
            tags: []
        };
        state.meta.nextChoiceId += 1;
        state.choices.push(choice);
        touch(state);
        return { choice: choice };
    }

    function deleteChoice(state, choiceId) {
        var choice = requireChoice(state, choiceId);
        // 别名和标签随候选项一起删除（SQLite 侧靠 ON DELETE CASCADE）；
        // 历史记录不受影响：吃过什么是发生过的事，不该因为改候选列表而消失。
        state.choices = state.choices.filter(function(item) {
            return item !== choice;
        });
        touch(state);
        return { deleted: true };
    }

    function addChoiceMeta(state, kind, choiceId, rawValue) {
        var config = META_KINDS[kind];
        if (!config) {
            throw new AppValidation.ValidationError("元数据类型无效");
        }
        // 顺序对着 database.py 的 _add_choice_meta：先校验 id，**再校验值**，
        // 最后才查候选项在不在。反过来的话，"候选项不存在 + 值是空的"会报
        // "候选项不存在"，而电脑版报"食物名称不能为空"。
        var id = coerceId(choiceId, "候选项 ID 无效");
        // 别名和标签与食物名走同一套规范化：否则零宽字符能绕过去重，
        // 「KFC」和「KFC\u200b」会同时挂在一个候选项上。
        var value = AppValidation.normalizeFood(rawValue);
        var choice = findChoice(state, id);
        if (!choice) {
            throw new AppValidation.NotFoundError("候选项不存在");
        }
        var items = choice[kind];
        var key = AppValidation.foldedKey(value);
        var duplicated = items.some(function(item) {
            return AppValidation.foldedKey(item[config.field]) === key;
        });
        if (duplicated) {
            throw new AppValidation.ConflictError("该候选项已有这个" + config.label);
        }
        if (items.length >= AppValidation.MAX_CHOICE_META_ITEMS) {
            throw new AppValidation.ConflictError(
                "每个候选项最多 " + AppValidation.MAX_CHOICE_META_ITEMS + " 个" + config.label
            );
        }
        // 响应形状对着 server.py：别名/标签接口返回 {alias: {id, alias}}，
        // 前端用 added[field].id 拿新条目。
        var result = { id: state.meta[config.idField] };
        result[config.field] = value;
        items.push({ id: result.id, [config.field]: value });
        state.meta[config.idField] += 1;
        touch(state);
        var response = {};
        response[config.field] = result;
        return response;
    }

    function deleteChoiceMeta(state, kind, choiceId, metaId) {
        var config = META_KINDS[kind];
        if (!config) {
            throw new AppValidation.ValidationError("元数据类型无效");
        }
        var id = coerceId(choiceId, "候选项 ID 无效");
        var targetId = coerceId(metaId, "条目 ID 无效");
        // 对着 database.py 的 _delete_choice_meta：它只按 (id, choice_id) 删，
        // **不**先查候选项存不存在。所以候选项不存在时两边都必须报
        // "别名不存在"，而不是"候选项不存在"。
        var found = null;
        state.choices.forEach(function(item) {
            if (item.id === id) {
                found = item;
            }
        });
        if (found) {
            var before = found[kind].length;
            found[kind] = found[kind].filter(function(entry) {
                return entry.id !== targetId;
            });
            // 候选项在、条目不在，也是"别名不存在"。
            if (found[kind].length !== before) {
                touch(state);
                return { deleted: true };
            }
        }
        throw new AppValidation.NotFoundError(config.label + "不存在");
    }

    function addHistory(state, rawFood) {
        var record = {
            id: AppValidation.createHistoryId(),
            food: AppValidation.normalizeFood(rawFood),
            selectedAt: AppValidation.utcNow(),
            seq: state.meta.nextSeq
        };
        state.meta.nextSeq += 1;
        state.history.push(record);
        touch(state);
        return { record: publicHistory(record) };
    }

    function updateHistory(state, recordId, rawFood, rawSelectedAt) {
        // 顺序对着 database.py 的 update_history：**先校验食物名**，再查记录。
        // 反过来的话，"id 不存在 + 食物名不合法"会报"历史记录不存在"，
        // 而电脑版报"食物名称不能为空"——同一个请求在两边的解释不一样。
        var food = AppValidation.normalizeFood(rawFood);
        var record = requireHistory(state, recordId);
        if (!AppValidation.isEditableTimestamp(record.selectedAt)) {
            throw new AppValidation.ValidationError(
                "只能编辑最近 " + AppValidation.HISTORY_EDIT_WINDOW_DAYS + " 天（含今天）的历史记录"
            );
        }
        var selectedAt = AppValidation.parseTimestamp(rawSelectedAt);
        // 未来时间先单独拦掉：窗口只看日历日，"今天 23:00" 属于今天，
        // 但它仍然是未来，不能和前端"不能是未来"的说法不一致。
        if (new Date(selectedAt).getTime() > Date.now()) {
            throw new AppValidation.ValidationError("选择时间不能晚于现在");
        }
        // 新时间还必须落在同一个窗口里：否则一保存就跳出可编辑范围，
        // 用户看到的是"改完就锁死"。
        if (!AppValidation.isEditableTimestamp(selectedAt)) {
            throw new AppValidation.ValidationError(
                "选择时间必须在最近 " + AppValidation.HISTORY_EDIT_WINDOW_DAYS + " 天以内（含今天）"
            );
        }
        record.food = food;
        record.selectedAt = selectedAt;
        touch(state);
        return { record: publicHistory(record) };
    }

    function deleteHistory(state, recordId) {
        var record = requireHistory(state, recordId);
        // 时间戳损坏或落在未来的记录必须允许删除，
        // 否则用户只能靠"清空全部历史"来摆脱它。
        if (!AppValidation.isDeletableTimestamp(record.selectedAt)) {
            throw new AppValidation.ValidationError(
                "只能删除最近 " + AppValidation.HISTORY_EDIT_WINDOW_DAYS + " 天（含今天）的历史记录"
            );
        }
        state.history = state.history.filter(function(item) {
            return item !== record;
        });
        touch(state);
        return { deleted: true };
    }

    function clearHistory(state) {
        state.history = [];
        touch(state);
        return { cleared: true };
    }

    function clearAllChoices(state) {
        state.choices = [];
        touch(state);
        return { cleared: true };
    }

    // 破坏性操作前的一致副本。存的是完整内部状态：恢复时不需要"重新算一遍"，
    // 也就不存在算错的可能。
    function buildSnapshot(state, createdAt) {
        return {
            schemaVersion: SNAPSHOT_SCHEMA_VERSION,
            createdAt: createdAt || AppValidation.utcNow(),
            choices: JSON.parse(JSON.stringify(state.choices)),
            history: JSON.parse(JSON.stringify(state.history)),
            meta: JSON.parse(JSON.stringify(state.meta))
        };
    }

    // 回复给前端的状态。editable/deletable 由这里算（SQLite 版是后端算的），
    // 前端只读这两个字段，不自己判断日期。
    function publicHistory(record) {
        return {
            id: record.id,
            food: record.food,
            selectedAt: record.selectedAt,
            editable: AppValidation.isEditableTimestamp(record.selectedAt),
            deletable: AppValidation.isDeletableTimestamp(record.selectedAt)
        };
    }

    function publicChoice(choice) {
        return {
            id: choice.id,
            name: choice.name,
            aliases: choice.aliases.map(function(item) {
                return { id: item.id, alias: item.alias };
            }),
            tags: choice.tags.map(function(item) {
                return { id: item.id, tag: item.tag };
            })
        };
    }

    function toApiState(state) {
        return {
            choices: state.choices.slice().sort(compareChoices).map(publicChoice),
            history: state.history.slice().sort(compareHistory).map(publicHistory)
        };
    }

    // 现有候选项的去重键集合、现有历史 id -> [食物, 时间]，给预览算
    // existingChoiceCount / historyIdConflictCount 用。
    function existingIndex(state) {
        var choices = {};
        state.choices.forEach(function(choice) {
            choices[AppValidation.foldedKey(choice.name)] = true;
        });
        var history = {};
        state.history.forEach(function(record) {
            history[record.id] = [record.food, record.selectedAt];
        });
        return { choices: choices, history: history };
    }

    function previewImport(state, payload) {
        var cleaned = AppValidation.prepareImport(payload);
        var index = existingIndex(state);
        return {
            data: cleaned.data,
            summary: AppValidation.summarizeAgainstExisting(
                cleaned.summary, cleaned.data, index.choices, index.history
            )
        };
    }

    /*
     * _import_choices 的移植：按名字插入或复用候选项，并合并别名与标签。
     *
     * 合并导入时已存在的候选项必须复用，否则别名会挂到一个刚被去重拒绝、
     * 实际并不存在的新 id 上。上限也要在同一个事务里判：只截断单份备份不够，
     * 同一份备份反复 merge、或多份备份依次 merge 都会把并集越堆越大。
     */
    function importChoices(state, entries) {
        var existing = {};
        state.choices.forEach(function(choice) {
            existing[AppValidation.foldedKey(choice.name)] = choice;
        });
        var insertedChoices = 0;
        var insertedAliases = 0;
        var insertedTags = 0;
        var skippedMeta = 0;

        entries.forEach(function(entry) {
            var key = AppValidation.foldedKey(entry.name);
            var choice = existing[key];
            if (!choice) {
                choice = {
                    id: state.meta.nextChoiceId,
                    name: entry.name,
                    position: nextPosition(state),
                    aliases: [],
                    tags: []
                };
                state.meta.nextChoiceId += 1;
                state.choices.push(choice);
                existing[key] = choice;
                insertedChoices += 1;
            }
            ["aliases", "tags"].forEach(function(kind) {
                var config = META_KINDS[kind];
                entry[kind].forEach(function(value) {
                    var valueKey = AppValidation.foldedKey(value);
                    var duplicated = choice[kind].some(function(item) {
                        return AppValidation.foldedKey(item[config.field]) === valueKey;
                    });
                    if (duplicated || choice[kind].length >= AppValidation.MAX_CHOICE_META_ITEMS) {
                        // 已经存在的同义项、或已经到上限：都不算新增。
                        skippedMeta += 1;
                        return;
                    }
                    var record = { id: state.meta[config.idField] };
                    record[config.field] = value;
                    choice[kind].push(record);
                    state.meta[config.idField] += 1;
                    if (kind === "aliases") {
                        insertedAliases += 1;
                    } else {
                        insertedTags += 1;
                    }
                });
            });
        });

        return {
            insertedChoices: insertedChoices,
            insertedAliases: insertedAliases,
            insertedTags: insertedTags,
            skippedMeta: skippedMeta
        };
    }

    /*
     * apply_import 的移植。
     *
     * 调用方（database.js）负责在同一事务里先把快照写好，再调用这个函数；
     * 这里只改内存状态。覆盖导入时"先快照再删"的顺序不能反过来。
     */
    function applyImport(state, payload, mode) {
        if (mode !== "merge" && mode !== "replace") {
            throw new AppValidation.ValidationError("导入模式无效");
        }
        var cleaned = AppValidation.prepareImport(payload);
        if (mode === "replace" && cleaned.data.choices.length === 0
            && cleaned.data.history.length === 0) {
            // 空备份不能用来清空数据库：这几乎总是"选错文件"，而不是本意。
            throw new AppValidation.ValidationError("备份中没有数据，已阻止覆盖导入");
        }

        var summary = cleaned.summary;
        var inserted;
        var skippedConflictCount = 0;

        if (mode === "replace") {
            state.choices = [];
            state.history = [];
            inserted = importChoices(state, cleaned.data.choices);
            cleaned.data.history.forEach(function(record) {
                state.history.push({
                    id: record.id,
                    food: record.food,
                    selectedAt: record.selectedAt,
                    seq: state.meta.nextSeq
                });
                state.meta.nextSeq += 1;
            });
        } else {
            inserted = importChoices(state, cleaned.data.choices);
            cleaned.data.history.forEach(function(record) {
                if (findHistory(state, record.id)) {
                    skippedConflictCount += 1;
                    return;
                }
                state.history.push({
                    id: record.id,
                    food: record.food,
                    selectedAt: record.selectedAt,
                    seq: state.meta.nextSeq
                });
                state.meta.nextSeq += 1;
            });
        }

        // 计数器只前进不后退：覆盖导入之后如果沿用旧的最大值，下一次新增候选项
        // 会撞上刚导入进来的 id。
        state.meta.nextChoiceId = Math.max(state.meta.nextChoiceId, maxOf(state.choices, "id") + 1);
        state.meta.nextAliasId = Math.max(state.meta.nextAliasId, maxOfMeta(state.choices, "aliases") + 1);
        state.meta.nextTagId = Math.max(state.meta.nextTagId, maxOfMeta(state.choices, "tags") + 1);
        state.meta.nextSeq = Math.max(state.meta.nextSeq, maxOf(state.history, "seq") + 1);
        // 导入过数据就说明"这台设备已经投入使用"，不要再播种默认候选项。
        // 对着 database.py 的 apply_import：它在同一处把 browser_v1_migrated
        // 置成 true。不置位的话，"先合并导入、再 initialize"会把 8 个默认
        // 候选项追加到导入的数据后面——用户会看到一堆自己没加过的条目。
        // 正常流程下 initialize() 在页面加载时就跑过了，但直接调 AppApi
        // （或将来改了初始化顺序）就会踩到。
        state.meta.initialized = true;
        touch(state);

        summary.insertedChoiceCount = inserted.insertedChoices;
        summary.insertedAliasCount = inserted.insertedAliases;
        summary.insertedTagCount = inserted.insertedTags;
        summary.skippedMetaCount = inserted.skippedMeta;
        summary.skippedConflictCount = skippedConflictCount;
        return { summary: summary, state: state };
    }

    /*
     * 首次启动的默认候选项。判断依据是 metadata 里的 initialized 标记，
     * 不是"候选列表为空"：用户把候选项全删光是合法状态，那时重新种一遍
     * 默认值等于把删除操作撤销了。
     */
    function initializeIfNeeded(state) {
        if (state.meta.initialized) {
            return { seeded: 0 };
        }
        var seeded = 0;
        AppValidation.DEFAULT_CHOICES.forEach(function(name) {
            try {
                addChoice(state, name);
                seeded += 1;
            } catch (error) {
                if (!(error instanceof AppValidation.ConflictError)) {
                    throw error;
                }
            }
        });
        state.meta.initialized = true;
        return { seeded: seeded };
    }

    // 导出载荷。取一致状态这件事由调用方在一个 readonly 事务里完成。
    function buildExport(state, exportedAt) {
        return AppValidation.buildExportPayload(
            state.choices.slice().sort(compareChoices),
            state.history.slice().sort(compareHistory),
            exportedAt
        );
    }

    return {
        SNAPSHOT_SCHEMA_VERSION: SNAPSHOT_SCHEMA_VERSION,
        META_KINDS: META_KINDS,
        // 转发两个 validation 里的常量：database.js 只加载 store.js，
        // 不该为了拿一个数字再去 require 一次 validation。
        SNAPSHOT_LIMIT: AppValidation.SNAPSHOT_LIMIT,
        foldedKey: AppValidation.foldedKey,
        // 错误类也转发出去：上层（api-local.js、database.js）判断"这是业务拒绝
        // 还是存储故障"时，不想到处再 require 一次 validation.js。
        ValidationError: AppValidation.ValidationError,
        ConflictError: AppValidation.ConflictError,
        NotFoundError: AppValidation.NotFoundError,
        createMeta: createMeta,
        createEmptyState: createEmptyState,
        normalizeState: normalizeState,
        compareChoices: compareChoices,
        compareHistory: compareHistory,
        findChoice: findChoice,
        findHistory: findHistory,
        addChoice: addChoice,
        deleteChoice: deleteChoice,
        addChoiceMeta: addChoiceMeta,
        deleteChoiceMeta: deleteChoiceMeta,
        addHistory: addHistory,
        updateHistory: updateHistory,
        deleteHistory: deleteHistory,
        clearHistory: clearHistory,
        clearAllChoices: clearAllChoices,
        buildSnapshot: buildSnapshot,
        publicChoice: publicChoice,
        publicHistory: publicHistory,
        toApiState: toApiState,
        existingIndex: existingIndex,
        previewImport: previewImport,
        importChoices: importChoices,
        applyImport: applyImport,
        initializeIfNeeded: initializeIfNeeded,
        buildExport: buildExport
    };
}));
