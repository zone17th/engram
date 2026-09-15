<#
.SYNOPSIS
Loads the repository .env file into the current PowerShell process.

.DESCRIPTION
Dot-source this script so raw Go and pnpm commands share the same host-dev
configuration. Existing process variables are preserved as local overrides.
#>
[CmdletBinding()]
param(
    [string]$EnvFile
)

$repoRoot = Split-Path -Parent $PSScriptRoot
if ([string]::IsNullOrWhiteSpace($EnvFile)) {
    $EnvFile = Join-Path $repoRoot '.env'
} elseif (-not [IO.Path]::IsPathRooted($EnvFile)) {
    $EnvFile = Join-Path $repoRoot $EnvFile
}

if (-not (Test-Path -LiteralPath $EnvFile -PathType Leaf)) {
    throw "Environment file not found: $EnvFile. Copy .env.example to .env first."
}

foreach ($rawLine in Get-Content -LiteralPath $EnvFile) {
    $line = $rawLine.Trim().TrimStart([char]0xFEFF)
    if ([string]::IsNullOrWhiteSpace($line) -or $line.StartsWith('#')) {
        continue
    }
    if ($line.StartsWith('export ')) {
        $line = $line.Substring(7).TrimStart()
    }

    $separator = $line.IndexOf('=')
    if ($separator -lt 1) {
        continue
    }
    $name = $line.Substring(0, $separator).Trim()
    if ($name -notmatch '^[A-Za-z_][A-Za-z0-9_]*$') {
        continue
    }

    $value = $line.Substring($separator + 1).Trim()
    if ($value.Length -ge 2 -and $value.StartsWith('"') -and $value.EndsWith('"')) {
        $value = $value.Substring(1, $value.Length - 2).Replace('\"', '"')
    } elseif ($value.Length -ge 2 -and $value.StartsWith("'") -and $value.EndsWith("'")) {
        $value = $value.Substring(1, $value.Length - 2)
    } else {
        $inlineComment = $value.IndexOf(' #')
        if ($inlineComment -ge 0) {
            $value = $value.Substring(0, $inlineComment).TrimEnd()
        }
    }

    if ($null -eq [Environment]::GetEnvironmentVariable($name, 'Process')) {
        Set-Item -LiteralPath "Env:$name" -Value $value
    }
}
