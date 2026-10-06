"use strict";

/*
 * 内存版 IndexedDB 桩：给 tests/test_database.js 用。
 *
 * 环境里没有浏览器自动化工具，也没有 npm 可以装 fake-indexeddb，所以持久化层
 * （pwa/database.js）是唯一只能靠人工点页面验证的一层——而它恰好管着"数据会
 * 不会丢"。这个文件实现 IDBFactory 里 database.js 真正用到的那部分，让
 * `AppDatabase.create({ indexedDB: createFakeIndexedDB(), name })` 在 node 里
 * 能真跑一遍。
 *
 * 三条关键语义（写错了测试就变成恒真，等于没测）：
 *
 * 1. 所有回调都异步派发（queueMicrotask）。不能同步派发：database.js 的只读
 *    路径是「先把三个 get 全发出去，再一起 await」，同步派发会让请求的
 *    onsuccess 在 database.js 还来不及挂上回调时就跑掉（promise 永远不 settle），
 *    也测不出"事务中途回到事件循环就会提前提交"这件事。
 *
 * 2. 写入先累积在事务的 pendingWrites 里，事务 commit 时才合并进真实存储。
 *    没用「开始时拷一份、abort 时还原」，是因为累积式顺带保证了「事务内的读取
 *    只看得到事务前的状态」：先拷快照的写法会让同一事务里 put 完再 get 读到刚
 *    写的值，真实 IndexedDB 不是这样，那种 bug 会被桩放过去。abort 时直接丢掉
 *    pendingWrites，就是回滚。
 *
 * 3. unique 索引在排队写入时就检查，冲突让请求 onerror（ConstraintError）、
 *    再让整个事务 onabort。数据库自己拦不住同名候选项的话，用户会看到两条一模
 *    一样的记录——而"页面先查一遍再写"在多标签页并发下本来就拦不住。
 *
 * 自动提交的近似：真实 IndexedDB 在微任务队列抽干后提交，这里放宽成"没有排队
 * 请求后再过一个宏任务"。差别只在 database.js 于读和写之间 `await` 一个纯
 * Promise 时（真实实现会提交、这里不会）；await 定时器、文件读取这类真正会回到
 * 事件循环的等待照样会被抓出来（事务变 inactive，写入抛 TransactionInactiveError）。
 *
 * 不实现（database.js 没用到，写了也没人测）：游标与范围查询、deleteDatabase、
 * 事务的 durability/autoCommit 选项、多版本连续升级的完整语义（升级里改已存在
 * 仓库的索引不会回滚）。
 */

/*
 * 结构化克隆。桩把记录交给调用方（database.js 读出来后 map 成 state），拿到的
 * 必须是副本：真实 IndexedDB 存读都走结构化克隆，共享引用会让"测试里改了返回
 * 值，库里的数据跟着变"这种浏览器里不会发生的事被当成通过。
 */
function clone(value) {
    if (value === undefined) {
        return undefined;
    }
    return JSON.parse(JSON.stringify(value));
}

function makeError(name, message) {
    if (typeof DOMException === "function") {
        return new DOMException(message, name);
    }
    var error = new Error(message);
    error.name = name;
    return error;
}

/*
 * 键路径 -> 键。单字段路径（"id"）取标量，数组路径（["selectedAt", "seq"]，
 * history 的 order 索引就是它）取数组。键只用于排序和唯一性判断，不参与范围
 * 查询，所以直接按值比较、用 JSON 序列化当 Map 的键就够。
 */
function keyOf(record, keyPath) {
    if (Array.isArray(keyPath)) {
        return keyPath.map(function(part) {
            return record ? record[part] : undefined;
        });
    }
    return record ? record[keyPath] : undefined;
}

function token(key) {
    return JSON.stringify(key === undefined ? null : key);
}

// 键序：索引与 getAll 只需要一个稳定顺序，不提供范围查询。
function compareTokens(left, right) {
    return left < right ? -1 : (left > right ? 1 : 0);
}

function createRequest() {
    return { onsuccess: null, onerror: null, result: undefined, error: null };
}

function dispatch(handler, event) {
    if (typeof handler === "function") {
        handler(event);
    }
}

/* ------------------------------------------------------------------ *
 * 事务
 * ------------------------------------------------------------------ */

