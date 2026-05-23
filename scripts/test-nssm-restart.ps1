<#
.SYNOPSIS
  Simulates an NSSM OpenCodeService restart and verifies the viewer server recovers correctly.

.DESCRIPTION
  TEST 1 — Force-kill the viewer server, wait GraceMs, respawn it.
           Verifies closeAllConnections + EADDRINUSE retry (port rebind).

  TEST 2 — Register this script's PID with the running server, then verify the server
           stays alive during the watchdog grace period (it should, because this script
           is still running). Tests the register-pid cancellation logic.

.PARAMETER GraceMs
  Milliseconds to wait between kill and respawn. Default 800.

.PARAMETER MaxWaitS
  Seconds to wait for server to come up after respawn. Default 30.

.EXAMPLE
  pnpm test:restart
  .\scripts\test-nssm-restart.ps1 -GraceMs 2000
#>
param(
    [int]$GraceMs  = 800,
    [int]$MaxWaitS = 30
)

Set-StrictMode -Off
$ErrorActionPreference = "Continue"

$ProjectDir   = Split-Path $PSScriptRoot -Parent
$ServerScript = "$ProjectDir\apps\server\dist\server.js"
$NodeExe      = "C:\Program Files\nodejs\node.exe"
$Port         = 4310
$ServerLog    = "$ProjectDir\server.log"
$PingUrl      = "http://localhost:$Port/api/ping"
$RegUrl       = "http://localhost:$Port/api/register-pid"

$pass = 0; $fail = 0

function Test-ServerAlive {
    try {
        $out = & curl.exe -s -o NUL -w "%{http_code}" --max-time 2 $PingUrl 2>$null
        return ($out -eq "200" -or $out -eq "503")
    } catch { return $false }
}

