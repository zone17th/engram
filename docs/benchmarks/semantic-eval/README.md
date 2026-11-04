# Bộ đánh giá và hiệu chỉnh ngưỡng `semantic_min_cos`

Thư mục này chứa bộ cặp đánh giá tổng hợp và các báo cáo hiệu chỉnh ngưỡng tương đồng cosine (`semantic_min_cos`) cho vùng gợi ý/tìm kiếm **Gần nghĩa** (SPEC §6.7, plan P05 mục 2.20, ADR 0007 §10).

> **Bất biến bảo mật (`user-dec-016`):** Toàn bộ dữ liệu trong thư mục này là **dữ liệu tổng hợp (synthetic)**. Tuyệt đối không thêm dữ liệu thật của người dùng, tên người thật, email thật, số điện thoại hay bất kỳ nội dung `entry` (secret/mật khẩu) nào vào `pairs.v1.jsonl` hoặc báo cáo.

## 1. Mục đích

Ngưỡng `semantic_min_cos` của vùng **Gần nghĩa** không đoán mò mà được đo trực tiếp trên bộ cặp đánh giá cho từng danh tính không gian vector `(provider, model, model_version)`. Code từ chối tạo hoặc kích hoạt `embedding_generation` (gồm cả `generation.Bootstrap`, `create`, `flip`) nếu danh tính client không có mục hiệu chỉnh hợp lệ trong `apps/api/internal/embedding/calibration.go`.

## 2. Schema `pairs.v1.jsonl`

Mỗi dòng trong `docs/benchmarks/semantic-eval/pairs.v1.jsonl` là một đối tượng JSON độc lập (UTF-8, xuống dòng LF `\n`), gồm **đúng 8 trường**:

| Trường | Kiểu / Giá trị hợp lệ | Mô tả |
|---|---|---|
| `id` | `string` (duy nhất, ví dụ `p001`…`p124`) | Định danh cặp đánh giá |
| `query` | `string` (không rỗng, ≥ 3 rune, không chứa `:` hoặc `：`) | Câu truy vấn người dùng gõ ở chế độ tìm |
| `target` | `string` (không rỗng) | Tên `item.name` hoặc `tag.display` đích |
| `target_kind` | `"item"` \| `"tag"` | Loại thực thể đích |
| `hint` | `string` (với `target_kind = "tag"` bắt buộc là `""`) | Phụ đề `item.hint` đi kèm khi nhúng document |
| `label` | `"related"` \| `"unrelated"` | Nhãn chuẩn (có liên quan ngữ nghĩa hay không) |
| `lang` | `"vi"` \| `"en"` \| `"mixed"` | Ngôn ngữ của cặp truy vấn – đích |
| `category` | `"abbrev"` \| `"diacritics"` \| `"no_diacritics"` \| `"short_name"` \| `"cross_lang"` \| `"tag"` \| `"noise"` | Nhóm kịch bản kiểm thử |

### Số lượng tối thiểu (kiểm tự động bởi `TestEvalSetSchema`)

- Tổng số dòng: **≥ 80** (bộ `v1` hiện có **124** cặp).
- Nhãn `related`: **≥ 40** (hiện có **74**).
- Nhãn `unrelated`: **≥ 30** (hiện có **50**).
- Mỗi `category` trong 7 nhóm (`abbrev`, `diacritics`, `no_diacritics`, `short_name`, `cross_lang`, `tag`, `noise`): **≥ 8** dòng mỗi nhóm.
- Số dòng có `target_kind = "tag"`: **≥ 15** (hiện có **18**).
- Nhóm `noise` chứa các cặp `unrelated` dùng chung từ khóa hoặc tiền tố với đích (ví dụ `"ngân hàng"` vs `"Ngân sách chi tiêu gia đình"`, `"mail công việc"` vs `"Mailchimp Chiến dịch Marketing"`) để giữ ngưỡng không bị kéo thấp bởi các cặp âm quá dễ.

## 3. Quy tắc chọn ngưỡng `t` (ghi trước khi chạy — SPEC §6.7)

Quy tắc được cài đặt thuần tại `embedding.SelectThreshold` (`apps/api/internal/embedding/calibration.go`):