function FakeTransaction(connection, storeNames, mode) {
    this.connection = connection;
    this.mode = mode;
    this.error = null;
    this.oncomplete = null;
    this.onabort = null;
    this.onerror = null;
    // finished: complete 或 abort 已经决定；failing: 有请求失败、正在走 abort。
    this.finished = false;
    this.aborted = false;
    this.failing = false;
    this.pending = 0;
    this.idleTimerArmed = false;
    this.objectStoreNames = storeNames.slice();
    // 每个事务各持一份视图：记录直接读已提交的存储，写入放 pendingWrites。
    this.views = new Map();
    var self = this;
    storeNames.forEach(function(name) {
        var definition = connection.record.stores.get(name);
        if (!definition) {
            throw makeError("NotFoundError", "对象仓库不存在：" + name);
        }
        self.views.set(name, {
            definition: definition,
            pendingWrites: new Map(),
            clearPending: false,
            stagedAutoKey: 0
        });
    });
}

FakeTransaction.prototype.isVersionChange = function() {
    return this.mode === "versionchange";
};

// 事务结束（complete 或 abort）之后排请求必须报 TransactionInactiveError：
// database.js 专门写了这个分支（"事务里夹了异步等待"），桩不报就测不出来。
FakeTransaction.prototype.assertActive = function() {
    if (this.finished || this.aborted || this.failing) {
        throw makeError(
            "TransactionInactiveError",
            "事务已经结束或正在中止，不能再排请求"
        );
    }
};

FakeTransaction.prototype.objectStore = function(name) {
    var view = this.views.get(name);
    if (!view) {
        throw makeError("NotFoundError", "事务没有覆盖对象仓库：" + name);
    }
    return new FakeObjectStore(this, view);
};

/*
 * 排一个请求。任务本身在微任务里跑，所以 database.js 在返回后才有机会挂
 * onsuccess/onerror——真实实现就是这样，这也是桩必须异步派发的原因之一。
 */
FakeTransaction.prototype.enqueue = function(task) {
    this.assertActive();
    var self = this;
    this.pending += 1;
    queueMicrotask(function() {
        if (self.finished || self.failing) {
            // 事务已经中止：排在后面的请求不会再执行（真实实现同理）。
            self.pending -= 1;
            return;
        }
        try {
            task();
        } finally {
            self.pending -= 1;
            self.checkIdle();
        }
    });
};

FakeTransaction.prototype.read = function(view, compute) {
    var self = this;
    var request = createRequest();
    this.enqueue(function() {
        var value;
        try {
            value = compute();
        } catch (error) {
            self.failRequest(request, error);
            return;
        }
        request.result = value;
        dispatch(request.onsuccess, { target: request });
    });
    return request;
};

FakeTransaction.prototype.write = function(view, kind, value, key) {
    var self = this;
    var request = createRequest();
    this.enqueue(function() {
        if (self.mode === "readonly") {
            self.failRequest(request, makeError("ReadOnlyError", "只读事务不能写入"));
            return;
        }
        var outcome;
        try {
            outcome = self.applyWrite(view, kind, value, key);
        } catch (error) {
            self.failRequest(request, error);
            return;
        }
        if (outcome.error) {
            self.failRequest(request, outcome.error);
            return;
        }
        request.result = outcome.result;
        dispatch(request.onsuccess, { target: request });
    });
    return request;
};

// 事务内可见的记录 = 已提交的记录叠加本次事务排队的写入。
FakeTransaction.prototype.effectiveRecords = function(view) {
    var records = new Map();
    if (!view.clearPending) {
        view.definition.records.forEach(function(record, recordToken) {
            records.set(recordToken, record);
        });
    }
    view.pendingWrites.forEach(function(entry, recordToken) {
        if (entry.deleted) {
            records.delete(recordToken);
        } else {
            records.set(recordToken, entry.value);
        }
    });
    return records;
};

