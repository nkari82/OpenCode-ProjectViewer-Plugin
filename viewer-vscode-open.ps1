param([string]$Uri)
# Decode viewer-vscode:///C:/some/path  →  C:\some\path
$p = [System.Uri]::UnescapeDataString(
    [System.Uri]::new($Uri).LocalPath.TrimStart('/')
).Replace('/', '\')

# Prefer VS Code CLI (code.cmd) — sends "open" via IPC named-pipe to the
# existing VS Code instance WITHOUT spawning a new editor window.
# This avoids the "Another instance is already running as administrator"
# dialog which fires only when a new Code.exe GUI process is launched.
$codeCli = $null
foreach ($c in @(
    "$env:LOCALAPPDATA\Programs\Microsoft VS Code\bin\code.cmd",
    "$env:ProgramFiles\Microsoft VS Code\bin\code.cmd"
)) { if (Test-Path $c) { $codeCli = $c; break } }

if ($codeCli) {
    $psi = [System.Diagnostics.ProcessStartInfo]::new()
    $psi.FileName        = "cmd.exe"
    $psi.Arguments       = "/d /c `"`"$codeCli`"`" --reuse-window `"$p`""
    $psi.WindowStyle     = [System.Diagnostics.ProcessWindowStyle]::Hidden
    $psi.UseShellExecute = $false
    $psi.CreateNoWindow  = $true
    [System.Diagnostics.Process]::Start($psi) | Out-Null
    exit
}

# Fallback: Code.exe directly (may trigger the admin dialog, but at least tries)
$codeExe = $null
foreach ($c in @(
    "$env:LOCALAPPDATA\Programs\Microsoft VS Code\Code.exe",
    "$env:ProgramFiles\Microsoft VS Code\Code.exe"
)) { if (Test-Path $c) { $codeExe = $c; break } }

if ($codeExe) {
    Start-Process $codeExe -ArgumentList "--reuse-window `"$p`""
}
