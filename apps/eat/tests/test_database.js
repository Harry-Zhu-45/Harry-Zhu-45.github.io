"use strict";

/*
 * pwa/database.js（IndexedDB 持久化层）的回归测试：node tests/test_database.js
 *
 * 环境里没有浏览器自动化工具、也没有 npm 可以装 fake-indexeddb，所以这一层
 * 以前只能靠"打开页面点一点"验证，而它恰好管着"数据会不会丢"。这里用
 * tests/helpers/fake-indexeddb.js 造一个内存版 IndexedDB，把
 * `AppDatabase.create({ indexedDB: fake, name })` 真跑一遍，覆盖：
 *
 *   1  首次初始化种默认候选项，重复初始化不翻倍
 *   2  候选项被全删光之后重新 initialize 不会再种一遍
 *   3  候选项/别名/标签/历史的增删改查往返
 *   4  重复候选项/重复别名被拒绝，且不留痕迹（abort 回滚）
 *   5  去重走 casefold（大小写、ß/ss）
 *   6  历史的编辑窗口、删除窗口、未来时间
 *   7  历史排序：selectedAt DESC, seq DESC
 *   8  清空历史留快照，快照里有清空前的数据
 *   9  快照上限 SNAPSHOT_LIMIT，保留最近的那几份
 *  10  导入：merge 不覆盖、replace 留快照、空备份/v1/别人的备份被拒
 *  11  同一份备份合并两次是幂等的
 *  12  buildExport 的形状（只导出该有的字段）
 *  13  close() 之后数据还在（模拟关掉页面再打开）
 *  14  库的版本比代码高时拒写，且不删库
 *  15  blocked：有旧连接挡着时给出"关掉其它标签页"的提示
 *  16  配额不足时提示"存储空间不足"，且整体回滚
 *  17  indexedDB 不可用时 supported=false，connect() 明确拒绝
 *
 * 测试不往项目目录写任何文件：全部数据都在内存里（假实现 + 假数据库名）。
 */

const assert = require("node:assert/strict");

const { createFakeIndexedDB } = require("./helpers/fake-indexeddb.js");
const AppDatabase = require("../pwa/database.js");
const AppStore = require("../pwa/store.js");
const AppValidation = require("../pwa/validation.js");

const APP_ID = "what-should-we-eat";
const SCHEMA_VERSION = 2;
const DAY = 86400000;

/* ------------------------------------------------------------------ *
 * 断言与报告
 *
 * 每条断言都写清楚"为什么这条重要"：以后有人改坏了，失败信息本身要能说明
 * 用户会遇到什么，而不是只丢一个 expected/actual。
 * ------------------------------------------------------------------ */

const failures = [];
let passed = 0;

async function test(title, body) {
    try {
        await body();
        passed += 1;
        console.log("ok   - " + title);
    } catch (error) {
        failures.push({ title: title, error: error });
        console.error("FAIL - " + title);
        console.error("       " + (error && error.message ? error.message : String(error)));
    }
}

/*
 * 断言一个 Promise 一定被拒绝，并把错误交给调用方继续检查。
 * 单独写一个是因为「没有抛错」这种情况用 try/catch 包起来最容易写漏。
 */
async function rejects(promise, message) {
    let captured = null;
    try {
        await promise;
    } catch (error) {
        captured = error;
    }
    assert.notStrictEqual(captured, null, message + "（应当抛错，但操作成功了）");
    return captured;
}

/* ------------------------------------------------------------------ *
 * 测试数据与工具
 * ------------------------------------------------------------------ */

function isoAgo(milliseconds) {
    return new Date(Date.now() - milliseconds).toISOString();
}

function isoAhead(milliseconds) {
    return new Date(Date.now() + milliseconds).toISOString();
}

function backupOf(choices, history) {
    return {
        app: APP_ID,
        schemaVersion: SCHEMA_VERSION,
        exportedAt: new Date().toISOString(),
        choices: choices || [],
        history: history || []
    };
}

function historyEntry(id, food, selectedAt) {
    return { id: id, food: food, selectedAt: selectedAt };
}

// 一个干净的假 factory + 一个 AppDatabase，每个用例各用各的，互不干扰。
function freshDatabase(label) {
    const fake = createFakeIndexedDB();
    return { fake: fake, db: AppDatabase.create({ indexedDB: fake, name: label }) };
}

/*
 * 绕过 database.js 直接开一个连接，用来造"另一个标签页"的场景
 * （blocked、versionchange、直接看快照里存了什么）。
 */
