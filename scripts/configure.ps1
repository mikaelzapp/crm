$ErrorActionPreference = 'Stop'
Set-Location (Split-Path $PSScriptRoot -Parent)
if (Test-Path '.env') {
    Write-Host '.env existente preservado.'
    exit 0
}
function New-RandomHex([int]$Length) {
    $bytes = New-Object byte[] $Length
    $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    try { $rng.GetBytes($bytes) } finally { $rng.Dispose() }
    return ([BitConverter]::ToString($bytes)).Replace('-', '').ToLowerInvariant()
}
$content = [IO.File]::ReadAllText((Join-Path (Get-Location) '.env.example'))
$content = $content.Replace('CHANGE_ME_POSTGRES', (New-RandomHex 24))
$content = $content.Replace('CHANGE_ME_ADMIN', (New-RandomHex 18))
$content = $content.Replace('CHANGE_ME_ENCRYPTION', (New-RandomHex 32))
[IO.File]::WriteAllText((Join-Path (Get-Location) '.env'), $content, (New-Object Text.UTF8Encoding $false))
Write-Host '.env criado com segredos aleatorios. Consulte ADMIN_EMAIL e ADMIN_PASSWORD no arquivo local para entrar.'
