const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const asar = require('@electron/asar');

const START = '/* CLAUDE_RTL_PATCH_START */';
const END = '/* CLAUDE_RTL_PATCH_END */';
const targets = ['.vite/build/mainView.js', '.vite/build/mainWindow.js'];
const payload = 'globalThis.fixtureRTL = "full";';
const preload = 'const { contextBridge } = require("electron");\ncontextBridge.exposeInMainWorld("fixture", {});\n';
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const read = file => fs.readFileSync(file);
const api = () => require('../lib/archive');

async function fixture(t, { version = '1.2.3', files = {}, unpacked = true } = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rtl-archive-test-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const source = path.join(dir, 'source');
    fs.mkdirSync(source);
    const entries = {
        'package.json': JSON.stringify({ name: 'fixture', version }),
        '.vite/build/index.chunk-example.js': 'const windows = [{webPreferences: {preload: path.join(app.getAppPath(), ".vite/build/mainWindow.js")}}, {webPreferences: {preload: path.join(app.getAppPath(), "mainView.js")}}];',
        '.vite/build/mainView.js': preload,
        '.vite/build/mainWindow.js': preload.replace('"electron"', '"electron/renderer"'),
        '.vite/build/notMainWindow.js': preload,
        '.vite/renderer/mainWindow.js': preload,
        '.vite/renderer/style.css': 'p { color: red; }',
        'bin/packed-helper': '#!/bin/sh\nexit 0\n',
        'native/helper.node': Buffer.from([0, 1, 2, 255]),
        'native/literal[1].bin': 'exact unpacked filename',
        'data/empty': '',
        ...files,
    };
    for (const [name, contents] of Object.entries(entries)) {
        if (contents === null) continue;
        const file = path.join(source, name);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, contents);
    }
    fs.chmodSync(path.join(source, 'bin/packed-helper'), 0o751);
    fs.chmodSync(path.join(source, 'native/helper.node'), 0o751);
    fs.symlinkSync('packed-helper', path.join(source, 'bin/packed-alias'));
    fs.symlinkSync('helper.node', path.join(source, 'native/helper-alias'));
    const app = path.join(dir, 'app.asar');
    await asar.createPackageWithOptions(source, app, unpacked ? { unpackDir: 'native' } : {});
    fs.chmodSync(app, 0o640);
    const original = read(app);
    return { dir, app, original, source };
}

function inventory(app) {
    asar.uncache(app);
    return Object.fromEntries(asar.listPackage(app).map(name => {
        name = name.slice(1);
        const node = asar.statFile(app, name, false);
        return [name, {
            unpacked: node.unpacked,
            executable: node.executable,
            link: node.link,
            directory: !!node.files,
            bytes: node.files || node.link ? null : asar.extractFile(app, name),
        }];
    }));
}

function assertIntegrity(app) {
    asar.uncache(app);
    for (const name of asar.listPackage(app).map(name => name.slice(1))) {
        const node = asar.statFile(app, name, false);
        if (node.files || node.link) continue;
        const bytes = asar.extractFile(app, name);
        assert.equal(node.integrity.algorithm, 'SHA256', name);
        assert.equal(node.integrity.hash, hash(bytes), name);
        const blocks = [];
        for (let offset = 0; offset < bytes.length; offset += node.integrity.blockSize) {
            blocks.push(hash(bytes.subarray(offset, offset + node.integrity.blockSize)));
        }
        if (!blocks.length) blocks.push(hash(Buffer.alloc(0)));
        assert.deepEqual(node.integrity.blocks, blocks, name);
    }
}

function editHeader(f, edit) {
    const { Pickle } = require(path.join(path.dirname(require.resolve('@electron/asar')), 'pickle.js'));
    const { header, headerSize } = asar.getRawHeader(f.app);
    edit(header);
    const body = read(f.app).subarray(8 + headerSize);
    const pickle = Pickle.createEmpty();
    pickle.writeString(JSON.stringify(header));
    const bytes = pickle.toBuffer();
    const size = Pickle.createEmpty();
    size.writeUInt32(bytes.length);
    fs.writeFileSync(f.app, Buffer.concat([size.toBuffer(), bytes, body]));
    asar.uncache(f.app);
    f.original = read(f.app);
}

function assertNoTemporaryFiles(f) {
    assert.equal(fs.existsSync(`${f.app}.rtl-lock`), false);
    assert.deepEqual(fs.readdirSync(f.dir).filter(name => name.startsWith('app.asar.rtl-stage-')), []);
}