FakeTransaction.prototype.applyWrite = function(view, kind, value, key) {
    var definition = view.definition;

    if (kind === "clear") {
        view.clearPending = true;
        view.pendingWrites.clear();
        return { result: undefined };
    }
    if (kind === "delete") {
        var deleteToken = token(key);
        view.pendingWrites.set(deleteToken, { deleted: true });
        return { result: undefined };
    }

    // 测试注入的存储故障（配额不足）。放在任何校验之前、并且不写 pending：
    // 断言"失败之后库里一个字节都没变"才成立。
    if (this.connection.factory.nextPutFailure) {
        var injected = this.connection.factory.nextPutFailure;
        this.connection.factory.nextPutFailure = null;
        return { error: injected };
    }

    var record = clone(value);
    var primaryKey = key;
    if (primaryKey === undefined && definition.keyPath) {
        primaryKey = keyOf(record, definition.keyPath);
    }
    if (primaryKey === undefined) {
        if (!definition.autoIncrement) {
            return { error: makeError("DataError", "记录没有键，且对象仓库不是自增的") };
        }
        primaryKey = this.nextAutoKey(view);
        if (definition.keyPath) {
            record[definition.keyPath] = primaryKey;
        }
    }

    var primaryToken = token(primaryKey);
    var records = this.effectiveRecords(view);
    if (kind === "add" && records.has(primaryToken)) {
        return { error: makeError("ConstraintError", "主键已存在：" + primaryToken) };
    }
    var conflict = this.findUniqueConflict(view, definition, record, primaryToken, records);
    if (conflict) {
        return { error: conflict };
    }

    view.pendingWrites.set(primaryToken, { value: record });
    return { result: primaryKey };
};

FakeTransaction.prototype.nextAutoKey = function(view) {
    var max = view.definition.autoKey || 0;
    this.effectiveRecords(view).forEach(function(record, recordToken) {
        var numeric = Number(recordToken);
        if (isFinite(numeric) && numeric > max) {
            max = numeric;
        }
    });
    if (view.stagedAutoKey > max) {
        max = view.stagedAutoKey;
    }
    view.stagedAutoKey = max + 1;
    return view.stagedAutoKey;
};

FakeTransaction.prototype.findUniqueConflict = function(view, definition, record, primaryToken, records) {
    var conflict = null;
    definition.indexes.forEach(function(indexDefinition, indexName) {
        if (conflict || !indexDefinition.unique) {
            return;
        }
        var wanted = token(keyOf(record, indexDefinition.keyPath));
        records.forEach(function(existing, existingToken) {
            if (conflict || existingToken === primaryToken) {
                return;
            }
            if (token(keyOf(existing, indexDefinition.keyPath)) === wanted) {
                conflict = makeError(
                    "ConstraintError",
                    "唯一索引冲突：" + indexName + " = " + wanted
                );
            }
        });
    });
    return conflict;
};

/*
 * 请求失败：先派发请求的 error，再派发事务的 error，最后整体 abort 回滚。
 * database.js 只 await 事务的 complete/abort，但请求级错误先报出来才谈得上
 * "哪一步失败的"。
 */
FakeTransaction.prototype.failRequest = function(request, error) {
    var self = this;
    if (this.finished || this.failing) {
        return;
    }
    this.failing = true;
    this.error = error;
    request.error = error;
    queueMicrotask(function() {
        dispatch(request.onerror, { target: request });
        dispatch(self.onerror, { target: self });
        self.settle(false);
    });
};

FakeTransaction.prototype.abort = function() {
    if (this.finished) {
        // 真实实现里 abort 一个已经结束的事务是 no-op，不抛错。
        return;
    }
    this.error = this.error || makeError("AbortError", "事务被中止");
    this.settle(false);
};

FakeTransaction.prototype.settle = function(committed) {
    var self = this;
    if (this.finished) {
        return;
    }
    this.finished = true;
    this.aborted = !committed;
    if (committed) {
        // 先合并进真实存储，再派发 complete：oncomplete 里读到的必须是新数据。
        this.commit();
    }
    var handler = committed ? this.oncomplete : this.onabort;
    queueMicrotask(function() {
        dispatch(handler, { target: self });
    });
};

/*
 * 没有排队的请求了 -> 事务自动提交（真实 IndexedDB 在微任务队列抽干后提交，
 * 这里放宽成一个宏任务，见文件头说明）。
 */
FakeTransaction.prototype.checkIdle = function() {
    var self = this;
    if (this.finished || this.failing || this.pending > 0 || this.idleTimerArmed) {
        return;
    }
    this.idleTimerArmed = true;
    setTimeout(function() {
        self.idleTimerArmed = false;
        if (self.finished || self.failing || self.pending > 0) {
            return;
        }
        self.settle(true);
    }, 0);
};

