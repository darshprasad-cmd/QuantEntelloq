/* Run against a local static server. Install Playwright separately, or set
 * PLAYWRIGHT_MODULE to an existing Playwright package; no app dependency needed.
 * This isolated browser uses only a synthetic local user. Provider/API requests
 * are blocked, so no account, external data, or trade is changed. */
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const base = process.env.QUANT_BASE_URL || 'http://127.0.0.1:8774';
const origin = new URL(base).origin;
assert.ok(['localhost', '127.0.0.1'].includes(new URL(base).hostname), 'Use a local static preview for this isolated user fixture');

(async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, reducedMotion: 'reduce' });
  await context.addInitScript(() => {
    localStorage.setItem('qz_auth_user', JSON.stringify({ name: 'UI Test', email: 'ui-test@example.invalid' }));
    for (const key of ['qz_onboarded', 'qz_tutorial_v3', 'qz_legal_v2', 'qz_disc_dismissed', 'qz_mentor_skip_v1', 'qz_welcome_shown_v1', 'qe_tour_seen_v1', 'qe_tour_seen_v2', 'qz_rebrand_entelloq_v1']) localStorage.setItem(key, '1');
    localStorage.setItem('qz_cookies_ok', 'minimal');
  });
  await context.route('**/*', route => {
    const url = new URL(route.request().url());
    return url.origin === origin && !url.pathname.startsWith('/api/') ? route.continue() : route.abort();
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    await page.goto(base, { waitUntil: 'domcontentloaded' });
    await page.locator('#qe-app-menu-toggle').waitFor({ state: 'visible' });
    await page.waitForTimeout(4500); // Let the legacy startup route settle once.
    for (const width of [390, 1440]) {
      await page.setViewportSize({ width, height: 844 });
      await page.waitForFunction(() => parseInt(getComputedStyle(document.documentElement).getPropertyValue('--qz-dockb'), 10) === 14);
      await page.locator('#qe-disclaimer-bar').evaluate(bar => bar.classList.add('visible'));
      await page.waitForFunction(() => {
        const bar = document.getElementById('qe-disclaimer-bar').getBoundingClientRect();
        return parseInt(getComputedStyle(document.documentElement).getPropertyValue('--qz-dockb'), 10) === Math.round(bar.height) + 14;
      });
      await page.evaluate(() => window.qeDismissDisclaimer());
      await page.waitForFunction(() => parseInt(getComputedStyle(document.documentElement).getPropertyValue('--qz-dockb'), 10) === 14);
    }
    for (const width of [390, 320, 820]) {
      await page.setViewportSize({ width, height: 844 });
      for (const selector of ['#qe-app-menu-toggle', '#qe-mobile-search-btn', '#qe-share-btn']) {
        const box = await page.locator(selector).boundingBox();
        assert.ok(box && box.x >= 0 && box.x + box.width <= width, `${selector} fits at ${width}px`);
        assert.ok(box.width >= 44 && box.height >= 44, `${selector} keeps a 44px touch target`);
      }
      await page.locator('#qe-app-menu-toggle').click();
      assert.equal(await page.locator('#qe-app-menu').evaluate(dialog => dialog.open), true);
      assert.equal(await page.locator('#qe-app-menu .qe-app-menu-close').evaluate(button => button === document.activeElement), true);
      const desktopRoutes = await page.locator('#qe-topnav [data-page]').evaluateAll(nodes => [...new Set(nodes.map(node => node.dataset.page))]);
      for (const route of [...desktopRoutes, 'learn-explore']) assert.equal(await page.locator(`#qe-app-menu [data-app-page="${route}"]`).count(), 1, `Mobile menu preserves ${route}`);
      await page.locator('#qe-app-menu [data-app-page]').last().focus();
      await page.keyboard.press('Tab');
      assert.equal(await page.evaluate(() => !!document.activeElement.closest('#qe-app-menu')), true, 'Tab stays in menu');
      await page.keyboard.press('Escape');
      await page.waitForFunction(() => !document.querySelector('#qe-app-menu').open && !document.body.classList.contains('qe-app-menu-open'));
      assert.equal(await page.locator('#qe-app-menu-toggle').evaluate(button => button === document.activeElement), true);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), width);
    }
    await page.setViewportSize({ width: 390, height: 844 });
    await page.evaluate(() => window.scrollTo(0, 400));
    const before = await page.evaluate(() => ({ y: scrollY, overflow: document.body.style.overflow }));
    await page.locator('#qe-app-menu-toggle').click();
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.body.classList.contains('qe-app-menu-open'));
    const after = await page.evaluate(() => ({ y: scrollY, overflow: document.body.style.overflow }));
    assert.deepEqual(after, before, 'Closing menu preserves scroll and existing overflow style');
    await page.locator('#qe-app-menu-toggle').click();
    await page.locator('#qe-app-menu [data-app-page="learn-explore"]').click();
    await page.locator('#page-learn-explore').waitFor({ state: 'visible' });
    assert.match(await page.locator('#page-title').textContent(), /^Learn/);
    const lesson = page.locator('[onclick^="qzLearnOpen("]').first();
    await lesson.focus();
    await page.keyboard.press('Enter');
    await page.locator('#qz-lesson-modal').waitFor({ state: 'visible' });
    await page.keyboard.press('Escape');
    await page.locator('#qz-lesson-modal').waitFor({ state: 'detached' });
    assert.equal(await lesson.evaluate(card => document.activeElement === card), true, 'Lesson close restores keyboard focus');
    await page.locator('#qe-app-menu-toggle').click();
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.waitForFunction(() => !document.querySelector('#qe-app-menu').open);
    assert.equal(await page.evaluate(() => document.body.style.overflow), before.overflow, 'Resizing releases scroll lock');
    await page.locator('#qe-tn-more-btn').click();
    await page.locator('#qe-tn-more-panel .qe-tn-mitem').first().focus();
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('#qe-tn-more-btn').evaluate(button => button === document.activeElement), true);
    assert.equal(await page.locator('#qe-tn-more-panel').evaluate(panel => panel.classList.contains('open')), false);
    await page.locator('#qe-tn-more-btn').click();
    await page.locator('#qe-tn-more-panel [data-page="scenario"]').focus();
    await page.keyboard.press('Enter');
    await page.getByRole('button', { name: /Historical Crisis/ }).click();
    const crisis = page.locator('.qzsc-crisis-card').nth(1);
    await crisis.focus();
    await page.keyboard.press('Space');
    assert.equal(await crisis.evaluate(card => card.classList.contains('active')), true, 'Historical crisis can be selected by keyboard');
    await page.setViewportSize({ width: 390, height: 844 });
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.equal(await page.locator('#qe-mobile-search-btn').isVisible(), true, 'Search is immediately available after desktop-to-phone resize');
    await page.locator('#qe-mobile-search-btn').click();
    assert.equal(await page.locator('#qz-search-overlay').evaluate(overlay => overlay.classList.contains('open')), true);
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('#qz-search-overlay').evaluate(overlay => overlay.classList.contains('open')), false);
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ passed: true, widths: [390, 320, 820, 1440], checks: ['header target fit', 'mobile menu destinations', 'focus containment and Escape return', 'scroll preservation', 'keyboard lesson entry and close', 'resize cleanup', 'desktop More keyboard navigation', 'crisis keyboard selection', 'desktop-to-mobile search', 'disclaimer dock offsets', 'no page errors'] }));
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
