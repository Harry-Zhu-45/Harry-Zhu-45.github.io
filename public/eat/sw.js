"use strict";

/*
 * Service Worker：让应用能装到桌面、断网也能打开。
 *
 * 边界先说清楚，这层只做两件事：
 *   1. 预缓存"应用外壳"（HTML/CSS/JS/图标/字体/头图）——这些都是可重新下载的
 *      静态资源，丢了不会有数据损失。
 *   2. 把同源的 GET 请求按"导航请求走 HTML、其余走缓存优先"分派。
 *
 * 它**不碰业务数据**。候选项和历史在 IndexedDB 里，由 database.js 负责；
 * Service Worker 里再存一份就是第二个事实来源，两边一旦不一致，用户看到的
 * 到底是哪一份全凭运气。所以这里没有、也不要加任何数据缓存的代码。
 *
 * 更新策略（关键是"不要偷偷换掉用户正在看的页面"）：
 *   - 装好新版本后停在 waiting，不调 skipWaiting()。用户可能正开着编辑器打字，
 *     自动接管并刷新会把没提交的内容一起抹掉。
 *   - 页面通过 postMessage({type: "SKIP_WAITING"}) 明确要求时才跳过等待，
 *     而且刷新由页面自己做（bootstrap.js 弹提示、用户点确认）。
 *   - 安装新版本时**不删**旧缓存。删了之后如果新版本的预缓存中途失败，
 *     用户手里就一个可用版本都没有了；旧缓存在 activate 时才清。
 */

/*
 * 缓存名里的版本。060f68f97127 由 tools/prepare_pwa.py 在打包时替换成
 * 产物内容的指纹（除 sw.js 自身外的全部文件）。
 *
 * 为什么不是手写的 "v1"：手工版本号是"用户永远看到旧页面"的经典成因——改了 JS
 * 却忘了把 v1 改成 v2，Service Worker 就认为缓存还是最新的，所有人继续拿旧文件，
 * 而且没有任何报错。用内容指纹之后，"改了东西"和"缓存名变了"是同一件事，
 * 忘了改版本这件事本身就不存在了。
 *
 * 指纹变了之后的流程是：浏览器发现 sw.js 变了 -> 装新版本 -> 停在 waiting ->
 * bootstrap.js 弹提示 -> 用户点「立即更新」-> 跳过等待 -> 刷新拿到新文件。
 */
var VERSION = "060f68f97127";
// 缓存名带应用前缀：同一个 origin 上还可能有别的页面（比如桌面版被一起
// 部署到根目录），前缀能保证清理时不会误删别人的缓存。
var CACHE_PREFIX = "what-should-we-eat-";
var CACHE_NAME = CACHE_PREFIX + "shell-" + VERSION;

/* 网络优先，但慢网时最多等待 3 秒后尝试缓存；没有缓存则继续等待网络。 */
var NAVIGATION_TIMEOUT_MS = 3000;

/*
 * 缓存里的页面外壳。先找 index.html，再退到 "./"——两者在缓存里是不同的键，
 * 而 "./" 是 start_url，冷启动请求的就是它。任何一个都没有时返回 undefined，
 * 由调用方决定怎么办（超时分支要继续等网络，断网分支只能认了）。
 */
function cachedShell() {
    return caches.match(new Request("./index.html")).then(function(cached) {
        return cached || caches.match(new Request("./"));
    });
}

/*
 * 预缓存清单。
 *
 * "./" 必须留：它就是 start_url，用户从主屏图标冷启动时请求的正是它，
 * 缺了这一条离线冷启动会白屏（导航请求落到网络，断网就失败）。
 * tools/prepare_pwa.py 会拿这份清单和 dist 里的实际产物做一致性校验，
 * 少了哪个文件就在构建阶段报错——比装到手机上才发现打不开要便宜得多。
 */
var PRECACHE = [
    "./",
    "./index.html",
    "./main.css",
    "./pwa.css",
    "./search.js",
    "./casefold.js",
    "./validation.js",
    "./store.js",
    "./database.js",
    "./api-local.js",
    "./pwa-text.js",
    "./index.js",
    "./bootstrap.js",
    "./manifest.webmanifest",
    "./icons/icon-192.png",
    "./icons/icon-512.png",
    "./icons/icon-maskable-512.png",
    "./images/xinsanguo-csm-1920.jpg"
];

