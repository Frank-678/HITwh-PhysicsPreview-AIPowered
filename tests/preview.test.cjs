const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');

async function scenario(provider, options = {}) {
  const code = fs.readFileSync(__dirname + '/../main-' + provider + '.js', 'utf8');
  let now = 1000000, done = false;
  const timers = [], listeners = [], menus = [], storage = options.storage || new Map();
  const exps = options.exps || [{ id: 'a', name: '实验甲' }];
  const state = { phase: options.onPaper !== undefined ? 'paper' : 'list', active: options.onPaper || 0,
    opened: now, requests: [], selections: [], submits: 0, reloads: 0, clicks: [], logs: [] };
  const schedule = (fn, delay = 0) => timers.push({ fn, at: now + delay });
  const show = (el, predicate) => {
    Object.defineProperties(el, {
      offsetWidth: { get: () => predicate() ? 100 : 0 }, offsetHeight: { get: () => predicate() ? 20 : 0 },
      offsetParent: { get: () => predicate() ? {} : null }
    });
    return el;
  };
  const cards = exps.flatMap((exp, ei) => Array.from({ length: exp.questions || 1 }, (_, qi) => {
    const shown = () => state.phase === 'paper' && state.active === ei && !exp.empty
      && now >= state.opened + (exp.readyDelay || 0);
    const nodes = Array.from({ length: 4 }, (_, index) => ({ checked: false, click() {
      for (const node of nodes) node.checked = false;
      if (!options.ignoreSelection) this.checked = true;
      state.selections.push({ experiment: ei, question: qi, index });
    } }));
    const blocks = nodes.map((node, index) => ({ querySelector: selector => selector === '.ant-col-22'
      ? { innerText: '选项 ' + index } : node }));
    return show({ innerText: '试题: ' + exp.name, querySelector(selector) {
      if (selector.includes('nth-child')) return { innerText: exp.name + ' 的题目 ' + qi };
      if (selector === '.exam-radio input[type=\'radio\']') return nodes[0];
      if (selector === 'input[type=\'radio\']:checked') return nodes.find(node => node.checked);
      return null;
    }, querySelectorAll: () => blocks }, shown);
  }));
  const rows = exps.map((exp, i) => show({ innerText: exp.name + '\n未通过\n可考试',
    getAttribute: () => exp.id, querySelector: () => ({ innerText: exp.name }), closest() { return this; },
    click() {
      state.clicks.push(i);
      for (const listener of listeners) listener({ target: this });
      state.active = i; state.opened = now;
      if (!exp.failToOpen) state.phase = 'paper';
    }
  }, () => state.phase === 'list'));
  const submit = show({ innerText: '提交答案', click() {
    state.submits++;
    if (!options.rejectSubmit) state.phase = 'result';
  } }, () => state.phase === 'paper');
  const back = show({ innerText: '返 回', click() { state.phase = 'list'; } }, () => state.phase === 'result');
  const spinner = show({}, () => state.phase === 'paper' && now < state.opened + (options.spinnerDelay || 0));
  const document = {
    addEventListener: (type, fn) => listeners.push(fn),
    querySelectorAll(selector) {
      return ({ button: [submit, back], 'tr.ant-table-row': rows, '.ant-card-bordered': cards,
        '.full-loading, .ant-spin-spinning': [spinner] })[selector] || [];
    }
  };
  const api = request => {
    const index = state.requests.length;
    state.requests.push(JSON.parse(request.data));
    const mode = Array.isArray(options.mode) ? options.mode[index] || 'success' : options.mode;
    schedule(() => {
      if (mode === 'network') return request.onerror({ error: 'offline' });
      if (mode === 'timeout') return request.ontimeout();
      if (mode === '429' || mode === '402') return request.onload({ status: Number(mode), responseText: '{}' });
      const letter = mode === 'invalid' ? '?' : mode === 'range' ? 'Z' : 'A';
      const count = Number(request.data.match(/本卷共 (\d+) 题/)?.[1] || 1);
      const data = provider === 'deepseek' ? { choices: [{ message: { content: JSON.stringify(Array(count).fill(letter)) } }] }
        : { candidates: [{ content: { parts: [{ text: letter }] } }] };
      request.onload({ status: 200, responseText: JSON.stringify(data) });
    }, mode === 'timeout' ? request.timeout : options.apiDelay || 10);
  };
  const context = { document, GM_xmlhttpRequest: api,
    GM_registerMenuCommand: (name, fn) => menus.push(fn),
    sessionStorage: { getItem: key => storage.get(key) || null, setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) },
    location: { reload() { state.reloads++; } },
    console: Object.fromEntries(['log', 'warn', 'error'].map(level => [level, (...values) => state.logs.push(values.join(' '))])),
    Date: { now: () => now }, setTimeout: (fn, delay) => schedule(() => {
      const value = fn(); if (value?.then) value.then(() => { done = true; }, error => { throw error; });
    }, delay)
  };
  vm.runInNewContext(code, context);
  if (options.manualFirst !== undefined) schedule(() => rows[options.manualFirst].click(), 1000);
  if (options.switch !== undefined) schedule(() => { state.phase = 'list'; rows[options.switch].click(); }, 10000);
  for (let i = 0; i < 10000 && !done; i++) {
    for (let j = 0; j < 16; j++) await Promise.resolve();
    if (done) break;
    timers.sort((a, b) => a.at - b.at);
    const next = timers.shift(); if (!next) throw new Error('No timers while agent is pending');
    now = next.at; next.fn();
  }
  assert.ok(done, 'agent must terminate after reload or balance error');
  if (options.reset) menus[0]();
  return { ...state, storage };
}

