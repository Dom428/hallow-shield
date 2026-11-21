# Builds bridge\HallowShieldBridge.exe (the Hallow family bridge, Shield 1.6) with the C# compiler that ships with
# Windows (.NET Framework 4.8) - nothing to install.   -Test also builds bridge\out\BridgeTests.exe and runs it.
param([switch]$Test)
$ErrorActionPreference = 'Stop'
$fw = "$env:WINDIR\Microsoft.NET\Framework64\v4.0.30319"
$here = $PSScriptRoot
$refs = "$fw\System.Core.dll", "$fw\System.Web.Extensions.dll"
$ref = $refs | ForEach-Object { "/reference:$_" }
function Compile($out, $files) {
  $p = Start-Process -FilePath "$fw\csc.exe" -ArgumentList (@('/nologo', '/target:exe', '/optimize+', '/platform:anycpu', "/out:`"$out`"") + $ref + ($files | ForEach-Object { "`"$_`"" })) -NoNewWindow -PassThru -Wait:$false -RedirectStandardOutput "$here\out\csc.txt"
  $null = $p.Handle   # so ExitCode is kept
  try { $p.PriorityClass = 'BelowNormal' } catch { }
  $p.WaitForExit()
  Get-Content "$here\out\csc.txt" | Write-Host
  if ($p.ExitCode -ne 0) { throw "Build failed: $out" }
}
New-Item -ItemType Directory -Force "$here\out" | Out-Null
$exe = Join-Path $here 'HallowShieldBridge.exe'
Compile $exe @("$here\Bridge.cs", "$here\Program.cs")
"Built $exe ($([math]::Round((Get-Item $exe).Length / 1KB)) KB)"
if ($Test) {
  $t = Join-Path $here 'out\BridgeTests.exe'
  Compile $t @("$here\Bridge.cs", "$here\Tests.cs")
  & $t $exe
  if ($LASTEXITCODE -ne 0) { throw 'Bridge tests failed' }
}
