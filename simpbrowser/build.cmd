@echo off
setlocal
call "%~dp0build-env.cmd"
if errorlevel 1 exit /b 1
cd /d "%SIMPBROWSER_SRC%"
call gn gen out\SimpBrowser --args="is_debug=true is_component_build=true symbol_level=0 blink_symbol_level=0 v8_symbol_level=0 target_cpu=\"x64\"" > "%~dp0logs\configure.log" 2>&1
if errorlevel 1 exit /b %ERRORLEVEL%
call autoninja -C out\SimpBrowser -j 12 chrome url_unittests > "%~dp0logs\build.log" 2>&1
set "RESULT=%ERRORLEVEL%"
echo %RESULT% > "%~dp0build.exitcode"
exit /b %RESULT%
