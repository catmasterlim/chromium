@echo off
setlocal
if not exist "%~dp0..\out\Release\chrome.exe" (
  echo Run build-release.cmd first.
  exit /b 1
)
start "" "%~dp0..\out\Release\chrome.exe" --user-data-dir="%~dp0profiles\SimpBrowser-Release" --no-first-run https://www.youtube.com/
