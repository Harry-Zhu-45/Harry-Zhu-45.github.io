"use strict";

/*
 * PWA 版对 index.js 文案的覆盖。
 *
 * index.js 里有几处文案写的是桌面版的运行方式——"无法连接本地服务"
 * "本机 SQLite""请检查 data/backups 目录权限"。手机上没有本地服务、
 * 没有 SQLite 文件、也没有 data/backups 目录，照搬只会让用户以为
 * 是电脑没开机、然后去改一个根本不存在的目录权限。
 *
 * 做法是让 index.js 用一张可覆盖的文案表（window.AppText），默认值仍是
 * 桌面版原文（`tests/test_render.js` 断言的就是默认那套）。这个文件在
 * index.js 之前加载，整组替换成手机上的说法。
 *
 * 只放"和运行环境有关"的文案。业务文案（"不能添加重复的食物"、
 * "只能编辑最近 5 天（含今天）的历史记录"）两边完全一样，不许在这里分叉：
 * 一旦分叉，同一个操作在电脑和手机上会给出不同的解释。
 */
(function(root) {
    if (!root) {
        return;
    }
    root.AppText = {
        // 数据在手机本地，没有"服务"可连；失败原因通常是浏览器存储被禁用
        // 或配额用尽，所以这里指向重试按钮而不是让人去启动 server.py。
        unavailable: "本地数据没有加载成功，请点「重试」再试一次。",
        reconnected: "数据已重新加载",
        clearHistoryConfirm: "将永久删除手机上的全部历史记录，且无法撤销。建议先导出备份。确定继续吗？",
        clearedWithSnapshot: function(snapshotAt) {
            return "历史记录已清空，清空前的数据已在手机上留了一份副本（" + snapshotAt + "）";
        },
        // 桌面版这里说的是目录权限；手机上没有目录可查，失败只可能是
        // 存储被禁用或写不进去。
        clearedWithoutSnapshot: "历史记录已清空（未能留下副本，浏览器存储可能不可用）",
        replaceWarning: "注意：未能留下副本，浏览器存储可能不可用",
        // 数据备份页那句说明（index.html 里由 prepare 脚本换 id，见下）。
        storageNote: "数据保存在这台手机浏览器里，可导出 JSON 文件进行备份或迁移。"
    };
}(typeof window === "undefined" ? null : window));
