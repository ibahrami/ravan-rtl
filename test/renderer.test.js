const test = require('node:test');
const assert = require('node:assert/strict');
const { directionFor, buildPreload } = require('../lib/renderer');
const vm = require('node:vm');

test('sandboxed Electron insertCSS returns a synchronous key and initialization still runs exactly once', () => {
    let insertions = 0, readyListeners = 0;
    let fonts = 0;
    const context = vm.createContext({ process: { isMainFrame: true }, atob,
        FontFace: class { constructor(name, bytes, descriptors) {
            assert.equal(name, 'Vazirmatn');
            assert.equal(Buffer.from(bytes).subarray(0, 4).toString(), 'wOF2');
            assert.match(descriptors.unicodeRange, /U\+0600-06FF/);
        } },
        document: { readyState: 'loading', addEventListener: () => readyListeners++, fonts: { add: () => fonts++ } },
        require: name => { assert.equal(name, 'electron/renderer'); return { webFrame: { insertCSS: css => { assert.match(css, /\[data-rtl-prose\]/); insertions++; return 'stylesheet-key'; } } }; }
    });
    vm.runInContext(buildPreload('full'), context);
    vm.runInContext(buildPreload('full'), context);
    assert.equal(context.__claudeRtlPatch.mode, 'full');
    assert.equal(insertions, 1);
    assert.equal(fonts, 1);
    assert.equal(readyListeners, 1);
});

test('direction uses predominant strong letters, not the first English word', () => {
    for (const text of ['سلام دنیا', 'API خوب', 'OpenAI چیست؟', 'JavaScript خوب است', 'API برای آزمایش متن فارسی است', 'این مسیر /tmp/demo.js است', '123 سلام']) {
        assert.equal(directionFor(text), 'rtl', text);
    }
    for (const text of ['English with سلام', 'const result = 42;', 'https://example.test/path', '123']) {
        assert.equal(directionFor(text), 'ltr', text);
    }
});
