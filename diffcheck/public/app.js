(() => {
  'use strict';

  // Limits keep the user's own tab responsive. All work is client-side;
  // nothing typed here is ever sent anywhere or stored.
  const MAX_CHARS = 1_000_000;
  const MAX_LINES = 50_000;
  const MAX_INLINE_CHARS = 2_000;
  const DIFF_TIMEOUT_MS = 5_000;
  const MIN_SIMILARITY = 0.3; // below this, skip word-level highlighting

  const $ = (id) => document.getElementById(id);
  const root = document.documentElement;
  const originalEl = $('original');
  const changedEl = $('changed');
  const findBtn = $('find');
  const resultEl = $('result');
  const diffEl = $('diff');
  const diffIsland = $('diff-island');
  const noticeEl = $('notice');
  const noticeIcon = $('notice-icon');
  const noticeTitle = $('notice-title');
  const noticeText = $('notice-text');
  const themeBtn = $('theme-toggle');
  const resetBtn = $('reset');
  const restoreEl = $('restore');
  const restoreYes = $('restore-yes');
  const restoreNo = $('restore-no');

  // ---- Line-number gutters --------------------------------------------
  // Numbers are per logical line. When a long line wraps in the textarea, extra blank
  // rows are added after its number so every number stays level with its text.
  const NON_PLAIN = /[^\x20-\x7e]/; // tabs, control and non-ASCII chars can change widths
  const mirror = document.createElement('div');
  mirror.className = 'mirror';
  const probe = document.createElement('div');
  probe.className = 'mirror probe';
  document.body.append(mirror, probe);

  function linkGutter(ta, gutter) {
    let prev = '';
    let digits = 0;

    const update = () => {
      const lines = ta.value.split('\n');
      const n = lines.length;
      const cs = getComputedStyle(ta);
      const lh = parseFloat(cs.lineHeight) || 19.5;
      const width = ta.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);

      probe.textContent = '0'.repeat(100);
      const charW = probe.getBoundingClientRect().width / 100;
      const perRow = charW > 0 ? Math.max(1, Math.floor(width / charW)) : Infinity;

      // Only lines that might wrap need measuring; the rest are exactly one row.
      const cand = [];
      for (let i = 0; i < n; i++) {
        if (lines[i].length > perRow || NON_PLAIN.test(lines[i])) cand.push(i);
      }
      const rows = new Map();
      if (cand.length && width > 0) {
        mirror.style.width = `${width}px`;
        const frag = document.createDocumentFragment();
        for (const i of cand) {
          const d = document.createElement('div');
          d.textContent = lines[i];
          frag.appendChild(d);
        }
        mirror.replaceChildren(frag);
        const kids = mirror.children;
        for (let k = 0; k < cand.length; k++) {
          rows.set(cand[k], Math.max(1, Math.round(kids[k].offsetHeight / lh)));
        }
        mirror.replaceChildren();
      }

      const parts = new Array(n);
      for (let i = 0; i < n; i++) {
        const r = rows.get(i) || 1;
        parts[i] = r === 1 ? String(i + 1) : `${i + 1}${'\n'.repeat(r - 1)}`;
      }
      const text = parts.join('\n');
      if (text !== prev) { prev = text; gutter.textContent = text; }

      const d = Math.max(2, String(n).length);
      if (d !== digits) { digits = d; gutter.style.width = `calc(${d}ch + 14px)`; }
      gutter.scrollTop = ta.scrollTop;
    };

    ta.addEventListener('input', update);
    ta.addEventListener('scroll', () => { gutter.scrollTop = ta.scrollTop; });
    if (typeof ResizeObserver === 'function') new ResizeObserver(update).observe(ta);
    update();
    return update;
  }
  const updateOriginalGutter = linkGutter(originalEl, $('original-gutter'));
  const updateChangedGutter = linkGutter(changedEl, $('changed-gutter'));
  const updateGutters = () => { updateOriginalGutter(); updateChangedGutter(); };

  // ---- Theme ---------------------------------------------------------
  const paintThemeBtn = () => {
    const dark = root.dataset.theme === 'dark';
    const label = dark ? 'Switch to light theme' : 'Switch to dark theme';
    themeBtn.setAttribute('aria-label', label);
    themeBtn.title = label;
  };
  themeBtn.addEventListener('click', () => {
    const next = root.dataset.theme === 'dark' ? 'light' : 'dark';
    root.dataset.theme = next;
    try { localStorage.setItem('theme', next); } catch { /* ignore */ }
    paintThemeBtn();
  });
  paintThemeBtn();

  // ---- Diff model ----------------------------------------------------
  const toLines = (s) => s.replace(/\r\n?/g, '\n').split('\n');

  // Word-level diff for a pair of changed lines. Returns null when the lines
  // are too long or too dissimilar for inline highlighting to be useful.
  function inlineDiff(a, b) {
    if (a.length > MAX_INLINE_CHARS || b.length > MAX_INLINE_CHARS) return null;
    const parts = Diff.diffWordsWithSpace(a, b, { timeout: 100 });
    if (!parts) return null;
    let common = 0;
    for (const p of parts) if (!p.added && !p.removed) common += p.value.length;
    if (common / Math.max(a.length, b.length, 1) < MIN_SIMILARITY) return null;
    const left = [];
    const right = [];
    for (const p of parts) {
      if (p.added) right.push({ t: p.value, c: true });
      else if (p.removed) left.push({ t: p.value, c: true });
      else { left.push({ t: p.value }); right.push({ t: p.value }); }
    }
    return { left, right };
  }

  function buildRows(a, b) {
    const parts = Diff.diffArrays(a, b, { timeout: DIFF_TIMEOUT_MS });
    if (!parts) return null; // timed out
    const rows = [];
    let ln = 1;
    let rn = 1;
    let adds = 0;
    let dels = 0;

    for (let i = 0; i < parts.length; i++) {
      const p = parts[i];
      if (!p.added && !p.removed) {
        for (const t of p.value) rows.push({ l: { n: ln++, t }, r: { n: rn++, t } });
      } else if (p.removed) {
        let added = [];
        if (parts[i + 1] && parts[i + 1].added) added = parts[++i].value;
        const removed = p.value;
        dels += removed.length;
        adds += added.length;
        const len = Math.max(removed.length, added.length);
        for (let k = 0; k < len; k++) {
          const l = k < removed.length ? { n: ln++, t: removed[k], k: 'del' } : null;
          const r = k < added.length ? { n: rn++, t: added[k], k: 'add' } : null;
          if (l && r) {
            const segs = inlineDiff(l.t, r.t);
            if (segs) { l.segs = segs.left; r.segs = segs.right; }
          }
          rows.push({ l, r });
        }
      } else {
        adds += p.value.length;
        for (const t of p.value) rows.push({ l: null, r: { n: rn++, t, k: 'add' } });
      }
    }
    return { rows, adds, dels, leftLines: ln - 1, rightLines: rn - 1 };
  }

  // ---- Rendering (DOM APIs + textContent only; never innerHTML) ------
  function el(tag, cls, text) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function numCell(side) {
    const td = el('td', 'num', side ? String(side.n) : '');
    if (!side) td.classList.add('empty');
    else if (side.k) td.classList.add(side.k);
    return td;
  }

  function codeCell(side) {
    const td = el('td', 'code');
    if (!side) { td.classList.add('empty'); return td; }
    if (side.k) td.classList.add(side.k);
    if (side.segs) {
      const cls = side.k === 'del' ? 'seg-del' : 'seg-add';
      for (const s of side.segs) {
        if (s.c) td.appendChild(el('span', cls, s.t));
        else td.appendChild(document.createTextNode(s.t));
      }
    } else {
      td.textContent = side.t;
    }
    return td;
  }

  function renderTable(rows, adds, dels, leftLines, rightLines) {
    const table = el('table', 'diff');

    const cols = el('colgroup');
    // Number columns are sized to the widest line number: 17px left padding + digits + 0.6rem.
    const digits = Math.max(2, String(Math.max(leftLines, rightLines)).length);
    const numW = `calc(${digits}ch + 17px + 0.6rem)`;
    for (const w of ['8px', numW, 'auto', '40px', numW, 'auto', '8px']) {
      const c = document.createElement('col');
      c.style.width = w;
      cols.appendChild(c);
    }
    table.appendChild(cols);

    // Header: each side's counter on the left and its line count on the right, above that side.
    const plural = (n, one, many) => `${n.toLocaleString()} ${n === 1 ? one : many}`;
    const headCell = (statEl, lineCount) => {
      const th = el('th');
      th.colSpan = 2;
      const inner = el('div', 'th-inner');
      inner.append(statEl, el('span', 'lines', plural(lineCount, 'line', 'lines')));
      th.appendChild(inner);
      return th;
    };
    const head = el('tr');
    head.append(
      el('th', 'gap'),
      headCell(stat('del', 'minus', dels, 'removal', 'removals'), leftLines),
      el('th', 'gap'),
      headCell(stat('add', 'plus', adds, 'addition', 'additions'), rightLines),
      el('th', 'gap'),
    );
    const padRow = el('tr', 'pad'); // 8px of space between the header line and the first row
    const padCell = el('td');
    padCell.colSpan = 7;
    padRow.appendChild(padCell);
    const thead = el('thead');
    thead.append(head, padRow);
    table.appendChild(thead);

    const body = el('tbody');
    const frag = document.createDocumentFragment();
    const kindOf = (side) => (side ? side.k || '' : 'empty');
    const isChanged = (row) => Boolean(kindOf(row.l) || kindOf(row.r));
    rows.forEach((row, i) => {
      const prev = rows[i - 1];
      const next = rows[i + 1];
      const tr = el('tr');
      tr.appendChild(el('td', 'gap'));
      for (const key of ['l', 'r']) {
        const side = row[key];
        const kind = kindOf(side);
        const cells = [numCell(side), codeCell(side)];
        if (kind) { // first/last row of a highlighted run gets the rounded corners
          if (!prev || kindOf(prev[key]) !== kind) for (const td of cells) td.classList.add('r-top');
          if (!next || kindOf(next[key]) !== kind) for (const td of cells) td.classList.add('r-bot');
        }
        if (!isChanged(row)) { // regular row next to a changed run: add the outside gap
          if (next && isChanged(next)) for (const td of cells) td.classList.add('sp-b');
          if (prev && isChanged(prev)) for (const td of cells) td.classList.add('sp-t');
        }
        tr.append(...cells);
        tr.appendChild(el('td', 'gap'));
      }
      frag.appendChild(tr);
    });
    body.appendChild(frag);
    table.appendChild(body);
    return table;
  }

  // Icons are built with the DOM API (no innerHTML), as the CSP and Trusted Types require.
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const ICONS = {
    minus: [['circle', { cx: 12, cy: 12, r: 10 }], ['path', { d: 'M8 12h8' }]],
    plus: [['circle', { cx: 12, cy: 12, r: 10 }], ['path', { d: 'M8 12h8M12 8v8' }]],
    info: [
      ['circle', { cx: 12, cy: 12, r: 11.5, fill: 'currentColor', stroke: 'none' }],
      ['path', { d: 'M12 11v5.5', class: 'glyph' }],
      ['circle', { cx: 12, cy: 7.6, r: 1.4, class: 'glyph-dot' }],
    ],
    alert: [
      ['circle', { cx: 12, cy: 12, r: 11.5, fill: 'currentColor', stroke: 'none' }],
      ['path', { d: 'M12 7v5.5', class: 'glyph' }],
      ['circle', { cx: 12, cy: 16.4, r: 1.4, class: 'glyph-dot' }],
    ],
  };

  function svgIcon(name, size) {
    const svg = document.createElementNS(SVG_NS, 'svg');
    const attrs = {
      viewBox: '0 0 24 24', width: size, height: size, fill: 'none', stroke: 'currentColor',
      'stroke-width': 2, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true',
    };
    for (const [k, v] of Object.entries(attrs)) svg.setAttribute(k, String(v));
    for (const [tag, a] of ICONS[name]) {
      const shape = document.createElementNS(SVG_NS, tag);
      for (const [k, v] of Object.entries(a)) shape.setAttribute(k, String(v));
      svg.appendChild(shape);
    }
    return svg;
  }

  function stat(kind, icon, count, singular, plural) {
    const span = el('span', `stat ${kind}`);
    span.append(svgIcon(icon, 17.5), document.createTextNode(`${count.toLocaleString()} ${count === 1 ? singular : plural}`));
    return span;
  }

  function hideAll() {
    noticeEl.hidden = true;
    diffIsland.hidden = true;
    diffEl.replaceChildren();
  }

  function showDiff(out) {
    diffIsland.hidden = false;
    diffEl.replaceChildren(renderTable(out.rows, out.adds, out.dels, out.leftLines, out.rightLines));
  }

  function showNotice(kind, title, text) {
    noticeEl.hidden = false;
    noticeEl.classList.toggle('error', kind === 'error');
    noticeIcon.replaceChildren(svgIcon(kind === 'error' ? 'alert' : 'info', 19));
    noticeTitle.textContent = title;
    noticeText.textContent = text;
  }

  function showResult(visible) {
    resultEl.hidden = !visible;
    document.body.classList.toggle('has-result', visible);
  }

  // ---- Main action ---------------------------------------------------
  function run() {
    const a = originalEl.value;
    const b = changedEl.value;

    showResult(true);
    hideAll();

    if (a.length > MAX_CHARS || b.length > MAX_CHARS) {
      showNotice('error', 'Input is too large', 'The limit is 1,000,000 characters per side.');
      return;
    }
    const la = toLines(a);
    const lb = toLines(b);
    if (la.length > MAX_LINES || lb.length > MAX_LINES) {
      showNotice('error', 'Input has too many lines', `The limit is ${MAX_LINES.toLocaleString()} lines per side.`);
      return;
    }

    const out = buildRows(la, lb);
    if (!out) {
      showNotice('error', 'Comparison timed out', 'The texts differ too much to compare within the time limit.');
      return;
    }

    if (out.adds === 0 && out.dels === 0) {
      showNotice('info', 'The two texts are identical', 'There is no difference to show between these two texts');
    }
    showDiff(out); // always rendered, including when the texts are identical
  }

  function onFind() {
    findBtn.disabled = true;
    findBtn.textContent = 'Comparing\u2026';
    // Yield once so the button state paints before the (synchronous) diff runs.
    setTimeout(() => {
      try { run(); } finally {
        findBtn.disabled = false;
        findBtn.textContent = 'Find Difference';
        window.scrollTo(0, 0);
        saveSession();
      }
    }, 0);
  }

  // ---- Session restore -----------------------------------------------
  // Text is kept in sessionStorage only: per tab, never sent anywhere, and gone when
  // the tab closes. It is cleared by Reset, by dismissing the prompt, and on any
  // page load that is not a reload.
  const KEY = 'diffcheck.session';
  let saveTimer = 0;

  function clearSession() {
    try { sessionStorage.removeItem(KEY); } catch { /* ignore */ }
  }

  function saveSession() {
    try {
      const a = originalEl.value;
      const b = changedEl.value;
      if (!a && !b) { sessionStorage.removeItem(KEY); return; }
      sessionStorage.setItem(KEY, JSON.stringify({ a, b, d: !resultEl.hidden }));
    } catch { /* storage full or unavailable: restore is best-effort */ }
  }

  function readSession() {
    try {
      const raw = sessionStorage.getItem(KEY);
      if (!raw) return null;
      const o = JSON.parse(raw);
      if (!o || typeof o.a !== 'string' || typeof o.b !== 'string') return null;
      return { a: o.a.slice(0, MAX_CHARS), b: o.b.slice(0, MAX_CHARS), d: o.d === true };
    } catch { return null; }
  }

  function scheduleSave() {
    if (!restoreEl.hidden) restoreEl.hidden = true; // user moved on; don't offer stale data
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveSession, 300);
  }

  function resetAll() {
    clearTimeout(saveTimer);
    originalEl.value = '';
    changedEl.value = '';
    updateGutters();
    hideAll();
    showResult(false);
    restoreEl.hidden = true;
    clearSession();
    window.scrollTo(0, 0);
    originalEl.focus();
  }

  const nav = performance.getEntriesByType && performance.getEntriesByType('navigation')[0];
  const saved = readSession();
  if (saved && nav && nav.type === 'reload') {
    restoreEl.hidden = false;
    restoreYes.addEventListener('click', () => {
      originalEl.value = saved.a;
      changedEl.value = saved.b;
      updateGutters();
      restoreEl.hidden = true;
      if (saved.d) run();
      saveSession();
    });
    restoreNo.addEventListener('click', () => {
      restoreEl.hidden = true;
      clearSession();
    });
  } else if (saved) {
    clearSession();
  }

  resetBtn.addEventListener('click', resetAll);
  originalEl.addEventListener('input', scheduleSave);
  changedEl.addEventListener('input', scheduleSave);

  findBtn.addEventListener('click', onFind);
  for (const ta of [originalEl, changedEl]) {
    ta.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); onFind(); }
    });
  }
})();
