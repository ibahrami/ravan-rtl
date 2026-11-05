# Ravan RTL

**Natural right-to-left text for Claude Desktop on Linux.**

Ravan RTL is an independent, open-source presentation patcher for supported Linux installations of Claude Desktop. It adds scoped right-to-left layout and the Vazirmatn font for Persian, Arabic and other right-to-left text, while keeping English, code, paths and math readable. It does not alter saved messages or account settings.

## Quick start

You need Git, Bash, Node.js **22.12.0 or newer**, npm, and `/usr/bin/python3`. An internet connection is needed for the initial dependency installation. Quit Claude Desktop completely, including its tray icon, then run:

```bash
git clone https://github.com/ibahrami/ravan-rtl.git && bash ravan-rtl/install.sh
```

The installer installs the locked dependencies with lifecycle scripts disabled, diagnoses the archive, and applies the full RTL mode. If the installation requires elevated ownership or directory access, it invokes `pkexec` and your existing authentication agent; elevated operations also require `runuser` to verify the application version as your normal user. Run the installer as your normal user; do not run the desktop application as root. Review the source before authorizing privileged execution: the patcher and its dependencies run with elevated privileges when elevation is needed. Do not authorize it if another user can modify your checkout, dependencies, or Node executable.

Reopen Claude Desktop normally after the installer succeeds. Keep the cloned directory: it is needed to update the patch or restore the original build. If automatic discovery fails, specify the installation path:

```bash
bash ravan-rtl/install.sh --path /path/to/resources/app.asar
```

The script requires a local checkout, not a downloaded standalone script. Existing dependencies are checked and reused, so diagnosis and restoration can run offline; the script does not replace an existing dependency directory. It does not install Node.js or system packages, close a running application, change its security configuration, or publish an npm package.

## Operations

```bash
# Read-only compatibility check
bash ravan-rtl/install.sh --diagnose

# Typography only; keep the application's native direction
bash ravan-rtl/install.sh --font-only

# Restore the exact original archive for this build
bash ravan-rtl/install.sh --restore
```

Each operation also accepts `--path /path/to/resources/app.asar`. Quit the application before applying or restoring. A running process, unsupported preload, unrecognized patch, changed backup, or incompatible archive causes a clear failure rather than a silent success. The patcher does not turn off integrity checks, alter the executable, or replace native unpacked files. Signed bundles, read-only containers, script launchers and unsupported executable layouts are not modified. If the executable cannot be verified, supply its full path with `--path`.

After a Desktop update, quit the app, run `--diagnose`, check that the detected build and targets are supported, then explicitly reapply the desired mode. Every build receives its own backup; never copy an older archive over a new build. If a patch is interrupted, an existing lock must be investigated rather than forcibly removed while another patcher might be running. Backups are stored next to `app.asar` under `app.asar.rtl-backups/<version>-<original-sha256>/`. The patcher validates backup identity, file metadata, archive integrity and native unpacked files before atomic replacement.

## How it works

Ravan RTL classifies relevant message, composer, task-list and question-panel text independently. It uses the renderer's Unicode bidi behavior and never reverses strings or inserts hidden direction characters into messages. The font is embedded in the renderer under the existing content security policy. Code and mathematical content remain isolated; unrelated interface elements are not globally forced right-to-left. The font-only mode does not change text direction.

Frontend markup can change independently of the app version. A successful archive patch or automated test does **not** guarantee visual compatibility: check the actual Desktop interface with synthetic content after installation and updates. The most recent receipt and task-panel refinements have browser regression coverage but have not yet been verified on an actual installed Desktop build. Long streaming, live caret and clipboard behavior have not been fully verified.

## Development

```bash
npm ci --ignore-scripts
npm test
```

The browser regression test is optional unless both `RTL_BROWSER_DRIVER` (an installed Puppeteer-compatible module) and `RTL_BROWSER_EXECUTABLE` point to a compatible browser. The remaining tests exercise real ASAR fixtures, backup/restore safety and installer behavior. An npm audit of the locked dependency tree currently reports five advisories (three moderate and two high); the project does not claim an audit-clean dependency tree. Do not commit credentials, account data, private conversations or personal screenshots.

## Credits and license

Ravan RTL is based on [claude-rtl-patcher](https://github.com/m4tinbeigi-official/claude-rtl-patcher), originally by Rick Sanchez & Contributors. The software is distributed under the [MIT License](LICENSE). The bundled Vazirmatn font is copyright its authors and is distributed under the [SIL Open Font License 1.1](FONT-LICENSE). This independent project is not affiliated with or endorsed by Anthropic.
