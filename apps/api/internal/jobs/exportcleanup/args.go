// Package exportcleanup defines the shared River job payload for durable
// export file deletion on disk (plan P06 mục 2.9, 4.2).
//
// Privacy invariant (user-dec-016): job arguments carry only the cleanup row
// UUID — never user IDs, email addresses, or filesystem paths.
package exportcleanup

import "github.com/google/uuid"

// Kind is the River job kind for durable export file cleanup.
const Kind = "export_file_cleanup"

// Args is the River job payload for unlinking an expired/cancelled/deleted
// export file recorded in export_file_cleanup.
type Args struct {
	CleanupID uuid.UUID `json:"cleanup_id"`
}

// Kind returns the River job kind "export_file_cleanup".
func (Args) Kind() string { return Kind }
