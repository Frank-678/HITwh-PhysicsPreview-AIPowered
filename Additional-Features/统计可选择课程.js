(() => {
  'use strict';

  const CONFIG = {
    DAYS_AHEAD: 100,

    // 只在确实需要时增长
    MAX_DELAY: 32,

    // 真正异常才会触发，不是正常等待
    STAGE_TIMEOUT: 5000,
    NETWORK_TIMEOUT: 5000
  };

  const PANEL_ID =
    'hitwh-physics-fast-v6';

  let running = false;
  let results = [];

  // ------------------------------------------------
  // 自适应延迟学习
  // ------------------------------------------------

  const tune = {
    stage: 0,
    select: 0,
    query: 0,
    render: 0
  };

  const sleep = ms =>
    new Promise(resolve =>
      setTimeout(resolve, ms)
    );

  const nextTurn = () =>
    new Promise(resolve =>
      setTimeout(resolve, 0)
    );

  const compact = s =>
    (s || '').replace(/\s+/g, '');

  const rawText = el =>
    (
      el?.innerText ||
      el?.textContent ||
      ''
    ).trim();

  const text = el =>
    compact(rawText(el));

  function visible(el) {
    if (!el) {
      return false;
    }

    const style =
      getComputedStyle(el);

    return (
      style.display !== 'none' &&
      style.visibility !== 'hidden' &&
      el.getClientRects().length > 0
    );
  }

  /*
   * 自适应条件等待：
   *
   * 立即检查
   * -> microtask
   * -> 0ms timer
   * -> 1
   * -> 2
   * -> 4
   * ...
   *
   * 成功后下次自动降低起点。
   */
  async function adaptiveWait(
    key,
    condition,
    timeout,
    description
  ) {
    const started =
      performance.now();

    let delay =
      Math.max(
        0,
        tune[key] || 0
      );

    let lastSuccessfulDelay =
      delay;

    // 第一次零等待直接检查
    try {
      const v =
        condition();

      if (v) {
        tune[key] = 0;
        return v;
      }
    } catch (_) {}

    // 先只让出 microtask
    await Promise.resolve();

    try {
      const v =
        condition();

      if (v) {
        tune[key] = 0;
        return v;
      }
    } catch (_) {}

    /*
     * 再让浏览器真正完成一个 event-loop turn。
     * setTimeout(0)，不是固定人为等待。
     */
    await nextTurn();

    while (
      performance.now() - started <
      timeout
    ) {
      if (!running) {
        throw new Error('STOPPED');
      }

      try {
        const value =
          condition();

        if (value) {
          tune[key] =
            lastSuccessfulDelay <= 1
              ? 0
              : Math.floor(
                  lastSuccessfulDelay / 2
                );

          return value;
        }
      } catch (_) {}

      if (delay <= 0) {
        delay = 1;
      } else {
        lastSuccessfulDelay =
          delay;

        await sleep(delay);

        delay =
          Math.min(
            delay * 2,
            CONFIG.MAX_DELAY
          );
      }
    }

    throw new Error(
      `TIMEOUT:${description}`
    );
  }

  // ------------------------------------------------
  // 全局 DOM mutation 序号
  // ------------------------------------------------

  let mutationVersion = 0;

  new MutationObserver(
    () => {
      mutationVersion++;
    }
  ).observe(
    document.documentElement,
    {
      childList: true,
      subtree: true,
      attributes: true,
      characterData: true
    }
  );

  // ------------------------------------------------
  // 网络跟踪
  // ------------------------------------------------

  function installNetworkTracker() {
    const old =
      window.__HITWH_FAST_NET__;

    if (old) {
      return old;
    }

    let seq = 0;

    const pending =
      new Set();

    function start() {
      const id =
        ++seq;

      pending.add(id);

      return id;
    }

    function end(id) {
      pending.delete(id);
    }

    // fetch
    if (
      typeof window.fetch ===
      'function'
    ) {
      const original =
        window.fetch;

      window.fetch =
        function (...args) {
          const id =
            start();

          try {
            return Promise.resolve(
              original.apply(
                this,
                args
              )
            ).finally(
              () => end(id)
            );
          } catch (e) {
            end(id);
            throw e;
          }
        };
    }

    // XHR
    const originalSend =
      XMLHttpRequest
        .prototype
        .send;

    XMLHttpRequest
      .prototype
      .send =
      function (...args) {
        const id =
          start();

        this.addEventListener(
          'loadend',
          () => end(id),
          {
            once: true
          }
        );

        try {
          return originalSend.apply(
            this,
            args
          );
        } catch (e) {
          end(id);
          throw e;
        }
      };

    const tracker = {
      snapshot() {
        return seq;
      },

      startedAfter(n) {
        return seq > n;
      },

      pendingAfter(n) {
        for (
          const id of pending
        ) {
          if (id > n) {
            return true;
          }
        }

        return false;
      }
    };

    window.__HITWH_FAST_NET__ =
      tracker;

    return tracker;
  }

  const NET =
    installNetworkTracker();

  // ------------------------------------------------
  // 基础页面结构
  // ------------------------------------------------

  function bookingRoot() {
    return (
      document.querySelector(
        '.vctch-layout-content.full'
      ) ||
      document.body
    );
  }

  function findSection(label) {
    const target =
      compact(label);

    const divider = [
      ...bookingRoot()
        .querySelectorAll(
          '.ant-divider-inner-text'
        )
    ].find(
      el =>
        text(el) === target
    );

    return (
      divider
        ?.closest(
          '.ant-divider'
        )
        ?.parentElement ||
      null
    );
  }

  const courseSection = () =>
    findSection(
      '请在下面选择实验项目'
    );

  const dateSection = () =>
    findSection(
      '选择预约实验的日期和节次'
    );

  const timeSection = () =>
    findSection(
      '可选上课时间'
    );

  function stage() {
    if (
      visible(timeSection())
    ) {
      return 'TIMES';
    }

    if (
      visible(dateSection())
    ) {
      return 'DATES';
    }

    if (
      visible(courseSection())
    ) {
      return 'COURSES';
    }

    return 'UNKNOWN';
  }

  async function waitStage(
    expected
  ) {
    return adaptiveWait(
      'stage',

      () =>
        stage() === expected,

      CONFIG.STAGE_TIMEOUT,

      `STAGE_${expected}`
    );
  }

  function blurEverything() {
    try {
      const active =
        document.activeElement;

      if (
        active &&
        active !==
          document.body
      ) {
        active.blur();
      }
    } catch (_) {}
  }

  function click(el) {
    if (!el) {
      throw new Error(
        'CLICK_TARGET_MISSING'
      );
    }

    blurEverything();

    el.click();

    /*
     * Ant Design 有时把焦点留到
     * 即将隐藏的节点。
     */
    queueMicrotask(
      blurEverything
    );
  }

  // ------------------------------------------------
  // 精确按钮
  // ------------------------------------------------

  function exactButton(
    root,
    name
  ) {
    if (!root) {
      return null;
    }

    const target =
      compact(name);

    return [
      ...root.querySelectorAll(
        'button'
      )
    ].find(
      button =>
        text(button) === target
    ) || null;
  }

  // ------------------------------------------------
  // 实验
  // ------------------------------------------------

  function getCourseRows() {
    const root =
      courseSection();

    if (!root) {
      return [];
    }

    return [
      ...root.querySelectorAll(
        'tr.ant-table-row'
      )
    ].filter(
      row => {
        const td =
          row.querySelector('td');

        const name = (
          td?.getAttribute(
            'title'
          ) ||
          rawText(td)
        ).trim();

        return (
          name &&
          !/^\d{4}-\d{2}-\d{2}$/
            .test(name)
        );
      }
    );
  }

  function courseName(row) {
    const td =
      row.querySelector('td');

    return (
      td?.getAttribute(
        'title'
      ) ||
      rawText(td)
    ).trim();
  }

  async function enterCourse(
    name
  ) {
    if (
      stage() !== 'COURSES'
    ) {
      throw new Error(
        `ENTER_COURSE_FROM_${stage()}`
      );
    }

    const row =
      getCourseRows()
        .find(
          r =>
            courseName(r) ===
            name
        );

    if (!row) {
      throw new Error(
        `找不到实验：${name}`
      );
    }

    click(row);

    await waitStage(
      'DATES'
    );
  }

  // ------------------------------------------------
  // 日期
  // ------------------------------------------------

  function getDateRows() {
    const root =
      dateSection();

    if (!root) {
      return [];
    }

    return [
      ...root.querySelectorAll(
        'tr.ant-table-row'
      )
    ].filter(
      row => {
        const td =
          row.querySelector('td');

        const value = (
          td?.getAttribute(
            'title'
          ) ||
          rawText(td)
        ).trim();

        return (
          /^\d{4}-\d{2}-\d{2}$/
            .test(value)
        );
      }
    );
  }

  function parseDateRow(row) {
    const td = [
      ...row.querySelectorAll(
        'td'
      )
    ];

    return {
      date: (
        td[0]
          ?.getAttribute(
            'title'
          ) ||
        rawText(td[0])
      ).trim(),

      week:
        rawText(td[1]),

      weekday: (
        td[2]
          ?.getAttribute(
            'title'
          ) ||
        rawText(td[2])
      ).trim()
    };
  }

  function withinHorizon(
    date
  ) {
    const d =
      new Date(
        `${date}T00:00:00`
      );

    const today =
      new Date();

    today.setHours(
      0,
      0,
      0,
      0
    );

    const max =
      new Date(today);

    max.setDate(
      max.getDate() +
      CONFIG.DAYS_AHEAD
    );

    return (
      d >= today &&
      d <= max
    );
  }

  async function enterDate(
    date
  ) {
    if (
      stage() !== 'DATES'
    ) {
      throw new Error(
        `ENTER_DATE_FROM_${stage()}`
      );
    }

    const row =
      getDateRows()
        .find(
          r =>
            parseDateRow(r)
              .date ===
            date
        );

    if (!row) {
      throw new Error(
        `找不到日期：${date}`
      );
    }

    click(row);

    await waitStage(
      'TIMES'
    );
  }

  // ------------------------------------------------
  // 关键：
  // TIMES -> COURSES
  // ------------------------------------------------

  /*
   * 日期页的“返 回”按钮虽然 TIMES 时
   * 对应 section 被隐藏，但 handler 仍挂着。
   *
   * 与直接点隐藏课程行不同，
   * 这是页面自己提供的状态转换。
   *
   * 点它后应回 COURSES。
   */
  async function returnToCourses() {
    if (
      stage() === 'COURSES'
    ) {
      return;
    }

    const root =
      dateSection();

    const back =
      exactButton(
        root,
        '返回'
      );

    if (!back) {
      throw new Error(
        '找不到日期页面的“返 回”按钮'
      );
    }

    click(back);

    await waitStage(
      'COURSES'
    );
  }

  // ------------------------------------------------
  // 大节
  // ------------------------------------------------

  function getTimeCards() {
    const root =
      timeSection();

    if (!root) {
      return [];
    }

    return [
      ...root.querySelectorAll(
        '.radio-item'
      )
    ].filter(
      card =>
        /第[一二三四五六七八九十]+大节/
          .test(
            rawText(card)
          )
    );
  }

  function parseTimeCard(
    card
  ) {
    const s =
      rawText(card)
        .replace(
          /\s+/g,
          ' '
        );

    return {
      period:
        s.match(
          /第[一二三四五六七八九十]+大节/
        )?.[0] ||
        s,

      start:
        s.match(
          /开始时间[:：]\s*([0-9:]+)/
        )?.[1] ||
        ''
    };
  }

  // ------------------------------------------------
  // 座位
  // ------------------------------------------------

  function getSeatCards() {
    const root =
      timeSection();

    if (!root) {
      return [];
    }

    return [
      ...root.querySelectorAll(
        '.ant-card'
      )
    ].filter(
      card =>
        /座位\s*[:：]\s*\d+/
          .test(
            rawText(card)
          )
    );
  }

  function seatSignature() {
    return getSeatCards()
      .map(
        x =>
          compact(
            rawText(x)
          )
      )
      .join('|');
  }

  function getSeatInfo() {
    const root =
      timeSection();

    const cards =
      getSeatCards();

    const free =
      cards.filter(
        x =>
          /状态\s*[:：]\s*空闲/
            .test(
              rawText(x)
            )
      ).length;

    const room =
      rawText(root)
        .match(
          /实验室名称\s*[:：]\s*([^\n\r]+)/
        )?.[1]
        ?.trim() ||
      '';

    return {
      free,
      total:
        cards.length,
      room
    };
  }

  // ------------------------------------------------
  // 查询
  // ------------------------------------------------

  /*
   * 查询完成判据：
   *
   * 不再要求网络请求。
   *
   * 下列任意一种发生即可：
   *
   * 1. 新网络请求完成
   * 2. DOM 发生改变
   * 3. loading 出现后消失
   * 4. 座位结果改变
   * 5. 什么都没发生：
   *    一个 event-loop turn 后直接接受当前结果
   *
   * 第 5 条很重要：
   * 缓存结果 / 同样结果不会再卡 5~10 秒。
   */
  async function queryTime(
    period
  ) {
    const root =
      timeSection();

    if (!root) {
      throw new Error(
        'TIME_SECTION_MISSING'
      );
    }

    const card =
      getTimeCards()
        .find(
          x =>
            parseTimeCard(x)
              .period ===
            period
        );

    if (!card) {
      throw new Error(
        `找不到 ${period}`
      );
    }

    const radio =
      card.querySelector(
        'input[type="radio"]'
      );

    click(
      radio || card
    );

    if (radio) {
      try {
        await adaptiveWait(
          'select',

          () =>
            radio.checked,

          300,

          `SELECT_${period}`
        );
      } catch (_) {
        /*
         * Ant Design 有时真实状态
         * 不直接体现在 native checked。
         *
         * 不因此失败。
         */
      }
    }

    const beforeNet =
      NET.snapshot();

    const beforeMutation =
      mutationVersion;

    const beforeSeats =
      seatSignature();

    const query =
      exactButton(
        root,
        '查询'
      );

    if (!query) {
      throw new Error(
        '找不到当前区块内“查询”按钮'
      );
    }

    click(query);

    /*
     * 先让点击 handler + Promise microtask
     * 有机会执行。
     *
     * 没有固定 ms。
     */
    await Promise.resolve();
    await Promise.resolve();

    /*
     * 再让一个最小 event-loop turn。
     */
    await nextTurn();

    /*
     * 情况 A：
     * 真的产生网络请求。
     */
    if (
      NET.startedAfter(
        beforeNet
      )
    ) {
      try {
        await adaptiveWait(
          'query',

          () =>
            !NET.pendingAfter(
              beforeNet
            ),

          CONFIG.NETWORK_TIMEOUT,

          `QUERY_NETWORK_${period}`
        );
      } catch (e) {
        /*
         * 即使网络 tracker 不完善，
         * 也不让一个时段卡整个扫描。
         */
        console.warn(
          '[查询网络等待超时，直接读取页面]',
          period
        );
      }

      await Promise.resolve();
      await Promise.resolve();

      return getSeatInfo();
    }

    /*
     * 情况 B：
     * 没网络，但 DOM 已同步更新。
     */
    if (
      mutationVersion >
        beforeMutation ||
      seatSignature() !==
        beforeSeats
    ) {
      return getSeatInfo();
    }

    /*
     * 情况 C：
     * 没网络、没 DOM 变化。
     *
     * 很可能：
     * - 数据来自缓存
     * - 当前结果与上一个完全相同
     *
     * 这时不能等 10 秒。
     *
     * 只使用当前学到的最小 render delay。
     */
    let delay =
      tune.render || 0;

    if (delay > 0) {
      await sleep(delay);
    }

    /*
     * 再检查一次。
     */
    if (
      mutationVersion >
        beforeMutation ||
      seatSignature() !==
        beforeSeats
    ) {
      tune.render =
        delay <= 1
          ? 0
          : Math.floor(
              delay / 2
            );
    } else {
      /*
       * 下次稍微增加，
       * 但本次绝不阻塞。
       */
      tune.render =
        delay === 0
          ? 1
          : Math.min(
              delay * 2,
              CONFIG.MAX_DELAY
            );
    }

    return getSeatInfo();
  }

  // ------------------------------------------------
  // 结果
  // ------------------------------------------------

  function addResult(row) {
    const key =
      `${row.course}|${row.date}|${row.period}`;

    const index =
      results.findIndex(
        r =>
          `${r.course}|${r.date}|${r.period}` ===
          key
      );

    if (index >= 0) {
      results[index] =
        row;
    } else {
      results.push(row);
    }

    render();
  }

  // ------------------------------------------------
  // 主循环
  // ------------------------------------------------

  async function scanAll() {
    if (running) {
      return;
    }

    if (
      stage() !== 'COURSES'
    ) {
      alert(
        '请先手动回到“预约选课”的实验列表。'
      );

      return;
    }

    running = true;

    results = [];

    render();

    const courses =
      getCourseRows()
        .map(courseName)
        .filter(Boolean);

    try {
      for (
        let ci = 0;
        ci < courses.length;
        ci++
      ) {
        const course =
          courses[ci];

        log(
          `[${ci + 1}/${courses.length}] ${course}`
        );

        /*
         * 先进入一次课程，
         * 取得日期快照。
         */
        await enterCourse(
          course
        );

        const dates =
          getDateRows()
            .map(
              parseDateRow
            )
            .filter(
              x =>
                withinHorizon(
                  x.date
                )
            );

        /*
         * 返回实验列表。
         *
         * 后面每一个日期都重新
         * 从 COURSES -> DATES -> TIMES。
         *
         * 不再依赖隐藏列表直接跨状态跳转。
         */
        await returnToCourses();

        for (
          let di = 0;
          di < dates.length;
          di++
        ) {
          if (!running) {
            throw new Error(
              'STOPPED'
            );
          }

          const d =
            dates[di];

          log(
            `${course}：${d.date} ${d.weekday}`
          );

          /*
           * 每次日期：
           *
           * COURSES
           * -> 当前实验
           * -> DATES
           * -> 当前日期
           * -> TIMES
           */
          try {
            await enterCourse(
              course
            );

            await enterDate(
              d.date
            );
          } catch (e) {
            console.warn(
              '[进入日期失败]',
              course,
              d.date,
              e
            );

            /*
             * 尝试恢复实验列表。
             */
            try {
              await returnToCourses();
            } catch (_) {}

            continue;
          }

          const times =
            getTimeCards()
              .map(
                parseTimeCard
              );

          for (
            const tm of times
          ) {
            if (!running) {
              throw new Error(
                'STOPPED'
              );
            }

            log(
              `${course}：${d.date} ${tm.period}`
            );

            try {
              const seat =
                await queryTime(
                  tm.period
                );

              addResult({
                course,

                date:
                  d.date,

                weekday:
                  d.weekday,

                week:
                  d.week,

                period:
                  tm.period,

                start:
                  tm.start,

                free:
                  seat.free,

                total:
                  seat.total,

                room:
                  seat.room
              });

            } catch (e) {
              console.error(
                '[单时段查询失败]',
                course,
                d.date,
                tm.period,
                e
              );
            }
          }

          /*
           * TIMES
           * -> 日期页自己的隐藏“返 回”
           * -> COURSES
           */
          try {
            await returnToCourses();

          } catch (e) {
            console.error(
              '[无法恢复实验列表]',
              course,
              d.date,
              e
            );

            throw e;
          }
        }
      }

      log(
        `完成：扫描 ${results.length} 个时段，其中 ${
          results.filter(
            r => r.free > 0
          ).length
        } 个有空位`
      );

    } catch (e) {
      if (
        String(
          e?.message || e
        ) === 'STOPPED'
      ) {
        log(
          `已停止，保留 ${results.length} 条结果`
        );

      } else {
        console.error(
          '[扫描中断]',
          e
        );

        log(
          `扫描中断：${
            e?.message || e
          }`
        );
      }

    } finally {
      running = false;
    }
  }

  // ------------------------------------------------
  // CSV
  // ------------------------------------------------

  function exportCsv() {
    const rows = [
      [
        '实验',
        '日期',
        '星期',
        '周次',
        '大节',
        '开始时间',
        '空闲座位',
        '总座位',
        '实验室'
      ],

      ...results.map(
        r => [
          r.course,
          r.date,
          r.weekday,
          r.week,
          r.period,
          r.start,
          r.free,
          r.total,
          r.room
        ]
      )
    ];

    const csv =
      '\uFEFF' +
      rows
        .map(
          row =>
            row
              .map(
                value =>
                  `"${String(
                    value ?? ''
                  ).replace(
                    /"/g,
                    '""'
                  )}"`
              )
              .join(',')
        )
        .join('\n');

    const blob =
      new Blob(
        [csv],
        {
          type:
            'text/csv;charset=utf-8'
        }
      );

    const link =
      document.createElement(
        'a'
      );

    link.href =
      URL.createObjectURL(
        blob
      );

    link.download =
      '大物实验空余时段.csv';

    link.click();

    URL.revokeObjectURL(
      link.href
    );
  }

  // ------------------------------------------------
  // UI
  // ------------------------------------------------

  function esc(s) {
    return String(
      s ?? ''
    ).replace(
      /[&<>"']/g,
      ch => ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;'
      }[ch])
    );
  }

  function render() {
    const tbody =
      document.querySelector(
        `#${PANEL_ID} tbody`
      );

    if (!tbody) {
      return;
    }

    const sorted =
      [...results].sort(
        (a, b) =>
          a.date.localeCompare(
            b.date
          ) ||
          a.course.localeCompare(
            b.course
          ) ||
          a.period.localeCompare(
            b.period
          )
      );

    tbody.innerHTML =
      sorted
        .map(
          r => `
            <tr class="${
              r.free > 0
                ? 'free'
                : 'full'
            }">

              <td>
                ${esc(r.course)}
              </td>

              <td>
                ${esc(r.date)}
                <br>
                <small>
                  ${esc(r.weekday)}
                </small>
              </td>

              <td>
                ${esc(r.period)}
              </td>

              <td>
                <b>${r.free}</b>
                /
                ${r.total}
              </td>

              <td>
                ${esc(
                  r.room || '-'
                )}
              </td>

            </tr>
          `
        )
        .join('');

    const stats =
      document.querySelector(
        `#${PANEL_ID} .stats`
      );

    if (stats) {
      stats.textContent =
        `结果 ${results.length} | ` +
        `stage ${tune.stage}ms | ` +
        `select ${tune.select}ms | ` +
        `render ${tune.render}ms`;
    }
  }

  function log(message) {
    console.log(
      '[空余时段扫描器]',
      message
    );

    const el =
      document.querySelector(
        `#${PANEL_ID} .log`
      );

    if (el) {
      el.textContent =
        message;
    }

    render();
  }

  function createPanel() {
    document
      .getElementById(
        PANEL_ID
      )
      ?.remove();

    const panel =
      document.createElement(
        'div'
      );

    panel.id =
      PANEL_ID;

    panel.innerHTML = `
      <div class="head">
        <b>
          大物实验极速扫描 v6
        </b>

        <span class="log">
          待机
        </span>
      </div>

      <div class="actions">
        <button class="start">
          扫描未来 ${CONFIG.DAYS_AHEAD} 天
        </button>

        <button class="stop">
          停止
        </button>

        <button class="csv">
          导出 CSV
        </button>

        <span class="stats"></span>
      </div>

      <div class="body">
        <table>
          <thead>
            <tr>
              <th>实验</th>
              <th>日期</th>
              <th>大节</th>
              <th>空闲/总数</th>
              <th>实验室</th>
            </tr>
          </thead>

          <tbody></tbody>
        </table>
      </div>
    `;

    const style =
      document.createElement(
        'style'
      );

    style.textContent = `
      #${PANEL_ID} {
        position: fixed;
        right: 12px;
        bottom: 12px;
        width: 780px;
        max-width: calc(100vw - 24px);
        max-height: 72vh;
        z-index: 2147483647;
        background: white;
        color: #222;
        border: 1px solid #aaa;
        border-radius: 8px;
        box-shadow: 0 6px 24px #0003;
        font: 14px/1.4 sans-serif;
        overflow: hidden;
      }

      #${PANEL_ID} .head {
        display: flex;
        gap: 12px;
        align-items: center;
        padding: 9px 12px;
        background: #f5f6f7;
        border-bottom: 1px solid #ddd;
      }

      #${PANEL_ID} .log {
        flex: 1;
        color: #666;
        overflow: hidden;
        white-space: nowrap;
        text-overflow: ellipsis;
      }

      #${PANEL_ID} .actions {
        display: flex;
        gap: 7px;
        align-items: center;
        flex-wrap: wrap;
        padding: 8px 12px;
        border-bottom: 1px solid #eee;
      }

      #${PANEL_ID} button {
        padding: 5px 9px;
        cursor: pointer;
      }

      #${PANEL_ID} .stats {
        margin-left: auto;
        color: #666;
        font-size: 11px;
      }

      #${PANEL_ID} .body {
        max-height: 54vh;
        overflow: auto;
      }

      #${PANEL_ID} table {
        width: 100%;
        border-collapse: collapse;
        font-size: 12px;
      }

      #${PANEL_ID} th,
      #${PANEL_ID} td {
        padding: 6px;
        border-bottom: 1px solid #eee;
        text-align: left;
        vertical-align: top;
      }

      #${PANEL_ID} th {
        position: sticky;
        top: 0;
        background: #fafafa;
      }

      #${PANEL_ID} tr.free {
        background: #f3fff3;
      }

      #${PANEL_ID} tr.full {
        opacity: .55;
      }
    `;

    document.head
      .appendChild(
        style
      );

    document.body
      .appendChild(
        panel
      );

    panel
      .querySelector(
        '.start'
      )
      .onclick =
      scanAll;

    panel
      .querySelector(
        '.stop'
      )
      .onclick =
      () => {
        running = false;
        log('正在停止…');
      };

    panel
      .querySelector(
        '.csv'
      )
      .onclick =
      exportCsv;

    render();
  }

  createPanel();

})();