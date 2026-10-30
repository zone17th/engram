-- Chỉ dùng trên DB test một lần. Không phải quy trình rollback production.
DROP TABLE IF EXISTS rate_event;
DROP TABLE IF EXISTS idempotency_key;
DROP TABLE IF EXISTS webauthn_challenge;
DROP TABLE IF EXISTS vault_passkey;
DROP TABLE IF EXISTS vault_recovery_key;
DROP TABLE IF EXISTS vault;
