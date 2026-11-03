//go:build searchbench

package searchbench

import (
	"encoding/json"
	"fmt"
	"sort"
	"strings"
)

// Pure helpers of the FU-SL-1 lexical plan evidence (Task 23): read the JSON of
// `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)` and name the indexes the planner used.

// Index classes of the lexical plan evidence.
const (
	// IndexPerUser: the migration 0008 per-user lexical indexes.
	IndexPerUser = "per-user"
	// IndexGlobalTrgm: the global trigram indexes item_name_trgm / tag_norm_trgm
	// that migration 0010 would drop.
	IndexGlobalTrgm = "global-trgm"
	// IndexOther: any other index (primary keys, user_id btrees, ...).
	IndexOther = "other"
)

var (
	perUserLexicalIndexes = map[string]bool{
		"item_user_unaccent_prefix": true, "item_user_name_trgm": true,
		"tag_user_unaccent_prefix": true, "tag_user_tag_trgm": true,
	}
	globalTrgmIndexes = map[string]bool{"item_name_trgm": true, "tag_norm_trgm": true}
)

// IndexClassOf classifies an index name.
func IndexClassOf(name string) string {
	switch {
	case perUserLexicalIndexes[name]:
		return IndexPerUser
	case globalTrgmIndexes[name]:
		return IndexGlobalTrgm
	default:
		return IndexOther
	}
}

// LexPlanInfo is what the report keeps of one EXPLAIN ANALYZE plan.
type LexPlanInfo struct {
	Indexes    []string `json:"indexes"`     // distinct index names, sorted
	UsesGlobal bool     `json:"uses_global"` // item_name_trgm / tag_norm_trgm in the plan
	UsesUser   bool     `json:"uses_per_user"`
	SeqScan    bool     `json:"seq_scan"` // a Seq Scan node on item or tag
	ExecMs     float64  `json:"execution_ms"`
	PlanningMs float64  `json:"planning_ms"`
	SharedHit  int64    `json:"shared_hit_blocks"`
	SharedRead int64    `json:"shared_read_blocks"`
	TopNode    string   `json:"top_node"`
}

type planNode struct {
	NodeType     string     `json:"Node Type"`
	RelationName string     `json:"Relation Name"`
	IndexName    string     `json:"Index Name"`
	SharedHit    int64      `json:"Shared Hit Blocks"`
	SharedRead   int64      `json:"Shared Read Blocks"`
	Plans        []planNode `json:"Plans"`
}

type planDoc struct {
	Plan          planNode `json:"Plan"`
	PlanningTime  float64  `json:"Planning Time"`
	ExecutionTime float64  `json:"Execution Time"`
}

// ParseLexicalPlan reads the JSON array of one EXPLAIN (ANALYZE, BUFFERS, FORMAT
// JSON) statement. Buffers are the root node's (cumulative) shared hit/read
// counts. A "Seq Scan" node (parallel or not) on the item or tag table counts as
// a sequential scan; seq scans of CTE/function nodes do not.
func ParseLexicalPlan(planJSON []byte) (LexPlanInfo, error) {
	var docs []planDoc
	if err := json.Unmarshal(planJSON, &docs); err != nil {
		return LexPlanInfo{}, fmt.Errorf("searchbench: parse EXPLAIN JSON: %w", err)
	}
	if len(docs) == 0 || docs[0].Plan.NodeType == "" {
		return LexPlanInfo{}, fmt.Errorf("searchbench: EXPLAIN JSON has no plan")
	}
	d := docs[0]
	info := LexPlanInfo{
		ExecMs: d.ExecutionTime, PlanningMs: d.PlanningTime,
		SharedHit: d.Plan.SharedHit, SharedRead: d.Plan.SharedRead, TopNode: d.Plan.NodeType,
	}
	seen := map[string]bool{}
	var walk func(n planNode)
	walk = func(n planNode) {
		if n.IndexName != "" {
			seen[n.IndexName] = true
		}
		if n.NodeType == "Seq Scan" && (n.RelationName == "item" || n.RelationName == "tag") {
			info.SeqScan = true
		}
		for _, c := range n.Plans {
			walk(c)
		}
	}
	walk(d.Plan)
	for name := range seen {
		info.Indexes = append(info.Indexes, name)
	}
	sort.Strings(info.Indexes)
	for _, name := range info.Indexes {
		switch IndexClassOf(name) {
		case IndexGlobalTrgm:
			info.UsesGlobal = true
		case IndexPerUser:
			info.UsesUser = true
		}
	}
	return info, nil
}

// Label is the compact "indexes (classes)" text of the report table; "-" when the
// plan used no index.
func (p LexPlanInfo) Label() string {
	if len(p.Indexes) == 0 {
		return "-"
	}
	parts := make([]string, 0, len(p.Indexes))
	for _, n := range p.Indexes {
		parts = append(parts, n+" ("+IndexClassOf(n)+")")
	}
	return strings.Join(parts, ", ")
}