test('archive replacement and restoration preserve extended security and ACL attributes', async t => {
    const f = await fixture(t);
    const python = '/usr/bin/python3';
    execFileSync(python, ['-I', '-c', 'import os,sys; os.setxattr(sys.argv[1], "user.rtl-fixture", b"metadata\\x00unchanged")', f.app]);
    execFileSync('/usr/bin/setfacl', ['-m', 'u:65534:r--', f.app]);
    const attributes = file => execFileSync(python, ['-I', '-c', 'import os,sys,json,base64; print(json.dumps({k:base64.b64encode(os.getxattr(sys.argv[1],k)).decode() for k in sorted(os.listxattr(sys.argv[1]))},sort_keys=True))', file], { encoding: 'utf8' });
    const before = attributes(f.app);
    await api().applyPatch(f.app, { mode: 'full', payload });
    assert.equal(attributes(f.app), before);
    await api().restore(f.app);
    assert.equal(attributes(f.app), before);
});

test('backup metadata stays readable to the same readers without broadening private archives', async t => {
    for (const mode of [0o644, 0o600]) {
        const f = await fixture(t);
        fs.chmodSync(f.app, mode);
        const result = await api().applyPatch(f.app, { mode: 'full', payload });
        assert.equal(fs.statSync(`${f.app}.rtl-backups`).mode & 0o777, 0o755);
        assert.equal(fs.statSync(result.backupDirectory).mode & 0o777, mode === 0o644 ? 0o755 : 0o700);
        assert.equal(fs.statSync(path.join(result.backupDirectory, 'manifest.json')).mode & 0o777, mode);
    }
});

test('CSS-only legacy patches and shell-only or unwired preloads cannot be treated as supported pristine builds', async t => {
    const legacy = await fixture(t, { files: { '.vite/renderer/style.css': '/* RTL and Vazirmatn Font Patch */ p { direction: rtl; }' } });
    assert.equal(api().diagnose(legacy.app).status, 'unmanaged-patch');
    await assert.rejects(api().applyPatch(legacy.app, { mode: 'full', payload }), /[Uu]nmanaged/);
    assert.equal(fs.existsSync(`${legacy.app}.rtl-backups`), false);
    const unwired = await fixture(t, { files: { '.vite/build/index.chunk-example.js': 'const unused = "mainView.js"; const other = "mainWindow.js";' } });
    assert.throws(() => api().diagnose(unwired.app), /[Nn]o supported/);
    const shell = await fixture(t, { files: { '.vite/build/mainView.js': 'const contextBridge = {};' } });
    assert.throws(() => api().diagnose(shell.app), /content preload|[Nn]o supported/);
});

test('diagnose reads the actual package version and verified preloads without writes', async t => {
    const f = await fixture(t);
    const before = fs.statSync(f.app);
    const names = fs.readdirSync(f.dir);
    const d = api().diagnose(f.app);
    assert.equal(d.version, '1.2.3');
    assert.equal(d.sha256, hash(f.original));
    assert.deepEqual(d.targets, targets);
    assert.equal(d.status, 'original');
    assert.equal(d.mode, null);
    assert.equal(d.backupDirectory, `${f.app}.rtl-backups/1.2.3-${hash(f.original)}`);
    assert.deepEqual(fs.readdirSync(f.dir), names);
    assert.equal(fs.statSync(f.app).mtimeMs, before.mtimeMs);
    assert.deepEqual(read(f.app), f.original);
});

test('only referenced Electron bridge preloads qualify; unrelated lookalikes and CSS stay untouched', async t => {
    const f = await fixture(t, { files: {
        '.vite/build/mainWindow.js': 'const contextBridge = {}; // no Electron require',
    } });
    assert.deepEqual(api().diagnose(f.app).targets, [targets[0]]);
    const before = inventory(f.app);
    await api().applyPatch(f.app, { mode: 'full', payload });
    const after = inventory(f.app);
    for (const name of Object.keys(before).filter(name => name !== targets[0])) {
        assert.deepEqual(after[name], before[name], name);
    }
});

