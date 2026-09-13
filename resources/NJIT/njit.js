/**
 * 南京工程学院 研究生教育教学管理系统（南软 GMIS 5.0）拾光课程表适配脚本
 *
 * 数据来源（均为同源 XHR，登录后带会话 Cookie 直接 fetch）：
 *   GET  /gmis5/student/default/bindterm        -> 当前绑定学期 { termcode: "50", ... }
 *   POST /gmis5/student/pygl/py_kbcx_yw         -> 课表数据  body: termcode=<code>
 *   POST /gmis5/student/pygl/py_kbcx_ew         -> 备用接口  body: kblx=xs&termcode=<code>
 *
 * 返回字段（2026-09 实测确认）：
 *   kcmc 课程名称、rkjsxm 任课教师、dz 上课教室、sjms 时间描述、
 *   lxfs 周类型（连续周/单周/双周）、ksz/jsz 起止周、
 *   jdid 同一课程的多条周次段（自动合并为周次并集）
 *
 * sjms 格式："星期四 晚上1-晚上2" 或 "星期一 下午1-下午2,星期四 下午1-下午2"，
 *   逗号分隔多个时段；节次为节内编号（上午1-4 → 第1~4节，下午1-4 → 第5~8节，晚上1-3 → 第9~11节）。
 *
 * 作息（南京工程学院研究生）：
 *   第1-4节  08:00-08:45 / 08:55-09:40 / 10:10-10:55 / 11:05-11:50
 *   第5-8节  13:40-14:25 / 14:35-15:20 / 15:40-16:25 / 16:35-17:20
 *   第9-11节 18:30-19:15 / 19:25-20:10 / 20:20-21:05
 */

