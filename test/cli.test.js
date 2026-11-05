const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { parseOptions, runningPids } = require('../index');

test('running-process detection resolves executable symlinks', () => {
    const fs = require('node:fs');
    const os = require('node:os');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rtl-pids-'));
    try {
        const link = path.join(root, 'node-link');
        fs.symlinkSync(process.execPath, link);
        assert.ok(runningPids(link).includes(String(process.pid)));
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('patch modes are explicit and mutually exclusive', () => {
    assert.equal(parseOptions(['--full']).mode, 'full');
    assert.equal(parseOptions(['--font-only']).mode, 'font-only');
    assert.throws(() => parseOptions(['--patch']), /explicit|full|font-only/i);
    assert.throws(() => parseOptions(['--full', '--font-only']), /one|exclusive/i);
    assert.throws(() => parseOptions(['--restore', '--full']), /one|exclusive/i);
    assert.throws(() => parseOptions(['--unknown']), /unknown/i);
});

test('dry-run and status select a read-only operation and accept normal Linux paths', () => {
    assert.equal(parseOptions(['--dry-run', '/usr/lib/claude-desktop']).action, 'diagnose');
    assert.equal(parseOptions(['--status']).action, 'diagnose');
    assert.equal(parseOptions(['--diagnose', '--path', '/example with spaces/resources']).customPath, '/example with spaces/resources');
});

test('mismatched binary and archive versions are rejected before any backup or mutation', async () => {
    const fs = require('node:fs');
    const os = require('node:os');
    const crypto = require('node:crypto');
    const { Readable } = require('node:stream');
    const asar = require('@electron/asar');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rtl-cli-'));
    try {
        fs.mkdirSync(path.join(root, 'resources'));
        const archive = path.join(root, 'resources/app.asar');
        const files = { 'package.json': '{"version":"1.0.0"}', '.vite/build/index.js': 'const window = {webPreferences: {preload: ".vite/build/mainView.js"}};', '.vite/build/mainView.js': 'require("electron"); contextBridge;' };
        await asar.createPackageFromStreams(archive, Object.entries(files).map(([name, text]) => ({ path: name, type: 'file', stat: { size: Buffer.byteLength(text), mode: 0o644 }, streamGenerator: () => Readable.from([Buffer.from(text)]) })));
        fs.copyFileSync(process.execPath, path.join(root, 'claude-desktop'));
        fs.chmodSync(path.join(root, 'claude-desktop'), 0o755);
        const hash = crypto.createHash('sha256').update(fs.readFileSync(archive)).digest('hex');
        const diagnosis = spawnSync(process.execPath, [path.join(__dirname, '../index.js'), '--diagnose', '--path', root, '--json'], { encoding: 'utf8' });
        assert.equal(diagnosis.status, 0, diagnosis.stderr);
        assert.equal(JSON.parse(diagnosis.stdout).binaryVersion, null);
        const result = spawnSync(process.execPath, [path.join(__dirname, '../index.js'), '--full', '--path', root], { encoding: 'utf8' });
        assert.equal(result.status, 1);
        assert.match(result.stderr, /versions disagree/);
        assert.equal(crypto.createHash('sha256').update(fs.readFileSync(archive)).digest('hex'), hash);
        assert.equal(fs.existsSync(`${archive}.rtl-backups`), false);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('CLI help works without detecting or opening an installation', () => {
    const result = spawnSync(process.execPath, [path.join(__dirname, '../index.js'), '--help'], { encoding: 'utf8', env: { ...process.env, PATH: '' } });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /diagnose/);
    assert.match(result.stdout, /restore/);
});

test('mutation refuses to proceed without a verifiable application executable', async () => {
    const fs = require('node:fs');
    const os = require('node:os');
    const asar = require('@electron/asar');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ravan-no-executable-'));
    try {
        const source = path.join(root, 'source');
        fs.mkdirSync(path.join(source, '.vite/build'), { recursive: true });
        fs.mkdirSync(path.join(root, 'resources'));
        fs.writeFileSync(path.join(source, 'package.json'), '{"version":"1.0.0"}');
        fs.writeFileSync(path.join(source, '.vite/build/index.js'), 'const a = {webPreferences: {preload: path.join(app.getAppPath(), "mainView.js")}};');
        fs.writeFileSync(path.join(source, '.vite/build/mainView.js'), 'const {contextBridge} = require("electron");');
        const archive = path.join(root, 'resources/app.asar');
        await asar.createPackage(source, archive);
        const original = fs.readFileSync(archive);
        const result = spawnSync(process.execPath, [path.join(__dirname, '../index.js'), '--full', '--path', archive], { encoding: 'utf8' });
        assert.equal(result.status, 1);
        assert.match(result.stderr, /executable/i);
        assert.deepEqual(fs.readFileSync(archive), original);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('mutation rejects a script launcher whose running process cannot be reliably identified', async () => {
    const fs = require('node:fs');
    const os = require('node:os');
    const asar = require('@electron/asar');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ravan-wrapper-'));
    try {
        const source = path.join(root, 'source');
        fs.mkdirSync(path.join(source, '.vite/build'), { recursive: true });
        fs.mkdirSync(path.join(root, 'resources'));
        fs.writeFileSync(path.join(source, 'package.json'), '{"version":"1.0.0"}');
        fs.writeFileSync(path.join(source, '.vite/build/index.js'), 'const a = {webPreferences: {preload: path.join(app.getAppPath(), "mainView.js")}};');
        fs.writeFileSync(path.join(source, '.vite/build/mainView.js'), 'const {contextBridge} = require("electron");');
        const archive = path.join(root, 'resources/app.asar');
        await asar.createPackage(source, archive);
        const executable = path.join(root, 'launcher');
        fs.writeFileSync(executable, '#!/bin/sh\nprintf 1.0.0\n', { mode: 0o755 });
        const original = fs.readFileSync(archive);
        const result = spawnSync(process.execPath, [path.join(__dirname, '../index.js'), '--full', '--path', executable], { encoding: 'utf8' });
        assert.equal(result.status, 1);
        assert.match(result.stderr, /executable|wrapper/i);
        assert.deepEqual(fs.readFileSync(archive), original);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('mutation refuses a running nonstandard executable before querying its version', async () => {
    const fs = require('node:fs');
    const os = require('node:os');
    const { spawn } = require('node:child_process');
    const asar = require('@electron/asar');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ravan-running-'));
    let child;
    try {
        const source = path.join(root, 'source');
        fs.mkdirSync(path.join(source, '.vite/build'), { recursive: true });
        fs.mkdirSync(path.join(root, 'resources'));
        fs.writeFileSync(path.join(source, 'package.json'), JSON.stringify({ version: process.version }));
        fs.writeFileSync(path.join(source, '.vite/build/index.js'), 'const a = {webPreferences: {preload: path.join(app.getAppPath(), "mainView.js")}};');
        fs.writeFileSync(path.join(source, '.vite/build/mainView.js'), 'const {contextBridge} = require("electron");');
        const archive = path.join(root, 'resources/app.asar');
        await asar.createPackage(source, archive);
        const executable = path.join(root, 'CustomClaude');
        fs.copyFileSync(process.execPath, executable);
        fs.chmodSync(executable, 0o755);
        child = spawn(executable, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });
        await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
        const original = fs.readFileSync(archive);
        const result = spawnSync(process.execPath, [path.join(__dirname, '../index.js'), '--full', '--path', executable], { encoding: 'utf8' });
        assert.equal(result.status, 1);
        assert.match(result.stderr, /Quit Claude/);
        assert.deepEqual(fs.readFileSync(archive), original);
    } finally {
        if (child) { child.kill(); await new Promise(resolve => child.once('exit', resolve)); }
        fs.rmSync(root, { recursive: true, force: true });
    }
});