test('diagnose rejects archives with no supported, referenced preload', async t => {
    for (const files of [
        { '.vite/build/mainView.js': null, '.vite/build/mainWindow.js': null },
        { '.vite/build/index.chunk-example.js': 'const unrelated = "mainWindow-lookalike.js";' },
    ]) {
        const f = await fixture(t, { files });
        assert.throws(() => api().diagnose(f.app), /supported.*preload|supported.*target/i);
        assert.deepEqual(read(f.app), f.original);
    }
});

test('apply appends one marked payload, refreshes integrity, and preserves exact archive and native metadata', async t => {
    const f = await fixture(t);
    const before = inventory(f.app);
    const outer = fs.statSync(f.app);
    const helperPath = `${f.app}.unpacked/native/helper.node`;
    const helper = fs.statSync(helperPath);
    fs.writeFileSync(`${f.app}.bak`, 'untrusted stale legacy backup');
    const d = await api().applyPatch(f.app, { mode: 'full', payload });
    assert.equal(d.status, 'patched');
    assert.equal(d.mode, 'full');
    const after = inventory(f.app);
    assert.deepEqual(Object.keys(after), Object.keys(before));
    for (const name of Object.keys(before)) {
        const expected = { ...before[name] };
        if (targets.includes(name)) expected.bytes = Buffer.concat([before[name].bytes, Buffer.from(`\n${START}\n${payload}\n${END}\n`)]);
        assert.deepEqual(after[name], expected, name);
    }
    assertIntegrity(f.app);
    assert.deepEqual(read(path.join(d.backupDirectory, 'app.asar')), f.original);
    assert.equal(fs.existsSync(path.join(d.backupDirectory, 'app.asar.unpacked')), false);
    assert.equal(read(`${f.app}.bak`).toString(), 'untrusted stale legacy backup');
    const current = fs.statSync(f.app);
    assert.deepEqual([current.mode, current.uid, current.gid], [outer.mode, outer.uid, outer.gid]);
    const native = fs.statSync(helperPath);
    assert.deepEqual([native.ino, native.mode, native.uid, native.gid], [helper.ino, helper.mode, helper.uid, helper.gid]);
    assert.equal(fs.readlinkSync(`${f.app}.unpacked/native/helper-alias`), 'helper.node');
    assertNoTemporaryFiles(f);
});

test('explicit false flags and executable metadata on unpacked entries survive packing', async t => {
    const f = await fixture(t);
    editHeader(f, header => {
        header.files.native.files['helper.node'].executable = true;
        header.files.data.files.empty.unpacked = false;
        header.files.data.files.empty.executable = false;
        header.files.data.executable = false;
    });
    const before = inventory(f.app);
    await api().applyPatch(f.app, { mode: 'full', payload });
    const after = inventory(f.app);
    for (const name of Object.keys(before).filter(name => !targets.includes(name))) assert.deepEqual(after[name], before[name], name);
    assertIntegrity(f.app);
    await api().restore(f.app);
    assert.deepEqual(read(f.app), f.original);
});

test('large multi-block files and an archive without unpacked resources survive apply and restore', async t => {
    const f = await fixture(t, { unpacked: false, files: { 'data/large': Buffer.alloc(4 * 1024 * 1024 + 17, 0xa5) } });
    const before = inventory(f.app);
    await api().applyPatch(f.app, { mode: 'full', payload });
    const after = inventory(f.app);
    assert.deepEqual(after['data/large'].bytes, before['data/large'].bytes);
    assertIntegrity(f.app);
    assert.equal(asar.statFile(f.app, 'data/large').integrity.blocks.length, 2);
    assert.equal(fs.existsSync(`${f.app}.unpacked`), false);
    await api().restore(f.app);
    assert.deepEqual(read(f.app), f.original);
    assert.equal(fs.existsSync(`${f.app}.unpacked`), false);
});

test('backup symlinks and traversal header names are rejected without modifying their targets', async t => {
    const f = await fixture(t);
    const external = path.join(f.dir, 'external-backups');
    fs.mkdirSync(external);
    fs.symlinkSync(external, `${f.app}.rtl-backups`);
    await assert.rejects(api().applyPatch(f.app, { mode: 'full', payload }), /symlink/i);
    assert.deepEqual(fs.readdirSync(external), []);
    assert.deepEqual(read(f.app), f.original);
    fs.unlinkSync(`${f.app}.rtl-backups`);
    editHeader(f, header => { header.files['..'] = { files: { 'escape': { size: 0, offset: '0' } } }; });
    assert.throws(() => api().diagnose(f.app), /unsafe.*path/i);
    await assert.rejects(api().applyPatch(f.app, { mode: 'full', payload }), /unsafe.*path/i);
    assert.deepEqual(read(f.app), f.original);
    assertNoTemporaryFiles(f);
});

