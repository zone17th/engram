# ADR 0004 — Embedding qua API tương thích OpenAI (qwen3-embedding-8b)

- Trạng thái: chấp nhận (owner chốt 2026-10-29)
- Ngày: 2026-10-29
- Phase: áp dụng từ P05 (semantic); P03/P04 không đổi
- Thay thế một phần: SPEC §1.1 "embedding self-host", §1.3 non-goal "không embedding API bên thứ ba", §4.4, §6.4 budget TEI, §6.6 degraded, §6.7, §10.4
- Không phải bằng chứng: số đo dưới đây là probe 6 cụm từ, không thay cho bộ đánh giá ở mục "Ngưỡng"

## Bối cảnh

SPEC v0.7 chốt TEI CPU tự host (`BAAI/bge-m3`, 1024 dims) và cấm embedding API bên thứ ba. Host đích hiện có (`bro`) là ARM64 (Neoverse-N1); digest TEI đang pin trong `infra/image-pins.env` chỉ có `amd64`, chạy qua giả lập không dùng được. Owner đã có một router tự vận hành nói giao thức OpenAI (`/v1/embeddings`), chuyển tiếp tới OpenRouter.

Probe 2026-10-29 qua router, 3 lần mỗi model, input gồm cặp liên quan (`mật khẩu wifi`/`wifi-password`, `mật khẩu wifi`/`mạng-nhà`, `họp marketing tuần này`/`meeting-mkt`) và cặp không liên quan (`mật khẩu wifi`/`họp marketing tuần này`, `mật khẩu wifi`/`hoá đơn tiền điện`):

| Model (qua OpenRouter) | Dims | Latency / request | Liên quan (cos) | Không liên quan (cos) | Tách |
|---|---|---|---|---|---|
| `baai/bge-m3` | 1024 | 1,8–1,9 s | 0.677 · 0.649 · 0.463 | 0.591 · 0.601 | sai thứ tự |
| `openai/text-embedding-3-small` | 1536 | 1,4–1,8 s | 0.503 · 0.489 · 0.408 | 0.386 · 0.374 | +0.02 |
| `openai/text-embedding-ada-002` | 1536 | 1,6–1,9 s | 0.827 · 0.845 · 0.782 | 0.814 · 0.825 | sai thứ tự |
| `qwen/qwen3-embedding-8b` | 4096 | 2,5–5,5 s | 0.885 · 0.586 · 0.654 | 0.508 · 0.528 | +0.058 |
| `qwen/qwen3-embedding-8b`, `dimensions=1024` | 1024 | 2,3 s | 0.892 · 0.602 · 0.689 | 0.564 · 0.558 | +0.038 |

Ngoài chọn model, probe cho thấy ngưỡng cố định `cos ≥ 0.55` của §6.4 không dùng chung được: với bge-m3 cặp không liên quan đã vượt 0.55, với text-embedding-3-small cặp liên quan đều dưới 0.55.

## Quyết định

### Provider `openai_compat`

Thêm provider thứ ba bên cạnh `tei` và `noop`, cùng interface §4.4:

| Env | Ý nghĩa | Mặc định |
|---|---|---|
| `EMBEDDING_PROVIDER` | `noop` \| `tei` \| `openai_compat` | `noop` |
| `EMBEDDING_BASE_URL` | gốc `/v1` của API | bắt buộc khi `openai_compat` |
| `EMBEDDING_API_KEY` | bearer token | bắt buộc khi `openai_compat`; chỉ qua secret/env |
| `EMBEDDING_MODEL` | tên model phía API | `openrouter/qwen/qwen3-embedding-8b` |
| `EMBEDDING_DIMENSIONS` | gửi `dimensions`, kiểm dims trả về | `1024` |
| `EMBEDDING_QUERY_INSTRUCTION` | instruction cho phía query | `Given a short search query, retrieve matching item names or tags` |
| `EMBEDDING_QUERY_TIMEOUT` | budget embed query đồng bộ | `300ms` với `tei`, `4s` với `openai_compat` |

Request: `POST {base}/embeddings` với `{model, input: [...], dimensions, encoding_format: "float"}`. Go L2-normalize mọi vector nhận về (vector cắt MRL không bảo đảm chuẩn hoá) và từ chối response sai số lượng, sai dims hoặc có NaN.

