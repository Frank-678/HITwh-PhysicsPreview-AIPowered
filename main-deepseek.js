// ==UserScript==
// @name         物理实验系统自动答题 Agent (DeepSeek 专属单体版)
// @namespace    http://tampermonkey.net/
// @version      3.0.2.DS
// @description  专门针对 DeepSeek 接口标准优化的批处理自动化架构
// @author       Frank
// @match        *://openlab.hitwh.edu.cn/dxwl/*
// @grant        GM_xmlhttpRequest
// @grant        GM_registerMenuCommand
// @connect      api.deepseek.com
// ==/UserScript==

(function() {
    'use strict';

    // 核心物理配置：剥离所有冗余提供商，仅保留 DeepSeek 环境常量
    const CONFIG = {
        API_KEYS: [
            ""  // 必须真金白银。
        ],
        MODEL: "deepseek-chat", // 严谨约束为 DeepSeek 标准对话模型
        URL: "https://api.deepseek.com/chat/completions",
        DELAY_MS: 3000,
        LOAD_TIMEOUT_MS: 20000, // 题目及页面切换最多等待 20 秒，可按网络情况调整
        MAX_RETRIES: 4
    };

    let currentKeyIndex = 0;

    const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

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

    // 决策模块：硬编码适配 DeepSeek (OpenAI 协议) 规范
    function getBatchDecisionFromAPI(expName, paperText, questionCount) {
        return new Promise((resolve, reject) => {
            const prompt = `你是一个严谨的物理学专家。${expName ? `当前实验是：【${expName}】。` : "实验名称未确认，请以题干和选项为准。"}
请结合该实验的物理原理连贯作答。
要求条件：
1. 大学物理题需要严谨的推导。请针对每一道题，简要写出你的物理公式与思考计算过程。
2. 所有的推理完成后，必须在回复的最末尾，使用 \`\`\`json 和 \`\`\` 包裹输出最终的纯答案数组。
3. 数组元素为正确选项的大写字母。数组长度必须严格等于题目数量（本卷共 ${questionCount} 题）。
输出示例：
(你的物理推导过程...)
\`\`\`json
["A", "B", "C", "D"]
\`\`\`

试卷内容如下：
${paperText}`;

            const activeKey = CONFIG.API_KEYS[currentKeyIndex];

            GM_xmlhttpRequest({
                method: "POST",
                url: CONFIG.URL,
                headers: {
                    "Content-Type": "application/json",
                    "Authorization": `Bearer ${activeKey}` // 严格遵循 Bearer 鉴权标准
                },
                timeout: 45000, // 设定 45 秒超时，容纳大模型长文本的 Time To Last Byte
                data: JSON.stringify({
                    model: CONFIG.MODEL,
                    messages: [{ role: "user", content: prompt }],
                    temperature: 0.1 // 极低温度，压制模型幻觉，确保输出格式具备确定性
                }),
                onload: function(response) {
                    try {
                        if (response.status === 429) {
                            reject("KEY_EXHAUSTED");
                            return;
                        }
                        if (response.status === 402) {
                            console.error("[物理阻断] HTTP 402: 账户余额耗尽，计费网关拒绝服务。");
                            reject("INSUFFICIENT_BALANCE");
                            return;
                        }
                        if (response.status !== 200) {
                            console.error(`[API 状态异常] HTTP ${response.status}: ${response.responseText}`);
                            reject("API_ERROR");
                            return;
                        }

                        const resJson = JSON.parse(response.responseText);
                        const rawText = resJson.choices[0].message.content.trim();

                        console.log("DeepSeek 原始推导回传截取：", rawText.substring(0, 150) + "...");

                        // 正则提取清洗：从思维链推导长文中剥离最终的 JSON 数组
                        const jsonMatch = rawText.match(/```json\s*(\[[^\]]+\])\s*```/i) || rawText.match(/(\[[^\]]+\])/);

                        if (!jsonMatch) {
                            console.error("正则提取失败，未能匹配到数组结构。");
                            reject("PARSE_ERROR");
                            return;
                        }

                        const answerArray = JSON.parse(jsonMatch[1]);
                        if (Array.isArray(answerArray) && answerArray.length === questionCount
                            && answerArray.every(answer => typeof answer === "string" && /^[A-Z]$/.test(answer))) {
                            resolve(answerArray);
                        } else {
                            console.error(`答案数组无效：期望 ${questionCount} 个选项字母。`);
                            reject("LENGTH_MISMATCH");
                        }
                    } catch (e) {
                        console.error("响应报文反序列化或数据提取失败:", e);
                        reject("PARSE_ERROR");
                    }
                },
                onerror: function(err) {
                    console.error("底层网络物理层被截断或浏览器沙盒拦截:", err);
                    reject("NETWORK_ERROR");
                },
                ontimeout: function() { reject("TIMEOUT"); }
            });
        });
    }

    // 主调度：空题暂时跳过，失败实验回目录后继续，避免空卷与无限重试。
    async function runAgent() {
        console.log("Agent (DeepSeek) 启动。");
        while (true) {
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

                let paperText = "";
                const allTargetNodes = [];
                for (const [index, card] of cards.entries()) {
                    const title = card.querySelector("div[style='padding: 12px;'] > div:nth-child(2)").innerText.trim();
                    paperText += `\n第 ${index + 1} 题：${title}\n`;
                    const nodes = [];
                    card.querySelectorAll(".exam-radio").forEach((block, optionIndex) => {
                        const text = block.querySelector(".ant-col-22")?.innerText.trim() || "";
                        paperText += `${String.fromCharCode(65 + optionIndex)}. ${text}\n`;
                        nodes.push(block.querySelector("input[type='radio']"));
                    });
                    allTargetNodes.push(nodes);
                }

                let paperSolved = false;
                for (let attempt = 0; attempt < CONFIG.MAX_RETRIES && samePaper(); attempt++) {
                    try {
                        const answers = await getBatchDecisionFromAPI(experiment?.name || "", paperText, cards.length);
                        if (!samePaper()) break;
                        const targets = answers.map((answer, index) =>
                            allTargetNodes[index][answer.charCodeAt(0) - 65]);
                        if (targets.some(node => !node)) throw new Error("INVALID_ANSWER");
                        targets.forEach(node => node.click());
                        paperSolved = true;
                        break;
                    } catch (err) {
                        if (!samePaper()) break;
                        if (err === "INSUFFICIENT_BALANCE") {
                            console.error("余额不足，脚本已暂停；未提交试卷。");
                            return;
                        }
                        if (err === "KEY_EXHAUSTED") {
                            currentKeyIndex = (currentKeyIndex + 1) % CONFIG.API_KEYS.length;
                        }
                        console.warn(`请求失败（${err}），剩余重试次数：${CONFIG.MAX_RETRIES - attempt - 1}`);
                        if (attempt + 1 < CONFIG.MAX_RETRIES) {
                            await sleep(err === "KEY_EXHAUSTED" ? 60000 : 3000);
                        }
                    }
                }
                if (!samePaper()) continue;
                if (!paperSolved) {
                    skipExperiment(experiment, "达到 API 尝试上限，未提交试卷");
                    return;
                }
                await sleep(1500);
                if (!samePaper()) continue;
                if (!allTargetNodes.every(nodes => nodes.some(node => node?.checked))) {
                    skipExperiment(experiment, "仍有未选答案，未提交试卷");
                    return;
                }
                submitBtn.click();
                if (!await waitFor(() => !samePaper())) {
                    skipExperiment(experiment, "提交后仍停留在答题页，请检查平台提示");
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
