@echo off
if not exist "%~dp0logs" mkdir "%~dp0logs"
for %%I in ("%~dp0..") do set "SIMPBROWSER_SRC=%%~fI"
if defined SIMPBROWSER_DEPOT_TOOLS set "PATH=%SIMPBROWSER_DEPOT_TOOLS%;%PATH%"
if not defined SIMPBROWSER_DEPOT_TOOLS if exist "%SIMPBROWSER_SRC%\..\..\depot_tools\gn.bat" set "PATH=%SIMPBROWSER_SRC%\..\..\depot_tools;%PATH%"
set "DEPOT_TOOLS_WIN_TOOLCHAIN=0"
if not defined vs2026_install if exist "%ProgramFiles(x86)%\Microsoft Visual Studio\Installer\vswhere.exe" (
  for /f "usebackq delims=" %%I in (`"%ProgramFiles(x86)%\Microsoft Visual Studio\Installer\vswhere.exe" -latest -products * -property installationPath`) do set "vs2026_install=%%I"
)
where gn >nul 2>nul
if errorlevel 1 (
  echo Add depot_tools to PATH or set SIMPBROWSER_DEPOT_TOOLS.
  exit /b 1
)
exit /b 0
