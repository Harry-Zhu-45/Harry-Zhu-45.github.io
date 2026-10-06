#!/usr/bin/env node
"use strict";

/*
 * pwa/sw.js 的运行时测试：node tests/test_service_worker.js
 *
 * 为什么需要这个文件：sw.js 是唯一"写错了只能在真机上发现"的产品逻辑。
 * 别的层出错会有明确的报错或界面异常，而缓存分派写错的表现是
 * **用户离线打不开**——那正是这个应用存在的意义。在加这个测试之前，
 * sw.js 只有构建期校验（占位符被替换、PRECACHE 清单与产物一致），
 * install/activate/fetch 里没有一行被真正执行过。
 *
 * 装载的是 **dist/pwa/sw.js**，不是 pwa/sw.js：缓存名里的指纹只在产物里，
 * 而产物才是要发布的东西。顺手也守住"dist 里不能残留 __CACHE_VERSION__"。
 *
 * 这**不是**浏览器契约验证。桩是我按 SW 规范里用到的部分写的，覆盖不到的：
 * 真实的 CacheStorage 配额与淘汰、SW 的实际注册与生命周期时序、多标签页
 * 接管、cache.add 的真实网络行为。这些只能真机验收，不能靠这个文件声称
 * "离线能力已验证"。它锁住的是**分派逻辑的分支行为**。
 */

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const PROJECT_ROOT = path.join(__dirname, "..");
const DIST = path.join(PROJECT_ROOT, "dist", "pwa");
const SW_FILE = path.join(DIST, "sw.js");

// 桩里的相对 URL 一律按这个 scope 解析。用子路径而不是根路径，是为了让
// "相对路径解析"这件事在测试里真的被走到：根路径下 "./x" 和 "/x" 看不出区别。
const SCOPE = "https://example.test/what-should-we-eat/";

let checks = 0;
const failures = [];

async function test(name, body) {
    let watchdog;
    try {
        // 未决 Promise 不会让 Node 保持运行；真实看门狗防止挂起用例退出 0。
        await Promise.race([
            body(),
            new Promise(function(resolve, reject) {
                watchdog = setTimeout(function() {
                    reject(new Error("测试未在 3 秒内完成（可能存在未决响应）"));
                }, 3000);
            })
        ]);
        checks += 1;
        console.log("ok   - " + name);
    } catch (error) {
        failures.push({ name: name, error: error });
        console.log("FAIL - " + name);
        console.log("       " + (error && error.message));
    } finally {
        clearTimeout(watchdog);
    }
}

function fail(message) {
    throw new Error(message);
}

// --------------------------------------------------------------------------
// Service Worker 运行环境的桩
// --------------------------------------------------------------------------

/*
 * Request 桩必须自己写，不能用 node 的 undici 版。
 *
 * 浏览器里 `new Request("./index.html")` 是合法的：相对 URL 按 SW 的 scope
 * 解析成绝对地址。node 的 `Request` 要求绝对 URL，遇到 "./index.html" 直接抛
 * `TypeError: Failed to parse URL`——用它做桩的话，sw.js 里每一处相对路径
 * 都会在测试里炸掉，而那句报错和真实缺陷毫无关系。
 *
 * 解析结果是这个桩里最要紧的东西：`"./index.html"` 与 `"./"` 必须解析成
 * **两个不同的绝对 URL**。它们相同的话，导航回退（找 index.html）和
 * 冷启动回退（找 "./"）就会互相冒充，缓存键也会串。
 */
