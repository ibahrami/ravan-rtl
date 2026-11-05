const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveAppPaths, isWindowsAppsPath } = require('../lib/platform');
const path = require('node:path');

test('resolves a custom macOS app bundle', () => {
    const paths = resolveAppPaths({
        customPath: '/Applications/Claude.app',
        platform: 'darwin'
    });

    assert.equal(paths.appPath, '/Applications/Claude.app');
    assert.equal(paths.asarPath, '/Applications/Claude.app/Contents/Resources/app.asar');
    assert.equal(paths.infoPlistPath, '/Applications/Claude.app/Contents/Info.plist');
});

test('resolves a direct macOS app.asar path to the app bundle root', () => {
    const paths = resolveAppPaths({
        customPath: '/Applications/Claude.app/Contents/Resources/app.asar',
        platform: 'darwin'
    });

    assert.equal(paths.appPath, '/Applications/Claude.app');
    assert.equal(paths.infoPlistPath, '/Applications/Claude.app/Contents/Info.plist');
});

test('detects WindowsApps paths with either path separator', () => {
    assert.equal(isWindowsAppsPath('C:\\Program Files\\WindowsApps\\Claude\\app.asar'), true);
    assert.equal(isWindowsAppsPath('C:/Program Files/WindowsApps/Claude/app.asar'), true);
    assert.equal(isWindowsAppsPath('C:\\Users\\me\\Claude\\resources\\app.asar'), false);
});

const fs = require('node:fs');
const os = require('node:os');

test('Linux detection follows the actual desktop launcher and executable symlink', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rtl-discovery-'));
    try {
        for (const dir of ['data/applications', 'bin', 'installed/resources']) fs.mkdirSync(path.join(root, dir), { recursive: true });
        fs.writeFileSync(path.join(root, 'installed/resources/app.asar'), 'fixture');
        fs.writeFileSync(path.join(root, 'installed/claude-desktop'), 'fixture');
        fs.symlinkSync(path.join(root, 'installed/claude-desktop'), path.join(root, 'bin/custom-claude'));
        fs.writeFileSync(path.join(root, 'data/applications/com.anthropic.Claude.desktop'), '[Desktop Entry]\nExec=custom-claude %U\n');
        const env = { HOME: root, XDG_DATA_HOME: path.join(root, 'data'), XDG_DATA_DIRS: path.join(root, 'none'), PATH: path.join(root, 'bin') };
        const paths = resolveAppPaths({ platform: 'linux', env });
        assert.equal(paths.asarPath, path.join(root, 'installed/resources/app.asar'));
        assert.equal(paths.executablePath, path.join(root, 'installed/claude-desktop'));
        fs.writeFileSync(path.join(root, 'data/applications/com.anthropic.Claude.desktop'), '[Desktop Entry]\nExec=/bin/sh wrapper\n');
        assert.throws(() => resolveAppPaths({ platform: 'linux', env }), /wrapper|Flatpak|AppImage/);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

for (const form of ['app', 'resources', 'app.asar', 'executable']) {
    test(`resolves a Linux custom ${form} path`, () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rtl-path-'));
        try {
            fs.mkdirSync(path.join(root, 'resources'));
            fs.writeFileSync(path.join(root, 'resources', 'app.asar'), 'fixture');
            fs.writeFileSync(path.join(root, 'claude-desktop'), 'fixture');
            const customPath = { app: root, resources: path.join(root, 'resources'), 'app.asar': path.join(root, 'resources', 'app.asar'), executable: path.join(root, 'claude-desktop') }[form];
            assert.equal(resolveAppPaths({ customPath, platform: 'linux' }).asarPath, path.join(root, 'resources', 'app.asar'));
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    });
}

test('Linux custom executable paths retain their verified executable identity', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ravan-executable-'));
    try {
        fs.mkdirSync(path.join(root, 'resources'));
        fs.writeFileSync(path.join(root, 'resources/app.asar'), 'fixture');
        fs.writeFileSync(path.join(root, 'CustomClaude'), 'fixture');
        assert.equal(resolveAppPaths({ customPath: path.join(root, 'CustomClaude'), platform: 'linux' }).executablePath, path.join(root, 'CustomClaude'));
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
