"use strict";

/*
 * 极简 DOM 桩：给 tests/test_pwa_integration.js 用。
 *
 * `index.js` 在**加载时**就 `document.getElementById(...)` 一堆元素，
 * 所以想把它装进 node 跑就必须先有一个 DOM。`tests/test_render.js` 里有一份
 * 同样用途的实现，那份是配合它的 `createHarness()` 写的（它自己造 AppApi、
 * 自己维护状态）。这个文件提供的是"只有 DOM、没有 AppApi"的版本，让调用方
 * 能装载 PWA 那一整套真实模块。
 *
 * 能力和契约跟 test_render.js 的桩保持一致（含 focus 与 document.activeElement
 * 的互斥语义、replaceChildren 摘掉旧子节点），改这里时要两个测试一起想。
 */

class FakeClassList {
    constructor() {
        this.values = new Set();
    }
    add(...names) {
        names.forEach((name) => this.values.add(name));
    }
    remove(...names) {
        names.forEach((name) => this.values.delete(name));
    }
    toggle(name, force) {
        if (force) {
            this.values.add(name);
        } else {
            this.values.delete(name);
        }
    }
    contains(name) {
        return this.values.has(name);
    }
}

class FakeElement {
    constructor(tagName) {
        this.tagName = String(tagName).toUpperCase();
        this.children = [];
        this.parentElement = null;
        this.classList = new FakeClassList();
        this.dataset = {};
        this.attributes = {};
        this.listeners = {};
        this.style = {};
        this.textContent = "";
        this.value = "";
        this.hidden = false;
        this.disabled = false;
        this.checked = false;
        this.focused = false;
        this.files = null;
        this.scrolledIntoView = false;
    }

    appendChild(child) {
        child.parentElement = this;
        this.children.push(child);
        return child;
    }

    replaceChildren(...nodes) {
        // 真实 DOM 会把被移除的子节点从文档里摘掉（parentElement 变 null）。
        // 桩也要这么做，否则"元素还在文档里"的判断会失真。
        this.children.forEach((child) => {
            child.parentElement = null;
        });
        this.children = [];
        nodes.forEach((node) => this.appendChild(node));
    }

    setAttribute(name, value) {
        this.attributes[name] = String(value);
    }

    getAttribute(name) {
        return this.attributes[name];
    }

    removeAttribute(name) {
        delete this.attributes[name];
    }

    contains(node) {
        if (!node) {
            return false;
        }
        return this.descendants().includes(node);
    }

    addEventListener(type, handler) {
        (this.listeners[type] = this.listeners[type] || []).push(handler);
    }

    dispatch(type, event) {
        (this.listeners[type] || []).forEach((handler) => handler(event || {}));
    }

    focus() {
        this.focused = true;
        // 焦点是"当前文档里只有一个元素持有"的东西：桩里也照这个语义维护，
        // 否则 index.js 里 document.activeElement 的判断测不出来。
        if (this.ownerDocument) {
            if (this.ownerDocument.activeElement
                && this.ownerDocument.activeElement !== this) {
                this.ownerDocument.activeElement.focused = false;
            }
            this.ownerDocument.activeElement = this;
        }
    }

    scrollIntoView() {
        this.scrolledIntoView = true;
    }

    click() {
        this.dispatch("click");
    }

    remove() {
        if (!this.parentElement) {
            return;
        }
        const index = this.parentElement.children.indexOf(this);
        if (index >= 0) {
            this.parentElement.children.splice(index, 1);
        }
        this.parentElement = null;
    }

    closest(selector) {
        let node = this.parentElement;
        while (node) {
            if (node.matches(selector)) {
                return node;
            }
            node = node.parentElement;
        }
        return null;
    }

    matches(selector) {
        if (selector.charAt(0) === ".") {
            return this.classList.contains(selector.slice(1));
        }
        return selector === this.tagName.toLowerCase();
    }

    querySelector(selector) {
        // 只实现 index.js 用到的那几种选择器。
        const match = selector.match(
            /^input\[data-choice-id="([^"]+)"\]\[data-meta-kind="([^"]+)"\]$/
        );
        if (match) {
            return this.descendants().find(
                (node) =>
                    node.tagName === "INPUT"
                    && String(node.dataset.choiceId) === match[1]
                    && node.dataset.metaKind === match[2]
            ) || null;
        }
        const byClass = selector.match(/^\.([A-Za-z0-9_-]+)$/);
        if (byClass) {
            return this.descendants().find(
                (node) => node.classList.contains(byClass[1])
            ) || null;
        }
        return null;
    }