function Register-ParentPid ([int]$parentPid) {
    try {
        # Write body to temp file to avoid Windows quoting issues with curl -d
        $tmp = [System.IO.Path]::GetTempFileName()
        [System.IO.File]::WriteAllText($tmp, "{`"pid`":$parentPid}")
        $out = & curl.exe -s -X POST -H "Content-Type: application/json" -d "@$tmp" --max-time 3 $RegUrl 2>$null
        Remove-Item $tmp -ErrorAction SilentlyContinue
        return $out -match '"ok":true'
    } catch { return $false }
}

function Get-ListenPid {
    $c = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
    if ($c) { return [int]$c.OwningProcess } else { return 0 }
}

function Wait-ServerUp ([int]$TimeoutS) {
    for ($i = 0; $i -lt ($TimeoutS * 4); $i++) {
        Start-Sleep -Milliseconds 250
        if (Test-ServerAlive) { return $true }
    }
    return $false
}

function Kill-Port {
    $p = Get-ListenPid
    if ($p -gt 0) {
        Stop-Process -Id $p -Force -ErrorAction SilentlyContinue
        Start-Sleep -Milliseconds 300
    }
}

function Start-ViewerServer ([string]$Label) {
    Kill-Port
    $stamp = Get-Date -Format "o"
    try { [System.IO.File]::AppendAllText($ServerLog, "`n--- [$stamp] test-nssm-restart.ps1: $Label ---`n") } catch {}

    $env:PORT       = "$Port"
    $env:PARENT_PID = ""
    $outLog = "$env:TEMP\viewer-test-stdout.log"
    $errLog = "$env:TEMP\viewer-test-stderr.log"
    $proc = Start-Process -FilePath $NodeExe -ArgumentList "`"$ServerScript`"" `
        -WorkingDirectory (Split-Path $ServerScript) `
        -RedirectStandardOutput $outLog `
        -RedirectStandardError  $errLog `
        -PassThru -WindowStyle Hidden
    $env:PARENT_PID = $null
    return $proc
}

function Emit-Result ([bool]$ok, [string]$msg) {
    if ($ok) { $script:pass++; Write-Host "  PASS  $msg" -ForegroundColor Green }
    else      { $script:fail++; Write-Host "  FAIL  $msg" -ForegroundColor Red }
}

# ─── pre-flight ──────────────────────────────────────────────────────────────

if (-not (Test-Path $NodeExe))      { Write-Host "ERROR: Node not found at $NodeExe"             -ForegroundColor Red; exit 1 }
if (-not (Test-Path $ServerScript)) { Write-Host "ERROR: dist missing — run pnpm build first"    -ForegroundColor Red; exit 1 }

Write-Host ""
Write-Host "=== Viewer Server NSSM-Restart Simulation ===" -ForegroundColor Cyan
Write-Host "  Script : $ServerScript"
Write-Host "  Port   : $Port"
Write-Host "  GraceMs: $GraceMs"
Write-Host ""

# ═════════════════════════════════════════════════════════════════════════════
# TEST 1 — Kill → immediate respawn
# ═════════════════════════════════════════════════════════════════════════════
Write-Host "-- TEST 1: Kill then respawn (port rebind / EADDRINUSE retry) --" -ForegroundColor Yellow

# Ensure a server is running as baseline
if (-not (Test-ServerAlive)) {
    Write-Host "  Starting baseline server..." -ForegroundColor DarkGray
    $baseline = Start-ViewerServer "baseline"
    if (-not (Wait-ServerUp 30)) {
        Write-Host "  Could not start baseline server. Check server.log." -ForegroundColor Red
        exit 1
    }
}
$beforePid = Get-ListenPid
Write-Host "  Baseline server PID=$beforePid"

$t0 = Get-Date

# Force-kill (simulate NSSM killing the parent → server exits)
Stop-Process -Id $beforePid -Force -ErrorAction SilentlyContinue
$elapsed = [math]::Round(((Get-Date) - $t0).TotalSeconds * 1000)
Write-Host "  [${elapsed}ms] killed PID $beforePid"

# Check for zombie sockets immediately after kill
Start-Sleep -Milliseconds 200
$zombies = Get-NetTCPConnection -LocalPort $Port -ErrorAction SilentlyContinue |
           Where-Object { $_.State -notin @("Listen","Established") }
if ($zombies) {
    Write-Host "  [${elapsed}ms] zombie sockets right after kill:" -ForegroundColor DarkGray
    $zombies | ForEach-Object { Write-Host "    $($_.State) ownerPid=$($_.OwningProcess)" -ForegroundColor DarkGray }
}

# Simulate NSSM restart lag
Start-Sleep -Milliseconds $GraceMs
$elapsed = [math]::Round(((Get-Date) - $t0).TotalSeconds * 1000)
Write-Host "  [${elapsed}ms] grace done, spawning new server"

$newProc = Start-ViewerServer "test1-respawn"
$elapsed = [math]::Round(((Get-Date) - $t0).TotalSeconds * 1000)
Write-Host "  [${elapsed}ms] new server PID=$($newProc.Id)"

# Wait for new server to respond
$up = Wait-ServerUp $MaxWaitS
$elapsed = [math]::Round(((Get-Date) - $t0).TotalSeconds * 1000)

Emit-Result $up "port $Port came up in ${elapsed}ms after kill+respawn"

if (-not $up) {
    $bad = Get-Content $ServerLog -Tail 30 -ErrorAction SilentlyContinue |
           Where-Object { $_ -match "EADDRINUSE|listen error|Error" }
    if ($bad) { $bad | ForEach-Object { Write-Host "    log: $_" -ForegroundColor Red } }
}

# Check for *problematic* zombie sockets: CLOSE_WAIT or ESTABLISHED from a dead process.
# TIME_WAIT (OwningProcess=0) is normal kernel-managed TCP teardown — NOT a problem.
$zombiesAfter = Get-NetTCPConnection -LocalPort $Port -ErrorAction SilentlyContinue |
                Where-Object {
                    $_.State -eq "CloseWait" -and $_.OwningProcess -gt 0 -and
                    $_.OwningProcess -ne $newProc.Id -and
                    -not (Get-Process -Id $_.OwningProcess -ErrorAction SilentlyContinue)
                }
$timeWaits = (Get-NetTCPConnection -LocalPort $Port -ErrorAction SilentlyContinue |
              Where-Object { $_.State -eq "TimeWait" }).Count
Emit-Result (-not $zombiesAfter) "no CLOSE_WAIT zombie sockets from dead process"
if ($timeWaits -gt 0) {
    Write-Host "  (note: $timeWaits TIME_WAIT sockets — normal OS teardown, not a problem)" -ForegroundColor DarkGray
}
if ($zombiesAfter) {
    $zombiesAfter | ForEach-Object { Write-Host "    zombie: $($_.State) pid=$($_.OwningProcess)" -ForegroundColor Yellow }
}

# ═════════════════════════════════════════════════════════════════════════════
# TEST 2 — register-pid keeps server alive through watchdog grace
# ═════════════════════════════════════════════════════════════════════════════
Write-Host ""
Write-Host "-- TEST 2: register-pid cancels watchdog shutdown --" -ForegroundColor Yellow
Write-Host "  (watchdog fires every 5s, grace=15s; total window ~20s)" -ForegroundColor DarkGray

# Spawn a fresh server WITH watchdog (PARENT_PID=99999, dead PID — watchdog activates immediately).
# We then register THIS script's live PID to cancel the pending shutdown.
Kill-Port
$env:PORT       = "$Port"
$env:PARENT_PID = "99999"
$outLog2 = "$env:TEMP\viewer-test2-stdout.log"
$errLog2 = "$env:TEMP\viewer-test2-stderr.log"
$t2proc = Start-Process -FilePath $NodeExe -ArgumentList "`"$ServerScript`"" `
    -WorkingDirectory (Split-Path $ServerScript) `
    -RedirectStandardOutput $outLog2 -RedirectStandardError $errLog2 `
    -PassThru -WindowStyle Hidden
$env:PARENT_PID = $null
Write-Host "  Watchdog server PID=$($t2proc.Id) (PARENT_PID=99999 is dead, watchdog active)"

if (-not (Wait-ServerUp 20)) {
    Write-Host "  SKIP: test2 server did not start" -ForegroundColor Yellow
} else {
    # Register THIS script's live PID immediately so the watchdog finds us alive
    $myPid = $PID
    $ok = Register-ParentPid $myPid
    if ($ok) {
        Write-Host "  Registered live PID $myPid — server must NOT shut down"
    } else {
        Write-Host "  SKIP: register-pid call failed" -ForegroundColor Yellow
    }

    # Wait 25s — watchdog fires at ~5s, grace at ~20s; server must stay alive
    Write-Host "  Waiting 25s (watchdog=5s + grace=15s + buffer=5s)..." -ForegroundColor DarkGray
    $t2start = Get-Date
    $downAt = -1
    for ($i = 0; $i -lt 100; $i++) {
        Start-Sleep -Milliseconds 250
        if (-not (Test-ServerAlive)) {
            $downAt = [math]::Round(((Get-Date) - $t2start).TotalSeconds, 1)
            break
        }
    }

    if ($downAt -lt 0) {
        $elapsed2 = [math]::Round(((Get-Date) - $t2start).TotalSeconds, 1)
        Emit-Result $true "server stayed alive ${elapsed2}s (PID $myPid registered, watchdog saw dead 99999)"
    } else {
        Emit-Result $false "server shut down at ${downAt}s despite live PID $myPid being registered"
    }
    Stop-Process -Id $t2proc.Id -Force -ErrorAction SilentlyContinue
}

# ─── summary ─────────────────────────────────────────────────────────────────
Write-Host ""
Write-Host "==================================" -ForegroundColor Cyan
Write-Host "  Results: $pass passed, $fail failed" -ForegroundColor $(if ($fail -eq 0) { "Green" } else { "Red" })
Write-Host "==================================" -ForegroundColor Cyan

# Cleanup
if ($newProc -and -not $newProc.HasExited) {
    Stop-Process -Id $newProc.Id -Force -ErrorAction SilentlyContinue
    Write-Host "  Cleaned up test server PID=$($newProc.Id)" -ForegroundColor DarkGray
}
Write-Host ""

exit $fail
