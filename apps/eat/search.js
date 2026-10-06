"use strict";

/*
 * 候选项搜索的纯函数实现：名字、别名、标签三类字段一起匹配。
 *
 * 单独成文件有两个原因：
 * 1. 别名和标签是用户数据（存在 SQLite 里），词典是应用数据（写在下面）；
 *    两者混在渲染代码里会让人分不清该改哪一边。
 * 2. 纯函数可以用 node 直接跑断言（tests/test_search.js）——浏览器之外的
 *    回归测试是这个项目唯一能自动验证前端行为的方式。
 */
(function(root, factory) {
    var api = factory();
    if (typeof module === "object" && module.exports) {
        module.exports = api;
    }
    if (root) {
        root.AppSearch = api;
    }
}(typeof window === "undefined" ? null : window, function() {
    // 应用级词典：中英对照、常见说法。只放跟具体候选无关的映射；
    // 「肯德基 = KFC」这类属于候选项自己的别名，存在数据库里由用户维护。
    var SEARCH_ALIASES = {
        "米": ["rice"],
        "米饭": ["rice"],
        "饭": ["rice"],
        "rice": ["米饭", "饭"],
        "蛋": ["egg"],
        "鸡蛋": ["egg"],
        "egg": ["蛋", "鸡蛋"],
        "面": ["noodle"],
        "面条": ["noodle"],
        "noodle": ["面", "面条"],
        "早餐": ["breakfast", "cereal", "bread", "egg"],
        "breakfast": ["早餐", "cereal", "bread", "egg"],
        "谷物": ["cereal"],
        "cereal": ["谷物"]
    };

    // 每个字段先拿一个层级分，再叠加匹配精度。层级差（1000）大于任何精度分
    // （最大 exact 1000），所以同一个查询词上：名字命中 > 别名命中 > 标签命中，
    // 不会出现「挂着『面』标签的米饭」压过名字里带「面」的重庆小面。
    var FIELD_WEIGHTS = {
        name: { tier: 3000, exact: 1000, substring: 500, compact: 400, primary: 100, alternate: 60 },
        alias: { tier: 2000, exact: 800, substring: 450, compact: 380, primary: 90, alternate: 55 },
        tag: { tier: 1000, exact: 700, substring: 420, compact: 360, primary: 80, alternate: 50 }
    };

    function normalizeSearchText(value) {
        var normalized = value;
        if (typeof normalized.normalize === "function") {
            normalized = normalized.normalize("NFKC");
        }
        return normalized
            .toLocaleLowerCase()
            // 只保留字母、数字和符号类（\p{S}）：其余标点——包括 NFKC 转换出来的
            // 半角 ! ?——一律当分隔符，这样只输入"！？"时会被当成空关键词。
            // emoji（So）和 +（Sm）仍然可以当关键词；& 属于标点（Po），会被去掉。
            .replace(/[^\p{L}\p{N}\p{S}]+/gu, " ")
            .replace(/\s+/g, " ")
            .trim();
    }

    function expandSearchToken(token) {
        var terms = [token].concat(SEARCH_ALIASES[token] || []);
        // 英文复数：noodles / eggs / oats 这类词没有单列别名，回退到单数再查一次。
        // 下限是「s 前面至少 3 个字母」，这样 eggs 能覆盖到，而 his / gas 不会
        // 被削成 hi / ga 这种会造成误匹配的碎片。
        if (/^[a-z]{3,}s$/.test(token)) {
            var singular = token.slice(0, -1);
            terms.push(singular);
            terms = terms.concat(SEARCH_ALIASES[singular] || []);
        }
        return terms;
    }

    function getSearchGroups(query) {
        var normalizedQuery = normalizeSearchText(query);
        var tokens = normalizedQuery ? normalizedQuery.split(" ") : [];

        if (tokens.length === 1
            && !SEARCH_ALIASES[tokens[0]]
            && /[\u4e00-\u9fff]{2,}/.test(tokens[0])) {
            tokens = Array.from(tokens[0]);
        }

        return tokens.map(expandSearchToken);
    }

    // /api/state 下发的是 {id, alias}/{id, tag}，测试里为了省事也会直接传字符串。
    function metaText(item, key) {
        if (item && typeof item === "object" && typeof item[key] === "string") {
            return item[key];
        }
        return typeof item === "string" ? item : "";
    }

    // 只接受数组；裸字符串当成只有一个元素的列表，其余（数字、对象、null）忽略。
    // 不能直接 .forEach：一个手写的 state 里传了字符串就会把整个渲染打断。
    function metaList(value) {
        if (Array.isArray(value)) {
            return value;
        }
        return typeof value === "string" ? [value] : [];
    }

    function searchFields(choice) {
        var fields = [{ kind: "name", text: normalizeSearchText(choice.name || "") }];
        metaList(choice.aliases).forEach(function(item) {
            var text = normalizeSearchText(metaText(item, "alias"));
            if (text) {
                fields.push({ kind: "alias", text: text });
            }
        });
        metaList(choice.tags).forEach(function(item) {
            var text = normalizeSearchText(metaText(item, "tag"));
            if (text) {
                fields.push({ kind: "tag", text: text });
            }
        });
        return fields;
    }

    function compact(value) {
        return value.replace(/\s/g, "");
    }

    function bestFieldScore(fields, normalizedQuery) {
        var compactQuery = compact(normalizedQuery);
        return fields.reduce(function(best, field) {
            var weights = FIELD_WEIGHTS[field.kind];
            var score = 0;
            if (field.text === normalizedQuery) {
                score = weights.tier + weights.exact;
            } else if (field.text.indexOf(normalizedQuery) !== -1) {
                score = weights.tier + weights.substring;
            } else if (compactQuery && compact(field.text).indexOf(compactQuery) !== -1) {
                score = weights.tier + weights.compact;
            }
            return Math.max(best, score);
        }, 0);
    }

    function bestGroupScore(fields, terms) {
        var best = 0;
        terms.forEach(function(term, termIndex) {
            var normalizedTerm = normalizeSearchText(term);
            if (!normalizedTerm) {
                return;
            }
            var compactTerm = compact(normalizedTerm);
            fields.forEach(function(field) {
                var text = field.text;
                if (text.indexOf(normalizedTerm) === -1
                    && compact(text).indexOf(compactTerm) === -1) {
                    return;
                }
                var weights = FIELD_WEIGHTS[field.kind];
                // 查询词本身命中算"直接命中"，靠词典/复数展开命中的排在后面。
                var score = weights.tier
                    + (termIndex === 0 ? weights.primary : weights.alternate);
                best = Math.max(best, score);
            });
        });
        return best;
    }

    function matchGroups(fields, groups, requireAll) {
        var total = 0;
        var matched = 0;
        for (var index = 0; index < groups.length; index += 1) {
            var best = bestGroupScore(fields, groups[index]);
            if (!best) {
                if (requireAll) {
                    return -1;
                }
                continue;
            }
            total += best;
            matched += 1;
        }
        return matched ? total : -1;
    }

    function scoreChoice(choice, query, groups, requireAll) {
        var fields = searchFields(choice);
        var normalizedQuery = normalizeSearchText(query);
        var groupScore = matchGroups(fields, groups, requireAll);
        if (groupScore < 0) {
            return -1;
        }
        return (normalizedQuery ? bestFieldScore(fields, normalizedQuery) : 0) + groupScore;
    }

    function scoreSearchChoice(choice, query, groups) {
        return scoreChoice(choice, query, groups, true);
    }

    function scoreSearchChoiceAny(choice, query, groups) {
        return scoreChoice(choice, query, groups, false);
    }

    function rank(choices, query, groups, requireAll) {
        var score = requireAll ? scoreSearchChoice : scoreSearchChoiceAny;
        return choices
            .map(function(choice, index) {
                return { choice: choice, index: index, score: score(choice, query, groups) };
            })
            .filter(function(result) {
                return result.score >= 0;
            })
            .sort(function(a, b) {
                return b.score - a.score || a.index - b.index;
            });
    }

    function searchChoices(choices, query) {
        var keyword = normalizeSearchText(query);
        if (!keyword) {
            return { keyword: "", matches: [], partial: false };
        }
        var groups = getSearchGroups(keyword);
        var matches = rank(choices, keyword, groups, true);
        var partial = false;
        // 只有用户真的写了多个词才回退 OR。单个中文词会被拆成一个个字
        // （「重庆小面」→ 重/庆/小/面），那时"命中任意一个字"会给出误导结果：
        // 搜「水产」命中「喜家德水饺」，而用户只输入了一个词。
        var explicitMultiple = keyword.indexOf(" ") !== -1;
        if (matches.length === 0 && explicitMultiple && groups.length > 1) {
            matches = rank(choices, keyword, groups, false);
            partial = matches.length > 0;
        }
        return { keyword: keyword, matches: matches, partial: partial };
    }

    return {
        SEARCH_ALIASES: SEARCH_ALIASES,
        normalizeSearchText: normalizeSearchText,
        getSearchGroups: getSearchGroups,
        scoreSearchChoice: scoreSearchChoice,
        searchChoices: searchChoices
    };
}));
