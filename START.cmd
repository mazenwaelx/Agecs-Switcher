@echo off
REM Double-click to start AGECS Switcher. Pick a mode with a number key.
cd /d "%~dp0"
:menu
cls
echo ============================================
echo    AGECS Switcher
echo ============================================
echo.
echo   How do you want to use Claude?
echo.
echo   [1] Sidebar panel   - the Claude chat panel (switches on a limit)
echo   [2] Terminal        - Claude in the terminal (fully automatic)
echo   [3] App window      - buttons to log in / save / switch accounts
echo   [4] Check accounts  - are both saved and distinct?
echo   [5] Quit
echo.
choice /c 12345 /n /m "Press 1-5: "
set c=%errorlevel%
if %c%==5 exit /b 0
if %c%==4 ( node "%~dp0agecs.mjs" doctor & echo. & pause & goto menu )
if %c%==3 ( node "%~dp0app.mjs" & goto menu )
if %c%==2 ( node "%~dp0agecs.mjs" run & goto menu )
if %c%==1 ( node "%~dp0agecs.mjs" watch & goto menu )
goto menu