(function () {
    "use strict";

    if (!window.shiguangBridge || !window.shiguangBridgePromise) {
        try { shiguangBridge.showToast("桥未就绪，请通过“执行导入”运行本脚本"); } catch (e) { /* ignore */ }
        return;
    }

    // ============================================================================
    // 作息时段
    // ============================================================================

    var NJIT_PRESET_TIME_SLOTS = [
        { "number": 1, "startTime": "08:00", "endTime": "08:45" },
        { "number": 2, "startTime": "08:55", "endTime": "09:40" },
        { "number": 3, "startTime": "10:10", "endTime": "10:55" },
        { "number": 4, "startTime": "11:05", "endTime": "11:50" },
        { "number": 5, "startTime": "13:40", "endTime": "14:25" },
        { "number": 6, "startTime": "14:35", "endTime": "15:20" },
        { "number": 7, "startTime": "15:40", "endTime": "16:25" },
        { "number": 8, "startTime": "16:35", "endTime": "17:20" },
        { "number": 9, "startTime": "18:30", "endTime": "19:15" },
        { "number": 10, "startTime": "19:25", "endTime": "20:10" },
        { "number": 11, "startTime": "20:20", "endTime": "21:05" }
    ];

    // ============================================================================
    // 工具函数
    // ============================================================================

    function tryParse(text) {
        if (!text) return null;
        try { return JSON.parse(text); } catch (e) { return null; }
    }

    /** 同源请求，自动携带 Cookie；GET 追加时间戳防缓存 */
    function apiFetch(url, body) {
        if (!body) {
            url += (url.indexOf("?") === -1 ? "?" : "&") + "_=" + Date.now();
        }
        var opts = {
            method: body ? "POST" : "GET",
            credentials: "include",
            headers: {
                "X-Requested-With": "XMLHttpRequest",
                "Accept": "application/json, text/javascript, */*; q=0.01"
            }
        };
        if (body) {
            opts.headers["Content-Type"] = "application/x-www-form-urlencoded;charset=UTF-8";
            opts.body = body;
        }
        return fetch(url, opts).then(function (resp) {
            if (!resp.ok) throw new Error("HTTP " + resp.status);
            return resp.text();
        });
    }

    /** 根据 lxfs 类型与起止周生成周次数组（连续/单周/双周） */
    function parseWeeks(lxfs, ksz, jsz) {
        var out = [];
        if (ksz === null || ksz === undefined || jsz === null || jsz === undefined) return out;
        var a = parseInt(ksz, 10), b = parseInt(jsz, 10);
        if (isNaN(a) || isNaN(b)) return out;
        if (a > b) { var t = a; a = b; b = t; }
        var odd = String(lxfs || "").indexOf("单") !== -1;
        var even = String(lxfs || "").indexOf("双") !== -1;
        for (var w = a; w <= b; w++) {
            if (odd && w % 2 === 0) continue;
            if (even && w % 2 === 1) continue;
            out.push(w);
        }
        return out;
    }

    /** 解析时间描述："星期四 晚上1-晚上2,星期五 上午3-上午4" → [{day,start,end},…] */
    function parseSjms(sjms) {
        var out = [];
        var segs = String(sjms || "").split(/[,，]/);
        for (var i = 0; i < segs.length; i++) {
            var s = segs[i].trim();
            if (!s) continue;
            var m = s.match(/星期([一二三四五六日天])\s*(上午|下午|晚上)(\d+)\s*[-~至]\s*(上午|下午|晚上)?(\d+)/);
            if (!m) {
                console.warn("时间描述解析失败:", sjms);
                continue;
            }
            var day = "一二三四五六日天".indexOf(m[1]) + 1;
            var offset = { "上午": 0, "下午": 4, "晚上": 8 }[m[2]];
            var start = parseInt(m[3], 10) + offset;
            var offsetEnd = m[4] ? { "上午": 0, "下午": 4, "晚上": 8 }[m[4]] : offset;
            var end = parseInt(m[5], 10) + offsetEnd;
            if (end < start) { var t = start; start = end; end = t; }
            out.push({ day: day, start: start, end: end });
        }
        return out;
    }

    /** 等待登录：bindterm 有有效响应即视为已登录，默认 60 秒超时 */
    function waitForLogin(timeoutMs) {
        return new Promise(function (resolve) {
            var deadline = Date.now() + (timeoutMs || 60000);

            function check() {
                apiFetch("/gmis5/student/default/bindterm", null)
                    .then(tryParse)
                    .then(function (json) {
                        if (json !== null && json !== undefined) {
                            resolve(true);
                        } else if (Date.now() > deadline) {
                            resolve(false);
                        } else {
                            setTimeout(check, 2000);
                        }
                    })
                    .catch(function () {
                        if (Date.now() > deadline) resolve(false);
                        else setTimeout(check, 2000);
                    });
            }
            check();
        });
    }

    /** 取学期代码，失败时用传入默认值 */
    function fetchTermCode(defaultCode) {
        return apiFetch("/gmis5/student/default/bindterm", null)
            .then(tryParse)
            .then(function (json) {
                if (json) {
                    var t = json.termcode || json.termCode || json.TERMCODE || json.current;
                    if (t !== null && t !== undefined && String(t) !== "") return String(t);
                }
                return defaultCode;
            })
            .catch(function () { return defaultCode; });
    }

    /** 拉课表：优先 py_kbcx_yw，其次 py_kbcx_ew */
    function fetchTimetable(termcode) {
        return apiFetch("/gmis5/student/pygl/py_kbcx_yw", "termcode=" + encodeURIComponent(termcode))
            .then(function (text) {
                var json = tryParse(text);
                var rows = Array.isArray(json) ? json : (json && Array.isArray(json.rows) ? json.rows : []);
                if (rows.length > 0) {
                    return { rows: rows, source: "py_kbcx_yw" };
                }
                return apiFetch("/gmis5/student/pygl/py_kbcx_ew",
                    "kblx=xs&termcode=" + encodeURIComponent(termcode))
                    .then(function (text2) {
                        var json2 = tryParse(text2);
                        var rows2 = Array.isArray(json2) ? json2 : (json2 && Array.isArray(json2.rows) ? json2.rows : []);
                        return { rows: rows2, source: "py_kbcx_ew" };
                    });
            });
    }

    // ============================================================================
    // 主流程
    // ============================================================================

    async function run() {
        // 1. 域检查：必须在研究生教务系统页面执行
        var currentUrl = window.location.href || "";
        if (currentUrl.indexOf("gmis5") === -1) {
            await window.shiguangBridgePromise.showAlert(
                "请先进入教务系统",
                "当前页面不在研究生教务系统上。\n\n请先在页面中打开：\nhttp://yjsjy.njit.edu.cn/gmis5/student/default/index\n完成统一身份认证登录并停留在学生端页面后，再点\"执行导入\"。",
                "知道了"
            );
            shiguangBridge.notifyTaskCompletion();
            return;
        }

        shiguangBridge.showToast("检查登录状态…（若尚未登录，请登录完成后重新点\"执行导入\"）");

        // 2. 等登录
        var loggedIn = await waitForLogin(60000);
        if (!loggedIn) {
            await window.shiguangBridgePromise.showAlert(
                "未检测到登录",
                "60 秒内未获取到登录状态。\n\n请确认：\n1. 已通过统一身份认证登录成功；\n2. 当前页面停留在登录后的研究生教务系统（地址含 gmis5）；\n然后重新点\"执行导入\"。",
                "好的"
            );
            shiguangBridge.notifyTaskCompletion();
            return;
        }

        // 3. 取学期 + 拉课表
        var termcode = await fetchTermCode("50");
        shiguangBridge.showToast("正在获取课表 (termcode=" + termcode + ")…");
        var result = await fetchTimetable(termcode);
        var rows = result.rows || [];

        if (rows.length === 0) {
            await window.shiguangBridgePromise.showAlert(
                "未获取到课表数据",
                "接口没有返回课程。可尝试：\n1. 在网页中手动打开「培养管理 → 学生课表查询」后重试；\n2. 确认当前学期有排课。",
                "好的"
            );
            shiguangBridge.notifyTaskCompletion();
            return;
        }

        // 4. 按 课程编号+时间描述 分组，合并周次（jdid 多周段取并集），再按 sjms 时段拆分
        var groups = {};
        rows.forEach(function (r) {
            var key = (r.kcbh || "") + "|" + (r.sjms || "");
            (groups[key] = groups[key] || []).push(r);
        });

        var payload = [];
        Object.keys(groups).forEach(function (key) {
            var g = groups[key];
            var weeksSet = {};
            g.forEach(function (r) {
                parseWeeks(r.lxfs, r.ksz, r.jsz).forEach(function (w) { weeksSet[w] = true; });
            });
            var weeks = Object.keys(weeksSet).map(Number).sort(function (a, b) { return a - b; });
            if (weeks.length === 0) return;

            var dzSet = {};
            g.forEach(function (r) { if (r.dz) dzSet[r.dz] = true; });
            var position = Object.keys(dzSet).join("、");

            var first = g[0];
            var name = first.kcmc || first.bjmc || "未知课程";
            var teacher = first.rkjsxm || "";

            parseSjms(first.sjms).forEach(function (ts) {
                payload.push({
                    name: name,
                    teacher: teacher,
                    position: position,
                    day: ts.day,
                    startSection: ts.start,
                    endSection: ts.end,
                    weeks: weeks
                });
            });
        });

        if (payload.length === 0) {
            await window.shiguangBridgePromise.showAlert(
                "解析失败",
                "共 " + rows.length + " 条原始记录，但没有解析出可用课程。\n请把「原始返回」反馈给维护者（可参考 raw 数据）。",
                "好的"
            );
            shiguangBridge.notifyTaskCompletion();
            return;
        }

        // 5. 导入课程 + 作息 + 配置
        var saved = await window.shiguangBridgePromise.saveImportedCourses(JSON.stringify(payload));
        if (saved !== true) {
            shiguangBridge.showToast("课程导入失败：" + saved);
            shiguangBridge.notifyTaskCompletion();
            return;
        }

        try {
            await window.shiguangBridgePromise.savePresetTimeSlots(JSON.stringify(NJIT_PRESET_TIME_SLOTS));
        } catch (e) { /* 作息保存失败不影响课程导入 */ }

        var maxWeek = 1;
        payload.forEach(function (c) {
            c.weeks.forEach(function (w) { if (w > maxWeek) maxWeek = w; });
        });

        try {
            await window.shiguangBridgePromise.saveCourseConfig(JSON.stringify({
                semesterTotalWeeks: maxWeek
            }));
        } catch (e) { /* 配置保存失败不影响课程导入 */ }

        await window.shiguangBridgePromise.showAlert(
            "导入完成",
            "成功导入 " + payload.length + " 条课程（原始记录 " + rows.length + " 条，来源 " + result.source + "），作息时段已同步写入。\n\n如有课程时间/周次显示异常，请把课程名反馈给维护者。",
            "好的"
        );
        shiguangBridge.notifyTaskCompletion();
    }

    run().catch(async function (err) {
        try {
            await window.shiguangBridgePromise.showAlert(
                "脚本异常",
                "发生错误：" + (err && err.message ? err.message : String(err)),
                "好的"
            );
        } catch (e) { /* ignore */ }
        try { shiguangBridge.notifyTaskCompletion(); } catch (e) { /* ignore */ }
    });
})();
