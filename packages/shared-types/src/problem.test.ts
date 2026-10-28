import { describe, expect, it } from 'vitest';
import { ERROR_CODES, PROBLEM_BASE, isProblemDetails } from './problem';

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
});
