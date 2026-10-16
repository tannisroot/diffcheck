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
  const summaryEl = $('summary');
  const diffEl = $('diff');
  const themeBtn = $('theme-toggle');
  const resetBtn = $('reset');
  const restoreEl = $('restore');
  const restoreYes = $('restore-yes');
  const restoreNo = $('restore-no');

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
    return { rows, adds, dels };
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

  function renderTable(rows) {
    const table = el('table', 'diff');

    const cols = el('colgroup');
    for (const w of ['4rem', 'auto', '4rem', 'auto']) {
      const c = document.createElement('col');
      c.style.width = w;
      cols.appendChild(c);
    }
    table.appendChild(cols);

    const head = el('tr');
    for (const label of ['Original', 'Changed']) {
      const th = el('th', '', label);
      th.colSpan = 2;
      head.appendChild(th);
    }
    table.appendChild(el('thead')).appendChild(head);

    const body = el('tbody');
    const frag = document.createDocumentFragment();
    for (const { l, r } of rows) {
      const tr = el('tr');
      tr.append(numCell(l), codeCell(l), numCell(r), codeCell(r));
      frag.appendChild(tr);
    }
    body.appendChild(frag);
    table.appendChild(body);
    return table;
  }

  function showSummary(nodes) {
    summaryEl.replaceChildren(...nodes);
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
    diffEl.replaceChildren();

    if (a.length > MAX_CHARS || b.length > MAX_CHARS) {
      showSummary([el('span', 'msg', 'Input is too large (limit: 1,000,000 characters per side).')]);
      return;
    }
    const la = toLines(a);
    const lb = toLines(b);
    if (la.length > MAX_LINES || lb.length > MAX_LINES) {
      showSummary([el('span', 'msg', `Input has too many lines (limit: ${MAX_LINES.toLocaleString()} per side).`)]);
      return;
    }

    const out = buildRows(la, lb);
    if (!out) {
      showSummary([el('span', 'msg', 'The texts differ too much to compare within the time limit.')]);
      return;
    }

    if (out.adds === 0 && out.dels === 0) {
      showSummary([el('span', 'msg', 'No differences found. The texts are identical.')]);
    } else {
      showSummary([
        el('span', 'n-add', `+${out.adds.toLocaleString()} added`),
        el('span', 'n-del', `\u2212${out.dels.toLocaleString()} removed`),
      ]);
    }
    diffEl.replaceChildren(renderTable(out.rows));
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
    summaryEl.replaceChildren();
    diffEl.replaceChildren();
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
