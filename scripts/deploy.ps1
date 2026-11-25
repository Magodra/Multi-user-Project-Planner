<#
.SYNOPSIS
  Builds the planner and uploads it to a web server over SSH, signing in with a password.

.DESCRIPTION
  Reads the target from a deployment server file (JSON, default: deploy.server.json in the
  repository root) and the SSH password from a password file (default: deploy.password).
  Both files are listed in .gitignore and must never be committed. If the password file is
  missing, the script asks for the password.

  Modes (the "mode" setting in the server file):
    app     Uploads the built shared package, server and client, plus the package files, to
            remotePath; then runs "npm ci --omit=dev" there and the optional restartCommand.
            config.json and the data directory on the server are left untouched.
    client  Uploads only the client (index.html and client-config.js) to remotePath, for a
            plain web server. The API runs elsewhere; set apiUrl.

  The remote host must have bash and tar (Linux). In app mode it also needs Node.js 22.12+.

  Uses the Windows OpenSSH client (ssh.exe and scp.exe). OpenSSH cannot take a password on
  the command line, so the password is handed over through a temporary SSH_ASKPASS helper
  that reads it from an environment variable of this process. The helper is deleted
  afterwards.

.PARAMETER ServerFile
  Deployment server file (JSON). See deploy.server.example.json.

.PARAMETER PasswordFile
  File holding only the SSH password (one line).

.PARAMETER SkipBuild
  Upload the existing build output instead of running "npm run build" first.

.EXAMPLE
  .\scripts\deploy.ps1

.EXAMPLE
  .\scripts\deploy.ps1 -ServerFile .\deploy.test.json -PasswordFile .\deploy.test.password -SkipBuild
#>
[CmdletBinding()]
param(
  [string]$ServerFile,
  [string]$PasswordFile,
  [switch]$SkipBuild
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 3.0

$repoRoot = Split-Path -Parent $PSScriptRoot
if (-not $ServerFile) { $ServerFile = Join-Path $repoRoot 'deploy.server.json' }
if (-not $PasswordFile) { $PasswordFile = Join-Path $repoRoot 'deploy.password' }

function Write-Step([string]$text) {
  Write-Host "==> $text" -ForegroundColor Cyan
}

function Get-Setting($settings, [string]$name, $default) {
  $prop = $settings.PSObject.Properties[$name]
  if ($null -eq $prop -or $null -eq $prop.Value -or "$($prop.Value)" -eq '') { return $default }
  return $prop.Value
}

# Quotes a value for a POSIX shell: 'it'\''s'
function ConvertTo-ShellQuoted([string]$value) {
  return "'" + $value.Replace("'", "'\''") + "'"
}

function Write-LfFile([string]$path, [string]$text) {
  $utf8NoBom = New-Object System.Text.UTF8Encoding $false
  [System.IO.File]::WriteAllText($path, $text.Replace("`r`n", "`n"), $utf8NoBom)
}

function Invoke-Native([string]$exe, [string[]]$arguments, [string]$what) {
  & $exe @arguments
  if ($LASTEXITCODE -ne 0) { throw "$what failed (exit code $LASTEXITCODE)." }
}

function Find-Tool([string]$name, [string]$preferred) {
  if (Test-Path $preferred) { return $preferred }
  $cmd = Get-Command $name -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  throw "$name was not found. Install the Windows OpenSSH client (Settings > System > Optional features)."
}

# --- Settings -------------------------------------------------------------------------------

if (-not (Test-Path $ServerFile)) {
  throw "Deployment server file not found: $ServerFile. Copy deploy.server.example.json to deploy.server.json and edit it."
}
$settings = Get-Content -Raw -Path $ServerFile | ConvertFrom-Json

$hostName = Get-Setting $settings 'host' $null
$userName = Get-Setting $settings 'user' $null
$remotePath = Get-Setting $settings 'remotePath' $null
if (-not $hostName -or -not $userName -or -not $remotePath) {
  throw "The deployment server file must set host, user and remotePath."
}
$port = [int](Get-Setting $settings 'port' 22)
$mode = Get-Setting $settings 'mode' 'app'
if ($mode -ne 'app' -and $mode -ne 'client') { throw "mode must be 'app' or 'client', not '$mode'." }
$apiUrl = Get-Setting $settings 'apiUrl' $null
$npmCommand = Get-Setting $settings 'npmCommand' 'npm'
$restartCommand = Get-Setting $settings 'restartCommand' $null
$hostKeyChecking = Get-Setting $settings 'strictHostKeyChecking' 'accept-new'
$remoteTempDir = Get-Setting $settings 'remoteTempDir' '/tmp'

if (Test-Path $PasswordFile) {
  # Only line breaks are trimmed; spaces may be part of the password.
  $password = (Get-Content -Raw -Path $PasswordFile).TrimEnd("`r", "`n")
} else {
  Write-Host "Password file not found ($PasswordFile)."
  $secure = Read-Host -AsSecureString "SSH password for $userName@$hostName"
  $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
  try { $password = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr) }
  finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }
}
if (-not $password) { throw "The SSH password is empty." }

