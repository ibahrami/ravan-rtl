const test = require('node:test');
const assert = require('node:assert/strict');
const fontCss = require('../font.js');
const { CSS_INJECT_FULL, CSS_INJECT_FONT_ONLY } = require('../lib/css');

test('embedded Persian font covers Arabic letters without replacing Latin glyphs', () => {
    assert.match(fontCss, /U\+0600-06FF/);
    assert.match(fontCss, /U\+200C/);
    assert.doesNotMatch(fontCss, /U\+0000/);
});

test('font-only stylesheet leaves native direction and bidi rules unchanged', () => {
    assert.doesNotMatch(CSS_INJECT_FONT_ONLY, /(?:direction|unicode-bidi|text-align)\s*:/);
});

test('full stylesheet scopes direction rules to runtime-classified prose', () => {
    assert.match(CSS_INJECT_FULL, /\[data-rtl-dir="rtl"\]/);
    assert.doesNotMatch(CSS_INJECT_FULL, /(?:^|\n)\s*(?:\*|div|span|p,|input)[\s:{]/);
});