- Duyệt `t` trên lưới `0.30…0.90` bước `0.01` (tính theo số nguyên phần trăm `30..90` để không trôi dấu phẩy động).
- Chọn giá trị **`t` nhỏ nhất** trên lưới sao cho **FPR ≤ 5 %** (`max_fpr = 0.05`, với `FPR` = tỷ lệ cặp `unrelated` có `cos ≥ t` trên tổng số cặp `unrelated`).
- Nếu tại `t` đó **recall < 0.60** (`min_recall = 0.60`, với `recall` = tỷ lệ cặp `related` có `cos ≥ t` trên tổng số cặp `related`), hoặc không có điểm nào trên lưới thỏa `FPR ≤ 5 %`, kết quả trả về `decision = "decision_required"` và **không bật semantic cho người dùng**.
- Ngược lại, kết quả trả về `decision = "ok"`.

## 4. Quy ước đặt tên và schema báo cáo (`engram.semeval.report.v1`)

Tên file báo cáo:

```text
docs/benchmarks/semantic-eval/report-<model_slug>-<dims>-<yyyymmdd>.json
```

Cấu trúc JSON của báo cáo:

```json
{
  "schema": "engram.semeval.report.v1",
  "provider": "tei",
  "model": "tei/engram-fakeembed",
  "model_version": "fakeembed-v1;qp=e3b0c442;dp=e3b0c442",
  "dims": 1024,
  "pairs_file": "docs/benchmarks/semantic-eval/pairs.v1.jsonl",
  "pairs_sha256": "<hex sha256 của file pairs.v1.jsonl>",
  "grid": { "min": 0.30, "max": 0.90, "step": 0.01 },
  "max_fpr": 0.05,
  "min_recall": 0.60,
  "threshold": 0.62,
  "precision": 0.9722222222222222,
  "recall": 0.9459459459459459,
  "fpr": 0.04,
  "decision": "ok",
  "generated_at": "2026-11-02T00:00:00Z",
  "synthetic": true,
  "note": "...",
  "results": [
    { "id": "p001", "label": "related", "cos": 0.72 }
  ]
}
```

Mảng `results` chỉ lưu `id`, `label` và `cos` (không ghi lại văn bản `query` hay `target`).

## 5. Liên kết với `calibration.go` và quy tắc model giả (`fakeembed`)

- Mỗi mục `CalibrationEntry` trong `apps/api/internal/embedding/calibration.go` khai báo `(Provider, Model, ModelVersion, MinCos, ReportPath, NonProductionOnly)`.
- Validator CI `TestCalibrationEntriesHaveReports` (`apps/api/internal/embedding/evalset_test.go`) kiểm tra mọi mục trong `CalibrationEntries()`:
  - File `ReportPath` tồn tại trong `docs/benchmarks/semantic-eval/`, đúng schema `engram.semeval.report.v1`.
  - `pairs_sha256` khớp tuyệt đối với SHA-256 của `pairs.v1.jsonl` hiện tại.
  - `results` phủ đúng tập `id` và `label` của `pairs.v1.jsonl`.
  - Chạy lại `SelectThreshold(results)` cho ra đúng `threshold`, `precision`, `recall`, `fpr`, `decision = "ok"`, và `threshold` khớp `MinCos` của mục `calibration.go`.
- **Quy tắc `fakeembed` cho CI:** Mục `(provider="tei", model="tei/engram-fakeembed", model_version prefix "fakeembed-v1;")` đi kèm báo cáo tổng hợp `report-fakeembed-1024-20261102.json` (`synthetic: true`) và cờ `NonProductionOnly: true`. `CalibrationLookupFor(appEnv)` chỉ chấp nhận mục này khi `appEnv` là `"development"` hoặc `"staging"` (để profile E2E `semantic-fake` bootstrap được `g1`), và **từ chối (`ok = false`) khi `appEnv == "production"`** hoặc giá trị môi trường rỗng/không xác định (fail closed).
- **Chạy thật trên host triển khai (Task 24):** Ở W2, subcommand `worker semeval --pairs docs/benchmarks/semantic-eval/pairs.v1.jsonl --out docs/benchmarks/semantic-eval/report-<model_slug>-<dims>-<yyyymmdd>.json` được thêm vào binary `worker`. Trong bước rollout (Task 24), lane `rollout` chạy `worker semeval` một lần trên host deploy với provider thật, commit báo cáo JSON cùng mục `CalibrationEntry` thật vào `calibration.go`, rồi build và deploy image mới trước khi bootstrap `g1`.
