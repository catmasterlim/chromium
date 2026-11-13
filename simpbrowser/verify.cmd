@echo off
setlocal
call "%~dp0build-env.cmd"
if errorlevel 1 exit /b 1
cd /d "%~dp0"
if not exist test-results mkdir test-results
echo running > test-results\verification.exitcode
"%SIMPBROWSER_SRC%\out\SimpBrowser\url_unittests.exe" --test-launcher-bot-mode --test-launcher-summary-output=test-results\url-tests.json > test-results\url-tests.log 2>&1
set "URL_RESULT=%ERRORLEVEL%"
echo %URL_RESULT% > test-results\url-tests.exitcode
node smoke-test.mjs > test-results\smoke.log 2>&1
set "SMOKE_RESULT=%ERRORLEVEL%"
echo %SMOKE_RESULT% > test-results\smoke.exitcode
if not "%URL_RESULT%"=="0" goto failed
if not "%SMOKE_RESULT%"=="0" goto failed
echo 0 > test-results\verification.exitcode
exit /b 0
:failed
echo 1 > test-results\verification.exitcode
exit /b 1
