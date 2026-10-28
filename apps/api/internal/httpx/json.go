package httpx

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"
)

const AuthJSONLimit = 16 * 1024

// DecodeJSON đọc body JSON chặt: content-type, giới hạn, unknown field,
// trailing data, duplicate key.
func DecodeJSON(w http.ResponseWriter, r *http.Request, dst any) bool {
	ct := r.Header.Get("Content-Type")
	if mt := strings.TrimSpace(strings.Split(ct, ";")[0]); !strings.EqualFold(mt, "application/json") {
		WriteProblem(w, r, http.StatusUnsupportedMediaType, "invalid_request", "Content-Type phải là application/json.")
		return false
	}
	body, err := io.ReadAll(io.LimitReader(r.Body, AuthJSONLimit+1))
	if err != nil {
		WriteProblem(w, r, http.StatusBadRequest, "invalid_request", "Không đọc được nội dung.")
		return false
	}
	if len(body) > AuthJSONLimit {
		WriteProblem(w, r, http.StatusRequestEntityTooLarge, "invalid_request", "Nội dung quá lớn.")
		return false
	}
	if len(bytes.TrimSpace(body)) == 0 {
		WriteProblem(w, r, http.StatusBadRequest, "invalid_request", "Thiếu nội dung JSON.")
		return false
	}
	if err := rejectDuplicateKeys(body); err != nil {
		WriteProblem(w, r, http.StatusBadRequest, "invalid_request", "JSON không hợp lệ.")
		return false
	}
	dec := json.NewDecoder(bytes.NewReader(body))
	dec.DisallowUnknownFields()
	if err := dec.Decode(dst); err != nil {
		WriteProblem(w, r, http.StatusBadRequest, "invalid_request", "JSON không hợp lệ.")
		return false
	}
	var extra any
	if err := dec.Decode(&extra); !errors.Is(err, io.EOF) {
		WriteProblem(w, r, http.StatusBadRequest, "invalid_request", "JSON không hợp lệ.")
		return false
	}
	return true
}

func rejectDuplicateKeys(data []byte) error {
	dec := json.NewDecoder(bytes.NewReader(data))
	dec.UseNumber()
	return walkDup(dec, false)
}

func walkDup(dec *json.Decoder, inArray bool) error {
	tok, err := dec.Token()
	if err != nil {
		return err
	}
	switch t := tok.(type) {
	case json.Delim:
		switch t {
		case '{':
			seen := map[string]struct{}{}
			for dec.More() {
				k, err := dec.Token()
				if err != nil {
					return err
				}
				key, ok := k.(string)
				if !ok {
					return errors.New("key")
				}
				if _, dup := seen[key]; dup {
					return errors.New("duplicate")
				}
				seen[key] = struct{}{}
				if err := walkDup(dec, false); err != nil {
					return err
				}
			}
			end, err := dec.Token()
			if err != nil {
				return err
			}
			if end != json.Delim('}') {
				return errors.New("object")
			}
		case '[':
			for dec.More() {
				if err := walkDup(dec, true); err != nil {
					return err
				}
			}
			end, err := dec.Token()
			if err != nil {
				return err
			}
			if end != json.Delim(']') {
				return errors.New("array")
			}
		default:
			return errors.New("delim")
		}
	case string, json.Number, bool, nil:
		if inArray {
			return nil
		}
		return nil
	default:
		if _, ok := tok.(json.Delim); ok {
			return errors.New("delim")
		}
	}
	return nil
}