// 把 pendingWrites 合并回真实存储。索引项每次提交整体重算：库里只有几十条记录，
// 增量维护一旦算错，唯一索引就会悄悄失效。
FakeTransaction.prototype.commit = function() {
    this.views.forEach(function(view) {
        var definition = view.definition;
        if (view.clearPending) {
            definition.records.clear();
        }
        view.pendingWrites.forEach(function(entry, recordToken) {
            if (entry.deleted) {
                definition.records.delete(recordToken);
            } else {
                definition.records.set(recordToken, entry.value);
            }
        });
        // 自增计数器只前进不后退：clear() 之后也不会把用过的键重新发一遍。
        if (view.stagedAutoKey > definition.autoKey) {
            definition.autoKey = view.stagedAutoKey;
        }
    });
};

/* ------------------------------------------------------------------ *
 * 对象仓库与索引
 * ------------------------------------------------------------------ */

function FakeObjectStore(transaction, view) {
    this.transaction = transaction;
    this.view = view;
}

FakeObjectStore.prototype.createIndex = function(name, keyPath, options) {
    if (!this.transaction.isVersionChange()) {
        throw makeError("InvalidStateError", "只有升级事务里能建索引");
    }
    this.transaction.assertActive();
    var definition = this.view.definition;
    if (definition.indexes.has(name)) {
        throw makeError("ConstraintError", "索引已存在：" + name);
    }
    definition.indexes.set(name, {
        name: name,
        keyPath: keyPath,
        unique: Boolean(options && options.unique),
        multiEntry: Boolean(options && options.multiEntry)
    });
    return this.index(name);
};

FakeObjectStore.prototype.index = function(name) {
    var definition = this.view.definition.indexes.get(name);
    if (!definition) {
        throw makeError("NotFoundError", "索引不存在：" + name);
    }
    return new FakeIndex(this.transaction, this.view, definition);
};

FakeObjectStore.prototype.get = function(key) {
    var definition = this.view.definition;
    return this.transaction.read(this.view, function() {
        var record = definition.records.get(token(key));
        return record === undefined ? undefined : clone(record);
    });
};

FakeObjectStore.prototype.getAll = function() {
    var definition = this.view.definition;
    return this.transaction.read(this.view, function() {
        // 真实实现按主键升序返回。候选项的最终顺序在 store.js 里按 position 排，
        // 这里只是让读回来的顺序稳定、测试失败信息好读。
        return Array.from(definition.records.keys()).sort(compareTokens).map(function(recordToken) {
            return clone(definition.records.get(recordToken));
        });
    });
};

FakeObjectStore.prototype.put = function(value, key) {
    return this.transaction.write(this.view, "put", value, key);
};

FakeObjectStore.prototype.add = function(value, key) {
    return this.transaction.write(this.view, "add", value, key);
};

FakeObjectStore.prototype.delete = function(key) {
    return this.transaction.write(this.view, "delete", undefined, key);
};

FakeObjectStore.prototype.clear = function() {
    return this.transaction.write(this.view, "clear");
};

function FakeIndex(transaction, view, definition) {
    this.transaction = transaction;
    this.view = view;
    this.definition = definition;
    this.name = definition.name;
    this.keyPath = definition.keyPath;
    this.unique = definition.unique;
    this.multiEntry = definition.multiEntry;
}

/*
 * 索引上的 getAll。按索引键排序，只返回索引键有值的记录（真实实现里索引键为
 * undefined 的记录压根不进索引）。
 */
FakeIndex.prototype.getAll = function() {
    var self = this;
    return this.transaction.read(this.view, function() {
        var entries = [];
        self.view.definition.records.forEach(function(record, recordToken) {
            var key = keyOf(record, self.keyPath);
            if (key === undefined) {
                return;
            }
            entries.push({ key: token(key), recordToken: recordToken, record: record });
        });
        entries.sort(function(left, right) {
            if (left.key !== right.key) {
                return compareTokens(left.key, right.key);
            }
            return compareTokens(left.recordToken, right.recordToken);
        });
        return entries.map(function(entry) {
            return clone(entry.record);
        });
    });
};

/* ------------------------------------------------------------------ *
 * 连接
 * ------------------------------------------------------------------ */

function FakeConnection(factory, name, record, version) {
    this.factory = factory;
    this.name = name;
    this.record = record;
    this.version = version;
    this.closed = false;
    this.onversionchange = null;
    this.onclose = null;
    // 升级期间指向升级事务：createObjectStore 只能从升级事务里调。
    this.upgradeTransaction = null;
}

