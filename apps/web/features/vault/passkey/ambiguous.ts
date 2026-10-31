/**
 * Server failures whose outcome is unknown: the request may have committed before the error was produced
 * (ADR 0003 §5). Everything below 500 is produced before or instead of the mutation, and the one 503 the API sends
 * on purpose (`vault_mutations_disabled`, plan §2.3 "K") is checked before anything is written. Any other 5xx — a
 * commit failure surfacing as 500 `internal_error`, a gateway 502/504, a proxy 503 — proves nothing.
 */
export function isAmbiguousServerFailure(problem: { status: number; code?: string }): boolean {
  if (problem.status < 500) return false;
  return !(problem.status === 503 && problem.code === 'vault_mutations_disabled');
}
