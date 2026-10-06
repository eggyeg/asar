<#
  asar installer for Discord on Windows.

  Downloads the latest asar build and puts it in place of Discord's app.asar
  (Stable, PTB and Canary), keeping a backup of Discord's original.

    asar-setup.bat              install or update asar
    asar-setup.bat -Uninstall   put stock Discord back
#>
param(
  [switch]$Uninstall,
  [switch]$NoStart,
  [switch]$Bat, # run from asar-setup.bat: report success/failure as the process exit code
  [string]$Url = 'https://raw.githubusercontent.com/eggyeg/asar/build/app.asar',
  [string]$Root = $env:LOCALAPPDATA
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue' # Invoke-WebRequest is many times faster without the progress bar on PowerShell 5.1
try { [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12 } catch { }

function Say([string]$msg, [string]$color = 'Gray') { Write-Host $msg -ForegroundColor $color }

function Test-AsarBytes([byte[]]$b) {
  return ($b.Length -gt 1024 -and $b[0] -eq 4 -and $b[1] -eq 0 -and $b[2] -eq 0 -and $b[3] -eq 0)
}

# 'asar' (this project), 'openasar', or 'stock'
function Get-AsarKind([string]$path) {
  $text = [Text.Encoding]::ASCII.GetString([IO.File]::ReadAllBytes($path))
  if ($text.Contains('asarVersion')) { return 'asar' }
  if ($text.Contains('OpenAsar')) { return 'openasar' }
  return 'stock'
}

function Copy-WithRetry([string]$from, [string]$to) {
  for ($i = 0; $i -lt 20; $i++) {
    try { Copy-Item -LiteralPath $from -Destination $to -Force; return } catch { Start-Sleep -Milliseconds 500 }
  }
  throw "Couldn't write $to. Make sure Discord is fully closed (tray icon > Quit) and run the installer again."
}

function Get-AppVersion($dir) {
  try { return [version]($dir.Name.Substring(4)) } catch { return [version]'0.0' }
}

Say ''
Say '  asar installer' 'Magenta'
Say ''

try {
  if (-not $Root -or -not (Test-Path -LiteralPath $Root)) { throw "Couldn't find your AppData\Local folder." }

  $channels = @('Discord', 'DiscordPTB', 'DiscordCanary', 'DiscordDevelopment')
  $installs = @()
  foreach ($name in $channels) {
    $dir = Join-Path $Root $name
    if (-not (Test-Path -LiteralPath $dir)) { continue }

    $apps = @(Get-ChildItem -LiteralPath $dir -Directory -Filter 'app-*' |
      Where-Object { Test-Path -LiteralPath (Join-Path (Join-Path $_.FullName 'resources') 'app.asar') } |
      Sort-Object { Get-AppVersion $_ } -Descending)

    if ($apps.Count -gt 0) { $installs += [pscustomobject]@{ Name = $name; Dir = $dir; Apps = $apps } }
  }

  if ($installs.Count -eq 0) { throw "Couldn't find Discord. Install it from https://discord.com/download first." }

  $tmp = $null
  if (-not $Uninstall) {
    Say "  Downloading asar..."
    $tmp = Join-Path ([IO.Path]::GetTempPath()) ('asar-' + [guid]::NewGuid().ToString('N') + '.asar')
    Invoke-WebRequest -UseBasicParsing -Uri $Url -OutFile $tmp
    if (-not (Test-AsarBytes ([IO.File]::ReadAllBytes($tmp)))) { throw "The download isn't a valid app.asar. Try again in a minute." }
    $kb = [math]::Round((Get-Item -LiteralPath $tmp).Length / 1KB)
    Say "  Downloaded $kb KB" 'DarkGray'
  }

  $wasRunning = @()
  foreach ($inst in $installs) {
    Say ''
    Say "  $($inst.Name)" 'White'

    $procs = @(Get-Process -Name $inst.Name -ErrorAction SilentlyContinue)
    if ($procs.Count -gt 0) {
      Say "  Closing $($inst.Name)..."
      $wasRunning += $inst
      $procs | Stop-Process -Force -ErrorAction SilentlyContinue
      $procs | Wait-Process -Timeout 15 -ErrorAction SilentlyContinue
      Start-Sleep -Milliseconds 700
    }

    # Every installed version is patched, so asar stays in place when Discord switches to a newer app-* folder
    foreach ($app in $inst.Apps) {
      $asar = Join-Path (Join-Path $app.FullName 'resources') 'app.asar'
      $backup = "$asar.backup"

      if ($Uninstall) {
        if (Test-Path -LiteralPath $backup) {
          Copy-WithRetry $backup $asar
          Remove-Item -LiteralPath $backup -Force
          Say "  Restored stock Discord ($($app.Name))" 'Green'
        } else {
          Say "  No backup found in $($app.Name), left as is" 'Yellow'
        }
        continue
      }

      $kind = Get-AsarKind $asar
      if (-not (Test-Path -LiteralPath $backup)) {
        if ($kind -eq 'stock') {
          Copy-WithRetry $asar $backup
          Say "  Backed up Discord's app.asar ($($app.Name))" 'DarkGray'
        } else {
          Say "  Note: no stock backup in $($app.Name) (found $kind). Reinstall Discord if you ever want stock back." 'Yellow'
        }
      }

      Copy-WithRetry $tmp $asar
      $verb = 'Installed'
      if ($kind -eq 'asar') { $verb = 'Updated' }
      Say "  $verb asar ($($app.Name))" 'Green'
    }
  }

  if ($tmp) { Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue }

  if (-not $NoStart) {
    $toStart = $wasRunning
    if ($toStart.Count -eq 0) { $toStart = @($installs[0]) }
    foreach ($inst in $toStart) {
      $update = Join-Path $inst.Dir 'Update.exe'
      if (Test-Path -LiteralPath $update) {
        Start-Process -FilePath $update -ArgumentList '--processStart', "$($inst.Name).exe"
      }
    }
  }

  Say ''
  if ($Uninstall) {
    Say '  Done. Discord is back to stock.' 'Green'
  } else {
    Say '  Done. Discord is starting with asar.' 'Green'
    Say '  Open asar settings from the "asar" tab in Discord settings, or press Ctrl + Alt + O.' 'Gray'
  }
  Say ''
  if ($Bat) { exit 0 }
  return
} catch {
  Say ''
  Say "  Error: $($_.Exception.Message)" 'Red'
  Say ''
  if ($Bat) { exit 1 }
  return
}
