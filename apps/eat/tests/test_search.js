"use strict";

/*
 * 搜索纯函数的回归测试：node tests/test_search.js
 *
 * 项目没有前端测试框架（也不引入），所以用 node 自带的 assert 直接跑。
 * 覆盖的是「KFC 搜不到肯德基」这类行为：别名、标签、AND→OR 兜底。
 */

const assert = require("assert");
const search = require("../search.js");

const CHOICES = [
    { id: 1, name: "肯德基", aliases: [{ id: 11, alias: "KFC" }], tags: [{ id: 21, tag: "快餐" }] },
    { id: 2, name: "麦当劳", aliases: [{ id: 12, alias: "McDonalds" }], tags: [{ id: 22, tag: "快餐" }] },
    { id: 3, name: "中百罗森", aliases: [{ id: 13, alias: "Lawson" }], tags: [] },
    { id: 4, name: "重庆小面", aliases: [], tags: [{ id: 23, tag: "面" }] },
    { id: 5, name: "怪味面", aliases: [], tags: [{ id: 24, tag: "面" }] },
    { id: 6, name: "米饭", aliases: [], tags: [] },
    { id: 7, name: "鸡蛋灌饼", aliases: [], tags: [] },
    { id: 8, name: "梅园食堂", aliases: [], tags: [{ id: 25, tag: "食堂" }] }
];

function names(result) {
    return result.matches.map(function(match) {
        return match.choice.name;
    });
}

function searchIn(query, choices) {
    return search.searchChoices(choices || CHOICES, query);
}

const cases = [];

function test(name, body) {
    cases.push([name, body]);
}

test("别名命中：KFC 找到肯德基", function() {
    const result = searchIn("KFC");
    assert.deepStrictEqual(names(result), ["肯德基"]);
    assert.strictEqual(result.partial, false);
});

test("别名命中不区分大小写", function() {
    assert.deepStrictEqual(names(searchIn("kfc")), ["肯德基"]);
    assert.deepStrictEqual(names(searchIn("lawson")), ["中百罗森"]);
});

test("标签命中：搜「快餐」拿到所有打过该标签的候选项", function() {
    assert.deepStrictEqual(names(searchIn("快餐")), ["肯德基", "麦当劳"]);
});

test("标签命中：搜「食堂」拿到食堂", function() {
    assert.deepStrictEqual(names(searchIn("食堂")), ["梅园食堂"]);
});

test("名字命中仍然优先于标签命中", function() {
    const choices = [
        { id: 1, name: "米饭", aliases: [], tags: [{ id: 1, tag: "面" }] },
        { id: 2, name: "面", aliases: [], tags: [] }
    ];
    assert.deepStrictEqual(names(searchIn("面", choices)), ["面", "米饭"]);
});

test("名字子串命中也要压过标签精确命中", function() {
    // 回归：字段层级不加成时，tag.exact(700) 会压过 name.substring(500)，
    // 搜「面」会先出挂「面」标签的米饭。
    const choices = [
        { id: 1, name: "米饭", aliases: [], tags: [{ id: 1, tag: "面" }] },
        { id: 2, name: "重庆小面", aliases: [], tags: [] },
        { id: 3, name: "怪味面", aliases: [], tags: [] }
    ];
    assert.deepStrictEqual(names(searchIn("面", choices)), ["重庆小面", "怪味面", "米饭"]);
});

test("别名命中要排在标签命中前面", function() {
    const choices = [
        { id: 1, name: "甲", aliases: [], tags: [{ id: 1, tag: "快餐" }] },
        { id: 2, name: "乙", aliases: [{ id: 2, alias: "快餐店" }], tags: [] }
    ];
    assert.deepStrictEqual(names(searchIn("快餐", choices)), ["乙", "甲"]);
});

test("名字子串仍然可用（回归：原来的行为不能丢）", function() {
    assert.deepStrictEqual(names(searchIn("灌饼")), ["鸡蛋灌饼"]);
    assert.deepStrictEqual(names(searchIn("罗森")), ["中百罗森"]);
});

test("应用词典和英文复数展开仍然可用", function() {
    assert.deepStrictEqual(names(searchIn("noodle")), ["重庆小面", "怪味面"]);
    assert.deepStrictEqual(names(searchIn("eggs")), ["鸡蛋灌饼"]);
});

