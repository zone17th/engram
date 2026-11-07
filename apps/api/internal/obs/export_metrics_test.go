package obs_test

import (
	"context"
	"errors"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/prometheus/client_golang/prometheus"
	dto "github.com/prometheus/client_model/go"

	"github.com/zone17th/engram/apps/api/internal/obs"
)

type fakeAgeRow struct {
	age float64
	err error
}

func (r fakeAgeRow) Scan(dest ...any) error {
	if r.err != nil {
		return r.err
	}
	dst := dest[0].(*float64)
	*dst = r.age
	return nil
}

type fakeAgeQuerier struct {
	row     fakeAgeRow
	queries []string
}

func (q *fakeAgeQuerier) Query(context.Context, string, ...any) (pgx.Rows, error) {
	return nil, errors.New("not used")
}

func (q *fakeAgeQuerier) QueryRow(_ context.Context, sql string, _ ...any) pgx.Row {
	q.queries = append(q.queries, sql)
	return q.row
}

func gatherByName(t *testing.T, reg prometheus.Gatherer) map[string]*dto.MetricFamily {
	t.Helper()
	families, err := reg.Gather()
	if err != nil {
		t.Fatalf("Gather: %v", err)
	}
	out := make(map[string]*dto.MetricFamily, len(families))
	for _, f := range families {
		out[f.GetName()] = f
	}
	return out
}

func TestExportMetricsPreinitializedFiniteLabels(t *testing.T) {
	reg, _ := obs.NewRegistry()
	byName := gatherByName(t, reg)

	cases := []struct {
		name   string
		keys   []string
		tuples [][]string
	}{
		{"export_jobs_total", []string{"kind", "outcome"}, product(obs.ExportKinds, obs.ExportJobOutcomes)},
		{"export_job_duration_seconds", []string{"kind", "outcome"}, product(obs.ExportKinds, obs.ExportJobOutcomes)},
		{"export_decrypted_audit_total", []string{"outcome"}, single(obs.ExportDecryptedAuditOutcomes)},
		{"account_deletions_total", []string{"outcome"}, single(obs.AccountDeletionOutcomes)},
	}
	for _, tc := range cases {
		f, ok := byName[tc.name]
		if !ok {
			t.Errorf("thiếu metric %s ngay từ boot", tc.name)
			continue
		}
		var got [][]string
		for _, metric := range f.GetMetric() {
			var keys, vals []string
			for _, l := range metric.GetLabel() {
				keys = append(keys, l.GetName())
				vals = append(vals, l.GetValue())
			}
			if !slices.Equal(keys, tc.keys) {
				t.Errorf("%s nhãn = %v, muốn %v", tc.name, keys, tc.keys)
			}
			got = append(got, vals)
		}
		if len(got) != len(tc.tuples) {
			t.Errorf("%s có %d series, muốn %d", tc.name, len(got), len(tc.tuples))
		}
		for _, want := range tc.tuples {
			if !slices.ContainsFunc(got, func(g []string) bool { return slices.Equal(g, want) }) {
				t.Errorf("%s thiếu series %v", tc.name, want)
			}
		}
	}
}

func TestExportMetricsRecordOnlyKnownOutcomes(t *testing.T) {
	reg, m := obs.NewRegistry()
	m.Export.ObserveJob("encrypted", "failed", 90*time.Second)
	m.Export.ObserveJob("encrypted", "bogus", time.Second)
	m.Export.IncAccountDeletion("error")

	byName := gatherByName(t, reg)
	for _, metric := range byName["export_jobs_total"].GetMetric() {
		want := 0.0
		if labelValue(metric, "outcome") == "failed" {
			want = 1
		}
		if metric.GetCounter().GetValue() != want {
			t.Errorf("export_jobs_total{%v} = %v, muốn %v", metric.GetLabel(), metric.GetCounter().GetValue(), want)
		}
	}
	for _, metric := range byName["export_job_duration_seconds"].GetMetric() {
		if labelValue(metric, "outcome") == "failed" && metric.GetHistogram().GetSampleSum() != 90 {
			t.Errorf("duration sum = %v, muốn 90", metric.GetHistogram().GetSampleSum())
		}
	}
	for _, metric := range byName["account_deletions_total"].GetMetric() {
		want := 0.0
		if labelValue(metric, "outcome") == "error" {
			want = 1
		}
		if metric.GetCounter().GetValue() != want {
			t.Errorf("account_deletions_total{%v} = %v, muốn %v", metric.GetLabel(), metric.GetCounter().GetValue(), want)
		}
	}
}

func TestExportCleanupGauge(t *testing.T) {
	reg := prometheus.NewRegistry()
	q := &fakeAgeQuerier{row: fakeAgeRow{age: 3725}}
	if err := obs.RegisterExportCleanupGauge(reg, q); err != nil {
		t.Fatalf("register: %v", err)
	}
	if err := obs.RegisterExportCleanupGauge(reg, q); err == nil {
		t.Fatal("đăng ký lần hai phải trả lỗi")
	}
	f, ok := gatherByName(t, reg)["export_cleanup_pending_age_seconds"]
	if !ok || len(f.GetMetric()) != 1 {
		t.Fatalf("thiếu gauge cleanup: %+v", f)
	}
	if got := f.GetMetric()[0].GetGauge().GetValue(); got != 3725 {
		t.Fatalf("gauge = %v, muốn 3725", got)
	}
	if len(f.GetMetric()[0].GetLabel()) != 0 {
		t.Fatalf("gauge không được có nhãn: %v", f.GetMetric()[0].GetLabel())
	}
	if len(q.queries) == 0 || strings.Contains(q.queries[0], "file_name") {
		t.Fatalf("truy vấn không được đọc file_name: %q", q.queries)
	}

	// Lỗi DB → series vắng (monitor coi vắng là cảnh báo), không phải 0.
	q.row = fakeAgeRow{err: errors.New("db down")}
	if _, ok := gatherByName(t, reg)["export_cleanup_pending_age_seconds"]; ok {
		t.Fatal("lỗi DB không được phát gauge")
	}
}

func labelValue(m *dto.Metric, name string) string {
	for _, l := range m.GetLabel() {
		if l.GetName() == name {
			return l.GetValue()
		}
	}
	return ""
}

func product(a, b []string) [][]string {
	var out [][]string
	for _, x := range a {
		for _, y := range b {
			out = append(out, []string{x, y})
		}
	}
	return out
}

func single(a []string) [][]string {
	out := make([][]string, 0, len(a))
	for _, x := range a {
		out = append(out, []string{x})
	}
	return out
}
