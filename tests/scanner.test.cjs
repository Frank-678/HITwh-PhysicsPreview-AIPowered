const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const code = fs.readFileSync(__dirname + '/../Additional-Features/统计可选择课程.js', 'utf8');

async function scenario(options = {}) {
  let now = new Date('2026-10-21T08:00:00').getTime();
  const timers = [], downloads = [], logs = [], blobs = new Map();
  const state = { stage: options.wrongStage ? 'DATES' : 'COURSES', course: '', date: '', period: '', seats: [], queries: 0, reservations: 0 };
  const schedule = (fn, delay = 0) => timers.push({ fn, at: now + delay });
  const element = (text = '', shown = () => true) => ({
    innerText: text, textContent: text, disabled: false, style: {},
    getClientRects: () => shown() ? [{}] : [], blur() {}, remove() {},
    getAttribute() { return null; }, querySelector() { return null; }, querySelectorAll() { return []; }
  });
  const fields = Object.fromEntries(['.start', '.stop', '.csv', '.diagnostic', '.stats', '.log', 'tbody'].map(key => [key, element()]));
  const panel = { ...element(), querySelector: key => fields[key] };
  const courses = ['实验 "甲"<测试>', '实验乙'];
  const dateValues = options.invalidDates ? ['十月二十一日'] : options.pastDates ? ['2026-09-01']
    : ['2026-10-20', '2026-10-21', '2026-10-22', '2027-01-30'];
  const displayDate = date => options.dateStyle === 'slash' ? date.replace(/-/g, '/')
    : options.dateStyle === 'chinese' ? date.replace(/-(\d+)-(\d+)/, (_, m, d) => '年' + Number(m) + '月' + Number(d) + '日')
    : options.dateStyle === 'timestamp' ? date + ' 00:00:00' : date;
  const areas = Object.fromEntries(['COURSES', 'DATES', 'TIMES'].map(name => [name, element('', () => state.stage === name)]));
  const cell = value => ({ ...element(value), getAttribute: name => name === 'title'
    ? options.badDateTitle && /^\d{4}/.test(value) ? '查看日期详情' : value : null });
  const row = (cells, handler) => ({ ...element(), querySelector: () => cell(cells[0]),
    querySelectorAll: () => cells.map(cell), click: handler });
  areas.COURSES.querySelectorAll = selector => selector === '.ant-empty' && options.emptyCourses ? [element()]
    : selector === 'tr.ant-table-row' && !options.emptyCourses ? courses.map(name =>
      row([name], () => { state.course = name; state.stage = 'DATES'; state.dateReadyAt = now + (options.dateDelay || 0); })) : [];
  const back = { ...element('返 回'), click() { state.stage = 'COURSES'; } };
  areas.DATES.querySelectorAll = selector => selector === 'button' ? [back]
    : selector === '.ant-empty' && options.emptyDates ? [element()]
    : selector === 'tr.ant-table-row' && !options.emptyDates && now >= (state.dateReadyAt || 0)
      ? dateValues.map(date => row([...(options.checkbox ? [''] : []), displayDate(date), '8', '星期三'],
        () => { state.date = date; state.stage = 'TIMES'; })) : [];
  const radios = ['第一大节', '第二大节'].map((period, index) => {
    const input = { ...element(), click() { state.period = period; } };
    return { ...element(period + '\n开始时间：' + (index ? '10:00' : '08:00')), querySelector: () => input };
  });
  const seatData = () => Array.from({ length: 3 }, (_, i) => element('座位：' + (i + 1) + '\n状态：' + (i < (options.full ? 0 : 2) ? '空闲' : '占用')));
  let loading = false;
  function queryResponse() {
    const failed = options.httpError && state.period === '第二大节';
    if (!failed) state.seats = seatData();
    return { ok: !failed, status: failed ? 500 : 200 };
  }
  class XHR {
    constructor() { this.listeners = new Map(); this.status = 0; }
    addEventListener(name, fn) { this.listeners.set(name, fn); }
    removeEventListener(name) { this.listeners.delete(name); }
    open() {}
    send() {
      loading = true;
      schedule(() => { this.status = queryResponse().status; loading = false; this.listeners.get('loadend')?.(); }, options.delay || 0);
    }
  }
  const originalFetch = () => {
    loading = true;
    return new Promise(resolve => schedule(() => { const response = queryResponse(); loading = false; resolve(response); }, options.delay || 0));
  };
  const originalSend = XHR.prototype.send;
  const window = { fetch: originalFetch };
  const query = { ...element('查 询'), click() {
    state.queries++;
    if (options.cache) { queryResponse(); return; }
    if (options.xhr) { new XHR().send(); return; }
    window.fetch('/query').catch(() => {});
  } };
  const reserve = { ...element('预约'), click() { state.reservations++; } };
  areas.TIMES.querySelectorAll = selector => selector === '.radio-item' ? radios : selector === '.ant-card' ? state.seats
    : selector === 'button' ? [reserve, query] : [];
  Object.defineProperty(areas.TIMES, 'innerText', { get: () => '实验室名称：N"<实验室>\n' + state.seats.map(s => s.innerText).join('\n') });
  const names = ['请在下面选择实验项目', '选择预约实验的日期和节次', '可选上课时间'];
  const headings = names.map((name, i) => ({ ...element(name), closest: () => ({ parentElement: areas[['COURSES', 'DATES', 'TIMES'][i]] }) }));
  if (options.duplicateSection) headings.unshift({ ...element(names[1]), closest: () => ({ parentElement: element('', () => false) }) });
  const root = { ...element(), querySelectorAll: () => headings };
  let mounted = !!options.existingPanel;
  const document = {
    activeElement: element(), body: { appendChild(el) { if (el === panel) mounted = true; } },
    getElementById: () => mounted ? panel : null,
    querySelector: selector => selector === '.vctch-layout-content.full' ? root : null,
    querySelectorAll: selector => selector === '.vctch-layout-content.full'
      ? [...(options.hiddenRoot ? [element('', () => false)] : []), root] : [element('', () => loading)],
    createElement(tag) {
      if (tag === 'div') return panel;
      return { ...element(), click() { downloads.push(blobs.get(this.href)); } };
    }
  };
  const context = { document, window, XMLHttpRequest: XHR, Blob, console: { log(...v) { logs.push(v.join(' ')); }, warn(...v) { logs.push(v.join(' ')); }, error() {} },
    alert: message => logs.push(message), getComputedStyle: () => ({ visibility: 'visible' }),
    setTimeout: schedule, URL: { createObjectURL(blob) { const key = 'blob:' + blobs.size; blobs.set(key, blob); return key; }, revokeObjectURL() {} },
    Date: class extends Date { constructor(...args) { super(...(args.length ? args : [now])); } static now() { return now; } }
  };
  vm.runInNewContext(code, context);
  if (options.existingPanel) return { status: fields['.log'].textContent, logs, queries: state.queries };
  let done = false;
  const promise = fields['.start'].onclick().then(() => { done = true; });
  if (options.stopAt) schedule(() => { fields['.stop'].onclick(); fields['.start'].onclick(); }, options.stopAt);
  for (let i = 0; i < 10000 && !done; i++) {
    for (let j = 0; j < 20; j++) await Promise.resolve();
    if (done) break;
    timers.sort((a, b) => a.at - b.at);
    const next = timers.shift();
    if (!next) throw new Error('No timers while scan is pending');
    now = next.at; next.fn();
  }
  assert.ok(done, 'scan must finish or stop');
  await promise;
  assert.equal(window.fetch, originalFetch, 'fetch must be restored');
  assert.equal(XHR.prototype.send, originalSend, 'XHR must be restored');
  assert.equal(state.reservations, 0, 'scanner must never book seats');
  assert.equal(fields['.start'].disabled, false);
  assert.equal(fields['.stop'].disabled, true);
  fields['.csv'].onclick();
  const csv = await downloads[0].text();
  fields['.diagnostic'].onclick();
  const diagnostic = JSON.parse(await downloads[1].text());
  return { state, csv, diagnostic, rows: fields.tbody.innerHTML, status: fields['.log'].textContent, logs };
}

