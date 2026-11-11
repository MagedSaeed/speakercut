const { chromium } = require('playwright');
const fs = require('fs'), path = require('path');
let mediaHits = 0;
(async () => {
  const ext = path.resolve(__dirname, '../extension');
  const ctx = await chromium.launchPersistentContext('/tmp/claude-0/pw-profile-' + Date.now(), {
    headless: true, channel: 'chromium', args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`, '--no-proxy-server'] });
  await ctx.route('https://annotation.dlnlp.ai/**', (route) => {
    const u = route.request().url();
    if (u.includes('local-files')) { mediaHits++; } if (u.includes('local-files')) return route.fulfill({ status: 200, contentType: 'video/mp4', body: fs.readFileSync(path.join(__dirname, 'sample.mp4')) });
    return route.fulfill({ status: 200, contentType: 'text/html', body: fs.readFileSync(path.join(__dirname, 'mock_ls.html')) });
  });
  const page = await ctx.newPage();
  page.on('console', m => { if (m.type()==='error') console.log('console:', m.text()); });
  await page.goto('https://annotation.dlnlp.ai/cinnamon/projects/42/data?tab=19&task=101169');
  const btn = page.locator('#lsp-root').locator('#run');
  await btn.waitFor({ timeout: 10000 });
  const st = page.locator('#lsp-root').locator('#st');
  await page.waitForTimeout(800);
  console.log('while loading -> disabled:', await btn.isDisabled(), '| status:', await st.textContent());
  await btn.click({ force: true }); await page.waitForTimeout(300);
  console.log('click while loading -> regions:', await page.evaluate(() => window.Htx.annotationStore.selected.regions.length));
  await page.waitForFunction(() => !document.getElementById('lsp-root').shadowRoot.getElementById('run').disabled, null, { timeout: 8000 });
  console.log('after load -> disabled:', await btn.isDisabled(), '| status:', await st.textContent());
  await page.screenshot({ path: '/tmp/claude-0/row.png', clip: { x: 0, y: 0, width: 1280, height: 330 } });
  await btn.click();
  await page.waitForFunction(() => window.Htx.annotationStore.selected.regions.length > 0 || false, null, { timeout: 30000 }).catch(()=>{});
  await page.waitForTimeout(500);
  console.log('status:', await st.textContent());
  const regs = await page.evaluate(() => window.Htx.annotationStore.selected.regions.map(r => r.result));
  console.log('regions:', JSON.stringify(regs.map(r => [r.from_name, r.to_name, r.type, r.value.start, r.value.end, r.value.labels[0]])));
  // second click should warn (existing segments), not duplicate
  await btn.click(); await page.waitForTimeout(500);
  console.log('second click status:', await st.textContent(), '| count:', await page.evaluate(() => window.Htx.annotationStore.selected.regions.length));
  await page.locator('#lsp-root').locator('#undo').click(); await page.waitForTimeout(300);
  console.log('after remove:', await st.textContent(), '| count:', await page.evaluate(() => window.Htx.annotationStore.selected.regions.length));
  console.log('media downloads by extension:', mediaHits);
  console.log('submits:', await page.evaluate(() => window.__submits));
  await page.screenshot({ path: '/tmp/claude-0/e2e.png' });
  await ctx.close();
})().catch(e => { console.error('FAIL', e); process.exit(1); });
