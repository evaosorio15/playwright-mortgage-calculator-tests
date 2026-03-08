import { test, expect, type Page } from '@playwright/test';

const CALCULATOR_URL = 'https://www.bankrate.com/mortgages/mortgage-calculator/';

// ─── Selectors ───────────────────────────────────────────────────────────────
//
// Verified against the live page (Vue.js, client-side rendered).
//
// KEY BEHAVIOURS (discovered through live testing):
//
//  1. The calculator does NOT auto-recalculate on input change. All changes
//     are committed only when the "Update" button is clicked.
//
//  2. Filling text inputs (homePrice, interestRate) via Playwright updates the
//     DOM value but NOT Vue's internal reactive state. Vue reads the DOM value
//     at Update-click time, so the values DO take effect on submit.
//
//  3. Down-payment $ ↔ % sync IS real-time (Tab-triggered) and does NOT
//     require clicking Update. However, the percentage is computed against
//     Vue's internal homePrice — which is only updated after an Update click.
//     Tests that check the real-time sync must therefore use the DEFAULT
//     homePrice (425,000) so Vue's state matches the DOM.
//
//  4. After filling homePrice and pressing Tab, the calculator fires a live
//     rate/property-tax API call for the new price. When that call returns, Vue
//     reactively resets dpDollar = dpPercent × new homePrice (e.g. 20 % ×
//     $300 k = $60 k). Tests 2 and 4 wait for this reactive update
//     (toHaveValue on dpDollar) before proceeding. This guarantees Vue's
//     internal homePrice is confirmed as $300 k before Update is clicked.
//
//  5. Property tax is auto-recalculated by the server on each Update (based
//     on home price + ZIP code). Zeroing it out before Update is ineffective.
//
//  6. The "Update" button selector 'button:text-is("Update")' matches exactly
//     the calculator's submit button and avoids ambiguity with "View offer"
//     buttons that share the same CSS class.
//
const SEL = {
  homePrice:      '#homePrice',
  interestRate:   '#interestRate',
  // Loan term: the <select> id is auto-generated; scope to its stable data-test wrapper.
  loanTerm:       '[data-test="loanProduct"] select',
  // Down-payment inputs live in separate data-test wrappers.
  dpDollar:       'div[data-test="downPaymentAmount"] input',
  dpPercent:      'div[data-test="downPaymentPercent"] input',
  // Primary monthly-payment display in the amortisation chart.
  monthlyPayment: '.Amortization-chart .Numeral.type-heading-two',
  // Submit button. :text-is() matches the exact trimmed visible text.
  updateBtn:      'button:text-is("Update")',
  calculator:     'div.calculator',
  cookieBanner:   '#onetrust-banner-sdk',
  cookieClose:    'button.onetrust-close-btn-handler.banner-close-button',
} as const;

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Dismiss the OneTrust cookie banner if it appears. */
async function dismissCookieBanner(page: Page): Promise<void> {
  try {
    await page.locator(SEL.cookieBanner).waitFor({ state: 'visible', timeout: 6000 });
    await page.locator(SEL.cookieClose).click();
    await page.locator(SEL.cookieBanner).waitFor({ state: 'hidden', timeout: 4000 });
  } catch {
    // Banner did not appear — nothing to do.
  }
}

/**
 * Replace a formatted numeric input's value and Tab away.
 * Inputs display values like "425,000"; triple-click selects all before fill().
 * Pressing Tab afterward fires blur/change events, triggering any real-time
 * reactive updates (e.g. down-payment % ↔ $ sync).
 */
async function clearAndFill(page: Page, selector: string, value: string): Promise<void> {
  const input = page.locator(selector);
  await input.click({ clickCount: 3 });
  await input.fill(value);
  await input.press('Tab');
}

/**
 * Click the "Update" button and give the calculator a moment to start its
 * async recalculation (property-tax and rate look-ups fire server requests).
 */
async function clickUpdate(page: Page): Promise<void> {
  await page.locator(SEL.updateBtn).click();
  await page.waitForTimeout(500);
}

/**
 * Poll the monthly-payment display until two consecutive 600 ms reads return
 * the same dollar amount, then return the stable text.
 *
 * Background: the calculator can briefly show an intermediate value while a
 * server-side property-tax or rate API call is still in flight. A fixed
 * timeout races against this; polling until stable is more reliable.
 * Maximum total wait: 16 × 600 ms = 9.6 s.
 */
async function readStablePayment(page: Page): Promise<string> {
  let prev = '';
  for (let i = 0; i < 16; i++) {
    await page.waitForTimeout(600);
    const text = (await page.locator(SEL.monthlyPayment).first().textContent())?.trim() ?? '';
    if (text === prev && text.startsWith('$')) return text;
    prev = text;
  }
  return prev;
}

