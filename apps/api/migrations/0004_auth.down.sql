-- Chỉ dùng trên DB test một lần. Không phải quy trình rollback production.
DROP TABLE IF EXISTS user_notification;
DROP TABLE IF EXISTS audit_log;
DROP TABLE IF EXISTS oauth_reauth_receipt;
DROP TABLE IF EXISTS oauth_transaction;
DROP TABLE IF EXISTS email_verification;
DROP TABLE IF EXISTS auth_throttle;
DROP TABLE IF EXISTS session_refresh_used;
DROP TABLE IF EXISTS session;
DROP TABLE IF EXISTS auth_identity;
DROP TABLE IF EXISTS app_user;
