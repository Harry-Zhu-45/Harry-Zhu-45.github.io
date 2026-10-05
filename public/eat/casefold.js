"use strict";

/*
 * 由 tools/generate_casefold.py 从 Python 的 unicodedata 生成，不要手改。
 *
 * 浏览器没有和 `str.casefold()` 等价的 API，而 `toLowerCase()` 在 1530 个码点
 * 上和它不一致（`ß` 不会变成 `ss`，`ﬁ` 不会变成 `fi`，词尾 sigma 不会归到
 * `σ`）。候选项去重键必须和 SQLite 侧一致，否则「Straße」和「STRASSE」在电脑
 * 上算重复、在手机上算两个不同的东西。
 *
 * 数据格式（都是逗号分隔的条目）：
 *   ranges   `起-止:偏移`  该区间内每个码点折叠成 `码点 + 偏移`，偏移可带 `-`
 *   singles  `码点:目标`   零散的单码点映射
 *   multi    `码点:目标`   折叠成多个码点，目标按 5 位十六进制一段拼接
 *
 * 正例和边界都钉在 tests/test_casefold.js 里；逐码点与 Python 的一致性由
 * tests/test_casefold_parity.py 校验。
 */
(function(root, factory) {
    var api = factory();
    if (typeof module === "object" && module.exports) {
        module.exports = api;
    }
    if (root) {
        root.AppCasefold = api;
    }
}(typeof window === "undefined" ? null : window, function() {
    var DATA = {
        unicodeVersion: "15.0.0",
        ranges: "41-5A:20,C0-D6:20,D8-DE:20,189-18A:CD,1B1-1B2:D9,388-38A:25,38E-38F:3F,391-3A1:20,3A3-3AB:20,3FD-3FF:-82,400-40F:50,410-42F:20,531-556:30,10A0-10C5:1C60,13F8-13FD:-8,1C83-1C84:-1842,1C90-1CBA:-BC0,1CBD-1CBF:-BC0,1F08-1F0F:-8,1F18-1F1D:-8,1F28-1F2F:-8,1F38-1F3F:-8,1F48-1F4D:-8,1F68-1F6F:-8,1FB8-1FB9:-8,1FBA-1FBB:-4A,1FC8-1FCB:-56,1FD8-1FD9:-8,1FDA-1FDB:-64,1FE8-1FE9:-8,1FEA-1FEB:-70,1FF8-1FF9:-80,1FFA-1FFB:-7E,2160-216F:10,24B6-24CF:1A,2C00-2C2F:30,2C7E-2C7F:-2A3F,AB70-ABBF:-97D0,FF21-FF3A:20,10400-10427:28,104B0-104D3:28,10570-1057A:27,1057C-1058A:27,1058C-10592:27,10594-10595:27,10C80-10CB2:40,118A0-118BF:20,16E40-16E5F:20,1E900-1E921:22",
        singles: "B5:3BC,100:101,102:103,104:105,106:107,108:109,10A:10B,10C:10D,10E:10F,110:111,112:113,114:115,116:117,118:119,11A:11B,11C:11D,11E:11F,120:121,122:123,124:125,126:127,128:129,12A:12B,12C:12D,12E:12F,132:133,134:135,136:137,139:13A,13B:13C,13D:13E,13F:140,141:142,143:144,145:146,147:148,14A:14B,14C:14D,14E:14F,150:151,152:153,154:155,156:157,158:159,15A:15B,15C:15D,15E:15F,160:161,162:163,164:165,166:167,168:169,16A:16B,16C:16D,16E:16F,170:171,172:173,174:175,176:177,178:FF,179:17A,17B:17C,17D:17E,17F:73,181:253,182:183,184:185,186:254,187:188,18B:18C,18E:1DD,18F:259,190:25B,191:192,193:260,194:263,196:269,197:268,198:199,19C:26F,19D:272,19F:275,1A0:1A1,1A2:1A3,1A4:1A5,1A6:280,1A7:1A8,1A9:283,1AC:1AD,1AE:288,1AF:1B0,1B3:1B4,1B5:1B6,1B7:292,1B8:1B9,1BC:1BD,1C4:1C6,1C5:1C6,1C7:1C9,1C8:1C9,1CA:1CC,1CB:1CC,1CD:1CE,1CF:1D0,1D1:1D2,1D3:1D4,1D5:1D6,1D7:1D8,1D9:1DA,1DB:1DC,1DE:1DF,1E0:1E1,1E2:1E3,1E4:1E5,1E6:1E7,1E8:1E9,1EA:1EB,1EC:1ED,1EE:1EF,1F1:1F3,1F2:1F3,1F4:1F5,1F6:195,1F7:1BF,1F8:1F9,1FA:1FB,1FC:1FD,1FE:1FF,200:201,202:203,204:205,206:207,208:209,20A:20B,20C:20D,20E:20F,210:211,212:213,214:215,216:217,218:219,21A:21B,21C:21D,21E:21F,220:19E,222:223,224:225,226:227,228:229,22A:22B,22C:22D,22E:22F,230:231,232:233,23A:2C65,23B:23C,23D:19A,23E:2C66,241:242,243:180,244:289,245:28C,246:247,248:249,24A:24B,24C:24D,24E:24F,345:3B9,370:371,372:373,376:377,37F:3F3,386:3AC,38C:3CC,3C2:3C3,3CF:3D7,3D0:3B2,3D1:3B8,3D5:3C6,3D6:3C0,3D8:3D9,3DA:3DB,3DC:3DD,3DE:3DF,3E0:3E1,3E2:3E3,3E4:3E5,3E6:3E7,3E8:3E9,3EA:3EB,3EC:3ED,3EE:3EF,3F0:3BA,3F1:3C1,3F4:3B8,3F5:3B5,3F7:3F8,3F9:3F2,3FA:3FB,460:461,462:463,464:465,466:467,468:469,46A:46B,46C:46D,46E:46F,470:471,472:473,474:475,476:477,478:479,47A:47B,47C:47D,47E:47F,480:481,48A:48B,48C:48D,48E:48F,490:491,492:493,494:495,496:497,498:499,49A:49B,49C:49D,49E:49F,4A0:4A1,4A2:4A3,4A4:4A5,4A6:4A7,4A8:4A9,4AA:4AB,4AC:4AD,4AE:4AF,4B0:4B1,4B2:4B3,4B4:4B5,4B6:4B7,4B8:4B9,4BA:4BB,4BC:4BD,4BE:4BF,4C0:4CF,4C1:4C2,4C3:4C4,4C5:4C6,4C7:4C8,4C9:4CA,4CB:4CC,4CD:4CE,4D0:4D1,4D2:4D3,4D4:4D5,4D6:4D7,4D8:4D9,4DA:4DB,4DC:4DD,4DE:4DF,4E0:4E1,4E2:4E3,4E4:4E5,4E6:4E7,4E8:4E9,4EA:4EB,4EC:4ED,4EE:4EF,4F0:4F1,4F2:4F3,4F4:4F5,4F6:4F7,4F8:4F9,4FA:4FB,4FC:4FD,4FE:4FF,500:501,502:503,504:505,506:507,508:509,50A:50B,50C:50D,50E:50F,510:511,512:513,514:515,516:517,518:519,51A:51B,51C:51D,51E:51F,520:521,522:523,524:525,526:527,528:529,52A:52B,52C:52D,52E:52F,10C7:2D27,10CD:2D2D,1C80:432,1C81:434,1C82:43E,1C85:442,1C86:44A,1C87:463,1C88:A64B,1E00:1E01,1E02:1E03,1E04:1E05,1E06:1E07,1E08:1E09,1E0A:1E0B,1E0C:1E0D,1E0E:1E0F,1E10:1E11,1E12:1E13,1E14:1E15,1E16:1E17,1E18:1E19,1E1A:1E1B,1E1C:1E1D,1E1E:1E1F,1E20:1E21,1E22:1E23,1E24:1E25,1E26:1E27,1E28:1E29,1E2A:1E2B,1E2C:1E2D,1E2E:1E2F,1E30:1E31,1E32:1E33,1E34:1E35,1E36:1E37,1E38:1E39,1E3A:1E3B,1E3C:1E3D,1E3E:1E3F,1E40:1E41,1E42:1E43,1E44:1E45,1E46:1E47,1E48:1E49,1E4A:1E4B,1E4C:1E4D,1E4E:1E4F,1E50:1E51,1E52:1E53,1E54:1E55,1E56:1E57,1E58:1E59,1E5A:1E5B,1E5C:1E5D,1E5E:1E5F,1E60:1E61,1E62:1E63,1E64:1E65,1E66:1E67,1E68:1E69,1E6A:1E6B,1E6C:1E6D,1E6E:1E6F,1E70:1E71,1E72:1E73,1E74:1E75,1E76:1E77,1E78:1E79,1E7A:1E7B,1E7C:1E7D,1E7E:1E7F,1E80:1E81,1E82:1E83,1E84:1E85,1E86:1E87,1E88:1E89,1E8A:1E8B,1E8C:1E8D,1E8E:1E8F,1E90:1E91,1E92:1E93,1E94:1E95,1E9B:1E61,1EA0:1EA1,1EA2:1EA3,1EA4:1EA5,1EA6:1EA7,1EA8:1EA9,1EAA:1EAB,1EAC:1EAD,1EAE:1EAF,1EB0:1EB1,1EB2:1EB3,1EB4:1EB5,1EB6:1EB7,1EB8:1EB9,1EBA:1EBB,1EBC:1EBD,1EBE:1EBF,1EC0:1EC1,1EC2:1EC3,1EC4:1EC5,1EC6:1EC7,1EC8:1EC9,1ECA:1ECB,1ECC:1ECD,1ECE:1ECF,1ED0:1ED1,1ED2:1ED3,1ED4:1ED5,1ED6:1ED7,1ED8:1ED9,1EDA:1EDB,1EDC:1EDD,1EDE:1EDF,1EE0:1EE1,1EE2:1EE3,1EE4:1EE5,1EE6:1EE7,1EE8:1EE9,1EEA:1EEB,1EEC:1EED,1EEE:1EEF,1EF0:1EF1,1EF2:1EF3,1EF4:1EF5,1EF6:1EF7,1EF8:1EF9,1EFA:1EFB,1EFC:1EFD,1EFE:1EFF,1F59:1F51,1F5B:1F53,1F5D:1F55,1F5F:1F57,1FBE:3B9,1FEC:1FE5,2126:3C9,212A:6B,212B:E5,2132:214E,2183:2184,2C60:2C61,2C62:26B,2C63:1D7D,2C64:27D,2C67:2C68,2C69:2C6A,2C6B:2C6C,2C6D:251,2C6E:271,2C6F:250,2C70:252,2C72:2C73,2C75:2C76,2C80:2C81,2C82:2C83,2C84:2C85,2C86:2C87,2C88:2C89,2C8A:2C8B,2C8C:2C8D,2C8E:2C8F,2C90:2C91,2C92:2C93,2C94:2C95,2C96:2C97,2C98:2C99,2C9A:2C9B,2C9C:2C9D,2C9E:2C9F,2CA0:2CA1,2CA2:2CA3,2CA4:2CA5,2CA6:2CA7,2CA8:2CA9,2CAA:2CAB,2CAC:2CAD,2CAE:2CAF,2CB0:2CB1,2CB2:2CB3,2CB4:2CB5,2CB6:2CB7,2CB8:2CB9,2CBA:2CBB,2CBC:2CBD,2CBE:2CBF,2CC0:2CC1,2CC2:2CC3,2CC4:2CC5,2CC6:2CC7,2CC8:2CC9,2CCA:2CCB,2CCC:2CCD,2CCE:2CCF,2CD0:2CD1,2CD2:2CD3,2CD4:2CD5,2CD6:2CD7,2CD8:2CD9,2CDA:2CDB,2CDC:2CDD,2CDE:2CDF,2CE0:2CE1,2CE2:2CE3,2CEB:2CEC,2CED:2CEE,2CF2:2CF3,A640:A641,A642:A643,A644:A645,A646:A647,A648:A649,A64A:A64B,A64C:A64D,A64E:A64F,A650:A651,A652:A653,A654:A655,A656:A657,A658:A659,A65A:A65B,A65C:A65D,A65E:A65F,A660:A661,A662:A663,A664:A665,A666:A667,A668:A669,A66A:A66B,A66C:A66D,A680:A681,A682:A683,A684:A685,A686:A687,A688:A689,A68A:A68B,A68C:A68D,A68E:A68F,A690:A691,A692:A693,A694:A695,A696:A697,A698:A699,A69A:A69B,A722:A723,A724:A725,A726:A727,A728:A729,A72A:A72B,A72C:A72D,A72E:A72F,A732:A733,A734:A735,A736:A737,A738:A739,A73A:A73B,A73C:A73D,A73E:A73F,A740:A741,A742:A743,A744:A745,A746:A747,A748:A749,A74A:A74B,A74C:A74D,A74E:A74F,A750:A751,A752:A753,A754:A755,A756:A757,A758:A759,A75A:A75B,A75C:A75D,A75E:A75F,A760:A761,A762:A763,A764:A765,A766:A767,A768:A769,A76A:A76B,A76C:A76D,A76E:A76F,A779:A77A,A77B:A77C,A77D:1D79,A77E:A77F,A780:A781,A782:A783,A784:A785,A786:A787,A78B:A78C,A78D:265,A790:A791,A792:A793,A796:A797,A798:A799,A79A:A79B,A79C:A79D,A79E:A79F,A7A0:A7A1,A7A2:A7A3,A7A4:A7A5,A7A6:A7A7,A7A8:A7A9,A7AA:266,A7AB:25C,A7AC:261,A7AD:26C,A7AE:26A,A7B0:29E,A7B1:287,A7B2:29D,A7B3:AB53,A7B4:A7B5,A7B6:A7B7,A7B8:A7B9,A7BA:A7BB,A7BC:A7BD,A7BE:A7BF,A7C0:A7C1,A7C2:A7C3,A7C4:A794,A7C5:282,A7C6:1D8E,A7C7:A7C8,A7C9:A7CA,A7D0:A7D1,A7D6:A7D7,A7D8:A7D9,A7F5:A7F6",
        multi: {
            "DF": "0007300073",
            "130": "0006900307",
            "149": "002BC0006E",
            "1F0": "0006A0030C",
            "390": "003B90030800301",
            "3B0": "003C50030800301",
            "587": "0056500582",
            "1E96": "0006800331",
            "1E97": "0007400308",
            "1E98": "000770030A",
            "1E99": "000790030A",
            "1E9A": "00061002BE",
            "1E9E": "0007300073",
            "1F50": "003C500313",
            "1F52": "003C50031300300",
            "1F54": "003C50031300301",
            "1F56": "003C50031300342",
            "1F80": "01F00003B9",
            "1F81": "01F01003B9",
            "1F82": "01F02003B9",
            "1F83": "01F03003B9",
            "1F84": "01F04003B9",
            "1F85": "01F05003B9",
            "1F86": "01F06003B9",
            "1F87": "01F07003B9",
            "1F88": "01F00003B9",
            "1F89": "01F01003B9",
            "1F8A": "01F02003B9",
            "1F8B": "01F03003B9",
            "1F8C": "01F04003B9",
            "1F8D": "01F05003B9",
            "1F8E": "01F06003B9",
            "1F8F": "01F07003B9",
            "1F90": "01F20003B9",
            "1F91": "01F21003B9",
            "1F92": "01F22003B9",
            "1F93": "01F23003B9",
            "1F94": "01F24003B9",
            "1F95": "01F25003B9",
            "1F96": "01F26003B9",
            "1F97": "01F27003B9",
            "1F98": "01F20003B9",
            "1F99": "01F21003B9",
            "1F9A": "01F22003B9",
            "1F9B": "01F23003B9",
            "1F9C": "01F24003B9",
            "1F9D": "01F25003B9",
            "1F9E": "01F26003B9",
            "1F9F": "01F27003B9",
            "1FA0": "01F60003B9",
            "1FA1": "01F61003B9",
            "1FA2": "01F62003B9",
            "1FA3": "01F63003B9",
            "1FA4": "01F64003B9",
            "1FA5": "01F65003B9",
            "1FA6": "01F66003B9",
            "1FA7": "01F67003B9",
            "1FA8": "01F60003B9",
            "1FA9": "01F61003B9",
            "1FAA": "01F62003B9",
            "1FAB": "01F63003B9",
            "1FAC": "01F64003B9",
            "1FAD": "01F65003B9",
            "1FAE": "01F66003B9",
            "1FAF": "01F67003B9",
            "1FB2": "01F70003B9",
            "1FB3": "003B1003B9",
            "1FB4": "003AC003B9",
            "1FB6": "003B100342",
            "1FB7": "003B100342003B9",
            "1FBC": "003B1003B9",
            "1FC2": "01F74003B9",
            "1FC3": "003B7003B9",
            "1FC4": "003AE003B9",
            "1FC6": "003B700342",
            "1FC7": "003B700342003B9",
            "1FCC": "003B7003B9",
            "1FD2": "003B90030800300",
            "1FD3": "003B90030800301",
            "1FD6": "003B900342",
            "1FD7": "003B90030800342",
            "1FE2": "003C50030800300",
            "1FE3": "003C50030800301",
            "1FE4": "003C100313",
            "1FE6": "003C500342",
            "1FE7": "003C50030800342",
            "1FF2": "01F7C003B9",
            "1FF3": "003C9003B9",
            "1FF4": "003CE003B9",
            "1FF6": "003C900342",
            "1FF7": "003C900342003B9",
            "1FFC": "003C9003B9",
            "FB00": "0006600066",
            "FB01": "0006600069",
            "FB02": "000660006C",
            "FB03": "000660006600069",
            "FB04": "00066000660006C",
            "FB05": "0007300074",
            "FB06": "0007300074",
            "FB13": "0057400576",
            "FB14": "0057400565",
            "FB15": "005740056B",
            "FB16": "0057E00576",
            "FB17": "005740056D"
        },
        format: [[0xAD,0xAD],[0x600,0x605],[0x61C,0x61C],[0x6DD,0x6DD],[0x70F,0x70F],[0x890,0x891],[0x8E2,0x8E2],[0x180E,0x180E],[0x200B,0x200F],[0x202A,0x202E],[0x2060,0x2064],[0x2066,0x206F],[0xFEFF,0xFEFF],[0xFFF9,0xFFFB],[0x110BD,0x110BD],[0x110CD,0x110CD],[0x13430,0x1343F],[0x1BCA0,0x1BCA3],[0x1D173,0x1D17A],[0xE0001,0xE0001],[0xE0020,0xE007F]]
    };

    // multi 段每个目标码点占的十六进制位数，必须和生成端的 MULTI_WIDTH 一致。
    var MULTI_WIDTH = 5;
    var singleMap = null;
    var rangeMap = null;

    function buildMaps() {
        if (singleMap) {
            return;
        }
        singleMap = {};
        rangeMap = DATA.ranges.split(",").map(function(entry) {
            var bounds = entry.split(":");
            var span = bounds[0].split("-");
            return {
                start: parseInt(span[0], 16),
                end: parseInt(span[1], 16),
                delta: bounds[1].charAt(0) === "-"
                    ? -parseInt(bounds[1].slice(1), 16)
                    : parseInt(bounds[1], 16)
            };
        });
        DATA.singles.split(",").forEach(function(entry) {
            var parts = entry.split(":");
            singleMap[parseInt(parts[0], 16)] = String.fromCodePoint(parseInt(parts[1], 16));
        });
        Object.keys(DATA.multi).forEach(function(key) {
            var chunk = DATA.multi[key];
            var value = "";
            for (var index = 0; index < chunk.length; index += MULTI_WIDTH) {
                value += String.fromCodePoint(parseInt(chunk.slice(index, index + MULTI_WIDTH), 16));
            }
            singleMap[parseInt(key, 16)] = value;
        });
    }

    // 折叠单个码点：full case folding 是逐字符映射，没有上下文规则
    // （词尾 sigma 那种是 lower 才有的），所以逐点折叠再拼接和整串 casefold 等价。
    function foldCodePoint(codePoint) {
        buildMaps();
        if (typeof codePoint !== "number" || !isFinite(codePoint)) {
            return "";
        }
        var direct = singleMap[codePoint];
        if (direct !== undefined) {
            return direct;
        }
        for (var index = 0; index < rangeMap.length; index += 1) {
            var range = rangeMap[index];
            if (codePoint >= range.start && codePoint <= range.end) {
                return String.fromCodePoint(codePoint + range.delta);
            }
        }
        return String.fromCodePoint(codePoint);
    }

    // 输入必须是已经做过 NFC 的字符串（normalize_food 的顺序就是先 NFC 再折叠）。
    function foldString(value) {
        if (typeof value !== "string") {
            return "";
        }
        var result = "";
        for (var index = 0; index < value.length; index += 1) {
            var codePoint = value.codePointAt(index);
            if (codePoint > 0xFFFF) {
                index += 1;
            }
            result += foldCodePoint(codePoint);
        }
        return result;
    }

    function inRanges(codePoint, ranges) {
        for (var index = 0; index < ranges.length; index += 1) {
            if (codePoint >= ranges[index][0] && codePoint <= ranges[index][1]) {
                return true;
            }
        }
        return false;
    }

    // Unicode 类别 Cf：零宽连接符、方向标记这类"看不见但存在"的字符。
    function isFormatCodePoint(codePoint) {
        return inRanges(codePoint, DATA.format);
    }

    // 类别 Cc（控制字符）与 Cs（代理字符）。换行和制表也在 Cc 里，
    // 和 Python 侧一样属于"不能出现在食物名里"。
    function isForbiddenCodePoint(codePoint) {
        if (codePoint >= 0xD800 && codePoint <= 0xDFFF) {
            return true;
        }
        return codePoint <= 0x1F || (codePoint >= 0x7F && codePoint <= 0x9F);
    }

    return {
        DATA: DATA,
        foldCodePoint: foldCodePoint,
        foldString: foldString,
        isFormatCodePoint: isFormatCodePoint,
        isForbiddenCodePoint: isForbiddenCodePoint
    };
}));
