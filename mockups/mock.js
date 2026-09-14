/* ------------------------------------------------------------------
   engram — mock behaviour
   Dữ liệu giả + logic omnibox + bảng JSON. Không gọi mạng, không crypto
   thật: "mở khoá" ở đây chỉ là đổi state hiển thị.
   Bám SPEC.md §6.4 (xếp hạng), §7.2 (omnibox), §7.4 (JSON như bảng).
------------------------------------------------------------------ */
(function () {
  'use strict';

  /* ---------- dữ liệu giả ---------- */

  const TAGS = [
    { name: 'nhà', count: 24 },
    { name: 'office', count: 11 },
    { name: 'công-ty', count: 8 },
    { name: 'ops', count: 15 },
    { name: 'home-lab', count: 6 },
    { name: 'okrs', count: 4 },
    { name: 'wifi-khách', count: 2 }
  ];

  const ITEMS = [
    {
      id: 'i1', name: 'wifi', hint: '', tags: ['nhà', 'office'],
      entries: 12, updated: '12/03/2026', touched: 9
    },
    {
      id: 'i2', name: 'wifi', hint: 'tầng 4 — SSID nội bộ', tags: ['công-ty'],
      entries: 3, updated: '01/06/2026', touched: 6
    },
    {
      id: 'i3', name: 'wifi-office', hint: '', tags: ['office'],
      entries: 3, updated: '28/05/2026', touched: 4
    },
    {
      id: 'i4', name: 'mạng nhà', hint: 'router, VLAN, DNS', tags: ['nhà', 'home-lab'],
      entries: 7, updated: '02/09/2026', touched: 8
    },
    {
      id: 'i5', name: 'docker', hint: '', tags: ['ops', 'home-lab'],
      entries: 9, updated: '10/09/2026', touched: 12
    },
    {
      id: 'i6', name: 'k8s', hint: 'kubernetes cụm nhà', tags: ['ops', 'home-lab'],
      entries: 5, updated: '30/08/2026', touched: 5
    },
    {
      id: 'i7', name: 'meeting-mkt', hint: '', tags: ['okrs'],
      entries: 4, updated: '11/09/2026', touched: 7
    },
    {
      id: 'i8', name: 'api key openai', hint: '', tags: ['ops'],
      entries: 2, updated: '19/07/2026', touched: 3
    },
    {
      id: 'i9', name: 'hợp đồng thuê nhà', hint: '', tags: ['nhà'],
      entries: 6, updated: '05/01/2026', touched: 2
    },
    {
      id: 'i10', name: 'ngân hàng', hint: 'số tài khoản, chi nhánh', tags: [],
      entries: 3, updated: '22/04/2026', touched: 4
    }
  ];

  /* Bản đồ "gần nghĩa" giả lập vector search. Thật ra là bge-m3 + pgvector;
     ở mockup chỉ cần cho thấy nhóm này nằm RIÊNG, dưới nhóm lexical. */
  const SEMANTIC = [
    { triggers: ['mat khau', 'password', 'pass', 'mk'], hits: [['i1', .86], ['i2', .82], ['i8', .74]] },
    { triggers: ['mang', 'internet', 'router', 'ssid', 'network'], hits: [['i4', .88], ['i1', .79], ['i6', .68]] },
    { triggers: ['wifi', 'wi-fi'], hits: [['i4', .81]] },
    { triggers: ['container', 'image', 'compose'], hits: [['i5', .84], ['i6', .77]] },
    { triggers: ['hop', 'lich hop', 'meeting', 'bien ban'], hits: [['i7', .85]] },
    { triggers: ['thue nha', 'nha tro', 'contract'], hits: [['i9', .83]] },
    { triggers: ['tien', 'chuyen khoan', 'bank'], hits: [['i10', .87]] }
  ];

  /* ---------- tiện ích ---------- */

  // Tương đương unaccent() của Postgres, đủ dùng cho mock.
  const foldChar = (c) => c.toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/đ/g, 'd');

  const norm = (s) => String(s || '').split('').map(foldChar).join('').replace(/\s+/g, ' ').trim();

  const esc = (s) => String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  /* Gấp từng ký tự một để index của chuỗi đã gấp ánh xạ 1-1 về chuỗi gốc
     (NFD làm lệch độ dài nếu gấp cả chuỗi). */
  function foldIndexed(text) {
    let n = '';
    const map = [];
    for (let i = 0; i < text.length; i++) {
      const f = foldChar(text[i]);
      for (let j = 0; j < f.length; j++) map.push(i);
      n += f;
    }
    map.push(text.length);
    return { n, map };
  }

  function markPrefix(text, q) {
    const nq = norm(q);
    if (!nq) return esc(text);
    const { n, map } = foldIndexed(text);
    const at = n.indexOf(nq);
    if (at < 0) return esc(text);
    const a = map[at];
    const b = map[Math.min(at + nq.length, map.length - 1)];
    return esc(text.slice(0, a)) + '<mark>' + esc(text.slice(a, b)) + '</mark>' + esc(text.slice(b));
  }

  const state = { semantic: true, locked: false };

  /* ---------- tìm kiếm ---------- */
  /* Bậc cứng: prefix(3) > fuzzy(2) > semantic(1) > recency(0).
     Nhóm hiển thị tách rời nên bật/tắt ≈ KHÔNG xáo trộn thứ tự lexical. */

  function parseAdd(q) {
    const colon = q.indexOf(':');
    if (colon < 0) return null;
    const left = q.slice(0, colon);
    const content = q.slice(colon + 1).trim();
    const tags = (left.match(/#[^\s#]+/g) || []).map((t) => t.slice(1));
    const name = left.replace(/#[^\s#]+/g, '').trim();
    if (!name) return null;
    const trimmed = content.trimStart();
    return {
      name, tags, content,
      type: (trimmed.startsWith('{') || trimmed.startsWith('[')) ? 'json' : 'text',
      dupes: ITEMS.filter((i) => norm(i.name) === norm(name))
    };
  }

  function search(q) {
    // Ở chế độ thêm nhanh, phần tìm kiếm chạy trên phần tên — để thấy ngay
    // mục trùng tên trước khi Enter (SPEC §3.4).
    const add = parseAdd(q);
    const effective = add ? add.name : q;
    const nq = norm(effective);
    const out = { tags: [], items: [], semantic: [], add, query: effective };

    if (!nq) {
      out.tags = TAGS.slice()
        .sort((a, b) => b.count - a.count).slice(0, 4);
      out.items = ITEMS.slice()
        .sort((a, b) => b.touched - a.touched).slice(0, 6);
      out.recent = true;
      return out;
    }

    const rank = (name) => {
      const n = norm(name);
      if (n.startsWith(nq)) return 3;
      if (n.includes(nq)) return 2;
      const parts = n.split(/[\s-]+/);
      if (parts.some((p) => p.startsWith(nq))) return 2;
      return 0;
    };

    out.tags = TAGS
      .map((t) => ({ ...t, tier: rank(t.name) }))
      .filter((t) => t.tier > 0)
      .sort((a, b) => b.tier - a.tier || b.count - a.count)
      .slice(0, 5);

    out.items = ITEMS
      .map((it) => ({ ...it, tier: Math.max(rank(it.name), rank(it.hint) ? 2 : 0) }))
      .filter((it) => it.tier > 0)
      .sort((a, b) => b.tier - a.tier || b.touched - a.touched)
      .slice(0, 6);

    if (state.semantic) {
      const seen = new Set(out.items.map((i) => i.id));
      const acc = new Map();
      SEMANTIC.forEach((g) => {
        const match = g.triggers.some((t) => t === nq || t.startsWith(nq) || (nq.length >= 3 && nq.startsWith(t)));
        if (!match) return;
        g.hits.forEach(([id, score]) => {
          if (seen.has(id)) return;
          if (!acc.has(id) || acc.get(id) < score) acc.set(id, score);
        });
      });
      out.semantic = [...acc.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .map(([id, score]) => ({ ...ITEMS.find((i) => i.id === id), score }));
    }

    return out;
  }

  /* ---------- render gợi ý ---------- */

  function itemIcon(it) {
    const ch = esc(it.name.trim()[0] || '?');
    return `<span class="mono" style="width:22px;height:22px;flex:none;display:inline-flex;align-items:center;
      justify-content:center;border-radius:var(--r-sm);background:var(--surface-alt);color:var(--muted);
      font-size:12px">${ch}</span>`;
  }

  function renderSuggest(pop, res, opts) {
    const rows = [];
    let html = '';

    if (res.add) {
      html += `<div class="sugg-group">Thêm nhanh</div>`;
      const tagChips = res.add.tags.map((t) => `<span class="chip" style="padding:2px 8px;font-size:12px">#${esc(t)}</span>`).join(' ');
      rows.push({ kind: 'add', add: res.add });
      html += `<button class="sugg-row" data-i="${rows.length - 1}">
        <span class="mono" style="width:22px;height:22px;flex:none;display:inline-flex;align-items:center;
          justify-content:center;border-radius:var(--r-sm);background:var(--primary);color:var(--on-primary);font-size:13px">+</span>
        <span>Lưu vào <strong>${esc(res.add.name)}</strong> ${tagChips}</span>
        <span class="sugg-meta"><span class="badge-type badge-${res.add.type}">${res.add.type}</span>
        <span class="kbd">Enter</span></span></button>`;
    }

    if (res.tags.length) {
      html += `<div class="sugg-group">${res.recent ? 'Tag hay dùng' : 'Tags'}</div>`;
      res.tags.forEach((t) => {
        rows.push({ kind: 'tag', tag: t });
        html += `<button class="sugg-row" data-i="${rows.length - 1}">
          <span class="mono" style="color:var(--accent);width:22px;text-align:center;flex:none">#</span>
          <span>${markPrefix(t.name, res.query)}</span>
          <span class="sugg-meta">${t.count} mục</span></button>`;
      });
    }

    if (res.items.length) {
      html += `<div class="sugg-group">${res.recent ? 'Gần đây' : (res.add ? 'Mục đang có cùng tên' : 'Items')}</div>`;
      res.items.forEach((it) => {
        rows.push({ kind: 'item', item: it });
        html += `<button class="sugg-row" data-i="${rows.length - 1}">
          ${itemIcon(it)}
          <span>${markPrefix(it.name, res.query)}
            ${it.tags.map((t) => `<span class="mono" style="color:var(--muted);font-size:12px">#${esc(t)}</span>`).join(' ')}
            ${it.hint ? `<span style="color:var(--muted);font-size:13px"> — ${esc(it.hint)}</span>` : ''}</span>
          <span class="sugg-meta">${it.entries} entries · ${it.updated}</span></button>`;
      });
    }

    if (res.semantic && res.semantic.length) {
      html += `<div class="sugg-group">Gần nghĩa</div>`;
      res.semantic.forEach((it) => {
        rows.push({ kind: 'item', item: it });
        html += `<button class="sugg-row" data-i="${rows.length - 1}">
          <span class="mono" style="color:var(--muted);width:22px;text-align:center;flex:none">≈</span>
          <span>${esc(it.name)}
            ${it.tags.map((t) => `<span class="mono" style="color:var(--muted);font-size:12px">#${esc(t)}</span>`).join(' ')}</span>
          <span class="sugg-meta mono">${it.score.toFixed(2)}</span></button>`;
      });
    }

    if (!rows.length) {
      html += `<div style="padding:28px 20px;text-align:center">
        <p class="t-body" style="margin:0 0 4px;color:var(--body)">Không có gì khớp “${esc(res.query)}”.</p>
        <p class="t-caption" style="margin:0 0 16px;color:var(--muted)">Gõ <span class="mono">${esc(res.query)}: nội dung</span> để lưu ngay.</p>
        <button class="btn btn-primary btn-sm" data-create="1">Tạo mục “${esc(res.query)}”</button></div>`;
    }

    html += `<div style="display:flex;gap:14px;align-items:center;padding:10px 16px;border-top:1px solid var(--border);
      background:var(--surface);color:var(--muted);font-size:12px">
      <span><span class="kbd">↑↓</span> chọn</span>
      <span><span class="kbd">Enter</span> mở</span>
      <span><span class="kbd">Tab</span> điền</span>
      <span style="margin-left:auto">${state.semantic ? 'Gần nghĩa: bật' : 'Gần nghĩa: tắt'}</span></div>`;

    pop.innerHTML = html;
    pop.hidden = false;
    return rows;
  }

  /* ---------- omnibox ---------- */

  function initOmnibox(root, opts) {
    opts = opts || {};
    const input = root.querySelector('.omnibox-input');
    const shell = root.querySelector('.omnibox-shell');
    const pop = root.querySelector('[data-pop]');
    let rows = [];
    let sel = -1;

    function paint() {
      const res = search(input.value);
      shell.classList.toggle('is-add', !!res.add);
      rows = renderSuggest(pop, res, opts);
      sel = rows.length ? 0 : -1;
      highlight();
    }

    function highlight() {
      pop.querySelectorAll('.sugg-row').forEach((el, i) => {
        el.setAttribute('aria-selected', String(i === sel));
        if (i === sel) el.scrollIntoView({ block: 'nearest' });
      });
    }

    function activate(i) {
      const r = rows[i];
      if (!r) return;
      if (r.kind === 'add') {
        if (r.add.dupes.length) { openDupDialog(r.add); return; }
        toast(`Đã lưu vào “${r.add.name}”`, 'Hoàn tác');
        input.value = '';
        paint();
        return;
      }
      if (r.kind === 'tag') {
        if (opts.demo) { toast(`Lọc theo #${r.tag.name}`); return; }
        input.value = '#' + r.tag.name;
        paint();
        return;
      }
      if (opts.demo) { toast(`Mở “${r.item.name}”`); return; }
      location.href = 'item.html';
    }

    input.addEventListener('input', paint);
    input.addEventListener('focus', paint);

    input.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown') { e.preventDefault(); sel = Math.min(sel + 1, rows.length - 1); highlight(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); sel = Math.max(sel - 1, 0); highlight(); }
      else if (e.key === 'Enter') { e.preventDefault(); activate(sel); }
      else if (e.key === 'Tab' && rows[sel] && rows[sel].kind === 'item') {
        e.preventDefault(); input.value = rows[sel].item.name; paint();
      } else if (e.key === 'Escape' && !opts.pinned) { pop.hidden = true; input.blur(); }
    });

    pop.addEventListener('mousemove', (e) => {
      const row = e.target.closest('.sugg-row');
      if (row) { sel = +row.dataset.i; highlight(); }
    });

    pop.addEventListener('click', (e) => {
      const row = e.target.closest('.sugg-row');
      if (row) { activate(+row.dataset.i); return; }
      if (e.target.closest('[data-create]')) {
        toast(`Đã tạo “${input.value}”`);
        input.value = ''; paint();
      }
    });

    if (!opts.pinned) {
      document.addEventListener('click', (e) => {
        if (!root.contains(e.target)) pop.hidden = true;
      });
    }

    document.addEventListener('keydown', (e) => {
      if ((e.key === 'k' && (e.metaKey || e.ctrlKey)) ||
          (e.key === '/' && !/^(INPUT|TEXTAREA)$/.test(document.activeElement.tagName))) {
        e.preventDefault(); input.focus(); input.select();
      }
    });

    root._repaint = paint;
    if (opts.openOnLoad) paint();
    return { paint, input };
  }

  /* ---------- hộp thoại trùng tên (SPEC §3.4) ---------- */

  function openDupDialog(add) {
    let dlg = document.getElementById('dupDialog');
    if (!dlg) {
      dlg = document.createElement('dialog');
      dlg.id = 'dupDialog';
      document.body.appendChild(dlg);
    }
    dlg.innerHTML = `<div class="panel" style="width:min(520px,92vw);padding:28px">
      <h2 class="t-title-sm" style="margin-bottom:6px">Có ${add.dupes.length} mục tên “${esc(add.name)}”</h2>
      <p class="t-body" style="color:var(--muted);margin:0 0 20px">Tên được phép trùng. Chọn nơi lưu entry mới.</p>
      <div style="display:flex;flex-direction:column;gap:10px;margin-bottom:22px">
        ${add.dupes.map((d) => `<button class="card" data-pick="${d.id}" style="display:flex;align-items:center;gap:12px;
          padding:14px 16px;text-align:left;cursor:pointer;font:inherit;color:inherit">
          <span style="flex:1"><strong>${esc(d.name)}</strong>
          ${d.tags.map((t) => `<span class="mono" style="color:var(--muted);font-size:12px"> #${esc(t)}</span>`).join('')}
          ${d.hint ? `<br><span style="color:var(--muted);font-size:13px">${esc(d.hint)}</span>` : ''}</span>
          <span class="sugg-meta">${d.entries} entries · ${d.updated}</span></button>`).join('')}
        <button class="card" data-pick="new" style="display:flex;align-items:center;gap:12px;padding:14px 16px;
          text-align:left;cursor:pointer;font:inherit;color:inherit;border-style:dashed">
          <span class="mono" style="color:var(--accent)">+</span> Tạo mục mới cùng tên</button>
      </div>
      <div style="display:flex;justify-content:flex-end;gap:10px">
        <button class="btn btn-tertiary" data-close>Huỷ</button>
      </div></div>`;
    dlg.addEventListener('click', (e) => {
      if (e.target.closest('[data-close]')) dlg.close();
      const pick = e.target.closest('[data-pick]');
      if (pick) {
        dlg.close();
        toast(pick.dataset.pick === 'new' ? `Đã tạo mục “${add.name}”` : `Đã lưu vào “${add.name}”`, 'Hoàn tác');
      }
    }, { once: true });
    dlg.showModal();
  }

  /* ---------- toast ---------- */

  let toastTimer;
  function toast(msg, action) {
    document.querySelectorAll('.toast').forEach((t) => t.remove());
    const el = document.createElement('div');
    el.className = 'toast';
    el.setAttribute('role', 'status');
    el.innerHTML = `<span>${esc(msg)}</span>${action ? `<button>${esc(action)}</button>` : ''}`;
    document.body.appendChild(el);
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.remove(), 3200);
    el.querySelector('button')?.addEventListener('click', () => el.remove());
  }

  /* ---------- bảng JSON (SPEC §7.4) ---------- */
  /* Cột = hợp key duyệt theo source order. Hàng có key trùng chuyển sang
     bảng field/value để hiện đủ occurrence (dữ liệu mock mang sẵn __pairs). */

  function typeOf(v) {
    if (v === null) return 'null';
    if (Array.isArray(v)) return 'array';
    return typeof v;
  }

  function scalarHtml(v) {
    const t = typeOf(v);
    if (t === 'number') return `<span class="v-num">${esc(v)}</span>`;
    if (t === 'boolean') return `<span class="v-bool">${v}</span>`;
    if (t === 'null') return `<span class="v-null">null</span>`;
    return esc(v);
  }

  let nestId = 0;

  function cellHtml(v) {
    if (v === undefined) return '<span class="v-null">—</span>';
    // __raw: giữ nguyên chữ số nguồn (số lớn, 1e400, -0) — JS không biểu diễn nổi.
    if (v && typeof v === 'object' && typeof v.__raw === 'string') {
      return `<span class="v-num" title="giữ nguyên text nguồn">${esc(v.__raw)}</span>`;
    }
    const t = typeOf(v);
    if (t !== 'object' && t !== 'array') return scalarHtml(v);
    const n = t === 'array' ? v.length : Object.keys(v).length;
    const id = 'n' + (++nestId);
    const label = t === 'array' ? `${n} phần tử` : `${n} khoá`;
    return `<button class="json-toggle" aria-expanded="false" data-nest="${id}">
        <span class="caret">›</span>${label}</button>
      <div class="json-nest" id="${id}" hidden>${tableHtml(v)}</div>`;
  }

  function columnsOf(arr) {
    const cols = [];
    arr.forEach((row) => {
      if (row && typeof row === 'object' && !Array.isArray(row)) {
        (row.__pairs ? row.__pairs.map((p) => p[0]) : Object.keys(row))
          .forEach((k) => { if (!cols.includes(k)) cols.push(k); });
      }
    });
    return cols;
  }

  function pairTable(pairs) {
    return `<table class="json-table"><tbody>
      ${pairs.map(([k, v]) => `<tr><td class="k">${esc(k)}</td><td>${cellHtml(v)}</td></tr>`).join('')}
    </tbody></table>`;
  }

  function tableHtml(value) {
    if (Array.isArray(value)) {
      const objRows = value.every((r) => r && typeof r === 'object' && !Array.isArray(r));
      if (objRows && value.length) {
        const cols = columnsOf(value);
        return `<table class="json-table"><thead><tr><th style="width:44px">#</th>
          ${cols.map((c) => `<th>${esc(c)}</th>`).join('')}</tr></thead><tbody>
          ${value.map((row, i) => {
            if (row.__pairs) {
              const keys = row.__pairs.map((p) => p[0]);
              const dup = keys.some((k, j) => keys.indexOf(k) !== j);
              if (dup) {
                return `<tr><td class="k">${i}</td><td colspan="${cols.length}">
                  <div style="font-size:12px;color:var(--warning-ink,var(--muted));margin-bottom:6px">
                  <span class="mono">khoá trùng</span> — hiện dạng field/value để giữ đủ occurrence</div>
                  ${pairTable(row.__pairs)}</td></tr>`;
              }
              const map = Object.fromEntries(row.__pairs);
              return `<tr><td class="k">${i}</td>${cols.map((c) => `<td>${cellHtml(map[c])}</td>`).join('')}</tr>`;
            }
            return `<tr><td class="k">${i}</td>${cols.map((c) => `<td>${cellHtml(row[c])}</td>`).join('')}</tr>`;
          }).join('')}
        </tbody></table>`;
      }
      return `<table class="json-table"><tbody>
        ${value.map((v, i) => `<tr><td class="k">${i}</td><td>${cellHtml(v)}</td></tr>`).join('')}
      </tbody></table>`;
    }
    if (value && typeof value === 'object') {
      return pairTable(value.__pairs || Object.entries(value));
    }
    return `<table class="json-table"><tbody><tr><td>${cellHtml(value)}</td></tr></tbody></table>`;
  }

  /* Uỷ quyền ở document: bảng bị vẽ lại (khoá/mở vault, đổi nguồn import)
     vẫn bấm được mà không phải gắn lại listener. */
  document.addEventListener('click', (e) => {
    const t = e.target.closest('.json-toggle');
    if (!t) return;
    const box = document.getElementById(t.dataset.nest);
    if (!box) return;
    const open = t.getAttribute('aria-expanded') === 'true';
    t.setAttribute('aria-expanded', String(!open));
    box.hidden = open;
  });

  function renderJsonTable(host, value) {
    host.innerHTML = tableHtml(value);
  }

  /* ---------- chrome chung: theme, khoá vault, tab ---------- */

  function initChrome() {
    const saved = localStorage.getItem('sak-theme');
    if (saved) document.documentElement.dataset.theme = saved;

    document.querySelectorAll('[data-theme-toggle]').forEach((btn) => {
      const sync = () => { btn.textContent = document.documentElement.dataset.theme === 'dark' ? '☀' : '☾'; };
      sync();
      btn.addEventListener('click', () => {
        const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
        document.documentElement.dataset.theme = next;
        localStorage.setItem('sak-theme', next);
        sync();
      });
    });

    const pills = document.querySelectorAll('[data-vault]');
    const unlockBtns = document.querySelectorAll('[data-unlock]');
    if (pills.length || unlockBtns.length) {
      const syncVault = () => {
        pills.forEach((btn) => {
          btn.className = 'vault-pill ' + (state.locked ? 'vault-shut' : 'vault-open');
          // Nhãn ngắn trên mobile: pill nằm trong header chật, không được đẩy tràn.
          btn.innerHTML = state.locked
            ? '<span aria-hidden="true">🔒</span> <span class="sm:hidden">Đã khoá</span><span class="hidden sm:inline">Vault đã khoá</span>'
            : '<span aria-hidden="true">🔓</span> <span class="sm:hidden">15 phút</span><span class="hidden sm:inline">Vault mở · 15 phút</span>';
        });
        document.body.classList.toggle('is-locked', state.locked);
        document.querySelectorAll('[data-secret]').forEach((el) => {
          if (!el.dataset.plain) el.dataset.plain = el.innerHTML;
          el.innerHTML = state.locked
            ? '<div class="lock-veil">•••• •••• •••• ••••</div>'
            : el.dataset.plain;
        });
        document.querySelectorAll('[data-locked-banner]').forEach((el) => { el.hidden = !state.locked; });
      };
      const toggle = () => { state.locked = !state.locked; syncVault(); };
      pills.forEach((b) => b.addEventListener('click', toggle));
      unlockBtns.forEach((b) => b.addEventListener('click', toggle));
      requestAnimationFrame(syncVault);
    }

    document.querySelectorAll('[data-sem-toggle]').forEach((btn) => {
      const sync = () => btn.setAttribute('aria-checked', String(state.semantic));
      sync();
      btn.addEventListener('click', () => {
        state.semantic = !state.semantic;
        sync();
        document.querySelectorAll('[data-omnibox]').forEach((r) => r._repaint && r._repaint());
        toast(state.semantic ? 'Đã bật tìm gần nghĩa' : 'Đã tắt tìm gần nghĩa');
      });
    });

    document.querySelectorAll('[data-seg]').forEach((seg) => {
      seg.addEventListener('click', (e) => {
        const b = e.target.closest('button');
        if (!b) return;
        seg.querySelectorAll('button').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
        if (!b.dataset.target) return;
        const scope = b.closest('[data-seg-scope]') || document;
        scope.querySelectorAll('[data-view]').forEach((v) => {
          v.hidden = v.dataset.view !== b.dataset.target;
        });
      });
    });

    document.querySelectorAll('[data-open-dialog]').forEach((btn) => {
      btn.addEventListener('click', () => document.getElementById(btn.dataset.openDialog)?.showModal());
    });
    document.querySelectorAll('[data-close-dialog]').forEach((btn) => {
      btn.addEventListener('click', () => btn.closest('dialog')?.close());
    });
    document.querySelectorAll('[data-toast]').forEach((btn) => {
      btn.addEventListener('click', () => {
        btn.closest('dialog')?.close();
        toast(btn.dataset.toast, btn.dataset.toastAction || null);
      });
    });
  }

  window.SAK = { TAGS, ITEMS, search, initOmnibox, renderJsonTable, initChrome, toast, state, norm };
})();
