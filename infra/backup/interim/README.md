# engram interim nightly encrypted DB backup (P06-BACKUPNOW)

Interim safety net until the P06 WAL/PITR ops tasks land. Does not replace them.

## What runs

- `engram-backup.sh` runs `docker exec engram-db-1 pg_dump -U engram -Fc engram` and streams it straight into
  `gpg --encrypt --recipient F2C47029212F6EE7A9D4D1779D5A1ABAB6A75AD7` (public key only, in
  `/home/ubuntu/engram-ops/backup/gnupg`, mode 700). No plaintext dump is ever written to disk. The private key is
  NOT on this host.
- Schedule: user systemd timer `engram-backup.timer` (user `ubuntu`, linger on), daily 03:17 Asia/Ho_Chi_Minh
  (host TZ is Asia/Ho_Chi_Minh), `Persistent=true` (runs on next boot if missed).
- Exit codes: 0 ok; 1 failure (pg_dump/gpg error or dump < 10 KB; previous backups untouched, `.partial` removed);
  2 skipped because `/` has < 3 GB free (logged; treated as success by systemd).

## Where files land

- `~/backups/engram/nightly/engram-<UTC ts>.dump.gpg` (mode 600; written as `.partial`, then renamed).
- Newest 7 kept; older `engram-*.dump.gpg` in `nightly/` deleted. Manual dumps/env backups in `~/backups/engram/`
  are never touched.
- `~/backups/engram/nightly/last.json`: `{"ts","bytes","sha256","ok"}` of the last successful run.
- Log: `/home/ubuntu/engram-ops/backup/backup.log` (START/OK/FAIL/SKIP/PRUNE lines, pg_dump/gpg stderr; no secrets).

## Restore (on a machine holding the private key)

```sh
sha256sum engram-<ts>.dump.gpg                 # compare with last.json / backup.log
gpg -d engram-<ts>.dump.gpg | pg_restore --list   # inspect
createdb scratch_restore
gpg -d engram-<ts>.dump.gpg | pg_restore --no-owner -d scratch_restore
```

Restore into a scratch DB first; never restore over production without an explicit go.

## Check / run / disable

```sh
systemctl --user list-timers engram-backup.timer
systemctl --user start engram-backup.service        # run now
journalctl --user -u engram-backup.service -n 50
systemctl --user disable --now engram-backup.timer  # disable
```

Unit files: `~/.config/systemd/user/engram-backup.{service,timer}` (copies in the repo under `infra/backup/interim/`).
