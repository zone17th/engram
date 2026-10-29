package vaulthttp_test

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/zone17th/save-all-by-keyword/apps/api/internal/vault"
)

// TestRecoveryKeysRegenerateConcurrentNeverExceedsTen covers Task 11 bullet:
// "two concurrent regenerates never exceed 10"
func TestRecoveryKeysRegenerateConcurrentNeverExceedsTen(t *testing.T) {
	h := newHarness(t, harnessOpts{})
	password := "correct-horse-battery-staple"
	jarA, meA := h.signupUser("rk-regen-concurrent@example.com", password)

	payloadA := makeCreatePayload(t, 0x10)
	respCreate, rawCreate := h.doReq(jarA, http.MethodPost, "/api/v1/vault", mustJSON(t, payloadA), reqOptions{
		idemKey: "idem-rk-conc-create-01",
	})
	if respCreate.StatusCode != http.StatusCreated {
		t.Fatalf("create vault = %d %s", respCreate.StatusCode, rawCreate)
	}
	var created vault.VaultCreatedResponse
	_ = json.Unmarshal([]byte(rawCreate), &created)

	// Delete 2 RKs (slots 1 and 2) so 8 remain (slots 1 and 2 are empty).
	if _, err := h.pool.Exec(context.Background(),
		`DELETE FROM vault_recovery_key WHERE vault_id = $1 AND slot IN (1, 2)`,
		meA.User.ID,
	); err != nil {
		t.Fatalf("delete 2 RKs: %v", err)
	}

	grant := h.reauthGrant(jarA, "vault.recovery_keys_regenerate", password)
	ifMatch := `"` + created.VaultKeyID + `:1"`

	// Hold both concurrent HTTP regenerate requests at a barrier after Idempotency.Claim.
	var arrived atomic.Int32
	bothClaimed := make(chan struct{})
	release := make(chan struct{})
	vault.SetRegenerateTestHook(func(_ context.Context) {
		if arrived.Add(1) == 2 {
			close(bothClaimed)
		}
		<-release
	})
	t.Cleanup(func() { vault.SetRegenerateTestHook(nil) })

	type callResult struct {
		status int
		body   string
	}
	results := make([]callResult, 2)
	var wg sync.WaitGroup
	wg.Add(2)

	idemKeys := []string{"idem-rk-conc-regen-key-1", "idem-rk-conc-regen-key-2"}
	for i := range 2 {
		go func(idx int) {
			defer wg.Done()
			localJar := cookieJar{}
			for k, v := range jarA {
				localJar[k] = v
			}
			// Each request attempts to regenerate both empty slots (1 and 2) with distinct hashes.
			items := []vault.RecoveryKeyUploadItem{
				{
					Slot:       1,
					LookupHash: vault.EncodeBase64URL(seqTestBytes(32, byte(0x80+idx*13))),
					Wrap:       makeWrapB64U(t, vault.WrapKindRK, byte(0x80+idx*13)),
				},
				{
					Slot:       2,
					LookupHash: vault.EncodeBase64URL(seqTestBytes(32, byte(0x85+idx*13))),
					Wrap:       makeWrapB64U(t, vault.WrapKindRK, byte(0x85+idx*13)),
				},
			}
			body := mustJSON(t, map[string]any{"recovery_keys": items})
			r, raw := h.doReq(localJar, http.MethodPost, "/api/v1/vault/recovery-keys/regenerate", body, reqOptions{
				idemKey: idemKeys[idx],
				ifMatch: ifMatch,
				grant:   grant,
			})
			results[idx] = callResult{status: r.StatusCode, body: raw}
		}(i)
	}

	select {
	case <-bothClaimed:
		close(release)
	case <-time.After(10 * time.Second):
		t.Fatal("timed out waiting for both regenerate requests at barrier")
	}
	wg.Wait()
	vault.SetRegenerateTestHook(nil)

	okCount := 0
	errCount := 0
	for i, res := range results {
		switch res.status {
		case http.StatusOK:
			okCount++
			var mr vault.RecoveryKeysMutationResponse
			if err := json.Unmarshal([]byte(res.body), &mr); err != nil || mr.Remaining != 10 || mr.Version != 2 {
				t.Fatalf("winner [%d] body = %s, want remaining=10 version=2", i, res.body)
			}
		case http.StatusPreconditionFailed, http.StatusConflict, http.StatusBadRequest:
			errCount++
		default:
			t.Fatalf("unexpected status on concurrent regenerate [%d]: %d %s", i, res.status, res.body)
		}
	}
	if okCount != 1 || errCount != 1 {
		t.Fatalf("concurrent regenerate results: okCount=%d errCount=%d (%+v)", okCount, errCount, results)
	}

	// Verify DB count never exceeded 10.
	var dbCount int
	if err := h.pool.QueryRow(context.Background(),
		`SELECT count(*) FROM vault_recovery_key WHERE vault_id = $1`,
		meA.User.ID,
	).Scan(&dbCount); err != nil {
		t.Fatal(err)
	}
	if dbCount != 10 {
		t.Fatalf("DB recovery key count = %d, want 10", dbCount)
	}
}