/** Strip currency symbols, commas, and whitespace; return a plain JS number. */
function parseAmount(text: string | null | undefined): number {
  return Number((text ?? '').replace(/[^0-9.]/g, ''));
}

// ─── Amortization helpers (shared by describe blocks 7 and 8) ────────────────

/**
 * Return the value display element for an amortization summary item.
 *
 * Two DOM shapes exist in the summary grid:
 *   Loan amount:  span.text-gray-700 label inside a tooltip wrapper → value in sibling div
 *   Other items:  p.text-gray-700 label directly sibling to the value div
 * XPath walks up to the first ancestor <div> that contains a type-heading-three
 * descendant, then returns that descendant — works for both shapes.
 */
function amortValue(page: Page, label: string | RegExp) {
  return page
    .locator('p.text-gray-700, span.text-gray-700')
    .filter({ hasText: label })
    .first()
    .locator('xpath=ancestor::div[.//div[contains(@class,"type-heading-three")]][1]//div[contains(@class,"type-heading-three")][1]');
}

/** Parse a payoff date string "Mon YYYY" into a comparable {year, monthIndex}. */
function parsePayoffDate(text: string): { year: number; monthIndex: number } {
  const MONTHS = ['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'];
  const [mon = '', yr = '0'] = text.trim().split(/\s+/);
  return { year: Number(yr), monthIndex: MONTHS.indexOf(mon.toLowerCase()) };
}

/** Return true when date a is strictly earlier than date b. */
function payoffBefore(
  a: { year: number; monthIndex: number },
  b: { year: number; monthIndex: number },
): boolean {
  return a.year < b.year || (a.year === b.year && a.monthIndex < b.monthIndex);
}

interface AmortBaseline {
  interest: number; // Total interest paid
  cost:     number; // Total cost of loan
  payoff:   string; // Payoff date raw text e.g. "Mar 2056"
}

/**
 * Capture the amortization summary values from the Amortization tab.
 * Call BEFORE making any extra-payment changes — the returned values serve
 * as the "no extra payments" baseline for comparison assertions.
 */
