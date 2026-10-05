"use strict";

/*
 * IndexedDB 持久化层。业务规则一条都不在这里——全部在 store.js；这一层只回答
 * 一个问题：「把状态读出来、改完写回去，并且要么整体生效要么整体不动」。
 *
 * 事务规则（每条都对应一个真实会发生的失败，改之前先想清楚）：
 *
 * 1. 每个写操作开一个 readwrite 事务，事务内只 await 这个事务自己的 request。
 *    IndexedDB 的事务在控制权回到事件循环时会自动提交，中间夹一个文件读取、
 *    JSON.parse 之后的用户确认、或任何定时器，事务就变成 inactive，后面的写入
 *    抛 TransactionInactiveError。所以读文件、解析 JSON、确认对话框全在事务
 *    之外做完，事务里只剩「读 -> 纯函数改 -> 写」。
 *
 * 2. 成功的判定是事务的 complete 事件，不是某个 request 的 success。最后一个
 *    request 成功之后事务仍可能整体回滚（唯一索引冲突、配额不足），那时报
 *    "已保存"就是假话，而用户已经看到成功提示、不会再检查。
 *
 * 3. 事务内先读完所有需要的数据，再同步跑 store.js 的纯函数，最后才写。
 *    顺序反了会出现「写了一半才发现有重复」。
 *
 * 4. 遇到更高的未知版本直接拒写：那是新版本应用建的库。旧代码按老结构写进去
 *    只会静默损坏数据，也**不能**用删库来"修复"。
 */