// TestRecoveryKeysRegenerateValidationAndUniqueMapping covers Task 11 bullets:
// - regenerate at 10 -> recovery_keys_count (400)
// - occupied slot (or out-of-range / duplicate slot) -> recovery_key_slot_taken (409)
// - duplicate lookup_hash (in-request and cross-user) -> 409 recovery_key_conflict (never 500, no owner leak)
// - wrong-length wrap -> vault_wrap_invalid (400)
func TestRecoveryKeysRegenerateValidationAndUniqueMapping(t *testing.T) {
	h := newHarness(t, harnessOpts{})
	password := "correct-horse-battery-staple"
	jarA, meA := h.signupUser("rk-regen-val-a@example.com", password)
	jarB, _ := h.signupUser("rk-regen-val-b@example.com", password)

	payloadA := makeCreatePayload(t, 0x20)
	respA, rawA := h.doReq(jarA, http.MethodPost, "/api/v1/vault", mustJSON(t, payloadA), reqOptions{
		idemKey: "idem-rk-regen-create-a",
	})
	if respA.StatusCode != http.StatusCreated {
		t.Fatalf("create A = %d %s", respA.StatusCode, rawA)
	}
	var createdA vault.VaultCreatedResponse
	_ = json.Unmarshal([]byte(rawA), &createdA)

	payloadB := makeCreatePayload(t, 0x60)
	respB, rawB := h.doReq(jarB, http.MethodPost, "/api/v1/vault", mustJSON(t, payloadB), reqOptions{
		idemKey: "idem-rk-regen-create-b",
	})
	if respB.StatusCode != http.StatusCreated {
		t.Fatalf("create B = %d %s", respB.StatusCode, rawB)
	}

	grantRegenA := h.reauthGrant(jarA, "vault.recovery_keys_regenerate", password)
	ifMatchA1 := `"` + createdA.VaultKeyID + `:1"`

	// 1. Regenerate when already at 10 RKs -> 400 recovery_keys_count.
	bodyAt10 := mustJSON(t, map[string]any{
		"recovery_keys": []vault.RecoveryKeyUploadItem{
			{
				Slot:       1,
				LookupHash: vault.EncodeBase64URL(seqTestBytes(32, 0x91)),
				Wrap:       makeWrapB64U(t, vault.WrapKindRK, 0x91),
			},
		},
	})
	resp, raw := h.doReq(jarA, http.MethodPost, "/api/v1/vault/recovery-keys/regenerate", bodyAt10, reqOptions{
		idemKey: "idem-rk-regen-at-10",
		ifMatch: ifMatchA1,
		grant:   grantRegenA,
	})
	if resp.StatusCode != http.StatusBadRequest || decodeProblem(t, raw).Code != "recovery_keys_count" {
		t.Fatalf("regenerate at 10 = %d %s, want 400 recovery_keys_count", resp.StatusCode, raw)
	}

	// Delete slots 3 and 8 for User A so remaining=8 and empty_slots=[3, 8].
	if _, err := h.pool.Exec(context.Background(),
		`DELETE FROM vault_recovery_key WHERE vault_id = $1 AND slot IN (3, 8)`,
		meA.User.ID,
	); err != nil {
		t.Fatal(err)
	}

	// 2. Sending 3 keys when only 2 slots are empty -> 400 recovery_keys_count.
	bodyTooMany := mustJSON(t, map[string]any{
		"recovery_keys": []vault.RecoveryKeyUploadItem{
			{Slot: 3, LookupHash: vault.EncodeBase64URL(seqTestBytes(32, 0xA1)), Wrap: makeWrapB64U(t, vault.WrapKindRK, 0xA1)},
			{Slot: 8, LookupHash: vault.EncodeBase64URL(seqTestBytes(32, 0xA2)), Wrap: makeWrapB64U(t, vault.WrapKindRK, 0xA2)},
			{Slot: 9, LookupHash: vault.EncodeBase64URL(seqTestBytes(32, 0xA3)), Wrap: makeWrapB64U(t, vault.WrapKindRK, 0xA3)},
		},
	})
	resp, raw = h.doReq(jarA, http.MethodPost, "/api/v1/vault/recovery-keys/regenerate", bodyTooMany, reqOptions{
		idemKey: "idem-rk-regen-too-many",
		ifMatch: ifMatchA1,
		grant:   grantRegenA,
	})
	if resp.StatusCode != http.StatusBadRequest || decodeProblem(t, raw).Code != "recovery_keys_count" {
		t.Fatalf("regenerate 3 into 2 empty = %d %s, want 400 recovery_keys_count", resp.StatusCode, raw)
	}

	// 3. Occupied slot (slot 1 is already occupied) -> 409 recovery_key_slot_taken.
	bodyOccupied := mustJSON(t, map[string]any{
		"recovery_keys": []vault.RecoveryKeyUploadItem{
			{Slot: 1, LookupHash: vault.EncodeBase64URL(seqTestBytes(32, 0xA4)), Wrap: makeWrapB64U(t, vault.WrapKindRK, 0xA4)},
		},
	})
	resp, raw = h.doReq(jarA, http.MethodPost, "/api/v1/vault/recovery-keys/regenerate", bodyOccupied, reqOptions{
		idemKey: "idem-rk-regen-occupied-slot",
		ifMatch: ifMatchA1,
		grant:   grantRegenA,
	})
	if resp.StatusCode != http.StatusConflict || decodeProblem(t, raw).Code != "recovery_key_slot_taken" {
		t.Fatalf("regenerate occupied slot = %d %s, want 409 recovery_key_slot_taken", resp.StatusCode, raw)
	}

	// 4. Duplicate lookup_hash in-request -> 409 recovery_key_conflict (not 500).
	dupHash := vault.EncodeBase64URL(seqTestBytes(32, 0xA5))
	bodyDupInReq := mustJSON(t, map[string]any{
		"recovery_keys": []vault.RecoveryKeyUploadItem{
			{Slot: 3, LookupHash: dupHash, Wrap: makeWrapB64U(t, vault.WrapKindRK, 0xA5)},
			{Slot: 8, LookupHash: dupHash, Wrap: makeWrapB64U(t, vault.WrapKindRK, 0xA6)},
		},
	})
	resp, raw = h.doReq(jarA, http.MethodPost, "/api/v1/vault/recovery-keys/regenerate", bodyDupInReq, reqOptions{
		idemKey: "idem-rk-regen-dup-in-req",
		ifMatch: ifMatchA1,
		grant:   grantRegenA,
	})
	if resp.StatusCode != http.StatusConflict || decodeProblem(t, raw).Code != "recovery_key_conflict" {
		t.Fatalf("regenerate in-request dup hash = %d %s, want 409 recovery_key_conflict", resp.StatusCode, raw)
	}

	// 5. Cross-user duplicate lookup_hash (collides with User B's slot 1 lookup_hash) -> 409 recovery_key_conflict (no owner leak, not 500).
	bodyCrossUser := mustJSON(t, map[string]any{
		"recovery_keys": []vault.RecoveryKeyUploadItem{
			{Slot: 3, LookupHash: payloadB.RecoveryKeys[0].LookupHash, Wrap: makeWrapB64U(t, vault.WrapKindRK, 0xA7)},
		},
	})
	resp, raw = h.doReq(jarA, http.MethodPost, "/api/v1/vault/recovery-keys/regenerate", bodyCrossUser, reqOptions{
		idemKey: "idem-rk-regen-cross-user",
		ifMatch: ifMatchA1,
		grant:   grantRegenA,
	})
	if resp.StatusCode != http.StatusConflict || decodeProblem(t, raw).Code != "recovery_key_conflict" {
		t.Fatalf("regenerate cross-user dup hash = %d %s, want 409 recovery_key_conflict", resp.StatusCode, raw)
	}
	if strings.Contains(raw, "rk-regen-val-b@example.com") || strings.Contains(raw, payloadB.RecoveryKeys[0].LookupHash) {
		t.Fatalf("cross-user conflict leaked owner or hash: %s", raw)
	}

	// 6. Wrong-length wrap -> 400 vault_wrap_invalid.
	bodyBadWrap := mustJSON(t, map[string]any{
		"recovery_keys": []vault.RecoveryKeyUploadItem{
			{Slot: 3, LookupHash: vault.EncodeBase64URL(seqTestBytes(32, 0xA8)), Wrap: vault.EncodeBase64URL(seqTestBytes(50, 0x01))},
		},
	})
	resp, raw = h.doReq(jarA, http.MethodPost, "/api/v1/vault/recovery-keys/regenerate", bodyBadWrap, reqOptions{
		idemKey: "idem-rk-regen-bad-wrap",
		ifMatch: ifMatchA1,
		grant:   grantRegenA,
	})
	if resp.StatusCode != http.StatusBadRequest || decodeProblem(t, raw).Code != "vault_wrap_invalid" {
		t.Fatalf("regenerate bad wrap = %d %s, want 400 vault_wrap_invalid", resp.StatusCode, raw)
	}

	// 7. Valid regenerate into empty slot 3 -> 200 {remaining: 9, version: 2} + audit recovery_key.regenerate.
	newSlot3Hash := vault.EncodeBase64URL(seqTestBytes(32, 0xA9))
	bodyValidRegen := mustJSON(t, map[string]any{
		"recovery_keys": []vault.RecoveryKeyUploadItem{
			{Slot: 3, LookupHash: newSlot3Hash, Wrap: makeWrapB64U(t, vault.WrapKindRK, 0xA9)},
		},
	})
	resp, raw = h.doReq(jarA, http.MethodPost, "/api/v1/vault/recovery-keys/regenerate", bodyValidRegen, reqOptions{
		idemKey: "idem-rk-regen-valid-slot3",
		ifMatch: ifMatchA1,
		grant:   grantRegenA,
	})
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("valid regenerate = %d %s, want 200", resp.StatusCode, raw)
	}
	var regenRes vault.RecoveryKeysMutationResponse
	if err := json.Unmarshal([]byte(raw), &regenRes); err != nil || regenRes.Remaining != 9 || regenRes.Version != 2 {
		t.Fatalf("regenRes = %+v, want {Remaining:9, Version:2}", regenRes)
	}

	var auditCount int
	if err := h.pool.QueryRow(context.Background(),
		`SELECT count(*) FROM audit_log WHERE user_id = $1 AND event = $2`,
		meA.User.ID, vault.EventRecoveryKeyRegenerate,
	).Scan(&auditCount); err != nil {
		t.Fatal(err)
	}
	if auditCount != 1 {
		t.Fatalf("recovery_key.regenerate audit count = %d, want 1", auditCount)
	}
}