$ssh = Find-Tool 'ssh' (Join-Path $env:SystemRoot 'System32\OpenSSH\ssh.exe')
$scp = Find-Tool 'scp' (Join-Path $env:SystemRoot 'System32\OpenSSH\scp.exe')
# Windows' own bsdtar: Git's tar would read "C:\..." as a remote host.
$tar = Join-Path $env:SystemRoot 'System32\tar.exe'
if (-not (Test-Path $tar)) { throw "tar.exe was not found in $env:SystemRoot\System32 (needs Windows 10 1803 or later)." }

# --- Build ----------------------------------------------------------------------------------

if (-not $SkipBuild) {
  Write-Step 'Building (npm run build)'
  $oldSkipImages = $env:SKIP_DOCS_IMAGES
  $env:SKIP_DOCS_IMAGES = '1'
  Push-Location $repoRoot
  try { Invoke-Native 'npm.cmd' @('run', 'build') 'npm run build' }
  finally {
    Pop-Location
    $env:SKIP_DOCS_IMAGES = $oldSkipImages
  }
}

# --- Package --------------------------------------------------------------------------------

$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$baseName = "planner-deploy-$stamp-$([guid]::NewGuid().ToString('N').Substring(0, 8))"
$workDir = Join-Path ([System.IO.Path]::GetTempPath()) $baseName
$stageDir = Join-Path $workDir 'stage'
$packageFile = Join-Path $workDir "$baseName.tgz"
$remoteScriptFile = Join-Path $workDir "$baseName.sh"
$askPassFile = Join-Path $workDir 'askpass.cmd'
New-Item -ItemType Directory -Path $stageDir | Out-Null

$oldEnv = @{}
foreach ($name in 'SSH_ASKPASS', 'SSH_ASKPASS_REQUIRE', 'DISPLAY', 'PLANNER_DEPLOY_SECRET') {
  $oldEnv[$name] = [Environment]::GetEnvironmentVariable($name, 'Process')
}