test('same payload and mode are a byte-, inode-, and mtime-preserving no-op', async t => {
    const f = await fixture(t);
    const first = await api().applyPatch(f.app, { mode: 'full', payload });
    const manifest = path.join(first.backupDirectory, 'manifest.json');
    const files = [f.app, path.join(first.backupDirectory, 'app.asar'), manifest];
    const before = files.map(file => ({ bytes: read(file), stat: fs.statSync(file) }));
    assert.deepEqual(await api().applyPatch(f.app, { mode: 'full', payload }), first);
    files.forEach((file, i) => {
        assert.deepEqual(read(file), before[i].bytes);
        const current = fs.statSync(file);
        assert.equal(current.ino, before[i].stat.ino);
        assert.equal(current.mtimeMs, before[i].stat.mtimeMs);
    });
    assertNoTemporaryFiles(f);
});

test('different mode or payload repatches from pristine backup and restore is byte-exact', async t => {
    const f = await fixture(t);
    const first = await api().applyPatch(f.app, { mode: 'full', payload });
    const second = await api().applyPatch(f.app, { mode: 'font-only', payload: 'globalThis.fontOnly = true;' });
    assert.equal(second.mode, 'font-only');
    assert.equal(second.backupDirectory, first.backupDirectory);
    for (const target of targets) {
        const text = asar.extractFile(f.app, target).toString();
        assert.equal(text.split(START).length, 2);
        assert.equal(text.includes('fixtureRTL'), false);
        assert.equal(text.includes('globalThis.fontOnly = true;'), true);
    }
    const changedPayload = await api().applyPatch(f.app, { mode: 'font-only', payload: 'globalThis.fontOnly = 2;' });
    assert.notEqual(changedPayload.sha256, second.sha256);
    const restored = await api().restore(f.app);
    assert.equal(restored.status, 'original');
    assert.equal(restored.sha256, hash(f.original));
    assert.deepEqual(read(f.app), f.original);
    assert.deepEqual(read(path.join(first.backupDirectory, 'app.asar')), f.original);
    assertIntegrity(f.app);
    assertNoTemporaryFiles(f);
});

test('a tampered pristine backup prevents even idempotent apply and restore', async t => {
    const f = await fixture(t);
    const d = await api().applyPatch(f.app, { mode: 'full', payload });
    const current = read(f.app);
    fs.appendFileSync(path.join(d.backupDirectory, 'app.asar'), 'tampered');
    await assert.rejects(api().applyPatch(f.app, { mode: 'full', payload }), /backup.*hash|backup.*integrity/i);
    await assert.rejects(api().restore(f.app), /backup.*hash|backup.*integrity/i);
    assert.deepEqual(read(f.app), current);
    assertNoTemporaryFiles(f);
});

test('restore never rolls back a different build, including a newer build with the same version', async t => {
    for (const version of ['1.2.3', '2.0.0']) {
        const f = await fixture(t);
        const d = await api().applyPatch(f.app, { mode: 'full', payload });
        const newer = await fixture(t, { version, files: { 'data/new-build': 'new release' } });
        fs.copyFileSync(newer.app, f.app);
        await assert.rejects(api().restore(f.app), /recorded|managed|patched|match/i);
        assert.deepEqual(read(f.app), newer.original);
        const reapplied = await api().applyPatch(f.app, { mode: 'full', payload });
        assert.notEqual(reapplied.backupDirectory, d.backupDirectory);
        assert.deepEqual(read(path.join(d.backupDirectory, 'app.asar')), f.original);
        assert.deepEqual(read(path.join(reapplied.backupDirectory, 'app.asar')), newer.original);
        await api().restore(f.app);
        assert.deepEqual(read(f.app), newer.original);
    }
});

test('unrecognized and legacy preload patch markers are unmanaged and cannot be mutated', async t => {
    for (const marker of [START, END, '/* CLAUDE_RTL_OLD_PATCH */', '// Injected for Persian/Arabic/Hebrew support']) {
        const f = await fixture(t, { files: { [targets[0]]: `${preload}\n${marker}\noldPayload();` } });
        assert.equal(api().diagnose(f.app).status, 'unmanaged-patch');
        await assert.rejects(api().applyPatch(f.app, { mode: 'full', payload }), /unmanaged|unrecognized/i);
        await assert.rejects(api().restore(f.app), /unmanaged|unrecognized/i);
        assert.deepEqual(read(f.app), f.original);
        assertNoTemporaryFiles(f);
    }
});

