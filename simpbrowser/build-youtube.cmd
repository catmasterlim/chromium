@echo off
setlocal
call "%~dp0build-env.cmd"
if errorlevel 1 exit /b 1
cd /d "%SIMPBROWSER_SRC%"
echo running > "%~dp0youtube-build.exitcode"
echo pending > "%~dp0youtube-checks.exitcode"
call gn gen out\SimpBrowser > "%~dp0logs\youtube-configure.log" 2>&1
if errorlevel 1 goto build_failed
call autoninja -C out\SimpBrowser -j 12 chrome url_unittests > "%~dp0logs\youtube-build.log" 2>&1
if errorlevel 1 goto build_failed
echo 0 > "%~dp0youtube-build.exitcode"
cd /d "%~dp0"
echo running > youtube-checks.exitcode
call verify.cmd > "%~dp0logs\youtube-baseline-tests.log" 2>&1
set "BASELINE_RESULT=%ERRORLEVEL%"
node test-youtube.mjs --live > "%~dp0logs\youtube-feature-tests.log" 2>&1
set "FEATURE_RESULT=%ERRORLEVEL%"
if not "%BASELINE_RESULT%"=="0" goto checks_failed
if not "%FEATURE_RESULT%"=="0" goto checks_failed
echo 0 > youtube-checks.exitcode
exit /b 0
:build_failed
echo 1 > "%~dp0youtube-build.exitcode"
echo build_failed > "%~dp0youtube-checks.exitcode"
exit /b 1
:checks_failed
echo 1 > youtube-checks.exitcode
exit /b 1
