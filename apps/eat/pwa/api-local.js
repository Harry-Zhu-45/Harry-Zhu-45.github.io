"use strict";

/*
 * PWA 版的 AppApi：和 api.js 是同一份契约（15 个方法、同样的返回形状、
 * 同样的错误文案），但数据全部来自本机 IndexedDB，不发一个网络请求。
 *
 * 契约必须一致，因为 index.js 只认 AppApi 这一层：
 *   initialize() -> 状态 + migrationWarning
 *   addChoice(name) -> {choice}
 *   addChoiceAlias/addChoiceTag(choiceId, value) -> {alias}/{tag}
 *   deleteChoiceAlias/deleteChoiceTag(choiceId, metaId) -> {deleted: true}
 *   addHistory(food) -> {record}
 *   updateHistory(id, food, selectedAt) -> {record}
 *   deleteHistory(id) -> {deleted: true}
 *   clearHistory() -> {snapshot}
 *   previewImport(file) -> {payload, preview}
 *   applyImport(payload, mode) -> {summary, state}
 *   fetchExport() -> {blob, filename}
 *
 * 与 api.js 的三处故意不同，都写在各自位置：
 * 1. 不发请求，所以没有"请确认 server.py 正在运行"这类文案；
 * 2. initialize() 不做浏览器 v1（localStorage）迁移：那条路径要写进 SQLite，
 *    PWA 的库里从第一天就是 IndexedDB，没有旧数据要接管；
 * 3. 导出靠 Blob，不再依赖 Content-Disposition 响应头。
 */