test('marked archives without a matching manifest cannot be patched or restored', async t => {
    const f = await fixture(t);
    const d = await api().applyPatch(f.app, { mode: 'full', payload });
    const current = read(f.app);
    fs.renameSync(`${f.app}.rtl-backups`, path.join(f.dir, 'detached-backups'));
    assert.equal(api().diagnose(f.app).status, 'unmanaged-patch');
    await assert.rejects(api().restore(f.app), /unmanaged/i);
    await assert.rejects(api().applyPatch(f.app, { mode: 'font-only', payload }), /unmanaged/i);
    assert.deepEqual(read(f.app), current);
    assert.equal(fs.existsSync(d.backupDirectory), false);
});

test('unpacked native tampering prevents repatch and restore without overwriting native files', async t => {
    const f = await fixture(t);
    await api().applyPatch(f.app, { mode: 'full', payload });
    const current = read(f.app);
    const native = `${f.app}.unpacked/native/helper.node`;
    fs.writeFileSync(native, 'externally changed native file');
    await assert.rejects(api().restore(f.app), /unpacked/i);
    await assert.rejects(api().applyPatch(f.app, { mode: 'full', payload }), /unpacked/i);
    assert.deepEqual(read(f.app), current);
    assert.equal(read(native).toString(), 'externally changed native file');
});

test('prepared manifest hashes recover a commit interrupted before manifest finalization', async t => {
    const f = await fixture(t);
    const d = await api().applyPatch(f.app, { mode: 'full', payload });
    const manifestPath = path.join(d.backupDirectory, 'manifest.json');
    const manifest = JSON.parse(read(manifestPath));
    manifest.pending = manifest.current;
    manifest.current = null;
    fs.writeFileSync(manifestPath, JSON.stringify(manifest));
    assert.equal(api().diagnose(f.app).status, 'patched');
    assert.equal(api().diagnose(f.app).mode, 'full');
    const current = read(f.app);
    await api().applyPatch(f.app, { mode: 'full', payload });
    assert.deepEqual(read(f.app), current);
    await api().restore(f.app);
    assert.deepEqual(read(f.app), f.original);
});

test('an existing lock is never removed, followed, or overridden', async t => {
    const f = await fixture(t);
    const lock = `${f.app}.rtl-lock`;
    fs.writeFileSync(lock, 'another operation');
    await assert.rejects(api().applyPatch(f.app, { mode: 'full', payload }), /lock|EEXIST/i);
    await assert.rejects(api().restore(f.app), /lock|EEXIST/i);
    assert.equal(read(lock).toString(), 'another operation');
    assert.deepEqual(read(f.app), f.original);
    fs.unlinkSync(lock);
    fs.symlinkSync(f.app, lock);
    await assert.rejects(api().applyPatch(f.app, { mode: 'full', payload }), /lock|EEXIST/i);
    assert.equal(fs.lstatSync(lock).isSymbolicLink(), true);
    assert.deepEqual(read(f.app), f.original);
});

test('a real manifest rename failure before replacement rolls back and cleans only owned temporary files', async t => {
    const f = await fixture(t);
    const backupDirectory = api().diagnose(f.app).backupDirectory;
    const sentinel = path.join(f.dir, 'app.asar.rtl-stage-other-operation');
    fs.mkdirSync(sentinel);
    const watcher = fs.watch(f.dir, (event, filename) => {
        if (!filename || !filename.startsWith('app.asar.rtl-stage-') || filename === path.basename(sentinel)) return;
        const manifestPath = path.join(backupDirectory, 'manifest.json');
        if (fs.existsSync(manifestPath) && fs.statSync(manifestPath).isFile()) {
            fs.unlinkSync(manifestPath);
            fs.mkdirSync(manifestPath);
        }
    });
    try {
        await assert.rejects(api().applyPatch(f.app, { mode: 'full', payload }), /EISDIR|ENOTDIR|directory/i);
    } finally {
        watcher.close();
    }
    assert.deepEqual(read(f.app), f.original);
    assert.equal(fs.existsSync(`${f.app}.rtl-lock`), false);
    assert.deepEqual(fs.readdirSync(f.dir).filter(name => name.startsWith('app.asar.rtl-stage-')), [path.basename(sentinel)]);
});