function openRaw(fake, name, version, onUpgrade) {
    return new Promise((resolve, reject) => {
        const request = fake.open(name, version);
        if (typeof onUpgrade === "function") {
            request.onupgradeneeded = onUpgrade;
        }
        request.onblocked = () => reject(new Error("open 被 blocked 了"));
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}

// 直接读某个对象仓库的全部内容（只读事务），用于核对快照里到底存了什么。
function readRawStore(fake, name, storeName) {
    return openRaw(fake, name).then((connection) => new Promise((resolve, reject) => {
        const transaction = connection.transaction([storeName], "readonly");
        const request = transaction.objectStore(storeName).getAll();
        request.onsuccess = () => {
            connection.close();
            resolve(request.result);
        };
        request.onerror = () => {
            connection.close();
            reject(request.error);
        };
    }));
}

// 等一小会儿，让两次破坏性操作的 createdAt（毫秒精度）有机会不同。
function tick() {
    return new Promise((resolve) => {
        setTimeout(resolve, 3);
    });
}

function namesOf(choices) {
    return choices.map((choice) => choice.name);
}

/* ------------------------------------------------------------------ *
 * 用例
 * ------------------------------------------------------------------ */

async function main() {
    await test("1. 首次 initialize 种下默认候选项，重复调用不会翻倍", async () => {
        const { db } = freshDatabase("init");
        const first = await db.initialize();
        assert.strictEqual(
            first.seeded,
            AppValidation.DEFAULT_CHOICES.length,
            "首次启动必须种下默认候选项（DEFAULT_CHOICES），"
                + "否则用户打开应用看到一个空的候选项列表，会以为数据丢了"
        );
        assert.strictEqual(first.state.choices.length, AppValidation.DEFAULT_CHOICES.length, "initialize 的返回里就应该带着种好的候选项");
        assert.deepStrictEqual(
            namesOf(first.state.choices),
            AppValidation.DEFAULT_CHOICES.slice(),
            "种下去的必须是 DEFAULT_CHOICES 本身，而不是别的什么列表"
        );

        const second = await db.initialize();
        assert.strictEqual(
            second.seeded,
            0,
            "第二次 initialize 不能再种一遍：重复种会让候选项翻倍，"
                + "用户会看到两份一模一样的列表"
        );
        assert.strictEqual(
            (await db.getState()).choices.length,
            AppValidation.DEFAULT_CHOICES.length,
            "重复 initialize 之后库里的候选项仍然是默认数量（判据是 metadata.initialized 标记）"
        );
    });

    await test("2. 候选项被全删光之后再 initialize 不会重新种（判据是 initialized 标记）", async () => {
        const { db } = freshDatabase("reseed");
        await db.initialize();
        const state = await db.getState();
        for (const choice of state.choices) {
            await db.deleteChoice(choice.id);
        }
        assert.strictEqual(
            (await db.getState()).choices.length,
            0,
            "候选项应该被删光了，后面的断言才有意义"
        );

        const again = await db.initialize();
        assert.strictEqual(again.seeded, 0, "重新 initialize 不能再种默认值");
        assert.strictEqual(
            (await db.getState()).choices.length,
            0,
            "「候选项全删光」是用户的合法状态：如果 initialize 拿'列表为空'当判据，"
                + "用户删完再刷新页面就会看到默认值又回来了，等于撤销了他的删除"
        );
    });

    await test("3. 候选项/别名/标签/历史的增删改查往返", async () => {
        const { db } = freshDatabase("crud");
        await db.initialize();

        const added = await db.addChoice("Carbonara");
        const choiceId = added.choice.id;
        let state = await db.getState();
        assert.ok(
            namesOf(state.choices).includes("Carbonara"),
            "addChoice 之后 getState 必须能看到它，否则用户加完候选项列表里却没有"
        );

        const alias = await db.addChoiceMeta("aliases", choiceId, "Pasta");
        const tag = await db.addChoiceMeta("tags", choiceId, "西餐");
        state = await db.getState();
        const stored = state.choices.filter((choice) => choice.id === choiceId)[0];
        assert.deepStrictEqual(
            stored.aliases.map((item) => item.alias),
            ["Pasta"],
            "别名必须能往返：搜「Pasta」找不到这道菜，等于别名白加了"
        );
        assert.deepStrictEqual(
            stored.tags.map((item) => item.tag),
            ["西餐"],
            "标签必须能往返：按「西餐」筛不到就等于没打标签"
        );

        // 历史先写一条：后面验证删候选项不会连带删历史。
        const record = (await db.addHistory("Carbonara")).record;
        assert.strictEqual(record.food, "Carbonara");
        assert.strictEqual(record.editable, true, "刚写的历史记录必须是可编辑的");
        assert.strictEqual(record.deletable, true, "刚写的历史记录必须是可删除的");

        // 改历史：食物和时间一起换。
        const newTime = isoAgo(2 * 3600000);
        const updated = await db.updateHistory(record.id, "Pasta", newTime);
        assert.strictEqual(updated.record.food, "Pasta", "updateHistory 要能改食物名");
        assert.strictEqual(updated.record.selectedAt, newTime, "updateHistory 要能改选择时间");
        state = await db.getState();
        assert.strictEqual(
            state.history.filter((item) => item.id === record.id)[0].food,
            "Pasta",
            "改完之后 getState 读到的必须是新值（不是只在返回值里对）"
        );

        // 删别名：标签不能跟着掉。
        await db.deleteChoiceMeta("aliases", choiceId, alias.alias.id);
        state = await db.getState();
        const afterAliasDelete = state.choices.filter((choice) => choice.id === choiceId)[0];
        assert.deepStrictEqual(afterAliasDelete.aliases, [], "deleteChoiceAlias 之后别名必须消失");
        assert.deepStrictEqual(
            afterAliasDelete.tags.map((item) => item.tag),
            ["西餐"],
            "删别名不能顺手把标签也删掉：那不是用户点的那个按钮"
        );
        assert.strictEqual(
            state.choices.filter((choice) => choice.id === choiceId)[0].tags[0].id,
            tag.tag.id,
            "标签的 id 不能在删别名时被重排，否则前端拿旧 id 删标签会删错条目"
        );

        // 删候选项：别名和标签跟着走，历史不动。
        await db.deleteChoice(choiceId);
        state = await db.getState();
        assert.strictEqual(
            state.choices.filter((choice) => choice.id === choiceId).length,
            0,
            "deleteChoice 之后候选项必须消失"
        );
        assert.strictEqual(
            state.history.filter((item) => item.id === record.id).length,
            1,
            "吃过什么是发生过的事：删候选项不该让历史记录一起消失"
        );

        // 删掉的历史才真的消失。
        await db.deleteHistory(record.id);
        assert.strictEqual(
            (await db.getState()).history.length,
            0,
            "deleteHistory 之后那条记录必须消失"
        );
    });

    await test("4. 重复候选项/重复别名被拒绝，且拒绝时不留任何痕迹", async () => {
        const { db } = freshDatabase("conflict");
        await db.initialize();
        const before = await db.getState();
        const snapshotsBefore = (await db.listSnapshots()).length;

        const conflict = await rejects(
            db.addChoice(AppValidation.DEFAULT_CHOICES[0]),
            "重复的候选项必须被拒绝，否则列表里会出现两条一模一样的食物"
        );
        assert.ok(
            conflict instanceof AppStore.ConflictError,
            "要抛 ConflictError（业务拒绝），不能包成 DatabaseError——"
                + "index.js 直接把 message 显示给用户，包一层会变成「数据库操作失败」"
        );

        const after = await db.getState();
        assert.strictEqual(
            after.choices.length,
            before.choices.length,
            "被拒绝的写入不能留下任何痕迹（abort 回滚）：留一条用户没添加过的记录，"
                + "他会以为是自己点错了，再去删一遍"
        );
        assert.deepStrictEqual(
            namesOf(after.choices),
            namesOf(before.choices),
            "候选项的名字顺序也不能变：失败的操作连 position 都不该占用"
        );
        assert.strictEqual(
            (await db.listSnapshots()).length,
            snapshotsBefore,
            "失败的操作不能顺手写快照（快照只在破坏性操作前留）"
        );

        // 别名重复：也要拒绝，并且不能把已有别名顶掉。
        const added = await db.addChoice("Carbonara");
        await db.addChoiceMeta("aliases", added.choice.id, "Pasta");
        const aliasConflict = await rejects(
            db.addChoiceMeta("aliases", added.choice.id, "pasta"),
            "同一个候选项上大小写不同的同名别名必须被拒绝"
        );
        assert.ok(aliasConflict instanceof AppStore.ConflictError, "重复别名要抛 ConflictError");
        const stored = (await db.getState()).choices.filter(
            (choice) => choice.id === added.choice.id
        )[0];
        assert.strictEqual(
            stored.aliases.length,
            1,
            "被拒绝的别名不能落库，也不能把原来那条挤掉，否则用户的别名会越加越乱"
        );
    });

    await test("5. 去重走 casefold：大小写不同、ß/ss 都算重复", async () => {
        const { db } = freshDatabase("casefold");
        await db.initialize();
        await db.addChoice("Yam and egg");
        const baseline = (await db.getState()).choices.length;

        const upper = await rejects(
            db.addChoice("YAM AND EGG"),
            "纯大小写不同的名字必须算重复"
        );
        assert.ok(upper instanceof AppStore.ConflictError, "大小写重复要抛 ConflictError");

        // casefold 和 toLowerCase 的差别：ß 折叠成 ss。这条断言是在说明
        // 「为什么不能图省事用 toLowerCase」。
        assert.notStrictEqual(
            "Straße".toLowerCase(),
            "STRASSE".toLowerCase(),
            "toLowerCase 认为这两个是不同的字符串（ß 不会变成 ss），"
                + "所以只用 toLowerCase 去重会让同一个候选项存成两条"
        );
        await db.addChoice("Straße");
        const sharp = await rejects(
            db.addChoice("STRASSE"),
            "casefold 之后「Straße」和「STRASSE」是同一个键，必须算重复"
        );
        assert.ok(sharp instanceof AppStore.ConflictError, "ß/ss 重复要抛 ConflictError");

        assert.strictEqual(
            (await db.getState()).choices.length,
            baseline + 1,
            "只有真正新增的那一条（Straße）应该落库"
        );

        /*
         * 全角。规格里写「"Ｙam and egg" 也算重复」，但本仓库（以及 Python 侧的
         * normalize_food + str.casefold）并不是这样：normalizeFood 只做 NFC，
         * 而 U+FF39 全角Ｙ不在 casefold 差异表里（Python 的 casefold 也只把它
         * 折成小写全角ｙ）。所以全角写法是**另一个候选项**。
         * 这条断言钉住的是"别为了让它通过偷偷加 NFKC"：PWA 和 SQLite 两端必须
         * 用同一套去重键，否则同一份数据在两边会变成不同的条数。
         */
        assert.notStrictEqual(
            AppValidation.foldedKey("Ｙam and egg"),
            AppValidation.foldedKey("Yam and egg"),
            "全角Ｙ在 casefold 之后仍然是小写全角ｙ，和半角 y 不是同一个键"
        );
        const fullwidth = await db.addChoice("Ｙam and egg");
        assert.strictEqual(
            fullwidth.choice.name,
            "Ｙam and egg",
            "全角写法按现有规则是一个新的候选项（和 database.py 的行为一致）"
        );
        assert.strictEqual(
            (await db.getState()).choices.length,
            baseline + 2,
            "全角落库之后总数应该 +2（Straße 与 Ｙam and egg）"
        );
    });

    await test("6. 历史的编辑窗口、删除窗口与未来时间", async () => {
        const { db } = freshDatabase("history-window");
        await db.initialize();

        // 窗口外（10 天前）：不能编辑。删除也不行——和 database.py 的
        // is_deletable_timestamp 一致，"可删"的只有时间戳损坏和落在未来这两类
        // 垃圾数据，窗口外的老记录同样删不掉（否则历史可以被逐条抹掉）。
        const oldTime = isoAgo(10 * DAY);
        await db.applyImport(backupOf([], [historyEntry("old-1", "十天前吃的", oldTime)]), "merge");
        let state = await db.getState();
        const oldRecord = state.history[0];
        assert.strictEqual(
            oldRecord.editable,
            false,
            "10 天前的记录必须标记为不可编辑，前端才会藏起「编辑」按钮"
        );
        const oldEdit = await rejects(
            db.updateHistory("old-1", "改名", isoAgo(3600000)),
            "编辑窗口外的记录必须拒绝编辑"
        );
        assert.ok(
            oldEdit instanceof AppValidation.ValidationError,
            "窗口外编辑要抛 ValidationError（「只能编辑最近 5 天」），"
                + "不能是数据库错误——用户看到的应该是业务规则，不是「数据库出错」"
        );
        assert.ok(
            oldEdit.message.includes("只能编辑最近"),
            "错误消息要说清楚为什么不能改，实际：" + oldEdit.message
        );
        await rejects(
            db.deleteHistory("old-1"),
            "窗口外的老记录不可删除（可删的只有时间戳损坏/落在未来这两类垃圾数据）"
        );
        assert.strictEqual(
            (await db.getState()).history.length,
            1,
            "被拒绝的删除不能真的把记录删掉"
        );

        // 落在未来的记录：不可编辑，但必须可删除，否则用户只能清空全部历史。
        // 时间必须落到**明天**：编辑窗口按本机日历日算，晚上 23:00 加一小时仍是
        // 今天、仍然可编辑，用"几小时后"造数据会让这条断言在夜里恒真。
        const tomorrow = new Date(Date.now() + DAY);
        tomorrow.setHours(12, 0, 0, 0);
        await db.applyImport(
            backupOf([], [historyEntry("future-1", "还没吃", tomorrow.toISOString())]),
            "merge"
        );
        state = await db.getState();
        const futureRecord = state.history.filter((item) => item.id === "future-1")[0];
        assert.strictEqual(futureRecord.editable, false, "未来时间的记录不可编辑");
        assert.strictEqual(
            futureRecord.deletable,
            true,
            "未来时间的记录必须可删除：否则它永远卡在列表最上面，用户只能清空全部历史"
        );
        await db.deleteHistory("future-1");
        assert.strictEqual(
            (await db.getState()).history.filter((item) => item.id === "future-1").length,
            0,
            "可删除的记录必须真的删得掉"
        );

        // 未来时间：即使在窗口内，新时间也不能晚于现在。
        const record = (await db.addHistory("Carbonara")).record;
        const futureTime = await rejects(
            db.updateHistory(record.id, "Carbonara", tomorrow.toISOString()),
            "把选择时间改到未来（明天中午）必须被拒绝"
        );
        assert.strictEqual(
            futureTime.message,
            "选择时间不能晚于现在",
            "这条要和前端「不能是未来」的说法一致，消息必须原样透出，实际："
                + futureTime.message
        );
        const unchanged = (await db.getState()).history.filter((item) => item.id === record.id)[0];
        assert.strictEqual(
            unchanged.selectedAt,
            record.selectedAt,
            "被拒绝的编辑不能把时间改掉一半"
        );
    });

    await test("7. 历史按 selectedAt 倒序；同一时间的按插入顺序倒序（seq）", async () => {
        const { fake, db } = freshDatabase("history-order");
        await db.initialize();

        const sameTime = isoAgo(3600000);
        // 同一时间戳的两条：id 故意让主键顺序和插入顺序相反（"aaa" 先插入、
        // "zzz" 后插入），这样"只按主键顺序读回来"和"按 seq 倒序"的结果不同，
        // 才能真正测出 seq 有没有起作用。
        await db.applyImport(backupOf([], [
            historyEntry("aaa", "先记的", sameTime),
            historyEntry("zzz", "后记的", sameTime),
            historyEntry("m-1", "两小时前", isoAgo(2 * 3600000)),
            historyEntry("m-2", "三小时前", isoAgo(3 * 3600000))
        ]), "merge");

        const expected = ["后记的", "先记的", "两小时前", "三小时前"];
        let state = await db.getState();
        assert.deepStrictEqual(
            state.history.map((item) => item.food),
            expected,
            "历史必须按 selectedAt 倒序；同一时间戳的按 seq 倒序（对应 SQLite 的 "
                + "rowid DESC）。顺序错了用户会觉得「刚吃的排到了下面」"
        );
        for (let index = 1; index < state.history.length; index += 1) {
            assert.ok(
                state.history[index - 1].selectedAt >= state.history[index].selectedAt,
                "第 " + index + " 条的 selectedAt 比前一条新，倒序排错了"
            );
        }

        // 关掉再打开：读回来的是主键顺序，排序必须靠 seq 重新排对。
        db.close();
        const reopened = AppDatabase.create({ indexedDB: fake, name: "history-order" });
        assert.deepStrictEqual(
            (await reopened.getState()).history.map((item) => item.food),
            expected,
            "重新打开页面之后顺序必须一样：seq 是持久化的，不能只在内存里对"
        );
        reopened.close();
    });

    await test("8. 清空历史留快照，且快照里真的有清空前的数据", async () => {
        const { fake, db } = freshDatabase("snapshot");
        await db.initialize();
        const choices = (await db.getState()).choices.length;
        await db.addHistory("Carbonara");
        await db.addHistory("Indomie");
        await db.addHistory("Cereal");

        const outcome = await db.clearHistory();
        assert.strictEqual(outcome.cleared, true, "clearHistory 要报告清空成功");
        assert.strictEqual(
            typeof outcome.snapshotAt,
            "string",
            "snapshotAt 是机器读的时间戳字符串（用来核对留了副本）"
        );

        assert.strictEqual(
            (await db.getState()).history.length,
            0,
            "clearHistory 之后历史必须为空"
        );

        const snapshots = await db.listSnapshots();
        assert.strictEqual(
            snapshots.length,
            1,
            "清空是破坏性操作，必须先留一份快照，否则用户点错了就再也找不回来"
        );
        assert.strictEqual(
            snapshots[0].historyCount,
            3,
            "快照里的 historyCount 应该是清空前的条数（3），否则这份备份是空的"
        );
        assert.strictEqual(
            snapshots[0].choiceCount,
            choices,
            "快照要连候选项一起留（恢复时是一整份状态，不是只有历史）"
        );
        assert.strictEqual(
            snapshots[0].createdAt,
            outcome.snapshotAt,
            "返回的 snapshotAt 要和真正落库的那份快照对得上"
        );

        // 光有计数不够：直接读快照仓库，确认里面真的存着清空前的记录。
        const raw = await readRawStore(fake, "snapshot", "snapshots");
        assert.strictEqual(
            (raw[0].history || []).map((item) => item.food).sort().join(","),
            "Carbonara,Cereal,Indomie",
            "快照里必须真的有那三条历史（不是只记了个数字）："
                + "恢复的时候要拿它把数据写回去"
        );
        assert.strictEqual(
            (raw[0].choices || []).length,
            choices,
            "快照里的候选项也必须是完整的一份"
        );
    });

    await test("9. 快照上限 10 份，超出后保留最近的那几份", async () => {
        const { db } = freshDatabase("snapshot-limit");
        await db.initialize();
        assert.strictEqual(AppStore.SNAPSHOT_LIMIT, 10, "这条用例是照着 SNAPSHOT_LIMIT=10 写的");

        // 连续 13 次破坏性操作：清空和覆盖导入交替，两种路径都要走一遍裁剪。
        // 其中几次之间停一下，让 createdAt 拉开；同一毫秒的那几次靠自增 id 兜底。
        for (let round = 1; round <= 13; round += 1) {
            if (round % 2 === 1) {
                await db.clearHistory();
            } else {
                await db.applyImport(
                    backupOf([{ name: "Round " + round, aliases: [], tags: [] }],
                        [historyEntry("h-" + round, "Round " + round, isoAgo(round * 60000))]),
                    "replace"
                );
            }
            if (round % 3 === 0) {
                await tick();
            }
        }

        const snapshots = await db.listSnapshots();
        assert.strictEqual(
            snapshots.length,
            10,
            "快照数量必须被裁到 SNAPSHOT_LIMIT（10）：无限留着会把手机存储撑爆"
        );
        const ids = snapshots.map((item) => item.id).sort((left, right) => left - right);
        assert.deepStrictEqual(
            ids,
            [4, 5, 6, 7, 8, 9, 10, 11, 12, 13],
            "保留的必须是最近的 10 份（自增 id 4~13），"
                + "把最新的裁掉等于用户刚清空完就发现没有副本可恢复"
        );
        for (let index = 1; index < snapshots.length; index += 1) {
            const newer = snapshots[index - 1];
            const older = snapshots[index];
            assert.ok(
                newer.createdAt > older.createdAt
                    || (newer.createdAt === older.createdAt && newer.id > older.id),
                "listSnapshots 要按 createdAt 倒序、同毫秒用 id 兜底排"
            );
        }
    });

    await test("10. 导入：merge 不覆盖，replace 留快照，坏备份被拒", async () => {
        const { db } = freshDatabase("import");
        await db.initialize();

        // ---- merge：已有的历史不能被覆盖，id 冲突要计入 skippedConflictCount ----
        const existing = (await db.addHistory("Carbonara")).record;
        const mergePayload = backupOf(
            [{ name: "Yam and egg", aliases: ["Yam"], tags: ["早餐"] }],
            [
                historyEntry(existing.id, "冒充的内容", existing.selectedAt),
                historyEntry("new-1", "Imported dish", isoAgo(2 * 3600000))
            ]
        );
        const mergeOutcome = await db.applyImport(mergePayload, "merge");
        assert.strictEqual(
            mergeOutcome.summary.skippedConflictCount,
            1,
            "id 冲突的那条必须计入 skippedConflictCount，前端才能告诉用户"
                + "「有 1 条因为 ID 冲突被跳过」"
        );
        let state = await db.getState();
        const kept = state.history.filter((item) => item.id === existing.id)[0];
        assert.strictEqual(
            kept.food,
            "Carbonara",
            "合并导入不能覆盖已有记录：覆盖等于用户没点过「替换」却丢了数据"
        );
        assert.strictEqual(
            state.history.length,
            2,
            "合并导入应该只补进那条不冲突的历史（1 条旧的 + 1 条新的）"
        );
        assert.ok(
            namesOf(state.choices).includes("Yam and egg"),
            "合并导入要能把新候选项加进来"
        );
        assert.strictEqual(
            mergeOutcome.summary.snapshot,
            undefined,
            "合并导入不动现有数据，不需要留快照"
        );

        // ---- replace：整体替换，并留下一份快照 ----
        const beforeReplace = await db.getState();
        const replaceOutcome = await db.applyImport(
            backupOf([{ name: "Only dish", aliases: [], tags: [] }],
                [historyEntry("r-1", "Only dish", isoAgo(3600000))]),
            "replace"
        );
        assert.strictEqual(
            typeof replaceOutcome.summary.snapshot,
            "string",
            "summary.snapshot 必须是字符串：index.js 直接把它拼进提示语"
                + "（「覆盖前的数据已备份到 " + replaceOutcome.summary.snapshot
                + "」），给个对象会渲染成 [object Object]"
        );
        state = await db.getState();
        assert.deepStrictEqual(
            namesOf(state.choices),
            ["Only dish"],
            "覆盖导入要把候选项整体换成备份里的那一份"
        );
        assert.strictEqual(state.history.length, 1, "覆盖导入要把历史整体换成备份里的那一份");
        const snapshots = await db.listSnapshots();
        assert.strictEqual(
            snapshots.length,
            1,
            "覆盖导入前必须留快照，这是用户唯一的后悔药"
        );
        assert.strictEqual(
            snapshots[0].historyCount,
            beforeReplace.history.length,
            "快照记的必须是替换**之前**的条数，替换之后再拍就拍到新数据了"
        );

        // ---- 坏备份：三条都要拒绝，而且拒绝之后数据不能变 ----
        const snapshotBefore = await db.getState();
        const empty = await rejects(
            db.applyImport(backupOf([], []), "replace"),
            "空备份必须被拒绝"
        );
        assert.strictEqual(
            empty.message,
            "备份中没有数据，已阻止覆盖导入",
            "空备份不该能清库：选错文件（比如刚导出的空备份）一下就全没了，"
                + "实际：" + empty.message
        );
        const v1 = await rejects(
            db.applyImport({ app: APP_ID, schemaVersion: 1, choices: [], history: [] }, "replace"),
            "v1 备份必须被明确拒绝，不能猜着导入"
        );
        assert.ok(
            v1.message.includes("不支持的备份版本"),
            "v1 备份要提示版本不支持，实际：" + v1.message
        );
        const foreign = await rejects(
            db.applyImport({ app: "some-other-app", schemaVersion: SCHEMA_VERSION, choices: [], history: [] }, "replace"),
            "不是本应用的备份必须被拒绝"
        );
        assert.strictEqual(
            foreign.message,
            "不是本应用的备份文件",
            "别人家的 JSON 被导进来会把数据搅乱，消息要直说文件不对，实际：" + foreign.message
        );

        const snapshotAfter = await db.getState();
        assert.deepStrictEqual(
            namesOf(snapshotAfter.choices),
            namesOf(snapshotBefore.choices),
            "被拒绝的导入不能留下半份数据"
        );
        assert.strictEqual(
            (await db.listSnapshots()).length,
            1,
            "被拒绝的覆盖导入不能顺手多留一份快照"
        );
    });

    await test("11. 同一份备份合并两次是幂等的（候选项和别名都不翻倍）", async () => {
        const { db } = freshDatabase("idempotent");
        await db.initialize();
        const payload = backupOf(
            [{ name: "Carbonara", aliases: ["Pasta", "Spaghetti"], tags: ["西餐"] }],
            [historyEntry("h-1", "Carbonara", isoAgo(3 * 3600000))]
        );

        const first = await db.applyImport(payload, "merge");
        assert.strictEqual(first.summary.insertedChoiceCount, 1, "第一次合并应该插入 1 个候选项");
        assert.strictEqual(first.summary.insertedAliasCount, 2, "第一次合并应该插入 2 个别名");
        const afterFirst = await db.getState();

        const second = await db.applyImport(payload, "merge");
        const afterSecond = await db.getState();
        assert.strictEqual(
            second.summary.insertedChoiceCount,
            0,
            "第二次合并不该新增候选项：重复导入同一份备份会让列表越长越乱"
        );
        assert.strictEqual(
            afterSecond.choices.length,
            afterFirst.choices.length,
            "合并两次之后候选项总数不能变（幂等）"
        );
        const carbonara = afterSecond.choices.filter((choice) => choice.name === "Carbonara");
        assert.strictEqual(
            carbonara.length,
            1,
            "同一个名字只能有一个候选项：出现两条同名记录，用户搜出来会一脸问号"
        );
        assert.deepStrictEqual(
            carbonara[0].aliases.map((item) => item.alias).sort(),
            ["Pasta", "Spaghetti"],
            "别名不能翻倍（第二次导入应该复用已有候选项，而不是挂到新 id 上）"
        );
        assert.strictEqual(
            afterSecond.history.length,
            1,
            "同一条历史（id 相同、内容相同）重复导入属于幂等重放，不该报警也不该重复"
        );
        assert.strictEqual(
            second.summary.skippedConflictCount,
            1,
            "database.py 的 apply_import 对**每一个** id 冲突都计数（内容相同也算）："
                + "第二次合并时那条历史确实被跳过了，数字要如实反映"
        );

        // 幂等重放不会被报警的那条规则在**预览**路径上：同 id 且内容相同
        // 不算冲突，用户就不会看到"有 1 条冲突"这种吓人的提示。
        const idempotentPreview = await db.previewImport(payload);
        assert.strictEqual(
            idempotentPreview.summary.historyIdConflictCount,
            0,
            "id 相同、内容也相同的重复导入属于幂等重放，预览里不能报成冲突，"
                + "否则用户每次重新导入同一份备份都会以为出了问题"
        );
        const conflictingPreview = await db.previewImport(backupOf([], [
            historyEntry("h-1", "被改过的内容", isoAgo(3 * 3600000))
        ]));
        assert.strictEqual(
            conflictingPreview.summary.historyIdConflictCount,
            1,
            "同一个 id 换成不同内容才该报冲突"
        );
    });

    await test("12. buildExport 只导出该有的字段，且能原样再导入", async () => {
        const { db } = freshDatabase("export");
        await db.initialize();
        const choice = (await db.addChoice("Carbonara")).choice;
        await db.addChoiceMeta("aliases", choice.id, "Pasta");
        await db.addChoiceMeta("tags", choice.id, "西餐");
        await db.addHistory("Carbonara");

        const exported = await db.buildExport();
        assert.deepStrictEqual(
            Object.keys(exported).sort(),
            ["app", "choices", "exportedAt", "history", "schemaVersion"],
            "导出载荷的顶层字段就是这五个，多写少写都会让别的客户端认不出来"
        );
        assert.strictEqual(exported.app, APP_ID, "app 必须是本应用的标识，导入时靠它认文件");
        assert.strictEqual(
            exported.schemaVersion,
            SCHEMA_VERSION,
            "schemaVersion 必须是 2（和 database.py 的 SCHEMA_VERSION 对齐）"
        );
        assert.strictEqual(typeof exported.exportedAt, "string", "exportedAt 是时间戳字符串");

        const exportedChoice = exported.choices.filter((item) => item.name === "Carbonara")[0];
        assert.deepStrictEqual(
            Object.keys(exportedChoice).sort(),
            ["aliases", "name", "tags"],
            "候选项只导出 name/aliases/tags：多余字段会让备份越滚越大"
        );
        assert.deepStrictEqual(
            exportedChoice.aliases,
            ["Pasta"],
            "别名要导出成纯字符串数组"
        );
        assert.deepStrictEqual(exportedChoice.tags, ["西餐"], "标签要导出成纯字符串数组");

        assert.deepStrictEqual(
            Object.keys(exported.history[0]).sort(),
            ["food", "id", "selectedAt"],
            "历史只导出 id/food/selectedAt"
        );
        assert.strictEqual(
            Object.prototype.hasOwnProperty.call(exported.history[0], "editable"),
            false,
            "editable/deletable 是后端（或 store.js）算出来的展示字段，"
                + "写进备份会被下一次导入当成陈旧数据读回来"
        );
        assert.strictEqual(
            Object.prototype.hasOwnProperty.call(exported.history[0], "deletable"),
            false,
            "deletable 同理，不该出现在备份里"
        );
        assert.strictEqual(
            Object.prototype.hasOwnProperty.call(exportedChoice, "id"),
            false,
            "候选项 id 不进备份（导入时按名字合并），导出它反而会让人以为 id 会被保留"
        );

        // 自己导出的东西自己必须能导入。
        const roundTrip = await db.applyImport(exported, "merge");
        assert.strictEqual(
            roundTrip.summary.choiceCount,
            exported.choices.length,
            "自己导出的备份必须能被自己完整读回来"
        );
    });

    await test("13. close() 之后数据还在（模拟关掉页面再打开）", async () => {
        const { fake, db } = freshDatabase("persist");
        await db.initialize();
        const choice = (await db.addChoice("Carbonara")).choice;
        await db.addChoiceMeta("aliases", choice.id, "Pasta");
        await db.addChoiceMeta("tags", choice.id, "西餐");
        await db.addHistory("Carbonara");
        const before = await db.getState();

        db.close();
        assert.strictEqual(
            fake.inspect("persist").version,
            1,
            "关掉页面不该改库的版本"
        );

        // 同一个 fake 上新建一个 AppDatabase：这就是"关掉页面再打开"。
        const reopened = AppDatabase.create({ indexedDB: fake, name: "persist" });
        const after = await reopened.getState();
        assert.deepStrictEqual(
            after.choices.map((item) => item.name),
            before.choices.map((item) => item.name),
            "关掉页面再打开，候选项必须原样还在，否则这个应用根本不能用"
        );
        const carbonara = after.choices.filter((item) => item.name === "Carbonara")[0];
        assert.deepStrictEqual(
            carbonara.aliases.map((item) => item.alias),
            ["Pasta"],
            "别名也要活过重启"
        );
        assert.deepStrictEqual(
            carbonara.tags.map((item) => item.tag),
            ["西餐"],
            "标签也要活过重启"
        );
        assert.strictEqual(after.history.length, 1, "历史也要活过重启");
        assert.strictEqual(after.history[0].food, "Carbonara", "历史内容不能变");
        assert.strictEqual(
            after.choices.filter((item) => item.name === "Carbonara").length,
            1,
            "重启之后不能出现第二条 Carbonara（唯一索引 nameKey 在写入时就算好了）"
        );
        reopened.close();
    });

    await test("14. 库的版本比代码高：拒绝读写，并且绝不删库重建", async () => {
        const fake = createFakeIndexedDB();
        const held = await openRaw(fake, "future-db", 5);
        assert.strictEqual(held.version, 5, "先造一个版本 5 的库（比代码支持的 1 高）");

        const db = AppDatabase.create({ indexedDB: fake, name: "future-db" });
        const failure = await rejects(
            db.getState(),
            "库比代码新时必须拒绝读写：按旧结构写进去只会静默损坏数据"
        );
        assert.strictEqual(
            failure.name,
            "VersionError",
            "要抛 VersionError（而不是 DatabaseError），提示语里要引导用户刷新页面，"
                + "实际：" + failure.name
        );
        assert.ok(
            failure.message.includes("更新版本"),
            "消息要让用户知道是页面旧了、刷新就好，实际：" + failure.message
        );

        const inspected = fake.inspect("future-db");
        assert.strictEqual(inspected.exists, true, "绝不能靠删库来「修复」：那是把用户的数据丢掉");
        assert.strictEqual(inspected.version, 5, "库的版本必须原封不动还是 5");
        assert.strictEqual(
            inspected.openConnectionCount,
            1,
            "拒写的那一次不能顺手把别的标签页的连接关掉"
        );

        // 用更高的版本再 open 一次：oldVersion 是 5，说明库没被重建过。
        held.close();
        let observedOldVersion = null;
        const bumped = await openRaw(fake, "future-db", 6, (event) => {
            observedOldVersion = event.oldVersion;
        });
        assert.strictEqual(
            observedOldVersion,
            5,
            "再升级时 oldVersion 必须还是 5：如果拒写时删过库，这里会看到 0，"
                + "那意味着用户数据已经没了"
        );
        assert.strictEqual(bumped.version, 6, "升级到 6 之后连接版本应该是 6");
        bumped.close();
    });

    await test("15. blocked：别的标签页握着旧连接时给出明确的提示", async () => {
        const fake = createFakeIndexedDB();

        // 造一个版本 1 的库并握着一个连接不放（模拟没关掉的旧标签页）。
        const held = await openRaw(fake, "two-tabs", 1, (event) => {
            const connection = event.target.result;
            connection.createObjectStore("choices", { keyPath: "id" });
        });

        // database.js 自己永远按 STORAGE_SCHEMA_VERSION 打开，所以在当前代码下
        // 走不到 blocked（版本没变过，不需要升级）。这里把 open 的版本抬高 1，
        // 模拟"页面要求的结构版本比另一个标签页握着的更高"——这正是 blocked
        // 分支存在的原因，也是将来 STORAGE_SCHEMA_VERSION +1 时会真实发生的场景。
        const blockedFactory = {
            open: (name, version) => fake.open(name, version + 1)
        };
        const db = AppDatabase.create({ indexedDB: blockedFactory, name: "two-tabs" });
        const failure = await rejects(
            db.connect(),
            "有旧连接挡着时 open 必须失败，而不是无限等下去（用户会看到页面一直转圈）"
        );
        assert.strictEqual(
            failure.message,
            "另一个标签页正在使用旧版本的数据，请关闭其它标签页后重试。",
            "这条提示要原样给到用户：他得知道去关别的标签页才能继续，实际：" + failure.message
        );

        // 旧连接让路之后，那个被判定为 abandoned 的请求会照常成功；
        // database.js 要把它悄悄关掉，而不是留下一个没人用的连接。
        held.close();
        await tick();
        await tick();
        assert.strictEqual(
            fake.inspect("two-tabs").version,
            2,
            "让路之后升级应该能完成"
        );
        assert.strictEqual(
            fake.inspect("two-tabs").openConnectionCount,
            0,
            "报过 blocked 之后才成功的连接没人用，必须自己关掉，"
                + "否则它会一直挡着下一个要升级的标签页"
        );

        // 反过来：database.js 自己的连接收到 versionchange 要主动关门，
        // 让别的标签页升得上去（不关的话对方永远 blocked）。
        const fake2 = createFakeIndexedDB();
        const app = AppDatabase.create({ indexedDB: fake2, name: "handoff" });
        await app.initialize();
        assert.strictEqual(fake2.inspect("handoff").openConnectionCount, 1, "应用自己拿着一个连接");
        const upgraded = await openRaw(fake2, "handoff", 2);
        assert.strictEqual(
            upgraded.version,
            2,
            "另一个标签页要升级时，本页的连接必须自己关掉（versionchange 处理），"
                + "否则对方会一直卡在 blocked"
        );
        assert.strictEqual(
            fake2.inspect("handoff").openConnectionCount,
            1,
            "关掉旧连接之后只剩新升级的那个连接"
        );
        upgraded.close();
    });

    await test("16. 配额不足：提示存储空间不足，且这次写入整体回滚", async () => {
        const { fake, db } = freshDatabase("quota");
        await db.initialize();
        const before = await db.getState();
        await db.addHistory("Carbonara");
        const historyBefore = (await db.getState()).history.length;

        const quotaError = typeof DOMException === "function"
            ? new DOMException("quota exceeded", "QuotaExceededError")
            : Object.assign(new Error("quota exceeded"), { name: "QuotaExceededError" });
        // 延后 2 个写请求才失败：database.js 的写入顺序是 clear/clear 之后才开始
        // put，这时候事务里已经改了不少东西——正好验证"要么整体成功、要么整体不动"。
        fake.failNextPut(quotaError, 2);

        const failure = await rejects(
            db.addChoice("Carbonara 二号"),
            "写不进去时必须报错，不能假装保存成功：用户以为存上了、实际没有，"
                + "下次打开发现数据没了会更懵"
        );
        assert.ok(
            failure.message.includes("存储空间不足"),
            "配额不足要给出可操作的建议（先导出备份再清理浏览器数据），实际：" + failure.message
        );
        assert.strictEqual(
            failure.name,
            "DatabaseError",
            "这是存储故障不是业务拒绝，要归一到 DatabaseError"
        );

        const after = await db.getState();
        assert.deepStrictEqual(
            namesOf(after.choices),
            namesOf(before.choices),
            "失败的写入必须整体回滚：这时候事务已经 clear 过整张表了，"
                + "不回滚的话用户会丢掉全部候选项"
        );
        assert.strictEqual(
            after.history.length,
            historyBefore,
            "历史也不能被这次失败带走"
        );
        assert.strictEqual(
            (await db.listSnapshots()).length,
            0,
            "失败的操作不该留下半份快照"
        );

        // toPublicError 认的是 error.name，不是构造函数：普通 Error 改个 name
        // 也要走同一条分支（跨浏览器/跨环境的错误对象来源不一样）。
        fake.failNextPut(Object.assign(new Error("full"), { name: "QuotaExceededError" }), 1);
        const again = await rejects(db.addChoice("再来一次"), "第二次配额失败同样要报错");
        assert.ok(
            again.message.includes("存储空间不足"),
            "只要 name 是 QuotaExceededError 就要走配额分支，实际：" + again.message
        );
        assert.deepStrictEqual(
            namesOf((await db.getState()).choices),
            namesOf(before.choices),
            "第二次失败之后候选项同样不能变"
        );
    });

    await test("17. indexedDB 不可用：supported=false，connect() 明确拒绝", async () => {
        const unsupported = AppDatabase.create({ indexedDB: null });
        assert.strictEqual(
            unsupported.supported,
            false,
            "无痕模式/禁用存储时要明确报告 supported=false，"
                + "页面才能提示「这个浏览器存不了数据」而不是停在空白状态"
        );
        const failure = await rejects(
            unsupported.connect(),
            "connect() 必须拒绝，不能返回一个用不了的连接"
        );
        assert.ok(
            failure.message.includes("IndexedDB"),
            "消息要点名 IndexedDB，用户/支持人员才知道该查什么，实际：" + failure.message
        );
        assert.strictEqual(
            typeof unsupported.close,
            "function",
            "不支持存储时 close() 也必须存在（index.js 在页面卸载时会统一调）"
        );
        unsupported.close();
    });

    /* -------------------------------------------------------------- */

    console.log("");
    if (failures.length === 0) {
        console.log("ok   - 持久化层测试全部通过（" + passed + " 项）");
    } else {
        console.error("FAIL - " + failures.length + " 项未通过：");
        failures.forEach((item) => {
            console.error("       - " + item.title);
        });
        process.exitCode = 1;
    }
}

main().catch((error) => {
    console.error("FAIL - 测试脚本自身出错：" + (error && error.stack ? error.stack : error));
    process.exitCode = 1;
});
