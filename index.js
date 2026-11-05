#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');
const { parseArgs } = require('node:util');
const { execFileSync } = require('node:child_process');
const { resolveAppPaths, isWindowsAppsPath } = require('./lib/platform');
const { buildPreload } = require('./lib/renderer');

function parseOptions(args) {
    const { values, positionals } = parseArgs({ args, allowPositionals: true, options: {
        path: { type: 'string' }, full: { type: 'boolean' }, rtl: { type: 'boolean' },
        'font-only': { type: 'boolean' }, patch: { type: 'boolean' }, restore: { type: 'boolean' },
        diagnose: { type: 'boolean' }, 'dry-run': { type: 'boolean' }, status: { type: 'boolean' },
        json: { type: 'boolean' }, help: { type: 'boolean', short: 'h' }
    } });
    if (positionals.length > 1 || (values.path && positionals.length)) throw new Error('Provide one installation path.');
    const full = values.full || values.rtl;
    if ([full, values['font-only'], values.restore].filter(Boolean).length > 1) throw new Error('Choose one operation: --full, --font-only, or --restore.');
    const mode = full ? 'full' : values['font-only'] ? 'font-only' : null;
    const readOnly = values.diagnose || values['dry-run'] || values.status;
    if (values.restore && readOnly) throw new Error('Choose one operation: diagnosis or restore.');
    if (values.patch && !mode && !readOnly) throw new Error('Choose --full or --font-only explicitly; native RTL cannot be inferred from a version.');
    return { action: values.help ? 'help' : readOnly ? 'diagnose' : values.restore ? 'restore' : mode ? 'patch' : 'menu', mode, customPath: values.path || positionals[0], json: values.json };
}

const HELP = `Ravan RTL — scoped RTL for Claude Desktop on Linux
Usage: node index.js [--path /path/to/app.asar] <operation>
  --diagnose, --dry-run, --status   Read-only build, targets and backup status
  --full, --rtl                  Explicit scoped RTL + Vazirmatn patch
  --font-only                    Typography only; no direction changes
  --restore                      Restore the exact backed-up build
  --json                         Machine-readable result
Quit Claude completely before apply/restore. Re-run diagnosis after every update.
No version threshold verifies native RTL. Signed macOS/MSIX and read-only
AppImage/Flatpak containers are not modified; no security checks are disabled.
`;

function runningPids(executable) {
    if (process.platform !== 'linux' || !executable) return [];
    executable = fs.realpathSync(executable);
    return fs.readdirSync('/proc').filter(name => /^\d+$/.test(name)).filter(pid => {
        try {
            return fs.readlinkSync(`/proc/${pid}/exe`).replace(/ \(deleted\)$/, '') === executable && !fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').includes('--type=');
        } catch (error) {
            if (['ENOENT', 'ESRCH', 'EACCES', 'EPERM'].includes(error.code)) return false;
            throw error;
        }
    });
}

function commandOutput(command, args) {
    try { return execFileSync(command, args, { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'pipe'] }).trim(); }
    catch { return null; }
}

async function main(args = process.argv.slice(2)) {
    const options = parseOptions(args);
    if (options.action === 'help') { console.log(HELP); return; }
    if (options.action === 'menu') {
        if (!process.stdin.isTTY) throw new Error('Choose --diagnose, --full, --font-only or --restore. Use --help for details.');
        const { action } = await require('inquirer').prompt([{ type: 'list', name: 'action', message: 'Choose an explicit operation (native RTL is unverified):', choices: [
            { name: 'Read-only diagnosis', value: '--diagnose' },
            { name: 'Scoped RTL + Vazirmatn', value: '--full' },
            { name: 'Vazirmatn only; keep native direction', value: '--font-only' },
            { name: 'Restore exact original build', value: '--restore' },
            { name: 'Exit', value: 'exit' }
        ] }]);
        if (action === 'exit') return;
        return main([action, ...(options.customPath ? ['--path', options.customPath] : [])]);
    }
    const paths = resolveAppPaths({ customPath: options.customPath });
    const archive = require('./lib/archive');
    const executable = paths.executablePath || [path.join(paths.appPath, 'claude-desktop'), path.join(paths.appPath, 'claude')].find(file => fs.existsSync(file));
    const before = archive.diagnose(paths.asarPath);
    let binaryVersion = null;
    let result = before;
    if (options.action !== 'diagnose') {
        if (process.platform !== 'linux' || isWindowsAppsPath(paths.asarPath)) throw new Error('In-place patching is only supported on writable Linux ASAR installations; signatures and integrity protections will not be bypassed.');
        if (/\/(?:flatpak|\.mount_)/.test(paths.asarPath) || fs.existsSync(`${paths.asarPath}.sig`)) throw new Error('Signed or read-only container detected; refusing in-place changes.');
        if (!executable) throw new Error('Cannot verify the application executable; specify its path with --path.');
        const fd = fs.openSync(executable, 'r');
        const signature = Buffer.alloc(4);
        try { fs.readSync(fd, signature, 0, 4, 0); } finally { fs.closeSync(fd); }
        if (!signature.equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))) throw new Error('Executable is a wrapper or unsupported format; cannot reliably detect running processes.');
        const pids = runningPids(executable);
        if (pids.length) throw new Error(`Quit Claude through its own Quit menu before ${options.action} (running PID: ${pids.join(', ')}).`);
        if (process.getuid() === 0) {
            const uid = process.env.PKEXEC_UID || process.env.SUDO_UID;
            if (!uid || !/^[1-9][0-9]*$/.test(uid)) throw new Error('Cannot safely identify the desktop user for version verification.');
            const user = commandOutput('/usr/bin/id', ['-un', uid]);
            if (!user) throw new Error('Cannot identify the desktop user for version verification.');
            const runuser = ['/usr/sbin/runuser', '/usr/bin/runuser'].find(file => fs.existsSync(file));
            if (!runuser) throw new Error('Cannot safely verify the version without runuser; no archive was modified.');
            binaryVersion = commandOutput(runuser, ['-u', user, '--', executable, '--version']);
        } else {
            binaryVersion = commandOutput(executable, ['--version']);
        }
        if (!binaryVersion) throw new Error('Cannot verify the application executable version; refusing to modify the archive.');
        if (binaryVersion !== before.version) throw new Error('Binary and ASAR versions disagree. Reassess the installed build before patching.');
        fs.accessSync(path.dirname(paths.asarPath), fs.constants.W_OK);
        result = options.action === 'restore' ? await archive.restore(paths.asarPath) : await archive.applyPatch(paths.asarPath, { mode: options.mode, payload: buildPreload(options.mode) });
    }
    const report = { ...result, asarPath: paths.asarPath, resourcesPath: paths.resourcesPath, executablePath: executable || null, launcherPath: paths.launcherPath || null,
        architecture: process.arch, binaryVersion,
        nativeRTL: 'unverified; select a mode explicitly', operation: options.action, requestedMode: options.mode,
        restartRequired: options.action !== 'diagnose' };
    console.log(options.json ? JSON.stringify(report, null, 2) : Object.entries(report).map(([key, value]) => `${key}: ${Array.isArray(value) ? value.join(', ') : value ?? 'unknown'}`).join('\n'));
}

if (require.main === module) main().catch(error => {
    console.error(`Error: ${error.message}`);
    if (['EACCES', 'EPERM'].includes(error.code)) console.error('The installation is protected. Use an existing authorized privilege mechanism to run this same command; never run the GUI as root.');
    process.exitCode = 1;
});

module.exports = { parseOptions, runningPids, main };
