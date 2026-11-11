const { chromium } = require('playwright'); const fs=require('fs'), path=require('path');
(async () => {
  const ext = path.resolve(__dirname, '../extension');
  const ctx = await chromium.launchPersistentContext('/tmp/claude-0/pwl'+Date.now(), { headless: true, channel: 'chromium',
    args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`, '--no-proxy-server'], viewport: {width: 1200, height: 500} });
  const html = fs.readFileSync(path.join(__dirname, 'mock_ls.html'), 'utf8');
  await ctx.route('https://annotation.dlnlp.ai/**', r => r.fulfill({ status: 200, contentType: 'text/html',
    body: r.request().url().includes('norow') ? html.replace(/<div id="linksrow"[\s\S]*?<\/div>\n<\/div>/, '') : html }));
  const p = await ctx.newPage();
  await p.goto('https://annotation.dlnlp.ai/cinnamon/projects/42/data?task=1'); await p.waitForTimeout(1500);
  const where = () => p.evaluate(() => { const h=document.getElementById('lsp-root'); return h ? { afterLinksRow: h.previousElementSibling?.id === 'linksrow', mode: h.shadowRoot.getElementById('box').className } : null; });
  console.log('initial:', JSON.stringify(await where()));
  await p.screenshot({ path: '/tmp/claude-0/layout.png' });
  // simulate LS re-rendering the config on task switch
  await p.evaluate(() => { const c=document.getElementById('cfg'); const clone=c.cloneNode(true); clone.querySelector('#lsp-root')?.remove(); c.replaceWith(clone); });
  await p.waitForTimeout(500);
  console.log('after re-render:', JSON.stringify(await where()), 'count:', await p.evaluate(() => document.querySelectorAll('#lsp-root').length));
  await p.goto('https://annotation.dlnlp.ai/cinnamon/projects/42/data?task=2&norow=1'); await p.waitForTimeout(1500);
  console.log('no row, 1.5s:', JSON.stringify(await where()));
  await p.waitForTimeout(4500);
  console.log('no row, 6s:', JSON.stringify(await where()));
  await ctx.close();
})().catch(e => { console.error('FAIL', e); process.exit(1); });
