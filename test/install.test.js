const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const asar = require('@electron/asar');

const installer = path.join(__dirname, '../install.sh');
test('installer diagnoses and safely patches and restores a writable installation', async t => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ravan installer '));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const bin = path.join(dir, 'bin');
    const source = path.join(dir, 'source');
    const app = path.join(dir, 'application', 'resources', 'app.asar');
    fs.mkdirSync(bin); fs.mkdirSync(source); fs.mkdirSync(path.dirname(app), { recursive: true });
    fs.writeFileSync(path.join(bin, 'npm'), '#!/bin/sh\ncase " $* " in *" ci "*) exit 99;; esac\nexit 0\n', { mode: 0o755 });
    fs.symlinkSync(process.execPath, path.join(bin, 'node'));
    fs.mkdirSync(path.join(source, '.vite/build'), { recursive: true });
    fs.writeFileSync(path.join(source, 'package.json'), JSON.stringify({ version: process.version }));
    fs.writeFileSync(path.join(source, '.vite/build/index.js'), 'const a = {webPreferences: {preload: path.join(app.getAppPath(), "mainView.js")}};');
    fs.writeFileSync(path.join(source, '.vite/build/mainView.js'), 'const {contextBridge} = require("electron");');
    await asar.createPackage(source, app);
    const executable = path.join(dir, 'application/CustomClaude');
    fs.copyFileSync(process.execPath, executable);
    fs.chmodSync(executable, 0o755);
    const original = fs.readFileSync(app);
    const run = (...args) => spawnSync('bash', [installer, ...args], { encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } });
    const patched = run('--path', executable);
    assert.equal(patched.status, 0, patched.stderr + patched.stdout);
    assert.match(patched.stdout, /patched/i);
    assert.notDeepEqual(fs.readFileSync(app), original);
    const restored = run('--restore', '--path', executable);
    assert.equal(restored.status, 0, restored.stderr + restored.stdout);
    assert.deepEqual(fs.readFileSync(app), original);
});

test('installer help does not require dependencies or change an installation', () => {
    const result = spawnSync('bash', [installer, '--help'], { encoding: 'utf8', env: { ...process.env, PATH: '/usr/bin:/bin' } });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /restore/);
});
