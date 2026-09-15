'use client';

import { useState } from 'react';
import { BadgeType } from '@/components/ui/badge-type';
import { Segmented } from '@/components/ui/segmented';

type Row = { path: string; key: string; value: string | null; depth: number };

/** Duyệt object thành các hàng phẳng để render bảng — không đệ quy trong JSX. */
function toRows(value: unknown, depth = 0, prefix = ''): Row[] {
  if (value === null || typeof value !== 'object') {
    return [{ path: prefix, key: prefix.split('.').pop() ?? prefix, value: String(value), depth }];
  }
  return Object.entries(value as Record<string, unknown>).flatMap(([key, child]) => {
    const path = prefix ? `${prefix}.${key}` : key;
    const isLeaf = child === null || typeof child !== 'object';
    const head: Row = { path, key, value: isLeaf ? String(child) : null, depth };
    return isLeaf ? [head] : [head, ...toRows(child, depth + 1, path)];
  });
}

export interface JsonTableProps {
  data: Record<string, unknown>;
  /** Tiêu đề hiện trong header card, cạnh badge `json` (theo mockups/landing.html). */
  title?: string;
  /**
   * Nhãn của segmented. Component này là client component nhưng KHÔNG gọi
   * useTranslations: test render nó trần, không có NextIntlClientProvider.
   * Trang truyền nhãn đã dịch xuống; mặc định là tiếng Việt.
   */
  labels?: { table: string; raw: string };
}

export function JsonTable({ data, title, labels }: JsonTableProps) {
  const [view, setView] = useState('tbl');
  const rows = toRows(data);
  const tableLabel = labels?.table ?? 'Bảng';
  const rawLabel = labels?.raw ?? 'JSON thô';

  return (
    <div className="card overflow-hidden">
      <div className="flex flex-wrap items-center gap-3 border-b border-line bg-surface px-4 py-3">
        <BadgeType kind="json" />
        {title ? <span className="text-[15px] font-semibold">{title}</span> : null}
        <div className="ml-auto">
          <Segmented
            value={view}
            onChange={setView}
            options={[
              { value: 'tbl', label: tableLabel },
              { value: 'raw', label: rawLabel },
            ]}
          />
        </div>
      </div>

      {view === 'tbl' ? (
        <table className="json-table">
          <tbody>
            {rows.map((row) => (
              <tr key={row.path} className={row.depth > 0 ? 'json-nest' : undefined}>
                <th scope="row" style={{ paddingLeft: `${row.depth * 16}px` }}>
                  {row.key}
                </th>
                <td className="mono">{row.value ?? ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <pre className="json-raw">
          <code role="code">{JSON.stringify(data, null, 2)}</code>
        </pre>
      )}
    </div>
  );
}
