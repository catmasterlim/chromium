param([string]$Root = $PSScriptRoot)
$ErrorActionPreference = 'Stop'
$rootPath = (Resolve-Path -LiteralPath $Root).Path
$logPath = Join-Path $rootPath 'logs'
New-Item -ItemType Directory -Path $logPath -Force | Out-Null
$moved = 0
$busy = @()
foreach ($file in Get-ChildItem -LiteralPath $rootPath -File -Filter '*.log') {
    try {
        $probe = [IO.File]::Open($file.FullName, [IO.FileMode]::Open,
            [IO.FileAccess]::Read, [IO.FileShare]::None)
        $probe.Dispose()
    } catch [IO.IOException] {
        $busy += $file.Name
        continue
    }
    $destination = Join-Path $logPath $file.Name
    if (Test-Path -LiteralPath $destination) {
        $destination = Join-Path $logPath ($file.BaseName + '-' + [guid]::NewGuid().ToString('N') + '.log')
    }
    try {
        Move-Item -LiteralPath $file.FullName -Destination $destination
        $moved++
    } catch [IO.IOException] { $busy += $file.Name }
}
Write-Output "Moved $moved log files into $logPath"
if ($busy.Count) { Write-Output ('Still in use, kept in place: ' + ($busy -join ', ')) }
