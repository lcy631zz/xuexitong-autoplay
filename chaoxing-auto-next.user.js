// ==UserScript==
// @name         超星学习通 · 自动播放 + 播完自动下一节
// @namespace    workbuddy.chaoxing.autonext
// @version      1.3.2
// @description  自动播放当前章节的视频；播放完成后自动点击右侧目录的下一节并继续播放。不加速、不绕过平台的防挂机检测（视频内弹出的单选题会自动逐个尝试作答）。
// @author       WorkBuddy
// @match        *://*.chaoxing.com/mycourse/studentstudy*
// @grant        none
// @run-at       document-end
// @license      MIT
// ==/UserScript==

/*
 * 设计边界（重要，请先读）
 * ---------------------------------------------------------------
 * 本脚本只做两件"免手动操作"的事：
 *   1) 进入某节后，自动点一下播放键（你本来也要点的）；
 *   2) 当前视频真正播完（进度 ≥ 98%）后，自动点右侧目录的下一节。
 * 视频仍然按 1 倍速、在前台、真实播放完整时长，不改学习记录。
 * 默认【静音】自动播放（浏览器普遍拦截"带声音的自动播放"，静音才稳；面板右侧 🔇/🔊 可一键切回有声）。
 *
 * 明确不做（也请你自己不要去找别的脚本做）：
 *   × 不加速播放
 *   × 不在你切走窗口时偷偷续播（那是伪造观看记录）
 *   × 不自动答【多选题 / 需要输入或论述】的题，也不自动过滑块验证码
 *   × 遇到文档/章节测验节点会停下来提醒你，不会替你跳过
 *   × 不绕过平台的防挂机风控（超星有 9010 风控验证码，触发后需人工输入）
 *
 * 关于"视频内弹题"：部分章节视频中途会弹出【单选题】。
 *   这类题脚本会真实点击——逐个选项尝试提交，答错（平台弹 alert）就换下一个，
 *   直到答对（弹题消失）或试完所有选项。不伪造、不绕过，纯前端自动点。
 *   多选题/填空题不参与自动作答，会停下等你自己做。
 */

