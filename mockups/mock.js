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
    { id: 't1', name: 'nhà', display: 'nhà', count: 24, last_used_at: '2026-10-28T10:00:00Z', touched: 12 },
    { id: 't2', name: 'office', display: 'office', count: 11, last_used_at: '2026-10-25T09:00:00Z', touched: 9 },
    { id: 't3', name: 'công-ty', display: 'công-ty', count: 8, last_used_at: '2026-10-20T08:00:00Z', touched: 7 },
    { id: 't4', name: 'ops', display: 'ops', count: 15, last_used_at: '2026-10-30T11:00:00Z', touched: 14 },
    { id: 't5', name: 'home-lab', display: 'home-lab', count: 6, last_used_at: '2026-10-18T14:00:00Z', touched: 6 },
    { id: 't6', name: 'okrs', display: 'okrs', count: 4, last_used_at: '2026-10-15T16:00:00Z', touched: 5 },
    { id: 't7', name: 'wifi-khách', display: 'wifi-khách', count: 4, last_used_at: '2026-10-22T12:00:00Z', touched: 8 },
    { id: 't8', name: 'nhà-bố-mẹ', display: 'nhà-bố-mẹ', count: 2, last_used_at: '2026-10-12T10:00:00Z', touched: 4 }
  ];

  const ITEMS = [
    {
      id: 'i1', name: 'wifi', hint: '', tags: ['nhà', 'office', 'home-lab', 'ops'],
      entries: 12, created_at: '12/03/2026', updated: '12/03/2026', last_used_at: '2026-10-29T09:00:00Z', touched: 9
    },
    {
      id: 'i2', name: 'wifi', hint: 'tầng 4 — SSID nội bộ', tags: ['công-ty', 'office'],
      entries: 3, created_at: '01/06/2026', updated: '01/06/2026', last_used_at: '2026-10-26T09:00:00Z', touched: 6
    },
    {
      id: 'i11', name: 'wifi', hint: 'nhà bố mẹ · cáp quang', tags: ['nhà', 'wifi-khách'],
      entries: 2, created_at: '14/01/2026', updated: '14/01/2026', last_used_at: '2026-10-25T09:00:00Z', touched: 5
    },
    {
      id: 'i12', name: 'wifi', hint: 'quán cà phê hay ngồi', tags: ['wifi-khách'],
      entries: 1, created_at: '08/11/2025', updated: '08/11/2025', last_used_at: '2026-10-23T09:00:00Z', touched: 3
    },
    {
      id: 'i3', name: 'wifi-office', hint: '', tags: ['office'],
      entries: 3, created_at: '28/05/2026', updated: '28/05/2026', last_used_at: '2026-10-24T09:00:00Z', touched: 4
    },
    {
      id: 'i13', name: 'wi-fi', hint: 'bộ phát dự phòng tầng 2', tags: ['nhà'],
      entries: 2, created_at: '19/08/2026', updated: '19/08/2026', last_used_at: '2026-10-21T09:00:00Z', touched: 3
    },
    {
      id: 'i4', name: 'mạng nhà', hint: 'router, VLAN, DNS', tags: ['nhà', 'home-lab'],
      entries: 7, created_at: '02/09/2026', updated: '02/09/2026', last_used_at: '2026-10-28T09:00:00Z', touched: 8
    },
    {
      id: 'i5', name: 'docker', hint: '', tags: ['ops', 'home-lab'],
      entries: 9, created_at: '10/09/2026', updated: '10/09/2026', last_used_at: '2026-10-31T09:00:00Z', touched: 12
    },
    {
      id: 'i6', name: 'k8s', hint: 'kubernetes cụm nhà', tags: ['ops', 'home-lab'],
      entries: 5, created_at: '30/08/2026', updated: '30/08/2026', last_used_at: '2026-10-25T08:00:00Z', touched: 5
    },
    {
      id: 'i7', name: 'meeting-mkt', hint: '', tags: ['okrs'],
      entries: 4, created_at: '11/09/2026', updated: '11/09/2026', last_used_at: '2026-10-27T09:00:00Z', touched: 7
    },
    {
      id: 'i8', name: 'api key openai', hint: '', tags: ['ops'],
      entries: 2, created_at: '19/07/2026', updated: '19/07/2026', last_used_at: '2026-10-22T09:00:00Z', touched: 3
    },
    {
      id: 'i9', name: 'hợp đồng thuê nhà', hint: '', tags: ['nhà'],
      entries: 6, created_at: '05/01/2026', updated: '05/01/2026', last_used_at: '2026-10-20T09:00:00Z', touched: 2
    },
    {
      id: 'i10', name: 'ngân hàng', hint: 'số tài khoản, chi nhánh', tags: [],
      entries: 3, created_at: '22/04/2026', updated: '22/04/2026', last_used_at: '2026-10-24T08:00:00Z', touched: 4
    }
  ];

  /* P05 plan mục 2.4 + packages/search-fixtures/quota.json (embedded constants, FS-26) */
  const SUGGEST_QUOTA = {
    limits: [5, 8, 12],
    default_limit: 8,
    mobile_limit: 5,
    table: [
      { scope: 'all',  limit: 5,  tag_max: 2, lex_max: 4, near_base: 1, near_max_cap: 2, recent_tag: 2, recent_item: 3 },
      { scope: 'all',  limit: 8,  tag_max: 3, lex_max: 6, near_base: 2, near_max_cap: 3, recent_tag: 3, recent_item: 5 },
      { scope: 'all',  limit: 12, tag_max: 4, lex_max: 9, near_base: 3, near_max_cap: 4, recent_tag: 4, recent_item: 8 },
      { scope: 'item', limit: 5,  tag_max: 0, lex_max: 4, near_base: 1, near_max_cap: 2, recent_tag: 0, recent_item: 5 },
      { scope: 'item', limit: 8,  tag_max: 0, lex_max: 6, near_base: 2, near_max_cap: 3, recent_tag: 0, recent_item: 8 },
      { scope: 'item', limit: 12, tag_max: 0, lex_max: 9, near_base: 3, near_max_cap: 4, recent_tag: 0, recent_item: 12 },
      { scope: 'tag',  limit: 5,  tag_max: 4, lex_max: 4, near_base: 1, near_max_cap: 2, recent_tag: 5, recent_item: 0 },
      { scope: 'tag',  limit: 8,  tag_max: 6, lex_max: 6, near_base: 2, near_max_cap: 3, recent_tag: 8, recent_item: 0 },
      { scope: 'tag',  limit: 12, tag_max: 9, lex_max: 9, near_base: 3, near_max_cap: 4, recent_tag: 12, recent_item: 0 }
    ],
    search: {
      limits: [20, 50],
      default_limit: 20,
      all_scope_first_page_tags_max: 5,
      first_page_near_max: 5
    }
  };

  /* Bản đồ "gần nghĩa" giả lập vector search. Thật ra là bge-m3 + pgvector;
     ở mockup chỉ cần cho thấy nhóm này nằm RIÊNG, dưới nhóm lexical. */
  const SEMANTIC = [
    { triggers: ['mat khau', 'password', 'pass', 'mk'], hits: [['i1', .86], ['i2', .82], ['i8', .74]] },
    { triggers: ['mang', 'internet', 'router', 'ssid', 'network'], hits: [['i4', .88], ['i1', .79], ['i6', .68]] },
    { triggers: ['wifi', 'wi-fi', 'wif'], hits: [['i4', .81], ['i6', .72]] },
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


  const state = {
    semantic: true,
    semanticAvailable: true,
    semanticExternal: true,
    locked: false
  };

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

  /* Nhánh tìm kiếm dành riêng cho hero demo của landing.html (opts.demo = true):
     giữ nguyên hành vi 100% như bản gốc để landing không đổi. */
  function searchDemo(q) {
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

  /* P05 mục 2.3 + 2.4:
     - Chỉ khớp name (bỏ hint khỏi lexical, OQ-4).
     - Tier: prefix đúng dấu (3) > prefix bỏ dấu (2) > fuzzy trigram (1, score >= 0.35 khi len(qn) >= 2).
     - Tie-break: tier DESC, score DESC, last_used_at DESC, count DESC, id ASC.
     - Quota theo (scope, limit, mode) từ SUGGEST_QUOTA (packages/search-fixtures/quota.json). */
  function trigramsOf(str) {
    const padded = '  ' + String(str || '') + ' ';
    const set = new Set();
    for (let i = 0; i <= padded.length - 3; i++) {
      set.add(padded.slice(i, i + 3));
    }
    return set;
  }

  function trigramSim(a, b) {
    if (!a || !b) return 0;
    if (a === b) return 1;
    const ta = trigramsOf(a);
    const tb = trigramsOf(b);
    let inter = 0;
    ta.forEach((g) => { if (tb.has(g)) inter++; });
    const union = ta.size + tb.size - inter;
    return union > 0 ? Math.round((inter / union) * 100) / 100 : 0;
  }

  function wordTrigramSim(qa, targetUnaccent) {
    const words = String(targetUnaccent || '').split(/[\s-]+/).filter(Boolean);
    let best = trigramSim(qa, targetUnaccent);
    for (let i = 0; i < words.length; i++) {
      const s = trigramSim(qa, words[i]);
      if (s > best) best = s;
    }
    const compactTarget = String(targetUnaccent || '').replace(/[\s-]+/g, '');
    const compactQa = String(qa || '').replace(/[\s-]+/g, '');
    if (compactTarget && compactQa) {
      const cs = trigramSim(compactQa, compactTarget);
      if (cs > best) best = cs;
    }
    return Math.round(best * 100) / 100;
  }

  function getQuotaRow(scope, limit) {
    const sc = (scope === 'item' || scope === 'tag') ? scope : 'all';
    const lim = SUGGEST_QUOTA.limits.includes(limit) ? limit : SUGGEST_QUOTA.default_limit;
    return SUGGEST_QUOTA.table.find((r) => r.scope === sc && r.limit === lim) || SUGGEST_QUOTA.table[1];
  }

  function scoreLexicalCandidate(rawText, qn, qa, allowFuzzy) {
    const normText = normIdentity(rawText);
    const unaccentText = norm(rawText);
    const sim = wordTrigramSim(qa, unaccentText);
    if (normText.startsWith(qn)) {
      return { tier: 3, score: sim, match: 'prefix' };
    }
    if (unaccentText.startsWith(qa)) {
      return { tier: 2, score: sim, match: 'prefix_folded' };
    }
    if (allowFuzzy && sim >= 0.35) {
      return { tier: 1, score: sim, match: 'fuzzy' };
    }
    return null;
  }

  function compareLexicalRows(a, b) {
    if (b.tier !== a.tier) return b.tier - a.tier;
    if (b.score !== a.score) return b.score - a.score;
    const lua = String(a.last_used_at || '');
    const lub = String(b.last_used_at || '');
    if (lub !== lua) return lub.localeCompare(lua);
    const ca = a.count != null ? a.count : (a.entry_count != null ? a.entry_count : (a.entries || 0));
    const cb = b.count != null ? b.count : (b.entry_count != null ? b.entry_count : (b.entries || 0));
    if (cb !== ca) return cb - ca;
    return String(a.id || a.name).localeCompare(String(b.id || b.name));
  }

  function compareRecentRows(a, b) {
    const lua = String(a.last_used_at || '');
    const lub = String(b.last_used_at || '');
    if (lub !== lua) return lub.localeCompare(lua);
    return String(b.id || b.name).localeCompare(String(a.id || a.name));
  }

  function search(q, opts) {
    opts = opts || {};
    const rawStr = String(q == null ? '' : q);
    const trimmedStart = rawStr.replace(/^\s+/, '');
    let scope = opts.scope || 'all';
    let queryText = trimmedStart;
    if (trimmedStart.startsWith('#')) {
      scope = 'tag';
      queryText = trimmedStart.slice(1).split(/[\s:：]/)[0] || '';
    }
    const limit = opts.limit || SUGGEST_QUOTA.default_limit;
    const qRule = getQuotaRow(scope, limit);
    const qn = normIdentity(queryText);
    const qa = norm(queryText);
    const isEmptyInput = trimmedStart.trim().length === 0;

    if (isEmptyInput && scope !== 'tag') {
      const recTags = scope === 'item' ? [] : TAGS.slice().sort(compareRecentRows).slice(0, qRule.recent_tag).map((t) => ({
        ...t,
        kind: 'tag',
        display: t.display || t.name,
        item_count: t.count,
        match: 'prefix'
      }));
      const recItems = scope === 'tag' ? [] : ITEMS.slice().sort(compareRecentRows).slice(0, limit - recTags.length).map((it) => ({
        ...it,
        kind: 'item',
        entry_count: it.entries,
        match: 'prefix'
      }));
      return {
        scope,
        limit,
        mode: 'recent',
        recent: true,
        query: '',
        qn: '',
        quota: { tag: qRule.recent_tag, lexical: limit, near: 0 },
        tags: recTags,
        items: recItems,
        near: [],
        semantic: [],
        semantic_ran: false,
        semantic_reason: 'short_query'
      };
    }

    if (!qn) {
      if (scope === 'tag' && isEmptyInput) {
        const recTags = TAGS.slice().sort(compareRecentRows).slice(0, qRule.recent_tag).map((t) => ({
          ...t,
          kind: 'tag',
          display: t.display || t.name,
          item_count: t.count,
          match: 'prefix'
        }));
        return {
          scope: 'tag',
          limit,
          mode: 'recent',
          recent: true,
          query: '',
          qn: '',
          quota: { tag: limit, lexical: limit, near: 0 },
          tags: recTags,
          items: [],
          near: [],
          semantic: [],
          semantic_ran: false,
          semantic_reason: 'request_lexical'
        };
      }
      return {
        scope,
        limit,
        mode: 'prefix',
        recent: false,
        query: queryText,
        qn: '',
        quota: { tag: qRule.tag_max, lexical: qRule.lex_max, near: qRule.near_max_cap },
        tags: [],
        items: [],
        near: [],
        semantic: [],
        semantic_ran: false,
        semantic_reason: 'short_query'
      };
    }

    const rLen = runeLen(qn);
    const mode = rLen < 2 ? 'prefix' : 'full';
    const allowFuzzy = mode === 'full';

    const tagHits = scope === 'item' ? [] : TAGS
      .map((t) => {
        const sc = scoreLexicalCandidate(t.display || t.name, qn, qa, allowFuzzy);
        if (!sc) return null;
        return {
          ...t,
          kind: 'tag',
          display: t.display || t.name,
          item_count: t.count,
          tier: sc.tier,
          score: sc.score,
          match: sc.match
        };
      })
      .filter(Boolean)
      .sort(compareLexicalRows);

    const itemHits = scope === 'tag' ? [] : ITEMS
      .map((it) => {
        /* OQ-4: lexical chỉ khớp item.name, KHÔNG khớp hint */
        const sc = scoreLexicalCandidate(it.name, qn, qa, allowFuzzy);
        if (!sc) return null;
        return {
          ...it,
          kind: 'item',
          entry_count: it.entries,
          tier: sc.tier,
          score: sc.score,
          match: sc.match
        };
      })
      .filter(Boolean)
      .sort(compareLexicalRows);

    const tagsUsedCount = Math.min(tagHits.length, Math.max(qRule.tag_max, qRule.lex_max - itemHits.length));
    const itemsUsedCount = Math.min(itemHits.length, qRule.lex_max - tagsUsedCount);
    const tagsOut = tagHits.slice(0, tagsUsedCount);
    const itemsOut = itemHits.slice(0, itemsUsedCount);

    const effectiveNearQuota = Math.min(
      qRule.near_max_cap,
      qRule.near_base + Math.max(0, qRule.lex_max - tagsUsedCount - itemsUsedCount)
    );

    const wantSemantic = opts.semantic != null ? !!opts.semantic : (state.semanticAvailable && state.semantic && scope !== 'tag' && rLen >= 3);
    let nearOut = [];
    let semReason = null;
    if (!state.semanticAvailable) {
      semReason = 'disabled_server';
    } else if (!state.semantic) {
      semReason = 'disabled_user';
    } else if (scope === 'tag' || opts.semantic === false) {
      semReason = 'request_lexical';
    } else if (rLen < 3) {
      semReason = 'short_query';
    } else if (wantSemantic) {
      const seenItemIds = new Set(itemsOut.map((i) => i.id));
      const acc = new Map();
      SEMANTIC.forEach((g) => {
        const match = g.triggers.some((t) => t === qa || t.startsWith(qa) || qa.startsWith(t));
        if (!match) return;
        g.hits.forEach(([id, cos]) => {
          if (seenItemIds.has(id)) return;
          if (!acc.has(id) || acc.get(id) < cos) acc.set(id, cos);
        });
      });
      const nearCap = Math.min(effectiveNearQuota, limit - tagsOut.length - itemsOut.length);
      nearOut = [...acc.entries()]
        .map(([id, cos]) => {
          const found = ITEMS.find((i) => i.id === id);
          if (!found) return null;
          return {
            ...found,
            kind: 'item',
            entry_count: found.entries,
            match: 'semantic',
            score: cos
          };
        })
        .filter(Boolean)
        .sort((a, b) => (b.score - a.score) || compareLexicalRows(a, b))
        .slice(0, nearCap);
    }

    return {
      scope,
      limit,
      mode,
      recent: false,
      query: queryText,
      qn,
      quota: {
        tag: qRule.tag_max,
        lexical: qRule.lex_max,
        near: effectiveNearQuota
      },
      tags: tagsOut,
      items: itemsOut,
      near: nearOut,
      semantic: nearOut,
      semantic_ran: semReason === null,
      semantic_reason: semReason
    };
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

  /* ---------- P04 & P05 omnibox (SPEC §3.4–§3.5, §6.8, §7.2, plan mục 2.1, 2.3–2.6, 2.8–2.10, 2.24) ---------- */
  /* Intended i18n keys (Task 17/18):
     - search.help.sentToServer
     - search.help.sentToServerExternal
     - search.help.enterToSearch
     - search.group.tags ("Tags")
     - search.group.items ("Items")
     - search.group.near ("Gần nghĩa" / "Similar meaning")
     - search.group.recentItems ("Gần đây" / "Recent")
     - search.group.recentTags ("Tag hay dùng" / "Frequent tags")
     - search.group.actions ("Thao tác" / "Actions")
     - search.match.fuzzy ("gần đúng" / "fuzzy")
     - search.match.semantic ("≈ gần nghĩa" / "≈ similar meaning")
     - search.state.nearPending ("Đang tìm gần nghĩa…" / "Searching similar meaning…")
     - search.state.degraded ("Gần nghĩa đang tạm nghỉ — tìm theo tên vẫn chạy" / "Similar-meaning search is temporarily paused — name search still works")
     - search.state.enable409 ("Không bật được tìm theo nghĩa" / "Could not enable similar-meaning search")
     - search.state.rateLimited ("Đang gửi hơi nhanh, thử lại sau {seconds} giây" / "Sending too fast, try again in {seconds}s")
     - search.state.noMatch ("Không khớp “{query}”" / "No match for “{query}”")
     - search.actions.createItem ("Tạo mục “{query}”" / "Create item “{query}”")
     - search.actions.loadMore ("Xem thêm" / "Show more")
     - search.tab.cannotFill ("Không điền được bằng Tab" / "Cannot fill with Tab")
  */

  const COPY_SEARCH_HINT_VI = 'Enter: tìm theo đầu tên · Ctrl+Enter: tạo mục tên này — chữ đã gõ gửi tới máy chủ, không mã hoá. Để lưu nội dung, gõ ';
  const COPY_SEARCH_HINT_EN = 'Enter: search by name prefix · Ctrl+Enter: create item with this name — typed text is sent to the server unencrypted. To save content, type ';
  const COPY_SENT_TO_SERVER_VI = 'Chữ gõ để tìm được gửi tới máy chủ, không mã hoá; lưu nội dung thì gõ ';
  const COPY_SENT_TO_SERVER_EN = 'Text you type to search is sent to the server, not encrypted. To save content, type ';
  const COPY_SENT_TO_SERVER_EXT_VI = 'Chữ gõ để tìm được gửi tới máy chủ và tới dịch vụ nhúng bên ngoài khi bật ≈, không mã hoá; lưu nội dung thì gõ ';
  const COPY_SENT_TO_SERVER_EXT_EN = 'Text you type to search is sent to the server, and to an external embedding service when ≈ is on, not encrypted. To save content, type ';
  const COPY_ENTER_TO_SEARCH_VI = 'Nhấn Enter để tìm; chữ gõ được gửi tới máy chủ, không mã hoá.';
  const COPY_ENTER_TO_SEARCH_EN = 'Press Enter to search; the text is sent to the server, not encrypted.';
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
      const res = searchDemo(input.value);
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

    input.removeAttribute('role');
    input.removeAttribute('aria-expanded');
    input.removeAttribute('aria-autocomplete');
    input.removeAttribute('aria-controls');
    input.setAttribute('data-vault-secret', '');
    input.setAttribute('spellcheck', 'false');
    input.setAttribute('autocomplete', 'off');
    input.setAttribute('autocorrect', 'off');
    input.setAttribute('autocapitalize', 'off');

    let semToggleBtn = shell.querySelector('[data-omni-sem-toggle]');
    if (!semToggleBtn) {
      semToggleBtn = document.createElement('button');
      semToggleBtn.type = 'button';
      semToggleBtn.className = 'omni-sem-btn';
      semToggleBtn.dataset.omniSemToggle = '1';
      const kbdEl = shell.querySelector('.kbd');
      if (kbdEl) {
        shell.insertBefore(semToggleBtn, kbdEl);
      } else {
        shell.appendChild(semToggleBtn);
      }
    }

    function syncSemToggleBtn() {
      if (!semToggleBtn) return;
      if (!state.semanticAvailable) {
        semToggleBtn.hidden = true;
        return;
      }
      semToggleBtn.hidden = false;
      const isOn = !!state.semantic;
      semToggleBtn.setAttribute('aria-pressed', String(isOn));
      semToggleBtn.setAttribute('aria-label', 'Tìm gần nghĩa');
      semToggleBtn.innerHTML = '<span aria-hidden="true">≈</span>';
    }
    syncSemToggleBtn();

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
    let activeKey = null;
    let activeIdx = -1;
    let activePlan = null;
    let pinnedItem = null;
    let tabCannotFillMsg = false;
    let hadDraftOnLock = false;
    let hadCommittedMetaOnLock = false;
    let showPostUnlockNotice = false;

    /* Send-gate state (SPEC §3.5, plan mục 2.1 + 2.24) */
    let gateTainted = false;
    let gateColonLocked = false;
    let isComposing = false;
    let prevValue = '';
    let lastInputType = 'insertText';
    let lastInputData = '';
    let legacyHintMode = false;

    let lastErrorAlertSig = '';
    let lastFailAlertSig = '';
    let planStepTimers = [];
    let suggestTimers = [];

    function clearPlanTimers() {
      planStepTimers.forEach((tid) => clearTimeout(tid));
      planStepTimers = [];
    }

    function clearSuggestTimers() {
      suggestTimers.forEach((tid) => clearTimeout(tid));
      suggestTimers = [];
    }

    function countGraphemes(str) {
      const s = String(str || '');
      if (typeof Intl !== 'undefined' && Intl.Segmenter) {
        const seg = new Intl.Segmenter('vi', { granularity: 'grapheme' });
        let n = 0;
        for (const _ of seg.segment(s)) n++;
        return n;
      }
      return Array.from(s).length;
    }

    function hasAnyColon(str) {
      const s = String(str || '');
      return s.includes(':') || s.includes('：');
    }

    function setDraft(val, writeOpts) {
      writeOpts = writeOpts || {};
      const v = String(val == null ? '' : val);
      input.value = v;
      prevValue = v;
      if (v === '') {
        gateTainted = false;
        gateColonLocked = false;
        pinnedItem = null;
      } else {
        if (hasAnyColon(v)) {
          gateColonLocked = true;
        }
        const p = parseQuickAdd(v);
        if (p.mode === 'add' || p.mode === 'add-invalid') {
          gateColonLocked = true;
        }
        if (writeOpts.tainted != null) {
          gateTainted = !!writeOpts.tainted;
        }
      }
      syncTextareaHeight();
    }

    function isGateClean(val) {
      const v = String(val == null ? input.value : val);
      if (gateTainted || gateColonLocked || hasAnyColon(v)) return false;
      const lines = v.replace(/\r\n?/g, '\n').split('\n');
      if (lines.length > 1) return false;
      const trimmed = v.trim();
      if (trimmed.startsWith('#')) {
        const tok = trimmed.slice(1).split(/[\s:：]/)[0] || '';
        return runeLen(tok) <= 50;
      }
      return runeLen(trimmed) <= 200;
    }

    function syncTextareaHeight() {
      if (input.tagName !== 'TEXTAREA') return;
      if (!input.value) {
        input.style.height = '';
        input.style.overflowY = 'hidden';
        return;
      }
      input.style.height = 'auto';
      const sh = input.scrollHeight;
      if (sh > 0) {
        const cap = 132;
        input.style.height = Math.min(sh, cap) + 'px';
        input.style.overflowY = sh > cap ? 'auto' : 'hidden';
      }
    }

    function setLiveText(text) {
      if (liveEl) liveEl.textContent = text || '';
    }

    function closeListbox(clearLive) {
      clearSuggestTimers();
      listOpen = false;
      listKind = null;
      listOptions = [];
      activeKey = null;
      activeIdx = -1;
      pop.hidden = true;
      pop.innerHTML = '';
      input.removeAttribute('aria-controls');
      input.removeAttribute('aria-activedescendant');
      if (clearLive) setLiveText('');
    }

    function rebuildListOptionsFromDom() {
      const lb = pop.querySelector('#' + listboxId) || pop;
      const optEls = Array.from(lb.querySelectorAll('[role="option"]'));
      listOptions = optEls.map((el, idx) => {
        el.dataset.optIdx = String(idx);
        const key = el.dataset.optKey || el.id || String(idx);
        const kind = el.dataset.optKind || 'item';
        const itemId = el.dataset.itemId || '';
        const tagName = el.dataset.tagName || '';
        const q = el.dataset.optQuery || '';
        const itemObj = itemId ? (ITEMS.find((i) => i.id === itemId) || { id: itemId, name: el.dataset.itemName || itemId, tags: [] }) : null;
        const tagObj = tagName ? (TAGS.find((t) => (t.display || t.name) === tagName) || { name: tagName, display: tagName, count: 0 }) : null;
        return {
          id: el.id,
          key,
          kind,
          item: itemObj,
          tag: tagObj,
          query: q,
          el
        };
      });
      if (activeKey) {
        const foundIdx = listOptions.findIndex((o) => o.key === activeKey);
        activeIdx = foundIdx >= 0 ? foundIdx : -1;
        if (activeIdx < 0) activeKey = null;
      } else if (activeIdx >= 0 && listOptions[activeIdx]) {
        activeKey = listOptions[activeIdx].key;
      } else {
        activeIdx = -1;
      }
    }

    function syncActiveOption() {
      const lb = pop.querySelector('#' + listboxId) || pop;
      const optEls = lb.querySelectorAll('[role="option"]');
      if (activeKey) {
        const idxByKey = listOptions.findIndex((o) => o.key === activeKey);
        if (idxByKey >= 0) activeIdx = idxByKey;
      }
      optEls.forEach((el, idx) => {
        const isSel = idx === activeIdx;
        el.setAttribute('aria-selected', String(isSel));
        if (isSel) {
          el.scrollIntoView({ block: 'nearest' });
        }
      });
      if (listOpen && activeIdx >= 0 && optEls[activeIdx] && optEls[activeIdx].id) {
        activeKey = listOptions[activeIdx] ? listOptions[activeIdx].key : activeKey;
        input.setAttribute('aria-activedescendant', optEls[activeIdx].id);
      } else {
        input.removeAttribute('aria-activedescendant');
      }
    }

    function formatItemRowHtml(it, query, optId, optKey, dupNameSet) {
      const shownTags = (it.tags || []).slice(0, 3);
      const extra = (it.tags || []).length > 3 ? (it.tags.length - 3) : 0;
      const count = it.entry_count != null ? it.entry_count : (it.entries != null ? it.entries : 0);
      const matchKind = it.match || 'prefix';
      let titleHtml = esc(it.name);
      if (query && matchKind === 'prefix') {
        titleHtml = markPrefixExact(it.name, query);
      } else if (query && matchKind === 'prefix_folded') {
        titleHtml = markPrefix(it.name, query);
      }
      const isDup = dupNameSet && dupNameSet.has(normIdentity(it.name));
      const dateMeta = (isDup && it.created_at) ? ` · ${esc(it.created_at)}` : '';
      let badgeHtml = '';
      if (matchKind === 'fuzzy') {
        badgeHtml = ' <span class="sugg-match-badge" data-i18n-key="search.match.fuzzy">gần đúng</span>';
      } else if (matchKind === 'semantic') {
        badgeHtml = ' <span class="sugg-near-badge" data-i18n-key="search.match.semantic">≈ gần nghĩa</span>';
      }
      return `<div role="option" id="${optId}" data-opt-key="${esc(optKey)}" data-opt-kind="item" data-item-id="${esc(it.id)}" data-item-name="${esc(it.name)}" aria-selected="false" class="sugg-row">
        <span class="omni-opt-main">
          <span class="omni-opt-title">${titleHtml}</span>
          ${shownTags.map((t) => `<span class="chip dup-chip" title="#${esc(t)}">#${esc(t)}</span>`).join('')}
          ${extra > 0 ? `<span class="mono text-[12px] text-muted" aria-hidden="true">+${extra}</span><span class="sr-only">Còn ${extra} tag nữa</span>` : ''}
        </span>
        <span class="sugg-meta mono">${count} entries${dateMeta}${badgeHtml}</span>
      </div>`;
    }

    function formatTagRowHtml(t, query, optId, optKey) {
      const disp = t.display || t.name;
      const count = t.item_count != null ? t.item_count : (t.count || 0);
      const matchKind = t.match || 'prefix';
      let labelHtml = esc(disp);
      if (query && matchKind === 'prefix') {
        labelHtml = markPrefixExact(disp, query);
      } else if (query && matchKind === 'prefix_folded') {
        labelHtml = markPrefix(disp, query);
      }
      const fuzzyBadge = matchKind === 'fuzzy'
        ? ' <span class="sugg-match-badge" data-i18n-key="search.match.fuzzy">gần đúng</span>'
        : '';
      return `<div role="option" id="${optId}" data-opt-key="${esc(optKey)}" data-opt-kind="tag" data-tag-name="${esc(disp)}" aria-selected="false" class="sugg-row">
        <span class="mono text-accent">#</span>
        <span class="omni-opt-title">${labelHtml}</span>
        <span class="sugg-meta mono">${count} mục${fuzzyBadge}</span>
      </div>`;
    }

    function computeDupNames(itemsArr, nearArr) {
      const counts = new Map();
      (itemsArr || []).concat(nearArr || []).forEach((it) => {
        const k = normIdentity(it.name);
        counts.set(k, (counts.get(k) || 0) + 1);
      });
      const dupSet = new Set();
      counts.forEach((c, k) => { if (c > 1) dupSet.add(k); });
      return dupSet;
    }

    /* Render P05 suggest dropdown (mục 2.8 quy tắc 5 + mục 2.24 item 3):
       - Một role="listbox" duy nhất (#omni-listbox).
       - Mỗi vùng là role="group" với aria-labelledby trỏ heading của vùng:
         * Recent: Gần đây (Items) -> Tag hay dùng (Tags)
         * Typing: Tags -> Items -> Gần nghĩa -> Thao tác (search.group.actions, luôn là group cuối)
       - Dòng trạng thái hiển thị (near pending, degraded, 409, 429) nằm NGOÀI listbox và NGOÀI live region, không role="status"/aria-live. */
    function renderSuggestDropdown(res, viewOpts) {
      viewOpts = viewOpts || {};
      listOpen = true;
      listKind = 'suggest';
      const prevKey = viewOpts.keepActiveKey !== false ? activeKey : null;

      const isRecent = !!res.recent;
      const tags = res.tags || [];
      const items = res.items || [];
      const near = (viewOpts.hideNear || !state.semantic || !state.semanticAvailable) ? [] : (res.near || []);
      const dupSet = computeDupNames(items, near);
      const q = res.query || '';

      const grpTagsHdrId = `${baseId}-grp-tags-hdr`;
      const grpItemsHdrId = `${baseId}-grp-items-hdr`;
      const grpNearHdrId = `${baseId}-grp-near-hdr`;
      const grpActHdrId = `${baseId}-grp-actions-hdr`;

      let groupsHtml = '';

      if (isRecent) {
        if (items.length > 0) {
          const rowsHtml = items.map((it) => {
            const key = `item:${it.id}`;
            const optId = `${baseId}-opt-item-${esc(it.id)}`;
            return formatItemRowHtml(it, '', optId, key, dupSet);
          }).join('');
          groupsHtml += `<div role="group" aria-labelledby="${grpItemsHdrId}" class="sugg-zone" data-zone="items">
            <div id="${grpItemsHdrId}" class="sugg-group" role="presentation" data-i18n-key="search.group.recentItems">Gần đây</div>
            ${rowsHtml}
          </div>`;
        }
        if (tags.length > 0) {
          const rowsHtml = tags.map((t) => {
            const disp = t.display || t.name;
            const key = `tag:${t.id || disp}`;
            const optId = `${baseId}-opt-tag-${esc(t.id || disp)}`;
            return formatTagRowHtml(t, '', optId, key);
          }).join('');
          groupsHtml += `<div role="group" aria-labelledby="${grpTagsHdrId}" class="sugg-zone" data-zone="tags">
            <div id="${grpTagsHdrId}" class="sugg-group" role="presentation" data-i18n-key="search.group.recentTags">Tag hay dùng</div>
            ${rowsHtml}
          </div>`;
        }
      } else {
        if (tags.length > 0) {
          const rowsHtml = tags.map((t) => {
            const disp = t.display || t.name;
            const key = `tag:${t.id || disp}`;
            const optId = `${baseId}-opt-tag-${esc(t.id || disp)}`;
            return formatTagRowHtml(t, q, optId, key);
          }).join('');
          groupsHtml += `<div role="group" aria-labelledby="${grpTagsHdrId}" class="sugg-zone" data-zone="tags">
            <div id="${grpTagsHdrId}" class="sugg-group" role="presentation" data-i18n-key="search.group.tags">Tags</div>
            ${rowsHtml}
          </div>`;
        }
        if (items.length > 0) {
          const rowsHtml = items.map((it) => {
            const key = `item:${it.id}`;
            const optId = `${baseId}-opt-item-${esc(it.id)}`;
            return formatItemRowHtml(it, q, optId, key, dupSet);
          }).join('');
          groupsHtml += `<div role="group" aria-labelledby="${grpItemsHdrId}" class="sugg-zone" data-zone="items">
            <div id="${grpItemsHdrId}" class="sugg-group" role="presentation" data-i18n-key="search.group.items">Items</div>
            ${rowsHtml}
          </div>`;
        }
        if (near.length > 0) {
          const rowsHtml = near.map((it) => {
            const key = `item:${it.id}`;
            const optId = `${baseId}-opt-near-${esc(it.id)}`;
            return formatItemRowHtml({ ...it, match: 'semantic' }, '', optId, key, dupSet);
          }).join('');
          groupsHtml += `<div role="group" aria-labelledby="${grpNearHdrId}" class="sugg-zone" data-zone="near">
            <div id="${grpNearHdrId}" class="sugg-group" role="presentation" data-i18n-key="search.group.near">Gần nghĩa</div>
            ${rowsHtml}
          </div>`;
        }
      }

      let emptyOutsideHtml = '';
      const totalHits = tags.length + items.length + near.length;
      if (!isRecent && totalHits === 0 && q) {
        emptyOutsideHtml = `<div class="omni-empty-box" id="${baseId}-suggest-empty-note" data-i18n-key="search.state.noMatch">
          <p class="text-[14px] font-semibold text-body m-0 mb-0.5">Không khớp “${esc(q)}”</p>
          <p class="text-[12px] text-muted m-0">Gõ <span class="mono">${esc(q)}: nội dung</span> để lưu ngay hoặc tạo mục rỗng bên dưới.</p>
        </div>`;
      }

      /* Group cuối riêng cho CTA (mục 2.8 quy tắc 5 + mục 2.24 item 3: search.group.actions) */
      if (!isRecent && q && res.scope !== 'tag') {
        const createId = `${baseId}-opt-create`;
        const createKey = `action:create:${q}`;
        groupsHtml += `<div role="group" aria-labelledby="${grpActHdrId}" class="sugg-zone sugg-zone-actions" data-zone="actions">
          <div id="${grpActHdrId}" class="sugg-group" role="presentation" data-i18n-key="search.group.actions">Thao tác</div>
          <div role="option" id="${createId}" data-opt-key="${esc(createKey)}" data-opt-kind="create" data-opt-query="${esc(q)}" aria-selected="false" class="sugg-row omni-create-option">
            <span class="mono text-accent">＋</span>
            <span data-i18n-key="search.actions.createItem"><strong>Tạo mục “${esc(q)}”</strong></span>
            <span class="sugg-meta"><span class="kbd">Ctrl+Enter</span></span>
          </div>
        </div>`;
      }

      let statusOutsideHtml = '';
      if (viewOpts.nearPending) {
        statusOutsideHtml += `<div class="sugg-status-line" data-omni-status="near-pending" data-i18n-key="search.state.nearPending">
          <span>Đang tìm gần nghĩa…</span>
        </div>`;
      }
      if (viewOpts.degraded) {
        statusOutsideHtml += `<div class="sugg-status-line" data-omni-status="degraded" data-i18n-key="search.state.degraded">
          <span>Gần nghĩa đang tạm nghỉ — tìm theo tên vẫn chạy</span>
        </div>`;
      }
      if (viewOpts.enable409) {
        statusOutsideHtml += `<div class="sugg-status-line" data-omni-status="enable-409" data-i18n-key="search.state.enable409">
          <span>Không bật được tìm theo nghĩa</span>
        </div>`;
      }
      if (viewOpts.rateLimited) {
        statusOutsideHtml += `<div class="sugg-status-line" data-omni-status="rate-limited" data-i18n-key="search.state.rateLimited">
          <span>Đang gửi hơi nhanh, thử lại sau 2 giây</span>
        </div>`;
      }

      pop.innerHTML = `${emptyOutsideHtml}<div role="listbox" id="${listboxId}" class="omni-listbox" aria-label="Gợi ý tìm kiếm">${groupsHtml}</div>${statusOutsideHtml}`;
      pop.hidden = false;
      input.setAttribute('aria-controls', listboxId);

      activeKey = prevKey;
      rebuildListOptionsFromDom();
      if (viewOpts.initialActiveKey) {
        activeKey = viewOpts.initialActiveKey;
        rebuildListOptionsFromDom();
      } else if (res.scope === 'tag' && !activeKey && listOptions.length > 0) {
        activeKey = listOptions[0].key;
        activeIdx = 0;
      }
      syncActiveOption();

      if (viewOpts.liveAnnouncement != null) {
        setLiveText(viewOpts.liveAnnouncement);
      } else if (!isRecent && totalHits === 0 && q) {
        setLiveText(`Không khớp “${q}”`);
      } else {
        setLiveText(`${totalHits} gợi ý`);
      }
    }

    /* Append vùng Gần nghĩa muộn mà KHÔNG re-render hay thay thế DOM node của các hàng lexical
       (giữ nguyên cùng element reference và activeKey — mục 2.8 quy tắc 3). */
    function appendNearZoneInPlace(nearRows, query) {
      const lb = pop.querySelector('#' + listboxId);
      if (!lb || !listOpen) return;
      const pendEl = pop.querySelector('[data-omni-status="near-pending"]');
      if (pendEl) pendEl.remove();

      const existingNearZone = lb.querySelector('[data-zone="near"]');
      if (existingNearZone) existingNearZone.remove();

      if (!nearRows || !nearRows.length || !state.semantic || !state.semanticAvailable) {
        rebuildListOptionsFromDom();
        syncActiveOption();
        return;
      }

      const existingIds = new Set(
        Array.from(lb.querySelectorAll('[data-zone="items"] [role="option"]')).map((el) => el.dataset.itemId)
      );
      const filteredNear = nearRows.filter((it) => !existingIds.has(it.id));
      if (!filteredNear.length) {
        rebuildListOptionsFromDom();
        syncActiveOption();
        return;
      }

      const grpNearHdrId = `${baseId}-grp-near-hdr`;
      const nearZone = document.createElement('div');
      nearZone.setAttribute('role', 'group');
      nearZone.setAttribute('aria-labelledby', grpNearHdrId);
      nearZone.className = 'sugg-zone sugg-zone-near-append';
      nearZone.dataset.zone = 'near';

      const dupSet = computeDupNames([], filteredNear);
      const rowsHtml = filteredNear.map((it) => {
        const key = `item:${it.id}`;
        const optId = `${baseId}-opt-near-${esc(it.id)}`;
        return formatItemRowHtml({ ...it, match: 'semantic' }, query || '', optId, key, dupSet);
      }).join('');

      nearZone.innerHTML = `<div id="${grpNearHdrId}" class="sugg-group" role="presentation" data-i18n-key="search.group.near">Gần nghĩa</div>${rowsHtml}`;

      /* Chèn trước nhóm cuối (search.group.actions) để actions luôn là con cuối của listbox */
      const actionsZone = lb.querySelector('[data-zone="actions"]');
      if (actionsZone) {
        lb.insertBefore(nearZone, actionsZone);
      } else {
        lb.appendChild(nearZone);
      }

      rebuildListOptionsFromDom();
      syncActiveOption();
      setLiveText(`Thêm ${filteredNear.length} gợi ý gần nghĩa`);
    }

    function removeNearZoneInPlace() {
      const lb = pop.querySelector('#' + listboxId);
      if (!lb || !listOpen) return;
      const nearZone = lb.querySelector('[data-zone="near"]');
      const wasActiveInNear = !!(nearZone && activeKey && nearZone.querySelector(`[data-opt-key="${CSS.escape ? CSS.escape(activeKey) : activeKey}"]`));
      if (nearZone) nearZone.remove();
      const pendEl = pop.querySelector('[data-omni-status="near-pending"]');
      if (pendEl) pendEl.remove();
      if (wasActiveInNear) {
        activeKey = null;
        activeIdx = -1;
      }
      rebuildListOptionsFromDom();
      syncActiveOption();
      setLiveText('Đã ẩn gợi ý gần nghĩa');
    }

    function renderSearchListbox(query, items, searchOpts) {
      searchOpts = searchOpts || {};
      listOpen = true;
      listKind = 'search';
      listOptions = [];
      activeKey = null;
      activeIdx = -1;

      const grpItemsHdrId = `${baseId}-grp-search-items-hdr`;
      const grpActHdrId = `${baseId}-grp-search-actions-hdr`;
      const dupSet = computeDupNames(items, []);

      let topStatusHtml = '';
      let groupsHtml = '';
      if (items.length > 0) {
        topStatusHtml = `<div class="sugg-status-line sugg-status-line-top" data-omni-status="search-count">${items.length} kết quả</div>`;
        const rowsHtml = items.map((it, idx) => {
          const optId = `${baseId}-opt-item-${esc(it.id)}-${idx}`;
          const optKey = `item:${it.id}`;
          return formatItemRowHtml(it, query, optId, optKey, dupSet);
        }).join('');
        groupsHtml += `<div role="group" aria-labelledby="${grpItemsHdrId}" class="sugg-zone" data-zone="items">
          <div id="${grpItemsHdrId}" class="sugg-group" role="presentation" data-i18n-key="search.group.items">Items</div>
          ${rowsHtml}
        </div>`;

        const createOptId = `${baseId}-opt-create`;
        const createKey = `action:create:${query}`;
        let moreOptHtml = '';
        if (searchOpts.hasMore) {
          const moreOptId = `${baseId}-opt-more`;
          moreOptHtml = `<div role="option" id="${moreOptId}" data-opt-key="action:more" data-opt-kind="more" data-opt-query="${esc(query)}" aria-selected="false" class="sugg-row">
            <span class="mono text-accent">↓</span>
            <span data-i18n-key="search.actions.loadMore"><strong>Xem thêm</strong></span>
            <span class="sugg-meta"><span class="kbd">Enter</span></span>
          </div>`;
        }
        groupsHtml += `<div role="group" aria-labelledby="${grpActHdrId}" class="sugg-zone sugg-zone-actions" data-zone="actions">
          <div id="${grpActHdrId}" class="sugg-group" role="presentation" data-i18n-key="search.group.actions">Thao tác</div>
          ${moreOptHtml}
          <div role="option" id="${createOptId}" data-opt-key="${esc(createKey)}" data-opt-kind="create" data-opt-query="${esc(query)}" aria-selected="false" class="sugg-row omni-create-option">
            <span class="mono text-accent">＋</span>
            <span data-i18n-key="search.actions.createItem"><strong>Tạo mục “${esc(query)}”</strong></span>
            <span class="sugg-meta"><span class="kbd">Ctrl+Enter</span></span>
          </div>
        </div>`;
        setLiveText(`${items.length} kết quả`);
      } else {
        const createOptId = `${baseId}-opt-create`;
        const createKey = `action:create:${query}`;
        topStatusHtml = `<div class="omni-empty-box" id="${baseId}-search-empty" data-i18n-key="search.state.noMatch">
          <p class="t-label mb-1 text-muted">Tìm không ra</p>
          <p class="text-[14px] font-semibold text-body m-0">Không khớp “${esc(query)}”</p>
        </div>`;
        groupsHtml = `<div role="group" aria-labelledby="${grpActHdrId}" class="sugg-zone sugg-zone-actions" data-zone="actions">
          <div id="${grpActHdrId}" class="sugg-group" role="presentation" data-i18n-key="search.group.actions">Thao tác</div>
          <div role="option" id="${createOptId}" data-opt-key="${esc(createKey)}" data-opt-kind="create" data-opt-query="${esc(query)}" aria-selected="false" class="sugg-row omni-create-option">
            <span class="mono text-accent">＋</span>
            <span data-i18n-key="search.actions.createItem"><strong>Tạo mục “${esc(query)}”</strong></span>
            <span class="sugg-meta"><span class="kbd">Enter</span></span>
          </div>
        </div>`;
        setLiveText(`Không khớp “${query}”`);
      }

      pop.innerHTML = `${topStatusHtml}<div role="listbox" id="${listboxId}" class="omni-listbox" aria-label="Kết quả tìm kiếm">${groupsHtml}</div>`;
      pop.hidden = false;
      input.setAttribute('aria-controls', listboxId);
      rebuildListOptionsFromDom();
      input.removeAttribute('aria-activedescendant');
    }

    function renderTagListbox(tagQuery, matchedTags, fromServerLookup) {
      listOpen = true;
      listKind = 'tag-filter';
      const prevKey = activeKey;
      listOptions = [];

      const grpTagsHdrId = `${baseId}-grp-tag-filter-hdr`;
      const hdrLabel = 'Tags';
      let emptyTopHtml = '';
      let groupsHtml = '';
      if (matchedTags.length) {
        const rowsHtml = matchedTags.map((t, idx) => {
          const disp = t.display || t.name;
          const optId = `${baseId}-opt-tag-${idx}`;
          const optKey = `tag:${t.id || disp}`;
          return formatTagRowHtml(t, tagQuery, optId, optKey);
        }).join('');
        groupsHtml = `<div role="group" aria-labelledby="${grpTagsHdrId}" class="sugg-zone" data-zone="tags">
          <div id="${grpTagsHdrId}" class="sugg-group" role="presentation">${hdrLabel}</div>
          ${rowsHtml}
        </div>`;
        setLiveText(`${matchedTags.length} tag khớp #${tagQuery}`);
      } else {
        emptyTopHtml = `<div class="omni-empty-box">
          <p class="text-[14px] font-semibold text-body m-0">Không khớp “#${esc(tagQuery)}”</p>
        </div>`;
        groupsHtml = `<div role="group" aria-labelledby="${grpTagsHdrId}" class="sugg-zone" data-zone="tags">
          <div id="${grpTagsHdrId}" class="sugg-group" role="presentation">${hdrLabel}</div>
        </div>`;
        setLiveText(`Không khớp “#${tagQuery}”`);
      }

      pop.innerHTML = `${emptyTopHtml}<div role="listbox" id="${listboxId}" class="omni-listbox" aria-label="Kết quả lọc tag">${groupsHtml}</div>`;
      pop.hidden = false;
      input.setAttribute('aria-controls', listboxId);
      activeKey = prevKey;
      rebuildListOptionsFromDom();
      if (matchedTags.length && !gateColonLocked && !gateTainted) {
        if (activeIdx < 0) {
          activeIdx = 0;
          activeKey = listOptions[0] ? listOptions[0].key : null;
        }
      } else {
        activeKey = null;
        activeIdx = -1;
      }
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
        <div class="omni-add-privacy mt-2.5 pt-2.5 rule-top-line" id="${baseId}-add-privacy">
          <p class="m-0 text-[12px] text-body">${COPY_PRIVACY_VI}</p>
          <p class="m-0 text-[12px] text-muted" lang="en">${COPY_PRIVACY_EN}</p>
        </div>`;
    }

    function renderHintAndPanels() {
      syncTextareaHeight();
      syncSemToggleBtn();
      const parsed = parseQuickAdd(input.value);
      const isAddLike = parsed.mode === 'add' || parsed.mode === 'add-invalid';
      shell.classList.toggle('is-add', isAddLike);
      const hasNonEmptyInput = input.value.trim().length > 0;

      if (pinnedItem && normIdentity(parsed.name) !== normIdentity(pinnedItem.name)) {
        pinnedItem = null;
      }

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
        hintEl.hidden = !guardEl.hidden;
        const gateClosedForSearch = gateTainted || gateColonLocked || hasAnyColon(input.value) || parsed.tooLongOrMulti;
        if (tabCannotFillMsg) {
          hintEl.dataset.i18nKey = 'search.tab.cannotFill';
          hintEl.innerHTML = `<span class="omni-hint-vi">Không điền được bằng Tab</span>`;
        } else if (legacyHintMode) {
          hintEl.dataset.i18nKey = 'content.omnibox.searchHint';
          hintEl.innerHTML = `<span class="omni-hint-vi"${hasNonEmptyInput ? '' : ' hidden'}>${COPY_SEARCH_HINT_VI}<span class="mono">tên: nội dung</span></span>
            <span class="omni-hint-en" lang="en">${COPY_SEARCH_HINT_EN}<span class="mono">name: content</span></span>`;
        } else if (gateClosedForSearch) {
          /* SPEC §3.4 bảng state -> key: tainted / khoá : ngoài add mode / nhiều dòng / >200 rune -> search.help.enterToSearch */
          hintEl.dataset.i18nKey = 'search.help.enterToSearch';
          hintEl.innerHTML = `<span class="omni-hint-vi">${COPY_ENTER_TO_SEARCH_VI}</span>`;
        } else if (state.semanticExternal !== false) {
          hintEl.dataset.i18nKey = 'search.help.sentToServerExternal';
          hintEl.innerHTML = `<span class="omni-hint-vi">${COPY_SENT_TO_SERVER_EXT_VI}<span class="mono">tên:</span> trước.</span>`;
        } else {
          hintEl.dataset.i18nKey = 'search.help.sentToServer';
          hintEl.innerHTML = `<span class="omni-hint-vi">${COPY_SENT_TO_SERVER_VI}<span class="mono">tên:</span> trước.</span>`;
        }
        addPanelEl.hidden = true;
        lastErrorAlertSig = '';
        lastFailAlertSig = '';
        if (parsed.searchable || !hasNonEmptyInput) {
          input.removeAttribute('aria-invalid');
        }
        return;
      }

      if (parsed.mode === 'tag-filter') {
        hintEl.hidden = !hasNonEmptyInput || !guardEl.hidden;
        const gateClosedForTag = gateTainted || gateColonLocked || hasAnyColon(input.value) || !parsed.searchable;
        if (tabCannotFillMsg) {
          hintEl.dataset.i18nKey = 'search.tab.cannotFill';
          hintEl.innerHTML = `<span class="omni-hint-vi">Không điền được bằng Tab</span>`;
        } else if (gateClosedForTag) {
          hintEl.dataset.i18nKey = 'search.help.enterToSearch';
          hintEl.innerHTML = `<span class="omni-hint-vi">${COPY_ENTER_TO_SEARCH_VI}</span>`;
        } else {
          hintEl.dataset.i18nKey = 'content.omnibox.tagHint';
          hintEl.innerHTML = `<span class="omni-hint-vi">${COPY_TAG_HINT_VI}</span>
            <span class="omni-hint-en" lang="en">${COPY_TAG_HINT_EN}</span>`;
        }
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
        if (pinnedItem) {
          destLabelEl.innerHTML = `Sẽ lưu vào <span class="chip chip-accent !py-0.5 !px-2">${esc(pinnedItem.name)} ✓</span>`;
        } else {
          destLabelEl.innerHTML = `Sẽ lưu vào <strong>${esc(parsed.name || '…')}</strong> · <span lang="en" class="text-muted">Will save to <strong>${esc(parsed.name || '…')}</strong></span>`;
        }
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
      setDraft('');
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
      /* OQ-2: nếu đã ghim item ID qua Tab trên hàng item và phần name chưa sửa -> lưu thẳng vào mục đã ghim, không mở picker */
      if (pinnedItem && normIdentity(pinnedItem.name) === normIdentity(parsed.name)) {
        executeAddAfterTargetResolved(parsed, pinnedItem, false, simOpts);
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
        setDraft('');
        renderHintAndPanels();
        toast(`Đã tạo mục “${q}” (chưa có entry) · Created item “${q}” (no entries)`, 'Hoàn tác', {
          originEl: input
        });
        return;
      }
      if (opt.kind === 'more') {
        toast('Đã tải thêm kết quả (semantic=0) · Loaded more results');
        return;
      }
      if (opt.kind === 'tag') {
        const tagName = opt.tag.display || opt.tag.name;
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

    /* Tab điền (SPEC §3.5, §7.8, plan mục 2.9):
       - Chỉ chặn khi có hàng active (item hoặc tag).
       - Trên item: điền `${name}: ` (add mode), ghim item ID vào kế hoạch lưu (OQ-2).
         Nếu tên chứa `:` hoặc bắt đầu bằng `#` -> không điền, hiện hint "Không điền được bằng Tab".
       - Trên tag: thay token `#…` bằng `#${display} ` (qua setDraft -> sạch).
         Nếu display chứa khoảng trắng, `#` hoặc `:` -> không điền. */
    function handleTabKey(e) {
      if (!listOpen || activeIdx < 0 || !listOptions[activeIdx]) return false;
      const opt = listOptions[activeIdx];
      if (opt.kind === 'item' && opt.item) {
        e.preventDefault();
        const itemName = String(opt.item.name || '');
        if (!itemName || itemName.includes(':') || itemName.includes('：') || itemName.startsWith('#')) {
          tabCannotFillMsg = true;
          renderHintAndPanels();
          setLiveText('Không điền được bằng Tab · Cannot fill with Tab');
          return true;
        }
        tabCannotFillMsg = false;
        pinnedItem = opt.item;
        closeListbox(false);
        setDraft(itemName + ': ');
        renderHintAndPanels();
        setLiveText(`Đã điền “${itemName}: ” và ghim mục ${opt.item.id} · Filled “${itemName}: ” and pinned item`);
        return true;
      }
      if (opt.kind === 'tag' && opt.tag) {
        e.preventDefault();
        const disp = String(opt.tag.display || opt.tag.name || '');
        if (!disp || /\s/.test(disp) || disp.includes('#') || disp.includes(':') || disp.includes('：')) {
          tabCannotFillMsg = true;
          renderHintAndPanels();
          setLiveText('Không điền được bằng Tab · Cannot fill with Tab');
          return true;
        }
        tabCannotFillMsg = false;
        setDraft('#' + disp + ' ', { tainted: false });
        const res = search('#' + disp, { scope: 'tag', semantic: false });
        renderSuggestDropdown(res);
        renderHintAndPanels();
        setLiveText(`Đã điền “#${disp} ” · Filled “#${disp} ”`);
        return true;
      }
      return false;
    }

    function handleEnter(e) {
      const parsed = parseQuickAdd(input.value);
      const isCtrl = e.ctrlKey || e.metaKey;

      if (parsed.mode === 'tag-filter') {
        if (isCtrl) return;
        if (!parsed.searchable) {
          closeListbox(false);
          guardEl.hidden = false;
          hintEl.hidden = true;
          guardEl.innerHTML = `<p class="m-0 text-[13px] font-semibold text-body">Tên tag lọc tối đa 50 ký tự · <span lang="en" class="font-normal text-muted">Tag filter query must be at most 50 characters</span></p>`;
          setLiveText('Tên tag lọc tối đa 50 ký tự · Tag filter query must be at most 50 characters');
          return;
        }
        guardEl.hidden = true;
        /* Mục 2.24 item 2 & 10: nếu gate đóng (ví dụ #home:secret), activeKey đã reset null nên Enter không mở tag active cũ */
        if (listOpen && activeIdx >= 0 && listOptions[activeIdx]) {
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
          hintEl.hidden = true;
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
          setDraft('');
          renderHintAndPanels();
          toast(`Đã tạo mục mới “${newName}” (chưa có entry) · Created new item “${newName}” (no entries)`, 'Hoàn tác', {
            originEl: input
          });
          return;
        }
        if (listOpen && activeIdx >= 0 && listOptions[activeIdx]) {
          executeOption(listOptions[activeIdx]);
          return;
        }
        /* Mục 2.9: q chuẩn hoá ra rỗng (ví dụ "!!!") -> hiện "Không khớp" cục bộ, không gọi /search */
        const qn = normIdentity(parsed.name);
        if (!qn) {
          renderSearchListbox(parsed.name, []);
          return;
        }
        /* Mục 2.24 item 1: Enter trên draft không sạch qua gate luôn gọi /search với semantic=0 */
        const clean = isGateClean(input.value);
        const res = search(parsed.name, { semantic: clean && state.semantic && state.semanticAvailable });
        renderSearchListbox(parsed.name, res.items);
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

    /* Listener native beforeinput / composition để phân biệt gõ tay vs dán/taint (SPEC §3.5 quy tắc 1–3) */
    const ALLOWED_INPUT_TYPES = new Set([
      'insertText',
      'insertCompositionText',
      'insertFromComposition',
      'deleteCompositionText',
      'deleteContent',
      'deleteContentBackward',
      'deleteContentForward',
      'deleteWordBackward',
      'deleteWordForward',
      'deleteSoftLineBackward',
      'deleteSoftLineForward',
      'deleteHardLineBackward',
      'deleteHardLineForward',
      'deleteByCut'
    ]);

    input.addEventListener('compositionstart', () => {
      isComposing = true;
    });
    input.addEventListener('compositionend', (e) => {
      isComposing = false;
      const committed = String((e && e.data) || '');
      if (countGraphemes(committed) > 64) {
        gateTainted = true;
      }
    });
    input.addEventListener('beforeinput', (e) => {
      lastInputType = (e && e.inputType) ? e.inputType : '';
      lastInputData = (e && typeof e.data === 'string') ? e.data : '';
    });

    input.addEventListener('input', (e) => {
      showPostUnlockNotice = false;
      legacyHintMode = false;
      tabCannotFillMsg = false;
      guardEl.hidden = true;
      if (activePlan) {
        clearPlanTimers();
        activePlan = null;
      }

      const curVal = input.value;
      const evType = (e && e.inputType) ? e.inputType : lastInputType;
      const evData = (e && typeof e.data === 'string') ? e.data : lastInputData;

      if (curVal === '') {
        gateTainted = false;
        gateColonLocked = false;
        pinnedItem = null;
      } else {
        if (hasAnyColon(curVal)) {
          gateColonLocked = true;
        }
        if (!evType || !ALLOWED_INPUT_TYPES.has(evType)) {
          gateTainted = true;
        } else if (!isComposing && evType === 'insertText' && countGraphemes(evData) > 1) {
          gateTainted = true;
        }
      }
      prevValue = curVal;
      lastInputType = 'insertText';
      lastInputData = '';

      const parsed = parseQuickAdd(curVal);
      if (parsed.mode === 'add' || parsed.mode === 'add-invalid') {
        gateColonLocked = true;
      }

      if (parsed.mode === 'tag-filter') {
        if (gateColonLocked || gateTainted || hasAnyColon(curVal)) {
          /* Mục 2.24 item 10 (FE-C20): ở chế độ #, khi gate đóng giữ hàng từ cache cục bộ nhưng xoá activeKey */
          const cached = filterTagsPrefix(parsed.tagQuery);
          activeKey = null;
          renderTagListbox(parsed.tagQuery, cached, false);
        } else {
          const res = search(curVal, { scope: 'tag', semantic: false });
          renderSuggestDropdown(res);
        }
      } else if (parsed.mode === 'search') {
        if (!isGateClean(curVal) || isComposing) {
          /* Mục 2.24 item 2 (FE-C2): khi gate đóng xoá snapshot, activeKey=null, đóng dropdown */
          closeListbox(true);
        } else if (curVal.trim() === '') {
          renderSuggestDropdown(search('', { scope: 'all' }));
        } else {
          renderSuggestDropdown(search(curVal, { scope: 'all' }));
        }
      } else if (listOpen) {
        closeListbox(true);
      }
      renderHintAndPanels();
    });

    input.addEventListener('focus', () => {
      if (!listOpen && input.value === '' && !showPostUnlockNotice && !legacyHintMode) {
        renderSuggestDropdown(search('', { scope: 'all' }));
      }
    });

    if (semToggleBtn) {
      semToggleBtn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (!state.semanticAvailable) return;
        state.semantic = !state.semantic;
        syncSemToggleBtn();
        document.querySelectorAll('[data-sem-toggle]').forEach((b) => {
          b.setAttribute('aria-checked', String(state.semantic));
        });
        if (listOpen && listKind === 'suggest') {
          if (!state.semantic) {
            removeNearZoneInPlace();
          } else if (isGateClean(input.value) && input.value.trim().length > 0 && !input.value.trim().startsWith('#')) {
            const res = search(input.value, { scope: 'all', semantic: true });
            appendNearZoneInPlace(res.near, res.query);
          }
        }
        renderHintAndPanels();
      });
    }

    input.addEventListener('keydown', (e) => {
      if (e.isComposing || e.keyCode === 229) return;
      if (e.key === 'Tab') {
        if (handleTabKey(e)) return;
      } else if (e.key === 'ArrowDown') {
        if (!listOpen || !listOptions.length) return;
        e.preventDefault();
        activeIdx = activeIdx < 0 ? 0 : (activeIdx + 1) % listOptions.length;
        activeKey = listOptions[activeIdx] ? listOptions[activeIdx].key : null;
        syncActiveOption();
      } else if (e.key === 'ArrowUp') {
        if (!listOpen || !listOptions.length) return;
        e.preventDefault();
        activeIdx = activeIdx <= 0 ? listOptions.length - 1 : activeIdx - 1;
        activeKey = listOptions[activeIdx] ? listOptions[activeIdx].key : null;
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
          setDraft('');
          clearPlanTimers();
          activePlan = null;
          guardEl.hidden = true;
          renderHintAndPanels();
        }
      }
    });

    /* SPEC §6.8 / plan mục 2.9: Hover KHÔNG đổi activeKey; click = Enter */
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
    window.addEventListener('resize', syncTextareaHeight);

    function onVaultStateChange(isLocked, wasLocked) {
      if (isLocked && !wasLocked) {
        const hasText = input.value.trim().length > 0;
        const hasCommitted = !!(activePlan && activePlan.steps && activePlan.steps.some((s) => s.status === 'done'));
        if (hasText || activePlan) {
          hadDraftOnLock = true;
          hadCommittedMetaOnLock = hasCommitted;
          setDraft('');
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
      setDraft,
      appendNearZoneInPlace,
      removeNearZoneInPlace,
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
        legacyHintMode = false;
        tabCannotFillMsg = false;
        clearPlanTimers();
        clearSuggestTimers();
        activePlan = null;
        guardEl.hidden = true;
        closeListbox(true);

        const segEl = document.getElementById('omni-state-seg');
        if (segEl) {
          segEl.querySelectorAll('[data-omni-scenario]').forEach((b) => {
            b.setAttribute('aria-pressed', String(b.dataset.omniScenario === scenarioName));
          });
        }

        function ensureUnlocked() {
          if (state.locked) {
            state.locked = false;
            if (window.SAK._syncVault) window.SAK._syncVault();
          }
          state.semanticAvailable = true;
          syncSemToggleBtn();
        }

        /* === P05 scenarios (U15 / U18) === */
        if (scenarioName === 'suggest-recent') {
          ensureUnlocked();
          setDraft('');
          renderHintAndPanels();
          const res = search('', { scope: 'all' });
          renderSuggestDropdown(res, { keepActiveKey: false });
          input.focus();
        } else if (scenarioName === 'suggest-typing') {
          ensureUnlocked();
          state.semantic = true;
          syncSemToggleBtn();
          setDraft('wif');
          renderHintAndPanels();
          const res = search('wif', { scope: 'all', semantic: true });
          renderSuggestDropdown(res, { initialActiveKey: 'item:i1' });
          input.focus();
        } else if (scenarioName === 'suggest-near-late') {
          ensureUnlocked();
          state.semantic = true;
          syncSemToggleBtn();
          setDraft('wif');
          renderHintAndPanels();
          const res = search('wif', { scope: 'all', semantic: true });
          /* B1: hiện lexical trước + dòng "Đang tìm gần nghĩa…" ngoài listbox */
          renderSuggestDropdown(res, {
            hideNear: true,
            nearPending: true,
            initialActiveKey: 'item:i1',
            liveAnnouncement: `${res.tags.length + res.items.length} gợi ý`
          });
          /* B2: sau 420ms append vùng Gần nghĩa mà giữ nguyên DOM node lexical & activeKey */
          const tid = setTimeout(() => {
            appendNearZoneInPlace(res.near, 'wif');
          }, 420);
          suggestTimers.push(tid);
          input.focus();
        } else if (scenarioName === 'suggest-empty') {
          ensureUnlocked();
          setDraft('xyz');
          renderHintAndPanels();
          const res = search('xyz', { scope: 'all', semantic: true });
          renderSuggestDropdown(res, { initialActiveKey: 'action:create:xyz' });
          input.focus();
        } else if (scenarioName === 'suggest-paste-guard') {
          ensureUnlocked();
          /* Dán văn bản: gate đóng (tainted = true), không mở dropdown, help text đổi tạm sang search.help.enterToSearch */
          setDraft('secret-token-pasted-from-clipboard', { tainted: true });
          closeListbox(true);
          renderHintAndPanels();
          setLiveText(COPY_ENTER_TO_SEARCH_VI);
          input.focus();
        } else if (scenarioName === 'suggest-tab-item') {
          ensureUnlocked();
          const pinned = ITEMS.find((i) => i.id === 'i1') || ITEMS[0];
          setDraft(pinned.name + ': ');
          pinnedItem = pinned;
          renderHintAndPanels();
          setLiveText(`Đã điền “${pinned.name}: ”`);
          input.focus();
        } else if (scenarioName === 'suggest-tab-tag') {
          ensureUnlocked();
          setDraft('#wifi-khách ', { tainted: false });
          renderHintAndPanels();
          const res = search('#wifi-khách', { scope: 'tag', semantic: false });
          renderSuggestDropdown(res, { initialActiveKey: 'tag:t7' });
          setLiveText('Đã điền “#wifi-khách ”');
          input.focus();
        }
        /* === 16 P04 scenarios (giữ nguyên) === */
        else if (scenarioName === 'search-hint') {
          ensureUnlocked();
          legacyHintMode = true;
          setDraft('wif');
          renderHintAndPanels();
          input.focus();
        } else if (scenarioName === 'search-results') {
          ensureUnlocked();
          setDraft('wif');
          renderHintAndPanels();
          renderSearchListbox('wif', searchItemsPrefix('wif'), { hasMore: true });
          input.focus();
        } else if (scenarioName === 'search-empty') {
          ensureUnlocked();
          setDraft('thuế 2026');
          renderHintAndPanels();
          renderSearchListbox('thuế 2026', []);
          input.focus();
        } else if (scenarioName === 'search-multiline-guard') {
          ensureUnlocked();
          setDraft('dòng 1 chưa có dấu hai chấm\ndòng 2 nội dung dài cần mã hoá');
          renderHintAndPanels();
          handleEnter({ ctrlKey: false, metaKey: false });
          input.focus();
        } else if (scenarioName === 'search-200-guard') {
          ensureUnlocked();
          setDraft('chuỗi-một-dòng-dài-quá-200-ký-tự-không-có-dấu-hai-chấm-' + 'a'.repeat(160));
          renderHintAndPanels();
          handleEnter({ ctrlKey: false, metaKey: false });
          input.focus();
        } else if (scenarioName === 'tag-filter') {
          ensureUnlocked();
          setDraft('#nh');
          renderHintAndPanels();
          renderTagListbox('nh', filterTagsPrefix('nh'), false);
          input.focus();
        } else if (scenarioName === 'add-preview') {
          ensureUnlocked();
          setDraft('wifi #nhà #office: SSID Zone17th-5G / mk 8chars');
          renderHintAndPanels();
          input.focus();
        } else if (scenarioName === 'add-json-banner') {
          ensureUnlocked();
          setDraft('wifi #ops: {"ssid":"Zone17th-5G","vlan":10}');
          renderHintAndPanels();
          input.focus();
        } else if (scenarioName === 'add-err-tag-space') {
          ensureUnlocked();
          setDraft('wifi #nhà bố mẹ: Abc123@home');
          renderHintAndPanels();
          input.focus();
        } else if (scenarioName === 'add-err-21-tags') {
          ensureUnlocked();
          const tags21 = Array.from({ length: 21 }, (_, i) => `#t${i + 1}`).join(' ');
          setDraft(`wifi ${tags21}: nội dung mẫu`);
          renderHintAndPanels();
          input.focus();
        } else if (scenarioName === 'add-err-empty-body') {
          ensureUnlocked();
          setDraft('wifi #nhà:   ');
          renderHintAndPanels();
          input.focus();
        } else if (scenarioName === 'add-err-target-tag-cap') {
          ensureUnlocked();
          setDraft('wifi-office #tag-mới-1 #tag-mới-2 #tag-mới-3: nội dung thêm');
          const parsed = parseQuickAdd(input.value);
          executeAddAfterTargetResolved(parsed, ITEMS.find((i) => i.id === 'i3'), false, { existingTagCount: 18 });
          input.focus();
        } else if (scenarioName === 'save-step-running') {
          ensureUnlocked();
          setDraft('router-mới #nhà #ops: cấu hình PPPoE ISP');
          const parsed = parseQuickAdd(input.value);
          executeAddAfterTargetResolved(parsed, null, true, { pauseAtKey: 'entry', immediate: true });
          input.focus();
        } else if (scenarioName === 'save-step-error') {
          ensureUnlocked();
          setDraft('router-mới #nhà #ops: cấu hình PPPoE ISP');
          const parsed = parseQuickAdd(input.value);
          executeAddAfterTargetResolved(parsed, null, true, { failAtKey: 'entry', immediate: true });
          const retryBtn = addPanelEl.querySelector('[data-omni-retry-plan]');
          if (retryBtn) retryBtn.focus();
        } else if (scenarioName === 'locked-add') {
          setDraft('wifi #nhà: mật khẩu đang gõ khi khoá');
          state.locked = true;
          if (window.SAK._syncVault) window.SAK._syncVault({ keepDraftForDemo: true });
          renderHintAndPanels();
          input.focus();
        } else if (scenarioName === 'unlocked-draft-cleared') {
          ensureUnlocked();
          setDraft('');
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

  /* ---------- P04 Step 3: Strict JSON AST, Table Editor, Raw Editor, Format & Import (U13, U14) ---------- */

  const JSON_MAX_UTF8_BYTES = 262144;
  const JSON_FORMAT_MAX_DEPTH = 1000;
  const JSON_TABLE_MAX_COLUMNS = 20;
  const JSON_TABLE_PAGE_SIZE = 50;
  const utf8Encoder = new TextEncoder();

  function measureUtf8Bytes(text) {
    return utf8Encoder.encode(String(text || '')).byteLength;
  }

  function formatByteCountVi(bytes) {
    return Number(bytes || 0).toLocaleString('vi-VN');
  }

  function isWellFormedUtf16(value) {
    const s = String(value);
    for (let i = 0; i < s.length; i++) {
      const code = s.charCodeAt(i);
      if (code >= 0xd800 && code <= 0xdbff) {
        if (i + 1 >= s.length) return false;
        const next = s.charCodeAt(i + 1);
        if (next < 0xdc00 || next > 0xdfff) return false;
        i++;
      } else if (code >= 0xdc00 && code <= 0xdfff) {
        return false;
      }
    }
    return true;
  }

  function detectEol(text) {
    const s = String(text || '');
    let lfCount = 0;
    let crlfCount = 0;
    let crCount = 0;
    let firstBreak = null;
    for (let i = 0; i < s.length; i++) {
      const ch = s.charCodeAt(i);
      if (ch === 0x0d) {
        if (i + 1 < s.length && s.charCodeAt(i + 1) === 0x0a) {
          if (!firstBreak) firstBreak = 'crlf';
          crlfCount++;
          i++;
        } else {
          crCount++;
        }
      } else if (ch === 0x0a) {
        if (!firstBreak) firstBreak = 'lf';
        lfCount++;
      }
    }
    const totalBreaks = lfCount + crlfCount + crCount;
    let kind = 'lf';
    if (totalBreaks > 0) {
      const kindsPresent = (lfCount > 0 ? 1 : 0) + (crlfCount > 0 ? 1 : 0) + (crCount > 0 ? 1 : 0);
      if (kindsPresent > 1) kind = 'mixed';
      else if (crlfCount > 0) kind = 'crlf';
      else if (crCount > 0) kind = 'cr';
    }
    let majority = 'lf';
    if (crlfCount > lfCount) majority = 'crlf';
    else if (lfCount > crlfCount) majority = 'lf';
    else if (crlfCount > 0 && lfCount === crlfCount && firstBreak === 'crlf') majority = 'crlf';
    const majoritySeq = majority === 'crlf' ? '\r\n' : '\n';
    return {
      kind,
      majority,
      lfCount,
      crlfCount,
      crCount,
      totalBreaks,
      majoritySeq,
      requiresConversionWarning: kind === 'mixed' || kind === 'cr'
    };
  }

  function offsetToLineColumn(source, offset) {
    const clamped = Math.max(0, Math.min(offset, source.length));
    let line = 1;
    let lineStart = 0;
    for (let i = 0; i < clamped; i++) {
      const ch = source.charCodeAt(i);
      if (ch === 0x0d) {
        if (i + 1 < source.length && source.charCodeAt(i + 1) === 0x0a) {
          if (i + 1 <= clamped) {
            i++;
            line++;
            lineStart = i + 1;
          }
        } else {
          line++;
          lineStart = i + 1;
        }
      } else if (ch === 0x0a) {
        line++;
        lineStart = i + 1;
      }
    }
    return { line, column: clamped - lineStart + 1 };
  }

  function isValidJsonNumberLexeme(lexeme) {
    const s = String(lexeme || '');
    if (!s) return false;
    return /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(s);
  }

  function escapeJsonStringMinimal(value) {
    const s = String(value);
    let out = '"';
    for (let i = 0; i < s.length; i++) {
      const ch = s.charCodeAt(i);
      if (ch === 0x22) out += '\\"';
      else if (ch === 0x5c) out += '\\\\';
      else if (ch === 0x08) out += '\\b';
      else if (ch === 0x09) out += '\\t';
      else if (ch === 0x0a) out += '\\n';
      else if (ch === 0x0c) out += '\\f';
      else if (ch === 0x0d) out += '\\r';
      else if (ch <= 0x1f) out += '\\u' + ch.toString(16).padStart(4, '0');
      else out += s[i];
    }
    out += '"';
    return out;
  }

  let jsonRevisionCounter = 1;

  function parseJsonStrict(source, opts) {
    const s = String(source == null ? '' : source);
    const revision = opts && opts.revision != null ? opts.revision : (jsonRevisionCounter++);
    const len = s.length;
    let pos = 0;
    let nextId = 1;
    const nodeById = new Map();
    const propertyById = new Map();
    const parentById = new Map();

    function makeErr(offset, code, messageVi, messageEn) {
      const lc = offsetToLineColumn(s, offset);
      return {
        ok: false,
        error: {
          code,
          offset,
          line: lc.line,
          column: lc.column,
          messageVi,
          messageEn
        }
      };
    }

    function skipWs() {
      while (pos < len) {
        const ch = s.charCodeAt(pos);
        if (ch === 0x20 || ch === 0x09 || ch === 0x0a || ch === 0x0d) {
          pos++;
        } else if (ch === 0xfeff) {
          return makeErr(pos, 'BOM_NOT_WHITESPACE', 'Ký tự BOM (U+FEFF) không phải khoảng trắng hợp lệ trong JSON.', 'Byte order mark (U+FEFF) is not valid JSON whitespace.');
        } else if (ch === 0x2f && pos + 1 < len && (s.charCodeAt(pos + 1) === 0x2f || s.charCodeAt(pos + 1) === 0x2a)) {
          return makeErr(pos, 'COMMENT_NOT_ALLOWED', 'JSON chuẩn không cho phép chú thích (// hoặc /* */).', 'Comments are not allowed in strict RFC 8259 JSON.');
        } else {
          break;
        }
      }
      return null;
    }

    function hexVal(code) {
      if (code >= 0x30 && code <= 0x39) return code - 0x30;
      if (code >= 0x41 && code <= 0x46) return code - 0x41 + 10;
      if (code >= 0x61 && code <= 0x66) return code - 0x61 + 10;
      return -1;
    }

    function parseString() {
      const start = pos;
      pos++;
      let out = '';
      let hasEscape = false;
      while (pos < len) {
        const ch = s.charCodeAt(pos);
        if (ch === 0x22) {
          pos++;
          const raw = s.slice(start, pos);
          let hasLoneSurrogate = false;
          let hasCarriageReturn = false;
          for (let i = 0; i < out.length; i++) {
            const c = out.charCodeAt(i);
            if (c === 0x0d) hasCarriageReturn = true;
            if (c >= 0xd800 && c <= 0xdbff) {
              if (i + 1 < out.length) {
                const lo = out.charCodeAt(i + 1);
                if (lo >= 0xdc00 && lo <= 0xdfff) { i++; continue; }
              }
              hasLoneSurrogate = true;
            } else if (c >= 0xdc00 && c <= 0xdfff) {
              hasLoneSurrogate = true;
            }
          }
          return {
            ok: true,
            node: {
              id: nextId++,
              kind: 'string',
              span: { start, end: pos },
              raw,
              value: out,
              hasEscape,
              hasLoneSurrogate,
              hasCarriageReturn
            }
          };
        }
        if (ch <= 0x1f) {
          return makeErr(pos, 'UNESCAPED_CONTROL_CHAR', 'Ký tự điều khiển chưa escape trong chuỗi JSON.', 'Unescaped control character in JSON string.');
        }
        if (ch === 0x5c) {
          hasEscape = true;
          const escStart = pos;
          pos++;
          if (pos >= len) return makeErr(escStart, 'UNTERMINATED_STRING', 'Chuỗi JSON chưa đóng dấu ngoặc kép.', 'Unterminated JSON string literal.');
          const escCh = s.charCodeAt(pos);
          pos++;
          if (escCh === 0x22) out += '"';
          else if (escCh === 0x5c) out += '\\';
          else if (escCh === 0x2f) out += '/';
          else if (escCh === 0x62) out += '\b';
          else if (escCh === 0x66) out += '\f';
          else if (escCh === 0x6e) out += '\n';
          else if (escCh === 0x72) out += '\r';
          else if (escCh === 0x74) out += '\t';
          else if (escCh === 0x75) {
            if (pos + 4 > len) return makeErr(escStart, 'INVALID_UNICODE_ESCAPE', 'Escape Unicode \\uXXXX chưa đủ 4 chữ số hex.', 'Incomplete \\uXXXX Unicode escape sequence.');
            let cu = 0;
            for (let k = 0; k < 4; k++) {
              const hv = hexVal(s.charCodeAt(pos + k));
              if (hv < 0) return makeErr(escStart, 'INVALID_UNICODE_ESCAPE', 'Escape Unicode \\uXXXX không hợp lệ.', 'Invalid hex digit in \\uXXXX Unicode escape.');
              cu = (cu << 4) | hv;
            }
            pos += 4;
            out += String.fromCharCode(cu);
          } else {
            return makeErr(escStart, 'INVALID_ESCAPE', 'Ký tự escape không hợp lệ trong chuỗi JSON.', 'Invalid escape sequence in JSON string.');
          }
        } else {
          out += s[pos++];
        }
      }
      return makeErr(start, 'UNTERMINATED_STRING', 'Chuỗi JSON chưa đóng dấu ngoặc kép.', 'Unterminated JSON string literal.');
    }

    function parseNumber() {
      const start = pos;
      if (s.charCodeAt(pos) === 0x2d) {
        pos++;
        if (pos >= len) return makeErr(start, 'INVALID_NUMBER', 'Số JSON không hợp lệ sau dấu trừ.', 'Invalid JSON number after minus sign.');
      }
      const d0 = s.charCodeAt(pos);
      if (d0 === 0x30) {
        pos++;
        if (pos < len && s.charCodeAt(pos) >= 0x30 && s.charCodeAt(pos) <= 0x39) {
          return makeErr(start, 'INVALID_NUMBER', 'Số JSON không được có chữ số 0 đứng đầu.', 'Leading zeros are not allowed in JSON numbers.');
        }
      } else if (d0 >= 0x31 && d0 <= 0x39) {
        pos++;
        while (pos < len && s.charCodeAt(pos) >= 0x30 && s.charCodeAt(pos) <= 0x39) pos++;
      } else {
        return makeErr(start, 'INVALID_NUMBER', 'Số JSON không hợp lệ.', 'Invalid JSON number.');
      }
      if (pos < len && s.charCodeAt(pos) === 0x2e) {
        pos++;
        if (pos >= len || s.charCodeAt(pos) < 0x30 || s.charCodeAt(pos) > 0x39) {
          return makeErr(start, 'INVALID_NUMBER', 'Thiếu chữ số sau dấu chấm thập phân.', 'Expected digit after decimal point.');
        }
        while (pos < len && s.charCodeAt(pos) >= 0x30 && s.charCodeAt(pos) <= 0x39) pos++;
      }
      if (pos < len && (s.charCodeAt(pos) === 0x65 || s.charCodeAt(pos) === 0x45)) {
        pos++;
        if (pos < len && (s.charCodeAt(pos) === 0x2b || s.charCodeAt(pos) === 0x2d)) pos++;
        if (pos >= len || s.charCodeAt(pos) < 0x30 || s.charCodeAt(pos) > 0x39) {
          return makeErr(start, 'INVALID_NUMBER', 'Thiếu chữ số ở phần mũ (exponent).', 'Expected digit in number exponent.');
        }
        while (pos < len && s.charCodeAt(pos) >= 0x30 && s.charCodeAt(pos) <= 0x39) pos++;
      }
      const lexeme = s.slice(start, pos);
      return {
        ok: true,
        node: {
          id: nextId++,
          kind: 'number',
          span: { start, end: pos },
          lexeme
        }
      };
    }

    const wsErr = skipWs();
    if (wsErr) return wsErr;
    if (pos >= len) {
      return makeErr(0, 'EMPTY_DOCUMENT', 'Tài liệu JSON đang trống.', 'JSON document is empty.');
    }

    let rootNode = null;
    let maxDepth = 0;
    const stack = [];

    function attachValue(node) {
      nodeById.set(node.id, node);
      if (stack.length === 0) {
        rootNode = node;
        return;
      }
      const top = stack[stack.length - 1];
      parentById.set(node.id, top.node);
      if (top.kind === 'array') {
        top.elements.push(node);
        top.state = 'afterValue';
      } else {
        const keyStr = top.pendingKey.value;
        const prevCount = top.keyCounts.get(keyStr) || 0;
        top.keyCounts.set(keyStr, prevCount + 1);
        if (prevCount >= 1) top.hasDuplicateKeys = true;
        const prop = {
          id: nextId++,
          kind: 'property',
          span: { start: top.pendingKey.span.start, end: node.span.end },
          keyNode: top.pendingKey,
          key: keyStr,
          occurrenceIndex: prevCount,
          propertyIndex: top.properties.length,
          colonOffset: top.pendingColon,
          valueNode: node
        };
        propertyById.set(prop.id, prop);
        parentById.set(top.pendingKey.id, top.node);
        top.properties.push(prop);
        top.pendingKey = null;
        top.state = 'afterValue';
      }
    }

    mainLoop: while (true) {
      const err0 = skipWs();
      if (err0) return err0;

      if (stack.length > 0) {
        const top = stack[stack.length - 1];
        if (top.kind === 'object') {
          if (top.state === 'expectKeyOrEnd' || top.state === 'expectKey') {
            if (pos >= len) return makeErr(pos, 'UNEXPECTED_EOF', 'Kết thúc đột ngột khi đang đọc object.', 'Unexpected end of input inside object.');
            const ch = s.charCodeAt(pos);
            if (ch === 0x7d) {
              if (top.state === 'expectKey') {
                return makeErr(pos, 'TRAILING_COMMA', 'Dư dấu phẩy cuối trước dấu đóng ngoặc nhọn }.', 'Trailing comma before closing "}" is not allowed.');
              }
              pos++;
              top.node.span.end = pos;
              top.node.properties = top.properties;
              top.node.hasDuplicateKeys = top.hasDuplicateKeys;
              stack.pop();
              attachValue(top.node);
              if (stack.length === 0) break mainLoop;
              continue mainLoop;
            }
            if (ch !== 0x22) {
              return makeErr(pos, 'EXPECTED_PROPERTY_KEY', 'Khoá trong object phải đặt trong dấu ngoặc kép (").', 'Expected double-quoted property name in object.');
            }
            const keyRes = parseString();
            if (!keyRes.ok) return keyRes;
            nodeById.set(keyRes.node.id, keyRes.node);
            const errColon = skipWs();
            if (errColon) return errColon;
            if (pos >= len || s.charCodeAt(pos) !== 0x3a) {
              return makeErr(pos, 'EXPECTED_COLON', 'Thiếu dấu hai chấm (:) sau tên khoá.', 'Expected ":" after property name in object.');
            }
            top.pendingKey = keyRes.node;
            top.pendingColon = pos;
            pos++;
            top.state = 'expectValue';
            const errAfterColon = skipWs();
            if (errAfterColon) return errAfterColon;
          } else if (top.state === 'afterValue') {
            if (pos >= len) return makeErr(pos, 'UNEXPECTED_EOF', 'Thiếu dấu phẩy (,) hoặc dấu đóng ngoặc nhọn (}).', 'Expected "," or "}" after object property.');
            const ch = s.charCodeAt(pos);
            if (ch === 0x2c) {
              pos++;
              top.state = 'expectKey';
              continue mainLoop;
            }
            if (ch === 0x7d) {
              pos++;
              top.node.span.end = pos;
              top.node.properties = top.properties;
              top.node.hasDuplicateKeys = top.hasDuplicateKeys;
              stack.pop();
              attachValue(top.node);
              if (stack.length === 0) break mainLoop;
              continue mainLoop;
            }
            return makeErr(pos, 'EXPECTED_COMMA_OR_END', 'Thiếu dấu phẩy (,) hoặc dấu đóng ngoặc nhọn (}) giữa hai khoá.', 'Expected "," or "}" after property value.');
          }
        } else if (top.kind === 'array') {
          if (top.state === 'expectValueOrEnd' || top.state === 'expectValue') {
            if (pos >= len) return makeErr(pos, 'UNEXPECTED_EOF', 'Kết thúc đột ngột khi đang đọc mảng.', 'Unexpected end of input inside array.');
            const ch = s.charCodeAt(pos);
            if (ch === 0x5d) {
              if (top.state === 'expectValue') {
                return makeErr(pos, 'TRAILING_COMMA', 'Dư dấu phẩy cuối trước dấu đóng ngoặc vuông ].', 'Trailing comma before closing "]" is not allowed.');
              }
              pos++;
              top.node.span.end = pos;
              top.node.elements = top.elements;
              stack.pop();
              attachValue(top.node);
              if (stack.length === 0) break mainLoop;
              continue mainLoop;
            }
          } else if (top.state === 'afterValue') {
            if (pos >= len) return makeErr(pos, 'UNEXPECTED_EOF', 'Thiếu dấu phẩy (,) hoặc dấu đóng ngoặc vuông (]).', 'Expected "," or "]" after array element.');
            const ch = s.charCodeAt(pos);
            if (ch === 0x2c) {
              pos++;
              top.state = 'expectValue';
              continue mainLoop;
            }
            if (ch === 0x5d) {
              pos++;
              top.node.span.end = pos;
              top.node.elements = top.elements;
              stack.pop();
              attachValue(top.node);
              if (stack.length === 0) break mainLoop;
              continue mainLoop;
            }
            return makeErr(pos, 'EXPECTED_COMMA_OR_END', 'Thiếu dấu phẩy (,) hoặc dấu đóng ngoặc vuông (]).', 'Expected "," or "]" after array element.');
          }
        }
      }

      if (pos >= len) return makeErr(pos, 'UNEXPECTED_EOF', 'Kết thúc đột ngột khi đang chờ giá trị JSON.', 'Unexpected end of input where JSON value was expected.');
      const ch = s.charCodeAt(pos);
      if (ch === 0x7b) {
        const objNode = { id: nextId++, kind: 'object', span: { start: pos, end: pos + 1 }, properties: [], hasDuplicateKeys: false };
        pos++;
        stack.push({ kind: 'object', node: objNode, properties: [], keyCounts: new Map(), hasDuplicateKeys: false, state: 'expectKeyOrEnd', pendingKey: null, pendingColon: 0 });
        if (stack.length > maxDepth) maxDepth = stack.length;
        continue mainLoop;
      }
      if (ch === 0x5b) {
        const arrNode = { id: nextId++, kind: 'array', span: { start: pos, end: pos + 1 }, elements: [] };
        pos++;
        stack.push({ kind: 'array', node: arrNode, elements: [], state: 'expectValueOrEnd' });
        if (stack.length > maxDepth) maxDepth = stack.length;
        continue mainLoop;
      }
      if (ch === 0x22) {
        const strRes = parseString();
        if (!strRes.ok) return strRes;
        attachValue(strRes.node);
        if (stack.length === 0) break mainLoop;
        continue mainLoop;
      }
      if (ch === 0x2d || (ch >= 0x30 && ch <= 0x39)) {
        const numRes = parseNumber();
        if (!numRes.ok) return numRes;
        attachValue(numRes.node);
        if (stack.length === 0) break mainLoop;
        continue mainLoop;
      }
      if (ch === 0x74 && s.slice(pos, pos + 4) === 'true') {
        const node = { id: nextId++, kind: 'boolean', span: { start: pos, end: pos + 4 }, value: true, raw: 'true' };
        pos += 4;
        attachValue(node);
        if (stack.length === 0) break mainLoop;
        continue mainLoop;
      }
      if (ch === 0x66 && s.slice(pos, pos + 5) === 'false') {
        const node = { id: nextId++, kind: 'boolean', span: { start: pos, end: pos + 5 }, value: false, raw: 'false' };
        pos += 5;
        attachValue(node);
        if (stack.length === 0) break mainLoop;
        continue mainLoop;
      }
      if (ch === 0x6e && s.slice(pos, pos + 4) === 'null') {
        const node = { id: nextId++, kind: 'null', span: { start: pos, end: pos + 4 }, value: null, raw: 'null' };
        pos += 4;
        attachValue(node);
        if (stack.length === 0) break mainLoop;
        continue mainLoop;
      }
      return makeErr(pos, 'UNEXPECTED_TOKEN', 'Ký tự không hợp lệ trong JSON.', 'Unexpected token in JSON input.');
    }

    const trailErr = skipWs();
    if (trailErr) return trailErr;
    if (pos < len) {
      return makeErr(pos, 'TRAILING_CONTENT', 'Dư ký tự sau giá trị JSON gốc.', 'Unexpected trailing content after root JSON value.');
    }

    return {
      ok: true,
      document: {
        source: s,
        revision,
        root: rootNode,
        maxDepth,
        nodeById,
        propertyById,
        parentById
      }
    };
  }

  function scanNonWhitespaceTokens(source) {
    const tokens = [];
    const len = source.length;
    let pos = 0;
    while (pos < len) {
      const ch = source.charCodeAt(pos);
      if (ch === 0x20 || ch === 0x09 || ch === 0x0a || ch === 0x0d) {
        pos++;
        continue;
      }
      if (ch === 0x7b || ch === 0x7d || ch === 0x5b || ch === 0x5d || ch === 0x3a || ch === 0x2c) {
        const raw = source[pos++];
        tokens.push({ kind: raw, raw, utf8Bytes: 1 });
        continue;
      }
      if (ch === 0x22) {
        const start = pos++;
        while (pos < len) {
          const c = source.charCodeAt(pos);
          if (c === 0x5c) { pos += 2; continue; }
          if (c === 0x22) { pos++; break; }
          pos++;
        }
        const raw = source.slice(start, pos);
        tokens.push({ kind: 'string', raw, utf8Bytes: measureUtf8Bytes(raw) });
        continue;
      }
      const start = pos;
      while (pos < len) {
        const c = source.charCodeAt(pos);
        if (c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d || c === 0x7b || c === 0x7d || c === 0x5b || c === 0x5d || c === 0x3a || c === 0x2c || c === 0x22) break;
        pos++;
      }
      const raw = source.slice(start, pos);
      tokens.push({ kind: 'literal', raw, utf8Bytes: raw.length });
    }
    return tokens;
  }

  function formatJsonStrict(sourceOrDoc, options) {
    const maxBytes = (options && options.maxBytes) || JSON_MAX_UTF8_BYTES;
    const maxDepth = (options && options.maxDepth) || JSON_FORMAT_MAX_DEPTH;
    let doc = sourceOrDoc;
    if (typeof sourceOrDoc === 'string') {
      const parsed = parseJsonStrict(sourceOrDoc);
      if (!parsed.ok) {
        return { ok: false, code: 'PARSE_ERROR', parseError: parsed.error };
      }
      doc = parsed.document;
    }
    if (doc.maxDepth > maxDepth) {
      return { ok: false, code: 'DEPTH_LIMIT_EXCEEDED', depth: doc.maxDepth, maxDepth };
    }
    const eolKind = (options && options.eol) || detectEol(doc.source).majority;
    const eolSeq = eolKind === 'crlf' ? '\r\n' : eolKind === 'cr' ? '\r' : '\n';
    const eolBytes = eolSeq.length;
    const tokens = scanNonWhitespaceTokens(doc.source);

    let predictedBytes = 0;
    let currentDepth = 0;
    for (let i = 0; i < tokens.length; i++) {
      const tok = tokens[i];
      const nextTok = i + 1 < tokens.length ? tokens[i + 1] : null;
      if (tok.kind === '{' || tok.kind === '[') {
        predictedBytes += 1;
        if (nextTok && (nextTok.kind === '}' || nextTok.kind === ']')) {
          predictedBytes += 1;
          i++;
        } else {
          currentDepth++;
          if (currentDepth > maxDepth) {
            return { ok: false, code: 'DEPTH_LIMIT_EXCEEDED', depth: currentDepth, maxDepth };
          }
          predictedBytes += eolBytes + currentDepth * 2;
        }
      } else if (tok.kind === '}' || tok.kind === ']') {
        currentDepth--;
        predictedBytes += eolBytes + currentDepth * 2 + 1;
      } else if (tok.kind === ':') {
        predictedBytes += 2;
      } else if (tok.kind === ',') {
        predictedBytes += 1 + eolBytes + currentDepth * 2;
      } else {
        predictedBytes += tok.utf8Bytes;
      }
      if (predictedBytes > maxBytes) {
        return { ok: false, code: 'BYTE_LIMIT_EXCEEDED', byteLength: predictedBytes, limitBytes: maxBytes };
      }
    }

    const indentCache = [''];
    function getIndent(d) {
      while (indentCache.length <= d) indentCache.push(indentCache[indentCache.length - 1] + '  ');
      return indentCache[d];
    }
    const parts = [];
    let buildDepth = 0;
    for (let i = 0; i < tokens.length; i++) {
      const tok = tokens[i];
      const nextTok = i + 1 < tokens.length ? tokens[i + 1] : null;
      if (tok.kind === '{' || tok.kind === '[') {
        if (nextTok && (nextTok.kind === '}' || nextTok.kind === ']')) {
          parts.push(tok.raw, nextTok.raw);
          i++;
        } else {
          buildDepth++;
          parts.push(tok.raw, eolSeq, getIndent(buildDepth));
        }
      } else if (tok.kind === '}' || tok.kind === ']') {
        buildDepth--;
        parts.push(eolSeq, getIndent(buildDepth), tok.raw);
      } else if (tok.kind === ':') {
        parts.push(': ');
      } else if (tok.kind === ',') {
        parts.push(',', eolSeq, getIndent(buildDepth));
      } else {
        parts.push(tok.raw);
      }
    }
    const formattedText = parts.join('');
    const reparsed = parseJsonStrict(formattedText);
    if (!reparsed.ok) return { ok: false, code: 'PARSE_ERROR', parseError: reparsed.error };
    return {
      ok: true,
      text: formattedText,
      byteLength: predictedBytes,
      document: reparsed.document
    };
  }

  function findLineStart(source, offset) {
    let i = offset;
    while (i > 0) {
      const ch = source.charCodeAt(i - 1);
      if (ch === 0x0a || ch === 0x0d) break;
      i--;
    }
    return i;
  }

  function getLeadingIndentAt(source, offset) {
    const ls = findLineStart(source, offset);
    let i = ls;
    while (i < offset) {
      const ch = source.charCodeAt(i);
      if (ch === 0x20 || ch === 0x09) i++;
      else break;
    }
    return source.slice(ls, i);
  }

  function hasLineBreakBetween(source, start, end) {
    for (let i = start; i < end; i++) {
      const ch = source.charCodeAt(i);
      if (ch === 0x0a || ch === 0x0d) return true;
    }
    return false;
  }

  function computeInsertionSpan(source, containerSpan, items, insertIndex, newItemText) {
    const clampedIndex = Math.max(0, Math.min(insertIndex, items.length));
    const eol = detectEol(source).majoritySeq;
    const parentIndent = getLeadingIndentAt(source, containerSpan.start);
    const defaultChildIndent = parentIndent + '  ';

    if (items.length === 0) {
      const innerStart = containerSpan.start + 1;
      const innerEnd = containerSpan.end - 1;
      if (!hasLineBreakBetween(source, innerStart, innerEnd)) {
        return { offset: innerStart, length: innerEnd - innerStart, content: newItemText };
      }
      return {
        offset: innerStart,
        length: innerEnd - innerStart,
        content: eol + defaultChildIndent + newItemText + eol + parentIndent
      };
    }

    const isMulti = hasLineBreakBetween(source, containerSpan.start, containerSpan.end);
    if (clampedIndex === 0) {
      const first = items[0];
      const firstHasOwnLine = hasLineBreakBetween(source, containerSpan.start, first.span.start);
      if (!isMulti || !firstHasOwnLine) {
        return { offset: first.span.start, length: 0, content: newItemText + ', ' };
      }
      const firstLineStart = findLineStart(source, first.span.start);
      const firstIndent = getLeadingIndentAt(source, first.span.start);
      return { offset: firstLineStart, length: 0, content: firstIndent + newItemText + ',' + eol };
    }

    const prev = items[clampedIndex - 1];
    const prevHasOwnLine = hasLineBreakBetween(source, containerSpan.start, prev.span.start);
    const siblingIndent = prevHasOwnLine ? getLeadingIndentAt(source, prev.span.start) : defaultChildIndent;
    if (!isMulti && !prevHasOwnLine) {
      return { offset: prev.span.end, length: 0, content: ', ' + newItemText };
    }
    return { offset: prev.span.end, length: 0, content: ',' + eol + siblingIndent + newItemText };
  }

  function computeRemovalSpan(source, containerSpan, items, removeIndex) {
    const target = items[removeIndex];
    if (items.length === 1) {
      const innerStart = containerSpan.start + 1;
      const innerEnd = containerSpan.end - 1;
      return { offset: innerStart, length: innerEnd - innerStart, content: '' };
    }
    if (removeIndex < items.length - 1) {
      const next = items[removeIndex + 1];
      const targetLineStart = findLineStart(source, target.span.start);
      const nextLineStart = findLineStart(source, next.span.start);
      if (targetLineStart > containerSpan.start && nextLineStart > target.span.end) {
        return { offset: targetLineStart, length: nextLineStart - targetLineStart, content: '' };
      }
      return { offset: target.span.start, length: next.span.start - target.span.start, content: '' };
    }
    const prev = items[removeIndex - 1];
    return { offset: prev.span.end, length: target.span.end - prev.span.end, content: '' };
  }

  function spliceJsonSource(source, edit) {
    return source.slice(0, edit.offset) + edit.content + source.slice(edit.offset + edit.length);
  }

  function classifyArrayNode(arrNode) {
    const elements = arrNode.elements;
    const n = elements.length;
    if (n === 0) return 'empty-array';
    let allObjects = true;
    let allArrays = true;
    for (let i = 0; i < n; i++) {
      const k = elements[i].kind;
      if (k !== 'object') allObjects = false;
      if (k !== 'array') allArrays = false;
    }
    if (allObjects) return 'array-of-objects';
    if (allArrays) return 'array-of-arrays';
    return 'primitive-array';
  }

  function deriveArrayColumns(arrNode) {
    const columns = [];
    const seen = new Set();
    let totalDistinct = 0;
    arrNode.elements.forEach((el) => {
      if (el.kind === 'object') {
        el.properties.forEach((p) => {
          if (!seen.has(p.key)) {
            seen.add(p.key);
            totalDistinct++;
            if (columns.length < JSON_TABLE_MAX_COLUMNS) columns.push(p.key);
          }
        });
      }
    });
    return {
      columns,
      overflowColumnCount: Math.max(0, totalDistinct - JSON_TABLE_MAX_COLUMNS)
    };
  }

  /* ---------- Interactive JSON Entry Card Controller ---------- */

  const jsonCardInstances = [];
  let vaultTogglePointerDown = false;
  const SUP_DIGITS = ['⁰', '¹', '²', '³', '⁴', '⁵', '⁶', '⁷', '⁸', '⁹'];
  function toSuperscriptNum(n) {
    return String(n).split('').map((d) => SUP_DIGITS[d.charCodeAt(0) - 48] || d).join('');
  }

  function mapSourceOffsetToLfOffset(source, offset) {
    const s = String(source || '');
    const clamped = Math.max(0, Math.min(offset || 0, s.length));
    let lfOffset = 0;
    for (let i = 0; i < clamped; i++) {
      if (s.charCodeAt(i) === 0x0d && i + 1 < s.length && s.charCodeAt(i + 1) === 0x0a) {
        if (i + 1 < clamped) {
          i++;
        }
      }
      lfOffset++;
    }
    return lfOffset;
  }

  function initJsonEntryCard(config) {
    const tableHost = typeof config.tableHost === 'string' ? document.getElementById(config.tableHost) : config.tableHost;
    const rawHost = typeof config.rawHost === 'string' ? document.getElementById(config.rawHost) : config.rawHost;
    if (!tableHost) return null;

    const hostIdPrefix = (tableHost.id && tableHost.id.trim()) || ('json-tbl-' + (jsonCardInstances.length + 1));
    const readOnlyNoteId = `${hostIdPrefix}-ro-note`;
    const rawErrorId = (rawHost && rawHost.querySelector('[data-json-raw-error]')?.id) || `${hostIdPrefix}-raw-error`;
    if (rawHost) {
      const errEl = rawHost.querySelector('[data-json-raw-error]');
      if (errEl && !errEl.id) errEl.id = rawErrorId;
    }

    let currentSource = String(config.initialSource || '{}');
    let parsedRes = parseJsonStrict(currentSource);
    let currentDoc = parsedRes.ok ? parsedRes.document : null;
    const readOnlyCard = !!config.readOnly;
    const pageByNodePath = new Map();
    const openContainers = new Set(config.initialOpenPaths || []);
    let activeEditCellKey = null;
    let activeCellError = null;
    let activeAddFormPath = null;
    let activeAddKeyError = null;
    let eolConfirmPending = false;
    let renderedHasReadOnlyCells = false;
    let lastRawErrorOffset = 0;
    let validateRawDraftFn = null;

    function getNodeByPath(root, path) {
      if (!root) return null;
      if (!path || path === 'root') return root;
      const parts = path.split('.');
      let cur = root;
      for (let i = 1; i < parts.length; i++) {
        const step = parts[i];
        if (!cur) return null;
        if (step.startsWith('p')) {
          const pIdx = parseInt(step.slice(1), 10);
          const prop = cur.properties && cur.properties[pIdx];
          cur = prop ? prop.valueNode : null;
        } else if (step.startsWith('k')) {
          const pIdx = parseInt(step.slice(1), 10);
          const prop = cur.properties && cur.properties[pIdx];
          cur = prop ? prop.keyNode : null;
        } else if (step.startsWith('e')) {
          const eIdx = parseInt(step.slice(1), 10);
          cur = cur.elements && cur.elements[eIdx];
        }
      }
      return cur;
    }

    function getPropByPath(root, path) {
      const parts = path.split('.');
      const last = parts[parts.length - 1];
      const parentPath = parts.slice(0, -1).join('.');
      const parent = getNodeByPath(root, parentPath);
      if (!parent || parent.kind !== 'object') return null;
      const idx = parseInt(last.slice(1), 10);
      return { parent, prop: parent.properties[idx], index: idx, parentPath };
    }

    function makePositionalAriaLabel(rowNum, colNum) {
      const r = Number.isFinite(rowNum) && rowNum >= 1 ? rowNum : 1;
      const c = Number.isFinite(colNum) && colNum >= 1 ? colNum : 1;
      return `Hàng ${r}, cột ${c} · Row ${r}, column ${c}`;
    }

    function renderPrimitiveCellHtml(node, path, cellOpts) {
      cellOpts = cellOpts || {};
      const posLabel = makePositionalAriaLabel(cellOpts.rowNum, cellOpts.colNum);
      if (!node) {
        if (!readOnlyCard && cellOpts.missingObjPath && cellOpts.missingColIndex != null) {
          return `<button type="button" class="json-cell-btn v-null" data-json-act="init-missing" data-obj-path="${esc(cellOpts.missingObjPath)}" data-arr-path="${esc(cellOpts.missingArrPath || 'root')}" data-col-index="${Number(cellOpts.missingColIndex)}" aria-label="${esc(posLabel)}" title="Nhấp để thêm trường · Click to add field">—</button>`;
        }
        return '<span class="v-null">—</span>';
      }

      const isKeyCell = !!cellOpts.isKey;
      const isReadOnlyString = node.kind === 'string' && (node.hasLoneSurrogate || node.hasCarriageReturn);
      if (isReadOnlyString) {
        renderedHasReadOnlyCells = true;
        const displaySafe = node.hasLoneSurrogate
          ? Array.from(node.value).map((ch) => {
              const c = ch.charCodeAt(0);
              return (c >= 0xd800 && c <= 0xdfff) ? `\\u${c.toString(16).padStart(4, '0')}` : ch;
            }).join('')
          : node.value.replace(/\r/g, '\\r');
        return `<span class="json-cell-readonly" tabindex="0" role="textbox" aria-readonly="true" aria-label="${esc(posLabel)}" aria-describedby="${esc(readOnlyNoteId)}">${esc(displaySafe)}</span>`;
      }

      if (!readOnlyCard && activeEditCellKey === path) {
        const isMultiline = node.kind === 'string' && node.value.includes('\n');
        const inputControl = isMultiline
          ? `<textarea rows="2" class="json-cell-input" data-json-edit-input="${esc(path)}" aria-label="${esc(posLabel)}" data-vault-secret spellcheck="false" autocomplete="off" autocorrect="off" autocapitalize="off"></textarea>`
          : `<input type="text" class="json-cell-input" data-json-edit-input="${esc(path)}" aria-label="${esc(posLabel)}" data-vault-secret spellcheck="false" autocomplete="off" autocorrect="off" autocapitalize="off">`;

        const typeSelector = !isKeyCell ? `
          <label class="inline-flex items-center gap-1 text-[12px] text-muted">
            <span>Kiểu · <span lang="en">Type</span></span>
            <select class="json-type-btn" data-json-type-select="${esc(path)}" aria-label="Đổi kiểu ô · Change cell type">
              <option value="string" ${node.kind === 'string' ? 'selected' : ''}>string</option>
              <option value="number" ${node.kind === 'number' ? 'selected' : ''}>number</option>
              <option value="true" ${node.kind === 'boolean' && node.value === true ? 'selected' : ''}>true</option>
              <option value="false" ${node.kind === 'boolean' && node.value === false ? 'selected' : ''}>false</option>
              <option value="null" ${node.kind === 'null' ? 'selected' : ''}>null</option>
              <option value="object">object ({})</option>
              <option value="array">array ([])</option>
            </select>
          </label>` : '';

        const replaceHint = !isKeyCell
          ? `<p class="text-[11px] text-muted m-0">Chọn <span class="mono">object</span> hoặc <span class="mono">array</span> sẽ thay thế giá trị hiện tại của ô. · <span lang="en">Choosing <span class="mono">object</span> or <span class="mono">array</span> replaces the current cell value.</span></p>`
          : '';
        const errHtml = activeCellError ? `<p role="alert" class="field-error mt-1 mb-0 text-[12px]">${esc(activeCellError)}</p>` : '';
        return `<div class="json-cell-edit-wrap" data-json-active-editor="${esc(path)}">
          <div class="flex flex-wrap items-center gap-1.5">
            ${inputControl}
            ${typeSelector}
            <button type="button" class="btn btn-primary btn-sm" data-json-act="commit-cell" data-path="${esc(path)}">Lưu ô · <span lang="en">OK</span></button>
            <button type="button" class="btn btn-tertiary btn-sm" data-json-act="cancel-cell" data-path="${esc(path)}">Huỷ · <span lang="en">Esc</span></button>
          </div>
          ${replaceHint}
          ${errHtml}
        </div>`;
      }

      let valSpan = '';
      if (node.kind === 'number') {
        valSpan = `<span class="v-num" title="Giữ nguyên chữ số nguồn · Verbatim number lexeme">${esc(node.lexeme)}</span>`;
      } else if (node.kind === 'boolean') {
        valSpan = `<span class="v-bool">${esc(node.raw)}</span>`;
      } else if (node.kind === 'null') {
        valSpan = `<span class="v-null">null</span>`;
      } else {
        valSpan = `<span>${esc(node.value)}</span>`;
      }

      if (readOnlyCard) return valSpan;

      return `<button type="button" class="json-cell-btn" data-json-act="edit-cell" data-path="${esc(path)}" aria-label="${esc(posLabel)}" title="Nhấp để sửa · Click to edit">${valSpan}</button>`;
    }

    function renderCellHtml(node, path, cellOpts) {
      if (!node) return renderPrimitiveCellHtml(null, path, cellOpts);
      if (node.kind !== 'object' && node.kind !== 'array') {
        return renderPrimitiveCellHtml(node, path, cellOpts);
      }
      const isOpen = openContainers.has(path);
      const count = node.kind === 'array' ? node.elements.length : node.properties.length;
      const labelVi = node.kind === 'array' ? `${count} phần tử` : `${count} khoá`;
      const labelEn = node.kind === 'array' ? `${count} items` : `${count} keys`;
      /* Lazy chevron: child DOM is ONLY constructed when isOpen is true */
      const innerDom = isOpen ? `<div class="json-nest">${renderNodeTableHtml(node, path)}</div>` : '';
      return `<button type="button" class="json-toggle" aria-expanded="${isOpen ? 'true' : 'false'}" data-json-act="toggle-nest" data-path="${esc(path)}">
        <span class="caret">›</span><span>${labelVi} · <span lang="en" class="text-muted">${labelEn}</span></span>
      </button>${innerDom}`;
    }

    function renderPaginationBar(path, totalRows, page) {
      const totalPages = Math.max(1, Math.ceil(totalRows / JSON_TABLE_PAGE_SIZE));
      if (totalRows <= JSON_TABLE_PAGE_SIZE) return '';
      const startRow = (page - 1) * JSON_TABLE_PAGE_SIZE + 1;
      const endRow = Math.min(totalRows, page * JSON_TABLE_PAGE_SIZE);
      return `<div class="json-page-bar" data-json-pagination="${esc(path)}">
        <span>Hàng ${startRow}–${endRow} / ${totalRows} (50 hàng/trang) · <span lang="en">Rows ${startRow}–${endRow} of ${totalRows} (50/page)</span></span>
        <div class="flex items-center gap-1.5">
          <button type="button" class="btn btn-tertiary btn-sm" data-json-act="page-prev" data-path="${esc(path)}" ${page <= 1 ? 'disabled' : ''}>‹ Trang trước · <span lang="en">Prev</span></button>
          <span class="mono">Trang ${page}/${totalPages}</span>
          <button type="button" class="btn btn-tertiary btn-sm" data-json-act="page-next" data-path="${esc(path)}" ${page >= totalPages ? 'disabled' : ''}>Trang sau › · <span lang="en">Next</span></button>
        </div>
      </div>`;
    }

    function renderContainerToolbar(node, path) {
      if (readOnlyCard) return '';
      if (node.kind === 'object') {
        if (activeAddFormPath === path) {
          const errHtml = activeAddKeyError ? `<span role="alert" class="text-[12px] text-error-ink font-medium">${esc(activeAddKeyError)}</span>` : '';
          return `<div class="json-table-toolbar" data-json-add-field-form="${esc(path)}">
            <input type="text" class="json-cell-input !w-[192px] shrink-0" data-json-new-key="${esc(path)}" placeholder="Tên khoá mới · New key" data-vault-secret spellcheck="false" autocomplete="off" autocorrect="off" autocapitalize="off">
            <select class="json-type-btn" data-json-new-type="${esc(path)}" aria-label="Kiểu giá trị mới · New value type">
              <option value="string">string ("")</option>
              <option value="number">number (0)</option>
              <option value="true">true</option>
              <option value="false">false</option>
              <option value="null" selected>null</option>
              <option value="object">object ({})</option>
              <option value="array">array ([])</option>
            </select>
            <button type="button" class="btn btn-primary btn-sm" data-json-act="confirm-add-field" data-path="${esc(path)}">Thêm · <span lang="en">Add</span></button>
            <button type="button" class="btn btn-tertiary btn-sm" data-json-act="cancel-add-field" data-path="${esc(path)}">Huỷ · <span lang="en">Cancel</span></button>
            ${errHtml}
          </div>`;
        }
        return `<div class="json-table-toolbar">
          <button type="button" class="btn btn-tertiary btn-sm" data-json-act="open-add-field" data-path="${esc(path)}">+ Thêm trường · <span lang="en">Add field</span></button>
        </div>`;
      }
      if (node.kind === 'array') {
        return `<div class="json-table-toolbar">
          <button type="button" class="btn btn-tertiary btn-sm" data-json-act="add-row" data-path="${esc(path)}">+ Thêm hàng · <span lang="en">Add row</span></button>
        </div>`;
      }
      return '';
    }

    function renderObjectTableHtml(objNode, path) {
      const props = objNode.properties;
      const totalRows = props.length;
      const totalPages = Math.max(1, Math.ceil(totalRows / JSON_TABLE_PAGE_SIZE));
      const page = Math.min(Math.max(1, pageByNodePath.get(path) || 1), totalPages);
      const start = (page - 1) * JSON_TABLE_PAGE_SIZE;
      const end = Math.min(totalRows, start + JSON_TABLE_PAGE_SIZE);

      if (totalRows === 0) {
        return `<div class="p-3 text-[13px] text-muted mono">Object rỗng <span class="mono">{}</span> · <span lang="en">Empty object</span></div>` + renderContainerToolbar(objNode, path);
      }

      let rowsHtml = '';
      for (let i = start; i < end; i++) {
        const p = props[i];
        const rowNum = i + 1;
        const keyPath = `${path}.k${i}`;
        const valPath = `${path}.p${i}`;
        const occBadge = p.occurrenceIndex >= 1
          ? `<span class="k-occ" aria-label="Lần xuất hiện thứ ${p.occurrenceIndex + 1} · Occurrence ${p.occurrenceIndex + 1}">⁽${toSuperscriptNum(p.occurrenceIndex + 1)}⁾</span>`
          : '';
        const delBtn = !readOnlyCard
          ? `<td class="w-[44px] text-right json-col-act"><button type="button" class="btn btn-tertiary btn-sm !px-2 !py-0.5 text-muted" data-json-act="remove-field" data-path="${esc(path)}" data-prop-idx="${i}" aria-label="Xoá hàng ${rowNum} · Remove row ${rowNum}" title="Xoá hàng · Remove row">×</button></td>`
          : '';
        rowsHtml += `<tr>
          <td class="k">${renderPrimitiveCellHtml(p.keyNode, keyPath, { isKey: true, rowNum, colNum: 1 })}${occBadge}</td>
          <td>${renderCellHtml(p.valueNode, valPath, { rowNum, colNum: 2 })}</td>
          ${delBtn}
        </tr>`;
      }

      return `<table class="json-table"><tbody>${rowsHtml}</tbody></table>` +
        renderPaginationBar(path, totalRows, page) +
        renderContainerToolbar(objNode, path);
    }

    function renderArrayTableHtml(arrNode, path) {
      const elements = arrNode.elements;
      const totalRows = elements.length;
      const totalPages = Math.max(1, Math.ceil(totalRows / JSON_TABLE_PAGE_SIZE));
      const page = Math.min(Math.max(1, pageByNodePath.get(path) || 1), totalPages);
      const start = (page - 1) * JSON_TABLE_PAGE_SIZE;
      const end = Math.min(totalRows, start + JSON_TABLE_PAGE_SIZE);
      const kind = classifyArrayNode(arrNode);

      if (kind === 'empty-array') {
        return `<table class="json-table"><thead><tr><th class="json-col-idx">#</th><th>Giá trị · <span lang="en">Value</span></th></tr></thead><tbody>
          <tr><td colspan="2" class="text-[13px] text-muted">Mảng rỗng <span class="mono">[]</span> (0 phần tử) · <span lang="en">Empty array (0 items)</span></td></tr>
        </tbody></table>` + renderContainerToolbar(arrNode, path);
      }

      if (kind === 'array-of-objects') {
        const { columns, overflowColumnCount } = deriveArrayColumns(arrNode);
        const headCols = columns.map((c) => `<th>${esc(c)}</th>`).join('') +
          (overflowColumnCount > 0 ? `<th>+${overflowColumnCount} cột khác · <span lang="en">more</span></th>` : '') +
          (!readOnlyCard ? '<th class="w-[44px]"></th>' : '');

        let rowsHtml = '';
        for (let i = start; i < end; i++) {
          const rowObj = elements[i];
          const rowNum = i + 1;
          const rowPath = `${path}.e${i}`;
          const delCell = !readOnlyCard
            ? `<td class="w-[44px] text-right json-col-act"><button type="button" class="btn btn-tertiary btn-sm !px-2 !py-0.5 text-muted" data-json-act="remove-row" data-path="${esc(path)}" data-elem-idx="${i}" aria-label="Xoá hàng ${rowNum} · Remove row ${rowNum}" title="Xoá hàng · Remove row">×</button></td>`
            : '';

          if (rowObj.hasDuplicateKeys) {
            const colSpan = Math.max(1, columns.length + (overflowColumnCount > 0 ? 1 : 0));
            rowsHtml += `<tr>
              <td class="k">${rowNum}</td>
              <td colspan="${colSpan}">
                <div class="text-[12px] text-muted mb-1.5 json-dup-row-note">
                  <span class="badge-type badge-warn">khoá trùng · duplicate keys</span>
                  <span>Hàng ${rowNum} có khoá trùng nên hiển thị bảng khoá/giá trị kèm nhãn thứ tự <span class="mono">⁽²⁾</span> để sửa đúng từng occurrence. · <span lang="en">Row ${rowNum} has duplicate keys; shown as field/value with occurrence badges.</span></span>
                </div>
                <div class="json-nest">${renderObjectTableHtml(rowObj, rowPath)}</div>
              </td>
              ${delCell}
            </tr>`;
            continue;
          }

          const propIdxByKey = new Map();
          rowObj.properties.forEach((p, pIdx) => propIdxByKey.set(p.key, pIdx));
          const cellsHtml = columns.map((colKey, colIdx) => {
            const colNum = colIdx + 1;
            const pIdx = propIdxByKey.get(colKey);
            if (pIdx === undefined) {
              return `<td>${renderPrimitiveCellHtml(null, `${rowPath}.missing.${colIdx}`, { missingObjPath: rowPath, missingArrPath: path, missingColIndex: colIdx, rowNum, colNum })}</td>`;
            }
            const prop = rowObj.properties[pIdx];
            return `<td>${renderCellHtml(prop.valueNode, `${rowPath}.p${pIdx}`, { rowNum, colNum })}</td>`;
          }).join('');

          let overflowCell = '';
          if (overflowColumnCount > 0) {
            overflowCell = `<td>${renderCellHtml(rowObj, rowPath, { rowNum, colNum: columns.length + 1 })}</td>`;
          }
          rowsHtml += `<tr><td class="k">${rowNum}</td>${cellsHtml}${overflowCell}${delCell}</tr>`;
        }

        return `<table class="json-table"><thead><tr><th class="json-col-idx">#</th>${headCols}</tr></thead><tbody>${rowsHtml}</tbody></table>` +
          renderPaginationBar(path, totalRows, page) +
          renderContainerToolbar(arrNode, path);
      }

      /* primitive-array or mixed array or array-of-arrays: 2-column # / Value table */
      let rowsHtml = '';
      for (let i = start; i < end; i++) {
        const el = elements[i];
        const rowNum = i + 1;
        const elPath = `${path}.e${i}`;
        const delCell = !readOnlyCard
          ? `<td class="w-[44px] text-right json-col-act"><button type="button" class="btn btn-tertiary btn-sm !px-2 !py-0.5 text-muted" data-json-act="remove-row" data-path="${esc(path)}" data-elem-idx="${i}" aria-label="Xoá hàng ${rowNum} · Remove row ${rowNum}" title="Xoá hàng · Remove row">×</button></td>`
          : '';
        rowsHtml += `<tr><td class="k">${rowNum}</td><td>${renderCellHtml(el, elPath, { rowNum, colNum: 1 })}</td>${delCell}</tr>`;
      }
      return `<table class="json-table"><thead><tr><th class="json-col-idx">#</th><th>Giá trị · <span lang="en">Value</span></th>${!readOnlyCard ? '<th class="w-[44px]"></th>' : ''}</tr></thead><tbody>${rowsHtml}</tbody></table>` +
        renderPaginationBar(path, totalRows, page) +
        renderContainerToolbar(arrNode, path);
    }

    function renderNodeTableHtml(node, path) {
      if (!node) return '';
      if (node.kind === 'object') return renderObjectTableHtml(node, path);
      if (node.kind === 'array') return renderArrayTableHtml(node, path);
      /* Root primitive: 1-row Value table */
      return `<table class="json-table"><thead><tr><th>Giá trị gốc (primitive) · <span lang="en">Root primitive value</span></th></tr></thead><tbody>
        <tr><td>${renderPrimitiveCellHtml(node, path, { rowNum: 1, colNum: 1 })}</td></tr>
      </tbody></table>`;
    }

    function updateEolBanner(eolBanner, eolInfo) {
      if (!eolBanner) return;
      if (!eolInfo.requiresConversionWarning) {
        eolBanner.hidden = true;
        return;
      }
      const targetLabel = eolInfo.majority === 'crlf' ? 'CRLF' : 'LF';
      eolBanner.innerHTML = `<span>Tài liệu có kiểu xuống dòng hỗn hợp; lưu từ ô này sẽ đổi về <strong class="mono">${targetLabel}</strong>.</span> · <span lang="en">Document has mixed line endings; saving from this box will convert to <strong class="mono">${targetLabel}</strong>.</span>`;
      eolBanner.hidden = false;
    }

    function syncRawHost() {
      if (!rawHost) return;
      const ta = rawHost.querySelector('[data-json-raw-textarea]');
      if (ta && document.activeElement !== ta) {
        ta.value = currentSource.replace(/\r\n?/g, '\n');
      } else if (!ta && rawHost.tagName === 'PRE') {
        rawHost.textContent = currentSource;
      }
      const byteEl = rawHost.querySelector('[data-json-raw-bytes]');
      if (byteEl) {
        const b = measureUtf8Bytes(currentSource);
        byteEl.textContent = `${formatByteCountVi(b)} / 262.144 B`;
      }
      const eolBanner = rawHost.querySelector('[data-json-eol-warning]');
      if (eolBanner) {
        const eolInfo = detectEol(currentSource);
        updateEolBanner(eolBanner, eolInfo);
      }
    }

    function describeElementFocusTarget(el) {
      if (!el || !tableHost.contains(el)) return null;
      if (el.dataset && el.dataset.jsonEditInput) {
        return { kind: 'edit-input', path: el.dataset.jsonEditInput };
      }
      if (el.dataset && el.dataset.jsonTypeSelect) {
        return { kind: 'type-select', path: el.dataset.jsonTypeSelect };
      }
      if (el.dataset && el.dataset.jsonNewKey) {
        return { kind: 'new-key', path: el.dataset.jsonNewKey };
      }
      if (el.dataset && el.dataset.jsonNewType) {
        return { kind: 'new-type', path: el.dataset.jsonNewType };
      }
      if (el.classList && el.classList.contains('json-cell-readonly') && el.getAttribute('aria-label')) {
        return { kind: 'readonly', label: el.getAttribute('aria-label') };
      }
      const actBtn = el.closest('[data-json-act]');
      if (actBtn) {
        return {
          kind: 'act',
          act: actBtn.dataset.jsonAct,
          path: actBtn.dataset.path || '',
          propIdx: actBtn.dataset.propIdx,
          elemIdx: actBtn.dataset.elemIdx,
          objPath: actBtn.dataset.objPath,
          colIndex: actBtn.dataset.colIndex
        };
      }
      return null;
    }

    function captureFocusTarget() {
      return describeElementFocusTarget(document.activeElement);
    }

    function restoreFocusTarget(focusTarget) {
      if (!focusTarget) return;
      let el = null;
      if (focusTarget.kind === 'edit-input' && focusTarget.path) {
        el = tableHost.querySelector(`[data-json-edit-input="${CSS.escape(focusTarget.path)}"]`) ||
             tableHost.querySelector(`[data-json-act="edit-cell"][data-path="${CSS.escape(focusTarget.path)}"]`);
      } else if (focusTarget.kind === 'type-select' && focusTarget.path) {
        el = tableHost.querySelector(`[data-json-type-select="${CSS.escape(focusTarget.path)}"]`) ||
             tableHost.querySelector(`[data-json-act="edit-cell"][data-path="${CSS.escape(focusTarget.path)}"]`) ||
             tableHost.querySelector(`[data-json-act="toggle-nest"][data-path="${CSS.escape(focusTarget.path)}"]`);
      } else if (focusTarget.kind === 'new-key' && focusTarget.path) {
        el = tableHost.querySelector(`[data-json-new-key="${CSS.escape(focusTarget.path)}"]`) ||
             tableHost.querySelector(`[data-json-act="open-add-field"][data-path="${CSS.escape(focusTarget.path)}"]`);
      } else if (focusTarget.kind === 'new-type' && focusTarget.path) {
        el = tableHost.querySelector(`[data-json-new-type="${CSS.escape(focusTarget.path)}"]`) ||
             tableHost.querySelector(`[data-json-act="open-add-field"][data-path="${CSS.escape(focusTarget.path)}"]`);
      } else if (focusTarget.kind === 'readonly' && focusTarget.label) {
        el = tableHost.querySelector(`.json-cell-readonly[aria-label="${CSS.escape(focusTarget.label)}"]`);
      } else if (focusTarget.kind === 'act') {
        const act = focusTarget.act;
        const p = focusTarget.path;
        if ((act === 'commit-cell' || act === 'cancel-cell') && p) {
          el = tableHost.querySelector(`[data-json-act="edit-cell"][data-path="${CSS.escape(p)}"]`);
        } else if (act === 'confirm-add-field' || act === 'cancel-add-field') {
          el = tableHost.querySelector(`[data-json-act="open-add-field"][data-path="${CSS.escape(p || 'root')}"]`);
        } else if (act === 'remove-field' && p) {
          el = tableHost.querySelector(`[data-json-act="remove-field"][data-path="${CSS.escape(p)}"][data-prop-idx="${CSS.escape(String(focusTarget.propIdx || 0))}"]`) ||
               tableHost.querySelector(`[data-json-act="open-add-field"][data-path="${CSS.escape(p)}"]`);
        } else if (act === 'remove-row' && p) {
          el = tableHost.querySelector(`[data-json-act="remove-row"][data-path="${CSS.escape(p)}"][data-elem-idx="${CSS.escape(String(focusTarget.elemIdx || 0))}"]`) ||
               tableHost.querySelector(`[data-json-act="add-row"][data-path="${CSS.escape(p)}"]`);
        } else if (act === 'init-missing' && focusTarget.objPath != null && focusTarget.colIndex != null) {
          el = tableHost.querySelector(`[data-json-act="init-missing"][data-obj-path="${CSS.escape(focusTarget.objPath)}"][data-col-index="${CSS.escape(String(focusTarget.colIndex))}"]`);
        } else if (p) {
          el = tableHost.querySelector(`[data-json-act="${CSS.escape(act)}"][data-path="${CSS.escape(p)}"]`);
        } else {
          el = tableHost.querySelector(`[data-json-act="${CSS.escape(act)}"]`);
        }
      }
      if (el && typeof el.focus === 'function' && !el.disabled) {
        el.focus();
      }
    }

    function paint(explicitFocusTarget) {
      const prevFocus = explicitFocusTarget !== undefined ? explicitFocusTarget : captureFocusTarget();
      if (state.locked && tableHost.closest('[data-secret]')) {
        tableHost.innerHTML = '';
        return;
      }
      if (!currentDoc) {
        tableHost.innerHTML = `<div class="p-4 text-[13px] text-error-ink">Chưa thể hiển thị bảng vì JSON đang có lỗi cú pháp. Hãy sửa ở tab JSON gốc. · <span lang="en">Cannot render table while JSON is invalid. Fix in Raw JSON tab.</span></div>`;
        return;
      }
      renderedHasReadOnlyCells = false;
      let html = renderNodeTableHtml(currentDoc.root, 'root');
      if (renderedHasReadOnlyCells) {
        html += `<p id="${esc(readOnlyNoteId)}" class="json-readonly-note">
          <span>Ô mờ có ký tự xuống dòng đặc biệt, sửa ở tab JSON gốc</span> ·
          <span lang="en">Dimmed cells contain special line breaks; edit them in the Raw JSON tab</span>
        </p>`;
      }
      tableHost.innerHTML = html;
      if (activeEditCellKey) {
        const inp = tableHost.querySelector(`[data-json-edit-input="${CSS.escape(activeEditCellKey)}"]`);
        const node = getNodeByPath(currentDoc.root, activeEditCellKey);
        if (inp && node) {
          if (node.kind === 'string') inp.value = node.value;
          else if (node.kind === 'number') inp.value = node.lexeme;
          else inp.value = node.raw;
        }
      }
      syncRawHost();
      if (prevFocus) {
        restoreFocusTarget(prevFocus);
      }
    }

    function applySourceSplice(edit, toastMsg, nextFocusTarget) {
      const nextSource = spliceJsonSource(currentSource, edit);
      const nextBytes = measureUtf8Bytes(nextSource);
      if (nextBytes > JSON_MAX_UTF8_BYTES) {
        activeCellError = 'Vượt quá giới hạn 256 KiB (262.144 B UTF-8) · Exceeds 256 KiB limit.';
        paint();
        return false;
      }
      const reparsed = parseJsonStrict(nextSource);
      if (!reparsed.ok) {
        activeCellError = `${reparsed.error.messageVi} (dòng ${reparsed.error.line}, cột ${reparsed.error.column})`;
        paint();
        return false;
      }
      currentSource = nextSource;
      currentDoc = reparsed.document;
      activeEditCellKey = null;
      activeCellError = null;
      activeAddFormPath = null;
      activeAddKeyError = null;
      paint(nextFocusTarget);
      if (toastMsg) toast(toastMsg);
      return true;
    }

    function commitCellEdit(path, opts) {
      opts = opts || {};
      if (!currentDoc || !path || activeEditCellKey !== path) return false;
      const inp = tableHost.querySelector(`[data-json-edit-input="${CSS.escape(path)}"]`);
      const newVal = inp ? inp.value : '';
      const node = getNodeByPath(currentDoc.root, path);
      if (!node) return false;
      const isKey = path.split('.').pop().startsWith('k');
      const focusAfterCommit = opts.focusTarget !== undefined ? opts.focusTarget : (opts.skipFocus ? null : { kind: 'act', act: 'edit-cell', path });

      if (node.kind === 'string') {
        if (node.value === newVal) {
          /* Rule 2: No-op commit = no edit (preserves escapes like \u00e9) */
          activeEditCellKey = null;
          activeCellError = null;
          paint(focusAfterCommit);
          return true;
        }
        if (isKey) {
          const propInfo = getPropByPath(currentDoc.root, path);
          if (propInfo && propInfo.parent.properties.some((p, idx) => idx !== propInfo.index && p.key === newVal)) {
            activeCellError = 'Key đã có trong object · Key already exists in object';
            paint({ kind: 'edit-input', path });
            return false;
          }
        }
        const escaped = escapeJsonStringMinimal(newVal);
        return applySourceSplice({ offset: node.span.start, length: node.span.end - node.span.start, content: escaped }, 'Đã cập nhật ô JSON · Updated JSON cell', focusAfterCommit);
      }
      if (node.kind === 'number') {
        if (node.lexeme === newVal) {
          activeEditCellKey = null;
          activeCellError = null;
          paint(focusAfterCommit);
          return true;
        }
        if (!isValidJsonNumberLexeme(newVal)) {
          activeCellError = 'Số không đúng cú pháp JSON (RFC 8259) · Invalid JSON number lexeme';
          paint({ kind: 'edit-input', path });
          return false;
        }
        return applySourceSplice({ offset: node.span.start, length: node.span.end - node.span.start, content: newVal }, 'Đã cập nhật số (giữ nguyên chữ số) · Updated number lexeme', focusAfterCommit);
      }
      if (node.kind === 'boolean') {
        if (newVal !== 'true' && newVal !== 'false') {
          activeCellError = 'Ô boolean chỉ nhận true hoặc false · Expected true or false';
          paint({ kind: 'edit-input', path });
          return false;
        }
        if (node.raw === newVal) {
          activeEditCellKey = null;
          activeCellError = null;
          paint(focusAfterCommit);
          return true;
        }
        return applySourceSplice({ offset: node.span.start, length: node.span.end - node.span.start, content: newVal }, 'Đã cập nhật ô boolean · Updated boolean cell', focusAfterCommit);
      }
      if (node.kind === 'null') {
        if (newVal !== 'null') {
          activeCellError = 'Đổi kiểu ở menu Kiểu để nhập giá trị khác null · Use Type menu to change from null';
          paint({ kind: 'edit-input', path });
          return false;
        }
        activeEditCellKey = null;
        activeCellError = null;
        paint(focusAfterCommit);
        return true;
      }
      return false;
    }

    let cancelCellPointerDown = false;
    let inTablePointerDown = false;

    const handleTablePointerDown = (e) => {
      const actBtn = e.target.closest('[data-json-act]');
      if (actBtn && actBtn.dataset.jsonAct === 'cancel-cell') {
        cancelCellPointerDown = true;
        inTablePointerDown = true;
      } else if (actBtn || e.target.closest('[data-json-type-select]')) {
        cancelCellPointerDown = false;
        inTablePointerDown = true;
      } else {
        cancelCellPointerDown = false;
        inTablePointerDown = false;
      }
      setTimeout(() => {
        cancelCellPointerDown = false;
        inTablePointerDown = false;
      }, 0);
    };

    tableHost.addEventListener('pointerdown', handleTablePointerDown);
    tableHost.addEventListener('mousedown', handleTablePointerDown);

    function submitAddField(path) {
      const keyInp = tableHost.querySelector(`[data-json-new-key="${CSS.escape(path)}"]`);
      const typeSel = tableHost.querySelector(`[data-json-new-type="${CSS.escape(path)}"]`);
      const newKey = keyInp ? keyInp.value.trim() : '';
      const newType = typeSel ? typeSel.value : 'null';
      const objNode = getNodeByPath(currentDoc.root, path);
      if (!objNode || objNode.kind !== 'object') return false;
      if (!newKey) {
        activeAddKeyError = 'Nhập tên khoá · Enter a key name';
        paint({ kind: 'new-key', path });
        return false;
      }
      if (objNode.properties.some((p) => p.key === newKey)) {
        activeAddKeyError = 'Key đã có · Key already exists';
        paint({ kind: 'new-key', path });
        return false;
      }
      const valLex = newType === 'string' ? '""'
        : newType === 'number' ? '0'
        : newType === 'true' ? 'true'
        : newType === 'false' ? 'false'
        : newType === 'object' ? '{}'
        : newType === 'array' ? '[]'
        : 'null';
      const propText = `${escapeJsonStringMinimal(newKey)}: ${valLex}`;
      const edit = computeInsertionSpan(currentSource, objNode.span, objNode.properties, objNode.properties.length, propText);
      return applySourceSplice(edit, 'Đã thêm trường · Added field', { kind: 'act', act: 'open-add-field', path });
    }

    tableHost.addEventListener('click', (e) => {
      cancelCellPointerDown = false;
      inTablePointerDown = false;
      const btn = e.target.closest('[data-json-act]');
      if (!btn || !currentDoc) return;
      const act = btn.dataset.jsonAct;
      const path = btn.dataset.path;

      /* S3RV2-2: commit any open cell editor in the target control's own click handler so focusout does not swallow the first click */
      if (activeEditCellKey && act !== 'commit-cell' && act !== 'cancel-cell') {
        if (act !== 'edit-cell' || activeEditCellKey !== path) {
          if (!commitCellEdit(activeEditCellKey, { skipFocus: true })) {
            return;
          }
        }
      }
      if (act === 'toggle-nest') {
        e.stopPropagation();
        if (openContainers.has(path)) openContainers.delete(path);
        else openContainers.add(path);
        paint({ kind: 'act', act: 'toggle-nest', path });
        return;
      }
      if (act === 'page-prev' || act === 'page-next') {
        const cur = pageByNodePath.get(path) || 1;
        pageByNodePath.set(path, act === 'page-prev' ? Math.max(1, cur - 1) : cur + 1);
        paint({ kind: 'act', act, path });
        return;
      }
      if (act === 'edit-cell') {
        activeEditCellKey = path;
        activeCellError = null;
        paint({ kind: 'edit-input', path });
        const inp = tableHost.querySelector(`[data-json-edit-input="${CSS.escape(path)}"]`);
        if (inp) { inp.focus(); if (inp.select) inp.select(); }
        return;
      }
      if (act === 'cancel-cell') {
        const cancelPath = path || activeEditCellKey;
        activeEditCellKey = null;
        activeCellError = null;
        paint(cancelPath ? { kind: 'act', act: 'edit-cell', path: cancelPath } : undefined);
        return;
      }
      if (act === 'commit-cell') {
        commitCellEdit(path || activeEditCellKey);
        return;
      }
      if (act === 'init-missing') {
        const objPath = btn.dataset.objPath;
        const arrPath = btn.dataset.arrPath || 'root';
        const colIdx = parseInt(btn.dataset.colIndex, 10);
        const arrNode = getNodeByPath(currentDoc.root, arrPath);
        const objNode = getNodeByPath(currentDoc.root, objPath);
        if (!objNode || objNode.kind !== 'object' || !arrNode || arrNode.kind !== 'array' || isNaN(colIdx)) return;
        const { columns } = deriveArrayColumns(arrNode);
        const colKey = columns[colIdx];
        if (colKey === undefined) return;
        const propText = `${escapeJsonStringMinimal(colKey)}: ""`;
        const edit = computeInsertionSpan(currentSource, objNode.span, objNode.properties, objNode.properties.length, propText);
        if (applySourceSplice(edit)) {
          const updatedObj = getNodeByPath(currentDoc.root, objPath);
          if (updatedObj && updatedObj.properties.length) {
            const newCellPath = `${objPath}.p${updatedObj.properties.length - 1}`;
            activeEditCellKey = newCellPath;
            paint({ kind: 'edit-input', path: newCellPath });
            const inp = tableHost.querySelector(`[data-json-edit-input="${CSS.escape(newCellPath)}"]`);
            if (inp) { inp.focus(); if (inp.select) inp.select(); }
          }
        }
        return;
      }
      if (act === 'open-add-field') {
        activeAddFormPath = path;
        activeAddKeyError = null;
        paint({ kind: 'new-key', path });
        const keyInp = tableHost.querySelector(`[data-json-new-key="${CSS.escape(path)}"]`);
        if (keyInp) keyInp.focus();
        return;
      }
      if (act === 'cancel-add-field') {
        const p = path || activeAddFormPath || 'root';
        activeAddFormPath = null;
        activeAddKeyError = null;
        paint({ kind: 'act', act: 'open-add-field', path: p });
        return;
      }
      if (act === 'confirm-add-field') {
        submitAddField(path);
        return;
      }
      if (act === 'remove-field') {
        const propIdx = parseInt(btn.dataset.propIdx, 10);
        const objNode = getNodeByPath(currentDoc.root, path);
        if (!objNode || objNode.kind !== 'object' || isNaN(propIdx)) return;
        const edit = computeRemovalSpan(currentSource, objNode.span, objNode.properties, propIdx);
        const nextIdx = Math.max(0, Math.min(propIdx, objNode.properties.length - 2));
        applySourceSplice(edit, 'Đã xoá trường · Removed field', { kind: 'act', act: 'remove-field', path, propIdx: nextIdx });
        return;
      }
      if (act === 'add-row') {
        const arrNode = getNodeByPath(currentDoc.root, path);
        if (!arrNode || arrNode.kind !== 'array') return;
        let itemLex = 'null';
        if (classifyArrayNode(arrNode) === 'array-of-objects') {
          const { columns } = deriveArrayColumns(arrNode);
          itemLex = columns.length ? `{ ${columns.map((c) => `${escapeJsonStringMinimal(c)}: null`).join(', ')} }` : '{}';
        }
        const edit = computeInsertionSpan(currentSource, arrNode.span, arrNode.elements, arrNode.elements.length, itemLex);
        applySourceSplice(edit, 'Đã thêm hàng mới · Added new row', { kind: 'act', act: 'add-row', path });
        return;
      }
      if (act === 'remove-row') {
        const elemIdx = parseInt(btn.dataset.elemIdx, 10);
        const arrNode = getNodeByPath(currentDoc.root, path);
        if (!arrNode || arrNode.kind !== 'array' || isNaN(elemIdx)) return;
        const edit = computeRemovalSpan(currentSource, arrNode.span, arrNode.elements, elemIdx);
        const nextIdx = Math.max(0, Math.min(elemIdx, arrNode.elements.length - 2));
        applySourceSplice(edit, 'Đã xoá hàng · Removed row', { kind: 'act', act: 'remove-row', path, elemIdx: nextIdx });
      }
    });

    tableHost.addEventListener('change', (e) => {
      const sel = e.target.closest('[data-json-type-select]');
      if (!sel || !currentDoc) return;
      const path = sel.dataset.jsonTypeSelect;
      const targetType = sel.value;
      const node = getNodeByPath(currentDoc.root, path);
      if (!node) return;
      const inp = tableHost.querySelector(`[data-json-edit-input="${CSS.escape(path)}"]`);
      const typedText = inp ? inp.value : null;
      let lex = 'null';
      if (targetType === 'string') {
        if (typedText != null && typedText !== '') {
          lex = escapeJsonStringMinimal(typedText);
        } else if (node.kind === 'number') {
          lex = escapeJsonStringMinimal(node.lexeme);
        } else if (node.kind === 'boolean') {
          lex = escapeJsonStringMinimal(node.raw);
        } else if (node.kind === 'string') {
          lex = escapeJsonStringMinimal(node.value);
        } else {
          lex = '""';
        }
      } else if (targetType === 'number') {
        if (typedText != null && isValidJsonNumberLexeme(typedText)) {
          lex = typedText;
        } else if (node.kind === 'string' && isValidJsonNumberLexeme(node.value)) {
          lex = node.value;
        } else if (node.kind === 'number') {
          lex = node.lexeme;
        } else {
          lex = '0';
        }
      } else if (targetType === 'true') {
        lex = 'true';
      } else if (targetType === 'false') {
        lex = 'false';
      } else if (targetType === 'object') {
        lex = '{}';
        openContainers.add(path);
      } else if (targetType === 'array') {
        lex = '[]';
        openContainers.add(path);
      }
      const nextFocus = (targetType === 'object' || targetType === 'array')
        ? { kind: 'act', act: 'toggle-nest', path }
        : { kind: 'act', act: 'edit-cell', path };
      applySourceSplice({ offset: node.span.start, length: node.span.end - node.span.start, content: lex }, `Đã đổi kiểu sang ${targetType} · Changed type to ${targetType}`, nextFocus);
    });

    tableHost.addEventListener('keydown', (e) => {
      const newKeyEl = e.target.closest('[data-json-new-key], [data-json-new-type]');
      if (newKeyEl) {
        const addPath = newKeyEl.dataset.jsonNewKey || newKeyEl.dataset.jsonNewType || activeAddFormPath || 'root';
        if (e.key === 'Escape') {
          e.preventDefault();
          activeAddFormPath = null;
          activeAddKeyError = null;
          paint({ kind: 'act', act: 'open-add-field', path: addPath });
        } else if (e.key === 'Enter') {
          e.preventDefault();
          submitAddField(addPath);
        }
        return;
      }
      const inp = e.target.closest('[data-json-edit-input]');
      if (!inp) return;
      const path = inp.dataset.jsonEditInput;
      if (e.key === 'Escape') {
        e.preventDefault();
        activeEditCellKey = null;
        activeCellError = null;
        paint({ kind: 'act', act: 'edit-cell', path });
      } else if (e.key === 'Enter') {
        if (inp.tagName === 'TEXTAREA' && e.shiftKey) {
          /* Shift+Enter inserts a newline in multiline string cells */
          return;
        }
        e.preventDefault();
        commitCellEdit(path);
      }
    });

    tableHost.addEventListener('focusout', (e) => {
      const wrap = e.target.closest('[data-json-active-editor]');
      if (!wrap) return;
      const path = wrap.dataset.jsonActiveEditor;
      if (!path || activeEditCellKey !== path) return;
      if (vaultTogglePointerDown) return;
      if (cancelCellPointerDown || inTablePointerDown) {
        return;
      }
      const next = e.relatedTarget;
      if (next && wrap.contains(next)) return;
      /* S3RV3-2: keyboard Tab/Shift+Tab to another control inside tableHost commits and restores focus on that control */
      if (next && tableHost.contains(next)) {
        const nextTarget = describeElementFocusTarget(next);
        commitCellEdit(path, { focusTarget: nextTarget, skipFocus: !nextTarget });
        return;
      }
      commitCellEdit(path, { skipFocus: true });
    });

    /* Wire Raw JSON editor panel if rawHost is an interactive container */
    if (rawHost && rawHost.dataset.jsonRawInteractive === '1') {
      const ta = rawHost.querySelector('[data-json-raw-textarea]');
      const saveBtn = rawHost.querySelector('[data-json-raw-save]');
      const formatBtn = rawHost.querySelector('[data-json-raw-format]');
      const errBox = rawHost.querySelector('[data-json-raw-error]');
      const eolWarn = rawHost.querySelector('[data-json-eol-warning]');
      const formatMsgEl = rawHost.querySelector('[data-json-format-msg]');

      function setRawInvalidState(isInvalid) {
        if (!ta) return;
        if (isInvalid) {
          ta.setAttribute('aria-invalid', 'true');
          if (errBox && errBox.id) ta.setAttribute('aria-describedby', errBox.id);
        } else {
          ta.removeAttribute('aria-invalid');
          if (errBox && errBox.id && ta.getAttribute('aria-describedby') === errBox.id) {
            ta.removeAttribute('aria-describedby');
          }
        }
      }

      function validateRawDraft() {
        if (!ta) return;
        const draft = ta.value;
        const bytes = measureUtf8Bytes(draft);
        const byteEl = rawHost.querySelector('[data-json-raw-bytes]');
        if (byteEl) byteEl.textContent = `${formatByteCountVi(bytes)} / 262.144 B`;

        if (!isWellFormedUtf16(draft)) {
          if (errBox) {
            errBox.hidden = false;
            errBox.innerHTML = `<strong>Chuỗi chứa lone surrogate (UTF-16 không hợp lệ)</strong> — Không thể mã hoá UTF-8. · <span lang="en">Input contains an unpaired UTF-16 surrogate and cannot be encoded as UTF-8.</span>`;
          }
          setRawInvalidState(true);
          if (saveBtn) saveBtn.disabled = true;
          if (formatBtn) formatBtn.disabled = true;
          return;
        }
        if (bytes > JSON_MAX_UTF8_BYTES) {
          if (errBox) {
            errBox.hidden = false;
            errBox.innerHTML = `<strong>Nội dung vượt quá 256 KiB (262.144 B UTF-8; 413 entry_too_large).</strong> Hãy rút gọn trước khi lưu. · <span lang="en">Exceeds 256 KiB (262,144 UTF-8 bytes). Shorten before saving.</span>`;
          }
          setRawInvalidState(true);
          if (saveBtn) saveBtn.disabled = true;
          if (formatBtn) formatBtn.disabled = true;
          return;
        }
        const res = parseJsonStrict(draft);
        if (!res.ok) {
          lastRawErrorOffset = res.error.offset || 0;
          if (errBox) {
            errBox.hidden = false;
            errBox.innerHTML = `<div class="flex flex-wrap items-center justify-between gap-2">
              <div>
                <p class="font-semibold m-0 mb-0.5">JSON không hợp lệ — Dòng ${res.error.line}, cột ${res.error.column} (offset ${res.error.offset})</p>
                <p class="m-0">${esc(res.error.messageVi)} · <span lang="en">${esc(res.error.messageEn)}</span></p>
              </div>
              <button type="button" class="btn btn-tertiary btn-sm" data-json-raw-goto>Đi tới lỗi · <span lang="en">Go to error</span></button>
            </div>`;
          }
          setRawInvalidState(true);
          if (saveBtn) saveBtn.disabled = true;
          if (formatBtn) formatBtn.disabled = true;
        } else {
          if (errBox) errBox.hidden = true;
          setRawInvalidState(false);
          if (saveBtn) saveBtn.disabled = false;
          if (formatBtn) formatBtn.disabled = false;
        }
      }
      validateRawDraftFn = validateRawDraft;

      if (errBox && ta) {
        errBox.addEventListener('click', (e) => {
          const gotoBtn = e.target.closest('[data-json-raw-goto]');
          if (!gotoBtn) return;
          const normText = ta.value;
          const pos = Math.max(0, Math.min(mapSourceOffsetToLfOffset(normText, lastRawErrorOffset), normText.length));
          ta.focus();
          ta.setSelectionRange(pos, Math.min(pos + 1, normText.length));
        });
      }

      function triggerRawSave() {
        if (!ta || (saveBtn && saveBtn.disabled)) return;
        const normDraft = ta.value.replace(/\r\n?/g, '\n');
        const normSource = currentSource.replace(/\r\n?/g, '\n');
        if (normDraft === normSource) {
          /* Plan 2.10 EOL rule 2: normalized draft unchanged -> keep original source bytes untouched, no PUT */
          eolConfirmPending = false;
          toast('Không có thay đổi (giữ nguyên chuỗi nguồn) · No changes (source bytes kept)');
          return;
        }
        const eolInfo = detectEol(currentSource);
        if (eolInfo.requiresConversionWarning && !eolConfirmPending) {
          eolConfirmPending = true;
          updateEolBanner(eolWarn, eolInfo);
          toast('Xác nhận chuẩn hoá xuống dòng (EOL) trước khi lưu · Confirm EOL normalization before saving');
          return;
        }
        eolConfirmPending = false;
        const targetSeq = eolInfo.majoritySeq;
        const nextSrc = normDraft.replace(/\n/g, targetSeq);
        const reparsed = parseJsonStrict(nextSrc);
        if (!reparsed.ok) {
          validateRawDraft();
          return;
        }
        currentSource = nextSrc;
        currentDoc = reparsed.document;
        paint();
        toast('Đã lưu JSON gốc · Saved Raw JSON');
      }

      if (ta) {
        ta.value = state.locked ? '' : currentSource.replace(/\r\n?/g, '\n');
        ta.addEventListener('input', () => {
          if (formatMsgEl) formatMsgEl.hidden = true;
          validateRawDraft();
        });
        ta.addEventListener('keydown', (e) => {
          if ((e.key || '').toLowerCase() === 's' && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            triggerRawSave();
          }
        });
      }

      if (formatBtn && ta) {
        formatBtn.addEventListener('click', () => {
          const eolInfo = detectEol(currentSource);
          const fmtRes = formatJsonStrict(ta.value, { eol: eolInfo.majority });
          if (!fmtRes.ok) {
            if (formatMsgEl) {
              formatMsgEl.hidden = false;
              if (fmtRes.code === 'DEPTH_LIMIT_EXCEEDED') {
                formatMsgEl.innerHTML = `Từ chối định dạng: độ sâu lồng nhau vượt quá ${JSON_FORMAT_MAX_DEPTH} cấp (an toàn bộ nhớ). Nội dung gốc được giữ nguyên. · <span lang="en">Formatting refused: nesting depth exceeds ${JSON_FORMAT_MAX_DEPTH} levels. Original text kept intact.</span>`;
              } else if (fmtRes.code === 'BYTE_LIMIT_EXCEEDED') {
                formatMsgEl.innerHTML = `Từ chối định dạng: kết quả sau khi thêm khoảng trắng sẽ vượt quá 256 KiB (${formatByteCountVi(fmtRes.byteLength)} / 262.144 B). Nội dung gốc được giữ nguyên. · <span lang="en">Formatting refused: formatted output would exceed 256 KiB (${formatByteCountVi(fmtRes.byteLength)} / 262,144 B). Original text kept intact.</span>`;
              } else {
                formatMsgEl.innerHTML = `Không thể định dạng khi JSON đang lỗi cú pháp. · <span lang="en">Cannot format invalid JSON.</span>`;
              }
            }
            return;
          }
          /* S3RV1-23: Format only rewrites the textarea draft; Save commits to currentSource */
          ta.value = fmtRes.text.replace(/\r\n?/g, '\n');
          if (formatMsgEl) formatMsgEl.hidden = true;
          validateRawDraft();
          toast('Đã định dạng bản nháp JSON (chỉ đổi khoảng trắng ngoài chuỗi) · Formatted JSON draft (whitespace only)');
        });
      }

      if (saveBtn && ta) {
        saveBtn.addEventListener('click', triggerRawSave);
      }

      /* Plan 2.10 EOL rule 5: switching from Raw tab to Table tab applies valid edited text as new source with re-applied EOL */
      const cardScope = tableHost.closest('[data-seg-scope]');
      if (cardScope && ta) {
        const cardSeg = cardScope.querySelector('[data-seg]');
        if (cardSeg) {
          cardSeg.addEventListener('click', (e) => {
            const segBtn = e.target.closest('button[data-target]');
            if (!segBtn) return;
            const targetView = segBtn.dataset.target;
            if (targetView && tableHost.dataset.view === targetView) {
              const normDraft = ta.value.replace(/\r\n?/g, '\n');
              const normSource = currentSource.replace(/\r\n?/g, '\n');
              if (normDraft !== normSource && isWellFormedUtf16(normDraft) && measureUtf8Bytes(normDraft) <= JSON_MAX_UTF8_BYTES) {
                const eolInfo = detectEol(currentSource);
                const nextSrc = normDraft.replace(/\n/g, eolInfo.majoritySeq);
                const reparsed = parseJsonStrict(nextSrc);
                if (reparsed.ok) {
                  currentSource = nextSrc;
                  currentDoc = reparsed.document;
                  paint();
                }
              }
            }
          });
        }
      }

      /* Simulation buttons for Raw JSON states (mixed EOL, format > 256 KiB, format > depth, invalid JSON) */
      rawHost.querySelectorAll('[data-json-raw-sim]').forEach((simBtn) => {
        simBtn.addEventListener('click', () => {
          const mode = simBtn.dataset.jsonRawSim;
          eolConfirmPending = false;
          if (mode === 'valid') {
            currentSource = config.initialSource;
            const p = parseJsonStrict(currentSource);
            if (p.ok) currentDoc = p.document;
            if (ta) ta.value = currentSource.replace(/\r\n?/g, '\n');
            if (formatMsgEl) formatMsgEl.hidden = true;
            if (eolWarn) eolWarn.hidden = true;
            validateRawDraft();
            paint();
          } else if (mode === 'syntax-error') {
            if (ta) {
              ta.value = `{\n  "ssid": "Zone17th-5G",\n  "channel": 36\n  "wpa": 3\n}`;
              validateRawDraft();
            }
          } else if (mode === 'mixed-eol') {
            currentSource = `{\r\n  "ssid": "Zone17th-5G",\n  "band": "5GHz",\r  "channel": 36\r\n}`;
            const p = parseJsonStrict(currentSource);
            if (p.ok) currentDoc = p.document;
            if (ta) ta.value = currentSource.replace(/\r\n?/g, '\n');
            updateEolBanner(eolWarn, detectEol(currentSource));
            validateRawDraft();
          } else if (mode === 'format-over-cap') {
            if (formatMsgEl) {
              formatMsgEl.hidden = false;
              formatMsgEl.innerHTML = `Từ chối định dạng: tài liệu 248.900 B hợp lệ nhưng sau khi thêm xuống dòng và thụt lề 2 dấu cách sẽ thành 274.120 B (&gt; 262.144 B / 256 KiB). Nội dung gốc được giữ nguyên. · <span lang="en">Formatting refused: formatted output (274,120 B) would exceed the 256 KiB (262,144 B) entry limit. Original source preserved.</span>`;
            }
          } else if (mode === 'format-deep') {
            if (formatMsgEl) {
              formatMsgEl.hidden = false;
              formatMsgEl.innerHTML = `Từ chối định dạng: độ sâu lồng nhau (1.024 cấp) vượt quá giới hạn định dạng an toàn (${JSON_FORMAT_MAX_DEPTH} cấp). Nội dung gốc được giữ nguyên. · <span lang="en">Formatting refused: nesting depth (1,024) exceeds maximum formatting depth (${JSON_FORMAT_MAX_DEPTH}). Original source preserved.</span>`;
            }
          }
        });
      });

      validateRawDraft();
    }

    paint();

    const cardController = {
      paint,
      setSource(newSrc, openPaths) {
        currentSource = String(newSrc || '');
        const p = parseJsonStrict(currentSource);
        currentDoc = p.ok ? p.document : null;
        openContainers.clear();
        (openPaths || []).forEach((k) => openContainers.add(k));
        pageByNodePath.clear();
        activeEditCellKey = null;
        activeCellError = null;
        activeAddFormPath = null;
        activeAddKeyError = null;
        eolConfirmPending = false;
        paint();
        if (validateRawDraftFn) {
          const ta = rawHost && rawHost.querySelector('[data-json-raw-textarea]');
          if (ta) ta.value = currentSource.replace(/\r\n?/g, '\n');
          const formatMsgEl = rawHost && rawHost.querySelector('[data-json-format-msg]');
          if (formatMsgEl) formatMsgEl.hidden = true;
          validateRawDraftFn();
        }
      },
      onVaultStateChange(isLocked) {
        activeEditCellKey = null;
        activeCellError = null;
        activeAddFormPath = null;
        activeAddKeyError = null;
        eolConfirmPending = false;
        if (rawHost) {
          const ta = rawHost.querySelector('[data-json-raw-textarea]');
          if (ta) {
            /* Plan 2.10 Lock: drop unsaved raw draft on lock and restore clean source on unlock */
            ta.value = isLocked ? '' : currentSource.replace(/\r\n?/g, '\n');
          }
          const formatMsgEl = rawHost.querySelector('[data-json-format-msg]');
          if (formatMsgEl) formatMsgEl.hidden = true;
        }
        if (isLocked) {
          if (tableHost.closest('[data-secret]')) {
            tableHost.innerHTML = '';
          }
        } else {
          paint();
          if (validateRawDraftFn) validateRawDraftFn();
        }
      },
      getSource() { return currentSource; },
      getDocument() { return currentDoc; }
    };

    jsonCardInstances.push(cardController);
    return cardController;
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
          btn.className = 'vault-pill ' + (state.locked ? 'vault-shut' : 'vault-open') + ' btn-icon !w-[38px] !h-[38px] !p-0 justify-center sm:!w-auto sm:!h-auto sm:!py-1.5 sm:!px-3 [@media(pointer:coarse)]:!h-[44px]';
          // Nhãn ngắn trên mobile: pill nằm trong header chật, không được đẩy tràn.
          btn.setAttribute('aria-label', state.locked ? 'Vault đã khoá · Vault locked' : 'Vault mở · 15 phút · Vault open · 15 min');
          btn.innerHTML = state.locked
            ? '<span aria-hidden="true">🔒</span><span class="hidden sm:inline">Vault đã khoá</span>'
            : '<span aria-hidden="true">🔓</span><span class="hidden sm:inline">Vault mở · 15 phút</span>';
        });
        document.body.classList.toggle('is-locked', state.locked);
        document.querySelectorAll('[data-secret]').forEach((el) => {
          if (state.locked) {
            el.dataset.locked = '1';
            let veil = el.querySelector(':scope > [data-lock-veil]');
            if (!veil) {
              veil = document.createElement('div');
              veil.className = 'lock-veil';
              veil.setAttribute('data-lock-veil', '1');
              veil.textContent = '•••• •••• •••• ••••';
              el.appendChild(veil);
            }
            veil.hidden = false;
          } else if (el.dataset.locked) {
            const veil = el.querySelector(':scope > [data-lock-veil]');
            if (veil) veil.remove();
            delete el.dataset.locked;
          }
        });
        document.querySelectorAll('[data-locked-banner]').forEach((el) => { el.hidden = !state.locked; });
        if (!syncOpts.keepDraftForDemo && prevLocked !== state.locked) {
          omniboxInstances.forEach((inst) => {
            if (inst && typeof inst.onVaultStateChange === 'function') {
              inst.onVaultStateChange(state.locked, prevLocked);
            }
          });
          jsonCardInstances.forEach((cardInst) => {
            if (cardInst && typeof cardInst.onVaultStateChange === 'function') {
              cardInst.onVaultStateChange(state.locked, prevLocked);
            }
          });
        }
        prevLocked = state.locked;
      };
      window.SAK._syncVault = syncVault;
      const markVaultPointerDown = () => {
        vaultTogglePointerDown = true;
        setTimeout(() => { vaultTogglePointerDown = false; }, 0);
      };
      const toggle = () => {
        vaultTogglePointerDown = false;
        state.locked = !state.locked;
        syncVault();
      };
      pills.forEach((b) => {
        b.addEventListener('pointerdown', markVaultPointerDown);
        b.addEventListener('mousedown', markVaultPointerDown);
        b.addEventListener('click', toggle);
      });
      unlockBtns.forEach((b) => {
        b.addEventListener('pointerdown', markVaultPointerDown);
        b.addEventListener('mousedown', markVaultPointerDown);
        b.addEventListener('click', toggle);
      });
      syncVault();
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
    TAGS, ITEMS, SUGGEST_QUOTA, search, searchDemo, parseQuickAdd, initOmnibox, openDupDialog,
    renderJsonTable, initJsonEntryCard, parseJsonStrict, formatJsonStrict,
    detectEol, measureUtf8Bytes, isWellFormedUtf16,
    initChrome, toast, state, norm, normIdentity,
    undoShortcutLabel, isApplePlatform
  };
})();