FakeConnection.prototype.createObjectStore = function(name, options) {
    var transaction = this.upgradeTransaction;
    if (!transaction || !transaction.isVersionChange()) {
        throw makeError("InvalidStateError", "只有升级事务里能建对象仓库");
    }
    transaction.assertActive();
    var settings = options || {};
    if (settings.autoIncrement && Array.isArray(settings.keyPath)) {
        throw makeError("NotSupportedError", "自增仓库不支持数组 keyPath");
    }
    if (this.record.stores.has(name)) {
        throw makeError("ConstraintError", "对象仓库已存在：" + name);
    }
    var definition = {
        name: name,
        keyPath: settings.keyPath === undefined ? null : settings.keyPath,
        autoIncrement: Boolean(settings.autoIncrement),
        records: new Map(),
        indexes: new Map(),
        autoKey: 0
    };
    this.record.stores.set(name, definition);
    this.record.order.push(name);
    var view = {
        definition: definition,
        pendingWrites: new Map(),
        clearPending: false,
        stagedAutoKey: 0
    };
    transaction.views.set(name, view);
    transaction.objectStoreNames.push(name);
    return new FakeObjectStore(transaction, view);
};

/*
 * 连接上的 objectStoreNames 是只读的 DOMStringList，database.js 只调 contains()。
 * 改成取值器：升级中的连接拿着 staged 记录，提交后 staged 就是正式记录，
 * 取值器才能一直读到最新的那份。
 */
Object.defineProperty(FakeConnection.prototype, "objectStoreNames", {
    get: function() {
        var names = Array.from(this.record.stores.keys());
        return {
            length: names.length,
            item: function(index) {
                return names[index] === undefined ? null : names[index];
            },
            contains: function(name) {
                return names.indexOf(name) !== -1;
            }
        };
    }
});

FakeConnection.prototype.transaction = function(storeNames, mode) {
    if (this.closed) {
        throw makeError("InvalidStateError", "连接已关闭");
    }
    var names = Array.isArray(storeNames) ? storeNames.slice() : [storeNames];
    var effectiveMode = mode || "readonly";
    if (effectiveMode !== "readonly" && effectiveMode !== "readwrite") {
        // database.js 只用 readonly / readwrite；"versionchange" 由升级流程内部建。
        throw makeError("TypeError", "不支持的事务模式：" + effectiveMode);
    }
    return new FakeTransaction(this, names, effectiveMode);
};

FakeConnection.prototype.close = function() {
    if (this.closed) {
        return;
    }
    this.closed = true;
    this.factory.connections.delete(this);
    // 真实实现里显式 close() 不派发 close 事件（那是异常终止用的），这里保持一致，
    // 免得 database.js 的 onclose 分支被误触发。
    this.factory.resumeUpgrades(this.name);
};

FakeConnection.prototype.dispatchVersionChange = function(newVersion) {
    dispatch(this.onversionchange, {
        target: this,
        oldVersion: this.version,
        newVersion: newVersion
    });
};

/* ------------------------------------------------------------------ *
 * 工厂
 * ------------------------------------------------------------------ */

function FakeDatabaseRecord(name) {
    this.name = name;
    this.version = 0;
    this.stores = new Map();
    this.order = [];
}

function FakeOpenRequest() {
    this.onupgradeneeded = null;
    this.onsuccess = null;
    this.onerror = null;
    this.onblocked = null;
    this.result = null;
    this.error = null;
    this.transaction = null;
}

function FakeFactory() {
    this.databases = new Map();
    this.connections = new Set();
    this.pendingUpgrades = [];
    // 正在跑升级的库名：升级是排队的，同一个库同时只能有一个在跑。
    this.activeUpgrades = new Set();
    this.nextPutFailure = null;
}

/*
 * 让下一次 put/add 失败，用于测配额不足那条分支：真实浏览器里
 * QuotaExceededError 是写请求失败 + 整个事务回滚，不是 open 失败。
 */
FakeFactory.prototype.failNextPut = function(error) {
    this.nextPutFailure = error;
};

/*
 * 给测试断言"库还在不在、版本是多少、还开着几个连接"用。
 * openConnectionCount 是验证"不能靠删库/降级重开来绕过 VersionError"的关键：
 * 拒写的那一次不能顺手把已有连接关掉。
 */
