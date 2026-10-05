"use strict";

/*
 * 业务校验规则的纯函数实现：食物名规范化、时间戳解析、历史记录规范化、
 * 导入清洗。浏览器和 node 共用（UMD，和 search.js 同一套写法）。
 *
 * 这些规则本来只写在 database.py 里。PWA 版没有 Python 进程，如果这里"大概
 * 差不多"地重写一遍，电脑版拒绝的名字手机会收下、两边导出的备份会互相不认。
 * 所以逐条对齐 database.py，并且用 tests/test_validation.js 拿同一批样例
 * 对照 Python 的实际输出（合成数据，不碰真实库）。
 *
 * 边界和 Python 的差异都写在各自的注释里，唯一的"故意不同"是错误类型：
 * Python 用 ValidationError/ConflictError/NotFoundError 三类异常，这里保留
 * 同名类，因为 index.js 只读 error.message，分类是为了让调用方查得到。
 */
(function(root, factory) {
    var api = factory(
        typeof module === "object" && module.exports ? require("./casefold.js") : root.AppCasefold
    );
    if (typeof module === "object" && module.exports) {
        module.exports = api;
    }
    if (root) {
        root.AppValidation = api;
    }
}(typeof window === "undefined" ? null : window, function(AppCasefold) {
    if (!AppCasefold) {
        throw new Error("validation.js 依赖 casefold.js，请确认它在前面加载");
    }

    // 与 database.py 顶部的常量一一对应。改任何一个都要两边一起改，
    // tests/test_validation.js 会拿 database.py 的当前值比对。
    var APP_ID = "what-should-we-eat";
    var SCHEMA_VERSION = 2;
    var MAX_FOOD_LENGTH = 40;
    var MAX_IMPORT_ITEMS = 100000;
    var MAX_CHOICE_META_ITEMS = 20;
    var MIN_TIMESTAMP_YEAR = 1970;
    var MAX_TIMESTAMP_YEAR = 2100;
    // 历史记录可编辑/可删除的窗口（含今天，按手机本地日历日算）。
    // 改这个数字要同时改 index.html 的说明文案和 README。
    var HISTORY_EDIT_WINDOW_DAYS = 5;
    var SNAPSHOT_LIMIT = 10;

    // 首次启动的默认候选项，与 database.py 的 DEFAULT_CHOICES 一致。
    // DEFAULT_CHOICE_ALIASES 不搬过来：它是 v1→v2 结构迁移时补一次的出厂别名，
    // PWA 的库从版本 1 开始，没有那一步迁移可做。
    var DEFAULT_CHOICES = [
        "Yam and egg",
        "Jollof rice",
        "Bread and egg",
        "Cereal",
        "Indomie",
        "Beans",
        "Efo riro",
        "Ofada rice and stew"
    ];

    function ValidationError(message) {
        var error = Error.call(this, message);
        this.name = "ValidationError";
        this.message = message;
        this.stack = error.stack;
    }
    ValidationError.prototype = Object.create(Error.prototype);
    ValidationError.prototype.constructor = ValidationError;

    function ConflictError(message) {
        var error = Error.call(this, message);
        this.name = "ConflictError";
        this.message = message;
        this.stack = error.stack;
    }
    ConflictError.prototype = Object.create(Error.prototype);
    ConflictError.prototype.constructor = ConflictError;

    function NotFoundError(message) {
        var error = Error.call(this, message);
        this.name = "NotFoundError";
        this.message = message;
        this.stack = error.stack;
    }
    NotFoundError.prototype = Object.create(Error.prototype);
    NotFoundError.prototype.constructor = NotFoundError;

    // 先把字符串按码点拆开：length 数的是 UTF-16 单元，一个 emoji 会算成 2，
    // 和 Python 的 len()（码点数）对不上。
    function codePoints(value) {
        return Array.from(value);
    }

    /*
     * normalize_food 的移植。顺序和 Python 完全一致，不能调换：
     * 先 NFC（否则 "é" 的两种写法算两个候选项），再删不可见格式字符，
     * 再拒绝控制字符/代理字符，最后压空白、查长度。
     */
    function normalizeFood(value) {
        if (typeof value !== "string") {
            throw new ValidationError("食物名称必须是文本");
        }
        var normalized = value.normalize("NFC");
        normalized = codePoints(normalized).filter(function(char) {
            return !AppCasefold.isFormatCodePoint(char.codePointAt(0));
        }).join("");
        if (codePoints(normalized).some(function(char) {
            return AppCasefold.isForbiddenCodePoint(char.codePointAt(0));
        })) {
            throw new ValidationError("食物名称不能包含控制字符");
        }
        // 走到这里，Cf 已经删掉、Cc/Cs 已经拒绝，剩下的空白集合 JS 和 Python
        // 是一致的：两边唯一的差别（\ufeff 与 \x1c-\x1f、\x85）都已在上一步处理。
        normalized = normalized.replace(/\s+/g, " ").trim();
        if (!normalized) {
            throw new ValidationError("食物名称不能为空");
        }
        if (codePoints(normalized).length > MAX_FOOD_LENGTH) {
            throw new ValidationError("食物名称不能超过 " + MAX_FOOD_LENGTH + " 个字符");
        }
        return normalized;
    }

    /*
     * 去重键。SQLite 侧是 `str.casefold()`，浏览器没有等价 API，所以走
     * casefold.js 里的差异表。不能用 toLowerCase 顶替：`ß` 不会变成 `ss`，
     * 「Straße」和「STRASSE」在电脑上算重复、在手机上会变成两个候选项。
     */
    function foldedKey(value) {
        return AppCasefold.foldString(String(value));
    }

    function pad(value, width) {
        var text = String(value);
        while (text.length < width) {
            text = "0" + text;
        }
        return text;
    }

    function isLeapYear(year) {
        return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    }

    function daysInMonth(year, month) {
        return [31, isLeapYear(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
    }

    /*
     * 扩展格式：`YYYY-MM-DD`，可接 `T` 或空格 + 时:分[:秒[.小数]]，再可接时区。
     * 秒级小数两种小数点都收（Python 的 fromisoformat 也收逗号），而且小数位
     * 可以是空的——`18:08:24.Z` 在 Python 里是合法的（按 0 毫秒算）。
     */
    var EXTENDED_PATTERN = new RegExp(
        "^(\\d{4})-(\\d{2})-(\\d{2})"
        + "(?:[T ](\\d{2})(?::(\\d{2})(?::(\\d{2})(?:[.,](\\d*))?)?)?"
        + "(Z|[+-]\\d{2}(?::?\\d{2})?(?::?\\d{2}(?:[.,]\\d+)?)?)?)?$"
    );
    // 紧凑格式：`YYYYMMDD`，可接 `T时:分:秒[.小数][时区]`。
    var BASIC_PATTERN = new RegExp(
        "^(\\d{4})(\\d{2})(\\d{2})"
        + "(?:[T ](\\d{2})(?::?(\\d{2})(?::?(\\d{2})(?:[.,](\\d*))?)?)?"
        + "(Z|[+-]\\d{2}(?::?\\d{2})?(?::?\\d{2}(?:[.,]\\d+)?)?)?)?$"
    );
    // ISO 周历：`YYYY-Www-D`，Python 的 fromisoformat 也认（按该周的周一算）。
    var WEEK_PATTERN = /^(\d{4})-?W(\d{2})-?(\d)$/;

    function parseOffset(text) {
        if (text === "Z") {
            return { ok: true, milliseconds: 0 };
        }
        var sign = text.charAt(0) === "-" ? -1 : 1;
        var body = text.slice(1);
        var digits = body.replace(/[:.,]/g, "");
        var hours = Number(digits.slice(0, 2) || "0");
        var minutes = Number(digits.slice(2, 4) || "0");
        var seconds = Number(digits.slice(4, 6) || "0");
        var fraction = digits.slice(6);
        if (hours > 23 || minutes > 59 || seconds > 59) {
            return { ok: false };
        }
        var milliseconds = ((hours * 60 + minutes) * 60 + seconds) * 1000;
        if (fraction) {
            milliseconds += Math.floor(Number("0." + fraction) * 1000);
        }
        // Python 的 timezone() 要求偏移严格小于 24 小时。
        if (milliseconds >= 86400000) {
            return { ok: false };
        }
        return { ok: true, milliseconds: sign * milliseconds };
    }

    /*
     * 把拆分出来的字段拼成 UTC 毫秒。没有时区的写法按本机时区解释——
     * 和 Python 的 `parsed.astimezone()` 一致（裸时间戳按本地时间算）。
     * 用 setFullYear/setUTCFullYear 而不是 Date 构造函数：构造函数把 0-99
     * 当成 19xx 年。
     */
    function assemble(fields, offsetMilliseconds) {
        var date = new Date(0);
        if (offsetMilliseconds === null) {
            date.setFullYear(fields.year, fields.month - 1, fields.day);
            date.setHours(fields.hour, fields.minute, fields.second, fields.millisecond);
        } else {
            date.setUTCFullYear(fields.year, fields.month - 1, fields.day);
            date.setUTCHours(fields.hour, fields.minute, fields.second, fields.millisecond);
        }
        return date.getTime() - (offsetMilliseconds || 0);
    }

    function fractionToMilliseconds(fraction) {
        return fraction ? Math.floor(Number("0." + fraction) * 1000) : 0;
    }

    /*
     * 解析出 UTC 毫秒；格式不认识返回 null（而不是抛错），让调用方决定
     * 是"用兜底值"还是"报错"。对应 Python 里 fromisoformat 的 ValueError。
     */
    function parseToUtcMs(raw) {
        var match = EXTENDED_PATTERN.exec(raw);
        var fields = null;
        var offsetText = null;
        if (match) {
            fields = {
                year: Number(match[1]),
                month: Number(match[2]),
                day: Number(match[3]),
                hour: Number(match[4] || "0"),
                minute: Number(match[5] || "0"),
                second: Number(match[6] || "0"),
                millisecond: fractionToMilliseconds(match[7])
            };
            offsetText = match[8] || null;
        } else {
            match = BASIC_PATTERN.exec(raw);
            if (match) {
                fields = {
                    year: Number(match[1]),
                    month: Number(match[2]),
                    day: Number(match[3]),
                    hour: Number(match[4] || "0"),
                    minute: Number(match[5] || "0"),
                    second: Number(match[6] || "0"),
                    millisecond: fractionToMilliseconds(match[7])
                };
                offsetText = match[8] || null;
            }
        }

        if (!fields) {
            var week = WEEK_PATTERN.exec(raw);
            if (!week) {
                return null;
            }
            var weekday = Number(week[3]);
            if (weekday < 1 || weekday > 7) {
                return null;
            }
            var weekYear = Number(week[1]);
            var weekNumber = Number(week[2]);
            if (weekYear < 1 || weekNumber < 1 || weekNumber > 53) {
                return null;
            }
            // ISO 周 1 是含 1 月 4 日的那一周，周一是它的第 1 天。
            var januaryFourth = new Date(0);
            januaryFourth.setFullYear(weekYear, 0, 4);
            januaryFourth.setHours(0, 0, 0, 0);
            var isoWeekday = januaryFourth.getDay() === 0 ? 7 : januaryFourth.getDay();
            januaryFourth.setDate(januaryFourth.getDate() - (isoWeekday - 1) + (weekNumber - 1) * 7 + (weekday - 1));
            // 周历只给出日期，日期靠 Date 归一化过（可能跨年），所以取回字段后
            // 继续走下面共用的年份校验，不能直接返回时间戳绕开 1970~2100 的检查。
            fields = {
                year: januaryFourth.getFullYear(),
                month: januaryFourth.getMonth() + 1,
                day: januaryFourth.getDate(),
                hour: 0,
                minute: 0,
                second: 0,
                millisecond: 0
            };
        }

        // Python 的 datetime 不接受 0 年；月、日、时、分、秒也各自有范围。
        if (fields.year < 1 || fields.month < 1 || fields.month > 12) {
            return null;
        }
        if (fields.day < 1 || fields.day > daysInMonth(fields.year, fields.month)) {
            return null;
        }
        if (fields.hour > 23 || fields.minute > 59 || fields.second > 59) {
            return null;
        }

        var offsetMilliseconds = null;
        if (offsetText) {
            var offset = parseOffset(offsetText);
            if (!offset.ok) {
                return null;
            }
            offsetMilliseconds = offset.milliseconds;
        }

        var epoch = assemble(fields, offsetMilliseconds);
        return isFinite(epoch) ? epoch : null;
    }

    function formatUtcMilliseconds(epoch) {
        // 年份已经限定在 1970~2100，toISOString 一定是 4 位年 + 3 位毫秒。
        return new Date(epoch).toISOString();
    }

    /*
     * parse_timestamp 的移植。`fallback` 的语义要照抄：
     * 只有"格式不认识"才用兜底值；年份越界（Python 里是会抛 OverflowError 的
     * 那类时间）必须报错，不能被兜底值悄悄盖过去。
     */
    function parseTimestamp(value, fallback) {
        var hasFallback = fallback !== undefined && fallback !== null;
        if (typeof value !== "string" || !value.trim()) {
            if (hasFallback) {
                return fallback;
            }
            throw new ValidationError("选择时间无效");
        }

        var epoch = parseToUtcMs(value.trim());
        if (epoch === null) {
            if (hasFallback) {
                return fallback;
            }
            throw new ValidationError("选择时间无效");
        }

        // 先换算成 UTC 再看年份：否则 "1970-01-01T00:00:00+14:00" 会以 1969 年
        // 落库，导出的备份再导入时又会被自己的校验拒绝。
        var utc = new Date(epoch);
        var utcYear = utc.getUTCFullYear();
        // Python 的 datetime 只到 9999 年、不早于 1 年，换算越界时 astimezone()
        // 直接抛 OverflowError。JS 的 Date 能表示到 27 万年，所以这里要自己判：
        // 分成"根本表示不了"和"在范围内但太极端"两种说法，用户看到的和电脑版一致。
        if (utcYear < 1 || utcYear > 9999) {
            throw new ValidationError("选择时间超出允许范围");
        }
        if (utcYear < MIN_TIMESTAMP_YEAR || utcYear > MAX_TIMESTAMP_YEAR) {
            throw new ValidationError(
                "选择时间必须在 " + MIN_TIMESTAMP_YEAR + " 至 " + MAX_TIMESTAMP_YEAR + " 年之间"
            );
        }
        return formatUtcMilliseconds(epoch);
    }

    function utcNow() {
        // 和 Python 的 utc_now() 一样是毫秒精度 + "Z" 后缀。
        return new Date().toISOString();
    }

    // 和 Python 的 uuid4().hex 一样是 32 位十六进制，不需要连字符。
    function createHistoryId() {
        var bytes = new Uint8Array(16);
        if (typeof crypto !== "undefined" && crypto && typeof crypto.getRandomValues === "function") {
            crypto.getRandomValues(bytes);
        } else {
            for (var index = 0; index < bytes.length; index += 1) {
                bytes[index] = Math.floor(Math.random() * 256);
            }
        }
        var hex = "";
        for (var cursor = 0; cursor < bytes.length; cursor += 1) {
            hex += pad(bytes[cursor].toString(16), 2);
        }
        return hex;
    }

    /*
     * normalize_history_item 的移植。`allowString` 对应旧的纯字符串历史，
     * 只有浏览器旧数据迁移才用得上。
     */
    function normalizeHistoryItem(item, options) {
        var settings = options || {};
        if (typeof item === "string" && settings.allowString) {
            return {
                id: createHistoryId(),
                food: normalizeFood(item),
                selectedAt: settings.fallbackTime || utcNow()
            };
        }

        if (typeof item !== "object" || item === null || Array.isArray(item)) {
            throw new ValidationError("历史记录格式无效");
        }

        var food = normalizeFood(item.food);
        var itemId = item.id;
        if (itemId === undefined || itemId === null || String(itemId).trim() === "") {
            itemId = createHistoryId();
        } else {
            itemId = String(itemId).trim();
            if (itemId.length > 200) {
                throw new ValidationError("历史记录 ID 无效");
            }
        }

        var selectedAt = item.selectedAt === undefined ? item.selected_at : item.selectedAt;
        return {
            id: itemId,
            food: food,
            selectedAt: parseTimestamp(selectedAt, settings.fallbackTime)
        };
    }

    /*
     * 时间戳 -> 本地日历日的天序号（用 UTC 构造的"纯日期"做减法，
     * 差值就是整天数，不受夏令时影响）。
     * 解析不了返回 null，调用方按各自的规则处理。
     */
    function localDayIndex(epoch) {
        var date = new Date(epoch);
        return Math.floor(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / 86400000);
    }

    function todayDayIndex() {
        return localDayIndex(Date.now());
    }

    // 时间戳能不能被解释。对应 Python 的 is_parseable_timestamp。
    function isParseableTimestamp(timestamp) {
        var epoch = typeof timestamp === "number" ? timestamp : parseValue(timestamp);
        return epoch !== null && isFinite(epoch);
    }

    // 宽松解析：只关心"能不能读出本地日期"，不关心年份范围。
    function parseValue(timestamp) {
        if (typeof timestamp !== "string" || !timestamp.trim()) {
            return null;
        }
        return parseToUtcMs(timestamp.trim());
    }

    /*
     * is_editable_timestamp 的移植：今天及前四个本地日历日内可编辑。
     * 解析不了的记录不可编辑（但可删除，见下）。
     */
    function isEditableTimestamp(timestamp) {
        var epoch = parseValue(timestamp);
        if (epoch === null) {
            return false;
        }
        var daysAgo = todayDayIndex() - localDayIndex(epoch);
        return daysAgo >= 0 && daysAgo < HISTORY_EDIT_WINDOW_DAYS;
    }

    /*
     * is_deletable_timestamp 的移植：窗口内的记录可删；时间戳损坏、或落在未来
     * 的记录属于垃圾数据，也必须可删，否则用户只能"清空全部历史"来摆脱它。
     */
    function isDeletableTimestamp(timestamp) {
        var epoch = parseValue(timestamp);
        if (epoch === null) {
            return true;
        }
        var daysAgo = todayDayIndex() - localDayIndex(epoch);
        if (daysAgo < 0) {
            return true;
        }
        return daysAgo < HISTORY_EDIT_WINDOW_DAYS;
    }

    /*
     * _clean_meta_values 的移植：清洗备份里的 aliases/tags，
     * 返回 {values, invalid, duplicate}。超过上限的条目计入无效数：
     * 它们会被静默丢弃，用户至少在预览里看得到。
     */
    function cleanMetaValues(rawValues, key) {
        var values = [];
        var seen = {};
        var invalid = 0;
        var duplicate = 0;
        if (rawValues === undefined || rawValues === null) {
            return { values: values, invalid: invalid, duplicate: duplicate };
        }
        if (!Array.isArray(rawValues)) {
            return { values: values, invalid: 1, duplicate: duplicate };
        }
        rawValues.forEach(function(item) {
            var rawValue = item !== null && typeof item === "object" && !Array.isArray(item)
                ? item[key]
                : item;
            var value;
            try {
                value = normalizeFood(rawValue);
            } catch (error) {
                if (!(error instanceof ValidationError)) {
                    throw error;
                }
                invalid += 1;
                return;
            }
            var valueKey = foldedKey(value);
            if (Object.prototype.hasOwnProperty.call(seen, valueKey)) {
                duplicate += 1;
                return;
            }
            if (values.length >= MAX_CHOICE_META_ITEMS) {
                invalid += 1;
                return;
            }
            seen[valueKey] = true;
            values.push(value);
        });
        return { values: values, invalid: invalid, duplicate: duplicate };
    }

    function isPlainObject(value) {
        return typeof value === "object" && value !== null && !Array.isArray(value);
    }

    /*
     * _prepare_import 的移植：把一份备份清洗成可写入的数据 + 预览摘要。
     * 摘要里的 choiceCount 等六个字段就是 index.js 的导入预览读的那几个。
     */
    function prepareImport(payload) {
        if (!isPlainObject(payload)) {
            throw new ValidationError("备份文件必须是 JSON 对象");
        }
        if (payload.app !== APP_ID) {
            throw new ValidationError("不是本应用的备份文件");
        }
        if (payload.schemaVersion !== SCHEMA_VERSION) {
            throw new ValidationError("不支持的备份版本");
        }

        var rawChoices = payload.choices;
        var rawHistory = payload.history;
        if (!Array.isArray(rawChoices) || !Array.isArray(rawHistory)) {
            throw new ValidationError("备份必须包含 choices 和 history 数组");
        }
        if (rawChoices.length > MAX_IMPORT_ITEMS || rawHistory.length > MAX_IMPORT_ITEMS) {
            throw new ValidationError("备份记录数量超出限制");
        }

        var validChoices = [];
        var choiceKeys = {};
        var invalidCount = 0;
        var duplicateCount = 0;
        rawChoices.forEach(function(item) {
            var rawName = isPlainObject(item) ? item.name : item;
            var name;
            try {
                name = normalizeFood(rawName);
            } catch (error) {
                if (!(error instanceof ValidationError)) {
                    throw error;
                }
                invalidCount += 1;
                return;
            }
            var key = foldedKey(name);
            if (Object.prototype.hasOwnProperty.call(choiceKeys, key)) {
                duplicateCount += 1;
                return;
            }
            choiceKeys[key] = true;
            var aliases = cleanMetaValues(isPlainObject(item) ? item.aliases : undefined, "alias");
            var tags = cleanMetaValues(isPlainObject(item) ? item.tags : undefined, "tag");
            invalidCount += aliases.invalid + tags.invalid;
            duplicateCount += aliases.duplicate + tags.duplicate;
            validChoices.push({ name: name, aliases: aliases.values, tags: tags.values });
        });

        var validHistory = [];
        var historyIds = {};
        rawHistory.forEach(function(item) {
            var record;
            try {
                record = normalizeHistoryItem(item);
            } catch (error) {
                if (!(error instanceof ValidationError)) {
                    throw error;
                }
                invalidCount += 1;
                return;
            }
            if (Object.prototype.hasOwnProperty.call(historyIds, record.id)) {
                duplicateCount += 1;
                return;
            }
            historyIds[record.id] = true;
            validHistory.push(record);
        });

        if ((rawChoices.length > 0 || rawHistory.length > 0)
            && validChoices.length === 0 && validHistory.length === 0) {
            throw new ValidationError("备份中没有可导入的有效数据");
        }

        var aliasCount = 0;
        var tagCount = 0;
        validChoices.forEach(function(entry) {
            aliasCount += entry.aliases.length;
            tagCount += entry.tags.length;
        });

        return {
            data: { choices: validChoices, history: validHistory },
            summary: {
                choiceCount: validChoices.length,
                historyCount: validHistory.length,
                aliasCount: aliasCount,
                tagCount: tagCount,
                invalidCount: invalidCount,
                duplicateCount: duplicateCount
            }
        };
    }

    /*
     * preview_import 里需要看现有数据的那两个数字。
     *
     * existingChoiceKeys: 现有候选项的去重键集合（foldedKey(normalizeFood(name))）
     * existingHistory:    {id: [food, selectedAt]}，用于判断 ID 冲突
     *
     * "冲突"只算 id 相同但内容不同的：id 相同且内容相同的重复导入属于幂等重放，
     * 报成冲突会让用户以为出了问题。
     */
    function summarizeAgainstExisting(summary, cleaned, existingChoiceKeys, existingHistory) {
        var choiceKeys = existingChoiceKeys || {};
        var historyMap = existingHistory || {};
        var existingChoiceCount = 0;
        var historyIdConflictCount = 0;

        cleaned.choices.forEach(function(entry) {
            if (Object.prototype.hasOwnProperty.call(choiceKeys, foldedKey(entry.name))) {
                existingChoiceCount += 1;
            }
        });
        cleaned.history.forEach(function(record) {
            if (!Object.prototype.hasOwnProperty.call(historyMap, record.id)) {
                return;
            }
            var existing = historyMap[record.id];
            if (existing[0] !== record.food || existing[1] !== record.selectedAt) {
                historyIdConflictCount += 1;
            }
        });

        var result = {};
        Object.keys(summary).forEach(function(key) {
            result[key] = summary[key];
        });
        result.existingChoiceCount = existingChoiceCount;
        result.historyIdConflictCount = historyIdConflictCount;
        return result;
    }

    // 导出载荷：字段和顺序都对着 database.py 的 export_payload，
    // 只写 name/aliases/tags 与 id/food/selectedAt，不写后端算出来的字段。
    function buildExportPayload(choices, history, exportedAt) {
        return {
            app: APP_ID,
            schemaVersion: SCHEMA_VERSION,
            exportedAt: exportedAt || utcNow(),
            choices: choices.map(function(choice) {
                return {
                    name: choice.name,
                    aliases: choice.aliases.map(function(item) {
                        return typeof item === "string" ? item : item.alias;
                    }),
                    tags: choice.tags.map(function(item) {
                        return typeof item === "string" ? item : item.tag;
                    })
                };
            }),
            history: history.map(function(record) {
                return {
                    id: record.id,
                    food: record.food,
                    selectedAt: record.selectedAt
                };
            })
        };
    }

    return {
        APP_ID: APP_ID,
        SCHEMA_VERSION: SCHEMA_VERSION,
        MAX_FOOD_LENGTH: MAX_FOOD_LENGTH,
        MAX_IMPORT_ITEMS: MAX_IMPORT_ITEMS,
        MAX_CHOICE_META_ITEMS: MAX_CHOICE_META_ITEMS,
        MIN_TIMESTAMP_YEAR: MIN_TIMESTAMP_YEAR,
        MAX_TIMESTAMP_YEAR: MAX_TIMESTAMP_YEAR,
        HISTORY_EDIT_WINDOW_DAYS: HISTORY_EDIT_WINDOW_DAYS,
        SNAPSHOT_LIMIT: SNAPSHOT_LIMIT,
        DEFAULT_CHOICES: DEFAULT_CHOICES,
        ValidationError: ValidationError,
        ConflictError: ConflictError,
        NotFoundError: NotFoundError,
        normalizeFood: normalizeFood,
        foldedKey: foldedKey,
        parseTimestamp: parseTimestamp,
        utcNow: utcNow,
        createHistoryId: createHistoryId,
        normalizeHistoryItem: normalizeHistoryItem,
        localDayIndex: localDayIndex,
        isParseableTimestamp: isParseableTimestamp,
        isEditableTimestamp: isEditableTimestamp,
        isDeletableTimestamp: isDeletableTimestamp,
        cleanMetaValues: cleanMetaValues,
        prepareImport: prepareImport,
        summarizeAgainstExisting: summarizeAgainstExisting,
        buildExportPayload: buildExportPayload
    };
}));
