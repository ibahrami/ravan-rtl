const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { pathToFileURL } = require('node:url');
const { rendererScript } = require('../lib/renderer');
const { CSS_INJECT_FULL, CSS_INJECT_FONT_ONLY } = require('../lib/css');

const driver = process.env.RTL_BROWSER_DRIVER;
test('real Chromium: self-only font CSP, mixed prose, streaming, selection, fonts and scoped isolation', { skip: !driver && 'Set RTL_BROWSER_DRIVER and RTL_BROWSER_EXECUTABLE to run real-browser tests' }, async t => {
    const { puppeteer } = await import(pathToFileURL(driver).href);
    const server = http.createServer((request, response) => {
        response.setHeader('Content-Security-Policy', "font-src 'self'");
        response.end('<!doctype html><html><body><main></main></body></html>');
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const browser = await puppeteer.launch({ executablePath: process.env.RTL_BROWSER_EXECUTABLE, headless: true });
    t.after(async () => { await browser.close(); await new Promise(resolve => server.close(resolve)); });
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.setContent(`<main>
        <p id="outside">سلام بیرون از پیام</p><span id="icon" style="font-family:monospace">X</span>
        <div class="font-user-message"><div id="bubble">API برای آزمایش متن فارسی است</div></div>
        <div class="standard-markdown" style="font-family:Arial">
          <h2 id="heading" style="font-family:serif">عنوان فارسی</h2><p id="mixed">API برای آزمایش متن فارسی است <code>/tmp/demo.js</code> و <a href="https://example.test/a">https://example.test/a</a></p>
          <p id="english">English text with سلام</p>
          <ol><li id="item">فهرست فارسی<ul><li>زیرمجموعه فارسی</li></ul></li></ol>
          <blockquote id="quote">نقل قول فارسی</blockquote>
          <table><tr><th id="headcell">نام فارسی</th><td id="cell">خانه فارسی</td></tr></table>
          <pre><code id="code">const x = "سلام";</code></pre><span class="katex" id="math">x = y + 2</span>
          <p id="stream">API</p>
        </div>
        <div contenteditable="true" class="ProseMirror" role="textbox"><p dir="auto" id="composer">API برای آزمایش متن فارسی است</p></div>
        </main>`);
    const original = await page.$eval('main', node => node.textContent);
    await page.addStyleTag({ content: CSS_INJECT_FULL });
    await page.addScriptTag({ content: rendererScript('full') });
    await page.waitForFunction(() => document.querySelector('#mixed').dataset.rtlDir === 'rtl');
    const styles = await page.evaluate(() => {
        const result = {};
        for (const id of ['mixed', 'heading', 'english', 'item', 'quote', 'headcell', 'cell', 'code', 'math', 'outside', 'composer', 'icon']) {
            const element = document.getElementById(id), css = getComputedStyle(element);
            result[id] = { direction: css.direction, bidi: css.unicodeBidi, font: css.fontFamily };
        }
        return result;
    });
    for (const id of ['mixed', 'heading', 'item', 'quote', 'headcell', 'cell', 'composer']) assert.equal(styles[id].direction, 'rtl', id);
    assert.equal(await page.$eval('#composer', node => node.hasAttribute('data-rtl-text') || node.hasAttribute('data-rtl-dir') || node.hasAttribute('style')), false, 'Do not mutate editor-owned paragraphs');
    for (const id of ['english', 'code', 'math', 'outside']) assert.equal(styles[id].direction, 'ltr', id);
    assert.equal(styles.code.bidi, 'isolate');
    assert.match(styles.code.font, /monospace/);
    assert.equal(styles.icon.font, 'monospace');
    assert.equal(await page.$eval('#mixed a', node => getComputedStyle(node).unicodeBidi), 'isolate');
    assert.equal(await page.$eval('main', node => node.textContent), original);
    await page.evaluate(() => {
        const range = document.createRange(); range.selectNodeContents(document.querySelector('#mixed'));
        getSelection().removeAllRanges(); getSelection().addRange(range);
    });
    const selection = await page.evaluate(() => getSelection().toString());
    await page.addScriptTag({ content: rendererScript('full') });
    await page.evaluate(() => { document.querySelector('#stream').firstChild.data += ' برای بررسی متن فارسی و پاسخ تدریجی است'; });
    await page.waitForFunction(() => document.querySelector('#stream').dataset.rtlDir === 'rtl');
    assert.equal(await page.evaluate(() => getSelection().toString()), selection);
    await page.evaluate(() => { const node = document.querySelector('#composer'); node.textContent = 'English only'; node.dispatchEvent(new InputEvent('input', { bubbles: true })); });
    await page.waitForFunction(() => document.querySelector('#composer').parentElement.dataset.rtlDir === 'ltr');
    await page.evaluate(() => document.fonts.ready);
    const cdp = await page.createCDPSession();
    await cdp.send('DOM.enable'); await cdp.send('CSS.enable');
    const { root } = await cdp.send('DOM.getDocument');
    const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: root.nodeId, selector: '#heading' });
    const { fonts } = await cdp.send('CSS.getPlatformFontsForNode', { nodeId });
    assert.ok(fonts.some(font => /Vazirmatn/i.test(font.familyName) && font.glyphCount > 0), JSON.stringify(fonts));
    await t.test('composer lists contribute prose without editor-owned attribute writes', async () => {
        await page.evaluate(() => {
            const root = document.createElement('div');
            root.id = 'list-composer'; root.className = 'ProseMirror'; root.contentEditable = 'true';
            root.innerHTML = '<ul><li>فهرست فارسی برای آزمایش</li></ul>';
            document.body.append(root);
        });
        await page.waitForFunction(() => document.querySelector('#list-composer').dataset.rtlDir, { timeout: 2000 });
        assert.equal(await page.$eval('#list-composer', node => node.dataset.rtlDir), 'rtl');
        assert.equal(await page.$eval('#list-composer li', node => node.hasAttribute('data-rtl-dir') || node.hasAttribute('data-rtl-text')), false);
    });
    await t.test('removed roots are released even without subsequent prose mutations', async () => {
        await page.evaluate(() => {
            globalThis.detachedFixture = document.createElement('div');
            detachedFixture.className = 'standard-markdown'; detachedFixture.textContent = 'سلام';
            document.body.append(detachedFixture);
        });
        await page.waitForFunction(() => __claudeRtlPatch.roots.has(detachedFixture));
        await page.evaluate(() => detachedFixture.remove());
        await page.waitForFunction(() => !__claudeRtlPatch.roots.has(detachedFixture), { timeout: 2000 });
    });
    await t.test('task rows and question cards apply RTL without moving icons or shortcuts incorrectly', async () => {
        await page.evaluate(() => {
            const container = document.createElement('section');
            container.id = 'interactive-fixture';
            container.innerHTML = `
              <ul id="task-list" role="list" style="list-style:none;padding:0">
                <li id="task-row" style="display:flex;gap:8px">
                  <span id="task-icon" class="epitaxy-markdown-first-line" style="font-family:monospace;flex-shrink:0">✓<span class="sr-only">not done</span></span>
                  <div class="epitaxy-markdown-inherit-color" style="flex:1"><span id="task-label" style="font-family:serif">API بررسی متن فارسی</span></div>
                </li>
              </ul>
              <div id="question-card" data-cds="AskUserQuestion" role="group" style="font-family:Arial">
                <div id="question-label" style="font-family:serif">API آیا این متن آزمایشی فارسی درست است؟</div>
                <div style="display:flex;gap:8px">
                  <button id="answer-yes" style="font-family:Arial;display:inline-flex;gap:4px">بله، درست است <kbd id="shortcut">Ctrl+Enter</kbd></button>
                  <button id="answer-no" style="font-family:Arial">خیر</button>
                </div>
                <input id="question-other" type="text" style="font-family:Arial" value="" />
              </div>
              <div data-ask-user-input-banner><span id="legacy-question">پرسش فارسی برای آزمایش نمایش</span></div>
              <div data-testid="ask-user-answers-card"><div id="answered-question">API پرسش فارسی پاسخ داده شد</div></div>
              <div class="epitaxy-question-receipt"><div id="native-receipt" style="unicode-bidi:plaintext">API پرسش فارسی پاسخ داده شد</div></div>
              <div id="unrelated-card" style="display:flex"><span>English controls</span><button id="unrelated-button" style="font-family:Arial">English</button></div>`;
            document.body.append(container);
            document.querySelector('#answer-yes').onclick = () => { document.querySelector('#question-card').dataset.answer = 'yes'; };
        });
        await page.waitForFunction(() => document.querySelector('#task-row').dataset.rtlDir === 'rtl', { timeout: 2000 });
        const result = await page.evaluate(() => {
            const ids = ['task-row', 'task-label', 'question-card', 'question-label', 'answered-question', 'native-receipt', 'answer-yes', 'answer-no', 'legacy-question', 'shortcut', 'unrelated-card', 'unrelated-button'];
            return Object.fromEntries(ids.map(id => {
                const node = document.getElementById(id), style = getComputedStyle(node), box = node.getBoundingClientRect();
                return [id, { direction: style.direction, font: style.fontFamily, x: box.x }];
            }));
        });
        for (const id of ['task-row', 'task-label', 'question-card', 'question-label', 'answered-question', 'native-receipt', 'answer-yes', 'answer-no', 'legacy-question']) {
            assert.equal(result[id].direction, 'rtl', id);
            assert.match(result[id].font, /Vazirmatn/, id);
        }
        assert.equal(await page.$eval('#native-receipt', node => getComputedStyle(node).unicodeBidi), 'isolate');
        assert.ok(await page.$eval('#task-icon', icon => icon.getBoundingClientRect().x > document.querySelector('#task-label').getBoundingClientRect().right));
        assert.ok(result['answer-yes'].x > result['answer-no'].x);
        assert.equal(result.shortcut.direction, 'ltr');
        assert.match(result.shortcut.font, /monospace/);
        assert.equal(result['unrelated-card'].direction, 'ltr');
        assert.equal(result['unrelated-button'].font, 'Arial');
        await page.click('#answer-yes');
        assert.equal(await page.$eval('#question-card', node => node.dataset.answer), 'yes');
        await page.focus('#answer-no');
        await page.keyboard.down('Shift');
        await page.keyboard.press('Tab');
        await page.keyboard.up('Shift');
        assert.equal(await page.evaluate(() => document.activeElement.id), 'answer-yes');
        await page.$eval('#question-card', node => { delete node.dataset.answer; });
        await page.keyboard.press('Enter');
        assert.equal(await page.$eval('#question-card', node => node.dataset.answer), 'yes');
        await page.type('#question-other', 'API این یک پاسخ فارسی است');
        await page.waitForFunction(() => document.querySelector('#question-other').dataset.rtlDir === 'rtl', { timeout: 2000 });
        assert.equal(await page.$eval('#question-other', node => node.value), 'API این یک پاسخ فارسی است');
        await page.evaluate(() => document.querySelector('#question-label').firstChild.data = 'English question');
        await page.waitForFunction(() => document.querySelector('#question-label').dataset.rtlDir === 'ltr', { timeout: 2000 });
        await page.evaluate(() => {
            const list = document.createElement('ul');
            list.id = 'deferred-tasks'; list.setAttribute('role', 'list');
            document.body.append(list);
        });
        await page.evaluate(() => {
            document.querySelector('#deferred-tasks').innerHTML = '<li><span class="epitaxy-markdown-first-line">o</span><div>بررسی متن فارسی</div></li>';
        });
        await page.waitForFunction(() => document.querySelector('#deferred-tasks').dataset.rtlDir === 'rtl', { timeout: 2000 });
    });
    await t.test('font-only truly preserves native bidi even on streamed text', async () => {
        const second = await browser.newPage();
        await second.goto(`http://127.0.0.1:${server.address().port}`);
        await second.setContent('<main><div class="standard-markdown"><p id="native" dir="rtl">API برای آزمایش</p></div><div data-cds="AskUserQuestion" dir="ltr" id="native-question"><button id="native-answer">پاسخ فارسی</button></div></main>');
        await second.addStyleTag({ content: CSS_INJECT_FONT_ONLY });
        await second.addScriptTag({ content: rendererScript('font-only') });
        await second.$eval('#native', node => node.firstChild.data += ' است');
        assert.deepEqual(await second.$eval('#native', node => [node.dir, node.hasAttribute('data-rtl-dir'), getComputedStyle(node).direction]), ['rtl', false, 'rtl']);
        assert.deepEqual(await second.$eval('#native-question', node => [node.dir, node.hasAttribute('data-rtl-dir'), getComputedStyle(node).direction]), ['ltr', false, 'ltr']);
        assert.equal(await second.$eval('#native-answer', node => getComputedStyle(node).direction), 'ltr');
        await second.close();
    });
});
