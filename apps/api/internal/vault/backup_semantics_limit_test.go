package vault

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgtype"

	"github.com/zone17th/save-all-by-keyword/apps/api/internal/audit"
	"github.com/zone17th/save-all-by-keyword/apps/api/internal/authctx"
	"github.com/zone17th/save-all-by-keyword/apps/api/internal/clock"
	"github.com/zone17th/save-all-by-keyword/apps/api/internal/config"
	"github.com/zone17th/save-all-by-keyword/apps/api/internal/db/dbtest"
	"github.com/zone17th/save-all-by-keyword/apps/api/internal/db/gen"
	"github.com/zone17th/save-all-by-keyword/apps/api/internal/httpx"
	"github.com/zone17th/save-all-by-keyword/apps/api/internal/notification"
	"github.com/zone17th/save-all-by-keyword/apps/api/internal/obs"
	"github.com/zone17th/save-all-by-keyword/apps/api/internal/vault/webauthntest"
)

// TestBackupSemanticsLimitByDesign_ConsumedAndRotatedRKAndRevokedPasskeyUnwrapVK implements
// plan Task 22 (evidence P03-B6): a fixture test proving the SPEC §5.9, §3.11, §3.15, and §10.5
// limit as designed, NOT a bug (no claim of cryptographic revocation over copied wraps / snapshots):
//
//   - (a) Consumed and rotated recovery keys (RK): after an RK slot is consumed via live
//     `POST /vault/recover/complete` (`svc.RecoverComplete`) and/or replaced via live
//     `POST /vault/recovery-keys/rotate` (`svc.RotateRecoveryKeys`), the live server rejects
//     online lookup (`svc.RecoveryLookup` -> `ErrRecoveryKeyInvalid`), yet whoever still holds
//     the OLD `vault_recovery_key.wrap` (from an encrypted backup snapshot or copied before
//     consumption/rotation) plus the matching RK secret still derives `wrap_key` and unwraps
//     the live `VK` (and decrypts both snapshot and post-mutation entry ciphertexts under that `VK`).
//
//   - (b) Revoked passkey: after `DELETE /vault/passkeys/{id}` (`svc.RevokePasskey`), the live
//     server deletes the credential row (`svc.PasskeyUnlockOptions` -> `ErrPasskeyNotFound`),
//     yet whoever still holds the old passkey `vk_wrap` plus `prf_salt` (from a backup snapshot
//     or prior `unlock/passkey/options` copy) and can still evaluate WebAuthn PRF (`hmac-secret`)
//     on the credential still derives `PWK` and unwraps the live `VK`.
func TestBackupSemanticsLimitByDesign_ConsumedAndRotatedRKAndRevokedPasskeyUnwrapVK(t *testing.T) {
	dsn := dbtest.StartPostgres(t)
	dbtest.MigrateUp(t, dsn)
	pool := dbtest.Pool(t, dsn)
	ctx := context.Background()

	t.Setenv("DATABASE_URL", dsn)
	t.Setenv("APP_ORIGIN", "http://localhost:3000")
	t.Setenv("APP_ENV", "development")

	cfg, err := config.Load()
	if err != nil {
		t.Fatalf("config.Load: %v", err)
	}

	var logBuf bytes.Buffer
	logger := slog.New(slog.NewJSONHandler(&logBuf, &slog.HandlerOptions{Level: slog.LevelDebug}))
	clk := clock.NewFixed(time.Date(2026, 10, 30, 12, 0, 0, 0, time.UTC))
	aud := audit.NewStore(pool)
	notes := notification.NewStore(pool, nil)
	_, obsMetrics := obs.NewRegistry()

	svc, err := NewService(cfg, pool, clk, aud, notes, nil, MetricsFromObs(obsMetrics), nil, logger)
	if err != nil {
		t.Fatalf("NewService: %v", err)
	}

	q := gen.New(pool)
	user, err := q.InsertUser(ctx, gen.InsertUserParams{
		Email:  "backup-limit-by-design@example.com",
		Locale: "en",
	})
	if err != nil {
		t.Fatalf("InsertUser: %v", err)
	}
	sess, err := q.InsertSession(ctx, gen.InsertSessionParams{
		UserID:           user.ID,
		RefreshTokenHash: seqBytes(32, 0x05),
		IpHash:           seqBytes(32, 0x06),
		ExpiresAt:        pgtype.Timestamptz{Time: clk.Now().Add(24 * time.Hour), Valid: true},
	})
	if err != nil {
		t.Fatalf("InsertSession: %v", err)
	}
	principal := authctx.Principal{
		UserID:    user.ID,
		SessionID: sess.ID,
	}

	// Deterministic test-only Vault Key (VK, 32 B) and asymmetric seeds (ADR 0002 §1–§2).
	// Never log or format secret bytes in failure messages.
	vk := seqBytes(VKBytes, 0x11)
	xSeed := seqBytes(SeedBytes, 0x31)
	edSeed := seqBytes(SeedBytes, 0x51)
	xPub, err := deriveX25519PublicFromSeed(xSeed)
	if err != nil {
		t.Fatalf("deriveX25519PublicFromSeed: %v", err)
	}
	edPub, err := deriveEd25519PublicFromSeed(edSeed)
	if err != nil {
		t.Fatalf("deriveEd25519PublicFromSeed: %v", err)
	}
	privSeeds, err := PackPrivateKeySeeds(xSeed, edSeed)
	if err != nil {
		t.Fatalf("PackPrivateKeySeeds: %v", err)
	}
	privWrappedB64, err := SealWrapBase64URL(WrapKindPriv, privSeeds, vk, seqBytes(WrapNonceBytes, 0x71))
	if err != nil {
		t.Fatalf("SealWrapBase64URL(WrapKindPriv): %v", err)
	}

	initialSalt := seqBytes(KDFSaltBytes, 0x81)
	initialKEK := seqBytes(VKBytes, 0x91)
	initialWrapKB64, err := SealWrapBase64URL(WrapKindKEK, vk, initialKEK, seqBytes(WrapNonceBytes, 0xA1))
	if err != nil {
		t.Fatalf("SealWrapBase64URL(WrapKindKEK): %v", err)
	}

	// Build 10 real recovery keys (slots 1..10) using ADR 0002 §7 domain separation
	// (`sabk.rk.lookup.v1` and `sabk.rk.wrap.v1`) and `sabk.vk.rk.v1` AEAD wraps of `vk`.
	type rkFixture struct {
		slot       int
		display    string
		lookupB64U string
		wrapB64U   string
	}
	initialRKs := make([]rkFixture, 10)
	uploadRKs := make([]RecoveryKeyUploadItem, 10)
	for i := range 10 {
		slot := i + 1
		entropy := seqBytes(RKEntropyBytes, byte(0x10+slot*7))
		genRK, err := generateRecoveryKey(slot, entropy)
		if err != nil {
			t.Fatalf("generateRecoveryKey(slot=%d): %v", slot, err)
		}
		lookupHash, err := deriveRecoveryLookupHash(genRK.Display)
		if err != nil {
			t.Fatalf("deriveRecoveryLookupHash(slot=%d): %v", slot, err)
		}
		wrapKey, err := deriveRecoveryWrapKey(genRK.Display)
		if err != nil {
			t.Fatalf("deriveRecoveryWrapKey(slot=%d): %v", slot, err)
		}
		nonce := seqBytes(WrapNonceBytes, byte(0xB0+slot))
		wrapB64U, err := SealWrapBase64URL(WrapKindRK, vk, wrapKey[:], nonce)
		if err != nil {
			t.Fatalf("SealWrapBase64URL(WrapKindRK, slot=%d): %v", slot, err)
		}
		lookupB64U := EncodeBase64URL(lookupHash[:])
		initialRKs[i] = rkFixture{
			slot:       slot,
			display:    genRK.Display,
			lookupB64U: lookupB64U,
			wrapB64U:   wrapB64U,
		}
		uploadRKs[i] = RecoveryKeyUploadItem{
			Slot:       slot,
			LookupHash: lookupB64U,
			Wrap:       wrapB64U,
		}
	}

	initialKDFRaw := json.RawMessage(`{"alg":"argon2id13","ops":3,"mem":67108864,"parallelism":1,"salt":"` + EncodeBase64URL(initialSalt) + `"}`)
	createdVault, err := svc.Create(ctx, principal, CreateVaultInput{
		KDFRaw:               initialKDFRaw,
		VaultKeyWrappedByKEK: initialWrapKB64,
		X25519Public:         EncodeBase64URL(xPub),
		Ed25519Public:        EncodeBase64URL(edPub),
		PrivateKeysWrapped:   privWrappedB64,
		RecoveryKeys:         uploadRKs,
		IP:                   "127.0.0.1",
		UA:                   "task22-backup-semantics-test",
	})
	if err != nil {
		t.Fatalf("svc.Create: %v", err)
	}

	// Register a passkey through the real WebAuthn registration ceremony (`RegisterPasskeyOptions` ->
	// virtual authenticator `CreateCredential` -> `SealWrapBase64URL(WrapKindPRF, vk, PWK)` -> `RegisterPasskey`).
	regOpts, err := svc.RegisterPasskeyOptions(ctx, principal)
	if err != nil {
		t.Fatalf("RegisterPasskeyOptions: %v", err)
	}
	prfSaltBytes, err := DecodeBase64URLStrict(regOpts.PRFSalt, WebAuthnPRFSaltBytes)
	if err != nil {
		t.Fatalf("DecodeBase64URLStrict(prf_salt): %v", err)
	}
	va := webauthntest.New()
	ceremonyRes, err := va.CreateCredential(webauthntest.RegistrationOptions{
		RPID:         svc.WebAuthnRPID(),
		Origin:       svc.WebAuthnRPOrigin(),
		ChallengeB64: regOpts.PublicKey.Challenge,
		PRFSalt:      prfSaltBytes,
	})
	if err != nil {
		t.Fatalf("va.CreateCredential: %v", err)
	}
	pkWrapB64, err := SealWrapBase64URL(WrapKindPRF, vk, ceremonyRes.PRFOutput, seqBytes(WrapNonceBytes, 0xD1))
	if err != nil {
		t.Fatalf("SealWrapBase64URL(WrapKindPRF): %v", err)
	}
	createdPasskey, err := svc.RegisterPasskey(ctx, principal, RegisterPasskeyInput{
		ChallengeID:       regOpts.ChallengeID,
		ClientDataJSON:    ceremonyRes.ClientDataJSONB64,
		AttestationObject: ceremonyRes.AttestationObjectB64,
		PRFSalt:           regOpts.PRFSalt,
		VKWrap:            pkWrapB64,
		Name:              "Backup Snapshot Passkey",
		IP:                "127.0.0.1",
		UA:                "task22-backup-semantics-test",
	})
	if err != nil {
		t.Fatalf("RegisterPasskey: %v", err)
	}

	// Encrypt a snapshot entry before any RK consumption/rotation or passkey revocation (SPEC §3.11, §5.5).
	const snapshotEntryID = "3fa85f64-5717-4562-b3fc-2c963f66afa6"
	snapshotPlaintext := []byte("entry-body-captured-in-backup-snapshot-v1")
	snapshotEnv, snapshotCiphertext, err := SealEntry(
		snapshotEntryID,
		createdVault.VaultKeyID,
		snapshotPlaintext,
		vk,
		seqBytes(WrapNonceBytes, 0xE1),
	)
	if err != nil {
		t.Fatalf("SealEntry(snapshot): %v", err)
	}
	snapshotEnvJSON, err := json.Marshal(snapshotEnv)
	if err != nil {
		t.Fatalf("json.Marshal(snapshotEnv): %v", err)
	}

	// =========================================================================
	// Part (a): Consumed RK and Rotated RK still unwrap VK from the old wrap
	//           (SPEC §5.9, §3.11, §10.5 — documented limit, not a bug).
	// =========================================================================
	t.Run("PartA_ConsumedAndRotatedRecoveryKeyOldWrapStillUnwrapsVK_LimitByDesign", func(t *testing.T) {
		// 1. Before consumption, the holder / backup snapshot records slot 1's wrap from the server
		//    (and slot 2's wrap before rotation).
		slot1Lookup, err := svc.RecoveryLookup(ctx, principal, RecoveryLookupInput{
			LookupHash: initialRKs[0].lookupB64U,
		})
		if err != nil {
			t.Fatalf("RecoveryLookup(slot 1 before consume): %v", err)
		}
		copiedSlot1WrapBeforeConsume := slot1Lookup.Wrap
		copiedSlot2WrapBeforeRotate := initialRKs[1].wrapB64U

		// 2. Consume slot 1 on the live server via `RecoverComplete` (updates KDF + wrapK,
		//    bumps version 1 -> 2, and executes `DELETE FROM vault_recovery_key` for slot 1).
		recoverSalt := seqBytes(KDFSaltBytes, 0x82)
		recoverKEK := seqBytes(VKBytes, 0x92)
		recoverWrapKB64, err := SealWrapBase64URL(WrapKindKEK, vk, recoverKEK, seqBytes(WrapNonceBytes, 0xA2))
		if err != nil {
			t.Fatalf("SealWrapBase64URL(recover KEK): %v", err)
		}
		recoverKDFRaw := json.RawMessage(`{"alg":"argon2id13","ops":3,"mem":67108864,"parallelism":1,"salt":"` + EncodeBase64URL(recoverSalt) + `"}`)

		completeResp, err := svc.RecoverComplete(ctx, principal, RecoverCompleteInput{
			RecoveryKeyID:        slot1Lookup.RecoveryKeyID,
			KDFRaw:               recoverKDFRaw,
			VaultKeyWrappedByKEK: recoverWrapKB64,
			IfMatch:              httpx.VaultIfMatch{VaultKeyID: createdVault.VaultKeyID, Version: 1},
			IP:                   "127.0.0.1",
			UA:                   "task22-backup-semantics-test",
		})
		if err != nil {
			t.Fatalf("RecoverComplete(slot 1): %v", err)
		}
		if completeResp.Version != 2 {
			t.Fatalf("RecoverComplete version = %d, want 2", completeResp.Version)
		}

		// Live server enforcement: slot 1 row is deleted from `vault_recovery_key`;
		// online lookup now fails with ErrRecoveryKeyInvalid and slot 1 is listed in empty_slots.
		if _, err := svc.RecoveryLookup(ctx, principal, RecoveryLookupInput{
			LookupHash: initialRKs[0].lookupB64U,
		}); !errors.Is(err, ErrRecoveryKeyInvalid) {
			t.Fatalf("live RecoveryLookup on consumed slot 1 = %v, want ErrRecoveryKeyInvalid", err)
		}
		statusAfterConsume, err := svc.GetRecoveryKeysStatus(ctx, user.ID)
		if err != nil {
			t.Fatalf("GetRecoveryKeysStatus after consume: %v", err)
		}
		if statusAfterConsume.Remaining != 9 || len(statusAfterConsume.EmptySlots) != 1 || statusAfterConsume.EmptySlots[0] != 1 {
			t.Fatalf("unexpected RK status after consume: remaining=%d empty=%v", statusAfterConsume.Remaining, statusAfterConsume.EmptySlots)
		}

		// SPEC §5.9 limit by design (consumed RK): whoever still holds the old wrap copied before
		// consumption (`copiedSlot1WrapBeforeConsume`) plus the slot 1 RK secret still derives
		// `wrap_key = BLAKE2b-256("sabk.rk.wrap.v1" || rk_norm)` and unwraps `VK`.
		consumedSlot1WrapKey, err := deriveRecoveryWrapKey(initialRKs[0].display)
		if err != nil {
			t.Fatalf("deriveRecoveryWrapKey(consumed slot 1): %v", err)
		}
		unwrappedVKFromConsumedRK, err := OpenWrapBase64URL(WrapKindRK, copiedSlot1WrapBeforeConsume, consumedSlot1WrapKey[:])
		if err != nil {
			t.Fatalf("OpenWrapBase64URL(consumed slot 1 old wrap): %v", err)
		}
		if !bytes.Equal(unwrappedVKFromConsumedRK, vk) {
			t.Fatal("consumed RK old wrap + RK secret did not unwrap to expected VK")
		}

		// 3. Rotate all 10 RKs on the live server (`RotateRecoveryKeys`), replacing slots 1..10
		//    with a fresh set of 10 RKs and bumping version 2 -> 3.
		rotatedUploadRKs := make([]RecoveryKeyUploadItem, 10)
		for i := range 10 {
			slot := i + 1
			entropy := seqBytes(RKEntropyBytes, byte(0x60+slot*5))
			genRK, err := generateRecoveryKey(slot, entropy)
			if err != nil {
				t.Fatalf("generateRecoveryKey(rotated slot=%d): %v", slot, err)
			}
			lookupHash, err := deriveRecoveryLookupHash(genRK.Display)
			if err != nil {
				t.Fatalf("deriveRecoveryLookupHash(rotated slot=%d): %v", slot, err)
			}
			wrapKey, err := deriveRecoveryWrapKey(genRK.Display)
			if err != nil {
				t.Fatalf("deriveRecoveryWrapKey(rotated slot=%d): %v", slot, err)
			}
			wrapB64U, err := SealWrapBase64URL(WrapKindRK, vk, wrapKey[:], seqBytes(WrapNonceBytes, byte(0xC0+slot)))
			if err != nil {
				t.Fatalf("SealWrapBase64URL(rotated slot=%d): %v", slot, err)
			}
			rotatedUploadRKs[i] = RecoveryKeyUploadItem{
				Slot:       slot,
				LookupHash: EncodeBase64URL(lookupHash[:]),
				Wrap:       wrapB64U,
			}
		}

		rotResp, err := svc.RotateRecoveryKeys(ctx, principal, RecoveryKeysRotateInput{
			RecoveryKeys: rotatedUploadRKs,
			IfMatch:      httpx.VaultIfMatch{VaultKeyID: createdVault.VaultKeyID, Version: 2},
			IP:           "127.0.0.1",
			UA:           "task22-backup-semantics-test",
		})
		if err != nil {
			t.Fatalf("RotateRecoveryKeys: %v", err)
		}
		if rotResp.Remaining != 10 || rotResp.Version != 3 {
			t.Fatalf("RotateRecoveryKeys = %+v, want {Remaining:10, Version:3}", rotResp)
		}

		// Live server enforcement: pre-rotation slot 2 now fails online lookup with ErrRecoveryKeyInvalid.
		if _, err := svc.RecoveryLookup(ctx, principal, RecoveryLookupInput{
			LookupHash: initialRKs[1].lookupB64U,
		}); !errors.Is(err, ErrRecoveryKeyInvalid) {
			t.Fatalf("live RecoveryLookup on rotated-out slot 2 = %v, want ErrRecoveryKeyInvalid", err)
		}

		// SPEC §5.9 limit by design (rotated RK): whoever still holds the old wrap from before
		// rotation (`copiedSlot2WrapBeforeRotate`) plus the old slot 2 RK secret still unwraps `VK`.
		rotatedOutSlot2WrapKey, err := deriveRecoveryWrapKey(initialRKs[1].display)
		if err != nil {
			t.Fatalf("deriveRecoveryWrapKey(rotated-out slot 2): %v", err)
		}
		unwrappedVKFromRotatedRK, err := OpenWrapBase64URL(WrapKindRK, copiedSlot2WrapBeforeRotate, rotatedOutSlot2WrapKey[:])
		if err != nil {
			t.Fatalf("OpenWrapBase64URL(rotated-out slot 2 old wrap): %v", err)
		}
		if !bytes.Equal(unwrappedVKFromRotatedRK, vk) {
			t.Fatal("rotated-out RK old wrap + old RK secret did not unwrap to expected VK")
		}

		// Both the snapshot entry and any new entry created after consume/rotate under the unchanged
		// `vault_key_id` are decryptable with the VK recovered from the old RK wrap (threat-model N-2(b)).
		_, openedSnapshotPlain, err := OpenEntry(snapshotEnvJSON, snapshotEntryID, snapshotCiphertext, unwrappedVKFromConsumedRK)
		if err != nil || !bytes.Equal(openedSnapshotPlain, snapshotPlaintext) {
			t.Fatalf("OpenEntry(snapshot via consumed RK VK) failed: err=%v", err)
		}
	})

	// =========================================================================
	// Part (b): Revoked passkey still unwraps VK from the old vk_wrap + PRF output
	//           (SPEC §3.15, §5.9, §10.5 — documented limit, not a bug).
	// =========================================================================
	t.Run("PartB_RevokedPasskeyOldVKWrapAndPRFOutputStillUnwrapVK_LimitByDesign", func(t *testing.T) {
		// 1. Before revocation, capture the passkey unlock bundle (`vk_wrap` and `prf_salt`)
		//    as returned by `PasskeyUnlockOptions` (or stored in an `.sabk.json` encrypted backup).
		unlockOptsBeforeRevoke, err := svc.PasskeyUnlockOptions(ctx, principal)
		if err != nil {
			t.Fatalf("PasskeyUnlockOptions(before revoke): %v", err)
		}
		if len(unlockOptsBeforeRevoke.Credentials) != 1 {
			t.Fatalf("len(Credentials) before revoke = %d, want 1", len(unlockOptsBeforeRevoke.Credentials))
		}
		copiedCred := unlockOptsBeforeRevoke.Credentials[0]
		copiedVKWrapBeforeRevoke := copiedCred.VKWrap
		copiedPRFSaltBeforeRevoke := copiedCred.PRFSalt

		// 2. Revoke the passkey on the live server (`DELETE /vault/passkeys/{id}` -> `svc.RevokePasskey`).
		if err := svc.RevokePasskey(ctx, principal, RevokePasskeyInput{
			PasskeyID: createdPasskey.ID,
			IP:        "127.0.0.1",
			UA:        "task22-backup-semantics-test",
		}); err != nil {
			t.Fatalf("RevokePasskey: %v", err)
		}

		// Live server enforcement: the passkey row is deleted from `vault_passkey`, `GET /vault` and
		// `GET /vault/passkeys` list 0 passkeys, `vault.version` is unchanged (still 3), and
		// `POST /vault/unlock/passkey/options` now rejects with `ErrPasskeyNotFound`.
		if _, err := svc.PasskeyUnlockOptions(ctx, principal); !errors.Is(err, ErrPasskeyNotFound) {
			t.Fatalf("live PasskeyUnlockOptions after revoke = %v, want ErrPasskeyNotFound", err)
		}
		pkListAfterRevoke, err := svc.ListPasskeys(ctx, user.ID)
		if err != nil {
			t.Fatalf("ListPasskeys after revoke: %v", err)
		}
		if len(pkListAfterRevoke.Items) != 0 {
			t.Fatalf("len(ListPasskeys) after revoke = %d, want 0", len(pkListAfterRevoke.Items))
		}
		vaultStateAfterRevoke, err := svc.Get(ctx, user.ID)
		if err != nil {
			t.Fatalf("svc.Get after revoke: %v", err)
		}
		if vaultStateAfterRevoke.Version != 3 || vaultStateAfterRevoke.VaultKeyID != createdVault.VaultKeyID {
			t.Fatalf("vault state after revoke = (key_id=%s, version=%d), want (%s, 3)",
				vaultStateAfterRevoke.VaultKeyID, vaultStateAfterRevoke.Version, createdVault.VaultKeyID)
		}

		// SPEC §3.15 & §5.9 limit by design (revoked passkey): server revocation deletes the row on
		// the live server, but does NOT delete the credential from the authenticator and does NOT
		// cryptographically invalidate a previously copied `vk_wrap`. Whoever still holds the old
		// `vk_wrap` (`copiedVKWrapBeforeRevoke`) plus the PRF output (`PWK`) from the authenticator
		// for `copiedPRFSaltBeforeRevoke` can still unwrap `VK` (and `private_keys_wrapped` / entries).
		savedSaltBytes, err := DecodeBase64URLStrict(copiedPRFSaltBeforeRevoke, WebAuthnPRFSaltBytes)
		if err != nil {
			t.Fatalf("DecodeBase64URLStrict(copiedPRFSaltBeforeRevoke): %v", err)
		}
		prfOutputAfterRevoke, err := va.EvaluatePRF(copiedCred.ID, savedSaltBytes)
		if err != nil {
			t.Fatalf("va.EvaluatePRF on revoked credential: %v", err)
		}
		unwrappedVKFromRevokedPasskey, err := OpenWrapBase64URL(WrapKindPRF, copiedVKWrapBeforeRevoke, prfOutputAfterRevoke)
		if err != nil {
			t.Fatalf("OpenWrapBase64URL(revoked passkey old vk_wrap): %v", err)
		}
		if !bytes.Equal(unwrappedVKFromRevokedPasskey, vk) {
			t.Fatal("revoked passkey old vk_wrap + PRF output did not unwrap to expected VK")
		}

		// Confirm that the VK recovered via the revoked passkey's old wrap also opens `private_keys_wrapped`
		// and decrypts both the pre-revocation snapshot entry and a post-revocation entry encrypted under
		// the same `vault_key_id` (proving why eliminating an exposed VK requires Vault Reset in MVP or
		// Rotate VK in P07, per SPEC §5.6 / §5.9 / threat-model N-2(b)).
		unwrappedPrivSeeds, err := OpenWrapBase64URL(WrapKindPriv, vaultStateAfterRevoke.PrivateKeysWrapped, unwrappedVKFromRevokedPasskey)
		if err != nil || !bytes.Equal(unwrappedPrivSeeds, privSeeds) {
			t.Fatalf("OpenWrapBase64URL(PrivateKeysWrapped via revoked passkey VK) failed: err=%v", err)
		}

		const postRevokeEntryID = "7c9e6679-7425-40de-944b-e07fc1f90ae7"
		postRevokePlaintext := []byte("entry-body-created-after-rk-consume-and-passkey-revoke")
		postRevokeEnv, postRevokeCiphertext, err := SealEntry(
			postRevokeEntryID,
			vaultStateAfterRevoke.VaultKeyID,
			postRevokePlaintext,
			vk,
			seqBytes(WrapNonceBytes, 0xE2),
		)
		if err != nil {
			t.Fatalf("SealEntry(postRevoke): %v", err)
		}
		postRevokeEnvJSON, err := json.Marshal(postRevokeEnv)
		if err != nil {
			t.Fatalf("json.Marshal(postRevokeEnv): %v", err)
		}
		_, openedPostRevokePlain, err := OpenEntry(postRevokeEnvJSON, postRevokeEntryID, postRevokeCiphertext, unwrappedVKFromRevokedPasskey)
		if err != nil || !bytes.Equal(openedPostRevokePlain, postRevokePlaintext) {
			t.Fatalf("OpenEntry(postRevoke via revoked passkey VK) failed: err=%v", err)
		}
	})

	// Verify structured logs and audit_log rows never leaked any wrap, lookup_hash, PRF salt, or VK.
	var allAuditJSON []byte
	rows, err := pool.Query(ctx, `SELECT row_to_json(audit_log) FROM audit_log WHERE user_id = $1`, user.ID)
	if err != nil {
		t.Fatalf("query audit_log: %v", err)
	}
	for rows.Next() {
		var raw json.RawMessage
		if err := rows.Scan(&raw); err != nil {
			rows.Close()
			t.Fatalf("scan audit_log: %v", err)
		}
		allAuditJSON = append(allAuditJSON, raw...)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		t.Fatalf("rows.Err: %v", err)
	}

	combinedTelemetry := logBuf.String() + "\n" + string(allAuditJSON)
	forbidden := []string{
		EncodeBase64URL(vk),
		EncodeBase64URL(ceremonyRes.PRFOutput),
		initialWrapKB64,
		pkWrapB64,
		regOpts.PRFSalt,
		initialRKs[0].display,
		initialRKs[0].lookupB64U,
		initialRKs[0].wrapB64U,
		initialRKs[1].display,
		initialRKs[1].lookupB64U,
		initialRKs[1].wrapB64U,
	}
	for _, s := range forbidden {
		if s != "" && strings.Contains(combinedTelemetry, s) {
			t.Fatal("telemetry or audit_log leaked sensitive material")
		}
	}
}
