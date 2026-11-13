# SimpBrowser

Chromium fork with SimpBrowser branding, YouTube quality controls, ad request
filtering, and local diagnostics. See [YOUTUBE.md](YOUTUBE.md) for UI and scope.

## Windows setup

Use Chromium's standard `depot_tools`/`gclient` checkout and dependency setup:
[Windows build instructions](../docs/windows_build_instructions.md).
Install the Visual Studio C++/ATL components and Windows SDK required by that
revision. Put `depot_tools` on PATH or set `SIMPBROWSER_DEPOT_TOOLS`.
The helper locates Visual Studio with `vswhere`; `vs2026_install` can override it.
Node.js 24 is needed for the browser tests. No npm dependencies are required.

Run from this directory:

```powershell
.\build.cmd                              # Development build: out/SimpBrowser
.\build-youtube.cmd                      # Incremental build + browser tests
.\build-release.cmd --configure-only     # Validate release configuration only
.\build-release.cmd                      # Optimized build: out/Release
.\SimpBrowser-Release.cmd                # Separate release profile
```

Release uses `is_debug=false`, `is_component_build=false`, disabled debug symbols
and DCHECKs, and 8 parallel jobs. It is not Google's official/PGO build.
An initial build can take several hours. Rerunning resumes incremental work.
Close browsers using the output directory before replacing DLLs/resources.
Keep the output directory's resources with `chrome.exe`.

## Verification

```powershell
.\verify.cmd
node .\test-youtube.mjs                  # Offline fixture checks, built browser
node .\test-youtube.mjs --live           # Also plays a public YouTube sample
```

Reports and test profiles are written under `simpbrowser/test-results`.
Logs, exit-code files, profiles, diagnostics exports, local configuration, and
generated output are ignored. The Chromium checkout's existing rules ignore
`out/`; binaries, cookies, login data, and raw test reports are not versioned.

Verified before this commit: 182 URL unit tests; 29 browser feature checks;
actual 1920×1080 playback. Portable helpers preserve the same browser checks.
Release configuration has been validated; a full release build has not been
verified as part of these results.
