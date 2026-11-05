const { CSS_INJECT_FULL, CSS_INJECT_FONT_ONLY } = require('./css');
const fontCss = require('../font');
const font = {
    base64: fontCss.match(/base64,([A-Za-z0-9+/=]+)/)[1],
    unicodeRange: fontCss.match(/unicode-range:\s*([^;]+)/)[1]
};

function directionFor(text) {
    const prose = text.replace(/(?:https?:\/\/|www\.)\S+|(?:\/?[\w.-]+\/)+[\w./?=#%-]+/g, '');
    const words = prose.match(/\p{Letter}+/gu) || [];
    if (/^(?:[A-Z]{2,}[A-Za-z]*|[A-Z][a-z]+[A-Z][A-Za-z]*)$/.test(words[0] || '')) words.shift();
    let rtl = 0, other = 0;
    for (const word of words) {
        if (/[\p{Script=Arabic}\p{Script=Hebrew}]/u.test(word)) rtl++;
        else other++;
    }
    return rtl > other || rtl === other && rtl > 0 && /^[\p{Script=Arabic}\p{Script=Hebrew}]/u.test(words[0]) ? 'rtl' : 'ltr';
}

function installRenderer(mode, directionFor, font) {
    if (globalThis.__claudeRtlPatch) return;
    const state = globalThis.__claudeRtlPatch = { mode, roots: new Set() };
    document.fonts.add(new FontFace('Vazirmatn', Uint8Array.from(atob(font.base64), char => char.charCodeAt(0)), {
        style: 'normal', weight: '400', display: 'swap', unicodeRange: font.unicodeRange
    }));
    const panels = '[data-cds="AskUserQuestion"], [data-ask-user-input-banner], [data-testid="ask-user-answers-card"], .epitaxy-question-receipt, ul[role="list"]:has(> li > .epitaxy-markdown-first-line)';
    const roots = `.font-claude-response, .font-user-message, .standard-markdown, .prose, [data-testid="user-message"], [data-message-author-role], .ProseMirror[contenteditable="true"], [contenteditable="true"][role="textbox"], textarea[data-testid="chat-input"], ${panels}, :is(${panels}) :is(textarea, input:not([type]), input[type="text"])`;
    const blocks = 'p, h1, h2, h3, h4, h5, h6, li, blockquote, td, th';
    const excluded = 'pre, code, kbd, samp, svg, math, .katex, .monaco-editor, .cm-editor, .epitaxy-markdown-first-line, .sr-only, [aria-hidden="true"], [class*="icon" i]';
    const pending = new Set();
    let scheduled = false;
    function proseText(element) {
        if (element.tagName === 'TEXTAREA' || element.tagName === 'INPUT') return element.value;
        const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
        let text = '', node;
        while ((node = walker.nextNode())) {
            if (node.parentElement.closest(excluded)) continue;
            const nestedList = node.parentElement.closest('ul, ol, table');
            if (!element.isContentEditable && nestedList && nestedList !== element && element.contains(nestedList)) continue;
            text += node.data;
        }
        return text;
    }
    function flush() {
        scheduled = false;
        for (const element of pending) {
            if (!element.isConnected || element.closest(excluded)) continue;
            if (!element.hasAttribute('data-rtl-text')) {
                const originalFont = getComputedStyle(element).fontFamily.replace(/^["']?Vazirmatn["']?,\s*/, '');
                element.style.setProperty('--rtl-original-font', originalFont);
                element.setAttribute('data-rtl-text', '');
            }
            if (mode === 'full') element.setAttribute('data-rtl-dir', directionFor(proseText(element)));
            for (const link of mode === 'full' && !element.isContentEditable ? element.querySelectorAll('a[href]') : []) {
                if (/^(?:https?:\/\/|www\.|\/|[A-Za-z]:\\)/.test(link.textContent.trim())) link.setAttribute('data-rtl-token', '');
            }
        }
        pending.clear();
        pruneRoots();
    }
    function pruneRoots() {
        for (const root of state.roots) {
            if (root.isConnected) continue;
            root.__rtlObserver.disconnect();
            state.roots.delete(root);
        }
    }
    function enqueue(element, root) {
        if (element.nodeType !== Node.ELEMENT_NODE) element = element.parentElement;
        if (!element || element.closest(excluded)) return;
        const block = element.closest(blocks);
        const composer = root.isContentEditable || root.matches('textarea, input');
        pending.add(!composer && block && root.contains(block) ? block : root);
        if (!composer) for (const child of element.querySelectorAll(blocks)) pending.add(child);
        if (root.matches(panels)) {
            pending.add(root);
            for (const control of root.querySelectorAll('button, label, legend')) pending.add(control);
            const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
            let node;
            while ((node = walker.nextNode())) {
                const parent = node.parentElement;
                if (/\p{Letter}/u.test(node.data) && !parent.isContentEditable && !parent.closest(excluded)) pending.add(parent);
            }
        }
        if (!scheduled) {
            scheduled = true;
            requestAnimationFrame(flush);
        }
    }
    function attach(root) {
        if (state.roots.has(root) || root.closest(excluded)) return;
        const originalFont = getComputedStyle(root).fontFamily;
        root.style.setProperty('--rtl-original-font', originalFont);
        root.setAttribute('data-rtl-prose', '');
        state.roots.add(root);
        enqueue(root, root);
        root.__rtlObserver = new MutationObserver(records => {
            for (const record of records) enqueue(record.target, root);
        });
        root.__rtlObserver.observe(root, { childList: true, characterData: true, subtree: true });
        root.addEventListener('input', () => enqueue(root, root));
    }
    function discover(element) {
        if (element.nodeType !== Node.ELEMENT_NODE) return;
        if (element.matches(roots)) attach(element);
        for (const root of element.querySelectorAll(roots)) attach(root);
    }
    function start() {
        discover(document.body);
        state.discovery = new MutationObserver(records => {
            for (const record of records) {
                for (const node of record.addedNodes) discover(node);
                const panel = record.target.closest(panels);
                if (panel) attach(panel);
            }
            if (records.some(record => record.removedNodes.length)) pruneRoots();
        });
        state.discovery.observe(document.body, { childList: true, subtree: true });
    }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
    else start();
}

function rendererScript(mode) {
    if (!['full', 'font-only'].includes(mode)) throw new Error('Choose full or font-only explicitly; native RTL is not version-verified.');
    return `(${installRenderer.toString()})(${JSON.stringify(mode)}, ${directionFor.toString()}, ${JSON.stringify(font)});`;
}

function buildPreload(mode) {
    const script = rendererScript(mode);
    const css = mode === 'full' ? CSS_INJECT_FULL : CSS_INJECT_FONT_ONLY;
    return `;(() => { if (process.isMainFrame && !globalThis.__claudeRtlPatch) { require('electron/renderer').webFrame.insertCSS(${JSON.stringify(css)}); ${script} } })();`;
}

module.exports = { directionFor, rendererScript, buildPreload };