Query dùng dạng instruction của Qwen3 `Instruct: {instruction}\nQuery:{q}`; item/tag (phía document) không prefix. Instruction là một phần của generation và `input_hash` (§6.6), như `input_prefix` hiện có.

### Model mặc định

`qwen/qwen3-embedding-8b` cắt 1024 dims: tách tốt nhất trong probe, vừa cột `vector(1024)` và giới hạn HNSW của pgvector (2000 dims với `vector`), không đổi schema. `model` = `"openai_compat/" + EMBEDDING_MODEL`; `model_version` = `dims=<n>;instr=<sha256 8 ký tự>` vì API không có `/info` như TEI.

API không cho biết upstream có đổi trọng số hay không. Lúc boot và mỗi giờ, provider embed một bộ canary cố định và so với fingerprint lưu theo generation; cosine < 0.99 ở bất kỳ canary nào → metric/log cảnh báo vận hành, không tự cutover.

TEI vẫn là provider hợp lệ cho host x86 muốn tự host hoàn toàn; đổi qua lại giữa provider là đổi model, luôn đi shadow/cutover §6.6.

### Ngưỡng semantic theo generation

`cos ≥ 0.55` trở thành `semantic_min_cos` lưu trong `active_generation`. P05 phải hiệu chỉnh trên một bộ đánh giá commit trong repo (≥ 80 cặp vi/en, tên ngắn, viết tắt, tag có dấu và không dấu, cặp nhiễu) trước khi bật semantic cho user. Giá trị tạm cho qwen3@1024 từ probe: `0.58`.

### Latency

Nhánh semantic đã là request riêng (`semantic=0` trả lexical trước), nên G2 không đổi. Với `openai_compat`: budget §6.4 "TEI 300 ms" đọc thành `EMBEDDING_QUERY_TIMEOUT`, tổng hybrid ≤ timeout + 50 ms cho hai query vector; LRU cache query giữ nguyên. Timeout, 5xx, 429 hay lỗi mạng mở circuit 60 s như cũ. Worker: batch ≤ 64, concurrency 2, tôn trọng `Retry-After` của 429.

### Quyền riêng tư và vận chuyển

- Khi provider là `openai_compat`, `item.name`, `hint`, `tag.display` và query semantic `q` rời hạ tầng sản phẩm: router → OpenRouter → nhà cung cấp chạy model. Body entry vẫn không bao giờ đi (đã mã hoá, §5).
- `user.settings.semantic_suggest = false` nghĩa là **không gửi gì của user đó** ra provider: không embed query, không enqueue embed item/tag, xoá vector hiện có của user trong mọi generation. Bật lại → backfill riêng user đó (`ReembedUser`). Thay hành vi "tắt vẫn index" của §6.6/§6.10 khi provider không phải `tei`/`noop`.
- Onboarding, nhãn `hint`, Settings `≈` và §10.4 nói rõ name/tag/hint/query được gửi tới dịch vụ embedding bên thứ ba khi bật gợi ý gần nghĩa.
- `EMBEDDING_BASE_URL` production phải là `https://` hoặc địa chỉ riêng (loopback, RFC 1918, CGNAT/Tailscale `100.64.0.0/10`, mạng Docker); config từ chối `http://` tới IP công khai. Key không vào repo, log hay trace; log chỉ ghi số lượng input và latency.
- Tài khoản OpenRouter cấu hình chỉ cho route tới provider không lưu/không train trên prompt; đây là điều kiện vận hành P06, không kiểm được từ API.

## Hệ quả

- P05: thêm `internal/embedding/openai_compat.go`, config validate mở rộng (`oneof=noop tei openai_compat` + rule URL/key), migration thêm `semantic_min_cos` vào generation, `ReembedUser`, bộ đánh giá ngưỡng, test fake server cho dims/normalize/429/timeout.
- P06: privacy/docs/onboarding theo mục trên; deploy không cần TEI trên host ARM.
- Chi phí: probe ~4e-7 USD cho 6 input ngắn; backfill 100k item + 20k tag là cỡ cent. Phụ thuộc mạng ngoài: semantic tắt êm (degraded) khi router/OpenRouter lỗi, lexical không ảnh hưởng.

## Câu hỏi mở

- `semantic_suggest` mặc định: giữ `true` (P02 đã migrate default) kèm thông báo onboarding, hay chuyển opt-in `false` cho user mới vì dữ liệu rời hạ tầng. Chưa quyết; P05 chốt trước khi bật semantic production.