test("多个关键词按 AND 匹配", function() {
    const result = searchIn("重庆 小面");
    assert.deepStrictEqual(names(result), ["重庆小面"]);
    assert.strictEqual(result.partial, false);
});

test("AND 全部落空时回退到 OR，并标记 partial", function() {
    const result = searchIn("kfc 面");
    assert.strictEqual(result.partial, true);
    // OR 结果仍按字段层级排序：名字命中排在别名命中前面。
    assert.deepStrictEqual(names(result), ["重庆小面", "怪味面", "肯德基"]);
});

test("单个中文词不会因为被拆成字而回退 OR", function() {
    // 回归：搜「水产」不该因为拆出「水」而命中「喜家德水饺」。
    const choices = [{ id: 1, name: "喜家德水饺", aliases: [], tags: [] }];
    const result = searchIn("水产", choices);
    assert.deepStrictEqual(names(result), []);
    assert.strictEqual(result.partial, false);
});

test("单个中文词仍然按拆字做 AND 匹配", function() {
    const choices = [{ id: 1, name: "重庆小面", aliases: [], tags: [] }];
    assert.deepStrictEqual(names(searchIn("重庆小面", choices)), ["重庆小面"]);
    assert.deepStrictEqual(names(searchIn("庆小", choices)), ["重庆小面"]);
});

test("只要有一个关键词命中就不算 partial（AND 成功时）", function() {
    assert.strictEqual(searchIn("重庆 小面").partial, false);
});

test("空查询和纯标点不返回结果", function() {
    ["", "   ", "！？", "，。"].forEach(function(query) {
        const result = searchIn(query);
        assert.deepStrictEqual(result.matches, [], JSON.stringify(query) + " 不该有结果");
        assert.strictEqual(result.keyword, "");
    });
});

test("别名和标签也接受纯字符串写法", function() {
    const choices = [{ id: 1, name: "肯德基", aliases: ["KFC"], tags: ["快餐"] }];
    assert.deepStrictEqual(names(searchIn("kfc", choices)), ["肯德基"]);
    assert.deepStrictEqual(names(searchIn("快餐", choices)), ["肯德基"]);
});

test("裸字符串的 aliases/tags 也能搜到，不会抛异常", function() {
    const choices = [{ id: 1, name: "肯德基", aliases: "KFC", tags: "快餐" }];
    assert.deepStrictEqual(names(searchIn("kfc", choices)), ["肯德基"]);
    assert.deepStrictEqual(names(searchIn("快餐", choices)), ["肯德基"]);
});

test("aliases/tags 是数字或对象时忽略而不是崩溃", function() {
    const choices = [
        { id: 1, name: "米饭", aliases: 42, tags: { tag: "主食" } },
        { id: 2, name: "肯德基", aliases: null, tags: undefined }
    ];
    assert.deepStrictEqual(names(searchIn("米饭", choices)), ["米饭"]);
    assert.deepStrictEqual(names(searchIn("kfc", choices)), []);
});

test("缺少 aliases/tags 字段的候选项不会崩", function() {
    const choices = [{ id: 1, name: "米饭" }];
    assert.deepStrictEqual(names(searchIn("米饭", choices)), ["米饭"]);
    assert.deepStrictEqual(names(searchIn("kfc", choices)), []);
});

test("同名候选项按原有顺序稳定排序", function() {
    const choices = [
        { id: 1, name: "面 甲", aliases: [], tags: [] },
        { id: 2, name: "面 乙", aliases: [], tags: [] }
    ];
    assert.deepStrictEqual(names(searchIn("面", choices)), ["面 甲", "面 乙"]);
});

test("normalizeSearchText 归一化全角与空白", function() {
    assert.strictEqual(search.normalizeSearchText("  ＫＦＣ "), "kfc");
    assert.strictEqual(search.normalizeSearchText("KFC"), "kfc");
});

let failed = 0;
cases.forEach(function(entry) {
    try {
        entry[1]();
        console.log("ok   - " + entry[0]);
    } catch (error) {
        failed += 1;
        console.error("FAIL - " + entry[0] + "\n       " + error.message);
    }
});

console.log("\n" + (cases.length - failed) + "/" + cases.length + " passed");
process.exit(failed === 0 ? 0 : 1);
