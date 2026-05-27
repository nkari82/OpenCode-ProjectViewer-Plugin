# setup-nssm-autoupdate.ps1
# 관리자 권한으로 실행 필요
# opencodeservice가 재시작될 때마다 opencode-ai를 최신 버전으로 업데이트하도록 NSSM 설정

$serviceName = "opencodeservice"
$scriptDir   = Split-Path -Parent $MyInvocation.MyCommand.Path
$startCmd    = Join-Path $scriptDir "opencode-start.cmd"

if (-not (Test-Path $startCmd)) {
    Write-Error "opencode-start.cmd not found: $startCmd"
    exit 1
}

Write-Host "Configuring NSSM service '$serviceName'..." -ForegroundColor Cyan

# Application → cmd.exe (래퍼 스크립트를 실행하기 위해)
nssm set $serviceName Application       "cmd.exe"
nssm set $serviceName AppParameters    "/c `"$startCmd`""
nssm set $serviceName AppDirectory     "C:\Users\NX3GAMES"

# 서비스 종료 시 로그 파일도 남도록 stdout/stderr 설정 (기존 설정 유지용)
# nssm set $serviceName AppStdout "$scriptDir\opencode-stdout.log"
# nssm set $serviceName AppStderr "$scriptDir\opencode-stderr.log"

Write-Host ""
Write-Host "Done. opencodeservice now runs opencode-start.cmd on every (re)start." -ForegroundColor Green
Write-Host "The script will run 'npm install -g opencode-ai@latest' before launching opencode."
Write-Host ""
Write-Host "To apply changes, restart the service:" -ForegroundColor Yellow
Write-Host "  nssm restart $serviceName"
