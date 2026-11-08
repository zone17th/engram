<#
.SYNOPSIS
  engram off-host 8-day retention sweep for the owner-PC backup copy (P06 Task 22, retention contract (a)/(b)/(e);
  review r1 R1-03, advisor-dec-P06-059).

.DESCRIPTION
  Same rule as infra/backup/expire/engram-backup-expire.sh, so a pulled copy can never outlive the 8-day promise:
  age = immutable source timestamp in the exact file NAME (never mtime: a pull gives every copy a fresh mtime), and
  every recognised backup with now - source_ts >= 7d22h (684000 s) is deleted. Recognised names (anchored):
    engram-<ts>.dump.gpg[.sha256|.partial]
    engram-base-<ts>.tar.gz.gpg[.sha256|.partial|.sha256.partial]
    <ts>--<wal>.gz.gpg[.sha256|.partial|.sha256.partial]   <wal> = 24 HEX [.partial] | 24 HEX.<8 HEX>.backup | <8 HEX>.history
    engram-pre-p0<N>-<ts>.dump[.sha256]
  Any other backup-like file (.gpg .dump .sha256 .partial .tar .gz .sql), an impossible date, or a name > 5 min in the
  future is KEPT and the sweep reports ok:false (exit 1); so does any enumeration/delete error. Reparse points
  (symlinks/junctions) are neither followed nor deleted.

  Runs hourly from Task Scheduler (engram-offhost-expire.task.xml: hourly repetition, StartWhenAvailable = a missed
  run starts as soon as the PC is available, plus a run at logon), INDEPENDENT of the pull: a pull may call it
  again before copying, never instead of it. Writes <Root>\expire\last-sweep.json and appends <Root>\expire\expire.log.
  Windows PowerShell 5.1 and PowerShell 7 compatible.

.PARAMETER Root
  The off-host copy root (default: $env:ENGRAM_OFFHOST_ROOT). Test clock: $env:EXPIRE_NOW_EPOCH (epoch seconds).
#>
param([string]$Root = $env:ENGRAM_OFFHOST_ROOT)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2

$MaxAge = 684000   # 7d22h
$MaxFuture = 300
$Ts = '([0-9]{8}T[0-9]{6}Z)'
$WalName = '([0-9A-F]{24}(\.partial|\.[0-9A-F]{8}\.backup)?|[0-9A-F]{8}\.history)'
$Recognised = @(
  "^engram-$Ts\.dump\.gpg(\.sha256|\.partial)?\z",
  "^engram-base-$Ts\.tar\.gz\.gpg(\.sha256|\.partial|\.sha256\.partial)?\z",
  "^$Ts--$WalName\.gz\.gpg(\.sha256|\.partial|\.sha256\.partial)?\z",
  "^engram-pre-p0[0-9]-$Ts\.dump(\.sha256)?\z"
)
$BackupLike = '\.(gpg|dump|sha256|partial|tar|gz|sql)\z'

if ([string]::IsNullOrEmpty($Root) -or -not (Test-Path -LiteralPath $Root -PathType Container)) {
  [Console]::Error.WriteLine("engram-offhost-expire: root '$Root' missing")
  exit 1
}
$Root = (Resolve-Path -LiteralPath $Root).ProviderPath
if ($env:EXPIRE_NOW_EPOCH) {
  if ($env:EXPIRE_NOW_EPOCH -notmatch '^[0-9]+$') { [Console]::Error.WriteLine('EXPIRE_NOW_EPOCH must be epoch seconds'); exit 1 }
  $Now = [int64]$env:EXPIRE_NOW_EPOCH
} else {
  $Now = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
}
$NowIso = [DateTimeOffset]::FromUnixTimeSeconds($Now).UtcDateTime.ToString("yyyy-MM-dd'T'HH:mm:ss'Z'", [Globalization.CultureInfo]::InvariantCulture)
$State = Join-Path $Root 'expire'
New-Item -ItemType Directory -Force -Path $State | Out-Null

