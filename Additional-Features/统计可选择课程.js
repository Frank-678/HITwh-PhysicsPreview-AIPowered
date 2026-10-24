(() => {
  'use strict';

  const CONFIG = { DAYS_AHEAD: 100, TIMEOUT_MS: 20000, POLL_MS: 50 };
  const VERSION = '2026-10-24.1';
  const PANEL_ID = 'hitwh-physics-fast-v6';
  const existing = document.getElementById(PANEL_ID);
  if (existing) {
    const message = '已有扫描器面板，请先刷新页面，再粘贴新版脚本（' + VERSION + '）。';
    const status = existing.querySelector('.log');
    if (status) status.textContent = message;
    console.warn(message);
    alert(message);
    return;
  }

  let running = false;
  let stopped = false;
  let pending = 0;
  let failures = 0;
  let skipped = 0;
  const events = [];
  const results = new Map();
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const compact = value => String(value || '').replace(/\s+/g, '');
  const rawText = el => (el?.innerText || el?.textContent || '').trim();
  const visible = el => !!el && getComputedStyle(el).visibility !== 'hidden'
    && el.getClientRects().length > 0;
  const root = () => [...document.querySelectorAll('.vctch-layout-content.full')].find(visible) || document.body;
  const knownSections = new Map();
  function section(label) {
    const matches = [...root().querySelectorAll('.ant-divider-inner-text')]
      .filter(el => compact(rawText(el)) === label).map(el => el.closest('.ant-divider')?.parentElement);
    const shown = matches.find(visible);
    if (shown) knownSections.set(label, shown);
    const remembered = knownSections.get(label);
    return shown || (matches.includes(remembered) ? remembered : matches[0]);
  }
  const coursesSection = () => section('请在下面选择实验项目');
  const datesSection = () => section('选择预约实验的日期和节次');
  const timesSection = () => section('可选上课时间');
  const rows = area => [...(area?.querySelectorAll('tr.ant-table-row') || [])];
  const cellText = cell => (cell?.getAttribute('title') || rawText(cell)).trim();
  const courseName = row => cellText(row.querySelector('td'));
  const button = (area, name) => [...(area?.querySelectorAll('button') || [])]
    .find(el => compact(rawText(el)) === name);
  const busy = () => [...document.querySelectorAll('.full-loading, .ant-spin-spinning')].some(visible);
  const stage = () => visible(timesSection()) ? 'TIMES'
    : visible(datesSection()) ? 'DATES' : visible(coursesSection()) ? 'COURSES' : 'UNKNOWN';

  function checkStopped() {
    if (stopped) throw new Error('STOPPED');
  }

  async function waitFor(condition, label) {
    const deadline = Date.now() + CONFIG.TIMEOUT_MS;
    while (true) {
      checkStopped();
      const value = condition();
      if (value) return value;
      if (Date.now() >= deadline) throw new Error('等待超时：' + label);
      await sleep(CONFIG.POLL_MS);
    }
  }

  function click(el) {
    checkStopped();
    if (!el) throw new Error('找不到操作目标');
    document.activeElement?.blur();
    el.click();
  }

  async function waitStage(expected) {
    await sleep(0);
    await waitFor(() => stage() === expected && !busy() && !pending, expected);
    await sleep(0);
  }

  async function waitRows(getSection, label) {
    await waitFor(() => rows(getSection()).length
      || [...(getSection()?.querySelectorAll('.ant-empty') || [])].some(visible), label);
  }

  // 只在扫描期间观察请求，结束后恢复；查询失败时不把上一时段的数据当成新结果。
  function trackNetwork() {
    const originalFetch = window.fetch;
    const originalSend = XMLHttpRequest.prototype.send;
    window.fetch = function (...args) {
      pending++;
      try {
        return Promise.resolve(originalFetch.apply(this, args))
          .then(response => { if (!response.ok) failures++; return response; },
            error => { failures++; throw error; })
          .finally(() => pending--);
      } catch (error) {
        pending--;
        failures++;
        throw error;
      }
    };
    XMLHttpRequest.prototype.send = function (...args) {
      pending++;
      const done = () => {
        pending--;
        if (!this.status || this.status >= 400) failures++;
      };
      this.addEventListener('loadend', done, { once: true });
      try {
        return originalSend.apply(this, args);
      } catch (error) {
        this.removeEventListener('loadend', done);
        pending--;
        failures++;
        throw error;
      }
    };
    return () => {
      window.fetch = originalFetch;
      XMLHttpRequest.prototype.send = originalSend;
    };
  }

  async function enterCourse(name) {
    click(rows(coursesSection()).find(row => courseName(row) === name));
    await waitStage('DATES');
    await waitRows(datesSection, '日期列表：' + name);
  }

  async function returnToCourses() {
    if (stage() === 'COURSES') return;
    // 原页面的日期区块即使隐藏，其返回按钮仍负责回到实验目录。
    click(button(datesSection(), '返回'));
    await waitStage('COURSES');
  }

  function normalizeDate(value) {
    const match = String(value || '').trim().match(/^(\d{4})\s*[-/.年]\s*(\d{1,2})\s*[-/.月]\s*(\d{1,2})(?:日|(?=[T\s]|$))/);
    if (!match) return '';
    const [year, month, day] = match.slice(1).map(Number);
    const date = new Date(year, month - 1, day);
    if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) return '';
    return [year, String(month).padStart(2, '0'), String(day).padStart(2, '0')].join('-');
  }

  function dateInfo(row) {
    const cells = [...row.querySelectorAll('td')];
    const dates = cells.map(cell => normalizeDate(cell.getAttribute('title')) || normalizeDate(rawText(cell)));
    const index = dates.findIndex(Boolean);
    return { date: dates[index] || '', week: rawText(cells[index + 1]), weekday: cellText(cells[index + 2]) };
  }

  function withinHorizon(date) {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const limit = new Date(today);
    limit.setDate(limit.getDate() + CONFIG.DAYS_AHEAD);
    const value = new Date(date + 'T00:00:00');
    return value >= today && value <= limit;
  }

  const timeCards = () => [...(timesSection()?.querySelectorAll('.radio-item') || [])]
    .filter(card => /第[一二三四五六七八九十]+大节/.test(rawText(card)));

  function timeInfo(card) {
    const text = rawText(card);
    return {
      period: text.match(/第[一二三四五六七八九十]+大节/)?.[0],
      start: text.match(/开始时间[:：]\s*([0-9:]+)/)?.[1] || ''
    };
  }

  async function queryTime(period) {
    const card = timeCards().find(el => timeInfo(el).period === period);
    click(card?.querySelector('input[type="radio"]') || card);
    await sleep(0);
    const beforeFailures = failures;
    click(button(timesSection(), '查询'));
    // 给点击处理、缓存读取和渲染一个事件循环；只有实际加载时才继续等待。
    await sleep(0);
    await waitFor(() => !pending && !busy(), period);
    await sleep(0);
    checkStopped();
    if (failures !== beforeFailures) throw new Error('查询请求失败：' + period);
    const area = timesSection();
    const seats = [...area.querySelectorAll('.ant-card')]
      .filter(el => /座位\s*[:：]\s*\d+/.test(rawText(el)));
    return {
      free: seats.filter(el => /状态\s*[:：]\s*空闲/.test(rawText(el))).length,
      total: seats.length,
      room: rawText(area).match(/实验室名称\s*[:：]\s*([^\n\r]+)/)?.[1]?.trim() || ''
    };
  }

  async function scanAll() {
    if (running) return;
    if (stage() !== 'COURSES') {
      alert('请先手动回到“预约选课”的实验列表。');
      return;
    }
    running = true;
    stopped = false;
    skipped = 0;
    events.length = 0;
    results.clear();
    render();
    const restoreNetwork = trackNetwork();
    try {
      await waitRows(coursesSection, '实验列表');
      const courses = rows(coursesSection()).map(courseName)
        .filter(name => name && !/^\d{4}-\d{2}-\d{2}$/.test(name));
      if (!courses.length) throw new Error('未识别到实验名称，请导出诊断');
      for (const [index, course] of courses.entries()) {
        checkStopped();
        log(`[${index + 1}/${courses.length}] ${course}`);
        await enterCourse(course);
        const dateRows = rows(datesSection());
        const recognized = dateRows.map(dateInfo).filter(row => row.date);
        if (dateRows.length && !recognized.length) throw new Error('无法识别日期列，请导出诊断：' + course);
        const dates = recognized.filter(row => withinHorizon(row.date));
        log(`${course}：日期 ${dateRows.length} 行，识别 ${recognized.length} 行，未来 ${CONFIG.DAYS_AHEAD} 天内 ${dates.length} 行`);
        if (!dates.length) skipped++;
        await returnToCourses();
        for (const date of dates) {
          checkStopped();
          try {
            await enterCourse(course);
            click(rows(datesSection()).find(row => dateInfo(row).date === date.date));
            await waitStage('TIMES');
            for (const time of timeCards().map(timeInfo)) {
              checkStopped();
              log(`${course}：${date.date} ${time.period}`);
              try {
                const seats = await queryTime(time.period);
                const value = { course, ...date, ...time, ...seats };
                results.set(JSON.stringify([course, date.date, time.period]), value);
                render();
              } catch (error) {
                if (stopped) throw error;
                skipped++;
                console.warn('[时段查询失败]', course, date.date, time.period, error);
                log(`查询失败：${course} ${date.date} ${time.period}，已跳过`);
              }
            }
          } catch (error) {
            if (stopped) throw error;
            skipped++;
            console.warn('[日期查询失败]', course, date.date, error);
            log(`日期查询失败：${course} ${date.date}，已跳过`);
          }
          await returnToCourses();
        }
      }
      log(`完成：扫描 ${results.size} 个时段，${[...results.values()].filter(row => row.free > 0).length} 个有空位，跳过/失败 ${skipped} 项`);
    } catch (error) {
      if (!stopped) console.error('[扫描中断]', error);
      log(stopped ? `已停止，保留 ${results.size} 条结果` : '扫描中断：' + error.message + '；可导出诊断');
    } finally {
      restoreNetwork();
      running = false;
      render();
    }
  }

  function exportCsv() {
    const fields = ['course', 'date', 'weekday', 'week', 'period', 'start', 'free', 'total', 'room'];
    const data = [['实验', '日期', '星期', '周次', '大节', '开始时间', '空闲座位', '总座位', '实验室'],
      ...[...results.values()].map(row => fields.map(key => row[key]))];
    const csv = '\uFEFF' + data.map(row => row.map(value =>
      '"' + String(value ?? '').replace(/"/g, '""') + '"').join(',')).join('\n');
    download('大物实验空余时段.csv', 'text/csv;charset=utf-8', csv);
  }

  function download(name, type, content) {
    const link = document.createElement('a');
    link.href = URL.createObjectURL(new Blob([content], { type }));
    link.download = name;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(link.href), 1000);
  }

  function exportDiagnostic() {
    const preview = area => rows(area).slice(0, 5).map(row => [...row.querySelectorAll('td')]
      .map(cell => ({ text: rawText(cell), title: cell.getAttribute('title') })));
    const report = { version: VERSION, computerTime: new Date().toString(), stage: stage(),
      pendingRequests: pending, resultCount: results.size, skipped,
      courses: preview(coursesSection()), dates: preview(datesSection()),
      headings: [...root().querySelectorAll('.ant-divider-inner-text')].map(el =>
        ({ text: rawText(el), visible: visible(el) })), events };
    download('大物实验扫描诊断.json', 'application/json;charset=utf-8', JSON.stringify(report, null, 2));
  }

  const esc = value => String(value ?? '').replace(/[&<>"']/g,
    ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));

  function render() {
    panel.querySelector('.start').disabled = running;
    panel.querySelector('.stop').disabled = !running || stopped;
    const sorted = [...results.values()].sort((a, b) => a.date.localeCompare(b.date)
      || a.course.localeCompare(b.course) || a.period.localeCompare(b.period));
    panel.querySelector('tbody').innerHTML = sorted.map(row =>
      `<tr class="${row.free > 0 ? 'free' : 'full'}"><td>${esc(row.course)}</td>
      <td>${esc(row.date)}<br><small>${esc(row.weekday)}</small></td>
      <td>${esc(row.period)}<br>${esc(row.start)}</td><td>${row.free}/${row.total}</td>
      <td>${esc(row.room || '-')}</td></tr>`).join('');
    panel.querySelector('.stats').textContent = `结果 ${results.size} | 有空位 ${sorted.filter(row => row.free > 0).length} | 跳过/失败 ${skipped}`;
  }

  function log(message) {
    events.push({ time: new Date().toLocaleTimeString(), message });
    if (events.length > 50) events.shift();
    console.log('[空余时段扫描器]', message);
    panel.querySelector('.log').textContent = message;
  }

  const panel = document.createElement('div');
  panel.id = PANEL_ID;
  panel.innerHTML = `
    <style>
      #${PANEL_ID}{position:fixed;right:12px;bottom:12px;width:780px;max-width:calc(100vw - 24px);max-height:72vh;z-index:2147483647;background:white;color:#222;border:1px solid #aaa;border-radius:8px;box-shadow:0 6px 24px #0003;font:14px/1.4 sans-serif;overflow:hidden}
      #${PANEL_ID} .head,#${PANEL_ID} .actions{display:flex;gap:10px;align-items:center;padding:9px 12px;border-bottom:1px solid #eee;flex-wrap:wrap}
      #${PANEL_ID} .head{background:#f5f6f7}
      #${PANEL_ID} .log{flex:1;color:#666;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}
      #${PANEL_ID} .stats{margin-left:auto;color:#666;font-size:12px}
      #${PANEL_ID} button{padding:5px 9px;cursor:pointer}
      #${PANEL_ID} .body{max-height:54vh;overflow:auto}
      #${PANEL_ID} table{width:100%;border-collapse:collapse;font-size:12px}
      #${PANEL_ID} th,#${PANEL_ID} td{padding:6px;border-bottom:1px solid #eee;text-align:left;vertical-align:top}
      #${PANEL_ID} th{position:sticky;top:0;background:#fafafa}
      #${PANEL_ID} tr.free{background:#f3fff3}
      #${PANEL_ID} tr.full{opacity:.55}
    </style>
    <div class="head"><b>空余时段扫描 ${VERSION}</b><span class="log">待机</span></div>
    <div class="actions"><button class="start">扫描未来 ${CONFIG.DAYS_AHEAD} 天</button>
      <button class="stop">停止</button><button class="csv">导出 CSV</button>
      <button class="diagnostic">导出诊断</button><span class="stats"></span></div>
    <div class="body"><table><thead><tr><th>实验</th><th>日期</th><th>大节</th>
      <th>空闲/总数</th><th>实验室</th></tr></thead><tbody></tbody></table></div>`;
  document.body.appendChild(panel);
  panel.querySelector('.start').onclick = scanAll;
  panel.querySelector('.stop').onclick = () => { stopped = true; log('正在停止…'); render(); };
  panel.querySelector('.csv').onclick = exportCsv;
  panel.querySelector('.diagnostic').onclick = exportDiagnostic;
  render();
})();
