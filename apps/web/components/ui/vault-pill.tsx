import { cn } from '@/lib/cn';

/**
 * Chỉ hiển thị trạng thái được truyền vào. P01 KHÔNG có vault thật — P03 mới nối
 * vào state thật; ở đây pill nhận prop từ fixture của shell.
 * Locked dùng .vault-shut (tokens.css) — không có .vault-locked.
 */
export function VaultPill({
  state,
  minutesLeft,
  className,
}: {
  state: 'open' | 'locked';
  minutesLeft?: number;
  className?: string;
}) {
  const open = state === 'open';
  return (
    <span className={cn('vault-pill', open ? 'vault-open' : 'vault-shut', className)}>
      <span aria-hidden="true">{open ? '🔓' : '🔒'}</span>
      <span>{open ? 'Vault mở' : 'Vault đang khoá'}</span>
      {open && minutesLeft !== undefined && <span>· {minutesLeft} phút</span>}
    </span>
  );
}
