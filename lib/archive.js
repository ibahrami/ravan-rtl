const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn, execFileSync } = require('node:child_process');
const asar = require('@electron/asar');
const { Pickle } = require(path.join(path.dirname(require.resolve('@electron/asar')), 'pickle.js'));

const START = '/* CLAUDE_RTL_PATCH_START */';
const END = '/* CLAUDE_RTL_PATCH_END */';
const MODES = new Set(['full', 'font-only']);
const HASH = /^[a-f0-9]{64}$/;
const MARKER = /CLAUDE_RTL_|\/\*\s*CLAUDE[ -]RTL\b|Injected for Persian\/Arabic\/Hebrew support|(?:RTL and Vazirmatn Font|Vazirmatn Font) Patch/i;

function exists(file) {
    try { return fs.lstatSync(file); } catch (error) {
        if (error.code === 'ENOENT') return null;
        throw error;
    }
}

function regularFile(file) {
    const stat = fs.lstatSync(file);
    if (!stat.isFile()) throw new Error(`Expected a regular file, not a symlink: ${file}`);
    return stat;
}

function digest({ file, start = 0, size = fs.statSync(file).size }, blockSize = 1024 * 1024) {
    if (!Number.isSafeInteger(blockSize) || blockSize <= 0 || blockSize > 16 * 1024 * 1024) throw new Error('Unsupported integrity block size');
    const fd = fs.openSync(file, 'r');
    const hash = crypto.createHash('sha256');
    const blocks = [];
    const buffer = Buffer.alloc(Math.min(blockSize, size || 1));
    try {
        for (let offset = 0; offset < size;) {
            const length = Math.min(buffer.length, size - offset);
            let read = 0;
            while (read < length) {
                const count = fs.readSync(fd, buffer, read, length - read, start + offset + read);
                if (!count) throw new Error(`Truncated archive or file: ${file}`);
                read += count;
            }
            const bytes = buffer.subarray(0, length);
            hash.update(bytes);
            blocks.push(crypto.createHash('sha256').update(bytes).digest('hex'));
            offset += length;
        }
        if (!size) blocks.push(crypto.createHash('sha256').digest('hex'));
        return { hash: hash.digest('hex'), blocks };
    } finally {
        fs.closeSync(fd);
    }
}

const sha256 = file => digest({ file }).hash;
const textHash = text => crypto.createHash('sha256').update(text).digest('hex');
const safeVersion = version => version.replace(/[^a-zA-Z0-9._-]/g, '-').replace(/^\.+/, '-').slice(0, 100) || 'unknown';
const backupDirectory = (file, version, hash) => `${file}.rtl-backups/${safeVersion(version)}-${hash}`;

function safePath(name) {
    return typeof name === 'string' && name.length && !name.includes('\\') && !name.includes('\0') &&
        !path.posix.isAbsolute(name) && name.split('/').every(part => part && part !== '.' && part !== '..');
}

function readArchive(file, unpackedRoot = `${file}.unpacked`) {
    regularFile(file);
    const { header, headerSize } = asar.getRawHeader(file);
    if (!header.files || Object.keys(header).some(key => key !== 'files')) throw new Error('Unsupported archive header/signature metadata');
    const entries = new Map();
    const dataOffset = 8 + headerSize;
    const archiveSize = fs.statSync(file).size;
    function walk(node, prefix = '') {
        for (const [name, entry] of Object.entries(node.files)) {
            const filename = prefix + name;
            if (!safePath(name) || name.includes('/') || !entry || typeof entry !== 'object') throw new Error('Unsafe ASAR entry path');
            if (Object.keys(entry).some(key => !['files', 'link', 'size', 'offset', 'unpacked', 'executable', 'integrity'].includes(key))) throw new Error(`Unsupported ASAR metadata: ${filename}`);
            if (entry.unpacked !== undefined && typeof entry.unpacked !== 'boolean') throw new Error('Invalid unpacked flag');
            if (entry.executable !== undefined && typeof entry.executable !== 'boolean') throw new Error('Invalid executable flag');
            if (entry.link !== undefined) {
                if (!safePath(entry.link) || entry.files || entry.size !== undefined) throw new Error('Unsafe ASAR link');
            } else if (entry.files) {
                if (entry.size !== undefined) throw new Error('Invalid ASAR directory');
            } else {
                if (!Number.isSafeInteger(entry.size) || entry.size < 0) throw new Error('Invalid ASAR file size');
                if (!entry.unpacked && (!/^\d+$/.test(entry.offset) || !Number.isSafeInteger(Number(entry.offset)) || dataOffset + Number(entry.offset) + entry.size > archiveSize)) throw new Error('Invalid ASAR file range');
            }
            entries.set(filename, entry);
            if (entry.files) walk(entry, `${filename}/`);
        }
    }
    walk(header);
    return { file, header, entries, dataOffset, unpackedRoot };
}