function createSandbox(options) {
    options = options || {};

    const entries = new Map();   // 缓存内容：绝对 URL -> 响应
    const calls = {
        openNames: [],
        added: [],               // [url, cacheMode]
        put: [],
        deleted: [],
        claimed: 0,
        skippedWaiting: 0,
        waited: [],
        fetched: [],
        loaders: options.loaders || null   // 预置缓存内容
    };

    function resolve(value) {
        return new URL(typeof value === "string" ? value : value.url, SCOPE).href;
    }

    const cache = {
        add: async function(request) {
            const url = resolve(request);
            calls.added.push([url, request.cache]);
            if (options.addFails && options.addFails(url)) {
                throw new TypeError("Failed to fetch");
            }
            entries.set(url, { url: url, body: "cached", ok: true, type: "basic" });
        },
        put: async function(request, response) {
            if (options.putFails) {
                throw new Error("cache write failed");
            }
            const url = resolve(request);
            calls.put.push(url);
            entries.set(url, response);
        }
    };

    const caches = {
        open: async function(name) {
            calls.openNames.push(name);
            return cache;
        },
        match: async function(request) {
            if (options.matchFails) {
                throw new Error("cache read failed");
            }
            return entries.get(resolve(request));
        },
        keys: async function() {
            return options.existingCaches || [];
        },
        delete: async function(name) {
            calls.deleted.push(name);
            return true;
        }
    };

    const listeners = {};
    /*
     * clients 用 Proxy 包一层，记下 sw.js 到底读了哪些方法。
     *
     * 为什么不用普通对象：那样只能断言"我给它定义了哪些方法"，而真正要守的是
     * "sw.js **用了**哪些"。"不许自己刷新页面"这条约束靠的是这个区别——
     * clients 上只要有 navigate() 能被调到，这个文件就有能力把用户正在编辑的
     * 页面换掉。读一次记一次，用没用过就藏不住了。
     */
    const clientsMethods = [];
    calls.clientsMethods = clientsMethods;
    const clients = new Proxy({}, {
        get: function(target, property) {
            if (typeof property !== "string") {
                return undefined;
            }
            clientsMethods.push(property);
            if (property === "claim") {
                return async function() { calls.claimed += 1; };
            }
            return undefined;
        }
    });
    const self = {
        location: new URL(SCOPE),
        clients: clients,
        skipWaiting: function() { calls.skippedWaiting += 1; },
        addEventListener: function(type, handler) { listeners[type] = handler; }
    };

    function makeResponse(url, overrides) {
        const response = {
            url: url,
            ok: true,
            type: "basic",
            status: 200,
            clone: function() { return makeResponse(url, overrides); }
        };
        return Object.assign(response, overrides || {});
    }

    function fetchImpl(request) {
        const url = resolve(request);
        calls.fetched.push(url);
        if (options.networkDown) {
            return Promise.reject(new TypeError("Failed to fetch"));
        }
        if (options.fetch) {
            return options.fetch(url, makeResponse);
        }
        if (options.networkHangs) {
            return new Promise(function() {});
        }
        const overrides = options.responseFor ? options.responseFor(url) : null;
        return Promise.resolve(makeResponse(url, overrides));
    }

    /*
     * 手动时钟。用例可以精确决定"超时先生效"还是"网络先生效"，
     * 而不用真的等 3 秒。
     */
    const timers = (function() {
        let pending = [];
        let nextId = 1;
        return {
            set: function(fn, delay) {
                const id = nextId++;
                pending.push({ id: id, fn: fn, delay: delay });
                return id;
            },
            clear: function(id) {
                pending = pending.filter(function(t) { return t.id !== id; });
            },
            // 触发所有还没被 clear 掉的定时器（模拟"时间到了"）。
            fire: function() {
                const due = pending;
                pending = [];
                due.forEach(function(t) { t.fn(); });
            },
            pendingCount: function() { return pending.length; },
            /*
             * 记下注册时的 delay。手动时钟会无视 delay 直接触发，所以"超时上限
             * 是 3 秒还是 30 秒"这件事必须单独断言——不查的话，把上限改成
             * 999999999（等于没有超时）也能让所有用例通过。
             */
            lastDelay: function() {
                return pending.length ? pending[pending.length - 1].delay : null;
            }
        };
    })();

    const sandbox = {
        self: self,
        caches: caches,
        fetch: fetchImpl,
        Request: function(url, init) {
            init = init || {};
            this.url = resolve(url);
            this.cache = init.cache;
            this.method = init.method || "GET";
        },
        URL: URL,
        Promise: Promise,
        console: console,
        Error: Error,
        TypeError: TypeError,
        /*
         * sw.js 的导航分支用 setTimeout 做超时兜底。这里不能直接把真的
         * setTimeout 塞进去：那会让"超时"用例真的等 3 秒，而且没法确定性地
         * 控制"超时先到"还是"网络先到"。
         *
         * 所以做成手动时钟：记下回调，由用例显式 fireTimers() 推进。
         */
        setTimeout: timers.set,
        clearTimeout: timers.clear
    };
    sandbox.globalThis = sandbox;
    vm.createContext(sandbox);
    vm.runInContext(fs.readFileSync(SW_FILE, "utf8"), sandbox);

    /*
     * 触发一个事件并把 waitUntil 的 promise 等掉。
     *
     * 这一步不能省：install 的缓存填充、activate 的清理与 claim 全都在
     * waitUntil 的 promise 里。随手调用监听器然后立刻断言，看到的永远是
     * "什么都没发生"——写这个文件时就先踩了一次，activate 的删除列表是空的。
     */
    async function fire(type, event) {
        let waited = null;
        const payload = Object.assign({
            waitUntil: function(promise) { waited = promise; }
        }, event || {});
        listeners[type](payload);
        if (waited) {
            await waited;
        }
    }

    /* 触发 fetch 并拿回 respondWith 的 promise（没被接管时是 null）。 */
    async function intercept(request) {
        let responder = null;
        listeners.fetch({
            request: request,
            respondWith: function(promise) { responder = promise; },
            waitUntil: function(promise) { calls.waited.push(promise); }
        });
        return responder === null ? null : await responder;
    }

    /* 让 sw.js 里"不 await 的 cache.put"落地。 */
    function settle() {
        return new Promise(function(resolve) { setImmediate(resolve); });
    }

    return {
        listeners: listeners,
        calls: calls,
        entries: entries,
        fire: fire,
        intercept: intercept,
        settle: settle,
        resolve: resolve,
        timers: timers
    };
}