FakeFactory.prototype.inspect = function(name) {
    var databaseName = String(name);
    var record = this.databases.get(databaseName);
    return {
        exists: Boolean(record),
        version: record ? record.version : 0,
        stores: record ? record.order.slice() : [],
        openConnectionCount: this.openConnections(databaseName).length
    };
};

FakeFactory.prototype.open = function(name, version) {
    var self = this;
    var databaseName = String(name);
    var existing = this.databases.get(databaseName);
    var request = new FakeOpenRequest();
    var requested = version === undefined ? null : Number(version);

    if (requested !== null && (!isFinite(requested) || requested < 1)) {
        throw makeError("TypeError", "版本号必须是 1 以上的整数");
    }

    if (existing && requested !== null && requested < existing.version) {
        return this.rejectWithVersionError(request, requested, existing.version);
    }

    if (!existing) {
        existing = new FakeDatabaseRecord(databaseName);
        this.databases.set(databaseName, existing);
    }
    var targetVersion = requested === null ? Math.max(existing.version, 1) : requested;

    if (targetVersion === existing.version) {
        // 版本相同：不升级，直接给连接。
        queueMicrotask(function() {
            var record = self.databases.get(databaseName);
            // 排队期间库被别人升过版本了，同一个连接不能按两种版本发出去：
            // 重新判定，该报 VersionError 就报。
            if (record && targetVersion < record.version) {
                self.rejectWithVersionError(request, targetVersion, record.version);
                return;
            }
            self.finishOpen(request, record || existing, targetVersion);
        });
        return request;
    }

    this.pendingUpgrades.push({
        databaseName: databaseName,
        request: request,
        record: existing,
        targetVersion: targetVersion,
        oldVersion: existing.version,
        blockedFired: false
    });
    this.resumeUpgrades(databaseName);
    return request;
};

/*
 * 库比代码新：不能按旧结构读写，也不能删库重来。database.js 靠这个错误把操作
 * 挡在门外（VersionError）。**不删库**：删了就等于把用户的数据丢掉换一个"能用"。
 */
FakeFactory.prototype.rejectWithVersionError = function(request, requested, currentVersion) {
    var versionError = makeError(
        "VersionError",
        "请求的版本 " + requested + " 低于已存在的版本 " + currentVersion
    );
    queueMicrotask(function() {
        request.error = versionError;
        dispatch(request.onerror, { target: request });
    });
    return request;
};

FakeFactory.prototype.openConnections = function(databaseName) {
    var open = [];
    this.connections.forEach(function(connection) {
        if (connection.name === databaseName && !connection.closed) {
            open.push(connection);
        }
    });
    return open;
};

FakeFactory.prototype.pendingFor = function(databaseName) {
    return this.pendingUpgrades.filter(function(upgrade) {
        return upgrade.databaseName === databaseName;
    });
};

/*
 * 推进某个库上排队中的升级。有旧连接开着就先请它让路（派发 versionchange）；
 * 让了路就接着升级，不让路则在下一个宏任务里派发 blocked——database.js 的
 * blocked 分支就是靠这一步触发的。
 */
FakeFactory.prototype.resumeUpgrades = function(databaseName) {
    var self = this;
    queueMicrotask(function() {
        self.runPendingUpgrades(databaseName);
    });
};

