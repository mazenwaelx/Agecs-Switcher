@echo off
REM Installs the AGECS Reloader companion extension so the Claude Code PANEL
REM switches accounts automatically. Run once, then fully restart VS Code.
setlocal
set "DEST=%USERPROFILE%\.vscode\extensions\agecs-reloader"
echo Installing AGECS Reloader to "%DEST%" ...
xcopy /e /i /y "%~dp0vscode-reloader" "%DEST%" >nul
if errorlevel 1 (
  echo FAILED to copy. Is VS Code installed for this user?
) else (
  echo Done. Now:
  echo   1^) Set  "claudeCode.continueAfterReload": false  in VS Code settings.
  echo   2^) Fully quit and reopen VS Code once to load the extension.
  echo After that, switching accounts reloads the panel automatically.
)
pause