(function () {
  'use strict';

  /* 每个文档只跑一次（防 Tampermonkey 重复注入）；"哪个文档含目录，哪个接管" */
  if (window.__cxAutoNextLoaded) return;
  window.__cxAutoNextLoaded = true;

  /* 任何报错都弹一个红色框，而不是让你对着空白发呆 */
  window.addEventListener('error', function (ev) {
    showFatal(ev.error || ev.message);
  });

  /* ================================================================
   * 1. 配置
   * ================================================================ */
  const CFG = {
    POLL_MS: 1500,        // 轮询间隔（毫秒）
    FINISH_RATIO: 0.98,   // 进度达到这个比例就算播完（平台要求 ≥ 90%）
    NEXT_WAIT_MS: 3000,   // 判定播完后等多久再切下一节（给平台上报进度留时间）
    AUTOSTART: false,     // 打开页面是否自动开始
    MUTED: true,          // 默认静音播放（浏览器普遍拦截"带声音的自动播放"，静音才稳；面板可一键切回有声）
    LOG_MAX: 120,         // 面板最多保留多少行日志
  };

  /* ================================================================
   * 2. 运行时状态
   * ================================================================ */
  let running = CFG.AUTOSTART;   // 总开关
  let switching = false;         // 正在切章节，避免重复触发
  let lastKey = '';              // 当前已接管的视频标识
  let lastTabTryAt = 0;          // 上次尝试点「视频」标签的时间
  let tabMissLogged = false;     // 「本节没有视频标签」只提醒一次
  let quizState = null;          // 当前正在处理的弹题状态
  let muted = CFG.MUTED;         // 是否静音播放（面板按钮可切换）
  let logs = [];
  let panel = null;
  let bootAt = 0;                // 脚本启动时间（用于诊断"目录多久没出现"）
  let catalogSeenAt = 0;         // 首次检测到目录的时间
  let catalogWarnLogged = false; // 「没找到目录」诊断只提示一次

  /* ================================================================
   * 3. 基础工具
   * ================================================================ */

  /* 收集本页 + 所有同源 iframe 的 document（超星是三层嵌套） */
  function collectDocs() {
    const docs = [];
    (function walk(doc) {
      if (!doc || docs.indexOf(doc) !== -1) return;
      docs.push(doc);
      let frames;
      try { frames = doc.querySelectorAll('iframe'); } catch (e) { return; }
      for (let i = 0; i < frames.length; i++) {
        try { if (frames[i].contentDocument) walk(frames[i].contentDocument); } catch (e) { /* 跨域忽略 */ }
      }
    })(document);
    return docs;
  }

  /* 尽量返回最外层文档（面板建在那里更显眼、也最不容易被 SPA 重新渲染冲掉）；
     若顶层跨域拿不到就退回当前文档 */
  function topDoc() {
    try {
      if (window.top && window.top.document) return window.top.document;
    } catch (e) {}
    return document;
  }

  /* 真实模拟一次鼠标点击（有些节点只认 mousedown/mouseup） */
  function realClick(el) {
    if (!el) return;
    const win = el.ownerDocument.defaultView || window;
    try { el.scrollIntoView({ block: 'center' }); } catch (e) {}
    ['mousedown', 'mouseup', 'click'].forEach(function (type) {
      try {
        el.dispatchEvent(new win.MouseEvent(type, { bubbles: true, cancelable: true, view: win }));
      } catch (e) {}
    });
  }

  function fmtTime(sec) {
    if (!isFinite(sec) || sec <= 0) return '--';
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    return m + ':' + (s < 10 ? '0' + s : s);
  }

  /* ================================================================
   * 4. 视频查找 / 控制
   * ================================================================ */

  /* 找出所有 document 里的 <video>，按时长从大到小排（排除装饰性小视频） */
  function findVideos() {
    const out = [];
    const docs = collectDocs();
    for (let i = 0; i < docs.length; i++) {
      let vs = [];
      try { vs = docs[i].querySelectorAll('video'); } catch (e) { continue; }
      for (let j = 0; j < vs.length; j++) out.push(vs[j]);
    }
    out.sort(function (a, b) { return (b.duration || 0) - (a.duration || 0); });
    return out;
  }

  function videoKey(v) {
    let src = v.currentSrc || v.src || '';
    if (!src) {
      const s = v.querySelector('source');
      if (s && s.src) src = s.src;
    }
    if (!src) return 'video-without-src';
    /* 只保留末尾文件名，日志更好读 */
    return src.split('?')[0];
  }

  function shortName(key) {
    const parts = String(key).split('/');
    return parts[parts.length - 1] || key;
  }

  /* ================================================================
   * 4.7 视频内弹题（单选题）自动作答
   * ================================================================ */

  /* 拦截原生 alert（超星答错会弹 alert），让脚本能捕获"答错"信号而不真正阻塞页面 */
  function installAlertHook(doc) {
    try {
      if (doc.__cxAlertHooked) return;
      doc.__cxAlertHooked = true;
      doc.__cxLastAlert = null;
      doc.defaultView.alert = function (msg) {
        doc.__cxLastAlert = { time: Date.now(), text: String(msg) };
        log('弹题反馈（平台提示）：' + String(msg), 'warn');
        /* 不弹原生对话框，避免卡住自动流程 */
        return;
      };
    } catch (e) {}
  }

  /* 弹题是否"仍可见/存在"。答对后平台通常会隐藏或移除弹题，隐藏的不再算数 */
  function quizAlive(submitBtn) {
    try {
      if (!submitBtn || !submitBtn.isConnected) return false;
      const win = submitBtn.ownerDocument.defaultView;
      let el = submitBtn;
      while (el) {
        if (el.style && el.style.display === 'none') return false;
        if (el.hidden) return false;
        if (el.nodeType === 1) {
          const cs = win.getComputedStyle(el);
          if (cs && cs.display === 'none') return false;
        }
        el = el.parentElement;
      }
      return true;
    } catch (e) { return true; }
  }

  /* 找到当前文档树里的弹题（单选 radio 选项 + 提交按钮） */
  function findQuiz() {
    const docs = collectDocs();
    for (let i = 0; i < docs.length; i++) {
      let opts = [], submitBtn = null;
      try {
        opts = Array.prototype.slice.call(docs[i].querySelectorAll('input[name="ans-videoquiz-opt"]'));
        submitBtn = docs[i].querySelector('.ans-videoquiz-submit');
      } catch (e) {}
      if (opts.length && submitBtn && quizAlive(submitBtn)) {
        installAlertHook(docs[i]);
        return { doc: docs[i], opts: opts, submitBtn: submitBtn };
      }
    }
    return null;
  }

  /* 多选题（checkbox）不参与自动作答 */
  function isMultiChoice(opts) {
    for (let i = 0; i < opts.length; i++) {
      if (opts[i].type === 'checkbox') return true;
    }
    return false;
  }

  /* 单选题自动作答：逐个选项尝试提交，答错就换下一个，直到答对（弹题消失） */
  function handleQuiz() {
    const q = findQuiz();
    if (!q) {
      /* 没有弹题了：要么本来就不存在，要么刚才作答成功被平台关掉了 */
      if (quizState && quizState.submitted) {
        log('弹题：作答成功，继续播放', 'ok');
      }
      quizState = null;
      return false; /* 交还给主循环处理视频 */
    }

    if (isMultiChoice(q.opts)) {
      setStatus('⏸ 弹题是多选题，脚本不代答，请手动作答');
      log('⏸ 检测到多选题，自动作答仅支持单选，已停下等手动', 'warn');
      return true;
    }

    /* 初始化该题状态（以"提交按钮"为同一题的标识） */
    if (!quizState || quizState.submitBtn !== q.submitBtn) {
      quizState = {
        doc: q.doc, opts: q.opts, submitBtn: q.submitBtn,
        idx: 0,
        alertBase: q.doc.__cxLastAlert ? q.doc.__cxLastAlert.time : 0,
        pending: false, pendingSince: 0, submitted: false, done: false
      };
      log('弹题：开始自动作答（单选题，逐个试直到正确）', 'warn');
    }
    const st = quizState;

    /* 处于"等待平台反馈"阶段 */
    if (st.pending) {
      st.submitted = true;
      const la = q.doc.__cxLastAlert;
      if (la && la.time > st.alertBase) {
        /* 平台弹了 alert = 答错，换下一个选项 */
        st.alertBase = la.time;
        var tried = st.idx + 1;
        st.idx += 1;
        st.pending = false;
        if (st.idx >= st.opts.length) {
          st.done = true;
          setStatus('⏸ 所有选项都试过仍不对（可能题目有变动或非单选），请手动作答');
          log('⏸ 弹题所有选项（共 ' + tried + ' 个）都试过仍不对，请手动作答', 'err');
          return true;
        }
        log('弹题：第 ' + tried + ' 个选项答错，换第 ' + (st.idx + 1) + ' 个试试', 'warn');
      } else if (Date.now() - st.pendingSince > 8000) {
        /* 8 秒既没"答错"提示、弹题也还在：属异常情况，交给人工确认，避免乱提交 */
        st.done = true;
        setStatus('⏸ 弹题提交后 8 秒无反馈（不确定是否答对），请手动作答确认');
        log('⏸ 弹题提交后 8 秒无反馈，请你手动作答确认', 'err');
        return true;
      } else {
        /* 还在等反馈，先返回，下一轮再判断 */
        setStatus('弹题：已选第 ' + (st.idx + 1) + '/' + st.opts.length + ' 个选项，等待反馈…');
        return true;
      }
    }

    if (st.done) return true;

    /* 提交第 st.idx 个选项 */
    const opt = st.opts[st.idx];
    try { opt.checked = true; } catch (e) {}
    realClick(opt);
    try { opt.click(); } catch (e) {}
    try {
      opt.dispatchEvent(new q.doc.defaultView.Event('change', { bubbles: true }));
    } catch (e) {}

    st.alertBase = q.doc.__cxLastAlert ? q.doc.__cxLastAlert.time : 0;
    st.pending = true;
    st.pendingSince = Date.now();
    st.submitted = true;

    realClick(st.submitBtn);
    try { st.submitBtn.click(); } catch (e) {}

    setStatus('弹题：已选第 ' + (st.idx + 1) + '/' + st.opts.length + ' 个选项，等待反馈…');
    return true;
  }

  /* 播放（先尝试带声音，被浏览器拦了就静音播） */
  /* 播放：按当前 muted 设置静音/有声；浏览器拦截（极少数情况）则提示手动 */
  function tryPlay(v) {
    if (!v) return;
    try { v.muted = muted; } catch (e) {}
    const p = v.play();
    if (p && typeof p.then === 'function') {
      p.then(function () {
        log('▶️ 开始播放' + (muted ? '（已静音）' : '（有声）') + '：' + shortName(videoKey(v)), 'ok');
      }).catch(function () {
        log('⚠️ 自动播放被浏览器拦截，请手动点一下播放键', 'warn');
      });
    }
  }

  /* ================================================================
   * 4.5 章节任务点标签页（1 基础知识 / 2 文档 / 3 视频 / 4 章节测验）
   *     很多章节默认落在「基础知识」，视频根本没加载，
   *     必须先点一下「视频」标签才能拿到 <video>。
   * ================================================================ */

  /* 元素是否真的显示出来了（隐藏的 <video> 播了也不算数） */
  function isVisible(el) {
    if (!el || !el.getBoundingClientRect) return false;
    try {
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    } catch (e) {
      return false;
    }
  }

  /* 该元素的某个近祖先是"标签栏"（同时含「基础知识」和「视频」） */
  function inTabBar(el) {
    let p = el.parentElement;
    let n = 0;
    while (p && n < 6) {
      const t = p.textContent || '';
      if (t.length < 300 && t.indexOf('基础知识') !== -1 && t.indexOf('视频') !== -1) return true;
      p = p.parentElement;
      n++;
    }
    return false;
  }

  /* 找到「视频」那个标签页元素（用文本匹配，不怕超星改 class 名） */
  function findVideoTab() {
    const docs = collectDocs();
    let best = null;
    for (let i = 0; i < docs.length; i++) {
      let els;
      try { els = docs[i].querySelectorAll('a, span, li, div, p, b, em, label'); } catch (e) { continue; }
      for (let j = 0; j < els.length; j++) {
        const el = els[j];
        const t = (el.textContent || '').replace(/\s/g, '');
        if (!/^\d*视频(播放)?$/.test(t)) continue;
        if (!isVisible(el)) continue;

        /* 打分：在标签栏里 +10；层级越深（元素越小）越好 */
        let depth = 0;
        let p = el.parentElement;
        while (p) { depth++; p = p.parentElement; }
        const score = (inTabBar(el) ? 10 : 0) + depth;
        if (!best || score > best.score) best = { el: el, score: score };
      }
    }
    return best ? best.el : null;
  }

  /* 每隔几秒尝试切到「视频」标签页；没找到就提醒一次 */
  function maybeClickVideoTab() {
    if (Date.now() - lastTabTryAt < 4000) return;
    lastTabTryAt = Date.now();

    const tab = findVideoTab();
    if (!tab) {
      if (!tabMissLogged) {
        tabMissLogged = true;
        log('ℹ️ 本节没有「视频」标签页（可能只有文档/测验），请自己处理完这一点，再点「手动下一节」', 'warn');
      }
      return;
    }
    /* 点标签本体；若它是 <a>/<li> 里的文字，就点最近的可点祖先 */
    const target = el_closest_clickable(tab);
    log('🖱 当前不在视频页，点了「' + (tab.textContent || '视频').replace(/\s+/g, '') + '」标签');
    realClick(target);
  }

  function el_closest_clickable(el) {
    try {
      return el.closest('a, li, button') || el;
    } catch (e) {
      return el;
    }
  }

  /* ================================================================
   * 5. 课程目录 / 切下一节
   * ================================================================ */

  function getChapterId() {
    const el = document.querySelector('#curChapterId');
    if (el && el.value) return el.value;
    const m = location.search.match(/chapterId=(\d+)/);
    return m ? m[1] : '';
  }

  /* 右侧目录里的所有小节节点（可能在顶层文档，也可能在某一层 iframe 里） */
  function catalogNodes() {
    const docs = collectDocs();
    for (let i = 0; i < docs.length; i++) {
      let nodes = [];
      try { nodes = docs[i].querySelectorAll('.posCatalog_level .posCatalog_select'); } catch (e) {}
      if (!nodes.length) {
        try { nodes = docs[i].querySelectorAll('.posCatalog_select'); } catch (e) {}
      }
      if (nodes.length) return Array.prototype.slice.call(nodes);
    }
    return [];
  }

  /* 当前正在播放的是第几个节点 */
  function activeIndex(nodes) {
    for (let i = 0; i < nodes.length; i++) {
      if (nodes[i].classList && nodes[i].classList.contains('posCatalog_active')) return i;
    }
    const cid = getChapterId();
    if (cid) {
      for (let i = 0; i < nodes.length; i++) {
        const attr = nodes[i].getAttribute('chapterid') ||
                     nodes[i].getAttribute('data-chapterid') ||
                     nodes[i].getAttribute('onclick') || '';
        if (attr.indexOf(cid) !== -1) return i;
      }
    }
    return -1;
  }

  function goNext() {
    const nodes = catalogNodes();
    if (!nodes.length) {
      log('❌ 没找到右侧课程目录（.posCatalog_select）。请确认右边「目录」面板是展开的', 'err');
      return false;
    }
    const idx = activeIndex(nodes);
    if (idx < 0) {
      log('❌ 认不出当前是目录里的哪一节。请手动点一次目录里的某一节，再点「开始」', 'err');
      return false;
    }
    if (idx >= nodes.length - 1) {
      log('🎉 已经是目录里的最后一节了，自动任务结束', 'ok');
      running = false;
      renderPanel();
      return false;
    }
    const next = nodes[idx + 1];
    const nameEl = next.querySelector('.posCatalog_name') || next;
    const title = (nameEl.textContent || '').replace(/\s+/g, ' ').trim();
    log('➡️ 切换到下一节：' + title);
    realClick(nameEl);
    return true;
  }

  /* ================================================================
   * 6. 主循环
   * ================================================================ */
  let statusText = '待启动';

  function setStatus(t) {
    statusText = t;
    renderPanel();
  }

  function tick() {
    if (panel && !panel.isConnected) {
      topDoc().documentElement.appendChild(panel);
    }
    if (!running || switching) return;

    /* 视频内弹题优先处理：单选题自动作答；多选题停下等手动；无弹题则往下走 */
    if (findQuiz()) {
      const handled = handleQuiz();
      if (handled) return; /* 还在处理弹题（提交/等待反馈/答错/等手动），先不播视频 */
      /* handled === false：弹题已消失（作答成功），继续往下走播放逻辑 */
    } else if (quizState && quizState.submitted && !quizState.done) {
      /* 上一题刚作答成功（弹题已被平台收掉），记一笔并清空状态 */
      log('弹题：作答成功，继续播放', 'ok');
      quizState = null;
    }

    const vids = findVideos();
    /* 优先用"看得见"的视频（隐藏的 <video> 播了也不算数） */
    const v = vids.filter(isVisible)[0];

    if (!v) {
      if (vids.length) {
        setStatus('检测到视频但当前标签页里看不到它，正在切到「视频」标签…');
      } else {
        setStatus('当前页面还没出现视频，正在尝试切到「视频」标签页…');
      }
      maybeClickVideoTab();
      return;
    }

    const key = videoKey(v);

    /* 发现新视频：接管并播放 */
    if (key !== lastKey) {
      lastKey = key;
      tabMissLogged = false;
      setStatus('已接管新视频，准备播放…');
      log('🎬 检测到视频：' + shortName(key) + '（时长 ' + fmtTime(v.duration) + '）');
      tryPlay(v);
      return;
    }

    /* 被暂停：只在你人还在（页面可见且聚焦）时恢复播放 */
    if (v.paused && !v.ended) {
      const here = document.visibilityState === 'visible' && document.hasFocus();
      if (here) {
        tryPlay(v);
      } else {
        setStatus('⏸ 视频已暂停（课程页面不在前台或未被聚焦）。脚本不会在你离开时偷偷续播，请把页面切回前台');
      }
      return;
    }

    /* 播放中：看进度 */
    if (!v.paused) {
      const ratio = v.duration ? (v.currentTime / v.duration) : 0;
      setStatus('播放中 ' + (ratio * 100).toFixed(1) + '%  (' +
                fmtTime(v.currentTime) + ' / ' + fmtTime(v.duration) + ')');

      if (v.ended || ratio >= CFG.FINISH_RATIO) {
        switching = true;
        const pct = (ratio * 100).toFixed(1);
        log('✅ 本节播完（' + pct + '%），' + (CFG.NEXT_WAIT_MS / 1000) + ' 秒后切下一节…', 'ok');
        setStatus('本节完成，准备切下一节…');
        setTimeout(function () {
          const ok = goNext();
          lastKey = '';
          tabMissLogged = false;
          lastTabTryAt = 0;
          setTimeout(function () { switching = false; }, ok ? 4000 : 1200);
        }, CFG.NEXT_WAIT_MS);
      }
    }
  }

  /* ================================================================
   * 7. 悬浮控制面板
   * ================================================================ */
  function log(msg, level) {
    const time = new Date().toTimeString().slice(0, 8);
    logs.push({ time: time, msg: msg, level: level || 'info' });
    if (logs.length > CFG.LOG_MAX) logs.shift();
    renderPanel();
  }

  const CSS = {
    info: '#333',
    ok: '#1a7f37',
    warn: '#b26a00',
    err: '#c0392b'
  };

  function renderPanel() {
    if (!panel) return;
    const statusEl = panel.querySelector('#cx-status');
    const logEl = panel.querySelector('#cx-log');
    const btn = panel.querySelector('#cx-toggle');
    const muteBtn = panel.querySelector('#cx-mute');
    if (statusEl) statusEl.textContent = statusText;
    if (muteBtn) muteBtn.textContent = muted ? '🔇' : '🔊';
    if (btn) {
      btn.textContent = running ? '⏸ 暂停自动' : '▶ 开始自动';
      btn.style.background = running ? '#e5533d' : '#1a7f37';
    }
    if (logEl) {
      let html = '';
      for (let i = logs.length - 1; i >= 0; i--) {
        const l = logs[i];
        html += '<div style="color:' + (CSS[l.level] || CSS.info) + '">[' + l.time + '] ' +
                escapeHtml(l.msg) + '</div>';
      }
      logEl.innerHTML = html;
    }
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c];
    });
  }

  function showFatal(e) {
    try {
      var box = document.getElementById('cx-fatal');
      if (!box) {
        box = document.createElement('div');
        box.id = 'cx-fatal';
        box.style.cssText = 'position:fixed;left:12px;top:12px;z-index:2147483647;max-width:340px;' +
          'background:#fff;border:1px solid #c0392b;border-radius:8px;padding:10px 12px;' +
          'color:#c0392b;font:12px/1.5 sans-serif;box-shadow:0 6px 20px rgba(0,0,0,.2)';
        (document.documentElement || document.body).appendChild(box);
      }
      box.innerHTML = '<b>脚本出错</b><div style="color:#333;margin-top:4px;white-space:pre-wrap;">' +
        escapeHtml(String((e && e.stack) ? e.stack : e)) + '</div>';
    } catch (x) {}
  }

  function buildPanel() {
    panel = document.createElement('div');
    panel.id = 'cx-autonext-panel';
    panel.style.cssText = [
      'position:fixed', 'left:12px', 'top:12px', 'width:300px', 'z-index:2147483647',
      'background:#fff', 'color:#222', 'border:1px solid #d0d5dd', 'border-radius:10px',
      'box-shadow:0 6px 20px rgba(0,0,0,.18)',
      'font:12px/1.6 -apple-system,"Segoe UI","Microsoft YaHei",sans-serif'
    ].join(';');

    panel.innerHTML = [
      '<div style="padding:8px 10px;border-bottom:1px solid #eceff3;display:flex;align-items:center;justify-content:space-between;">',
      '  <b style="font-size:13px;">学习通 · 自动下一节</b>',
      '  <span id="cx-min" style="cursor:pointer;color:#888;padding:0 4px;">—</span>',
      '</div>',
      '<div style="padding:8px 10px;">',
      '  <div id="cx-status" style="color:#475467;min-height:32px;">待启动</div>',
      '  <div style="display:flex;gap:6px;margin:8px 0;">',
      '    <button id="cx-toggle" style="flex:1;cursor:pointer;border:0;border-radius:6px;padding:7px 0;color:#fff;background:#1a7f37;font-size:12px;">▶ 开始自动</button>',
      '    <button id="cx-next" style="cursor:pointer;border:1px solid #d0d5dd;border-radius:6px;padding:7px 10px;background:#fff;font-size:12px;">手动下一节</button>',
      '    <button id="cx-mute" title="切换静音/有声" style="cursor:pointer;border:1px solid #d0d5dd;border-radius:6px;padding:7px 9px;background:#fff;font-size:13px;">🔇</button>',
      '  </div>',
      '  <div id="cx-log" style="max-height:150px;overflow-y:auto;border-top:1px solid #eceff3;padding-top:6px;"></div>',
      '  <div style="color:#98a2b3;margin-top:6px;">1 倍速 · 默认静音播放 · 不绕过检测</div>',
      '</div>'
    ].join('');

    topDoc().documentElement.appendChild(panel);

    panel.querySelector('#cx-toggle').addEventListener('click', function () {
      running = !running;
      if (running) {
        lastKey = '';
        switching = false;
        tabMissLogged = false;
        lastTabTryAt = 0;
        statusText = '已启动，正在寻找视频…';
        log('已启动自动播放', 'ok');
        tick();
      } else {
        statusText = '已暂停';
        log('已暂停自动播放', 'warn');
      }
      renderPanel();
    });

    panel.querySelector('#cx-next').addEventListener('click', function () {
      goNext();
    });

    /* 静音 / 有声 一键切换 */
    panel.querySelector('#cx-mute').addEventListener('click', function () {
      muted = !muted;
      const vs = findVideos();
      for (let i = 0; i < vs.length; i++) {
        try { vs[i].muted = muted; } catch (e) {}
      }
      log(muted ? '已切换为静音自动播放' : '已切换为有声播放（若浏览器拦截带声自动播放，需手动点一下播放键）',
          muted ? 'ok' : 'warn');
      renderPanel();
    });

    let collapsed = false;
    panel.querySelector('#cx-min').addEventListener('click', function () {
      collapsed = !collapsed;
      const body = panel.children[1];
      body.style.display = collapsed ? 'none' : '';
    });

    /* 允许拖动面板 */
    const head = panel.children[0];
    head.style.cursor = 'move';
    head.addEventListener('mousedown', function (e) {
      if (e.target.id === 'cx-min') return;
      const rect = panel.getBoundingClientRect();
      const dx = e.clientX - rect.left;
      const dy = e.clientY - rect.top;
      function move(ev) {
        panel.style.left = Math.max(0, ev.clientX - dx) + 'px';
        panel.style.top = Math.max(0, ev.clientY - dy) + 'px';
      }
      function up() {
        document.removeEventListener('mousemove', move);
        document.removeEventListener('mouseup', up);
      }
      document.addEventListener('mousemove', move);
      document.addEventListener('mouseup', up);
    });

    renderPanel();
  }

  /* ================================================================
   * 8. 启动
   * ================================================================ */
  function boot() {
    try {
      bootAt = Date.now();
      const td = topDoc();
      /* 关键：脚本一运行就立刻建面板 + 诊断，避免"目录没检测到就完全不建面板"的静默失败 */
      if (!td.__cxPanelBuilt) {
        td.__cxPanelBuilt = true;
        buildPanel();
        log('脚本已运行。正在检测课程目录…');
        setStatus('脚本已运行 · 正在检测右侧课程目录…');
      }
      /* 看门狗：① 目录可能是 AJAX 后加载，等到出现再激活；② 面板被冲刷则自愈；③ 一直找不到目录就给明确诊断 */
      setInterval(watchdog, 1200);
      watchdog();
    } catch (e) {
      showFatal(e);
    }
  }

  let watchdogInited = false;
  function watchdog() {
    try {
      const td = topDoc();
      /* 面板自愈：被页面重新渲染冲掉时自动重建 */
      if (td.__cxPanelBuilt) {
        if (!panel || panel.ownerDocument !== td || !panel.isConnected) {
          buildPanel();
          log('面板被页面刷新冲掉，已重建', 'warn');
        }
      }

      const nodes = catalogNodes();
      if (nodes.length > 0) {
        if (!catalogSeenAt) {
          catalogSeenAt = Date.now();
          log('页面就绪（目录已检测到，共 ' + nodes.length + ' 节）', 'ok');
          setStatus('目录已就绪，点「开始自动」即可');
        }
      } else if (catalogSeenAt === 0 && bootAt && Date.now() - bootAt > 12000) {
        /* 跑了 12 秒还没目录：给明确诊断，而不是静默空白 */
        setStatus('⚠ 12 秒仍未检测到右侧目录——可能：① 右侧"目录"面板没展开；② 超星改版了选择器；③ 脚本没在课程页运行。请展开目录或把 F12 Console 报错发我');
        if (!catalogWarnLogged) {
          catalogWarnLogged = true;
          log('⚠ 未检测到课程目录（.posCatalog_select）。请先展开右侧"目录"，或检查超星是否改版', 'err');
        }
      }

      /* 主循环只起一次（目录找到前也能先接管已在播的视频） */
      if (!watchdogInited) {
        watchdogInited = true;
        setInterval(tick, CFG.POLL_MS);
        document.addEventListener('visibilitychange', function () {
          if (document.visibilityState === 'visible') setTimeout(tick, 300);
        });
        window.addEventListener('focus', function () { setTimeout(tick, 300); });
      }
    } catch (e) {
      showFatal(e);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