try {
  Write-Step "Packaging ($mode)"
  if ($mode -eq 'app') {
    $items = @(
      'package.json', 'package-lock.json', 'config.example.json',
      'shared\package.json', 'shared\dist',
      'server\package.json', 'server\dist',
      'client\package.json', 'client\dist'
    )
    $clientConfigTarget = Join-Path $stageDir 'client\dist\client-config.js'
  } else {
    $items = @('client\dist\index.html', 'client\dist\client-config.js')
    $clientConfigTarget = Join-Path $stageDir 'client-config.js'
  }
  foreach ($item in $items) {
    $source = Join-Path $repoRoot $item
    if (-not (Test-Path $source)) { throw "Missing build output: $item. Run without -SkipBuild." }
    $target = if ($mode -eq 'app') { Join-Path $stageDir $item } else { Join-Path $stageDir (Split-Path -Leaf $item) }
    $parent = Split-Path -Parent $target
    if (-not (Test-Path $parent)) { New-Item -ItemType Directory -Path $parent | Out-Null }
    Copy-Item -Path $source -Destination $target -Recurse
  }
  if ($apiUrl) {
    $jsString = ConvertTo-Json ([string]$apiUrl)
    Write-LfFile $clientConfigTarget @"
// Written by scripts/deploy.ps1. See CLAUDE.md "Client deployment modes".
window.PLANNING_CLIENT_CONFIG = {
  apiUrl: $jsString,
};
"@
  }
  Invoke-Native $tar @('-czf', $packageFile, '-C', $stageDir, '.') 'Packaging'

  # --- Remote install script ----------------------------------------------------------------

  $remotePackage = "$remoteTempDir/$baseName.tgz"
  $remoteScript = "$remoteTempDir/$baseName.sh"
  $lines = @(
    '#!/usr/bin/env bash',
    'set -euo pipefail',
    "pkg=$(ConvertTo-ShellQuoted $remotePackage)",
    "dest=$(ConvertTo-ShellQuoted $remotePath)",
    'trap ''rm -f "$pkg" "$0"'' EXIT',
    'mkdir -p "$dest"',
    'cd "$dest"'
  )
  if ($mode -eq 'app') {
    # A non-interactive SSH session does not read the interactive part of ~/.bashrc, where
    # nvm and similar installers add Node.js to PATH. Look in the usual places.
    $npmExe = ConvertTo-ShellQuoted (($npmCommand.Trim() -split '\s+')[0])
    $lines += @(
      "if ! command -v $npmExe >/dev/null 2>&1; then",
      '  export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"',
      '  if [ -s "$NVM_DIR/nvm.sh" ]; then set +u; . "$NVM_DIR/nvm.sh"; set -u; fi',
      '  for dir in "$HOME/.volta/bin" "$HOME/.local/share/fnm/aliases/default/bin" "$HOME/.local/bin" "$HOME/bin" /usr/local/bin /opt/node/bin /opt/nodejs/bin; do',
      '    if [ -d "$dir" ]; then PATH="$PATH:$dir"; fi',
      '  done',
      'fi',
      "if ! command -v $npmExe >/dev/null 2>&1; then",
      "  echo `"Error: $npmExe was not found on the server. Install Node.js 22.12 or later, or set npmCommand in the deployment server file to npm's full path (run 'command -v npm' in an SSH session to find it).`" >&2",
      '  exit 127',
      'fi',
      "echo `"Using npm: `$(command -v $npmExe), node: `$(node --version 2>/dev/null || echo not found)`"",
      '# Remove old build output so deleted files do not linger; config.json and data stay.',
      'rm -rf shared/dist server/dist client/dist',
      'tar -xzf "$pkg"',
      '[ -f config.json ] || echo "Warning: $dest/config.json does not exist yet. Copy config.example.json and edit it." >&2',
      'echo "Installing production dependencies..."',
      "$npmCommand ci --omit=dev --no-audit --no-fund"
    )
  } else {
    $lines += @('tar -xzf "$pkg"')
  }
  if ($restartCommand) {
    $lines += @('echo "Restarting..."', [string]$restartCommand)
  }
  $lines += @('echo "Deployed to $dest"')
  Write-LfFile $remoteScriptFile (($lines -join "`n") + "`n")

  # --- Upload and install -------------------------------------------------------------------

  # OpenSSH asks SSH_ASKPASS for the password. The helper echoes it from an environment
  # variable of this process; delayed expansion keeps characters like & | < > ^ % literal.
  Write-LfFile $askPassFile "@echo off`r`nsetlocal EnableDelayedExpansion`r`necho(!PLANNER_DEPLOY_SECRET!`r`n"
  $env:PLANNER_DEPLOY_SECRET = $password
  $env:SSH_ASKPASS = $askPassFile
  $env:SSH_ASKPASS_REQUIRE = 'force'
  if (-not $env:DISPLAY) { $env:DISPLAY = 'none' }

  $sshOptions = @(
    '-o', "StrictHostKeyChecking=$hostKeyChecking",
    '-o', 'PubkeyAuthentication=no',
    '-o', 'PreferredAuthentications=password,keyboard-interactive',
    '-o', 'NumberOfPasswordPrompts=1',
    '-o', 'ConnectTimeout=30'
  )
  $target = "$userName@$hostName"

  Write-Step "Uploading to ${target}:$remoteTempDir"
  Invoke-Native $scp (@('-P', "$port") + $sshOptions + @($packageFile, $remoteScriptFile, "${target}:$remoteTempDir/")) 'Upload (scp)'

  Write-Step "Installing in ${target}:$remotePath"
  Invoke-Native $ssh (@('-p', "$port") + $sshOptions + @($target, "bash -l $(ConvertTo-ShellQuoted $remoteScript)")) 'Remote install (ssh)'

  Write-Step 'Done'
}
finally {
  foreach ($name in $oldEnv.Keys) {
    [Environment]::SetEnvironmentVariable($name, $oldEnv[$name], 'Process')
  }
  $password = $null
  if (Test-Path $workDir) { Remove-Item -Recurse -Force $workDir }
}
