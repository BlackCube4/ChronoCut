@echo off
setlocal EnableExtensions
title ChronoCut - Setup und Start
cd /d "%~dp0"

echo ============================================
echo   ChronoCut - Setup und Start
echo ============================================
echo.

rem ---------- Node / npm finden ----------
where npm >nul 2>&1
if not %errorlevel%==0 (
    echo [FEHLER] Node.js / npm wurde nicht gefunden.
    echo Bitte installiere Node.js von https://nodejs.org/ ^(LTS-Version^)
    echo und starte danach diese Datei erneut.
    echo.
    pause
    exit /b 1
)
echo [OK] npm gefunden.
echo.

rem ---------- Pakete ----------
echo ---- ChronoCut wird vorbereitet ----
call npm install --prefix "frontend"
if not %errorlevel%==0 (
    echo [FEHLER] "npm install" fehlgeschlagen.
    pause
    exit /b 1
)
echo [OK] ChronoCut bereit.
echo.

rem ---------- Server starten (falls nicht schon aktiv) ----------
rem PowerShell's -State Listen checks the real socket state; netstat/findstr
rem would also match stale TIME_WAIT leftovers of an already-closed server.
set "RUNNING="
powershell -NoProfile -Command "if (Get-NetTCPConnection -LocalPort 5173 -State Listen -ErrorAction SilentlyContinue) { exit 0 } else { exit 1 }" >nul 2>&1
if %errorlevel%==0 set "RUNNING=1"

if defined RUNNING (
    echo ChronoCut laeuft bereits auf Port 5173 - ueberspringe Start.
) else (
    start "ChronoCut" /D "%~dp0frontend" cmd /k "npm run dev"
    echo ChronoCut gestartet: http://localhost:5173/
)

echo.
echo Warte, bis der Server bereit ist...
ping -n 7 127.0.0.1 >nul
start "" "http://localhost:5173/"

echo.
echo ============================================
echo   ChronoCut laeuft: http://localhost:5173/
echo.
echo   Alle Dateien werden nur im Browser auf
echo   diesem Rechner verarbeitet.
echo.
echo   Zum Beenden das Fenster "ChronoCut"
echo   wieder schliessen.
echo ============================================
echo.
pause
