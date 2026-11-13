@echo off
setlocal
if not exist "%~dp0..\out\SimpBrowser\chrome.exe" (
  echo Run build.cmd first.
  exit /b 1
)
start "" "%~dp0..\out\SimpBrowser\chrome.exe" --user-data-dir="%~dp0profiles\SimpBrowser" --no-first-run https://www.youtube.com/