FakeFactory.prototype.runPendingUpgrades = function(databaseName) {
    var self = this;
    // 同一个库同一时刻只能有一个升级在跑：升级是按队列顺序来的。少了这个闸门，
    // 两个版本不同的 open 会各自看到"没有旧连接"而同时升级，测试里就会看到
    // 两个请求都成功（真实 IndexedDB 里第二个要排队）。
    if (this.activeUpgrades.has(databaseName)) {
        return;
    }
    var waiting = this.pendingFor(databaseName);
    if (waiting.length === 0) {
        return;
    }
    var head = waiting[0];
    var current = this.databases.get(databaseName);
    if (current && head.targetVersion < current.version) {
        // 排队期间库被别的请求升到了更高的版本。
        this.pendingUpgrades.splice(this.pendingUpgrades.indexOf(head), 1);
        this.rejectWithVersionError(head.request, head.targetVersion, current.version);
        this.resumeUpgrades(databaseName);
        return;
    }
    var blockers = this.openConnections(databaseName);
    if (blockers.length > 0) {
        // 请旧连接让路（派发 versionchange）。旧连接的 onversionchange 通常会
        // close()，close() 会再调一次这里，那时就能接着升级。
        blockers.forEach(function(connection) {
            connection.dispatchVersionChange(head.targetVersion);
        });
        if (this.openConnections(databaseName).length === 0) {
            this.resumeUpgrades(databaseName);
            return;
        }
        if (head.blockedPending || head.blockedFired) {
            // 判定还没跑、或者已经报过 blocked 了（真实实现里 blocked 的请求不会
            // 取消：对方关掉之后升级照样继续，database.js 的 abandoned 分支就是
            // 为这种"报错之后又成功"的情况写的）。
            return;
        }
        head.blockedPending = true;
        setTimeout(function() {
            head.blockedPending = false;
            if (self.openConnections(databaseName).length === 0) {
                // 旧连接在这一轮里关掉了，照样能升级，不派发 blocked。
                self.resumeUpgrades(databaseName);
                return;
            }
            head.blockedFired = true;
            dispatch(head.request.onblocked, {
                target: head.request,
                oldVersion: head.oldVersion,
                newVersion: head.targetVersion
            });
        }, 0);
        return;
    }
    var index = this.pendingUpgrades.indexOf(head);
    this.pendingUpgrades.splice(index, 1);
    this.startUpgrade(head);
};

/*
 * 跑一次升级：建一个 versionchange 事务，派发 onupgradeneeded，事务提交后
 * 才把连接给出去。升级里抛错时 database.js 会 abort 这个事务，库留在升级前的
 * 版本（而不是"表建了一半、版本号没动"），这里用 staged 记录来还原。
 */
FakeFactory.prototype.startUpgrade = function(upgrade) {
    var self = this;
    var record = upgrade.record;
    this.activeUpgrades.add(upgrade.databaseName);
    var staged = {
        name: record.name,
        version: upgrade.targetVersion,
        stores: new Map(record.stores),
        order: record.order.slice()
    };
    var connection = new FakeConnection(this, upgrade.databaseName, staged, upgrade.targetVersion);
    var transaction = new FakeTransaction(connection, [], "versionchange");
    connection.upgradeTransaction = transaction;

    transaction.oncomplete = function() {
        record.version = upgrade.targetVersion;
        record.stores = staged.stores;
        record.order = staged.order;
        staged.version = upgrade.targetVersion;
        self.connections.add(connection);
        connection.upgradeTransaction = null;
        upgrade.request.result = connection;
        dispatch(upgrade.request.onsuccess, { target: upgrade.request });
        // 升级完了，放行排在后面的请求（可能是同一个库的另一个 open）。
        self.activeUpgrades.delete(upgrade.databaseName);
        self.resumeUpgrades(upgrade.databaseName);
    };
    transaction.onabort = function() {
        connection.upgradeTransaction = null;
        // 库没升级成功：保持原样，并让 open 请求失败。
        upgrade.request.error = transaction.error || makeError("AbortError", "升级事务被中止");
        dispatch(upgrade.request.onerror, { target: upgrade.request });
        self.activeUpgrades.delete(upgrade.databaseName);
        self.resumeUpgrades(upgrade.databaseName);
    };

    upgrade.request.transaction = transaction;
    upgrade.request.result = connection;

    try {
        dispatch(upgrade.request.onupgradeneeded, {
            target: upgrade.request,
            oldVersion: upgrade.oldVersion,
            newVersion: upgrade.targetVersion
        });
    } finally {
        // onupgradeneeded 里只建结构（同步），所以这里一定没有排队的请求；
        // 调度一次空闲检查让升级事务提交。
        transaction.checkIdle();
    }
};

FakeFactory.prototype.finishOpen = function(request, record, version) {
    var connection = new FakeConnection(this, record.name, record, version);
    this.connections.add(connection);
    request.result = connection;
    dispatch(request.onsuccess, { target: request });
};

/*
 * createFakeIndexedDB(): 造一个可以塞进
 * `AppDatabase.create({ indexedDB: fake, name: "..." })` 的工厂。
 */
function createFakeIndexedDB() {
    return new FakeFactory();
}

module.exports = {
    createFakeIndexedDB: createFakeIndexedDB
};
