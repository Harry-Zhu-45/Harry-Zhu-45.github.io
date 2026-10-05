"use strict";

/*
 * 启动引导：注册 Service Worker、把"离线可用"和"有新版本"告诉用户。
 *
 * 这个文件在 index.js **之后**加载：
 *   - AppApi 已经由 api-local.js 装好，页面能立刻开始读数据，不必等 SW；
 *   - 注册失败或浏览器不支持 SW 都不影响应用本身能用（只是不能离线、
 *     不能装到桌面），所以这里所有错误都是"提示"而不是"拦截"。
 *
 * 更新提示的取舍：新版本装好后会停在 waiting，不自动刷新。用户可能正在
 * 编辑历史记录，自动接管 + 刷新会把没保存的输入一起抹掉。所以这里弹一条
 * 可关闭的提示，用户点"立即更新"才 skipWaiting + reload。
 */
(function(root) {
    if (!root || typeof root.document === "undefined") {
        return;
    }
    var document = root.document;

    var BANNER_ID = "pwa-update-banner";

    function isSecureContext() {
        // SW 只在安全上下文里可用：HTTPS 或 localhost。
        // 手机连电脑的 http://192.168.x.x:8080 不算，localStorage/IndexedDB
        // 能用但装不了、也离线不了。这里明确区分，免得用户以为是代码坏了。
        return root.isSecureContext === true
            || root.location.protocol === "https:"
            || root.location.hostname === "localhost"
            || root.location.hostname === "127.0.0.1"
            || root.location.hostname === "::1";
    }

    function removeBanner() {
        var existing = document.getElementById(BANNER_ID);
        if (existing && existing.parentNode) {
            existing.parentNode.removeChild(existing);
        }
    }

    /*
     * 顶部更新提示条。用 DOM API 拼，不用 innerHTML：
     * 这个应用全程避免拼接 HTML，SW 的版本号也一样按文本插入。
     */
    function showUpdateBanner(onAccept) {
        removeBanner();
        var banner = document.createElement("div");
        banner.id = BANNER_ID;
        banner.className = "pwa-update-banner";
        banner.setAttribute("role", "status");

        var text = document.createElement("span");
        text.textContent = "有新版本可用。";
        banner.appendChild(text);

        var accept = document.createElement("button");
        accept.type = "button";
        accept.textContent = "立即更新";
        accept.addEventListener("click", function() {
            accept.disabled = true;
            onAccept();
        });
        banner.appendChild(accept);

        var dismiss = document.createElement("button");
        dismiss.type = "button";
        dismiss.className = "pwa-update-dismiss";
        dismiss.textContent = "稍后";
        dismiss.addEventListener("click", removeBanner);
        banner.appendChild(dismiss);

        document.body.appendChild(banner);
    }

    function watchForUpdates(registration) {
        // 已经有一个装在 waiting 的版本（上次打开时下载好、用户没点更新）。
        if (registration.waiting) {
            showUpdateBanner(function() {
                activateWaiting(registration);
            });
        }

        registration.addEventListener("updatefound", function() {
            var installing = registration.installing;
            if (!installing) {
                return;
            }
            installing.addEventListener("statechange", function() {
                // 只有在"已经有一个受控页面"时才提示：首次安装时
                // installing -> installed 是正常的准备好，不是"新版本"。
                if (installing.state === "installed" && root.navigator.serviceWorker.controller) {
                    showUpdateBanner(function() {
                        activateWaiting(registration);
                    });
                }
            });
        });
    }

    function activateWaiting(registration) {
        var waiting = registration.waiting;
        if (!waiting) {
            // 没有等待中的 worker：直接刷新拿最新页面。
            root.location.reload();
            return;
        }
        // 只在新 SW 真正接管之后刷新。先刷新的话页面还是旧 SW 在管，
        // 刷新完仍然是旧页面，用户会以为"点了没用"。
        root.navigator.serviceWorker.addEventListener("controllerchange", function() {
            root.location.reload();
        });
        waiting.postMessage({ type: "SKIP_WAITING" });
    }

    function register() {
        if (!("serviceWorker" in root.navigator)) {
            return;
        }
        if (!isSecureContext()) {
            // 明文 HTTP 下注册会直接抛错。这里不弹东西吓用户：
            // 应用照常能用，只是装不了、离线不了。
            return;
        }

        // scope 用 "./"：部署到子路径（比如 GitHub Pages 的 /repo/）时，
        // 绝对路径 "/sw.js" 会 404，或者把作用域扩到整个域名。
        root.navigator.serviceWorker.register("./sw.js", { scope: "./" })
            .then(function(registration) {
                watchForUpdates(registration);
            })
            .catch(function() {
                // 注册失败不影响使用：只是没有离线能力。
                // 常见原因是托管平台不允许 SW 脚本被缓存，或 scope 不匹配。
                return null;
            });
    }

    /*
     * 离线就绪提示。只在"用户本来就装了它"的前提下才有意义——
     * 一个没用过离线功能的人看到"可以离线使用"只会困惑，
     * 所以这里什么都不弹，把能力安静地准备好。
     */
    function reportOfflineReady() {
        if (root.navigator.onLine === false) {
            document.documentElement.classList.add("pwa-offline");
        }
        root.addEventListener("online", function() {
            document.documentElement.classList.remove("pwa-offline");
        });
        root.addEventListener("offline", function() {
            document.documentElement.classList.add("pwa-offline");
        });
    }

    /*
     * 申请持久化以减少浏览器因存储压力回收数据的风险。不等待结果，也不阻止启动。
     * 浏览器可能拒绝或显示权限提示；获批仍不能防止用户清理站点数据、卸载浏览器
     * 或设备故障，所以 JSON 备份仍然必要。
     */
    function requestPersistentStorage() {
        try {
            if (!isSecureContext() || !root.navigator || !root.navigator.storage
                || typeof root.navigator.storage.persist !== "function") {
                // persist() 只在安全上下文里存在，明文 HTTP 下根本拿不到这个函数。
                // 拿不到就算了，不影响任何功能。
                return;
            }
            // 故意不 await：能不能拿到持久化不影响页面能不能用，
            // 启动流程没有理由等它。
            root.navigator.storage.persist().then(function(granted) {
                if (root.console && root.console.log) {
                    root.console.log(granted
                        ? "持久化存储已获批；仍请定期导出 JSON 备份。"
                        : "存储为 best-effort：空间紧张时浏览器可能清除数据，请定期导出备份。");
                }
            }).catch(function() {
                // 浏览器拒绝或直接抛错都无所谓。
                return null;
            });
        } catch (error) {
            // 有的实现在非安全上下文里不是"没有这个方法"而是直接抛 TypeError。
            return;
        }
    }

    function start() {
        requestPersistentStorage();
        reportOfflineReady();
        register();
    }

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", start);
    } else {
        start();
    }
}(typeof window === "undefined" ? null : window));
