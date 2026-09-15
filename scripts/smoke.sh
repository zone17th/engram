#!/usr/bin/env bash
# Kiểm tra P01-A3 và P01-A2 trên stack đang chạy. Chạy sau `make stack-up`.
set -euo pipefail

BASE="${BASE:-http://localhost:3000}"

echo "==> healthz đi qua proxy cùng origin"
curl -fsS "$BASE/api/v1/healthz" | grep -q '"status":"ok"'

echo "==> readyz báo sẵn sàng và KHÔNG quảng cáo semantic khi provider noop"
ready=$(curl -fsS "$BASE/api/v1/readyz")
echo "$ready" | grep -q '"status":"ready"'
echo "$ready" | grep -q '"semantic_available":false'

echo "==> không có bản sao endpoint ở root"
test "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/healthz")" = "404"

echo "==> landing và app trả 200"
test "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/")" = "200"
test "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/vi")" = "200"
test "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/app")" = "200"

echo "==> CSP có mặt trên HTML"
curl -fsSI "$BASE/" | grep -qi "content-security-policy"

echo "OK — smoke pass"
