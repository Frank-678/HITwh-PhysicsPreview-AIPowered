// ==UserScript==
// @name         物理实验系统自动答题 Agent
// @namespace    http://tampermonkey.net/
// @version      2.1.1
// @description  基于真实 DOM 结构的自动化考试执行脚本
// @author       Frank
// @match        http://openlab.hitwh.edu.cn/dxwl/*
// @grant        GM_xmlhttpRequest
// @grant        GM_registerMenuCommand
// @connect      generativelanguage.googleapis.com
// @run-at       document-idle
// ==/UserScript==

(function() {
    'use strict';

const CONFIG = {
        API_KEY: "",
        MODEL: "gemini-2.5-flash",
        DELAY_MS: 3000,
        LOAD_TIMEOUT_MS: 20000, // 题目及页面切换最多等待 20 秒，可按网络情况调整
        MAX_RETRIES: 4
    };

    const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

    // 辅助函数：判断 DOM 元素在页面上是否真实可见
    function isVisible(elem) {
        return !!(elem && elem.offsetWidth > 0 && elem.offsetHeight > 0 && elem.offsetParent !== null);
    }



    const SKIP_KEY = "LSM_SKIPPED_EXPERIMENTS";
    let skippedExperiments;
    try {
        skippedExperiments = new Set(JSON.parse(sessionStorage.getItem(SKIP_KEY) || "[]"));
    } catch (_) {
        skippedExperiments = new Set();
    }
    let currentExperiment = null;
    let openingSince = 0;

    function getExperiment(row) {
        const name = row.querySelector("span[style*='font-weight: bold']")?.innerText.trim()
            || row.innerText.split("\n")[0].trim();
        return { id: row.getAttribute("data-row-key") || name, name };
    }

    // 捕获手动和自动点击，避免沿用上一个实验名称。
    document.addEventListener("click", event => {
        const row = event.target.closest?.("tr.ant-table-row");
        if (row && isVisible(row) && row.innerText.includes("未通过") && row.innerText.includes("可考试")) {
            currentExperiment = getExperiment(row);
            openingSince = Date.now();
        }
    }, true);

    GM_registerMenuCommand("重新尝试已跳过实验", () => {
        sessionStorage.removeItem(SKIP_KEY);
        location.reload();
    });

    function skipExperiment(experiment, reason) {
        if (experiment) {
            skippedExperiments.add(experiment.id);
            sessionStorage.setItem(SKIP_KEY, JSON.stringify([...skippedExperiments]));
        }
        console.warn(`暂时跳过【${experiment?.name || "未确认的实验"}】：${reason}。可从脚本菜单重新尝试。`);
        location.reload();
    }

    async function waitFor(test) {
        const deadline = Date.now() + CONFIG.LOAD_TIMEOUT_MS;
        while (!test()) {
            if (Date.now() >= deadline) return false;
            await sleep(500);
        }
        return true;
    }

    async function waitForQuestions(samePaper) {
        let cards = [];
        const ready = await waitFor(() => {
            cards = Array.from(document.querySelectorAll(".ant-card-bordered"))
                .filter(card => isVisible(card) && card.innerText.includes("试题:"));
            const loading = Array.from(document.querySelectorAll(".full-loading, .ant-spin-spinning")).some(isVisible);
            return !samePaper() || (!loading && cards.length > 0 && cards.every(card =>
                card.querySelector("div[style='padding: 12px;'] > div:nth-child(2)")?.innerText.trim()
                && card.querySelector(".exam-radio input[type='radio']")));
        });
        return ready ? cards : [];
    }

// 决策模块：调用大模型（附带底层现象探针与防并发限流机制）
    function getDecisionFromAPI(question, options) {
        return new Promise((resolve, reject) => {
            const prompt = `你是一个严谨的物理学专家。请回答下面的单选题。要求：只输出正确选项的大写字母（例如 A、B、C 或 D），绝对不要输出任何解析或标点符号。\n\n题目：${question}\n选项：\n${options}`;

            GM_xmlhttpRequest({
                method: "POST",
                url: `https://generativelanguage.googleapis.com/v1beta/models/${CONFIG.MODEL}:generateContent?key=${CONFIG.API_KEY}`,
                headers: { "Content-Type": "application/json" },
                timeout: 45000,
                data: JSON.stringify({
                    contents: [{ parts: [{ text: prompt }] }]
                }),
                onload: function(response) {
                    try {
                        // 【现象探针】：严谨打印 HTTP 状态码与未经修饰的原始响应体
                        if (response.status !== 200) {
                            console.error(`[API 异常] HTTP 状态码: ${response.status}`);
                            console.error(`[API 响应报文]: ${response.responseText}`);
                            reject(`API 请求失败，状态码被拒绝`);
                            return;
                        }

                        const resJson = JSON.parse(response.responseText);

                        // 校验条件：检查字段是否存在，避免 TypeError 导致脚本崩溃
                        if (!resJson.candidates || resJson.candidates.length === 0) {
                            console.error(`[API 结构异常] 原始报文: ${response.responseText}`);
                            reject("API 返回了非预期的 JSON 结构（缺失 candidates）");
                            return;
                        }

                        const answer = resJson.candidates[0].content.parts[0].text.trim().toUpperCase();
                        const match = answer.match(/^[A-D]$/);
                        if (!match) throw new Error("INVALID_ANSWER");
                        resolve(match[0]);
                    } catch (e) {
                        console.error("[解析层严重错误]:", e);
                        reject("大模型返回数据解析异常");
                    }
                },
                ontimeout: function() { reject("TIMEOUT"); },
                onerror: function(err) {
                    console.error("[底层网络错误]: 无法连接到目标服务器");
                    reject("网络请求底层的通信错误");
                }
            });
        });
    }

    // 主调度：空题暂时跳过，失败时暂停，避免提交不完整试卷。
    async function runAgent() {
        console.log("Agent (Gemini) 启动。");
        agentLoop: while (true) {
            await sleep(CONFIG.DELAY_MS);
            const buttons = Array.from(document.querySelectorAll("button"));
            const submitBtn = buttons.find(b => b.innerText.includes("提交答案") && isVisible(b));
            const returnBtn = buttons.find(b => b.innerText.replace(/\s/g, "") === "返回" && isVisible(b));

            if (submitBtn) {
                openingSince = 0;
                const experiment = currentExperiment;
                const samePaper = () => currentExperiment === experiment && isVisible(submitBtn);
                const cards = await waitForQuestions(samePaper);
                if (!samePaper()) continue;
                if (!cards.length) {
                    skipExperiment(experiment, "等待题目超时，可能尚未发布或加载失败");
                    return;
                }

                for (const card of cards) {
                    const title = card.querySelector("div[style='padding: 12px;'] > div:nth-child(2)").innerText.trim();
                    let optionsText = "";
                    const nodes = [];
                    card.querySelectorAll(".exam-radio").forEach((block, index) => {
                        const text = block.querySelector(".ant-col-22")?.innerText.trim() || "";
                        optionsText += `${String.fromCharCode(65 + index)}. ${text}\n`;
                        nodes.push(block.querySelector("input[type='radio']"));
                    });
                    let solved = false;
                    for (let attempt = 0; attempt < CONFIG.MAX_RETRIES && samePaper(); attempt++) {
                        try {
                            const answer = await getDecisionFromAPI(title, optionsText);
                            if (!samePaper()) continue agentLoop;
                            const target = nodes[answer.charCodeAt(0) - 65];
                            if (!target) throw new Error("INVALID_ANSWER");
                            target.click();
                            await sleep(500);
                            solved = true;
                            break;
                        } catch (err) {
                            if (!samePaper()) continue agentLoop;
                            console.warn(`请求失败（${err}），剩余重试次数：${CONFIG.MAX_RETRIES - attempt - 1}`);
                            if (attempt + 1 < CONFIG.MAX_RETRIES) await sleep(3000);
                        }
                    }
                    if (!samePaper()) continue agentLoop;
                    if (!solved) {
                        console.error("达到重试上限，脚本已暂停；未提交试卷。");
                        return;
                    }
                }
                if (!samePaper()) continue;
                if (!cards.every(card => card.querySelector("input[type='radio']:checked"))) {
                    console.error("仍有未选答案，脚本已暂停；未提交试卷。");
                    return;
                }
                submitBtn.click();
                if (!await waitFor(() => !samePaper())) {
                    console.error("提交后仍停留在答题页，请检查平台提示；脚本已暂停。");
                    return;
                }
                continue;
            }

            if (returnBtn) {
                returnBtn.click();
                await sleep(CONFIG.DELAY_MS);
                location.reload();
                return;
            }

            if (openingSince) {
                if (Date.now() - openingSince >= CONFIG.LOAD_TIMEOUT_MS) {
                    skipExperiment(currentExperiment, "未能进入答题页");
                    return;
                }
                continue;
            }

            for (const row of document.querySelectorAll("tr.ant-table-row")) {
                const text = row.innerText;
                if (!isVisible(row) || text.includes("下次准考时间")
                    || !text.includes("未通过") || !text.includes("可考试")) continue;
                if (skippedExperiments.has(getExperiment(row).id)) continue;
                row.click();
                break;
            }
        }
    }

    setTimeout(runAgent, 3000);
})();