self.addEventListener("install", function(event) {
    event.waitUntil(
        caches.open(CACHE_NAME).then(function(cache) {
            /*
             * 逐个 add 而不是 addAll：addAll 是原子的，任何一条失败（比如头图
             * 一时超时）整个安装就失败，用户拿到的是一个装不上的应用。逐个 add
             * 至少能装上一个"少了某张图"的可用版本，缺的那张按需再取。
             */
            return Promise.all(PRECACHE.map(function(url) {
                return cache.add(new Request(url, { cache: "reload" })).catch(function() {
                    return null;
                });
            }));
        })
    );
});

self.addEventListener("activate", function(event) {
    event.waitUntil(
        caches.keys().then(function(names) {
            // 只清自己的旧缓存：别的前缀（同 origin 下别的应用）不动。
            return Promise.all(names.map(function(name) {
                if (name.indexOf(CACHE_PREFIX) === 0 && name !== CACHE_NAME) {
                    return caches.delete(name);
                }
                return null;
            }));
        }).then(function() {
            // 让浏览器把新 SW 立刻用于后续导航（已经打开的页面不受影响，
            // 它们仍然归旧 SW 管，直到用户确认刷新）。
            return self.clients.claim();
        })
    );
});

self.addEventListener("message", function(event) {
    var data = event.data || {};
    if (data.type !== "SKIP_WAITING") {
        return;
    }
    // 只有页面明确要求才跳过等待。这里不刷新任何页面：刷新由页面在用户
    // 点确认之后自己做，这样"正在编辑的东西会不会丢"由用户决定。
    self.skipWaiting();
});

self.addEventListener("fetch", function(event) {
    var request = event.request;
    if (request.method !== "GET") {
        return;
    }

    var url;
    try {
        url = new URL(request.url);
    } catch (error) {
        return;
    }
    // 跨源请求一律不接管。这个应用本来就不依赖 CDN，
    // 缓存别人的响应只会让调试变得莫名其妙。
    if (url.origin !== self.location.origin) {
        return;
    }

    if (request.mode === "navigate") {
        var network = fetch(request);
        // 超时交出缓存后，仍需让 SW 活到网络请求和缓存回写完成。
        // waitUntil 同步注册，不能等 respondWith 的响应已经交出后才补。
        event.waitUntil(network.then(function(response) {
            if (response && response.ok) {
                var copy = response.clone();
                return caches.open(CACHE_NAME).then(function(cache) {
                    return cache.put(new Request("./index.html"), copy);
                });
            }
            return null;
        }).catch(function() {
            // 缓存写入失败不应丢掉一个本来可用的网络响应。
            return null;
        }));

        var timer;
        var timeout = new Promise(function(resolve) {
            timer = setTimeout(function() { resolve(null); }, NAVIGATION_TIMEOUT_MS);
        });
        event.respondWith(Promise.race([
            network.catch(function() { return null; }),
            timeout
        ]).then(function(response) {
            clearTimeout(timer);
            if (response) {
                return response;
            }
            return cachedShell().catch(function() {
                return null;
            }).then(function(cached) {
                // 缓存缺失或读取失败时继续等网络；网络也失败则如实拒绝响应。
                return cached || network;
            });
        }));
        return;
    }

    /*
     * 其余同源 GET：缓存优先。
     *
     * 资源名里没有指纹（没有构建步骤，文件名固定），所以"缓存优先"意味着
     * 用户不会在一次导航里就拿到新文件——新版本要靠新 SW 的 install 把预缓存
     * 清单用 cache: "reload" 整个重取一遍，才进到新缓存里。
     *
     * 版本不需要手工维护：CACHE_NAME 里的 VERSION 由 tools/prepare_pwa.py
     * 盖成产物指纹（见文件开头）。任何一个页面资源改了，指纹就变，缓存名跟着变，
     * 新 SW 写进的是全新一份缓存——所以"新文件一直进不来"没有发生的余地。
     *
     * 只改 sw.js 自身时指纹不变（它被排除在指纹之外），但浏览器仍然会因为
     * sw.js 的字节变了而安装新版本，上面的 install 照样会把清单重取一遍。
     */
    event.respondWith(
        caches.match(request).then(function(cached) {
            if (cached) {
                return cached;
            }
            return fetch(request).then(function(response) {
                // 只缓存成功的同源响应：把 404/500 存下来会让一次偶发失败
                // 变成"永久失败"，刷新也修不好。
                if (response && response.ok && response.type === "basic") {
                    var copy = response.clone();
                    caches.open(CACHE_NAME).then(function(cache) {
                        cache.put(request, copy);
                    });
                }
                return response;
            });
        })
    );
});
