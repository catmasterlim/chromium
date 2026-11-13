@echo off
setlocal
if not "%~1"=="" if not "%~1"=="--configure-only" (
  echo Usage: build-release.cmd [--configure-only]
  exit /b 2
)
call "%~dp0build-env.cmd"
if errorlevel 1 exit /b 1
cd /d "%SIMPBROWSER_SRC%"
echo configuring > "%~dp0release-build.exitcode"
call gn gen out\Release --fail-on-unused-args --args="is_debug=false is_component_build=false is_official_build=false symbol_level=0 blink_symbol_level=0 v8_symbol_level=0 dcheck_always_on=false target_cpu=\"x64\"" > "%~dp0release-configure.log" 2>&1
if errorlevel 1 goto failed
if "%~1"=="--configure-only" (
  echo configured > "%~dp0release-build.exitcode"
  echo Release configuration verified. No compilation was started.
  exit /b 0
)
echo running > "%~dp0release-build.exitcode"
call autoninja -C out\Release -j 8 chrome > "%~dp0release-build.log" 2>&1
if errorlevel 1 goto failed
echo 0 > "%~dp0release-build.exitcode"
echo Release build ready: %~dp0..\out\Release\chrome.exe
exit /b 0
:failed
echo 1 > "%~dp0release-build.exitcode"
echo Build failed. Check release-configure.log and release-build.log.
exit /b 1