(async () => {
  const cases = [
    ['cached results', { cache: true }, 8],
    ['slow fetch', { delay: 12000 }, 8],
    ['XHR queries', { xhr: true, delay: 250 }, 8],
    ['HTTP failure preserves accuracy', { httpError: true }, 4],
    ['XHR failure preserves accuracy', { xhr: true, httpError: true }, 4],
    ['zero seats retained', { full: true }, 8],
    ['no dates', { emptyDates: true }, 0],
    ['stop preserves partial results', { delay: 12000, stopAt: 15000 }, 1],
    ['wrong starting page', { wrongStage: true }, 0],
    ['date rows arrive after the page becomes visible', { dateDelay: 12000 }, 8],
    ['slash dates', { dateStyle: 'slash' }, 8],
    ['Chinese dates', { dateStyle: 'chinese' }, 8],
    ['timestamp date cells', { dateStyle: 'timestamp' }, 8],
    ['date text overrides non-date tooltip', { badDateTitle: true }, 8],
    ['checkbox before date column', { checkbox: true }, 8],
    ['unrecognized dates reported', { invalidDates: true }, 0],
    ['past dates explained', { pastDates: true }, 0],
    ['visible content root selected', { hiddenRoot: true }, 8],
    ['visible date section preferred', { duplicateSection: true }, 8],
    ['missing course names reported', { emptyCourses: true }, 0]
  ];
  for (const [name, options, expected] of cases) {
    const r = await scenario(options);
    assert.equal(r.csv.split('\n').length - 1, expected, name);
    assert.ok(!r.csv.includes('2026-10-20') && !r.csv.includes('2027-01-30'), 'date horizon');
    if (expected) {
      assert.ok(r.csv.includes('实验 ""甲""<测试>'), 'CSV quotes');
      assert.ok(r.rows.includes('&lt;测试&gt;'), 'HTML escaped');
      assert.ok(r.csv.includes('N""<实验室>'), 'room retained');
    }
    if (options.full) assert.ok(r.csv.includes('"0","3"'), 'zero capacity retained');
    if (options.stopAt) assert.equal(r.state.queries, 2, 'restart blocked while stopping');
    if (options.invalidDates) assert.ok(r.status.includes('无法识别日期列'), 'invalid dates must not look successful');
    if (options.emptyCourses) assert.ok(r.status.includes('未识别到实验名称'), 'missing courses must not look successful');
    if (options.pastDates) assert.ok(r.diagnostic.events.some(e => e.message.includes('天内 0 行')), 'filtered dates explained');
    assert.equal(r.diagnostic.version, '2026-10-24.1');
    assert.ok(r.diagnostic.computerTime && Array.isArray(r.diagnostic.dates));
    console.log('PASS scanner:', name);
  }
  const existing = await scenario({ existingPanel: true });
  assert.ok(existing.status.includes('刷新页面') && existing.logs.some(message => message.includes('2026-10-24.1')));
  assert.equal(existing.queries, 0);
  console.log('PASS scanner: duplicate injection visibly rejected; total', cases.length + 1, 'scenarios');
})().catch(error => { console.error(error); process.exitCode = 1; });

