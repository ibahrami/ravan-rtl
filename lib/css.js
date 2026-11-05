const FONT_STYLE = `
[data-rtl-prose], [data-rtl-text] {
    font-family: 'Vazirmatn', var(--rtl-original-font, system-ui) !important;
}
[data-rtl-prose][contenteditable] :is(p, h1, h2, h3, h4, h5, h6, li, blockquote) {
    font-family: inherit !important;
}
[data-rtl-prose] :is(pre, code, kbd, samp, .monaco-editor, .cm-editor) {
    font-family: var(--font-mono, ui-monospace), monospace;
}
`;

const CSS_INJECT_FONT_ONLY = FONT_STYLE;
const CSS_INJECT_FULL = `${FONT_STYLE}
[data-rtl-dir="rtl"] { direction: rtl !important; text-align: start !important; unicode-bidi: isolate !important; }
[data-rtl-dir="ltr"] { direction: ltr !important; text-align: start !important; unicode-bidi: isolate !important; }
[data-rtl-prose][contenteditable] :is(p, h1, h2, h3, h4, h5, h6, li, blockquote) {
    direction: inherit !important;
    text-align: inherit !important;
}
[data-rtl-prose] :is(pre, code, kbd, samp, .katex, math, .monaco-editor, .cm-editor, [data-rtl-token]) {
    direction: ltr !important;
    unicode-bidi: isolate !important;
    text-align: start;
}
[data-rtl-prose] :is(ul, ol) { padding-inline-start: 1.5em; padding-inline-end: 0; }
`;

module.exports = { CSS_INJECT_FULL, CSS_INJECT_FONT_ONLY };