(function(root, factory) {
    var api = factory(
        typeof module === "object" && module.exports ? require("./store.js") : root.AppStore
    );
    if (typeof module === "object" && module.exports) {
        module.exports = api;
    }
    if (root) {
        root.AppDatabase = api;
    }
}(typeof window === "undefined" ? null : window, function(AppStore) {
    if (!AppStore) {
        throw new Error("database.js 依赖 store.js，请确认它在前面加载");
    }

    // 本地存储结构版本。它和 SQLite 的 user_version、JSON 导出的 schemaVersion
    // 是三件独立的事，不要合并成同一个数字。
    var STORAGE_SCHEMA_VERSION = 1;
    var DEFAULT_NAME = "what-should-we-eat";

    var STORE_CHOICES = "choices";
    var STORE_HISTORY = "history";
    var STORE_METADATA = "metadata";
    var STORE_SNAPSHOTS = "snapshots";
    var META_KEY = "app-state";

    var STORES = [STORE_CHOICES, STORE_HISTORY, STORE_METADATA, STORE_SNAPSHOTS];

    function makeErrorClass(name) {
        function Custom(message) {
            var error = Error.call(this, message);
            this.name = name;
            this.message = message;
            this.stack = error.stack;
        }
        Custom.prototype = Object.create(Error.prototype);
        Custom.prototype.constructor = Custom;
        return Custom;
    }

    // 存储本身的故障（打不开、配额不足、有别的标签页挡着）。
    var DatabaseError = makeErrorClass("DatabaseError");
    // 本地数据来自更新版本的应用：不是数据坏了，是页面该刷新了。
    var VersionError = makeErrorClass("VersionError");

    /*
     * 结构升级步骤。键是目标版本号。
     *
     * 只能在 onupgradeneeded 给的升级事务里动结构，不能自己开事务
     * （升级事务结束前开不了新事务）。整段跑在一个事务里，抛异常就整体回滚，
     * 库留在升级前的版本，而不是"表建了一半、版本号没动"。
     */
    var UPGRADES = {
        1: function(db) {
            if (!db.objectStoreNames.contains(STORE_CHOICES)) {
                var choices = db.createObjectStore(STORE_CHOICES, { keyPath: "id" });
                // 规范化名字建唯一索引：两个标签页同时添加同名候选项时，
                // 靠数据库自己拦住，而不是靠页面先查一遍（两边都会查到"不存在"）。
                choices.createIndex("nameKey", "nameKey", { unique: true });
            }
            if (!db.objectStoreNames.contains(STORE_HISTORY)) {
                var history = db.createObjectStore(STORE_HISTORY, { keyPath: "id" });
                // 排序是 selected_at DESC, seq DESC。索引键用数组把两个字段拼
                // 起来是为了让将来真要用游标时能一次走完；现在的排序在 store.js
                // 里做（几十条记录，读回来排比走两段游标更好懂）。
                history.createIndex("order", ["selectedAt", "seq"]);
            }
            if (!db.objectStoreNames.contains(STORE_METADATA)) {
                // 计数器（下一个 id / seq）、初始化标记、修订号。
                db.createObjectStore(STORE_METADATA, { keyPath: "key" });
            }
            if (!db.objectStoreNames.contains(STORE_SNAPSHOTS)) {
                var snapshots = db.createObjectStore(STORE_SNAPSHOTS, { keyPath: "id", autoIncrement: true });
                snapshots.createIndex("createdAt", "createdAt");
            }
        }
    };

    function requestToPromise(request) {
        return new Promise(function(resolve, reject) {
            request.onsuccess = function() {
                resolve(request.result);
            };
            request.onerror = function() {
                reject(request.error || new DatabaseError("本地数据库请求失败"));
            };
        });
    }

    /*
     * 把事务的成败接到 Promise 上。
     *
     * 等的是 complete 而不是某个 request 的 success：一个 request 成功之后，
     * 事务仍可能因为别的请求失败、唯一索引冲突或配额不足而整体回滚。
     */
    function transactionDone(transaction) {
        return new Promise(function(resolve, reject) {
            transaction.oncomplete = function() {
                resolve();
            };
            transaction.onabort = function() {
                reject(transaction.error || new DatabaseError("本地数据库事务被中止"));
            };
            transaction.onerror = function() {
                reject(transaction.error || new DatabaseError("本地数据库事务失败"));
            };
        });
    }

    function noop() {
        return undefined;
    }

    /*
     * 错误归一。业务拒绝（ValidationError / ConflictError / NotFoundError）
     * 原样透出：index.js 直接把 error.message 显示给用户，包一层会把
     * "不能添加重复的食物"变成"数据库操作失败"。
     */
    function toPublicError(error) {
        if (error instanceof DatabaseError || error instanceof VersionError) {
            return error;
        }
        if (error instanceof AppStore.ValidationError
            || error instanceof AppStore.ConflictError
            || error instanceof AppStore.NotFoundError) {
            return error;
        }
        if (error instanceof Error) {
            if (error.name === "QuotaExceededError") {
                return new DatabaseError("手机存储空间不足，无法保存。请先导出备份，再清理浏览器数据。");
            }
            if (error.name === "VersionError") {
                return new VersionError(
                    "本地数据由更新版本的应用创建，当前页面已停止读写以免损坏数据。请刷新页面获取最新版本。"
                );
            }
            if (error.name === "TransactionInactiveError") {
                // 这条只会在实现写错时出现（事务里夹了异步等待）。
                return new DatabaseError("本地数据库事务已失效，本次操作没有保存。请重试。");
            }
            // ConstraintError 之类：给原始消息，便于发现"同名候选项没被拦住"。
            return new DatabaseError("本地数据库错误：" + error.message);
        }
        return new DatabaseError("本地数据库操作失败");
    }

    /*
     * 打开数据库。resolve 出的连接由调用方保管；versionchange 时自动关闭，
     * 让要升级的另一个标签页拿得到升级锁（不关的话对方的 open 一直 blocked）。
     */
    function open(factory, name, version, onClosed) {
        return new Promise(function(resolve, reject) {
            var request;
            try {
                request = factory.open(name, version);
            } catch (error) {
                reject(toPublicError(error));
                return;
            }
            var abandoned = false;

            request.onupgradeneeded = function(event) {
                var transaction = request.transaction;
                try {
                    for (var target = event.oldVersion + 1; target <= version; target += 1) {
                        var upgrade = UPGRADES[target];
                        if (!upgrade) {
                            throw new DatabaseError("缺少本地数据库升级步骤：" + target);
                        }
                        upgrade(request.result, transaction);
                    }
                } catch (error) {
                    // 中止升级事务：库留在升级前的版本，而不是半升级状态。
                    transaction.abort();
                    reject(toPublicError(error));
                }
            };

            request.onsuccess = function() {
                var db = request.result;
                if (abandoned) {
                    // blocked 之后我们已经报过错了，这次连接没人用，直接关掉。
                    db.close();
                    return;
                }
                db.onversionchange = function() {
                    db.close();
                    onClosed();
                };
                db.onclose = function() {
                    onClosed();
                };
                resolve(db);
            };

            request.onerror = function() {
                reject(toPublicError(request.error || new DatabaseError("无法打开本地数据库")));
            };

            request.onblocked = function() {
                // 别的标签页还握着旧连接。不能强升级，也不该无限等下去：
                // 报错让用户关掉其它标签页。
                abandoned = true;
                reject(new DatabaseError(
                    "另一个标签页正在使用旧版本的数据，请关闭其它标签页后重试。"
                ));
            };
        });
    }

    function create(options) {
        var settings = options || {};
        var name = settings.name || DEFAULT_NAME;
        // 测试可以注入一个实现；浏览器里取全局 indexedDB。
        var factory = settings.indexedDB
            || (typeof indexedDB === "undefined" ? null : indexedDB);
        var connection = null;
        var opening = null;

        if (!factory) {
            // 无痕模式、禁用存储、或很老的浏览器。这不是崩溃，是该明确告诉用户
            // "这个浏览器存不了数据"，而不是让页面停在空白状态。
            return {
                name: name,
                supported: false,
                connect: function() {
                    return Promise.reject(new DatabaseError(
                        "当前浏览器不支持本地数据库（IndexedDB），无法保存数据。"
                    ));
                },
                close: noop
            };
        }

        function forgetConnection() {
            connection = null;
        }

        /*
         * 拿一个可用连接。
         *
         * 先按当前支持的版本 open：库比我们旧时 onupgradeneeded 会照常升级；
         * 库比我们新时 open 直接失败，此时**不能**降级重开、更不能删库重来，
         * 只能让用户刷新到新版本。
         */
        function connect() {
            if (connection) {
                return Promise.resolve(connection);
            }
            if (opening) {
                return opening;
            }
            opening = open(factory, name, STORAGE_SCHEMA_VERSION, forgetConnection)
                .then(function(db) {
                    connection = db;
                    opening = null;
                    return db;
                })
                .catch(function(error) {
                    opening = null;
                    throw toPublicError(error);
                });
            return opening;
        }

        function close() {
            if (connection) {
                connection.close();
            }
            connection = null;
            opening = null;
        }

        // 存储里的记录 -> store.js 的 state。
        function toState(choiceRows, historyRows, metaRow) {
            return AppStore.normalizeState({
                choices: choiceRows.map(fromStoredChoice),
                history: historyRows.map(fromStoredHistory),
                meta: metaRow && metaRow.value ? metaRow.value : null
            });
        }

        /*
         * 只读路径。三个读取一起发出去、再分别 await：中途 await 单个结果
         * 会让事务在回到事件循环时提交，后面的读取就发不出去了。
         */
        function readOnly(handler) {
            return connect().then(function(db) {
                var transaction = db.transaction(STORES, "readonly");
                var done = transactionDone(transaction);
                var reads = Promise.all([
                    requestToPromise(transaction.objectStore(STORE_CHOICES).getAll()),
                    requestToPromise(transaction.objectStore(STORE_HISTORY).getAll()),
                    requestToPromise(transaction.objectStore(STORE_METADATA).get(META_KEY))
                ]);
                return Promise.all([reads, done]).then(function(outcome) {
                    return handler(toState(outcome[0][0], outcome[0][1], outcome[0][2]));
                });
            }).catch(function(error) {
                throw toPublicError(error);
            });
        }

        /*
         * 写路径：读 -> 改 -> 写 -> 等 complete。
         *
         * mutator 必须同步，并且只能改传进来的 state。它返回
         * `{result, snapshot?}`；抛异常时显式中止事务，存储保持原样。
         */
        function readWrite(mutator) {
            return connect().then(function(db) {
                var transaction = db.transaction(STORES, "readwrite");
                var done = transactionDone(transaction);
                var choicesStore = transaction.objectStore(STORE_CHOICES);
                var historyStore = transaction.objectStore(STORE_HISTORY);
                var metadataStore = transaction.objectStore(STORE_METADATA);
                var snapshotsStore = transaction.objectStore(STORE_SNAPSHOTS);

                var reads = Promise.all([
                    requestToPromise(choicesStore.getAll()),
                    requestToPromise(historyStore.getAll()),
                    requestToPromise(metadataStore.get(META_KEY)),
                    requestToPromise(snapshotsStore.getAll())
                ]);

                return reads.then(function(rows) {
                    var state = toState(rows[0], rows[1], rows[2]);
                    var change;
                    try {
                        change = mutator(state) || {};
                    } catch (error) {
                        // 业务规则拒绝。此刻一个字节都还没写，明确中止事务，
                        // 顺手把 done 的 rejection 接掉，避免"未处理的拒绝"。
                        done.catch(noop);
                        transaction.abort();
                        throw error;
                    }

                    // 整表写回：候选项在几十条量级，全量写比逐条 diff 更不容易
                    // 出错，也和 store.js「纯函数改完再整份写回」是一个意思。
                    choicesStore.clear();
                    historyStore.clear();
                    state.choices.forEach(function(choice) {
                        choicesStore.put(toStoredChoice(choice));
                    });
                    state.history.forEach(function(record) {
                        historyStore.put(toStoredHistory(record));
                    });
                    metadataStore.put({ key: META_KEY, value: state.meta });

                    if (change.snapshot) {
                        // 快照和破坏性改动在同一个事务里：快照写不进去，
                        // 删除也一起回滚（不能"先删了再说，备份下次注意"）。
                        snapshotsStore.put(change.snapshot);
                        pruneSnapshots(snapshotsStore, rows[3]);
                    }

                    return done.then(function() {
                        return change.result;
                    });
                });
            }).catch(function(error) {
                throw toPublicError(error);
            });
        }

        /*
         * 快照裁剪：只保留最近 SNAPSHOT_LIMIT 份。
         *
         * 本事务又写了一份新快照（createdAt 是刚取的，一定最新），所以旧的
         * 只保留 SNAPSHOT_LIMIT - 1 份。排序用 createdAt，同毫秒时用自增 id
         * 兜底——只按 createdAt 排会在同一毫秒里退化成"任意顺序"。
         */
        function pruneSnapshots(snapshotsStore, existing, keepFromExisting) {
            var limit = typeof keepFromExisting === "number"
                ? keepFromExisting
                : AppStore.SNAPSHOT_LIMIT - 1;
            if (existing.length <= limit) {
                return;
            }
            existing.slice().sort(function(left, right) {
                if (left.createdAt !== right.createdAt) {
                    return left.createdAt < right.createdAt ? 1 : -1;
                }
                return right.id - left.id;
            }).slice(limit).forEach(function(item) {
                snapshotsStore.delete(item.id);
            });
        }

        return {
            name: name,
            supported: true,
            connect: connect,
            close: close,

            /*
             * 首次启动的默认候选项。判据是 metadata 里的 initialized 标记，
             * 不是"候选项列表为空"：用户把候选项全删光是合法状态，
             * 那时重新种一遍默认值等于把删除操作撤销了。
             */
            initialize: function() {
                return readWrite(function(state) {
                    var outcome = AppStore.initializeIfNeeded(state);
                    return {
                        result: {
                            seeded: outcome.seeded,
                            state: AppStore.toApiState(state)
                        }
                    };
                });
            },

            getState: function() {
                return readOnly(function(state) {
                    return AppStore.toApiState(state);
                });
            },

            addChoice: function(choiceName) {
                return readWrite(function(state) {
                    return { result: AppStore.addChoice(state, choiceName) };
                });
            },

            deleteChoice: function(choiceId) {
                return readWrite(function(state) {
                    return { result: AppStore.deleteChoice(state, choiceId) };
                });
            },

            addChoiceMeta: function(kind, choiceId, value) {
                return readWrite(function(state) {
                    return { result: AppStore.addChoiceMeta(state, kind, choiceId, value) };
                });
            },

            deleteChoiceMeta: function(kind, choiceId, metaId) {
                return readWrite(function(state) {
                    return { result: AppStore.deleteChoiceMeta(state, kind, choiceId, metaId) };
                });
            },

            addHistory: function(food) {
                return readWrite(function(state) {
                    return { result: AppStore.addHistory(state, food) };
                });
            },

            updateHistory: function(recordId, food, selectedAt) {
                return readWrite(function(state) {
                    return { result: AppStore.updateHistory(state, recordId, food, selectedAt) };
                });
            },

            deleteHistory: function(recordId) {
                return readWrite(function(state) {
                    return { result: AppStore.deleteHistory(state, recordId) };
                });
            },

            // 破坏性操作：快照与清空在同一个事务里。
            clearHistory: function() {
                return readWrite(function(state) {
                    var snapshot = AppStore.buildSnapshot(state);
                    AppStore.clearHistory(state);
                    return {
                        // snapshotAt 是机器读的（用来核对"确实留了副本"），
                        // 展示用的说法由 api-local.js 拼，存储层不写面向用户的文案。
                        result: { cleared: true, snapshotAt: snapshot.createdAt },
                        snapshot: snapshot
                    };
                });
            },

            previewImport: function(payload) {
                return readOnly(function(state) {
                    return AppStore.previewImport(state, payload);
                });
            },

            /*
             * 覆盖导入会整体替换数据，先留快照再清空，同一个事务。
             * merge 不动现有数据，不需要快照。
             *
             * summary.snapshot 是**字符串**：index.js 直接把它拼进提示语
             * （"覆盖前的数据已备份到 " + summary.snapshot），给个对象会渲染成
             * [object Object]。
             */
            applyImport: function(payload, mode) {
                return readWrite(function(state) {
                    var snapshot = mode === "replace" ? AppStore.buildSnapshot(state) : null;
                    var outcome = AppStore.applyImport(state, payload, mode);
                    var summary = outcome.summary;
                    if (snapshot) {
                        summary.snapshot = snapshot.createdAt;
                    }
                    return {
                        result: { summary: summary, state: AppStore.toApiState(state) },
                        snapshot: snapshot
                    };
                });
            },

            // 导出在一份一致的只读快照上取，Blob 与下载在事务外做。
            buildExport: function() {
                return readOnly(function(state) {
                    return AppStore.buildExport(state);
                });
            },

            /*
             * 已有的快照列表（只读）。给"清空之前先看看有没有副本"这类提示用，
             * 不参与业务判定，所以只回摘要不回全量数据。
             */
            listSnapshots: function() {
                return connect().then(function(db) {
                    var transaction = db.transaction(STORE_SNAPSHOTS, "readonly");
                    var done = transactionDone(transaction);
                    var request = transaction.objectStore(STORE_SNAPSHOTS).getAll();
                    return Promise.all([requestToPromise(request), done]);
                }).then(function(outcome) {
                    return outcome[0].map(function(item) {
                        return {
                            id: item.id,
                            createdAt: item.createdAt,
                            choiceCount: (item.choices || []).length,
                            historyCount: (item.history || []).length
                        };
                    }).sort(function(left, right) {
                        if (left.createdAt !== right.createdAt) {
                            return left.createdAt < right.createdAt ? 1 : -1;
                        }
                        return right.id - left.id;
                    });
                }).catch(function(error) {
                    throw toPublicError(error);
                });
            }
        };
    }

    function toStoredChoice(choice) {
        return {
            id: choice.id,
            name: choice.name,
            // 唯一索引的键在写入时算好存进记录：读回时不再依赖字典版本，
            // 而且索引本身就能拦住并发添加的同名候选项。
            nameKey: AppStore.foldedKey(choice.name),
            position: choice.position,
            aliases: choice.aliases.map(function(item) {
                return { id: item.id, alias: item.alias };
            }),
            tags: choice.tags.map(function(item) {
                return { id: item.id, tag: item.tag };
            })
        };
    }

    function fromStoredChoice(record) {
        return {
            id: record.id,
            name: record.name,
            position: record.position,
            aliases: record.aliases || [],
            tags: record.tags || []
        };
    }

    function toStoredHistory(record) {
        return {
            id: record.id,
            food: record.food,
            selectedAt: record.selectedAt,
            seq: record.seq
        };
    }

    function fromStoredHistory(record) {
        return {
            id: record.id,
            food: record.food,
            selectedAt: record.selectedAt,
            seq: record.seq
        };
    }

    return {
        STORAGE_SCHEMA_VERSION: STORAGE_SCHEMA_VERSION,
        DEFAULT_NAME: DEFAULT_NAME,
        STORES: STORES,
        STORE_CHOICES: STORE_CHOICES,
        STORE_HISTORY: STORE_HISTORY,
        STORE_METADATA: STORE_METADATA,
        STORE_SNAPSHOTS: STORE_SNAPSHOTS,
        META_KEY: META_KEY,
        DatabaseError: DatabaseError,
        VersionError: VersionError,
        create: create
    };
}));