(function(root, factory) {
    var api = factory(
        typeof module === "object" && module.exports
            ? { database: require("./database.js"), validation: require("./validation.js") }
            : { database: root.AppDatabase, validation: root.AppValidation }
    );
    if (typeof module === "object" && module.exports) {
        module.exports = api;
    }
    if (root) {
        root.createLocalApi = api.create;
        // bootstrap.js 用它决定是否注册 Service Worker：node 里没有 navigator，
        // 而且这个模块本身要被单测直接 require。
        if (typeof root.indexedDB !== "undefined") {
            root.AppApi = api.create();
        }
    }
}(typeof window === "undefined" ? null : window, function(deps) {
    var AppDatabase = deps.database;
    var AppValidation = deps.validation;
    if (!AppDatabase || !AppValidation) {
        throw new Error("api-local.js 依赖 database.js 和 validation.js，请确认它们在前面加载");
    }

    function createError(message) {
        return new Error(message || "操作失败");
    }

    /*
     * 一条前端依赖的行为：index.js 的 runAction 会把 error.message 原样显示，
     * 所以这里只做"包装"不做"改写"——业务拒绝（重复的食物、超出编辑窗口）
     * 必须原句透出。
     */
    function rethrow(error) {
        if (error instanceof Error) {
            throw error;
        }
        throw createError(String(error));
    }

    function create(options) {
        var settings = options || {};
        var database = settings.database || AppDatabase.create(settings.databaseOptions);

        /*
         * 首次启动。返回形状对着 api.js 的 initialize()：
         * 直接是 state 本身，外加 migrationWarning 字段。
         *
         * PWA 版没有浏览器旧数据要迁移，所以 migrationWarning 只在
         * "本地库初始化失败但仍能读出空状态"时为非 null——目前不会发生，
         * 保留字段是因为 index.js 会读它。
         */
        async function initialize() {
            try {
                var outcome = await database.initialize();
                return outcome.state;
            } catch (error) {
                rethrow(error);
            }
        }

        async function getState() {
            try {
                return await database.getState();
            } catch (error) {
                rethrow(error);
            }
        }

        async function addChoice(name) {
            try {
                return await database.addChoice(name);
            } catch (error) {
                rethrow(error);
            }
        }

        async function deleteChoice(id) {
            try {
                return await database.deleteChoice(id);
            } catch (error) {
                rethrow(error);
            }
        }

        async function addChoiceAlias(choiceId, alias) {
            try {
                return await database.addChoiceMeta("aliases", choiceId, alias);
            } catch (error) {
                rethrow(error);
            }
        }

        async function deleteChoiceAlias(choiceId, aliasId) {
            try {
                return await database.deleteChoiceMeta("aliases", choiceId, aliasId);
            } catch (error) {
                rethrow(error);
            }
        }

        async function addChoiceTag(choiceId, tag) {
            try {
                return await database.addChoiceMeta("tags", choiceId, tag);
            } catch (error) {
                rethrow(error);
            }
        }

        async function deleteChoiceTag(choiceId, tagId) {
            try {
                return await database.deleteChoiceMeta("tags", choiceId, tagId);
            } catch (error) {
                rethrow(error);
            }
        }

        async function addHistory(food) {
            try {
                return await database.addHistory(food);
            } catch (error) {
                rethrow(error);
            }
        }

        async function updateHistory(id, food, selectedAt) {
            try {
                return await database.updateHistory(id, food, selectedAt);
            } catch (error) {
                rethrow(error);
            }
        }

        async function deleteHistory(id) {
            try {
                return await database.deleteHistory(id);
            } catch (error) {
                rethrow(error);
            }
        }

        /*
         * 清空历史。index.js 读 result.snapshot 决定提示语，桌面版那里是备份
         * 目录路径。这里给一个字符串（快照时间），拼进同一句提示语里读得通：
         * "历史记录已清空，清空前的数据已备份到 <时间>"。
         */
        async function clearHistory() {
            try {
                var result = await database.clearHistory();
                return { cleared: result.cleared, snapshot: result.snapshotAt };
            } catch (error) {
                rethrow(error);
            }
        }

        /*
         * 预览导入。文件读取和 JSON 解析都在事务之外——IndexedDB 的事务
         * 一碰到 await 文件读取就会自动提交，写进去的判定也就没了。
         */
        async function previewImport(file) {
            var payload = await readJsonFile(file);
            try {
                var preview = await database.previewImport(payload);
                return { payload: payload, preview: preview };
            } catch (error) {
                rethrow(error);
            }
        }

        async function applyImport(payload, mode) {
            try {
                return await database.applyImport(payload, mode);
            } catch (error) {
                rethrow(error);
            }
        }

        /*
         * 导出。桌面版从 Content-Disposition 拿文件名，这里自己拼：
         * 命名规则和 server.py 保持一致（what-should-we-eat-YYYY-MM-DD.json），
         * 两个版本的备份文件放在一起时看不出区别。
         */
        async function fetchExport() {
            var payload;
            try {
                payload = await database.buildExport();
            } catch (error) {
                rethrow(error);
            }
            var text = JSON.stringify(payload, null, 2);
            return {
                blob: new Blob([text], { type: "application/json;charset=utf-8" }),
                filename: exportFilename(new Date())
            };
        }

        function exportFilename(date) {
            return "what-should-we-eat-"
                + date.getFullYear() + "-" + pad2(date.getMonth() + 1) + "-" + pad2(date.getDate())
                + ".json";
        }

        function pad2(value) {
            return value < 10 ? "0" + value : String(value);
        }

        return {
            initialize: initialize,
            getState: getState,
            addChoice: addChoice,
            deleteChoice: deleteChoice,
            addChoiceAlias: addChoiceAlias,
            deleteChoiceAlias: deleteChoiceAlias,
            addChoiceTag: addChoiceTag,
            deleteChoiceTag: deleteChoiceTag,
            addHistory: addHistory,
            updateHistory: updateHistory,
            deleteHistory: deleteHistory,
            clearHistory: clearHistory,
            previewImport: previewImport,
            applyImport: applyImport,
            fetchExport: fetchExport,
            // 给测试和 bootstrap 用：拿到下层数据库（比如 listSnapshots）。
            database: database
        };
    }

    // 三个文件读取的失败原因要分开报，否则用户不知道是选错文件还是文件坏了。
    async function readJsonFile(file) {
        if (!file) {
            throw createError("请先选择备份文件");
        }
        var text;
        try {
            text = await file.text();
        } catch (error) {
            throw createError("无法读取备份文件");
        }
        try {
            return JSON.parse(text);
        } catch (error) {
            throw createError("备份文件不是有效的 JSON");
        }
    }

    return { create: create };
}));