(async () => {
  let count = 0;
  for (const provider of ['deepseek', 'gemini']) {
    for (const [name, options] of [
      ['normal', {}], ['slow loading', { exps: [{ id: 'a', name: '实验甲', readyDelay: 12000 }], spinnerDelay: 12000 }],
      ['empty paper', { exps: [{ id: 'a', name: '实验甲', empty: true }] }],
      ['network', { mode: 'network' }], ['timeout', { mode: 'timeout' }], ['invalid answer', { mode: 'invalid' }],
      ['out of range', { mode: 'range' }], ['rejected submission', { rejectSubmit: true }],
      ['selection failed', { ignoreSelection: true }], ['navigation failed', { exps: [{ id: 'a', name: '实验甲', failToOpen: true }] }]
    ]) {
      const r = await scenario(provider, options);
      const success = name === 'normal' || name === 'slow loading';
      assert.equal(r.reloads, 1, name + ': return to directory');
      assert.equal(r.submits, success || name === 'rejected submission' ? 1 : 0, name + ': no empty submission');
      if (['network', 'timeout', 'invalid answer', 'out of range'].includes(name)) assert.equal(r.requests.length, 4);
      if (!success) assert.equal(r.storage.get('LSM_SKIPPED_EXPERIMENTS'), '["a"]', name + ': remember failure');
      console.log('PASS preview:', provider, name); count++;
    }
    const exps = [{ id: 'a', name: '实验甲' }, { id: 'b', name: '实验乙' }];
    const manual = await scenario(provider, { exps, manualFirst: 1 });
    assert.deepEqual(manual.clicks, [1]);
    if (provider === 'deepseek') assert.ok(manual.requests[0].messages[0].content.includes('当前实验是：【实验乙】'));
    const switched = await scenario(provider, { exps, switch: 1, apiDelay: 12000 });
    assert.equal(switched.requests.length, 2);
    assert.deepEqual(switched.selections.map(v => v.experiment), [1]);
    const failed = await scenario(provider, { mode: 'network' });
    const next = await scenario(provider, { storage: failed.storage, exps });
    assert.deepEqual(next.clicks, [1]); assert.equal(next.submits, 1);
    const reset = await scenario(provider, { storage: new Map([['LSM_SKIPPED_EXPERIMENTS', '["a"]']]), exps, reset: true });
    assert.ok(!reset.storage.has('LSM_SKIPPED_EXPERIMENTS'));
    const transient = await scenario(provider, { mode: ['network', 'success'] });
    assert.equal(transient.requests.length, 2); assert.equal(transient.submits, 1);
    count += 5;
    console.log('PASS preview:', provider, 'manual identity, stale response, continue after reload, reset, recovery');
  }
  const limited = await scenario('deepseek', { mode: '429' });
  assert.equal(limited.requests.length, 4); assert.equal(limited.reloads, 1); assert.equal(limited.submits, 0);
  const balance = await scenario('deepseek', { mode: '402' });
  assert.equal(balance.requests.length, 1); assert.equal(balance.reloads, 0); assert.equal(balance.submits, 0);
  const partial = await scenario('gemini', { exps: [{ id: 'a', name: '实验甲', questions: 2 }], mode: ['success', 'network', 'network', 'network', 'network'] });
  assert.equal(partial.selections.length, 1); assert.equal(partial.submits, 0); assert.equal(partial.reloads, 1);
  console.log('PASS preview: 429, balance, partial paper; total', count + 3, 'scenarios');
})().catch(error => { console.error(error); process.exitCode = 1; });