# One sweep at a time per root (scheduled run vs a pull-triggered run).
$mutexName = 'engram-offhost-expire-' + ([BitConverter]::ToString([Security.Cryptography.SHA256]::Create().ComputeHash([Text.Encoding]::UTF8.GetBytes($Root.ToLowerInvariant()))) -replace '-', '').Substring(0, 16)
$mutex = New-Object Threading.Mutex($false, $mutexName)
if (-not $mutex.WaitOne(0)) { [Console]::Error.WriteLine("engram-offhost-expire: another sweep holds $mutexName"); exit 1 }

$events = New-Object Collections.Generic.List[string]
$deleted = 0; $kept = 0; $problems = 0
try {
  $enumErrors = @()
  $files = @(Get-ChildItem -LiteralPath $Root -Recurse -File -Force -Attributes !ReparsePoint -ErrorAction SilentlyContinue -ErrorVariable enumErrors)
  foreach ($e in $enumErrors) {
    $events.Add("ERROR scan $($e.TargetObject): $($e.Exception.Message)")
    $problems++
  }
  foreach ($f in $files) {
    $name = $f.Name
    $tsv = $null
    foreach ($re in $Recognised) {
      $m = [regex]::Match($name, $re)
      if ($m.Success) { $tsv = $m.Groups[1].Value; break }
    }
    if ($null -eq $tsv) {
      if ([regex]::IsMatch($name, $BackupLike)) { $events.Add("UNRECOGNISED $($f.FullName)"); $problems++ }
      continue
    }
    $dt = [DateTime]::MinValue
    $okDate = [DateTime]::TryParseExact($tsv, "yyyyMMdd'T'HHmmss'Z'", [Globalization.CultureInfo]::InvariantCulture,
      ([Globalization.DateTimeStyles]::AssumeUniversal -bor [Globalization.DateTimeStyles]::AdjustToUniversal), [ref]$dt)
    if (-not $okDate) { $events.Add("BADDATE $($f.FullName)"); $problems++; continue }
    $epoch = [DateTimeOffset]::new($dt, [TimeSpan]::Zero).ToUnixTimeSeconds()
    $age = $Now - $epoch
    if ($age -lt -$MaxFuture) {
      $events.Add("FUTURE $($f.FullName)"); $problems++
    } elseif ($age -ge $MaxAge) {
      try {
        Remove-Item -LiteralPath $f.FullName -Force
        $events.Add("DELETED $($f.FullName) age=${age}s"); $deleted++
      } catch {
        $events.Add("ERROR delete $($f.FullName): $($_.Exception.Message)"); $problems++
      }
    } else {
      $kept++
    }
  }
} catch {
  $events.Add("ERROR sweep: $($_.Exception.Message)"); $problems++
} finally {
  $ok = ($problems -eq 0)
  $okJson = if ($ok) { 'true' } else { 'false' }
  $lines = @($events | ForEach-Object { "$NowIso $_" })
  $lines += "$NowIso SWEEP ok=$okJson deleted=$deleted kept=$kept problems=$problems"
  $utf8 = New-Object Text.UTF8Encoding($false)
  [IO.File]::AppendAllText((Join-Path $State 'expire.log'), (($lines -join "`n") + "`n"), $utf8)
  $json = '{"ts":"' + $NowIso + '","ok":' + $okJson + ',"deleted":' + $deleted + ',"kept":' + $kept + ',"problems":' + $problems + ',"max_age_seconds":' + $MaxAge + '}'
  $tmp = Join-Path $State 'last-sweep.json.tmp'
  [IO.File]::WriteAllText($tmp, $json + "`n", $utf8)
  Move-Item -LiteralPath $tmp -Destination (Join-Path $State 'last-sweep.json') -Force
  $mutex.ReleaseMutex()
  $mutex.Dispose()
}
if ($ok) { exit 0 } else { exit 1 }
