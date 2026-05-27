@echo off
setlocal EnableDelayedExpansion

:: Node.js / npm 경로가 서비스 컨텍스트에서 PATH에 없을 수 있으므로 명시적으로 추가
set "NODE_DIR=C:\Program Files\nodejs"
set "NPM_GLOBAL=C:\Users\NX3GAMES\AppData\Roaming\npm"
set "PATH=%NODE_DIR%;%NPM_GLOBAL%;%PATH%"

set "OPENCODE_EXE=%NPM_GLOBAL%\node_modules\opencode-ai\bin\opencode.exe"
set "LOGFILE=%~dp0opencode-start.log"

echo [%DATE% %TIME%] ========== opencode-start.cmd ========== >> "%LOGFILE%"
echo [%DATE% %TIME%] Updating opencode-ai to latest... >> "%LOGFILE%"
echo [%DATE% %TIME%] Updating opencode-ai to latest...

call "%NPM_GLOBAL%\npm.cmd" install -g opencode-ai@latest --no-progress --no-fund --loglevel warn >> "%LOGFILE%" 2>&1
set "NPM_EXIT=%ERRORLEVEL%"
echo [%DATE% %TIME%] npm update done (exit=%NPM_EXIT%) >> "%LOGFILE%"
echo [%DATE% %TIME%] npm update done (exit=%NPM_EXIT%)

if not exist "%OPENCODE_EXE%" (
    echo [%DATE% %TIME%] ERROR: opencode.exe not found: %OPENCODE_EXE% >> "%LOGFILE%"
    exit /b 1
)

echo [%DATE% %TIME%] Starting: %OPENCODE_EXE% serve --hostname 0.0.0.0 --port 4096 >> "%LOGFILE%"
echo [%DATE% %TIME%] Starting opencode...
"%OPENCODE_EXE%" serve --hostname 0.0.0.0 --port 4096

echo [%DATE% %TIME%] opencode exited (exit=%ERRORLEVEL%) >> "%LOGFILE%"