test('an external archive change during staging is detected immediately before replacement', async t => {
    const f = await fixture(t);
    let changed = false;
    const externallyChanged = Buffer.concat([f.original, Buffer.from('external updater')]);
    const watcher = fs.watch(f.dir, (event, filename) => {
        if (!changed && filename && filename.startsWith('app.asar.rtl-stage-')) {
            changed = true;
            fs.writeFileSync(f.app, externallyChanged);
        }
    });
    try {
        await assert.rejects(api().applyPatch(f.app, { mode: 'full', payload }), /changed|hash.*match/i);
    } finally {
        watcher.close();
    }
    assert.equal(changed, true);
    assert.deepEqual(read(f.app), externallyChanged);
    assertNoTemporaryFiles(f);
});

test('native bytes must match the original header integrity even before the first backup', async t => {
    const f = await fixture(t);
    const native = `${f.app}.unpacked/native/helper.node`;
    fs.writeFileSync(native, Buffer.from([0, 1, 3, 255]));
    await assert.rejects(api().applyPatch(f.app, { mode: 'full', payload }), /integrity/i);
    assert.deepEqual(read(f.app), f.original);
    assert.equal(fs.existsSync(`${f.app}.rtl-backups`), false);
    assertNoTemporaryFiles(f);
});

test('a matching hash alone does not make an unrecognized marker block managed', async t => {
    const f = await fixture(t);
    const d = await api().applyPatch(f.app, { mode: 'full', payload });
    const manifestPath = path.join(d.backupDirectory, 'manifest.json');
    const manifest = JSON.parse(read(manifestPath));
    manifest.current.payloadSha256 = hash('different unrecorded payload');
    fs.writeFileSync(manifestPath, JSON.stringify(manifest));
    const current = read(f.app);
    assert.equal(api().diagnose(f.app).status, 'unmanaged-patch');
    await assert.rejects(api().applyPatch(f.app, { mode: 'font-only', payload }), /unmanaged|unrecognized/i);
    await assert.rejects(api().restore(f.app), /unmanaged|unrecognized/i);
    assert.deepEqual(read(f.app), current);
});

test('ordinary RTL style identifiers are allowed in the renderer payload', async t => {
    const f = await fixture(t);
    const script = 'globalThis["claude-rtl-patcher"] = true;';
    const d = await api().applyPatch(f.app, { mode: 'full', payload: script });
    assert.equal(d.status, 'patched');
    assert.equal(asar.extractFile(f.app, targets[0]).toString().includes(script), true);
    await api().restore(f.app);
    assert.deepEqual(read(f.app), f.original);
});

test('mutation rejects invalid options before creating backups or locks', async t => {
    const f = await fixture(t);
    const names = fs.readdirSync(f.dir);
    for (const options of [{ mode: 'auto', payload }, { mode: 'full', payload: 42 }, { mode: 'full', payload: '' }, { mode: 'full', payload: START }]) {
        await assert.rejects(api().applyPatch(f.app, options), /mode|payload|marker/i);
    }
    assert.deepEqual(fs.readdirSync(f.dir), names);
    assert.deepEqual(read(f.app), f.original);
});

test('mutation rejects non-Linux platforms and external signature sidecars without changes', async t => {
    const f = await fixture(t);
    const modulePath = path.resolve(__dirname, '../lib/archive.js');
    const result = execFileSync(process.execPath, ['-e', `Object.defineProperty(process, 'platform', {value: 'darwin'}); require(process.argv[1]).applyPatch(process.argv[2], {mode:'full', payload:'void 0;'}).then(() => process.exit(2), e => process.stdout.write(e.message));`, modulePath, f.app], { encoding: 'utf8' });
    assert.match(result, /Linux|signed/i);
    fs.writeFileSync(`${f.app}.sig`, 'external signature');
    assert.equal(api().diagnose(f.app).status, 'original');
    await assert.rejects(api().applyPatch(f.app, { mode: 'full', payload }), /sign|integrity/i);
    assert.deepEqual(read(f.app), f.original);
    assert.equal(fs.existsSync(`${f.app}.rtl-backups`), false);
    assertNoTemporaryFiles(f);
});
