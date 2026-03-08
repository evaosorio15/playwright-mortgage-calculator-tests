import { test, expect, type Page } from '@playwright/test';
import {
  CALCULATOR_URL,
  SEL,
  dismissCookieBanner,
  clearAndFill,
  clickUpdate,
  readStablePayment,
  parseAmount,
} from './helpers';

// ─── Schedule selectors (scoped to the breakdown table) ──────────────────────
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

test.describe('Bankrate Mortgage Calculator — Amortization Schedule', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(CALCULATOR_URL, { waitUntil: 'domcontentloaded' });
    await expect(page.locator(SEL.homePrice)).toBeVisible({ timeout: 20_000 });
    await dismissCookieBanner(page);
  });

  // ── 9. Amortization Schedule ──────────────────────────────────────────────

  test.describe('9. Amortization Schedule', () => {
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

    // ── 9b. First Payment Change ──────────────────────────────────────────

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

    // ── 9c. Expand / Collapse All ─────────────────────────────────────────

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
});
