import { describe, expect, expectTypeOf, it } from 'vitest';
import type { components } from './api';
import { ERROR_CODES, type ErrorCode, PROBLEM_BASE, isProblemDetails } from './problem';

type NodeFs = {
  readFileSync(path: URL, encoding: 'utf8'): string;
};

declare const process: {
  getBuiltinModule(id: 'node:fs'): NodeFs;
};

function readOpenApiProblemCodes(): string[] {
  const raw = process
    .getBuiltinModule('node:fs')
    .readFileSync(new URL('../../../apps/api/api/openapi.yaml', import.meta.url), 'utf8');
  const blockMatch = raw.match(
    /^\s{4}ProblemCode:\r?\n\s{6}type:\s*string\r?\n\s{6}enum:\r?\n((?:\s{8}-\s*[a-z0-9_]+\r?\n)+)/m,
  );
  if (!blockMatch) {
    throw new Error('Không tìm thấy block ProblemCode.enum trong apps/api/api/openapi.yaml');
  }
  return Array.from(blockMatch[1].matchAll(/^\s{8}-\s*([a-z0-9_]+)\s*$/gm), (m) => m[1]);
}

describe('problem', () => {
  it('giữ đúng namespace type URI của spec', () => {
    expect(PROBLEM_BASE).toBe('https://key.zone17th.click/problems/');
  });

  it('nhận diện body problem hợp lệ', () => {
    expect(
      isProblemDetails({
        type: `${PROBLEM_BASE}dependency_unavailable`,
        title: 'Phụ thuộc chưa sẵn sàng',
        status: 503,
        code: 'dependency_unavailable',
      }),
    ).toBe(true);
  });

  it('từ chối object thiếu code', () => {
    expect(isProblemDetails({ type: PROBLEM_BASE, title: 'x', status: 500 })).toBe(false);
  });

  it('liệt kê đủ code P01 dùng', () => {
    expect(ERROR_CODES).toContain('dependency_unavailable');
    expect(ERROR_CODES).toContain('invalid_request');
    expect(ERROR_CODES).toContain('internal_error');
    expect(ERROR_CODES).toContain('not_found');
  });

  it('liệt kê đủ code P02 auth', () => {
    for (const code of [
      'unauthenticated',
      'access_expired',
      'session_invalid',
      'invalid_credentials',
      'csrf_invalid',
      'forbidden',
      'reauth_required',
      'reauth_invalid',
      'reauth_unsupported_provider',
      'rate_limited',
      'captcha_required',
      'email_not_verified',
      'email_taken',
      'identity_conflict',
      'identity_last_method',
      'oauth_state_invalid',
      'oauth_provider_error',
      'verification_invalid',
      'password_weak',
      'semantic_unavailable',
      'mail_delivery_unavailable',
    ] as const) {
      expect(ERROR_CODES).toContain(code);
    }
  });

  it('liệt kê đủ code P03 vault và không trùng lặp', () => {
    for (const code of [
      'vault_exists',
      'vault_absent',
      'vault_kdf_invalid',
      'vault_wrap_invalid',
      'vault_mutations_disabled',
      'recovery_keys_count',
      'recovery_key_slot_taken',
      'recovery_key_invalid',
      'recovery_key_conflict',
      'precondition_required',
      'version_mismatch',
      'idempotency_conflict',
      'idempotency_in_progress',
      'passkey_challenge_invalid',
      'passkey_attestation_invalid',
      'passkey_name_invalid',
      'passkey_exists',
      'passkey_not_found',
      'email_not_verified',
    ] as const) {
      expect(ERROR_CODES).toContain(code);
    }
    expect(new Set(ERROR_CODES).size).toBe(ERROR_CODES.length);
  });

  it('đồng bộ hai chiều giữa ERROR_CODES và danh sách ProblemCode trong openapi.yaml', () => {
    const openApiCodes = readOpenApiProblemCodes();
    for (const code of ERROR_CODES) {
      expect(openApiCodes).toContain(code);
    }
    for (const code of openApiCodes) {
      expect(ERROR_CODES).toContain(code);
    }
    expect(openApiCodes).toEqual([...ERROR_CODES]);
    expectTypeOf<ErrorCode>().toEqualTypeOf<components['schemas']['ProblemCode']>();
  });
});