function sourceFor(archive, name) {
    const entry = archive.entries.get(name);
    if (!entry || entry.files || entry.link !== undefined) throw new Error(`Expected archive file: ${name}`);
    if (entry.unpacked) {
        const file = path.join(archive.unpackedRoot, name);
        const stat = regularFile(file);
        const root = fs.realpathSync(archive.unpackedRoot) + path.sep;
        if (!fs.realpathSync(file).startsWith(root) || stat.size !== entry.size) throw new Error(`Unpacked file identity/size mismatch: ${name}`);
        return { file, size: entry.size };
    }
    return { file: archive.file, start: archive.dataOffset + Number(entry.offset), size: entry.size };
}

function contents(archive, name) {
    const source = sourceFor(archive, name);
    const buffer = Buffer.alloc(source.size);
    const fd = fs.openSync(source.file, 'r');
    try {
        let offset = 0;
        while (offset < buffer.length) {
            const read = fs.readSync(fd, buffer, offset, buffer.length - offset, (source.start || 0) + offset);
            if (!read) throw new Error(`Truncated archive file: ${name}`);
            offset += read;
        }
        return buffer;
    } finally { fs.closeSync(fd); }
}

function inspect(file) {
    const archive = readArchive(file);
    const version = JSON.parse(contents(archive, 'package.json').toString('utf8')).version;
    if (typeof version !== 'string' || !version || version.length > 200) throw new Error('Archive package.json has no valid version');
    const indexes = [...archive.entries].filter(([name, node]) => /^\.vite\/build\/index[^/]*\.js$/.test(name) && !node.files && node.link === undefined)
        .map(([name]) => contents(archive, name).toString('utf8'));
    const targets = [];
    let marked = false;
    for (const [name, entry] of archive.entries) {
        if (/^\.vite\/(?:build|renderer)\/.*\.(?:js|css)$/.test(name) && !entry.files && entry.link === undefined) {
            marked ||= MARKER.test(contents(archive, name).toString('utf8'));
        }
    }
    for (const basename of ['mainView.js', 'mainWindow.js']) {
        const name = `.vite/build/${basename}`;
        const entry = archive.entries.get(name);
        if (!entry || entry.files || entry.link !== undefined) continue;
        const text = contents(archive, name).toString('utf8');
        marked ||= MARKER.test(text);
        const reference = new RegExp(`\\bwebPreferences\\s*:\\s*\\{[^{}]{0,800}\\bpreload\\s*:\\s*(?:[\\w$.]+\\.join\\(\\s*(?:[\\w$.]+\\.getAppPath\\(\\)|__dirname)\\s*,\\s*)?["'](?:\\.vite/build/)?${basename.replace('.', '\\.')}["']`);
        if (/require\s*\(\s*['"]electron(?:\/renderer)?['"]\s*\)/.test(text) && /\bcontextBridge\b/.test(text) && indexes.some(index => reference.test(index))) targets.push(name);
    }
    if (!targets.includes('.vite/build/mainView.js')) throw new Error('No supported referenced content preload found (mainView.js required)');
    return { archive, version, targets, marked, sha256: sha256(file) };
}

function knownPayload(archive, targets, record) {
    for (const name of targets) {
        const text = contents(archive, name).toString('utf8');
        const start = `\n${START}\n`, end = `\n${END}\n`;
        const offset = text.indexOf(start);
        if (offset < 0 || !text.endsWith(end) || MARKER.test(text.slice(0, offset))) return false;
        const payload = text.slice(offset + start.length, -end.length);
        if (MARKER.test(payload) || textHash(payload) !== record.payloadSha256) return false;
    }
    return targets.length > 0;
}

function validateIntegrity(archive) {
    for (const [name, node] of archive.entries) {
        if (node.files || node.link !== undefined || !node.integrity) continue;
        const actual = digest(sourceFor(archive, name), node.integrity.blockSize);
        if (node.integrity.algorithm !== 'SHA256' || node.integrity.hash !== actual.hash || JSON.stringify(node.integrity.blocks) !== JSON.stringify(actual.blocks)) throw new Error(`Original archive/unpacked file integrity mismatch: ${name}`);
    }
}

function treeSnapshot(root) {
    const stat = exists(root);
    if (!stat) return null;
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Unpacked root must be a real directory');
    const result = [];
    function walk(file, name) {
        const stat = fs.lstatSync(file);
        const item = { path: name, mode: stat.mode & 0o7777, uid: stat.uid, gid: stat.gid };
        if (stat.isSymbolicLink()) {
            item.type = 'link';
            item.link = fs.readlinkSync(file);
            const resolved = path.resolve(path.dirname(file), item.link);
            if (!resolved.startsWith(path.resolve(root) + path.sep)) throw new Error(`Unsafe unpacked link: ${name}`);
        } else if (stat.isDirectory()) item.type = 'directory';
        else if (stat.isFile()) { item.type = 'file'; item.sha256 = sha256(file); }
        else throw new Error(`Unsupported unpacked file type: ${name}`);
        result.push(item);
        if (item.type === 'directory') {
            for (const child of fs.readdirSync(file).sort()) walk(path.join(file, child), name ? `${name}/${child}` : child);
        }
    }
    walk(root, '');
    return result;
}

function sameTree(expected, root) {
    if (JSON.stringify(treeSnapshot(root)) !== JSON.stringify(expected)) throw new Error('Unpacked tree identity has changed; refusing to replace archive');
}

function directory(file, create = false, owner, mode = 0o755) {
    if (create && !exists(file)) {
        fs.mkdirSync(file, { mode: 0o700 });
        syncFile(path.dirname(file));
    }
    const stat = fs.lstatSync(file);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`Backup directory must not be a symlink: ${file}`);
    if (owner) {
        fs.chownSync(file, owner.uid, owner.gid);
        fs.chmodSync(file, mode);
    }
}

function readManifest(dir, sourcePath) {
    directory(dir);
    const filename = path.join(dir, 'manifest.json');
    regularFile(filename);
    const manifest = JSON.parse(fs.readFileSync(filename, 'utf8'));
    if (manifest.schema !== 1 || manifest.sourcePath !== sourcePath || typeof manifest.originalVersion !== 'string' || !HASH.test(manifest.originalSha256) ||
        dir !== backupDirectory(sourcePath, manifest.originalVersion, manifest.originalSha256) || !Array.isArray(manifest.targets) ||
        manifest.targets.some(name => !['.vite/build/mainView.js', '.vite/build/mainWindow.js'].includes(name)) || !Object.hasOwn(manifest, 'unpacked')) throw new Error('Invalid backup manifest identity');
    for (const record of [manifest.current, manifest.pending]) {
        if (record !== null && (!record || !HASH.test(record.sha256) ||
            !(MODES.has(record.mode) && HASH.test(record.payloadSha256) || record.sha256 === manifest.originalSha256 && record.mode === null && record.payloadSha256 === null))) throw new Error('Invalid backup manifest patch record');
    }
    return manifest;
}

function state(file) {
    const info = inspect(file);
    const exact = backupDirectory(file, info.version, info.sha256);
    const root = `${file}.rtl-backups`;
    let match = null;
    if (exists(root)) {
        directory(root);
        for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
            if (!entry.isDirectory()) continue;
            const dir = path.join(root, entry.name);
            let manifest;
            try { manifest = readManifest(dir, file); } catch (error) {
                if (dir === exact && exists(path.join(dir, 'manifest.json'))) throw error;
                continue;
            }
            if (manifest.originalVersion !== info.version) continue;
            const record = [manifest.pending, manifest.current].find(record => record && record.mode !== null && record.sha256 === info.sha256);
            if (record && info.marked && knownPayload(info.archive, info.targets, record)) {
                if (match) throw new Error('Ambiguous matching backup manifests');
                match = { dir, manifest, record };
            }
        }
    }
    const diagnosis = {
        version: info.version, sha256: info.sha256, targets: info.targets,
        status: match ? 'patched' : info.marked ? 'unmanaged-patch' : 'original',
        mode: match ? match.record.mode : null, backupDirectory: match ? match.dir : exact,
    };
    return { ...info, match, diagnosis };
}

function diagnose(asarPath) {
    return state(path.resolve(asarPath)).diagnosis;
}

function securityGuard(file) {
    if (process.platform !== 'linux') throw new Error('Only Linux archives are supported; signed bundles are not supported');
    if (/(?:^|\/)\w[^/]*\.app\/Contents\//.test(file)) throw new Error('Signed application bundles are not supported');
    const resources = path.dirname(file);
    for (const name of fs.readdirSync(resources)) {
        if (name.startsWith(path.basename(file)) && /\.(?:sig|asc|signature|integrity|sha256)$/i.test(name)) throw new Error('External archive signature/integrity mechanism is not supported');
    }
    for (const name of [path.join(resources, '_CodeSignature'), path.join(resources, '..', '_CodeSignature'), path.join(resources, '..', 'Info.plist'), path.join(resources, 'AppxSignature.p7x')]) {
        if (exists(name)) throw new Error('External signed archive/bundle mechanism is not supported');
    }
    // Linux Electron may embed an archive-header hash in its adjacent executable.
    const headerHash = textHash(asar.getRawHeader(file).headerString);
    const needles = [Buffer.from(headerHash), Buffer.from(headerHash, 'hex'), Buffer.from('ElectronAsarIntegrity')];
    for (const entry of fs.readdirSync(path.dirname(resources), { withFileTypes: true })) {
        if (!entry.isFile()) continue;
        const candidate = path.join(resources, '..', entry.name);
        const stat = fs.statSync(candidate);
        if (!(stat.mode & 0o111)) continue;
        const fd = fs.openSync(candidate, 'r');
        try {
            const buffer = Buffer.alloc(1024 * 1024);
            let previous = Buffer.alloc(0);
            for (let read; (read = fs.readSync(fd, buffer, 0, buffer.length, null));) {
                const bytes = Buffer.concat([previous, buffer.subarray(0, read)]);
                if (needles.some(needle => bytes.includes(needle))) throw new Error('Externally embedded archive integrity/signature is not supported');
                previous = Buffer.from(bytes.subarray(Math.max(0, bytes.length - 128)));
            }
        } finally { fs.closeSync(fd); }
    }
}

const ATTRIBUTE_SCRIPT = `
import os, sys, json, base64
source = sys.argv[1]
attrs = {name: os.getxattr(source, name, follow_symlinks=False) for name in sorted(os.listxattr(source, follow_symlinks=False))}
if len(sys.argv) > 2:
    destination = sys.argv[2]
    for name in os.listxattr(destination, follow_symlinks=False):
        if name not in attrs: os.removexattr(destination, name, follow_symlinks=False)
    for name, value in attrs.items(): os.setxattr(destination, name, value, follow_symlinks=False)
    actual = {name: os.getxattr(destination, name, follow_symlinks=False) for name in os.listxattr(destination, follow_symlinks=False)}
    if actual != attrs: raise RuntimeError('Filesystem attributes were not preserved')
print(json.dumps({name: base64.b64encode(value).decode() for name, value in attrs.items()}, sort_keys=True))
`;

function attributes(file, destination) {
    return execFileSync('/usr/bin/python3', ['-I', '-c', ATTRIBUTE_SCRIPT, file, ...(destination ? [destination] : [])], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function syncFile(file) {
    const fd = fs.openSync(file, 'r');
    try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

function saveManifest(dir, manifest, stage) {
    const temporary = path.join(stage, 'manifest-next.json');
    fs.writeFileSync(temporary, JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    const owner = regularFile(path.join(dir, 'app.asar'));
    fs.chownSync(temporary, owner.uid, owner.gid);
    fs.chmodSync(temporary, (owner.mode & 0o444) | 0o200);
    syncFile(temporary);
    fs.renameSync(temporary, path.join(dir, 'manifest.json'));
    syncFile(dir);
}

function validateBackup(dir, manifest, installed) {
    const backup = path.join(dir, 'app.asar');
    regularFile(backup);
    if (sha256(backup) !== manifest.originalSha256) throw new Error('Pristine backup hash mismatch');
    sameTree(manifest.unpacked, `${installed}.unpacked`);
    const archive = readArchive(backup, `${installed}.unpacked`);
    const version = JSON.parse(contents(archive, 'package.json')).version;
    if (version !== manifest.originalVersion) throw new Error('Backup version mismatch');
    for (const name of manifest.targets) {
        if (MARKER.test(contents(archive, name).toString('utf8'))) throw new Error('Backup contains an unrecognized patch marker');
    }
    validateIntegrity(archive);
    return archive;
}

// An empty child cwd avoids ASAR's small-file integrity fast path reading unrelated cwd files.
const PACK = `
const fs = require('node:fs');
const { Readable } = require('node:stream');
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', data => input += data);
process.stdin.on('end', async () => {
    try {
        const { destination, entries } = JSON.parse(input);
        for (const entry of entries) {
            entry.streamGenerator = () => entry.bytes !== undefined ? Readable.from([Buffer.from(entry.bytes, 'base64')]) :
                !entry.stat.size ? Readable.from([]) : fs.createReadStream(entry.source.file, { start: entry.source.start || 0, end: (entry.source.start || 0) + entry.stat.size - 1 });
        }
        await require(process.argv[1]).createPackageFromStreams(destination, entries);
    } catch (error) { console.error(error.stack); process.exitCode = 1; }
});`;

async function pack(archive, destination, changes, stage) {
    const entries = [];
    for (const [name, node] of archive.entries) {
        const entry = { path: name, unpacked: node.unpacked, stat: { mode: node.executable ? 0o755 : 0o644, size: node.size || 0 } };
        if (node.files) entry.type = 'directory';
        else if (node.link !== undefined) {
            entry.type = 'link';
            entry.symlink = path.posix.relative(path.posix.dirname(name), node.link) || '.';
            if (node.unpacked) {
                entry.symlink = fs.readlinkSync(path.join(archive.unpackedRoot, name));
                if (path.posix.normalize(path.posix.join(path.posix.dirname(name), entry.symlink)) !== node.link) throw new Error('Unpacked link does not match archive header');
            }
        } else {
            entry.type = 'file';
            entry.source = sourceFor(archive, name);
            if (node.unpacked) entry.stat.mode = fs.statSync(entry.source.file).mode;
            if (changes.has(name)) { entry.bytes = changes.get(name).toString('base64'); entry.stat.size = changes.get(name).length; }
        }
        entries.push(entry);
    }
    const cwd = path.join(stage, 'empty');
    fs.mkdirSync(cwd);
    await new Promise((resolve, reject) => {
        const child = spawn(process.execPath, ['-e', PACK, require.resolve('@electron/asar')], { cwd, stdio: ['pipe', 'ignore', 'pipe'] });
        let stderr = '';
        child.stderr.on('data', data => { stderr = (stderr + data).slice(-8192); });
        child.on('error', reject);
        child.stdin.on('error', reject);
        child.on('close', code => code === 0 ? resolve() : reject(new Error(`ASAR staging failed (${code}): ${stderr}`)));
        child.stdin.end(JSON.stringify({ destination, entries }));
    });
    preserveFlags(archive, destination, stage);
}

function preserveFlags(original, destination, stage) {
    const generated = readArchive(destination);
    let changed = false;
    for (const [name, node] of original.entries) {
        const output = generated.entries.get(name);
        if (!output) throw new Error(`Missing staged archive entry: ${name}`);
        for (const flag of ['unpacked', 'executable']) {
            if (output[flag] !== node[flag]) {
                changed = true;
                if (node[flag] === undefined) delete output[flag]; else output[flag] = node[flag];
            }
        }
    }
    if (!changed) return;
    const pickle = Pickle.createEmpty();
    pickle.writeString(JSON.stringify(generated.header));
    const header = pickle.toBuffer();
    const size = Pickle.createEmpty();
    size.writeUInt32(header.length);
    const corrected = path.join(stage, 'header-corrected.asar');
    const output = fs.openSync(corrected, 'wx', 0o600);
    const input = fs.openSync(destination, 'r');
    try {
        fs.writeFileSync(output, Buffer.concat([size.toBuffer(), header]));
        const buffer = Buffer.alloc(1024 * 1024);
        let offset = generated.dataOffset;
        for (let read; (read = fs.readSync(input, buffer, 0, buffer.length, offset));) {
            fs.writeFileSync(output, buffer.subarray(0, read));
            offset += read;
        }
    } finally { fs.closeSync(input); fs.closeSync(output); }
    fs.renameSync(corrected, destination);
}

function validateStage(original, destination, changes) {
    const staged = readArchive(destination);
    if (JSON.stringify([...staged.entries.keys()]) !== JSON.stringify([...original.entries.keys()])) throw new Error('Staged archive entry set changed');
    for (const [name, node] of original.entries) {
        const next = staged.entries.get(name);
        if (!!node.files !== !!next.files || node.link !== next.link || node.unpacked !== next.unpacked || node.executable !== next.executable) throw new Error(`Staged metadata mismatch: ${name}`);
        if (node.files || node.link !== undefined) continue;
        const bytes = changes.get(name);
        const expected = bytes ? textHash(bytes) : digest(sourceFor(original, name)).hash;
        const actual = digest(sourceFor(staged, name), next.integrity?.blockSize);
        if (actual.hash !== expected || next.size !== (bytes ? bytes.length : node.size)) throw new Error(`Staged file bytes mismatch: ${name}`);
        if (next.integrity?.algorithm !== 'SHA256' || next.integrity.hash !== actual.hash || JSON.stringify(next.integrity.blocks) !== JSON.stringify(actual.blocks)) throw new Error(`Staged integrity mismatch: ${name}`);
        if (node.unpacked) {
            const before = fs.statSync(sourceFor(original, name).file);
            const after = fs.statSync(sourceFor(staged, name).file);
            if ((before.mode & 0o111) !== (after.mode & 0o111)) throw new Error(`Staged unpacked executable mode mismatch: ${name}`);
        }
    }
}

async function mutate(asarPath, options, restoring) {
    const file = path.resolve(asarPath);
    if (!restoring && (!options || !MODES.has(options.mode) || typeof options.payload !== 'string' || !options.payload.trim() || MARKER.test(options.payload))) throw new Error('A valid mode and nonempty payload without patch markers are required');
    securityGuard(file);
    regularFile(file);
    const originalAttributes = attributes(file);
    const lockPath = `${file}.rtl-lock`;
    const lock = fs.openSync(lockPath, 'wx', 0o600);
    const lockIdentity = fs.fstatSync(lock);
    let stage;
    let committed = false;
    try {
        const initial = state(file);
        if (initial.diagnosis.status === 'unmanaged-patch') throw new Error('Unmanaged/unrecognized patch; refusing mutation without a matching manifest');
        if (restoring && !initial.match) throw new Error('Current archive does not match a recorded managed patched build');
        const originalStat = regularFile(file);
        let dir, manifest, original;
        if (initial.match) {
            ({ dir, manifest } = initial.match);
            if (initial.version !== manifest.originalVersion) throw new Error('Current archive version differs from originalVersion');
            original = validateBackup(dir, manifest, file);
            if (JSON.stringify(initial.targets) !== JSON.stringify(manifest.targets)) throw new Error('Managed preload target identity changed');
            for (const name of manifest.targets) {
                const prefix = Buffer.concat([contents(original, name), Buffer.from(`\n${START}\n`)]);
                if (!contents(initial.archive, name).subarray(0, prefix.length).equals(prefix)) throw new Error('Unrecognized managed preload prefix; refusing mutation');
            }
            if (!restoring && initial.match.record.mode === options.mode && initial.match.record.payloadSha256 === textHash(options.payload)) return initial.diagnosis;
        } else {
            validateIntegrity(initial.archive);
            dir = initial.diagnosis.backupDirectory;
            const readable = originalStat.mode & 0o444;
            directory(`${file}.rtl-backups`, true, originalStat);
            directory(dir, true, originalStat, readable | (readable >> 2) | 0o200);
            const backup = path.join(dir, 'app.asar');
            try { fs.copyFileSync(file, backup, fs.constants.COPYFILE_EXCL); syncFile(backup); syncFile(dir); } catch (error) { if (error.code !== 'EEXIST') throw error; }
            regularFile(backup);
            fs.chownSync(backup, originalStat.uid, originalStat.gid);
            fs.chmodSync(backup, originalStat.mode & 0o7777);
            if (sha256(backup) !== initial.sha256) throw new Error('Pristine backup hash mismatch');
            manifest = exists(path.join(dir, 'manifest.json')) ? readManifest(dir, file) : {
                schema: 1, sourcePath: file, originalVersion: initial.version, originalSha256: initial.sha256,
                targets: initial.targets, unpacked: treeSnapshot(`${file}.unpacked`), current: null, pending: null,
            };
            original = validateBackup(dir, manifest, file);
        }
        for (const target of manifest.targets) {
            if (original.entries.get(target)?.unpacked) throw new Error('Unpacked preloads cannot be patched without modifying the installed unpacked tree');
        }
        stage = fs.mkdtempSync(`${file}.rtl-stage-`);
        if (!exists(path.join(dir, 'manifest.json'))) saveManifest(dir, manifest, stage);
        const destination = path.join(stage, 'app.asar');
        let record;
        if (restoring) {
            fs.copyFileSync(path.join(dir, 'app.asar'), destination, fs.constants.COPYFILE_EXCL);
            if (sha256(destination) !== manifest.originalSha256) throw new Error('Restore staging backup hash mismatch');
            record = { sha256: manifest.originalSha256, mode: null, payloadSha256: null };
        } else {
            const changes = new Map(manifest.targets.map(name => [name, Buffer.concat([contents(original, name), Buffer.from(`\n${START}\n${options.payload}\n${END}\n`)])]));
            await pack(original, destination, changes, stage);
            validateStage(original, destination, changes);
            record = { sha256: sha256(destination), mode: options.mode, payloadSha256: textHash(options.payload) };
        }
        fs.chownSync(destination, originalStat.uid, originalStat.gid);
        fs.chmodSync(destination, originalStat.mode & 0o7777);
        if (attributes(file, destination) !== originalAttributes) throw new Error('Filesystem attributes changed during staging');
        syncFile(destination);
        manifest.pending = record;
        saveManifest(dir, manifest, stage);
        validateBackup(dir, manifest, file);
        securityGuard(file);
        const current = regularFile(file);
        if (current.uid !== originalStat.uid || current.gid !== originalStat.gid || current.mode !== originalStat.mode || sha256(file) !== initial.sha256) throw new Error('Installed archive changed during staging; refusing replacement');
        if (attributes(file) !== originalAttributes) throw new Error('Filesystem attributes changed before replacement');
        fs.renameSync(destination, file);
        committed = true;
        syncFile(path.dirname(file));
        manifest.current = restoring ? null : record;
        manifest.pending = null;
        saveManifest(dir, manifest, stage);
        return diagnose(file);
    } catch (error) {
        if (committed) error.message = `Archive replacement committed; its prepared manifest permits recovery. ${error.message}`;
        throw error;
    } finally {
        try { if (stage) fs.rmSync(stage, { recursive: true, force: true }); } finally {
            fs.closeSync(lock);
            const currentLock = exists(lockPath);
            if (currentLock && currentLock.ino === lockIdentity.ino && currentLock.dev === lockIdentity.dev) fs.unlinkSync(lockPath);
        }
    }
}

async function applyPatch(asarPath, options) { return mutate(asarPath, options, false); }
async function restore(asarPath) { return mutate(asarPath, null, true); }

module.exports = { diagnose, applyPatch, restore };
