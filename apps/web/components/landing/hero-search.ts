import { fold } from '@/lib/demo-search';
import {
  HERO_FIXTURES,
  type HeroItem,
  type HeroTag,
  type LandingLocale,
} from '@/components/landing/landing-fixtures';

/**
 * Tìm kiếm của hero demo trên landing: chỉ lọc fixture cục bộ của landing, trong bộ nhớ.
 * Không I/O, không mạng, không lưu gì. Trả về ba nhóm như mockups/landing.html:
 * Tags → Items → Gần nghĩa. Nhóm gần nghĩa nằm riêng, không xáo thứ tự nhóm khớp chữ.
 */

export type HeroRow =
  | { kind: 'tag'; key: string; tag: HeroTag }
  | { kind: 'item'; key: string; item: HeroItem }
  | { kind: 'near'; key: string; item: HeroItem; score: number };

export interface HeroGroup {
  id: 'tags' | 'items' | 'near';
  rows: HeroRow[];
}

const MAX_TAGS = 5;
const MAX_ITEMS = 6;
const MAX_NEAR = 3;
const EMPTY_TAGS = 4;

/** Bậc khớp chữ: đầu chuỗi (3) > đầu một từ hoặc chứa (2) > không khớp (0). */
function rank(text: string, needle: string): number {
  const folded = fold(text);
  if (folded.startsWith(needle)) return 3;
  if (folded.includes(needle)) return 2;
  return 0;
}

function itemTier(item: HeroItem, needle: string): number {
  const byName = rank(item.name, needle);
  if (byName > 0) return byName;
  if (rank(item.hint, needle) > 0) return 2;
  if (item.tags.some((tag) => rank(tag, needle) > 0)) return 1;
  return 0;
}

function byTier<T>(list: T[], tier: (value: T) => number): T[] {
  return list
    .map((value, index) => ({ value, index, tier: tier(value) }))
    .filter((entry) => entry.tier > 0)
    .sort((a, b) => b.tier - a.tier || a.index - b.index)
    .map((entry) => entry.value);
}

export function searchHero(locale: LandingLocale, query: string): HeroGroup[] {
  const fixture = HERO_FIXTURES[locale];
  const needle = fold(query.trim()).replace(/\s+/g, ' ');

  let tags: HeroTag[];
  let items: HeroItem[];
  const near: { item: HeroItem; score: number }[] = [];

  if (needle === '') {
    // Ô trống: tag nhiều mục nhất và mục hay dùng nhất, như mockup.
    tags = [...fixture.tags].sort((a, b) => b.count - a.count).slice(0, EMPTY_TAGS);
    items = [...fixture.items].sort((a, b) => b.touched - a.touched).slice(0, MAX_ITEMS);
  } else {
    tags = byTier(fixture.tags, (tag) => rank(tag.name, needle)).slice(0, MAX_TAGS);
    items = byTier(fixture.items, (item) => itemTier(item, needle)).slice(0, MAX_ITEMS);

    const seen = new Set(items.map((item) => item.id));
    const scores = new Map<string, number>();
    for (const rule of fixture.near) {
      const hit = rule.triggers.some(
        (trigger) =>
          trigger === needle ||
          trigger.startsWith(needle) ||
          (needle.length >= 3 && needle.startsWith(trigger)),
      );
      if (!hit) continue;
      for (const [id, score] of rule.hits) {
        if (seen.has(id)) continue;
        if ((scores.get(id) ?? 0) < score) scores.set(id, score);
      }
    }
    for (const [id, score] of [...scores.entries()].sort((a, b) => b[1] - a[1]).slice(0, MAX_NEAR)) {
      const item = fixture.items.find((candidate) => candidate.id === id);
      if (item) near.push({ item, score });
    }
  }

  const groups: HeroGroup[] = [
    { id: 'tags', rows: tags.map((tag): HeroRow => ({ kind: 'tag', key: `tag-${tag.name}`, tag })) },
    { id: 'items', rows: items.map((item): HeroRow => ({ kind: 'item', key: `item-${item.id}`, item })) },
    {
      id: 'near',
      rows: near.map(({ item, score }): HeroRow => ({ kind: 'near', key: `near-${item.id}`, item, score })),
    },
  ];
  return groups.filter((group) => group.rows.length > 0);
}