// TestRecoveryKeysRotateReplacesAllOldLookupFailsAndNoReauthBypass covers Task 11 bullets:
//   - Rotate replaces all 10 RKs in one tx, bumps version, audit recovery_key.rotate, notice + mail; old RK lookup -> 401.
//   - Map UNIQUE(lookup_hash) -> 409 recovery_key_conflict and UNIQUE(slot) -> 409 recovery_key_slot_taken on rotate too.
//   - Wrong-length wrap on rotate -> 400 vault_wrap_invalid.
//   - No re-auth bypass via regenerate-then-recover (each route requires its exact action grant; regenerate grant is
//     rejected by recover/complete and vice versa).
func TestRecoveryKeysRotateReplacesAllOldLookupFailsAndNoReauthBypass(t *testing.T) {
	h := newHarness(t, harnessOpts{})
	password := "correct-horse-battery-staple"
	jarA, meA := h.signupUser("rk-rotate-a@example.com", password)
	jarB, _ := h.signupUser("rk-rotate-b@example.com", password)

	// Mark User A's email verified so security email is sent on rotate.
	if _, err := h.pool.Exec(context.Background(),
		`UPDATE app_user SET email_verified_at = now() WHERE id = $1`,
		meA.User.ID,
	); err != nil {
		t.Fatal(err)
	}

	payloadA := makeCreatePayload(t, 0x15)
	respA, rawA := h.doReq(jarA, http.MethodPost, "/api/v1/vault", mustJSON(t, payloadA), reqOptions{
		idemKey: "idem-rk-rotate-create-a",
	})
	if respA.StatusCode != http.StatusCreated {
		t.Fatalf("create A = %d %s", respA.StatusCode, rawA)
	}
	var createdA vault.VaultCreatedResponse
	_ = json.Unmarshal([]byte(rawA), &createdA)

	payloadB := makeCreatePayload(t, 0x55)
	respB, rawB := h.doReq(jarB, http.MethodPost, "/api/v1/vault", mustJSON(t, payloadB), reqOptions{
		idemKey: "idem-rk-rotate-create-b",
	})
	if respB.StatusCode != http.StatusCreated {
		t.Fatalf("create B = %d %s", respB.StatusCode, rawB)
	}

	ifMatchA1 := `"` + createdA.VaultKeyID + `:1"`
	grantRotate := h.reauthGrant(jarA, "vault.recovery_keys_rotate", password)

	// 1. Rotate validation: 9 keys -> 400 recovery_keys_count; duplicate slot -> 409 recovery_key_slot_taken;
	// cross-user duplicate lookup_hash -> 409 recovery_key_conflict; bad wrap -> 400 vault_wrap_invalid.
	newSet := makeCreatePayload(t, 0x90).RecoveryKeys

	resp9, raw9 := h.doReq(jarA, http.MethodPost, "/api/v1/vault/recovery-keys/rotate",
		mustJSON(t, map[string]any{"recovery_keys": newSet[:9]}),
		reqOptions{idemKey: "idem-rot-nine-keys-01", ifMatch: ifMatchA1, grant: grantRotate})
	if resp9.StatusCode != http.StatusBadRequest || decodeProblem(t, raw9).Code != "recovery_keys_count" {
		t.Fatalf("rotate 9 keys = %d %s, want 400 recovery_keys_count", resp9.StatusCode, raw9)
	}

	dupSlotSet := append([]vault.RecoveryKeyUploadItem(nil), newSet...)
	dupSlotSet[8].Slot = 1
	respDupSlot, rawDupSlot := h.doReq(jarA, http.MethodPost, "/api/v1/vault/recovery-keys/rotate",
		mustJSON(t, map[string]any{"recovery_keys": dupSlotSet}),
		reqOptions{idemKey: "idem-rot-dup-slot", ifMatch: ifMatchA1, grant: grantRotate})
	if respDupSlot.StatusCode != http.StatusConflict || decodeProblem(t, rawDupSlot).Code != "recovery_key_slot_taken" {
		t.Fatalf("rotate dup slot = %d %s, want 409 recovery_key_slot_taken", respDupSlot.StatusCode, rawDupSlot)
	}

	crossHashSet := append([]vault.RecoveryKeyUploadItem(nil), newSet...)
	crossHashSet[5].LookupHash = payloadB.RecoveryKeys[2].LookupHash
	respCrossHash, rawCrossHash := h.doReq(jarA, http.MethodPost, "/api/v1/vault/recovery-keys/rotate",
		mustJSON(t, map[string]any{"recovery_keys": crossHashSet}),
		reqOptions{idemKey: "idem-rot-cross-hash", ifMatch: ifMatchA1, grant: grantRotate})
	if respCrossHash.StatusCode != http.StatusConflict || decodeProblem(t, rawCrossHash).Code != "recovery_key_conflict" {
		t.Fatalf("rotate cross-user hash = %d %s, want 409 recovery_key_conflict", respCrossHash.StatusCode, rawCrossHash)
	}

	badWrapSet := append([]vault.RecoveryKeyUploadItem(nil), newSet...)
	badWrapSet[0].Wrap = vault.EncodeBase64URL(seqTestBytes(30, 0x01))
	respBadWrap, rawBadWrap := h.doReq(jarA, http.MethodPost, "/api/v1/vault/recovery-keys/rotate",
		mustJSON(t, map[string]any{"recovery_keys": badWrapSet}),
		reqOptions{idemKey: "idem-rot-bad-wrap", ifMatch: ifMatchA1, grant: grantRotate})
	if respBadWrap.StatusCode != http.StatusBadRequest || decodeProblem(t, rawBadWrap).Code != "vault_wrap_invalid" {
		t.Fatalf("rotate bad wrap = %d %s, want 400 vault_wrap_invalid", respBadWrap.StatusCode, rawBadWrap)
	}

	// 2. Valid Rotate replaces all 10 RKs -> 200 {remaining: 10, version: 2}, audit recovery_key.rotate, notice + mail.
	respRotOK, rawRotOK := h.doReq(jarA, http.MethodPost, "/api/v1/vault/recovery-keys/rotate",
		mustJSON(t, map[string]any{"recovery_keys": newSet}),
		reqOptions{idemKey: "idem-rot-valid-10", ifMatch: ifMatchA1, grant: grantRotate})
	if respRotOK.StatusCode != http.StatusOK {
		t.Fatalf("valid rotate = %d %s, want 200", respRotOK.StatusCode, rawRotOK)
	}
	var rotRes vault.RecoveryKeysMutationResponse
	if err := json.Unmarshal([]byte(rawRotOK), &rotRes); err != nil || rotRes.Remaining != 10 || rotRes.Version != 2 {
		t.Fatalf("rotRes = %+v, want {Remaining:10, Version:2}", rotRes)
	}

	// Old RK lookup now returns 401 recovery_key_invalid for all 10 old RKs!
	for i := range 10 {
		if i > 0 && i%4 == 0 {
			if _, err := h.pool.Exec(context.Background(), `DELETE FROM rate_event WHERE user_id = $1`, meA.User.ID); err != nil {
				t.Fatal(err)
			}
		}
		rOld, rawOld := h.doReq(jarA, http.MethodPost, "/api/v1/vault/unlock/recovery",
			`{"lookup_hash":"`+payloadA.RecoveryKeys[i].LookupHash+`"}`, reqOptions{})
		if rOld.StatusCode != http.StatusUnauthorized || decodeProblem(t, rawOld).Code != "recovery_key_invalid" {
			t.Fatalf("old RK[%d] lookup after rotate = %d %s, want 401 recovery_key_invalid", i, rOld.StatusCode, rawOld)
		}
	}

	if _, err := h.pool.Exec(context.Background(), `DELETE FROM rate_event WHERE user_id = $1`, meA.User.ID); err != nil {
		t.Fatal(err)
	}

	// New RK lookup succeeds (200).
	rNew, rawNew := h.doReq(jarA, http.MethodPost, "/api/v1/vault/unlock/recovery",
		`{"lookup_hash":"`+newSet[0].LookupHash+`"}`, reqOptions{})
	if rNew.StatusCode != http.StatusOK {
		t.Fatalf("new RK[0] lookup after rotate = %d %s, want 200", rNew.StatusCode, rawNew)
	}
	var lookupNew vault.RecoveryLookupResponse
	_ = json.Unmarshal([]byte(rawNew), &lookupNew)
	// Verify audit_log has recovery_key.rotate and user_notification was created.
	var rotAudits, notices, jobs int
	if err := h.pool.QueryRow(context.Background(),
		`SELECT count(*) FROM audit_log WHERE user_id = $1 AND event = $2`,
		meA.User.ID, vault.EventRecoveryKeyRotate,
	).Scan(&rotAudits); err != nil {
		t.Fatal(err)
	}
	if err := h.pool.QueryRow(context.Background(),
		`SELECT count(*) FROM user_notification WHERE user_id = $1`,
		meA.User.ID,
	).Scan(&notices); err != nil {
		t.Fatal(err)
	}
	if err := h.pool.QueryRow(context.Background(),
		`SELECT count(*) FROM river_job WHERE kind = 'security_notice_mail'`,
	).Scan(&jobs); err != nil {
		t.Fatal(err)
	}
	if rotAudits != 1 || notices != 1 || jobs != 1 {
		t.Fatalf("rotate audit=%d notices=%d jobs=%d, want 1/1/1", rotAudits, notices, jobs)
	}
	if beforeWorker := h.countSecurityMailsDelivered("rk-rotate-a@example.com"); beforeWorker != 0 {
		t.Fatalf("direct emails before worker on rotate = %d, want 0", beforeWorker)
	}
	if ran, err := h.runSecurityNoticeWorker(context.Background(), h.mail); err != nil || ran != 1 {
		t.Fatalf("runSecurityNoticeWorker after rotate = (%d, %v), want (1, nil)", ran, err)
	}
	if total := h.countSecurityMailsDelivered("rk-rotate-a@example.com"); total != 1 {
		t.Fatalf("total security emails delivered after rotate = %d, want 1", total)
	}

	// 3. No re-auth bypass via regenerate-then-recover (or recover-then-regenerate):
	// - Using a `vault.recovery_keys_regenerate` grant on `POST /vault/recover/complete` -> 401 reauth_invalid.
	grantRegen := h.reauthGrant(jarA, "vault.recovery_keys_regenerate", password)
	completeBody := mustJSON(t, makeRecoverCompletePayload(t, lookupNew.RecoveryKeyID, 0xC1))
	respBypass1, rawBypass1 := h.doReq(jarA, http.MethodPost, "/api/v1/vault/recover/complete", completeBody, reqOptions{
		idemKey: "idem-no-bypass-regen-on-recover",
		ifMatch: `"` + createdA.VaultKeyID + `:2"`,
		grant:   grantRegen,
	})
	if respBypass1.StatusCode != http.StatusUnauthorized || decodeProblem(t, rawBypass1).Code != "reauth_invalid" {
		t.Fatalf("recover/complete with regenerate grant = %d %s, want 401 reauth_invalid", respBypass1.StatusCode, rawBypass1)
	}

	// - Now obtain a valid `vault.recover` grant and complete recovery (consumes slot 1, bumps version to 3).
	grantRecover := h.reauthGrant(jarA, "vault.recover", password)
	respRecOK, rawRecOK := h.doReq(jarA, http.MethodPost, "/api/v1/vault/recover/complete", completeBody, reqOptions{
		idemKey: "idem-valid-recover-before-regen",
		ifMatch: `"` + createdA.VaultKeyID + `:2"`,
		grant:   grantRecover,
	})
	if respRecOK.StatusCode != http.StatusOK {
		t.Fatalf("recover/complete with recover grant = %d %s, want 200", respRecOK.StatusCode, rawRecOK)
	}

	// - Attempting to reuse that `vault.recover` grant on `POST /vault/recovery-keys/regenerate` -> 401 reauth_invalid!
	regenSlot1Body := mustJSON(t, map[string]any{
		"recovery_keys": []vault.RecoveryKeyUploadItem{
			{Slot: 1, LookupHash: vault.EncodeBase64URL(seqTestBytes(32, 0xD5)), Wrap: makeWrapB64U(t, vault.WrapKindRK, 0xD5)},
		},
	})
	respBypass2, rawBypass2 := h.doReq(jarA, http.MethodPost, "/api/v1/vault/recovery-keys/regenerate", regenSlot1Body, reqOptions{
		idemKey: "idem-no-bypass-recover-on-regen",
		ifMatch: `"` + createdA.VaultKeyID + `:3"`,
		grant:   grantRecover,
	})
	if respBypass2.StatusCode != http.StatusUnauthorized || decodeProblem(t, rawBypass2).Code != "reauth_invalid" {
		t.Fatalf("regenerate with recover grant = %d %s, want 401 reauth_invalid", respBypass2.StatusCode, rawBypass2)
	}

	// - With the proper `vault.recovery_keys_regenerate` grant, regenerating slot 1 succeeds -> 200 {remaining: 10, version: 4}.
	respRegenOK, rawRegenOK := h.doReq(jarA, http.MethodPost, "/api/v1/vault/recovery-keys/regenerate", regenSlot1Body, reqOptions{
		idemKey: "idem-valid-regen-after-recover",
		ifMatch: `"` + createdA.VaultKeyID + `:3"`,
		grant:   grantRegen,
	})
	if respRegenOK.StatusCode != http.StatusOK {
		t.Fatalf("regenerate with regenerate grant = %d %s, want 200", respRegenOK.StatusCode, rawRegenOK)
	}
}