async function captureAmortBaseline(page: Page): Promise<AmortBaseline> {
  await expect(amortValue(page, /Loan amount/i)).toBeVisible({ timeout: 8_000 });
  const interest = parseAmount(await amortValue(page, /Total interest paid/i).textContent());
  const cost     = parseAmount(await amortValue(page, /Total cost of loan/i).textContent());
  const payoff   = (await amortValue(page, /Payoff date/i).textContent())?.trim() ?? '';
  return { interest, cost, payoff };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

test.describe('Bankrate Mortgage Calculator', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(CALCULATOR_URL, { waitUntil: 'domcontentloaded' });
    // Wait for the Vue app to hydrate and render the calculator form.
    await expect(page.locator(SEL.homePrice)).toBeVisible({ timeout: 20_000 });
    await dismissCookieBanner(page);
  });

  // ── 1. Default State ───────────────────────────────────────────────────────

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

  // ── 2. Monthly Payment Calculation ─────────────────────────────────────────
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

  // ── 3. Down Payment Percentage Sync ────────────────────────────────────────
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

  // ── 4. Loan Term Toggle ─────────────────────────────────────────────────────

  test.describe('4. Loan Term Toggle', () => {
    test('switching to 15-year term produces a higher monthly payment than 30-year', async ({ page }) => {
      // Fill homePrice, then wait for Vue's reactive update of dpDollar to
      // 20 % × $300 k = $60 k — this confirms Vue's internal homePrice is
      // $300 k before any Update is clicked (see KEY BEHAVIOUR #4).
      await clearAndFill(page, SEL.homePrice, '300000');
      await expect(page.locator(SEL.dpDollar)).toHaveValue(/60,?000/, { timeout: 5000 });
      await clearAndFill(page, SEL.interestRate, '7');

      // ── 30-year ───────────────────────────────────────────────────────
      await page.locator(SEL.loanTerm).selectOption({ label: '30 years' });
      await clickUpdate(page);
      // Poll until stable — async server calls can produce intermediate values.
      const value30 = parseAmount(await readStablePayment(page));

      // ── 15-year ───────────────────────────────────────────────────────
      await page.locator(SEL.loanTerm).selectOption({ label: '15 years' });
      await clickUpdate(page);
      const value15 = parseAmount(await readStablePayment(page));

      // A 15-year loan repays the same principal in half the time → higher payment.
      expect(value15).toBeGreaterThan(value30);
    });
  });

  // ── 5. Interest Rate Change ─────────────────────────────────────────────────

  test.describe('5. Interest Rate Change', () => {
    test('increasing the interest rate raises the monthly payment', async ({ page }) => {
      // Stable loan inputs — only the rate changes between the two assertions.
      await clearAndFill(page, SEL.homePrice, '300000');
      await page.locator(SEL.loanTerm).selectOption({ label: '30 years' });

      // ── 5% ───────────────────────────────────────────────────────────
      await clearAndFill(page, SEL.interestRate, '5');
      await clickUpdate(page);
      const value5 = parseAmount(await page.locator(SEL.monthlyPayment).first().textContent());

      // ── 9% ───────────────────────────────────────────────────────────
      await clearAndFill(page, SEL.interestRate, '9');
      await clickUpdate(page);
      const value9 = parseAmount(await page.locator(SEL.monthlyPayment).first().textContent());

      expect(value9).toBeGreaterThan(value5);
    });
  });

  // ── 7. Amortization Tab ────────────────────────────────────────────────────
  //
  // The Amortization tab is reached by clicking [role="tab"][id="2"] (labelled
  // "Amortization"). The tab panel shows four summary values in a grid with two
  // distinct DOM shapes:
  //
  //   Loan amount (has tooltip):
  //     <div class="mt-5">
  //       <div> <span class="text-gray-700">Loan amount</span> <Tooltip /> </div>
  //       <div class="type-heading-three">$340,000</div>
  //     </div>
  //
  //   Other three items (no tooltip):
  //     <div>
  //       <p class="text-gray-700 ... mt-5 ...">Total interest paid</p>
  //       <div class="type-heading-three">$431,158</div>
  //     </div>
  //     NOTE: mt-5 is a class on the <p> label, NOT on the container <div>.
  //
  // The amortValue(), parsePayoffDate(), payoffBefore(), and captureAmortBaseline()
  // helpers used here are defined at module scope and shared with describe block 8.
  //
  // Tests use a fixed rate (7%) with the default home price and default 20%
  // down payment ($425 k − $85 k = $340 k loan) so assertions are
  // deterministic. Because homePrice is NOT changed, Vue's internal homePrice
  // stays at the confirmed default — the homePrice-lock issue (KEY BEHAVIOUR
  // #4) does not apply here.
  //
  // Expected values at 7% / 30 yr on $340 k:
  //   Loan amount      $340,000
  //   Total interest   ~$474,000  (360 × $2,262 P&I − $340 k)
  //   Total cost       ~$814,000  (loan + interest)
  //   Payoff date      <month> 2056  (current year + 30 years)

  test.describe('7. Amortization Tab', () => {
    /**
     * Fill a known interest rate, click Update (waiting for payment to
     * stabilise so all async API calls are complete), then switch to the
     * Amortization tab and wait for its content to render.
     */
    async function setupAmortTab(page: Page): Promise<void> {
      await clearAndFill(page, SEL.interestRate, '7');
      await page.locator(SEL.loanTerm).selectOption({ label: '30 years' });
      await clickUpdate(page);
      // Stable payment = all server-side async calls (property tax, rate
      // lookups) have completed. Safe to switch tabs after this.
      await readStablePayment(page);
      await page.getByRole('tab', { name: 'Amortization' }).click();
      // Loan amount is the first summary value rendered; use it as a
      // readiness gate before asserting any other value.
      await expect(amortValue(page, /Loan amount/i)).toBeVisible({ timeout: 8000 });
    }

    test('loan amount equals home price minus down payment', async ({ page }) => {
      // Read the form inputs BEFORE switching tabs so the expected value is
      // derived from the calculator's own inputs, not hard-coded.
      const homePrice = parseAmount(await page.locator(SEL.homePrice).inputValue());
      const dpDollar  = parseAmount(await page.locator(SEL.dpDollar).inputValue());
      const expectedLoan = homePrice - dpDollar; // 425,000 − 85,000 = 340,000

      await setupAmortTab(page);

      // The amortization tab must display exactly the principal borrowed.
      const displayed = parseAmount(await amortValue(page, /Loan amount/i).textContent());
      expect(displayed).toBe(expectedLoan);
    });

    test('total interest paid is within the expected range for a 7%, 30-year $340k loan', async ({ page }) => {
      // At 7% / 30 yr on $340 k: monthly P&I ≈ $2,263 → total paid ≈ $814,450
      // → total interest ≈ $474,450. Allow a ±$30 k window to absorb any
      // rounding differences in the amortization schedule.
      await setupAmortTab(page);

      const interest = parseAmount(await amortValue(page, /Total interest paid/i).textContent());
      expect(interest).toBeGreaterThan(440_000);
      expect(interest).toBeLessThan(510_000);
    });

    test('total cost of loan equals loan amount plus total interest paid', async ({ page }) => {
      // This verifies the calculator's own arithmetic, not an external formula.
      // All three values are read from the same tab panel and compared.
      await setupAmortTab(page);

      const loanAmount    = parseAmount(await amortValue(page, /Loan amount/i).textContent());
      const totalInterest = parseAmount(await amortValue(page, /Total interest paid/i).textContent());
      const totalCost     = parseAmount(await amortValue(page, /Total cost of loan/i).textContent());

      // The calculator displays all values as whole dollars, so the sum must
      // be exact. A ±$1 allowance covers any display-level rounding.
      expect(totalCost).toBeCloseTo(loanAmount + totalInterest, 0);
    });

    test('payoff date year matches current year plus 30-year loan term', async ({ page }) => {
      await setupAmortTab(page);

      // Displayed as "Mon YYYY" (e.g. "Mar 2056"). Extract the trailing year.
      const payoffText = (await amortValue(page, /Payoff date/i).textContent())?.trim() ?? '';
      const yearMatch  = payoffText.match(/(\d{4})$/);
      expect(yearMatch, `Payoff date "${payoffText}" should end with a 4-digit year`).toBeTruthy();

      const displayedYear = Number(yearMatch![1]);
      const expectedYear  = new Date().getFullYear() + 30; // e.g. 2026 + 30 = 2056
      expect(displayedYear).toBe(expectedYear);
    });
  });

  // ── 8. Extra Payments ──────────────────────────────────────────────────────
  //
  // The "Make extra payments" section lives in div.amort-container, always
  // visible on the Amortization tab (no expand interaction required).
  //
  // DOM structure of extra-payment inputs (none have id/data-test attributes):
  //
  //   Loan start date   — read-only vdp-datepicker, label for="date"
  //                       Interact: click input → calendar opens → click span.next
  //                       (year advance) → click desired span.cell.month
  //
  //   Monthly extra     — input inside the unique div.mb-4 in .amort-container
  //
  //   Yearly extra      — input following "Additional yearly payment" label
  //                       (same grid also has a month <select>)
  //
  //   One-time extra    — non-readonly input following "One-time additional
  //                       payment on" label (second input in grid is readonly
  //                       date picker → excluded via XPath not(@readonly))
  //
  // Recalculation: all extra-payment fields trigger client-side recalculation
  // on blur (Tab). No "Apply" button exists. Tests use toPass() polling on
  // Total interest paid as a readiness signal before asserting the other values.
  //
  // Each test captures baseline amortization values BEFORE entering an extra
  // payment and asserts that the new values are strictly reduced/earlier.

  test.describe('8. Extra Payments', () => {
    // All selectors scoped to .amort-container to avoid matching
    // identically-labelled elements elsewhere on the page.
    const EXTRA_CTR = '.amort-container';

    /**
     * Set deterministic inputs, navigate to the Amortization tab, and capture
     * the summary values BEFORE any extra payment is entered.
     * The returned baseline is used by every test as the comparison reference.
     */
    async function setupAmortTabWithBaseline(page: Page): Promise<AmortBaseline> {
      await clearAndFill(page, SEL.interestRate, '7');
      await page.locator(SEL.loanTerm).selectOption({ label: '30 years' });
      await clickUpdate(page);
      // readStablePayment waits for all async server calls (property tax, rate
      // lookups) to settle — safe to switch tabs only after this.
      await readStablePayment(page);
      await page.getByRole('tab', { name: 'Amortization' }).click();
      // captureAmortBaseline also waits for the Amortization tab to render.
      return captureAmortBaseline(page);
    }

    // ── 8a. Loan Start Date ─────────────────────────────────────────────────
    //
    // The loan start date field is a read-only vdp-datepicker (vue-datepicker).
    // Advancing the start date by N years must shift the payoff date by exactly
    // N years (same month, +N years) — a direct arithmetic relationship.

    test('changing the loan start date by +1 year shifts the payoff date by +1 year', async ({ page }) => {
      const baseline   = await setupAmortTabWithBaseline(page);
      const basePayoff = parsePayoffDate(baseline.payoff); // e.g. { year: 2056, monthIndex: 2 }

      // The loan start date read-only input (first vdp-datepicker in the container).
      const loanStartInput = page.locator(EXTRA_CTR + ' .vdp-datepicker input').first();
      const loanStartCal   = page.locator(EXTRA_CTR + ' .vdp-datepicker__calendar').first();

      // Read which month is currently selected so we can re-click it after
      // advancing the year (the calendar requires an explicit month click to confirm).
      const currentText = await loanStartInput.inputValue(); // e.g. "Mar 2026"
      const currentMon  = currentText.split(' ')[0];        // e.g. "Mar"

      // Open the calendar, advance year by +1, select the same month.
      await loanStartInput.click();
      await expect(loanStartCal).toBeVisible({ timeout: 3000 });
      await loanStartCal.locator('span.next').click(); // year +1 (e.g. 2026 → 2027)
      await loanStartCal.locator('span.cell.month', { hasText: currentMon }).click();

      // The calendar closes and payoff date should shift by exactly +1 year.
      // Month must stay the same — only the year changed.
      await expect(async () => {
        const txt = (await amortValue(page, /Payoff date/i).textContent())?.trim() ?? '';
        expect(parsePayoffDate(txt).year).toBe(basePayoff.year + 1);
      }).toPass({ timeout: 5000 });

      const updatedTxt = (await amortValue(page, /Payoff date/i).textContent())?.trim() ?? '';
      expect(parsePayoffDate(updatedTxt).monthIndex).toBe(basePayoff.monthIndex);
    });

    // ── 8b. Additional Monthly Payment ──────────────────────────────────────
    //
    // $200/month extra reduces the outstanding principal faster each month,
    // which lowers the interest accrued over the remaining loan life, reduces
    // the total cost, and shortens the loan term (earlier payoff).

    test('extra monthly payment of $200 reduces interest, total cost, and moves payoff date earlier', async ({ page }) => {
      const baseline = await setupAmortTabWithBaseline(page);

      // The monthly extra input is the only input inside the unique div.mb-4
      // within .amort-container (its label is nested inside that div).
      const monthlyExtraInput = page.locator(EXTRA_CTR + ' div.mb-4 input[type="text"]');
      await monthlyExtraInput.click({ clickCount: 3 });
      await monthlyExtraInput.fill('200');
      await monthlyExtraInput.press('Tab'); // blur triggers client-side recalculation

      // Poll until interest paid decreases — the signal that recalculation is done.
      await expect(async () => {
        const interest = parseAmount(await amortValue(page, /Total interest paid/i).textContent());
        expect(interest).toBeLessThan(baseline.interest);
      }).toPass({ timeout: 5000 });

      const newCost   = parseAmount(await amortValue(page, /Total cost of loan/i).textContent());
      const newPayoff = (await amortValue(page, /Payoff date/i).textContent())?.trim() ?? '';

      expect(newCost).toBeLessThan(baseline.cost);
      expect(payoffBefore(parsePayoffDate(newPayoff), parsePayoffDate(baseline.payoff))).toBe(true);
    });

    // ── 8c. Additional Yearly Payment ───────────────────────────────────────
    //
    // A $1,000/year lump sum applied once a year reduces principal more than
    // the equivalent monthly extra spread evenly, but the directional effect
    // (less interest, lower total cost, earlier payoff) is the same.

    test('extra yearly payment of $1,000 reduces interest, total cost, and moves payoff date earlier', async ({ page }) => {
      const baseline = await setupAmortTabWithBaseline(page);

      // The yearly extra amount is the first non-readonly input following the
      // "Additional yearly payment" label (the select for the month is not an input).
      const yearlyExtraInput = page
        .locator(EXTRA_CTR + ' label.FormLabel')
        .filter({ hasText: /additional yearly payment/i })
        .locator('xpath=following-sibling::div[1]//input[not(@readonly)][1]');

      await yearlyExtraInput.click({ clickCount: 3 });
      await yearlyExtraInput.fill('1000');
      // Pressing Tab moves focus to the month <select>. The calculator only
      // validates and applies a yearly payment when both a dollar amount AND an
      // application month are selected. Selecting the month fires change on the
      // select — this is what triggers recalculation.
      const yearlyMonthSelect = page.locator(EXTRA_CTR + ' select');
      await yearlyMonthSelect.selectOption('January');

      await expect(async () => {
        const interest = parseAmount(await amortValue(page, /Total interest paid/i).textContent());
        expect(interest).toBeLessThan(baseline.interest);
      }).toPass({ timeout: 5000 });

      const newCost   = parseAmount(await amortValue(page, /Total cost of loan/i).textContent());
      const newPayoff = (await amortValue(page, /Payoff date/i).textContent())?.trim() ?? '';

      expect(newCost).toBeLessThan(baseline.cost);
      expect(payoffBefore(parsePayoffDate(newPayoff), parsePayoffDate(baseline.payoff))).toBe(true);
    });

    // ── 8d. One-time Lump Sum Payment ───────────────────────────────────────
    //
    // A single $5,000 extra payment immediately reduces the principal, which
    // lowers every future interest charge for the remainder of the loan term.
    //
    // KEY BEHAVIOUR: The calculator ignores one-time payments dated at or before
    // the loan start month (current month). The date picker must be set to a
    // future date before the payment is applied. We advance the picker by +1 year
    // to guarantee the payment date is unambiguously in the future.

    test('one-time payment of $5,000 reduces interest, total cost, and moves payoff date earlier', async ({ page }) => {
      const baseline = await setupAmortTabWithBaseline(page);

      // The one-time amount is the first non-readonly input following the
      // "One-time additional payment on" label. The grid also contains a
      // readonly vdp-datepicker input, excluded here via not(@readonly).
      const onetimeExtraInput = page
        .locator(EXTRA_CTR + ' label.FormLabel')
        .filter({ hasText: /one-time additional payment/i })
        .locator('xpath=following-sibling::div[1]//input[not(@readonly)][1]');

      // The one-time payment date must be AFTER the loan start date for the
      // calculator to apply it. The loan starts in the current month, so any
      // date in the current year may be treated as past or at-start. We advance
      // the date picker to the next year (current month → +1 year) before
      // entering the amount, so the payment is unambiguously in the future.
      const onetimeDateInput = page.locator('[name="oneTimePayment"] input[name="date"]');
      const onetimeCal = page.locator('[name="oneTimePayment"] .vdp-datepicker__calendar');
      await onetimeDateInput.click(); // open the calendar
      await expect(onetimeCal).toBeVisible({ timeout: 3000 });
      // Read the current month text (e.g. "Mar 2026" → "Mar") before advancing,
      // because clicking span.next removes the .selected class from all cells.
      const currentDateText = await onetimeDateInput.inputValue(); // "Mar 2026"
      const currentMon = currentDateText.split(' ')[0];            // "Mar"
      await onetimeCal.locator('span.next').click();               // advance year by +1
      await onetimeCal.locator('span.cell.month', { hasText: currentMon }).click(); // same month, next year

      // Now enter the lump-sum amount and Tab away to trigger recalculation.
      await onetimeExtraInput.click({ clickCount: 3 });
      await onetimeExtraInput.fill('5000');
      await onetimeExtraInput.press('Tab');

      await expect(async () => {
        const interest = parseAmount(await amortValue(page, /Total interest paid/i).textContent());
        expect(interest).toBeLessThan(baseline.interest);
      }).toPass({ timeout: 5000 });

      const newCost   = parseAmount(await amortValue(page, /Total cost of loan/i).textContent());
      const newPayoff = (await amortValue(page, /Payoff date/i).textContent())?.trim() ?? '';

      expect(newCost).toBeLessThan(baseline.cost);
      expect(payoffBefore(parsePayoffDate(newPayoff), parsePayoffDate(baseline.payoff))).toBe(true);
    });
  });

  // ── 9. Amortization Schedule ───────────────────────────────────────────────
  //
  // The amortization schedule breakdown table lives in div.inline-table-container
  // below the amortization summary. DOM structure (confirmed via diagnostic):
  //
  //   Year rows: <tr> elements containing four <th> cells:
  //     th[0] → year label "2026" inside span.flex.cursor-pointer (expand toggle)
  //     th[1] → cumulative YTD principal paid
  //     th[2] → cumulative YTD interest paid
  //     th[3] → remaining balance at year end
  //   Selector: tr:has(th.py-2.pl-1.text-blue-600) — 31 rows for a 30-yr loan
  //
  //   Month rows: <tr class="hidden row"> with four <td> cells:
  //     td[0] → "Mon YYYY" date, td[1] → principal, td[2] → interest, td[3] → balance
  //   Initially display:none; made visible by the expand toggle or expand-all button.
  //
  //   Expand all: <button id="switch-one" role="switch" aria-checked="false">
  //   Clicking it toggles all month rows visible/hidden and flips aria-checked.
  //
  //   Individual year expand: click span.flex.cursor-pointer inside year row th[0].
  //
  //   Year values are CUMULATIVE YTD (not per-month). Last year balance = $0.00.
  //
  //   First payment datepicker (controls schedule start):
  //     .inline-table-container .vdp-datepicker input[type="text"]

  test.describe('9. Amortization Schedule', () => {
    // ── Selectors scoped to the schedule breakdown table ─────────────────────
    const SCHED_TABLE = '.inline-table-container .Table--numerical';
    const YEAR_ROW    = 'tr:has(th.py-2.pl-1.text-blue-600)';
    const MONTH_ROW   = 'tr.row';
    const EXPAND_BTN  = '#switch-one';

    function getYearRows(page: Page) {
      return page.locator(SCHED_TABLE).locator(YEAR_ROW);
    }

    function getMonthRows(page: Page) {
      return page.locator(SCHED_TABLE).locator(MONTH_ROW);
    }

    /**
     * Set 7% / 30yr, update, navigate to the Amortization tab, and wait for
     * the schedule table's first year row to be visible (render-complete gate).
     */
    async function setupScheduleTab(page: Page): Promise<void> {
      await clearAndFill(page, SEL.interestRate, '7');
      await page.locator(SEL.loanTerm).selectOption({ label: '30 years' });
      await clickUpdate(page);
      await readStablePayment(page);
      await page.getByRole('tab', { name: 'Amortization' }).click();
      await expect(page.locator(SCHED_TABLE).locator(YEAR_ROW).first())
        .toBeVisible({ timeout: 10_000 });
    }

    // ── 9a. Schedule Table Values ──────────────────────────────────────────

    test.describe('9a. Schedule Table Values', () => {
      test('first year row is visible and contains principal, interest, and balance', async ({ page }) => {
        await setupScheduleTab(page);

        const firstYearRow = getYearRows(page).first();
        await firstYearRow.scrollIntoViewIfNeeded();
        await expect(firstYearRow).toBeVisible();

        // All four columns must be present: date, principal, interest, balance.
        const ths = firstYearRow.locator('th');
        expect(await ths.count()).toBe(4);

        // The three value columns (principal, interest, balance) contain dollar amounts.
        for (let i = 1; i <= 3; i++) {
          const txt = await ths.nth(i).textContent();
          expect(txt).toContain('$');
        }
      });

      test('last year row has a near-zero remaining balance', async ({ page }) => {
        // The last year of a fully-amortizing loan must leave a $0 balance.
        await setupScheduleTab(page);

        const lastRow = getYearRows(page).last();
        await lastRow.scrollIntoViewIfNeeded();
        const balanceTxt = await lastRow.locator('th').nth(3).textContent();
        expect(parseAmount(balanceTxt)).toBeLessThanOrEqual(10); // ≤$10 for rounding
      });

      test('year row count spans the full 30-year loan term', async ({ page }) => {
        // A 30-yr loan starting mid-year spans 30 or 31 calendar years.
        await setupScheduleTab(page);

        const count = await getYearRows(page).count();
        expect(count).toBeGreaterThanOrEqual(30);
        expect(count).toBeLessThanOrEqual(31);
      });

      test('expanding the first year shows up to 12 monthly rows', async ({ page }) => {
        await setupScheduleTab(page);

        const firstYearRow = getYearRows(page).first();
        // Extract the 4-digit year from the first th (e.g. "2026").
        const yearLabel = (await firstYearRow.locator('th').first().textContent()) ?? '';
        const yearText  = (yearLabel.match(/\d{4}/) ?? [])[0] ?? '';

        // Month rows for this year are hidden by default.
        const monthRows = getMonthRows(page).filter({ hasText: yearText });
        await expect(monthRows.first()).not.toBeVisible();

        // Click the expand toggle (span.flex.cursor-pointer inside year th[0]).
        const expandSpan = firstYearRow.locator('span.flex.cursor-pointer');
        await expandSpan.scrollIntoViewIfNeeded();
        await expandSpan.click();

        // Month rows for this year should now be visible.
        await expect(monthRows.first()).toBeVisible({ timeout: 3000 });
        const monthCount = await monthRows.count();
        expect(monthCount).toBeGreaterThan(0);
        expect(monthCount).toBeLessThanOrEqual(12);
      });

      test('first month row: principal and interest are positive and sum to a plausible P&I amount', async ({ page }) => {
        // P&I for $340k at 7%/30yr ≈ $2,262/month. The month row shows only
        // P&I — not the total payment that includes taxes and insurance.
        await setupScheduleTab(page);

        // Use expand-all to access month rows without depending on individual toggle.
        const expandBtn = page.locator(EXPAND_BTN);
        await expandBtn.scrollIntoViewIfNeeded();
        await expandBtn.click();

        const firstMonthRow = getMonthRows(page).first();
        await expect(firstMonthRow).toBeVisible({ timeout: 5000 });

        const principal = parseAmount(await firstMonthRow.locator('td').nth(1).textContent());
        const interest  = parseAmount(await firstMonthRow.locator('td').nth(2).textContent());
        const sum = principal + interest;

        expect(principal).toBeGreaterThan(0);
        expect(interest).toBeGreaterThan(0);
        // Loose range covers any realistic 30-yr loan size and rate.
        expect(sum).toBeGreaterThan(1_000);
        expect(sum).toBeLessThan(5_000);
      });

      test('interest exceeds principal in the first month (early amortization behaviour)', async ({ page }) => {
        // In the early payments of a standard 30-yr loan, the bulk of each payment
        // goes to interest. This confirms the amortization direction is correct.
        await setupScheduleTab(page);

        const expandBtn = page.locator(EXPAND_BTN);
        await expandBtn.scrollIntoViewIfNeeded();
        await expandBtn.click();

        const firstMonthRow = getMonthRows(page).first();
        await expect(firstMonthRow).toBeVisible({ timeout: 5000 });

        const principal = parseAmount(await firstMonthRow.locator('td').nth(1).textContent());
        const interest  = parseAmount(await firstMonthRow.locator('td').nth(2).textContent());
        expect(interest).toBeGreaterThan(principal);
      });

      test('first year cumulative total principal + interest is within the expected range', async ({ page }) => {
        // Year values are cumulative YTD. For a loan starting mid-year, the first
        // year may contain as few as 1 month or as many as 12 months of payments.
        // Lower bound: 1 × $1,000 = $1,000. Upper bound: 12 × $4,000 = $48,000.
        await setupScheduleTab(page);

        const firstYearRow = getYearRows(page).first();
        const yearPrincipal = parseAmount(await firstYearRow.locator('th').nth(1).textContent());
        const yearInterest  = parseAmount(await firstYearRow.locator('th').nth(2).textContent());
        const yearTotal = yearPrincipal + yearInterest;

        expect(yearTotal).toBeGreaterThan(1_000);
        expect(yearTotal).toBeLessThan(50_000);
      });
    });

    // ── 9b. First Payment Change ───────────────────────────────────────────

    test.describe('9b. First Payment Change', () => {
      test('changing the first payment date by +1 year shifts the schedule start year', async ({ page }) => {
        await setupScheduleTab(page);

        const firstYearRow = getYearRows(page).first();
        // Capture the current start year (e.g. "2026").
        const baseYearLabel = (await firstYearRow.locator('th').first().textContent()) ?? '';
        const baseYear = Number((baseYearLabel.match(/\d{4}/) ?? ['0'])[0]);

        // The "First payment" datepicker controls the schedule (not the amort-container
        // loan start picker). It is the first vdp-datepicker in the schedule container.
        const dateInput = page
          .locator('.inline-table-container .vdp-datepicker input[type="text"]')
          .first();
        const dateCal = page
          .locator('.inline-table-container .vdp-datepicker__calendar')
          .first();

        const currentText = await dateInput.inputValue(); // e.g. "Apr 2026"
        const currentMon  = currentText.split(' ')[0];    // "Apr"

        await dateInput.click();
        await expect(dateCal).toBeVisible({ timeout: 3000 });
        await dateCal.locator('span.next').click(); // advance year by +1
        await dateCal.locator('span.cell.month', { hasText: currentMon }).click();

        // The first year row in the schedule should now show the next year.
        await expect(async () => {
          const newLabel = (await getYearRows(page).first().locator('th').first().textContent()) ?? '';
          const newYear  = Number((newLabel.match(/\d{4}/) ?? ['0'])[0]);
          expect(newYear).toBeGreaterThan(baseYear);
        }).toPass({ timeout: 5000 });
      });
    });

    // ── 9c. Expand / Collapse All ──────────────────────────────────────────

    test.describe('9c. Expand / Collapse All', () => {
      test('monthly rows are hidden by default', async ({ page }) => {
        await setupScheduleTab(page);
        // Month rows have display:none until expanded — Playwright treats them as not visible.
        await expect(getMonthRows(page).first()).not.toBeVisible();
      });

      test('clicking expand all reveals monthly rows for first, middle, and last years', async ({ page }) => {
        await setupScheduleTab(page);

        const expandBtn = page.locator(EXPAND_BTN);
        await expandBtn.scrollIntoViewIfNeeded();
        await expandBtn.click();

        // Spot-check three years: start, midpoint, and end of the 30-yr term.
        const startYear  = String(new Date().getFullYear());
        const middleYear = String(new Date().getFullYear() + 15);
        const endYear    = String(new Date().getFullYear() + 30);

        for (const yr of [startYear, middleYear, endYear]) {
          const rows = getMonthRows(page).filter({ hasText: yr });
          await expect(rows.first()).toBeVisible({ timeout: 5000 });
        }
      });

      test('clicking collapse all hides monthly rows again', async ({ page }) => {
        await setupScheduleTab(page);

        const expandBtn = page.locator(EXPAND_BTN);
        await expandBtn.scrollIntoViewIfNeeded();

        // Expand all → rows visible.
        await expandBtn.click();
        await expect(getMonthRows(page).first()).toBeVisible({ timeout: 3000 });

        // Collapse all → rows hidden again.
        await expandBtn.click();
        await expect(getMonthRows(page).first()).not.toBeVisible({ timeout: 3000 });
      });

      test('toggle button aria-checked flips between false and true on each click', async ({ page }) => {
        await setupScheduleTab(page);

        const expandBtn = page.locator(EXPAND_BTN);
        await expandBtn.scrollIntoViewIfNeeded();

        // Initially collapsed: aria-checked = "false".
        await expect(expandBtn).toHaveAttribute('aria-checked', 'false');

        // After expand: aria-checked = "true".
        await expandBtn.click();
        await expect(expandBtn).toHaveAttribute('aria-checked', 'true', { timeout: 3000 });

        // After collapse: aria-checked = "false" again.
        await expandBtn.click();
        await expect(expandBtn).toHaveAttribute('aria-checked', 'false', { timeout: 3000 });
      });
    });
  });

  // ── 6. Input Validation ────────────────────────────────────────────────────

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
