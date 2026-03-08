import { test, expect } from '@playwright/test';
import {
  CALCULATOR_URL,
  SEL,
  dismissCookieBanner,
  clearAndFill,
  clickUpdate,
  readStablePayment,
  parseAmount,
} from './helpers';

test.describe('Bankrate Mortgage Calculator — Calculator Inputs', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(CALCULATOR_URL, { waitUntil: 'domcontentloaded' });
    // Wait for the Vue app to hydrate and render the calculator form.
    await expect(page.locator(SEL.homePrice)).toBeVisible({ timeout: 20_000 });
    await dismissCookieBanner(page);
  });

  // ── 1. Default State ─────────────────────────────────────────────────────

  test.describe('1. Default State', () => {
    test('page loads and the calculator is visible with default values pre-populated', async ({ page }) => {
      await expect(page.locator(SEL.calculator)).toBeVisible();

      // All core inputs are rendered.
      await expect(page.locator(SEL.homePrice)).toBeVisible();
      await expect(page.locator(SEL.interestRate)).toBeVisible();
      await expect(page.locator(SEL.loanTerm)).toBeVisible();
      await expect(page.locator(SEL.dpDollar)).toBeVisible();
      await expect(page.locator(SEL.dpPercent)).toBeVisible();

      // Default home price is a positive number (e.g. 425,000).
      const homePrice = parseAmount(await page.locator(SEL.homePrice).inputValue());
      expect(homePrice).toBeGreaterThan(0);

      // Default interest rate is positive.
      const rate = parseAmount(await page.locator(SEL.interestRate).inputValue());
      expect(rate).toBeGreaterThan(0);

      // Default down-payment percentage is positive.
      const dpPct = parseAmount(await page.locator(SEL.dpPercent).inputValue());
      expect(dpPct).toBeGreaterThan(0);

      // Monthly payment is already displayed with a dollar sign.
      await expect(page.locator(SEL.monthlyPayment).first()).toBeVisible();
      await expect(page.locator(SEL.monthlyPayment).first()).toContainText('$');
    });
  });

  // ── 2. Monthly Payment Calculation ───────────────────────────────────────
  //
  // The total monthly payment displayed by the calculator includes principal &
  // interest (P&I) plus server-side estimates for property tax and home
  // insurance that cannot be zeroed out — the app recalculates them on every
  // Update. For a $300 k home in the default Denver ZIP, the auto-calculated
  // fees add roughly $264/month ($198 tax + $66 insurance), bringing the total
  // to approximately $1,861 (P&I $1,597 + fees $264).

  test.describe('2. Monthly Payment Calculation', () => {
    test('calculates expected monthly payment for $300k home, 20% down, 30yr, 7%', async ({ page }) => {
      // Fill homePrice, then wait for Vue's reactive API call to confirm the
      // new price and auto-update dpDollar to 20 % × $300 k = $60 k.
      // This ensures Vue's internal homePrice is $300 k before Update is
      // clicked (see KEY BEHAVIOUR #4).
      await clearAndFill(page, SEL.homePrice, '300000');
      await expect(page.locator(SEL.dpDollar)).toHaveValue(/60,?000/, { timeout: 5000 });
      await page.locator(SEL.loanTerm).selectOption({ label: '30 years' });
      await clearAndFill(page, SEL.interestRate, '7');

      await clickUpdate(page);

      // P&I = $1,597. Adding auto-estimated Denver taxes ($198) and insurance
      // ($66) gives ~$1,861. Poll until the payment stabilises — the calculator
      // makes async server calls that can briefly show an intermediate value.
      const payment = parseAmount(await readStablePayment(page));
      expect(payment).toBeGreaterThanOrEqual(1597); // at minimum, P&I only
      expect(payment).toBeLessThanOrEqual(2500);    // P&I + generous fee headroom
    });
  });

  // ── 3. Down Payment Percentage Sync ──────────────────────────────────────
  //
  // The $ ↔ % sync is REAL-TIME (driven by Tab/blur), not by the Update button.
  // These tests deliberately keep the home price at its default (425,000) so
  // that Vue's internal homePrice state — which lags behind DOM changes until
  // Update is clicked — already matches the value used for the sync calculation.

  test.describe('3. Down Payment Percentage Sync', () => {
    test('changing down payment dollar amount updates the percentage field', async ({ page }) => {
      // 42,500 / 425,000 (default home price) = 10 %
      await page.locator(SEL.dpDollar).click({ clickCount: 3 });
      await page.locator(SEL.dpDollar).fill('42500');
      await page.locator(SEL.dpDollar).press('Tab');

      // Sync is real-time — no Update click needed.
      await expect(async () => {
        const pct = parseAmount(await page.locator(SEL.dpPercent).inputValue());
        expect(pct).toBeCloseTo(10, 0);
      }).toPass({ timeout: 3000 });
    });

    test('changing down payment percentage updates the dollar amount field', async ({ page }) => {
      // 10 % × 425,000 (default home price) = 42,500
      await page.locator(SEL.dpPercent).click({ clickCount: 3 });
      await page.locator(SEL.dpPercent).fill('10');
      await page.locator(SEL.dpPercent).press('Tab');

      // Sync is real-time — no Update click needed.
      await expect(async () => {
        const amount = parseAmount(await page.locator(SEL.dpDollar).inputValue());
        expect(amount).toBeCloseTo(42500, -2); // allow ±50 for rounding
      }).toPass({ timeout: 3000 });
    });
  });

  // ── 4. Loan Term Toggle ───────────────────────────────────────────────────

  test.describe('4. Loan Term Toggle', () => {
    test('switching to 15-year term produces a higher monthly payment than 30-year', async ({ page }) => {
      // Fill homePrice, then wait for Vue's reactive update of dpDollar to
      // 20 % × $300 k = $60 k — this confirms Vue's internal homePrice is
      // $300 k before any Update is clicked (see KEY BEHAVIOUR #4).
      await clearAndFill(page, SEL.homePrice, '300000');
      await expect(page.locator(SEL.dpDollar)).toHaveValue(/60,?000/, { timeout: 5000 });
      await clearAndFill(page, SEL.interestRate, '7');

      // ── 30-year ─────────────────────────────────────────────────────
      await page.locator(SEL.loanTerm).selectOption({ label: '30 years' });
      await clickUpdate(page);
      // Poll until stable — async server calls can produce intermediate values.
      const value30 = parseAmount(await readStablePayment(page));

      // ── 15-year ─────────────────────────────────────────────────────
      await page.locator(SEL.loanTerm).selectOption({ label: '15 years' });
      await clickUpdate(page);
      const value15 = parseAmount(await readStablePayment(page));

      // A 15-year loan repays the same principal in half the time → higher payment.
      expect(value15).toBeGreaterThan(value30);
    });
  });

  // ── 5. Interest Rate Change ───────────────────────────────────────────────

  test.describe('5. Interest Rate Change', () => {
    test('increasing the interest rate raises the monthly payment', async ({ page }) => {
      // Stable loan inputs — only the rate changes between the two assertions.
      await clearAndFill(page, SEL.homePrice, '300000');
      await page.locator(SEL.loanTerm).selectOption({ label: '30 years' });

      // ── 5% ──────────────────────────────────────────────────────────
      await clearAndFill(page, SEL.interestRate, '5');
      await clickUpdate(page);
      const value5 = parseAmount(await page.locator(SEL.monthlyPayment).first().textContent());

      // ── 9% ──────────────────────────────────────────────────────────
      await clearAndFill(page, SEL.interestRate, '9');
      await clickUpdate(page);
      const value9 = parseAmount(await page.locator(SEL.monthlyPayment).first().textContent());

      expect(value9).toBeGreaterThan(value5);
    });
  });

  // ── 6. Input Validation ───────────────────────────────────────────────────

  test.describe('6. Input Validation', () => {
    test('zero home price does not crash the calculator or produce NaN', async ({ page }) => {
      await clearAndFill(page, SEL.homePrice, '0');
      await page.locator(SEL.updateBtn).click();
      await page.waitForTimeout(1500);

      await expect(page.locator(SEL.calculator)).toBeVisible();
      const text = await page.locator(SEL.monthlyPayment).first().textContent({ timeout: 4000 }).catch(() => '');
      expect(text).not.toContain('NaN');
    });

    test('negative home price does not crash the calculator or produce NaN', async ({ page }) => {
      await clearAndFill(page, SEL.homePrice, '-200000');
      await page.locator(SEL.updateBtn).click();
      await page.waitForTimeout(1500);

      await expect(page.locator(SEL.calculator)).toBeVisible();
      const text = await page.locator(SEL.monthlyPayment).first().textContent({ timeout: 4000 }).catch(() => '');
      expect(text).not.toContain('NaN');
    });

    test('zero interest rate does not crash the calculator or produce NaN', async ({ page }) => {
      await clearAndFill(page, SEL.interestRate, '0');
      await clickUpdate(page);

      await expect(page.locator(SEL.calculator)).toBeVisible();
      // At 0 % interest the payment = principal ÷ months — a valid finite number.
      const text = (await page.locator(SEL.monthlyPayment).first().textContent()) ?? '';
      expect(text).not.toContain('NaN');
    });
  });
});
