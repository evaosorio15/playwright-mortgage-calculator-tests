import { test, expect, type Page } from '@playwright/test';
import {
  CALCULATOR_URL,
  SEL,
  dismissCookieBanner,
  clearAndFill,
  clickUpdate,
  readStablePayment,
  parseAmount,
  amortValue,
  parsePayoffDate,
  payoffBefore,
  captureAmortBaseline,
  type AmortBaseline,
} from './helpers';

test.describe('Bankrate Mortgage Calculator — Amortization Summary', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(CALCULATOR_URL, { waitUntil: 'domcontentloaded' });
    await expect(page.locator(SEL.homePrice)).toBeVisible({ timeout: 20_000 });
    await dismissCookieBanner(page);
  });

  // ── 7. Amortization Tab ───────────────────────────────────────────────────
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
  // Tests use a fixed rate (7%) with the default home price and default 20%
  // down payment ($425 k − $85 k = $340 k loan) so assertions are
  // deterministic. Because homePrice is NOT changed, Vue's internal homePrice
  // stays at the confirmed default — the homePrice-lock issue does not apply here.
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

  // ── 8. Extra Payments ─────────────────────────────────────────────────────
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

    // ── 8a. Loan Start Date ────────────────────────────────────────────────
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

    // ── 8b. Additional Monthly Payment ────────────────────────────────────
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

    // ── 8c. Additional Yearly Payment ─────────────────────────────────────
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

    // ── 8d. One-time Lump Sum Payment ─────────────────────────────────────
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
});
