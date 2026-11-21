# Hallow Shield 1.6 - registers the Hallow family bridge for you (this Windows user only, no admin):
#   copies HallowShieldBridge.exe to %LOCALAPPDATA%\Hallow Shield\bridge and tells Chrome, Edge, Brave (Opera reads
#   Chrome's entry) and Firefox where it is (HKCU\Software\...\NativeMessagingHosts\com.hallow.shield).
# Hallow Setup does this for you when it installs Shield. Run it yourself with:
#   powershell -ExecutionPolicy Bypass -File install-bridge.ps1            (register / update)
#   powershell -ExecutionPolicy Bypass -File install-bridge.ps1 -Uninstall (unregister)
# Nothing is shared until you turn on "Share counts with Hallow apps on this PC" in Shield's options.
param([switch]$Uninstall, [switch]$Status)
$ErrorActionPreference = 'Stop'
$exe = Join-Path $PSScriptRoot 'HallowShieldBridge.exe'
if (-not (Test-Path $exe)) { throw "HallowShieldBridge.exe isn't next to this script ($PSScriptRoot)" }
$arg = if ($Uninstall) { '--uninstall' } elseif ($Status) { '--status' } else { '--install' }
& $exe $arg
if ($LASTEXITCODE -ne 0) { throw "HallowShieldBridge.exe $arg failed ($LASTEXITCODE)" }