    descendants() {
        const found = [];
        this.children.forEach((child) => {
            found.push(child);
            found.push(...child.descendants());
        });
        return found;
    }

    text() {
        const own = typeof this.textContent === "string" ? this.textContent : "";
        return own + this.children.map((child) => child.text()).join("");
    }
}

// index.html 里 index.js 会按 id 取的全部元素。少一个就是 `null.xxx` 崩溃，
// 所以这份清单要跟着 index.html 更新。
const ELEMENT_IDS = [
    "user-food-choice", "display-food-choice", "form-error", "choice-form-error",
    "app-status", "retry-load-btn", "food-choice", "selection-actions",
    "food-search-input", "food-search-results", "random-choice-btn",
    "add-food-choice-btn", "confirm-choice-btn", "cancel-choice-btn",
    "choice-filter-input", "choice-filter-note",
    "food-history", "clear-history-btn", "total-count", "unique-count",
    "food-ranking", "ranking-note", "trend-summary", "export-data-btn",
    "import-file-input", "import-preview", "import-summary",
    "merge-import-btn", "replace-import-btn"
];

/*
 * 造一份 DOM。返回 `{document, elements, rankingFilters, settle}`。
 *
 * `querySelectorAll` 只支持 index.js 真正用的那三个类名选择器；其余返回空数组
 * （和 test_render.js 一样的取舍：桩按契约实现，不试图通用）。
 */
function createDom() {
    const elements = new Map();

    const rankingFilters = [10, 20, 0].map((limit) => {
        const button = new FakeElement("button");
        button.classList.add("ranking-filter");
        button.dataset.limit = limit;
        return button;
    });

    // 导航按钮和视图：index.js 用它们做 showView()。给两组就够它跑通。
    const navButtons = ["home-view", "choices-view", "history-view"].map((view) => {
        const button = new FakeElement("button");
        button.classList.add("nav-button");
        button.dataset.view = view;
        return button;
    });
    const appViews = ["home-view", "choices-view", "history-view"].map((id) => {
        const view = new FakeElement("section");
        view.id = id;
        view.classList.add("app-view");
        return view;
    });

    const document = {
        getElementById(id) {
            if (!elements.has(id)) {
                const element = new FakeElement("div");
                element.ownerDocument = document;
                elements.set(id, element);
            }
            return elements.get(id);
        },
        createElement(tagName) {
            const element = new FakeElement(tagName);
            element.ownerDocument = document;
            return element;
        },
        createTextNode(text) {
            const node = new FakeElement("text");
            node.textContent = text;
            return node;
        },
        querySelectorAll(selector) {
            if (selector === ".ranking-filter") {
                return rankingFilters;
            }
            if (selector === ".nav-button") {
                return navButtons;
            }
            if (selector === ".app-view") {
                return appViews;
            }
            return [];
        },
        activeElement: null,
        body: new FakeElement("body"),
        documentElement: new FakeElement("html"),
        readyState: "complete",
        addEventListener() {}
    };

    ELEMENT_IDS.forEach((id) => document.getElementById(id));
    document.body.ownerDocument = document;

    /*
     * 等 index.js 的异步初始化跑完。
     *
     * 它是一串 async/await（initialize -> 渲染 -> 可能还有后续请求），
     * 单等一个 microtask 不够：每一层 await 都要过一次微任务队列，
     * 中间还夹着 IndexedDB 桩自己的异步派发。跑若干轮宏任务最稳，
     * 也不会掩盖"某个 Promise 永远不 settle"的问题（那样断言会失败）。
     */
    async function settle(rounds = 10) {
        for (let index = 0; index < rounds; index += 1) {
            await new Promise((resolve) => setTimeout(resolve, 0));
        }
    }

    return {
        document,
        elements,
        rankingFilters,
        navButtons,
        appViews,
        settle,
        element: (id) => document.getElementById(id)
    };
}

module.exports = { FakeElement, FakeClassList, createDom, ELEMENT_IDS };
