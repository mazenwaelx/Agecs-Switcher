@echo off
REM One-time setup for AGECS Switcher. Double-click this file.
cd /d "%~dp0"
echo ============================================
echo    AGECS Switcher - setup
echo ============================================
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo [X] Node.js is required. Install it from https://nodejs.org then run setup again.
  echo.
  pause
  exit /b 1
)

echo [1/2] Installing the AGECS Reloader extension (auto-switches the Claude panel)...
xcopy /e /i /y "%~dp0vscode-reloader" "%USERPROFILE%\.vscode\extensions\agecs-reloader" >nul
if errorlevel 1 ( echo       [X] copy failed. ) else ( echo       done. )
echo.

echo [2/2] Checking your accounts...
node "%~dp0agecs.mjs" doctor
echo.

echo ============================================
echo    NEXT STEPS
echo ============================================
echo  1^) Save your Claude accounts (opens Claude; type /login, sign in, exit):
echo        node agecs.mjs login claude-1
echo        node agecs.mjs login claude-2     ^(sign in with your OTHER account^)
echo.
echo  2^) For the SIDEBAR panel to switch + continue automatically, set:
echo        - VS Code setting:   "claudeCode.continueAfterReload": true
echo        - %%USERPROFILE%%\.claude\settings.json:  "autoContinueAtUsageLimit": true
echo        then fully quit and reopen VS Code once.
echo.
echo  3^) Start it:
echo        node agecs.mjs watch     ^(sidebar panel^)   OR   node agecs.mjs run   ^(terminal^)
echo        or double-click  AGECS.cmd  for the app window.
echo ============================================
echo.
pause
