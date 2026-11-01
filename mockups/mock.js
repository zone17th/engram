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
      id: 'i1', name: 'wifi', hint: '', tags: ['nhà', 'office', 'home-lab', 'ops'],
      entries: 12, created_at: '12/03/2026', updated: '12/03/2026', touched: 9
    },
    {
      id: 'i2', name: 'wifi', hint: 'tầng 4 — SSID nội bộ', tags: ['công-ty', 'office'],
      entries: 3, created_at: '01/06/2026', updated: '01/06/2026', touched: 6
    },
    {
      id: 'i11', name: 'wifi', hint: 'nhà bố mẹ · cáp quang', tags: ['nhà', 'wifi-khách'],
      entries: 2, created_at: '14/01/2026', updated: '14/01/2026', touched: 5
    },
    {
      id: 'i12', name: 'wifi', hint: 'quán cà phê hay ngồi', tags: ['wifi-khách'],
      entries: 1, created_at: '08/11/2025', updated: '08/11/2025', touched: 3
    },
    {
      id: 'i3', name: 'wifi-office', hint: '', tags: ['office'],
      entries: 3, created_at: '28/05/2026', updated: '28/05/2026', touched: 4
    },
    {
      id: 'i4', name: 'mạng nhà', hint: 'router, VLAN, DNS', tags: ['nhà', 'home-lab'],
      entries: 7, created_at: '02/09/2026', updated: '02/09/2026', touched: 8
    },
    {
      id: 'i5', name: 'docker', hint: '', tags: ['ops', 'home-lab'],
      entries: 9, created_at: '10/09/2026', updated: '10/09/2026', touched: 12
    },
    {
      id: 'i6', name: 'k8s', hint: 'kubernetes cụm nhà', tags: ['ops', 'home-lab'],
      entries: 5, created_at: '30/08/2026', updated: '30/08/2026', touched: 5
    },
    {
      id: 'i7', name: 'meeting-mkt', hint: '', tags: ['okrs'],
      entries: 4, created_at: '11/09/2026', updated: '11/09/2026', touched: 7
    },
    {
      id: 'i8', name: 'api key openai', hint: '', tags: ['ops'],
      entries: 2, created_at: '19/07/2026', updated: '19/07/2026', touched: 3
    },
    {
      id: 'i9', name: 'hợp đồng thuê nhà', hint: '', tags: ['nhà'],
      entries: 6, created_at: '05/01/2026', updated: '05/01/2026', touched: 2
    },
    {
      id: 'i10', name: 'ngân hàng', hint: 'số tài khoản, chi nhánh', tags: [],
      entries: 3, created_at: '22/04/2026', updated: '22/04/2026', touched: 4
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
  function markPrefixExact(text, q) {
    const s = String(text || '');
    const nq = normIdentity(q);
    if (!nq) return esc(s);
    const lowerS = s.normalize('NFC').toLowerCase().normalize('NFC');
    const at = lowerS.indexOf(nq);
    if (at < 0) return esc(s);
    return esc(s.slice(0, at)) + '<mark>' + esc(s.slice(at, at + nq.length)) + '</mark>' + esc(s.slice(at + nq.length));
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

  /* ---------- P04 omnibox (SPEC §3.4, §7.2, plan mục 2.11, Q17) ---------- */

  const COPY_SEARCH_HINT_VI = 'Enter: tìm theo đầu tên · Ctrl+Enter: tạo mục tên này — chữ đã gõ gửi tới máy chủ, không mã hoá. Để lưu nội dung, gõ ';
  const COPY_SEARCH_HINT_EN = 'Enter: search by name prefix · Ctrl+Enter: create item with this name — typed text is sent to the server unencrypted. To save content, type ';
  const COPY_TAG_HINT_VI = 'Enter: lọc theo tag — chữ đã gõ gửi tới máy chủ, không mã hoá';
  const COPY_TAG_HINT_EN = 'Enter: filter by tag — typed text is sent to the server unencrypted';
  const COPY_PRIVACY_VI = 'Tên mục, tag và gợi ý không được mã hoá; chỉ nội dung được mã hoá đầu-cuối';
  const COPY_PRIVACY_EN = 'Item names, tags and hints are not encrypted; only the content is end-to-end encrypted';
  const COPY_UNDO_SUB = 'Hoàn tác chỉ xoá nội dung vừa lưu; mục và tag vẫn giữ · Undo only removes the saved entry; the item and tags stay';

  function runeLen(str) {
    return Array.from(String(str || '')).length;
  }

  function normIdentity(str) {
    const s = String(str || '').normalize('NFC').toLowerCase().normalize('NFC').replace(/\s+/g, ' ').trim();
    return s.replace(/^[\p{P}]+|[\p{P}]+$/gu, '').trim();
  }

  function isJsonBodyCandidate(body) {
    const s = String(body || '').trim();
    if (!s || (s[0] !== '{' && s[0] !== '[')) return false;
    try {
      JSON.parse(s);
      return true;
    } catch (_) {
      return false;
    }
  }

  function findQuickAddColon(line) {
    for (let i = 0; i < line.length; i++) {
      if (line[i] === ':' && line.slice(i + 1, i + 3) !== '//') {
        return i;
      }
    }
    return -1;
  }

  function parseQuickAdd(raw) {
    const text = String(raw || '').replace(/\r\n?/g, '\n');
    const lines = text.split('\n');
    const firstLine = lines[0] || '';
    const trimmedFirst = firstLine.trimStart();

    if (trimmedFirst.startsWith('#')) {
      const rawToken = trimmedFirst.slice(1).trim();
      const token = rawToken.split(/\s+/)[0] || '';
      return {
        mode: 'tag-filter',
        name: '',
        tags: [],
        body: '',
        tagQuery: token,
        jsonCandidate: false,
        searchable: runeLen(token) <= 50,
        error: null
      };
    }

    const colonIdx = findQuickAddColon(firstLine);
    if (colonIdx < 0) {
      const trimmedAll = text.trim();
      const isSingleLine = lines.length === 1;
      const len = runeLen(trimmedAll);
      const searchable = isSingleLine && len > 0 && len <= 200;
      const tooLongOrMulti = len > 0 && (!isSingleLine || len > 200);
      return {
        mode: 'search',
        name: trimmedAll,
        tags: [],
        body: '',
        jsonCandidate: false,
        searchable,
        tooLongOrMulti,
        error: null
      };
    }

    const head = firstLine.slice(0, colonIdx);
    const afterFirst = firstLine.slice(colonIdx + 1);
    const restLines = lines.slice(1);
    const rawBody = restLines.length ? afterFirst + '\n' + restLines.join('\n') : afterFirst;
    const body = rawBody.trim();

    const tokens = head.trim() ? head.trim().split(/\s+/) : [];
    const nameTokens = [];
    const rawTags = [];
    let seenTag = false;
    let spaceInTagError = false;
    let invalidTagSyntax = false;

    for (let i = 0; i < tokens.length; i++) {
      const tok = tokens[i];
      if (tok.startsWith('#')) {
        seenTag = true;
        const tagDisplay = tok.slice(1);
        if (!tagDisplay || tagDisplay.includes('#') || tagDisplay.includes(':')) {
          invalidTagSyntax = true;
        } else {
          rawTags.push(tagDisplay);
        }
      } else if (seenTag) {
        spaceInTagError = true;
      } else {
        nameTokens.push(tok);
      }
    }

    const name = nameTokens.join(' ').trim();
    const normName = normIdentity(name);

    const dedupTags = [];
    const seenNormTags = new Set();
    for (let i = 0; i < rawTags.length; i++) {
      const t = rawTags[i];
      const nt = normIdentity(t);
      if (!nt) {
        invalidTagSyntax = true;
        continue;
      }
      if (!seenNormTags.has(nt)) {
        seenNormTags.add(nt);
        dedupTags.push(t);
      }
    }

    if (!name || !normName || runeLen(name) > 200) {
      return {
        mode: 'add-invalid',
        name,
        tags: dedupTags,
        body,
        jsonCandidate: false,
        searchable: false,
        error: 'name-invalid',
        errorVi: 'Tên mục cần từ 1–200 ký tự hợp lệ trước dấu :.',
        errorEn: 'Item name must be 1–200 valid characters before the colon (:).'
      };
    }

    if (spaceInTagError) {
      return {
        mode: 'add-invalid',
        name,
        tags: dedupTags,
        body,
        jsonCandidate: false,
        searchable: false,
        error: 'tag-space',
        errorVi: 'Tag không có khoảng trắng; dùng chip để gắn tag có khoảng trắng',
        errorEn: 'Tags cannot contain spaces; use the tag chip to attach a tag with spaces'
      };
    }

    if (invalidTagSyntax || dedupTags.some((t) => runeLen(t) > 50)) {
      return {
        mode: 'add-invalid',
        name,
        tags: dedupTags,
        body,
        jsonCandidate: false,
        searchable: false,
        error: 'tag-invalid',
        errorVi: 'Mỗi tag từ 1–50 ký tự và không chứa dấu # hoặc :.',
        errorEn: 'Each tag must be 1–50 characters and cannot contain # or :.'
      };
    }

    if (dedupTags.length > 20) {
      return {
        mode: 'add-invalid',
        name,
        tags: dedupTags,
        body,
        jsonCandidate: false,
        searchable: false,
        error: 'tag-limit-20',
        errorVi: `Đã nhập ${dedupTags.length} tag; tối đa 20 tag mỗi mục.`,
        errorEn: `${dedupTags.length} tags entered; maximum 20 tags per item.`
      };
    }

    if (!body) {
      return {
        mode: 'add-invalid',
        name,
        tags: dedupTags,
        body: '',
        jsonCandidate: false,
        searchable: false,
        error: 'empty-body',
        errorVi: 'Gõ nội dung sau dấu :',
        errorEn: 'Type content after the colon (:)'
      };
    }

    return {
      mode: 'add',
      name,
      tags: dedupTags,
      body,
      jsonCandidate: isJsonBodyCandidate(body),
      searchable: false,
      error: null
    };
  }

  function lookupItemsExact(name) {
    const target = normIdentity(name);
    if (!target) return [];
    return ITEMS.filter((it) => normIdentity(it.name) === target);
  }

  function searchItemsPrefix(q) {
    const target = normIdentity(q);
    if (!target) return [];
    return ITEMS
      .filter((it) => normIdentity(it.name).startsWith(target))
      .sort((a, b) => normIdentity(a.name).localeCompare(normIdentity(b.name)) || (b.touched - a.touched));
  }

  function filterTagsPrefix(q) {
    const target = normIdentity(q);
    if (!target) return TAGS.slice();
    return TAGS.filter((t) => normIdentity(t.name).startsWith(target));
  }

  const omniboxInstances = [];

  function initDemoOmnibox(root, opts) {
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
        toast(`Đã lưu vào “${r.add.name}” · Saved to “${r.add.name}”`, 'Hoàn tác', {
          sub: COPY_UNDO_SUB,
          originEl: input
        });
        input.value = '';
        input.dataset.justClearedBySave = '1';
        paint();
        return;
      }
      if (r.kind === 'tag') {
        toast(`Lọc theo #${r.tag.name} · Filter by #${r.tag.name}`);
        return;
      }
      toast(`Mở “${r.item.name}” · Open “${r.item.name}”`);
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
        toast(`Đã tạo “${input.value}” · Created “${input.value}”`);
        input.value = ''; paint();
      }
    });

    root._repaint = paint;
    if (opts.openOnLoad) paint();
    return { paint, input };
  }

  function initOmnibox(root, opts) {
    if (!root) return null;
    opts = opts || {};
    if (opts.demo) {
      return initDemoOmnibox(root, opts);
    }

    const input = root.querySelector('.omnibox-input');
    const shell = root.querySelector('.omnibox-shell');
    const pop = root.querySelector('[data-pop]');
    if (!input || !shell || !pop) return null;

    const baseId = root.id || 'omni';
    const popWrapId = (pop.id && pop.id !== (baseId + '-listbox')) ? pop.id : (baseId + '-pop');
    pop.id = popWrapId;
    pop.removeAttribute('role');
    pop.removeAttribute('aria-label');

    const listboxId = baseId + '-listbox';

    input.setAttribute('role', 'combobox');
    input.setAttribute('aria-autocomplete', 'list');
    input.setAttribute('aria-controls', listboxId);
    input.setAttribute('aria-expanded', 'false');
    input.setAttribute('data-vault-secret', '');
    input.setAttribute('spellcheck', 'false');
    input.setAttribute('autocomplete', 'off');
    input.setAttribute('autocorrect', 'off');
    input.setAttribute('autocapitalize', 'off');

    let auxHost = root.querySelector('[data-omni-aux]');
    if (!auxHost) {
      auxHost = document.createElement('div');
      auxHost.className = 'omni-aux';
      auxHost.dataset.omniAux = '1';
      root.appendChild(auxHost);
    }

    const hintId = baseId + '-hint';
    let hintEl = root.querySelector('#' + hintId);
    if (!hintEl) {
      hintEl = document.createElement('div');
      hintEl.id = hintId;
      hintEl.className = 'omni-hint-line';
      auxHost.appendChild(hintEl);
    }
    input.setAttribute('aria-describedby', hintId);

    const liveId = baseId + '-live';
    let liveEl = root.querySelector('#' + liveId);
    if (!liveEl) {
      liveEl = document.createElement('div');
      liveEl.id = liveId;
      liveEl.className = 'sr-only';
      liveEl.setAttribute('role', 'status');
      liveEl.setAttribute('aria-live', 'polite');
      auxHost.appendChild(liveEl);
    }

    let guardEl = root.querySelector('[data-omni-guard]');
    if (!guardEl) {
      guardEl = document.createElement('div');
      guardEl.id = baseId + '-guard-alert';
      guardEl.dataset.omniGuard = '1';
      guardEl.className = 'omni-guard-alert';
      guardEl.setAttribute('role', 'alert');
      guardEl.hidden = true;
      auxHost.appendChild(guardEl);
    }

    let lockNoticeEl = root.querySelector('[data-omni-lock-notice]');
    if (!lockNoticeEl) {
      lockNoticeEl = document.createElement('div');
      lockNoticeEl.id = baseId + '-lock-cleared-notice';
      lockNoticeEl.dataset.omniLockNotice = '1';
      lockNoticeEl.className = 'omni-lock-notice';
      lockNoticeEl.setAttribute('role', 'status');
      lockNoticeEl.hidden = true;
      auxHost.appendChild(lockNoticeEl);
    }

    let addPanelEl = root.querySelector('[data-omni-add-panel]');
    if (!addPanelEl) {
      addPanelEl = document.createElement('div');
      addPanelEl.id = baseId + '-add-preview';
      addPanelEl.dataset.omniAddPanel = '1';
      addPanelEl.className = 'omni-add-panel';
      addPanelEl.hidden = true;
      auxHost.appendChild(addPanelEl);
    }

    let listOpen = false;
    let listKind = null;
    let listOptions = [];
    let activeIdx = -1;
    let activePlan = null;
    let hadDraftOnLock = false;
    let hadCommittedMetaOnLock = false;
    let showPostUnlockNotice = false;

    let lastErrorAlertSig = '';
    let lastFailAlertSig = '';
    let planStepTimers = [];

    function clearPlanTimers() {
      planStepTimers.forEach((tid) => clearTimeout(tid));
      planStepTimers = [];
    }

    function syncTextareaHeight() {
      if (input.tagName !== 'TEXTAREA') return;
      if (!input.value || !input.value.includes('\n')) {
        input.style.height = '';
        return;
      }
      input.style.height = 'auto';
      if (input.scrollHeight > 0) {
        input.style.height = Math.min(input.scrollHeight, 132) + 'px';
      }
    }

    function setLiveText(text) {
      if (liveEl) liveEl.textContent = text || '';
    }

    function closeListbox(clearLive) {
      listOpen = false;
      listKind = null;
      listOptions = [];
      activeIdx = -1;
      pop.hidden = true;
      pop.innerHTML = '';
      input.setAttribute('aria-expanded', 'false');
      input.removeAttribute('aria-activedescendant');
      if (clearLive) setLiveText('');
    }

    function syncActiveOption() {
      const lb = pop.querySelector('#' + listboxId) || pop;
      const optEls = lb.querySelectorAll('[role="option"]');
      optEls.forEach((el, idx) => {
        const isSel = idx === activeIdx;
        el.setAttribute('aria-selected', String(isSel));
        if (isSel) {
          el.scrollIntoView({ block: 'nearest' });
        }
      });
      if (listOpen && activeIdx >= 0 && optEls[activeIdx] && optEls[activeIdx].id) {
        input.setAttribute('aria-activedescendant', optEls[activeIdx].id);
      } else {
        input.removeAttribute('aria-activedescendant');
      }
    }

    function renderSearchListbox(query, items) {
      listOpen = true;
      listKind = 'search';
      listOptions = [];
      activeIdx = -1;

      let headerHtml = '';
      let optionsHtml = '';
      if (items.length > 0) {
        headerHtml = `<div class="sugg-group" aria-hidden="true">${items.length} kết quả cho “${esc(query)}” · <span lang="en">${items.length} ${items.length === 1 ? 'result' : 'results'} for “${esc(query)}”</span></div>`;
        items.forEach((it, idx) => {
          const optId = `${baseId}-opt-item-${esc(it.id)}-${idx}`;
          const shownTags = (it.tags || []).slice(0, 3);
          const extra = (it.tags || []).length > 3 ? (it.tags.length - 3) : 0;
          const count = it.entry_count != null ? it.entry_count : (it.entries != null ? it.entries : 0);
          listOptions.push({ id: optId, kind: 'item', item: it, query });
          optionsHtml += `<div role="option" id="${optId}" aria-selected="false" class="sugg-row" data-opt-idx="${listOptions.length - 1}">
            <span class="omni-opt-main">
              <span class="omni-opt-title">${markPrefixExact(it.name, query)}</span>
              ${shownTags.map((t) => `<span class="chip dup-chip" title="#${esc(t)}">#${esc(t)}</span>`).join('')}
              ${extra > 0 ? `<span class="mono text-[12px] text-muted">+${extra}</span>` : ''}
            </span>
            <span class="sugg-meta mono">${count} entries</span>
          </div>`;
        });
        setLiveText(`${items.length} kết quả · ${items.length} results`);
      } else {
        const createOptId = `${baseId}-opt-create`;
        listOptions.push({ id: createOptId, kind: 'create', query });
        headerHtml = `<div class="omni-empty-box" id="${baseId}-search-empty" aria-hidden="true">
          <p class="t-label mb-1 text-muted">Tìm không ra · <span lang="en">No prefix match</span></p>
          <p class="text-[14px] font-semibold text-body m-0 mb-1">Không có mục bắt đầu bằng “${esc(query)}”</p>
          <p class="text-[12px] text-muted m-0" lang="en">No items starting with “${esc(query)}”. Search only matches item name prefixes.</p>
        </div>`;
        optionsHtml = `<div role="option" id="${createOptId}" aria-selected="false" class="sugg-row omni-create-option" data-opt-idx="0">
          <span class="mono text-accent">+</span>
          <span><strong>Tạo mục “${esc(query)}”</strong> · <span lang="en" class="text-muted">Create item “${esc(query)}”</span></span>
          <span class="sugg-meta"><span class="kbd">Enter</span></span>
        </div>`;
        setLiveText(`Không có mục bắt đầu bằng “${query}” · No items starting with “${query}”`);
      }

      pop.innerHTML = `${headerHtml}<div role="listbox" id="${listboxId}" class="omni-listbox" aria-label="Kết quả tìm kiếm · Search results">${optionsHtml}</div>`;
      pop.hidden = false;
      input.setAttribute('aria-expanded', 'true');
      input.removeAttribute('aria-activedescendant');
    }

    function renderTagListbox(tagQuery, matchedTags, fromServerLookup) {
      listOpen = true;
      listKind = 'tag-filter';
      listOptions = [];
      activeIdx = matchedTags.length ? 0 : -1;

      const hdrLabel = fromServerLookup
        ? 'Kết quả tìm tag · <span lang="en">Tag search results</span>'
        : 'Lọc tag trên bộ nhớ đệm · <span lang="en">Client tag cache</span>';
      let headerHtml = `<div class="sugg-group" aria-hidden="true">${hdrLabel} · <span lang="en">${matchedTags.length} tags</span></div>`;
      let optionsHtml = '';
      if (matchedTags.length) {
        matchedTags.forEach((t, idx) => {
          const optId = `${baseId}-opt-tag-${idx}`;
          listOptions.push({ id: optId, kind: 'tag', tag: t, query: tagQuery });
          optionsHtml += `<div role="option" id="${optId}" aria-selected="${idx === activeIdx}" class="sugg-row" data-opt-idx="${idx}">
            <span class="mono text-accent">#</span>
            <span>${markPrefixExact(t.name, tagQuery)}</span>
            <span class="sugg-meta mono">${t.count} mục · <span lang="en">${t.count} items</span></span>
          </div>`;
        });
        setLiveText(`${matchedTags.length} tag khớp #${tagQuery} · ${matchedTags.length} matching tags`);
      } else {
        headerHtml += `<div class="omni-empty-box" aria-hidden="true">
          <p class="text-[14px] font-semibold text-body m-0 mb-1">Không có tag bắt đầu bằng “#${esc(tagQuery)}”</p>
          <p class="text-[12px] text-muted m-0" lang="en">No tags starting with “#${esc(tagQuery)}” (${fromServerLookup ? 'no matching tags on server' : 'press Enter to search all tags'}).</p>
        </div>`;
        setLiveText(`Không có tag bắt đầu bằng “#${tagQuery}” · No tags starting with “#${tagQuery}”`);
      }

      pop.innerHTML = `${headerHtml}<div role="listbox" id="${listboxId}" class="omni-listbox" aria-label="Kết quả lọc tag · Tag filter results">${optionsHtml}</div>`;
      pop.hidden = false;
      input.setAttribute('aria-expanded', 'true');
      syncActiveOption();
    }

    function ensureAddPanelScaffold() {
      if (addPanelEl.dataset.scaffoldReady === '1') return;
      addPanelEl.dataset.scaffoldReady = '1';
      addPanelEl.innerHTML = `<div class="omni-add-header">
          <div class="omni-add-dest">
            <span class="badge-type badge-text">text · E2E</span>
            <span class="text-[14px] text-body" data-part="dest-label"></span>
            <span class="omni-add-tags" data-part="dest-tags"></span>
          </div>
          <button type="button" class="btn btn-primary btn-sm" data-omni-unlock-save="1" id="${baseId}-unlock-to-save-btn" hidden>
            <span aria-hidden="true">🔒</span> Mở khoá để lưu · <span lang="en">Unlock to save</span>
          </button>
          <div class="flex flex-wrap items-center gap-2" data-part="save-wrap">
            <span class="text-[12px] text-muted"><span class="kbd">Enter</span> lưu · <span class="kbd">Ctrl+Enter</span> luôn tạo mục mới · <span lang="en">save / always create new item</span></span>
            <button type="button" class="btn btn-primary btn-sm" data-omni-save-now="1">
              Lưu entry · <span lang="en">Save entry</span>
            </button>
          </div>
        </div>
        <p class="omni-add-local-note m-0 mt-1.5 text-[12px] text-muted">
          Xem trước dựng cục bộ từ tên và tag (chưa gửi máy chủ; số mục trùng tên chỉ kiểm tra sau khi nhấn <span class="kbd">Enter</span>). ·
          <span lang="en">Preview parsed locally (nothing sent before <span class="kbd">Enter</span>; duplicate count is checked only on <span class="kbd">Enter</span>).</span>
        </p>
        <div class="auth-alert mt-3 mb-0" id="${baseId}-add-error" hidden>
          <p class="m-0 text-[13px] font-semibold text-body" data-part="err-vi"></p>
          <p class="m-0 mt-0.5 text-[12px] text-muted" lang="en" data-part="err-en"></p>
        </div>
        <div class="omni-json-banner mt-3" id="${baseId}-json-banner" hidden>
          <div class="min-w-0">
            <p class="m-0 text-[13px] font-semibold text-body">Phát hiện JSON — Lưu như bảng · <span lang="en" class="font-normal text-muted">JSON detected — Save as table</span></p>
            <p class="m-0 text-[12px] text-muted">Quick-add mặc định lưu dạng <span class="mono">text</span>. Bấm nút bên cạnh để mở hộp nhập bảng JSON với nội dung này. · <span lang="en">Quick-add saves as <span class="mono">text</span> by default. Open JSON table import with this payload instead.</span></p>
          </div>
          <button type="button" class="btn btn-secondary btn-sm shrink-0" data-omni-open-json="1">
            Lưu như bảng · <span lang="en">Save as table</span>
          </button>
        </div>
        <div class="omni-plan-box mt-3" id="${baseId}-save-plan" role="region" aria-label="Tiến trình lưu quick-add · Quick-add save progress" hidden>
          <p class="t-label text-[12px] text-muted m-0 mb-2">Kế hoạch lưu nhiều bước · <span lang="en">Multi-step save plan</span></p>
          <ol class="omni-step-list m-0 p-0 list-none flex flex-col gap-1.5" data-part="step-list"></ol>
          <div role="alert" class="auth-alert mt-3 mb-0" id="${baseId}-plan-error" hidden>
            <p class="m-0 text-[13px] font-semibold text-body" data-part="fail-title"></p>
            <p class="m-0 mt-0.5 text-[12px] text-body">Bấm <strong>Thử lại</strong> để chạy tiếp từ bước lỗi với đúng <span class="mono">Idempotency-Key</span> và gói dữ liệu đã mã hoá (không mã hoá lại, không tạo bản sao). · <span lang="en" class="text-muted">Click <strong>Retry</strong> to resume from the failed step with the same <span class="mono">Idempotency-Key</span> and sealed payload.</span></p>
            <div class="mt-2 flex flex-wrap gap-2">
              <button type="button" class="btn btn-primary btn-sm" data-omni-retry-plan="1">Thử lại · <span lang="en">Retry</span></button>
            </div>
          </div>
        </div>
        <div class="omni-add-privacy mt-2.5 pt-2.5 border-top-line" id="${baseId}-add-privacy">
          <p class="m-0 text-[12px] text-body">${COPY_PRIVACY_VI}</p>
          <p class="m-0 text-[12px] text-muted" lang="en">${COPY_PRIVACY_EN}</p>
        </div>`;
    }
    function renderHintAndPanels() {
      syncTextareaHeight();
      const parsed = parseQuickAdd(input.value);
      const isAddLike = parsed.mode === 'add' || parsed.mode === 'add-invalid';
      shell.classList.toggle('is-add', isAddLike);
      const hasNonEmptyInput = input.value.trim().length > 0;

      if (showPostUnlockNotice && !state.locked) {
        lockNoticeEl.hidden = false;
        if (hadCommittedMetaOnLock) {
          lockNoticeEl.innerHTML = `<div class="omni-lock-notice-inner">
            <div>
              <p class="m-0 text-[13px] font-semibold text-body">Bản nháp chưa lưu đã bị xoá khi khoá vault; mục/tag đã tạo vẫn còn</p>
              <p class="m-0 text-[12px] text-muted" lang="en">Unsaved draft was cleared when the vault locked; any item/tags already created were kept.</p>
            </div>
            <button type="button" class="btn btn-tertiary btn-sm" data-dismiss-lock-notice="1">Đã hiểu · <span lang="en">Dismiss</span></button>
          </div>`;
        } else {
          lockNoticeEl.innerHTML = `<div class="omni-lock-notice-inner">
            <div>
              <p class="m-0 text-[13px] font-semibold text-body">Bản nháp chưa lưu đã bị xoá khi khoá vault</p>
              <p class="m-0 text-[12px] text-muted" lang="en">Unsaved draft was cleared when the vault locked.</p>
            </div>
            <button type="button" class="btn btn-tertiary btn-sm" data-dismiss-lock-notice="1">Đã hiểu · <span lang="en">Dismiss</span></button>
          </div>`;
        }
      } else {
        lockNoticeEl.hidden = true;
      }

      if (parsed.mode === 'search') {
        hintEl.hidden = !hasNonEmptyInput;
        hintEl.innerHTML = `<span class="omni-hint-vi">${COPY_SEARCH_HINT_VI}<span class="mono">tên: nội dung</span></span>
          <span class="omni-hint-en" lang="en">${COPY_SEARCH_HINT_EN}<span class="mono">name: content</span></span>`;
        addPanelEl.hidden = true;
        lastErrorAlertSig = '';
        lastFailAlertSig = '';
        if (parsed.searchable || !hasNonEmptyInput) {
          input.removeAttribute('aria-invalid');
        }
        return;
      }

      if (parsed.mode === 'tag-filter') {
        hintEl.hidden = !hasNonEmptyInput;
        hintEl.innerHTML = `<span class="omni-hint-vi">${COPY_TAG_HINT_VI}</span>
          <span class="omni-hint-en" lang="en">${COPY_TAG_HINT_EN}</span>`;
        addPanelEl.hidden = true;
        lastErrorAlertSig = '';
        lastFailAlertSig = '';
        input.removeAttribute('aria-invalid');
        return;
      }

      hintEl.hidden = true;
      guardEl.hidden = true;
      addPanelEl.hidden = false;
      ensureAddPanelScaffold();

      const destLabelEl = addPanelEl.querySelector('[data-part="dest-label"]');
      if (destLabelEl) {
        destLabelEl.innerHTML = `Sẽ lưu vào <strong>${esc(parsed.name || '…')}</strong> · <span lang="en" class="text-muted">Will save to <strong>${esc(parsed.name || '…')}</strong></span>`;
      }

      const destTagsEl = addPanelEl.querySelector('[data-part="dest-tags"]');
      if (destTagsEl) {
        destTagsEl.innerHTML = parsed.tags.length
          ? parsed.tags.map((t) => `<span class="chip dup-chip" title="#${esc(t)}">#${esc(t)}</span>`).join('')
          : `<span class="text-[12px] text-muted">không gắn tag · <span lang="en">no tags</span></span>`;
      }

      const hasGrammarErr = parsed.mode === 'add-invalid';
      const hasPlanTargetLimitErr = !!(activePlan && activePlan.error === 'target-tag-limit');
      const hasPlanFailedStep = !!(activePlan && activePlan.steps && activePlan.steps.some((s) => s.status === 'failed'));
      const errBox = addPanelEl.querySelector('#' + baseId + '-add-error');
      const errViEl = addPanelEl.querySelector('[data-part="err-vi"]');
      const errEnEl = addPanelEl.querySelector('[data-part="err-en"]');

      if (hasGrammarErr) {
        const isSoftHint = parsed.error === 'empty-body' || (parsed.error === 'name-invalid' && !parsed.name);
        const roleVal = isSoftHint ? 'status' : 'alert';
        if (roleVal === 'alert') {
          input.setAttribute('aria-invalid', 'true');
        } else {
          input.removeAttribute('aria-invalid');
        }
        const sig = `${roleVal}:${parsed.error}:${parsed.errorVi}`;
        if (errBox) {
          errBox.hidden = false;
          if (sig !== lastErrorAlertSig) {
            lastErrorAlertSig = sig;
            errBox.setAttribute('role', roleVal);
            if (errViEl) errViEl.textContent = parsed.errorVi;
            if (errEnEl) errEnEl.textContent = parsed.errorEn;
          }
        }
      } else if (hasPlanTargetLimitErr) {
        input.setAttribute('aria-invalid', 'true');
        const sig = `alert:target-tag-limit:${activePlan.errorVi}`;
        if (errBox) {
          errBox.hidden = false;
          if (sig !== lastErrorAlertSig) {
            lastErrorAlertSig = sig;
            errBox.setAttribute('role', 'alert');
            if (errViEl) errViEl.textContent = activePlan.errorVi;
            if (errEnEl) errEnEl.textContent = activePlan.errorEn;
          }
        }
      } else {
        input.removeAttribute('aria-invalid');
        lastErrorAlertSig = '';
        if (errBox) errBox.hidden = true;
      }

      const jsonBannerEl = addPanelEl.querySelector('#' + baseId + '-json-banner');
      if (jsonBannerEl) {
        jsonBannerEl.hidden = !(parsed.mode === 'add' && parsed.jsonCandidate);
      }

      const planBoxEl = addPanelEl.querySelector('#' + baseId + '-save-plan');
      const stepListEl = addPanelEl.querySelector('[data-part="step-list"]');
      const planErrorEl = addPanelEl.querySelector('#' + baseId + '-plan-error');
      const failTitleEl = addPanelEl.querySelector('[data-part="fail-title"]');

      if (activePlan && activePlan.steps && activePlan.steps.length) {
        if (planBoxEl) {
          planBoxEl.hidden = false;
          planBoxEl.setAttribute('aria-busy', String(!!activePlan.running));
        }
        if (stepListEl) {
          stepListEl.innerHTML = activePlan.steps.map((st) => {
            let badgeClass = 'badge-ok';
            let statusLabel = 'Chờ · Pending';
            if (st.status === 'done') { badgeClass = 'badge-text'; statusLabel = '✓ Xong · Done'; }
            else if (st.status === 'running') { badgeClass = 'badge-warn'; statusLabel = 'Đang gửi… · Sending…'; }
            else if (st.status === 'failed') { badgeClass = 'badge-err'; statusLabel = 'Lỗi · Failed'; }
            return `<li class="omni-step-item" data-step-key="${esc(st.key)}" data-step-status="${esc(st.status)}">
              <span class="mono text-[12px]">${esc(st.api)}</span>
              <span class="text-[13px] text-body">${esc(st.labelVi)} · <span lang="en" class="text-muted">${esc(st.labelEn)}</span></span>
              <span class="badge-type ${badgeClass} ml-auto">${statusLabel}</span>
            </li>`;
          }).join('');
        }
        const failedStep = activePlan.steps.find((s) => s.status === 'failed');
        if (failedStep && planErrorEl) {
          planErrorEl.hidden = false;
          const failSig = `${failedStep.key}:${failedStep.labelVi}`;
          if (failSig !== lastFailAlertSig) {
            lastFailAlertSig = failSig;
            if (failTitleEl) {
              failTitleEl.innerHTML = `Lỗi ở bước “${esc(failedStep.labelVi)}” — bản nháp và kế hoạch được giữ nguyên · <span lang="en" class="font-normal text-muted">Failed at “${esc(failedStep.labelEn)}” — draft &amp; plan preserved</span>`;
            }
          }
        } else if (planErrorEl) {
          planErrorEl.hidden = true;
          lastFailAlertSig = '';
        }
      } else if (planBoxEl) {
        planBoxEl.hidden = true;
        planBoxEl.removeAttribute('aria-busy');
        if (planErrorEl) planErrorEl.hidden = true;
        lastFailAlertSig = '';
      }

      const unlockBtnEl = addPanelEl.querySelector('#' + baseId + '-unlock-to-save-btn');
      const saveWrapEl = addPanelEl.querySelector('[data-part="save-wrap"]');
      const saveBtnEl = addPanelEl.querySelector('[data-omni-save-now]');
      if (state.locked) {
        if (unlockBtnEl) unlockBtnEl.hidden = false;
        if (saveWrapEl) saveWrapEl.hidden = true;
      } else {
        if (unlockBtnEl) unlockBtnEl.hidden = true;
        if (saveWrapEl) saveWrapEl.hidden = false;
        if (saveBtnEl) {
          saveBtnEl.disabled = !!(hasGrammarErr || hasPlanTargetLimitErr || (activePlan && activePlan.running) || hasPlanFailedStep);
        }
      }
    }

    function buildSavePlan(parsed, targetItemId, isNewItem, optsPlan) {
      optsPlan = optsPlan || {};
      const steps = [];
      if (isNewItem) {
        steps.push({
          key: 'item',
          api: 'POST /items',
          labelVi: `Tạo mục “${parsed.name}”`,
          labelEn: `Create item “${parsed.name}”`,
          status: 'pending'
        });
      }
      if (parsed.tags.length > 0) {
        steps.push({
          key: 'tags',
          api: `POST /tags (×${parsed.tags.length})`,
          labelVi: `Upsert ${parsed.tags.length} tag`,
          labelEn: `Upsert ${parsed.tags.length} tag(s)`,
          status: 'pending'
        });
        steps.push({
          key: 'assign',
          api: 'POST /items/{id}/tags',
          labelVi: 'Gán tag cộng dồn (trần 20)',
          labelEn: 'Additive tag assign (cap 20)',
          status: 'pending'
        });
      }
      steps.push({
        key: 'entry',
        api: 'POST /items/{id}/entries',
        labelVi: 'Mã hoá & lưu entry text',
        labelEn: 'Seal & save text entry',
        status: 'pending'
      });

      return {
        name: optsPlan.resolvedName || parsed.name,
        tags: parsed.tags.slice(),
        itemId: targetItemId,
        isNewItem: !!isNewItem,
        steps,
        failAtKey: optsPlan.failAtKey || null,
        running: false,
        error: null
      };
    }

    function completeQuickAddSave(plan) {
      const savedName = plan.name;
      clearPlanTimers();
      activePlan = null;
      input.value = '';
      syncTextareaHeight();
      input.dataset.justClearedBySave = '1';
      closeListbox(true);
      renderHintAndPanels();
      toast(`Đã lưu vào “${savedName}” · Saved to “${savedName}”`, 'Hoàn tác', {
        sub: COPY_UNDO_SUB,
        originEl: input
      });
    }

    function runPlanSteps(plan, immediate) {
      if (!plan || !plan.steps) return;
      clearPlanTimers();
      plan.running = true;

      if (immediate) {
        for (let i = 0; i < plan.steps.length; i++) {
          const st = plan.steps[i];
          if (st.status === 'done') continue;
          if (plan.pauseAtKey && st.key === plan.pauseAtKey) {
            st.status = 'running';
            plan.pauseAtKey = null;
            plan.running = true;
            renderHintAndPanels();
            setLiveText(`Đang lưu bước ${st.labelVi}…`);
            return;
          }
          if (plan.failAtKey && st.key === plan.failAtKey) {
            st.status = 'failed';
            plan.failAtKey = null;
            plan.running = false;
            renderHintAndPanels();
            setLiveText(`Lỗi ở bước ${st.labelVi}. Bấm Thử lại để tiếp tục.`);
            const retryBtn = addPanelEl.querySelector('[data-omni-retry-plan]');
            if (retryBtn && document.activeElement === document.body) retryBtn.focus();
            return;
          }
          st.status = 'done';
        }
        plan.running = false;
        renderHintAndPanels();
        completeQuickAddSave(plan);
        return;
      }

      const pendingIndices = [];
      for (let i = 0; i < plan.steps.length; i++) {
        if (plan.steps[i].status !== 'done') {
          pendingIndices.push(i);
        }
      }
      if (!pendingIndices.length) {
        plan.running = false;
        renderHintAndPanels();
        completeQuickAddSave(plan);
        return;
      }

      function advanceStep(pos) {
        if (activePlan !== plan || state.locked) return;
        const stepIdx = pendingIndices[pos];
        const st = plan.steps[stepIdx];
        st.status = 'running';
        renderHintAndPanels();

        if (plan.pauseAtKey && st.key === plan.pauseAtKey) {
          plan.pauseAtKey = null;
          setLiveText(`Đang lưu bước ${st.labelVi}…`);
          return;
        }

        const tid = setTimeout(() => {
          if (activePlan !== plan || state.locked) return;
          if (plan.failAtKey && st.key === plan.failAtKey) {
            st.status = 'failed';
            plan.failAtKey = null;
            plan.running = false;
            renderHintAndPanels();
            setLiveText(`Lỗi ở bước ${st.labelVi}. Bấm Thử lại để tiếp tục.`);
            const retryBtn = addPanelEl.querySelector('[data-omni-retry-plan]');
            if (retryBtn) retryBtn.focus();
            return;
          }
          st.status = 'done';
          if (pos + 1 < pendingIndices.length) {
            advanceStep(pos + 1);
          } else {
            plan.running = false;
            renderHintAndPanels();
            completeQuickAddSave(plan);
          }
        }, 160);
        planStepTimers.push(tid);
      }

      advanceStep(0);
    }

    function executeAddAfterTargetResolved(parsed, targetItem, isNewItem, simOpts) {
      simOpts = simOpts || {};
      const existingTags = (targetItem && Array.isArray(targetItem.tags)) ? targetItem.tags : [];
      const existingCount = simOpts.existingTagCount != null ? simOpts.existingTagCount : existingTags.length;
      const existingNormSet = new Set(existingTags.map((t) => normIdentity(t)));
      const newUniqueCount = parsed.tags.filter((t) => !existingNormSet.has(normIdentity(t))).length;

      if (!isNewItem && existingCount + newUniqueCount > 20) {
        activePlan = {
          name: parsed.name,
          tags: parsed.tags,
          steps: [],
          error: 'target-tag-limit',
          errorVi: `Mục này đã có ${existingCount} tag; tối đa 20`,
          errorEn: `This item already has ${existingCount} tags; maximum is 20`
        };
        renderHintAndPanels();
        return;
      }

      const resolvedId = isNewItem
        ? ('item_new_' + Math.random().toString(36).slice(2, 7))
        : (targetItem ? targetItem.id : 'i1');

      const resolvedTargetName = (!isNewItem && targetItem && targetItem.name) ? targetItem.name : parsed.name;
      activePlan = buildSavePlan(parsed, resolvedId, isNewItem, {
        resolvedName: resolvedTargetName,
        failAtKey: simOpts.failAtKey || null
      });
      if (simOpts.pauseAtKey) {
        activePlan.pauseAtKey = simOpts.pauseAtKey;
      }
      renderHintAndPanels();
      runPlanSteps(activePlan, simOpts.immediate != null ? !!simOpts.immediate : !!(simOpts.failAtKey || simOpts.pauseAtKey));
    }

    function submitQuickAdd(forceCreateNew, simOpts) {
      simOpts = simOpts || {};
      const parsed = parseQuickAdd(input.value);
      if (parsed.mode !== 'add') {
        renderHintAndPanels();
        return;
      }
      if (state.locked) {
        renderHintAndPanels();
        return;
      }
      if (forceCreateNew) {
        executeAddAfterTargetResolved(parsed, null, true, simOpts);
        return;
      }
      const matches = simOpts.mockMatches || lookupItemsExact(parsed.name);
      if (matches.length === 0) {
        executeAddAfterTargetResolved(parsed, null, true, simOpts);
      } else if (matches.length === 1) {
        executeAddAfterTargetResolved(parsed, matches[0], false, simOpts);
      } else {
        openDupDialog({
          name: parsed.name,
          dupes: matches,
          total: matches.length,
          silentToast: true,
          triggerEl: input
        }).then((pickedId) => {
          if (!pickedId) return;
          if (String(pickedId).startsWith('item_new_')) {
            executeAddAfterTargetResolved(parsed, null, true, simOpts);
          } else {
            const chosen = matches.find((m) => m.id === pickedId) || matches[0];
            executeAddAfterTargetResolved(parsed, chosen, false, simOpts);
          }
        });
      }
    }

    function executeOption(opt) {
      if (!opt) return;
      if (opt.kind === 'item') {
        closeListbox(false);
        if (typeof opts.onOpenItem === 'function') {
          opts.onOpenItem(opt.item);
        } else {
          location.href = 'item.html';
        }
        return;
      }
      if (opt.kind === 'create') {
        const q = opt.query || input.value.trim();
        closeListbox(false);
        input.value = '';
        renderHintAndPanels();
        toast(`Đã tạo mục “${q}” (chưa có entry) · Created item “${q}” (no entries)`, 'Hoàn tác', {
          originEl: input
        });
        return;
      }
      if (opt.kind === 'tag') {
        const tagName = opt.tag.name;
        closeListbox(false);
        if (typeof opts.onFilterTag === 'function') {
          opts.onFilterTag(tagName);
        } else {
          const railBtn = document.querySelector(`[data-tag-filter="${tagName}"]`);
          if (railBtn) railBtn.click();
          toast(`Đang lọc theo #${tagName} · Filtering by #${tagName}`);
        }
      }
    }

    function handleEnter(e) {
      const parsed = parseQuickAdd(input.value);
      const isCtrl = e.ctrlKey || e.metaKey;

      if (parsed.mode === 'tag-filter') {
        if (isCtrl) return;
        if (!parsed.searchable) {
          closeListbox(false);
          guardEl.hidden = false;
          guardEl.innerHTML = `<p class="m-0 text-[13px] font-semibold text-body">Tên tag lọc tối đa 50 ký tự · <span lang="en" class="font-normal text-muted">Tag filter query must be at most 50 characters</span></p>`;
          setLiveText('Tên tag lọc tối đa 50 ký tự · Tag filter query must be at most 50 characters');
          return;
        }
        guardEl.hidden = true;
        if (listOpen && listKind === 'tag-filter' && activeIdx >= 0 && listOptions[activeIdx]) {
          executeOption(listOptions[activeIdx]);
          return;
        }
        const cached = filterTagsPrefix(parsed.tagQuery);
        renderTagListbox(parsed.tagQuery, cached, true);
        return;
      }

      if (parsed.mode === 'search') {
        if (parsed.tooLongOrMulti) {
          closeListbox(false);
          guardEl.hidden = false;
          guardEl.innerHTML = `<p class="m-0 text-[13px] font-semibold text-body">Thêm tên và dấu <span class="mono">:</span> để lưu · <span lang="en" class="font-normal text-muted">Add a name and <span class="mono">:</span> to save</span></p>
            <p class="m-0 mt-0.5 text-[12px] text-muted">Chuỗi nhiều dòng hoặc dài quá 200 ký tự không được gửi tìm kiếm để tránh lộ nội dung. Gõ <span class="mono">tên: nội dung</span> ở dòng đầu để mã hoá và lưu. · <span lang="en">Multi-line or &gt; 200-character input is never sent as a search query. Prefix with <span class="mono">name:</span> to encrypt and save.</span></p>`;
          setLiveText('Thêm tên và dấu : để lưu · Add a name and : to save');
          return;
        }
        guardEl.hidden = true;
        if (!parsed.name) {
          closeListbox(true);
          return;
        }
        if (isCtrl && parsed.searchable) {
          const newName = parsed.name;
          closeListbox(false);
          input.value = '';
          renderHintAndPanels();
          toast(`Đã tạo mục mới “${newName}” (chưa có entry) · Created new item “${newName}” (no entries)`, 'Hoàn tác', {
            originEl: input
          });
          return;
        }
        if (listOpen && listKind === 'search' && activeIdx >= 0 && listOptions[activeIdx]) {
          executeOption(listOptions[activeIdx]);
          return;
        }
        const hits = searchItemsPrefix(parsed.name);
        renderSearchListbox(parsed.name, hits);
        return;
      }

      if (parsed.mode === 'add-invalid') {
        closeListbox(true);
        renderHintAndPanels();
        return;
      }

      if (parsed.mode === 'add') {
        closeListbox(true);
        if (activePlan && activePlan.steps && activePlan.steps.some((s) => s.status === 'failed')) {
          runPlanSteps(activePlan, false);
          return;
        }
        if (activePlan && activePlan.running) {
          return;
        }
        submitQuickAdd(isCtrl, {});
      }
    }

    input.addEventListener('input', () => {
      showPostUnlockNotice = false;
      guardEl.hidden = true;
      if (activePlan) {
        clearPlanTimers();
        activePlan = null;
      }
      const parsed = parseQuickAdd(input.value);
      if (parsed.mode === 'tag-filter') {
        const cached = filterTagsPrefix(parsed.tagQuery);
        renderTagListbox(parsed.tagQuery, cached, false);
      } else if (listOpen) {
        closeListbox(true);
      }
      renderHintAndPanels();
    });

    input.addEventListener('keydown', (e) => {
      if (e.isComposing || e.keyCode === 229) return;
      if (e.key === 'ArrowDown') {
        if (!listOpen || !listOptions.length) return;
        e.preventDefault();
        activeIdx = activeIdx < 0 ? 0 : (activeIdx + 1) % listOptions.length;
        syncActiveOption();
      } else if (e.key === 'ArrowUp') {
        if (!listOpen || !listOptions.length) return;
        e.preventDefault();
        activeIdx = activeIdx <= 0 ? listOptions.length - 1 : activeIdx - 1;
        syncActiveOption();
      } else if (e.key === 'Enter') {
        if (e.shiftKey && !e.ctrlKey && !e.metaKey && input.tagName === 'TEXTAREA') {
          requestAnimationFrame(syncTextareaHeight);
          return;
        }
        e.preventDefault();
        handleEnter(e);
      } else if (e.key === 'Escape') {
        if (listOpen) {
          e.preventDefault();
          closeListbox(false);
        } else if (input.value) {
          e.preventDefault();
          input.value = '';
          clearPlanTimers();
          activePlan = null;
          guardEl.hidden = true;
          renderHintAndPanels();
        }
      }
    });

    pop.addEventListener('mousemove', (e) => {
      const row = e.target.closest('[role="option"]');
      if (!row || !listOpen) return;
      const idx = Number(row.dataset.optIdx);
      if (!Number.isNaN(idx) && idx !== activeIdx) {
        activeIdx = idx;
        syncActiveOption();
      }
    });

    pop.addEventListener('click', (e) => {
      const row = e.target.closest('[role="option"]');
      if (!row) return;
      const idx = Number(row.dataset.optIdx);
      if (!Number.isNaN(idx) && listOptions[idx]) {
        executeOption(listOptions[idx]);
      }
    });

    auxHost.addEventListener('click', (e) => {
      if (e.target.closest('[data-dismiss-lock-notice]')) {
        showPostUnlockNotice = false;
        lockNoticeEl.hidden = true;
        return;
      }
      if (e.target.closest('[data-omni-unlock-save]')) {
        const pill = document.querySelector('[data-vault]');
        if (pill) pill.click();
        return;
      }
      if (e.target.closest('[data-omni-save-now]')) {
        if (activePlan && activePlan.steps && activePlan.steps.some((s) => s.status === 'failed')) {
          return;
        }
        input.focus();
        submitQuickAdd(false, {});
        return;
      }
      if (e.target.closest('[data-omni-retry-plan]')) {
        if (activePlan) {
          input.focus();
          runPlanSteps(activePlan, false);
        }
        return;
      }
      if (e.target.closest('[data-omni-open-json]')) {
        const parsed = parseQuickAdd(input.value);
        const importDlg = document.getElementById('importDlg');
        if (importDlg && typeof importDlg.showModal === 'function') {
          const importSrc = document.getElementById('importSrc');
          if (importSrc && parsed.body) {
            importSrc.value = parsed.body;
            importSrc.dispatchEvent(new Event('input', { bubbles: true }));
          }
          importDlg.showModal();
        } else {
          let stubDlg = document.getElementById('jsonImportStubDlg');
          if (!stubDlg) {
            stubDlg = document.createElement('dialog');
            stubDlg.id = 'jsonImportStubDlg';
            stubDlg.setAttribute('aria-labelledby', 'jsonImportStubTitle');
            document.body.appendChild(stubDlg);
          }
          stubDlg.innerHTML = `<div class="panel dup-panel">
            <p class="t-label mb-1 text-muted">Import JSON · U14 (Bước 3)</p>
            <h2 id="jsonImportStubTitle" class="t-title-sm mb-1">Lưu JSON như bảng vào “${esc(parsed.name || 'wifi')}”</h2>
            <p class="t-body text-muted m-0 mb-1">
              Đã chuyển nội dung JSON hợp lệ từ quick-add sang hộp nhập bảng JSON (không tự đổi kiểu ngầm khi chưa xác nhận).
            </p>
            <p class="text-[12px] text-muted m-0 mb-4" lang="en">
              <strong>Save JSON as table into “${esc(parsed.name || 'wifi')}”.</strong> Valid JSON from quick-add is handed off to the JSON import modal (never silently coerced without confirmation; full import flow in Step 3).
            </p>
            <div class="flex flex-wrap justify-end gap-2">
              <button type="button" class="btn btn-tertiary" data-close-stub="1">Đóng · <span lang="en">Close</span></button>
              <a href="item.html" class="btn btn-primary no-underline">Mở trang mục (#importDlg) · <span lang="en">Open item page</span></a>
            </div>
          </div>`;
          stubDlg.onclick = (ev) => {
            if (ev.target.closest('[data-close-stub]')) stubDlg.close();
          };
          if (!stubDlg.open) stubDlg.showModal();
        }
      }
    });

    if (!opts.pinned) {
      document.addEventListener('click', (e) => {
        if (e.target.closest('#omni-demo-bar')) return;
        if (!root.contains(e.target)) closeListbox(false);
      });
    }

    document.addEventListener('keydown', (e) => {
      const k = e.key || '';
      if ((k === 'k' && (e.metaKey || e.ctrlKey)) ||
          (k === '/' && !/^(INPUT|TEXTAREA)$/.test((document.activeElement && document.activeElement.tagName) || ''))) {
        e.preventDefault();
        input.focus();
        input.select();
      }
    });

    function onVaultStateChange(isLocked, wasLocked) {
      if (isLocked && !wasLocked) {
        const hasText = input.value.trim().length > 0;
        const hasCommitted = !!(activePlan && activePlan.steps && activePlan.steps.some((s) => s.status === 'done'));
        if (hasText || activePlan) {
          hadDraftOnLock = true;
          hadCommittedMetaOnLock = hasCommitted;
          input.value = '';
          clearPlanTimers();
          activePlan = null;
          guardEl.hidden = true;
        }
        closeListbox(true);
        renderHintAndPanels();
      } else if (!isLocked && wasLocked) {
        if (hadDraftOnLock) {
          showPostUnlockNotice = true;
          hadDraftOnLock = false;
        }
        renderHintAndPanels();
      } else {
        renderHintAndPanels();
      }
    }

    const api = {
      input,
      paint: renderHintAndPanels,
      closeListbox,
      triggerSearch: () => {
        const parsed = parseQuickAdd(input.value);
        if (parsed.mode === 'search' && parsed.tooLongOrMulti) {
          handleEnter({ ctrlKey: false, metaKey: false });
        } else if (parsed.mode === 'search' && parsed.name) {
          renderSearchListbox(parsed.name, searchItemsPrefix(parsed.name));
        } else if (parsed.mode === 'tag-filter') {
          renderTagListbox(parsed.tagQuery, filterTagsPrefix(parsed.tagQuery), true);
        }
        renderHintAndPanels();
      },
      setScenario: (scenarioName) => {
        showPostUnlockNotice = false;
        hadDraftOnLock = false;
        hadCommittedMetaOnLock = false;
        clearPlanTimers();
        activePlan = null;
        guardEl.hidden = true;
        closeListbox(true);

        if (scenarioName === 'search-hint') {
          if (state.locked) { state.locked = false; if (window.SAK._syncVault) window.SAK._syncVault(); }
          input.value = 'wif';
          renderHintAndPanels();
          input.focus();
        } else if (scenarioName === 'search-results') {
          if (state.locked) { state.locked = false; if (window.SAK._syncVault) window.SAK._syncVault(); }
          input.value = 'wif';
          renderHintAndPanels();
          renderSearchListbox('wif', searchItemsPrefix('wif'));
          input.focus();
        } else if (scenarioName === 'search-empty') {
          if (state.locked) { state.locked = false; if (window.SAK._syncVault) window.SAK._syncVault(); }
          input.value = 'thuế 2026';
          renderHintAndPanels();
          renderSearchListbox('thuế 2026', []);
          input.focus();
        } else if (scenarioName === 'search-multiline-guard') {
          if (state.locked) { state.locked = false; if (window.SAK._syncVault) window.SAK._syncVault(); }
          input.value = 'dòng 1 chưa có dấu hai chấm\ndòng 2 nội dung dài cần mã hoá';
          renderHintAndPanels();
          handleEnter({ ctrlKey: false, metaKey: false });
          input.focus();
        } else if (scenarioName === 'search-200-guard') {
          if (state.locked) { state.locked = false; if (window.SAK._syncVault) window.SAK._syncVault(); }
          input.value = 'chuỗi-một-dòng-dài-quá-200-ký-tự-không-có-dấu-hai-chấm-' + 'a'.repeat(160);
          renderHintAndPanels();
          handleEnter({ ctrlKey: false, metaKey: false });
          input.focus();
        } else if (scenarioName === 'tag-filter') {
          if (state.locked) { state.locked = false; if (window.SAK._syncVault) window.SAK._syncVault(); }
          input.value = '#nh';
          renderHintAndPanels();
          renderTagListbox('nh', filterTagsPrefix('nh'), false);
          input.focus();
        } else if (scenarioName === 'add-preview') {
          if (state.locked) { state.locked = false; if (window.SAK._syncVault) window.SAK._syncVault(); }
          input.value = 'wifi #nhà #office: SSID Zone17th-5G / mk 8chars';
          renderHintAndPanels();
          input.focus();
        } else if (scenarioName === 'add-json-banner') {
          if (state.locked) { state.locked = false; if (window.SAK._syncVault) window.SAK._syncVault(); }
          input.value = 'wifi #ops: {"ssid":"Zone17th-5G","vlan":10}';
          renderHintAndPanels();
          input.focus();
        } else if (scenarioName === 'add-err-tag-space') {
          if (state.locked) { state.locked = false; if (window.SAK._syncVault) window.SAK._syncVault(); }
          input.value = 'wifi #nhà bố mẹ: Abc123@home';
          renderHintAndPanels();
          input.focus();
        } else if (scenarioName === 'add-err-21-tags') {
          if (state.locked) { state.locked = false; if (window.SAK._syncVault) window.SAK._syncVault(); }
          const tags21 = Array.from({ length: 21 }, (_, i) => `#t${i + 1}`).join(' ');
          input.value = `wifi ${tags21}: nội dung mẫu`;
          renderHintAndPanels();
          input.focus();
        } else if (scenarioName === 'add-err-empty-body') {
          if (state.locked) { state.locked = false; if (window.SAK._syncVault) window.SAK._syncVault(); }
          input.value = 'wifi #nhà:   ';
          renderHintAndPanels();
          input.focus();
        } else if (scenarioName === 'add-err-target-tag-cap') {
          if (state.locked) { state.locked = false; if (window.SAK._syncVault) window.SAK._syncVault(); }
          input.value = 'wifi-office #tag-mới-1 #tag-mới-2 #tag-mới-3: nội dung thêm';
          const parsed = parseQuickAdd(input.value);
          executeAddAfterTargetResolved(parsed, ITEMS.find((i) => i.id === 'i3'), false, { existingTagCount: 18 });
          input.focus();
        } else if (scenarioName === 'save-step-running') {
          if (state.locked) { state.locked = false; if (window.SAK._syncVault) window.SAK._syncVault(); }
          input.value = 'router-mới #nhà #ops: cấu hình PPPoE ISP';
          const parsed = parseQuickAdd(input.value);
          executeAddAfterTargetResolved(parsed, null, true, { pauseAtKey: 'entry', immediate: true });
          input.focus();
        } else if (scenarioName === 'save-step-error') {
          if (state.locked) { state.locked = false; if (window.SAK._syncVault) window.SAK._syncVault(); }
          input.value = 'router-mới #nhà #ops: cấu hình PPPoE ISP';
          const parsed = parseQuickAdd(input.value);
          executeAddAfterTargetResolved(parsed, null, true, { failAtKey: 'entry', immediate: true });
          const retryBtn = addPanelEl.querySelector('[data-omni-retry-plan]');
          if (retryBtn) retryBtn.focus();
        } else if (scenarioName === 'locked-add') {
          input.value = 'wifi #nhà: mật khẩu đang gõ khi khoá';
          state.locked = true;
          if (window.SAK._syncVault) window.SAK._syncVault({ keepDraftForDemo: true });
          renderHintAndPanels();
          input.focus();
        } else if (scenarioName === 'unlocked-draft-cleared') {
          if (state.locked) { state.locked = false; if (window.SAK._syncVault) window.SAK._syncVault(); }
          input.value = '';
          hadCommittedMetaOnLock = true;
          showPostUnlockNotice = true;
          renderHintAndPanels();
          input.focus();
        }
      },
      onVaultStateChange
    };

    root._repaint = renderHintAndPanels;
    root._omniApi = api;
    omniboxInstances.push(api);
    renderHintAndPanels();
    return api;
  }

  /* ---------- hộp thoại trùng tên — Picker U9 (SPEC §3.4, plan mục 2.11) ---------- */

  function openDupDialog(add, onPick) {
    const payload = add && typeof add === 'object' ? add : {
      name: String(add || 'wifi'),
      dupes: ITEMS.filter((i) => normIdentity(i.name) === normIdentity(add || 'wifi'))
    };
    const dupes = Array.isArray(payload.dupes) && payload.dupes.length
      ? payload.dupes
      : ITEMS.filter((i) => normIdentity(i.name) === normIdentity(payload.name || 'wifi'));
    const total = payload.total || dupes.length;
    const pageSize = payload.pageSize || 2;
    let shownCount = Math.min(pageSize, dupes.length);
    const triggerEl = (payload.triggerEl instanceof HTMLElement)
      ? payload.triggerEl
      : (document.activeElement instanceof HTMLElement ? document.activeElement : null);
    let dlg = document.getElementById('dupDialog');
    if (!dlg) {
      dlg = document.createElement('dialog');
      dlg.id = 'dupDialog';
      dlg.setAttribute('aria-labelledby', 'dupDialogTitle');
      document.body.appendChild(dlg);
    }

    let activeIdx = 0;

    return new Promise((resolve) => {
      let settled = false;
      function finish(pickedId) {
        if (settled) return;
        settled = true;
        if (dlg.open) dlg.close();
        if (triggerEl && triggerEl.isConnected && typeof triggerEl.focus === 'function') triggerEl.focus();
        if (typeof onPick === 'function' && pickedId) onPick(pickedId);
        resolve(pickedId || null);
      }

      function renderPicker() {
        const visibleDupes = dupes.slice(0, shownCount);
        const hasMore = shownCount < dupes.length;
        const remaining = dupes.length - shownCount;

        const rowsHtml = visibleDupes.map((d, idx) => {
          const tags = Array.isArray(d.tags) ? d.tags : [];
          const shownTags = tags.slice(0, 3);
          const extraTags = tags.length > 3 ? tags.length - 3 : 0;
          const created = d.created_at || d.updated || '12/03/2026';
          const count = d.entry_count != null ? d.entry_count : (d.entries != null ? d.entries : 0);
          const isSel = idx === activeIdx;
          return `<button type="button" role="option" id="dup-opt-${esc(d.id)}" aria-selected="${isSel}" tabindex="${isSel ? '0' : '-1'}"
            class="dup-row" data-pick="${esc(d.id)}" data-opt-idx="${idx}">
            <span class="dup-row-main">
              <span class="dup-row-tags">
                <strong>${esc(d.name)}</strong>
                ${shownTags.map((t) => `<span class="chip dup-chip" title="#${esc(t)}">#${esc(t)}</span>`).join('')}
                ${extraTags > 0 ? `<span class="mono text-[12px] text-muted">+${extraTags}</span>` : ''}
              </span>
              ${d.hint ? `<span class="text-[13px] text-muted">${esc(d.hint)}</span>` : ''}
            </span>
            <span class="sugg-meta mono">${count} entries · tạo ${esc(created)} · <span lang="en">created ${esc(created)}</span></span>
          </button>`;
        }).join('');

        const newIdx = visibleDupes.length;
        const newSel = activeIdx === newIdx;

        dlg.innerHTML = `<div class="panel dup-panel">
          <p class="t-label mb-1 text-muted">Trùng tên mục · U9 Picker (<span class="mono">GET /items/lookup</span>)</p>
          <h2 id="dupDialogTitle" class="t-title-sm mb-1">Có ${total} mục tên “${esc(payload.name)}”</h2>
          <p class="t-body text-muted m-0 mb-1">
            Tên mục được phép trùng. Chọn đúng mục (theo tag và ngày tạo) để lưu entry mới, hoặc tạo mục mới cùng tên.
          </p>
          <p class="text-[12px] text-muted m-0 mb-4" lang="en">
            <strong>${total} items named “${esc(payload.name)}”.</strong> Duplicate item names are allowed. Pick the target item by its tags and creation date (returns item ID), or create a new item with the same name.
          </p>
          <div class="dup-list" role="listbox" id="dupListbox" aria-label="Chọn mục đích cho ${esc(payload.name)} · Select target item for ${esc(payload.name)}">
            ${rowsHtml}
            <button type="button" role="option" id="dup-opt-new" aria-selected="${newSel}" tabindex="${newSel ? '0' : '-1'}"
              class="dup-row dup-row-new" data-pick="new" data-opt-idx="${newIdx}">
              <span class="mono text-accent">+</span>
              <span><strong>Tạo mục mới cùng tên “${esc(payload.name)}”</strong> · <span lang="en" class="text-muted">Create new item with the same name</span></span>
            </button>
          </div>
          ${hasMore ? `<div class="mb-4">
            <button type="button" class="btn btn-tertiary btn-sm w-full" data-dup-more="1">
              Xem thêm (${remaining} mục) · <span lang="en">Load more (${remaining})</span>
            </button>
          </div>` : ''}
          <div class="flex flex-wrap items-center justify-between gap-2">
            <span class="text-[12px] text-muted"><span class="kbd">↑↓</span> chọn · <span class="kbd">Enter</span> lưu · <span class="kbd">Esc</span> huỷ · <span lang="en">select / save / cancel</span></span>
            <button type="button" class="btn btn-tertiary" data-close>Huỷ · <span lang="en">Cancel</span></button>
          </div>
        </div>`;
      }

      function syncSelection() {
        const opts = dlg.querySelectorAll('[role="option"]');
        opts.forEach((el, idx) => {
          const isSel = idx === activeIdx;
          el.setAttribute('aria-selected', String(isSel));
          el.setAttribute('tabindex', isSel ? '0' : '-1');
          if (isSel) el.focus();
        });
      }

      function handlePick(pickVal) {
        const resolvedId = pickVal === 'new' ? 'item_new_' + Math.random().toString(36).slice(2, 7) : pickVal;
        dlg.dataset.lastPickedId = resolvedId;
        finish(resolvedId);
        if (!payload.silentToast) {
          const label = pickVal === 'new'
            ? `Đã tạo mục mới “${payload.name}” và lưu entry · Created new item “${payload.name}” and saved entry`
            : `Đã lưu vào “${payload.name}” · Saved to “${payload.name}”`;
          toast(label, 'Hoàn tác', {
            sub: COPY_UNDO_SUB,
            originEl: triggerEl
          });
        }
      }
      dlg.onclick = (e) => {
        if (e.target.closest('[data-close]')) {
          finish(null);
          return;
        }
        if (e.target.closest('[data-dup-more]')) {
          shownCount = dupes.length;
          renderPicker();
          syncSelection();
          return;
        }
        const pick = e.target.closest('[data-pick]');
        if (pick) {
          handlePick(pick.dataset.pick);
        }
      };

      dlg.onkeydown = (e) => {
        const opts = dlg.querySelectorAll('[role="option"]');
        if (!opts.length) return;
        if (e.key === 'ArrowDown') {
          e.preventDefault();
          activeIdx = (activeIdx + 1) % opts.length;
          syncSelection();
        } else if (e.key === 'ArrowUp') {
          e.preventDefault();
          activeIdx = (activeIdx - 1 + opts.length) % opts.length;
          syncSelection();
        } else if (e.key === 'Enter' && !e.target.closest('[data-dup-more]') && !e.target.closest('[data-close]')) {
          e.preventDefault();
          const chosen = opts[activeIdx];
          if (chosen && chosen.dataset.pick) handlePick(chosen.dataset.pick);
        } else if (e.key === 'Escape') {
          e.preventDefault();
          finish(null);
        }
      };

      dlg.onclose = () => {
        if (!settled) finish(null);
      };

      renderPicker();
      if (!dlg.open) dlg.showModal();
      requestAnimationFrame(syncSelection);
    });
  }

  /* ---------- toast manager (plan mục 2.8, SPEC §3.8, §7.8) ---------- */

  function isApplePlatform() {
    const uaPlatform = (navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || '';
    return /^(mac|iphone|ipad|ipod|ios)/i.test(uaPlatform);
  }

  function undoShortcutLabel() {
    return isApplePlatform() ? '⌘Z' : 'Ctrl+Z';
  }

  function formatActionLabel(action) {
    if (!action) return '';
    const sc = undoShortcutLabel();
    const stripped = String(action)
      .replace(/\s*\((?:Ctrl\+Z|⌘Z)\)/gi, '')
      .replace(/\s*·\s*Undo.*$/i, '')
      .trim();
    if (/^(hoàn tác|undo)$/i.test(stripped)) {
      return `Hoàn tác (${sc}) · Undo (${sc})`;
    }
    if (/hoàn tác/i.test(stripped)) return `${stripped} (${sc})`;
    return action;
  }

  let lastInteractionWasKeyboard = false;
  document.addEventListener('keydown', (e) => {
    const k = e.key || '';
    if (k === 'Tab' || k === 'Enter' || k === ' ' || k.startsWith('Arrow')) {
      lastInteractionWasKeyboard = true;
    }
  }, true);
  document.addEventListener('pointerdown', () => {
    lastInteractionWasKeyboard = false;
  }, true);
  document.addEventListener('input', (e) => {
    if (e.target && e.target.dataset && e.target.dataset.justClearedBySave) {
      delete e.target.dataset.justClearedBySave;
    }
  }, true);

  const toastItems = [];
  let toastSeq = 0;
  let toastStackEl = null;
  let toastLiveEl = null;
  let toastMoreBtnEl = null;
  let toastExpanded = false;
  let toastHovering = false;
  let toastFocused = false;
  let toastTickInterval = null;

  function collapseAndResumeIfIdle() {
    if (toastHovering || toastFocused) return;
    if (toastExpanded) {
      toastExpanded = false;
      syncToastDom();
    }
    resumeAllToasts();
  }

  function ensureToastStack() {
    if (toastStackEl && document.body.contains(toastStackEl)) return toastStackEl;
    toastStackEl = document.getElementById('toastStack');
    if (!toastStackEl) {
      toastStackEl = document.createElement('div');
      toastStackEl.id = 'toastStack';
      toastStackEl.className = 'toast-stack';
      document.body.appendChild(toastStackEl);
    }
    toastLiveEl = toastStackEl.querySelector('#toastLiveRegion');
    if (!toastLiveEl) {
      toastLiveEl = document.createElement('div');
      toastLiveEl.id = 'toastLiveRegion';
      toastLiveEl.className = 'toast-live';
      toastLiveEl.setAttribute('role', 'status');
      toastLiveEl.setAttribute('aria-live', 'polite');
      toastLiveEl.setAttribute('aria-atomic', 'false');
      toastStackEl.appendChild(toastLiveEl);
    }
    toastMoreBtnEl = toastStackEl.querySelector('[data-toast-expand]');
    if (!toastMoreBtnEl) {
      toastMoreBtnEl = document.createElement('button');
      toastMoreBtnEl.type = 'button';
      toastMoreBtnEl.className = 'toast-more';
      toastMoreBtnEl.dataset.toastExpand = '1';
      toastMoreBtnEl.hidden = true;
      toastMoreBtnEl.addEventListener('click', () => {
        toastExpanded = true;
        pauseAllToasts(true);
        if (toastItems.length) {
          toastItems.forEach((item) => {
            if (item.el) item.el.hidden = false;
          });
        }
        const firstTarget = toastLiveEl && (
          toastLiveEl.querySelector('.toast:not([hidden]) [data-toast-action]') ||
          toastLiveEl.querySelector('.toast:not([hidden])')
        );
        if (firstTarget) firstTarget.focus();
        syncToastDom();
      });
      toastStackEl.appendChild(toastMoreBtnEl);
    }
    if (!toastStackEl.dataset.boundListeners) {
      toastStackEl.dataset.boundListeners = '1';
      toastStackEl.addEventListener('mouseenter', () => {
        toastHovering = true;
        pauseAllToasts(false);
      });
      toastStackEl.addEventListener('mouseleave', () => {
        toastHovering = false;
        collapseAndResumeIfIdle();
      });
      toastStackEl.addEventListener('focusin', () => {
        toastFocused = true;
        pauseAllToasts(true);
      });
      toastStackEl.addEventListener('focusout', (e) => {
        if (e.relatedTarget && toastStackEl.contains(e.relatedTarget)) return;
        toastFocused = false;
        collapseAndResumeIfIdle();
      });
    }
    return toastStackEl;
  }

  function isStackPaused() {
    return toastHovering || toastFocused || toastExpanded;
  }

  function pauseAllToasts(fromFocus) {
    const now = Date.now();
    toastItems.forEach((item) => {
      if (!item.paused) {
        const elapsed = now - item.lastResumeAt;
        item.remainingMs = Math.max(0, item.remainingMs - elapsed);
        item.paused = true;
      }
      if (fromFocus && item.remainingMs < 10000) {
        item.remainingMs = 10000;
      }
    });
  }

  function resumeAllToasts() {
    const now = Date.now();
    toastItems.forEach((item) => {
      if (item.paused) {
        item.paused = false;
        item.lastResumeAt = now;
      }
    });
  }

  function createToastNode(item) {
    const el = document.createElement('div');
    el.className = 'toast';
    el.tabIndex = -1;
    el.dataset.toastId = String(item.id);
    const actionText = formatActionLabel(item.action);
    el.innerHTML = `<div class="toast-body">
        <span>${esc(item.msg)}</span>
        ${item.sub ? `<span class="toast-sub">${esc(item.sub)}</span>` : ''}
      </div>
      ${actionText ? `<button type="button" data-toast-action="${item.id}">${esc(actionText)}</button>` : ''}`;
    const btn = el.querySelector('[data-toast-action]');
    if (btn) {
      btn.addEventListener('click', () => {
        const found = toastItems.find((t) => t.id === item.id);
        if (found) triggerToastUndo(found);
      });
    }
    return el;
  }

  function syncToastDom() {
    ensureToastStack();
    if (!toastItems.length) {
      if (toastLiveEl) toastLiveEl.innerHTML = '';
      if (toastMoreBtnEl) toastMoreBtnEl.hidden = true;
      return;
    }
    const maxVisible = toastExpanded ? toastItems.length : 3;
    const newestFirst = toastItems.slice().reverse();
    const visibleIds = new Set(newestFirst.slice(0, maxVisible).map((t) => t.id));
    const hiddenItems = newestFirst.slice(maxVisible);
    const hiddenCount = hiddenItems.length;
    const allUndo = hiddenItems.length > 0 && hiddenItems.every((t) => !!t.action);

    toastItems.forEach((item) => {
      if (item.el) {
        item.el.hidden = !visibleIds.has(item.id);
      }
    });

    if (toastMoreBtnEl) {
      if (hiddenCount > 0) {
        toastMoreBtnEl.hidden = false;
        const viNoun = allUndo ? 'hoàn tác' : 'thông báo';
        const enNoun = allUndo ? 'undo' : 'more';
        toastMoreBtnEl.setAttribute(
          'aria-label',
          `Mở rộng thêm ${hiddenCount} ${viNoun} · Expand ${hiddenCount} ${enNoun} notifications`
        );
        toastMoreBtnEl.textContent = `+${hiddenCount} ${viNoun} · +${hiddenCount} ${enNoun}`;
      } else {
        toastMoreBtnEl.hidden = true;
      }
    }
  }

  function removeToastById(id, restoreFocusToOrigin) {
    const idx = toastItems.findIndex((t) => t.id === id);
    if (idx < 0) return;
    const [removed] = toastItems.splice(idx, 1);
    const focusWasInside = toastStackEl && toastStackEl.contains(document.activeElement);
    if (removed.el && removed.el.parentNode) {
      removed.el.parentNode.removeChild(removed.el);
    }
    if (!toastItems.length) {
      toastExpanded = false;
      toastFocused = false;
      toastHovering = false;
    }
    syncToastDom();
    if ((restoreFocusToOrigin || focusWasInside) && removed.originEl && typeof removed.originEl.focus === 'function') {
      if (document.body.contains(removed.originEl)) removed.originEl.focus();
    }
    if (toastStackEl && !toastStackEl.contains(document.activeElement)) {
      toastFocused = false;
      collapseAndResumeIfIdle();
    }
  }

  function triggerToastUndo(item) {
    if (!item) return;
    if (typeof item.onAction === 'function') {
      item.onAction(item);
    }
    removeToastById(item.id, true);
  }

  function ensureToastTicker() {
    if (toastTickInterval) return;
    toastTickInterval = setInterval(() => {
      if (!toastItems.length || isStackPaused()) return;
      const now = Date.now();
      const expired = [];
      toastItems.forEach((item) => {
        if (!item.paused && now - item.lastResumeAt >= item.remainingMs) {
          expired.push(item.id);
        }
      });
      expired.forEach((id) => removeToastById(id, false));
    }, 100);
  }

  function toast(msg, action, opts) {
    opts = opts || {};
    ensureToastStack();
    ensureToastTicker();
    const fromKeyboard = opts.keyboard != null ? !!opts.keyboard : lastInteractionWasKeyboard;
    const duration = opts.duration || (fromKeyboard ? 10000 : 5000);
    const originEl = opts.originEl || (document.activeElement instanceof HTMLElement ? document.activeElement : null);
    const item = {
      id: ++toastSeq,
      msg: String(msg || ''),
      action: action || null,
      sub: opts.sub || null,
      onAction: typeof opts.onAction === 'function' ? opts.onAction : null,
      originEl,
      remainingMs: duration,
      lastResumeAt: Date.now(),
      paused: isStackPaused(),
      el: null
    };
    if (toastFocused && item.remainingMs < 10000) item.remainingMs = 10000;
    item.el = createToastNode(item);
    toastItems.push(item);
    toastLiveEl.insertBefore(item.el, toastLiveEl.firstChild);
    syncToastDom();
    return item.id;
  }

  /* Ctrl+Z / ⌘Z Undo newest toast when focus is not in a text field (or in just-cleared omnibox) */
  document.addEventListener('keydown', (e) => {
    if (e.shiftKey || e.altKey) return;
    const apple = isApplePlatform();
    const matchMod = apple ? (e.metaKey && !e.ctrlKey) : (e.ctrlKey && !e.metaKey);
    const k = (e.key || '').toLowerCase();
    if (!matchMod || k !== 'z') return;
    const undoable = toastItems.slice().reverse().find((t) => !!t.action);
    if (!undoable) return;

    const active = document.activeElement;
    if (active && (/^(INPUT|TEXTAREA)$/.test(active.tagName) || active.isContentEditable)) {
      const isClearedOmni = active.classList && active.classList.contains('omnibox-input') &&
        active.value === '' && active.dataset && active.dataset.justClearedBySave === '1';
      if (!isClearedOmni) return;
    }
    e.preventDefault();
    triggerToastUndo(undoable);
  });
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
    ensureToastStack();
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
      let prevLocked = state.locked;
      const syncVault = (syncOpts) => {
        syncOpts = syncOpts || {};
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
        if (!syncOpts.keepDraftForDemo && prevLocked !== state.locked) {
          omniboxInstances.forEach((inst) => {
            if (inst && typeof inst.onVaultStateChange === 'function') {
              inst.onVaultStateChange(state.locked, prevLocked);
            }
          });
        }
        prevLocked = state.locked;
      };
      window.SAK && (window.SAK._syncVault = syncVault);
      const toggle = () => { state.locked = !state.locked; syncVault(); };
      pills.forEach((b) => b.addEventListener('click', toggle));
      unlockBtns.forEach((b) => b.addEventListener('click', toggle));
      requestAnimationFrame(() => {
        if (window.SAK) window.SAK._syncVault = syncVault;
        syncVault();
      });
    }
    document.querySelectorAll('[data-sem-toggle]').forEach((btn) => {
      const sync = () => btn.setAttribute('aria-checked', String(state.semantic));
      sync();
      btn.addEventListener('click', () => {
        state.semantic = !state.semantic;
        sync();
        document.querySelectorAll('[data-omnibox]').forEach((r) => r._repaint && r._repaint());
        toast(state.semantic
          ? 'Đã bật tìm gần nghĩa · Semantic search enabled'
          : 'Đã tắt tìm gần nghĩa · Semantic search disabled');
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
          const own = v.parentElement && v.parentElement.closest('[data-seg-scope]');
          if ((own || document) !== scope) return;
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
        toast(btn.dataset.toast, btn.dataset.toastAction || null, {
          sub: btn.dataset.toastSub || null
        });
      });
    });
    document.querySelectorAll('[data-open-dup-picker]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const targetName = btn.dataset.openDupPicker || 'wifi';
        openDupDialog({ name: targetName });
      });
    });
  }

  window.SAK = {
    TAGS, ITEMS, search, parseQuickAdd, initOmnibox, openDupDialog,
    renderJsonTable, initChrome, toast, state, norm, normIdentity,
    undoShortcutLabel, isApplePlatform
  };
})();