function deferred() {
    let resolve, reject;
    const promise = new Promise(function(yes, no) { resolve = yes; reject = no; });
    return { promise, resolve, reject };
}

function navigationRequest(url) {
    return { method: "GET", mode: "navigate", url: url || SCOPE };
}

function assetRequest(url) {
    return { method: "GET", mode: "cors", url: SCOPE + url };
}

function readPrecacheList() {
    const source = fs.readFileSync(SW_FILE, "utf8");
    const block = source.match(/var PRECACHE = \[([\s\S]*?)\];/);
    if (!block) {
        fail("在 dist/pwa/sw.js 里找不到 PRECACHE 清单");
    }
    const urls = [];
    const pattern = /"([^"]+)"/g;
    let match = pattern.exec(block[1]);
    while (match) {
        urls.push(match[1]);
        match = pattern.exec(block[1]);
    }
    return urls;
}

// --------------------------------------------------------------------------
// 1. 装载与预缓存清单
// --------------------------------------------------------------------------

async function checkListenersRegistered() {
    const env = createSandbox();
    ["install", "activate", "message", "fetch"].forEach(function(type) {
        assert.strictEqual(
            typeof env.listeners[type],
            "function",
            "sw.js 没有注册 " + type + " 监听器"
        );
    });
}

async function checkPrecacheListMatchesProducts() {
    const urls = readPrecacheList();
    assert.ok(urls.length > 0, "PRECACHE 清单是空的");
    assert.ok(
        urls.indexOf("./") !== -1,
        "PRECACHE 必须包含 \"./\"：它就是 start_url，主屏图标冷启动请求的正是它"
    );
    // 每一项都要真的存在于 dist 里。"多列一个不存在的文件会留下一条
    // 永远失败的请求"——prepare_pwa.py 也查这个，这里从产物侧再确认一次。
    urls.forEach(function(url) {
        const relative = url.replace(/^\.\//, "");
        const target = relative === "" ? path.join(DIST, "index.html") : path.join(DIST, relative);
        assert.ok(fs.existsSync(target), "PRECACHE 列了 " + url + "，但 " + target + " 不存在");
    });
}

// --------------------------------------------------------------------------
// 2. install：逐个取，失败也要装得上
// --------------------------------------------------------------------------

async function checkInstallPrefillsCache() {
    const env = createSandbox();
    await env.fire("install", {});

    const urls = readPrecacheList();
    assert.strictEqual(
        env.calls.added.length,
        urls.length,
        "install 应该逐项 add，共 " + urls.length + " 次"
    );
    const missing = urls.filter(function(url) {
        return !env.entries.has(env.resolve(url));
    });
    assert.deepStrictEqual(missing, [], "这些预缓存项没有进缓存");

    // "./" 与 "./index.html" 必须解析成不同的键。相同的话导航回退和
    // 冷启动回退会互相冒充。
    assert.notStrictEqual(
        env.resolve("./"),
        env.resolve("./index.html"),
        "\"./\" 和 \"./index.html\" 解析成了同一个 URL"
    );
}

async function checkInstallUsesReloadCacheMode() {
    const env = createSandbox();
    await env.fire("install", {});
    const wrong = env.calls.added.filter(function(entry) { return entry[1] !== "reload"; });
    assert.deepStrictEqual(
        wrong.map(function(entry) { return entry[0]; }),
        [],
        "这些项没有用 cache: \"reload\" 取，会拿到 HTTP 缓存里的旧文件"
    );
}

async function checkPartialPrecacheFailureStillInstalls() {
    // 头图取不到（网络抖动、或者那张图被挪走了）不能导致整个应用装不上。
    const env = createSandbox({
        addFails: function(url) { return url.indexOf("xinsanguo") !== -1; }
    });
    await env.fire("install", {});

    const urls = readPrecacheList();
    assert.strictEqual(
        env.entries.size,
        urls.length - 1,
        "一项失败时，其余项仍然应该装进缓存"
    );
}

async function checkInstallDoesNotDeleteOldCaches() {
    // 装新版本时不能删旧缓存：新版本的预缓存中途失败的话，
    // 用户手里就一个可用版本都没有了。
    const env = createSandbox({ existingCaches: ["what-should-we-eat-shell-OLD"] });
    await env.fire("install", {});
    assert.deepStrictEqual(
        env.calls.deleted,
        [],
        "install 阶段不许删任何缓存"
    );
}

// --------------------------------------------------------------------------
// 3. activate：只清自己的旧缓存，然后接管
// --------------------------------------------------------------------------

async function checkActivateDeletesOnlyOwnOldCaches() {
    const env = createSandbox({
        existingCaches: [
            "what-should-we-eat-shell-OLD",
            "some-other-app-shell-v3",
            "unrelated-cache"
        ]
    });
    await env.fire("install", {});
    const currentName = env.calls.openNames[0];
    await env.fire("activate", {});

    assert.deepStrictEqual(
        env.calls.deleted,
        ["what-should-we-eat-shell-OLD"],
        "activate 只该删自己前缀的旧缓存，别家的一个都不能动"
    );
    assert.ok(
        env.calls.deleted.indexOf(currentName) === -1,
        "activate 把当前正在用的缓存删了"
    );
}

async function checkActivateClaimsClients() {
    const env = createSandbox({ existingCaches: ["what-should-we-eat-shell-OLD"] });
    await env.fire("install", {});
    await env.fire("activate", {});
    assert.strictEqual(env.calls.claimed, 1, "activate 应该调用一次 clients.claim()");
}

async function checkActivateKeepsNewestCache() {
    // 当前版本的缓存名不该被当成"旧缓存"删掉，否则刚装好的东西立刻没了。
    const env = createSandbox({
        existingCaches: ["what-should-we-eat-shell-OLD", "what-should-we-eat-shell-OLDER"]
    });
    await env.fire("install", {});
    const currentName = env.calls.openNames[0];
    await env.fire("activate", {});

    assert.strictEqual(env.calls.deleted.length, 2, "两个旧缓存都应该被清掉");
    assert.ok(
        env.calls.deleted.indexOf(currentName) === -1,
        "当前缓存被删了：装好的版本会立刻失效"
    );
}

// --------------------------------------------------------------------------
// 4. message：只有用户明确要求才跳过等待
// --------------------------------------------------------------------------

async function checkMessageIgnoresUnknownTypes() {
    const env = createSandbox();
    await env.fire("message", { data: { type: "SOMETHING_ELSE" } });
    await env.fire("message", { data: {} });
    await env.fire("message", {});
    assert.strictEqual(
        env.calls.skippedWaiting,
        0,
        "只有 SKIP_WAITING 能触发 skipWaiting()"
    );
}

async function checkMessageSkipsWaitingOnRequest() {
    const env = createSandbox();
    await env.fire("message", { data: { type: "SKIP_WAITING" } });
    assert.strictEqual(env.calls.skippedWaiting, 1, "SKIP_WAITING 应该触发一次 skipWaiting()");
}

async function checkNothingReloadsPagesAutomatically() {
    /*
     * 两条和"不许偷偷换掉用户正在看的页面"直接相关的断言。
     *
     * sw.js 手里不该有刷新/跳转页面的入口：自动接管 + 自动刷新会把用户正在
     * 编辑的历史或别名一起抹掉。刷新由页面在用户点确认之后自己做。
     *
     * clients 用 Proxy 记下被读过的方法名——只看"我给它定义了哪些方法"是
     * 不够的，得看 sw.js **实际用了**哪些。
     */
    const env = createSandbox();
    await env.fire("install", {});
    await env.fire("activate", {});

    assert.deepStrictEqual(
        env.calls.clientsMethods,
        ["claim"],
        "sw.js 只应该用 clients.claim()；出现 navigate()/openWindow() 说明它有能力自己跳转页面"
    );

    // install 和 activate 都不许自己跳过等待：装了新版本要停在 waiting，
    // 等用户在页面上明确点「立即更新」。
    assert.strictEqual(
        env.calls.skippedWaiting,
        0,
        "install/activate 自己调了 skipWaiting()：这会让新版本直接接管正在编辑的页面"
    );
}

// --------------------------------------------------------------------------
// 5. fetch：谁能被接管
// --------------------------------------------------------------------------

async function checkNonGetIsNotIntercepted() {
    const env = createSandbox();
    const taken = await env.intercept({ method: "POST", mode: "cors", url: SCOPE });
    assert.strictEqual(taken, null, "非 GET 请求不该被 Service Worker 接管");
}

async function checkCrossOriginIsNotIntercepted() {
    const env = createSandbox();
    const taken = await env.intercept({
        method: "GET", mode: "cors", url: "https://cdn.example.com/lib.js"
    });
    assert.strictEqual(taken, null, "跨源请求不该被接管");
    assert.deepStrictEqual(env.calls.fetched, [], "跨源请求不该被这个 SW 发出去");
}

// --------------------------------------------------------------------------
// 6. fetch：导航请求
// --------------------------------------------------------------------------

async function checkNavigationPrefersNetwork() {
    const env = createSandbox();
    await env.fire("install", {});
    env.calls.fetched.length = 0;

    const response = await env.intercept(navigationRequest());
    assert.ok(response, "导航请求应该被接管");
    assert.strictEqual(env.calls.fetched.length, 1, "在线时导航应该走网络");
    await env.settle();
    assert.ok(
        env.entries.has(env.resolve("./index.html")),
        "在线拿到的新 index.html 应该写回缓存，供下次离线用"
    );
}

async function checkNavigationFallsBackToCacheWhenOffline() {
    const env = createSandbox({ networkDown: true });
    await env.fire("install", {});
    assert.ok(env.entries.has(env.resolve("./index.html")), "前提：预缓存里有 index.html");

    const response = await env.intercept(navigationRequest());
    assert.ok(response, "断网导航必须被接管并回退，否则用户看到白屏");
    assert.ok(
        String(response.url).indexOf("index.html") !== -1,
        "断网导航回退到的应该是 index.html，实际是 " + response.url
    );
}

async function checkNavigationFallsBackToRootWhenIndexMissing() {
    // 极端情况：index.html 那条预缓存当初失败了，缓存里只有 "./"。
    // 这时候仍然要给出回退，不能因为找不到 index.html 就交出 undefined。
    const env = createSandbox({ networkDown: true });
    const root = env.resolve("./");
    env.entries.set(root, { url: root, body: "root", ok: true, type: "basic" });

    const response = await env.intercept(navigationRequest());
    assert.ok(response, "index.html 缺失时应该回退到 \"./\"，不能交出 undefined");
    assert.strictEqual(response.url, root);
}

/* 网络超时后有缓存就先展示，避免已安装应用无限等待网络。 */
async function checkNavigationFallsBackToCacheOnTimeout() {
    const env = createSandbox({ networkHangs: true });
    await env.fire("install", {});
    assert.ok(env.entries.has(env.resolve("./index.html")), "前提：预缓存里有 index.html");

    const pending = env.intercept(navigationRequest());
    // 网络还挂着，此刻不该有任何结果。
    let resolved = false;
    pending.then(function() { resolved = true; });
    await env.settle();
    assert.strictEqual(resolved, false, "网络没回来之前不该提前 resolve");

    // 超时上限必须是个"用户还能接受"的值。手动时钟会无视 delay 直接触发，
    // 所以这里要单独查：否则把上限改成 999999999（等于没有超时）也照样过。
    const delay = env.timers.lastDelay();
    assert.ok(
        typeof delay === "number" && delay > 0 && delay <= 5000,
        "导航超时上限应该是用户能接受的量级（≤5 秒），实际是 " + delay
        + "；太大等于没有超时，用户仍然要对着白屏等"
    );

    // 时间到 → 超时兜底生效。
    env.timers.fire();
    const response = await pending;
    assert.ok(response, "网络超时时必须交出缓存的外壳，否则用户看到的是白屏");
    assert.ok(
        String(response.url).indexOf("index.html") !== -1,
        "超时回退到的应该是 index.html，实际是 " + response.url
    );
}

async function checkNavigationTimeoutDoesNotFireWhenNetworkWins() {
    // 网络正常时必须用网络的结果（用户要拿到最新 HTML），而且定时器要清掉，
    // 不能留一个 3 秒后触发、把已经 resolve 的东西再 settle 一次的空跑。
    const env = createSandbox();
    await env.fire("install", {});
    env.calls.fetched.length = 0;

    const response = await env.intercept(navigationRequest());
    assert.strictEqual(env.calls.fetched.length, 1, "网络正常时应该走网络");
    assert.ok(response, "网络正常时要有响应");
    assert.strictEqual(
        env.timers.pendingCount(),
        0,
        "网络先成功时应该 clearTimeout，否则每个导航都留一个空转的定时器"
    );
}

async function checkNavigationTimeoutWithEmptyCacheStillWaitsForNetwork() {
    const network = deferred();
    const env = createSandbox({ fetch: function() { return network.promise; } });
    // 故意不 install：没有缓存时超时不能交出 undefined。
    let resolved = false;
    const pending = env.intercept(navigationRequest());
    pending.then(function() { resolved = true; });
    env.timers.fire();
    await env.settle();
    assert.strictEqual(resolved, false, "缓存为空时应继续等待网络");

    network.resolve({ url: SCOPE, ok: false });
    assert.strictEqual((await pending).url, SCOPE, "慢网络最终返回后应完成导航");
    await Promise.all(env.calls.waited);
}

async function checkNavigationTimeoutWriteBackLifetime() {
    const network = deferred();
    const env = createSandbox({ fetch: function() { return network.promise; } });
    await env.fire("install", {});
    const pending = env.intercept(navigationRequest());
    assert.strictEqual(env.calls.waited.length, 1, "须在响应交出前同步注册 waitUntil");
    let backgroundDone = false;
    env.calls.waited[0].then(function() { backgroundDone = true; });
    env.timers.fire();
    assert.strictEqual((await pending).body, "cached");
    assert.strictEqual(backgroundDone, false, "交出缓存后后台请求仍须保持活跃");

    const fresh = { url: SCOPE, ok: true, body: "fresh" };
    network.resolve(Object.assign({}, fresh, { clone: function() { return fresh; } }));
    await Promise.all(env.calls.waited);
    assert.strictEqual(env.entries.get(env.resolve("./index.html")).body, "fresh");
    assert.strictEqual(backgroundDone, true, "回写后才结束后台任务");
}

async function checkNavigationCachedResponseSurvivesLateNetworkFailure() {
    const network = deferred();
    const env = createSandbox({ fetch: function() { return network.promise; } });
    await env.fire("install", {});
    const pending = env.intercept(navigationRequest());
    env.timers.fire();
    assert.strictEqual((await pending).body, "cached");
    network.reject(new TypeError("offline"));
    await Promise.all(env.calls.waited);
    assert.strictEqual(env.entries.get(env.resolve("./index.html")).body, "cached");
}

async function checkNavigationCacheReadFailureStillUsesNetwork() {
    const network = deferred();
    const env = createSandbox({ matchFails: true, fetch: function() { return network.promise; } });
    const pending = env.intercept(navigationRequest());
    env.timers.fire();
    await env.settle();
    network.resolve({ url: SCOPE, ok: false });
    assert.strictEqual((await pending).url, SCOPE, "缓存读取失败不能挂住后续网络响应");
    await Promise.all(env.calls.waited);
}

async function checkNavigationCacheWriteFailureKeepsResponse() {
    const env = createSandbox({ putFails: true });
    const response = await env.intercept(navigationRequest());
    assert.strictEqual(response.url, SCOPE, "缓存写失败不能丢掉在线响应");
    await Promise.all(env.calls.waited);
}

async function checkNavigationOfflineWithoutCacheRejects() {
    const env = createSandbox({ networkDown: true });
    await assert.rejects(env.intercept(navigationRequest()), /Failed to fetch/);
    await Promise.all(env.calls.waited);
    assert.strictEqual(env.timers.pendingCount(), 0);
}

// --------------------------------------------------------------------------
// 7. fetch：普通静态资源
// --------------------------------------------------------------------------

async function checkAssetServedFromCacheWithoutNetwork() {
    const env = createSandbox();
    await env.fire("install", {});
    env.calls.fetched.length = 0;

    const response = await env.intercept(assetRequest("main.css"));
    assert.ok(response, "同源静态资源应该被接管");
    assert.deepStrictEqual(
        env.calls.fetched,
        [],
        "缓存命中时不该再发网络请求（离线可用性就靠这个）"
    );
}

async function checkAssetFetchedAndCachedOnMiss() {
    const env = createSandbox();
    await env.fire("install", {});

    const response = await env.intercept(assetRequest("extra.js"));
    assert.ok(response, "未命中的资源应该走网络");
    await env.settle();
    assert.ok(
        env.entries.has(env.resolve("./extra.js")),
        "成功后应该写入缓存，供下次离线使用"
    );
}

async function checkErrorResponsesAreNotCached() {
    // 把 404/500 存下来会让一次偶发失败变成"永久失败"，刷新也修不好。
    const env = createSandbox({
        responseFor: function() { return { ok: false, status: 500 }; }
    });
    await env.fire("install", {});
    const response = await env.intercept(assetRequest("broken.js"));
    assert.ok(response, "失败的响应仍然要交给页面（让页面自己报错）");
    await env.settle();
    assert.ok(
        !env.entries.has(env.resolve("./broken.js")),
        "错误响应被缓存了：这一次失败会变成永久失败"
    );
}

async function checkNonBasicResponsesAreNotCached() {
    // type 不是 "basic" 说明这是 opaque/跨源重定向之类的响应，
    // 它的内容不可控，存下来只会让缓存里多一份来路不明的东西。
    const env = createSandbox({
        responseFor: function() { return { type: "opaque", ok: true }; }
    });
    await env.fire("install", {});
    await env.intercept(assetRequest("opaque.js"));
    await env.settle();
    assert.ok(
        !env.entries.has(env.resolve("./opaque.js")),
        "非 basic 类型的响应被缓存了"
    );
}

// --------------------------------------------------------------------------
// 8. 产物本身
// --------------------------------------------------------------------------

async function checkVersionFingerprintIsStamped() {
    const source = fs.readFileSync(SW_FILE, "utf8");
    assert.ok(
        source.indexOf("__CACHE_VERSION__") === -1,
        "dist/pwa/sw.js 里还残留 __CACHE_VERSION__ 占位符：缓存名会永远是占位符本身，" +
        "每次发布都不更新，而且不会有任何报错"
    );

    // 不去正则匹配源码里的拼接表达式（`CACHE_PREFIX + "shell-" + VERSION`），
    // 而是问运行中的 sw.js 它到底开了哪个缓存——那才是浏览器看到的名字。
    // 匹配源码的话，改动拼接方式就会让测试失败，而缓存名其实没问题。
    const env = createSandbox();
    await env.fire("install", {});
    assert.strictEqual(env.calls.openNames.length, 1, "install 应该只开一个缓存");
    assert.match(
        env.calls.openNames[0],
        /^what-should-we-eat-shell-[0-9a-f]{12}$/,
        "缓存名应该是「应用前缀 + shell- + 12 位内容指纹」，实际是 " + env.calls.openNames[0]
    );
}

async function checkCacheNameCarriesAppPrefix() {
    // 前缀保证清理时不会误删同一个 origin 下别的应用的缓存。
    const env = createSandbox();
    await env.fire("install", {});
    assert.strictEqual(env.calls.openNames.length, 1, "install 应该只开一个缓存");
    assert.match(
        env.calls.openNames[0],
        /^what-should-we-eat-/,
        "缓存名缺少应用前缀：" + env.calls.openNames[0]
    );
}

// --------------------------------------------------------------------------
// 运行
// --------------------------------------------------------------------------

async function main() {
    if (!fs.existsSync(SW_FILE)) {
        fail("找不到 " + SW_FILE + "。先运行：python3 tools/prepare_pwa.py");
    }

    await test("1. sw.js 注册了 install/activate/message/fetch 四个监听器", checkListenersRegistered);
    await test("2. PRECACHE 清单里每一项都真实存在于 dist/pwa", checkPrecacheListMatchesProducts);
    await test("3. install 把预缓存清单逐项写进缓存", checkInstallPrefillsCache);
    await test("4. install 每一项都用 cache: \"reload\" 取", checkInstallUsesReloadCacheMode);
    await test("5. 某一项预缓存失败时，安装仍然成功", checkPartialPrecacheFailureStillInstalls);
    await test("6. install 阶段不删任何旧缓存", checkInstallDoesNotDeleteOldCaches);
    await test("7. activate 只删自己前缀的旧缓存", checkActivateDeletesOnlyOwnOldCaches);
    await test("8. activate 保留当前正在用的缓存", checkActivateKeepsNewestCache);
    await test("9. activate 调用 clients.claim()", checkActivateClaimsClients);
    await test("10. 非 SKIP_WAITING 消息不触发 skipWaiting()", checkMessageIgnoresUnknownTypes);
    await test("11. SKIP_WAITING 触发一次 skipWaiting()", checkMessageSkipsWaitingOnRequest);
    await test("12. 没有任何会自己刷新页面的入口", checkNothingReloadsPagesAutomatically);
    await test("13. 非 GET 请求不被接管", checkNonGetIsNotIntercepted);
    await test("14. 跨源请求不被接管", checkCrossOriginIsNotIntercepted);
    await test("15. 导航在线时走网络并回写缓存", checkNavigationPrefersNetwork);
    await test("16. 导航断网时回退到缓存的 index.html", checkNavigationFallsBackToCacheWhenOffline);
    await test("17. index.html 缺失时回退到 \"./\"", checkNavigationFallsBackToRootWhenIndexMissing);
    await test("18. 网络超时时导航回退到缓存外壳（不等白屏）", checkNavigationFallsBackToCacheOnTimeout);
    await test("19. 网络先成功时不触发超时，且定时器被清掉", checkNavigationTimeoutDoesNotFireWhenNetworkWins);
    await test("20. 缓存为空时超时不 resolve undefined（继续等网络）", checkNavigationTimeoutWithEmptyCacheStillWaitsForNetwork);
    await test("21. 静态资源缓存命中时不发网络请求", checkAssetServedFromCacheWithoutNetwork);
    await test("22. 静态资源未命中时取网络并写入缓存", checkAssetFetchedAndCachedOnMiss);
    await test("23. 错误响应不被缓存", checkErrorResponsesAreNotCached);
    await test("24. 非 basic 响应不被缓存", checkNonBasicResponsesAreNotCached);
    await test("25. 产物里的缓存版本已替换成内容指纹", checkVersionFingerprintIsStamped);
    await test("26. 缓存名带应用前缀", checkCacheNameCarriesAppPrefix);
    await test("27. 超时后 waitUntil 保持后台网络及缓存回写", checkNavigationTimeoutWriteBackLifetime);
    await test("28. 超时回退后网络才失败不破坏缓存响应", checkNavigationCachedResponseSurvivesLateNetworkFailure);
    await test("29. 缓存读失败仍等待可用网络", checkNavigationCacheReadFailureStillUsesNetwork);
    await test("30. 缓存写失败不丢掉在线响应", checkNavigationCacheWriteFailureKeepsResponse);
    await test("31. 无缓存且断网时明确拒绝而非挂住", checkNavigationOfflineWithoutCacheRejects);

    console.log("");
    if (failures.length) {
        console.log(failures.length + " 个用例失败，共 " + checks + " 个通过");
        process.exitCode = 1;
    } else {
        console.log("ok   - Service Worker 测试全部通过（" + checks + " 个用例）");
    }
}

main().catch(function(error) {
    console.log("测试自身崩溃：" + (error && error.stack ? error.stack : error));
    process.exitCode = 1;
});
