import { expect, type Page } from '@playwright/test';

export const CALCULATOR_URL = 'https://www.bankrate.com/mortgages/mortgage-calculator/';

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
export const SEL = {
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
export async function dismissCookieBanner(page: Page): Promise<void> {
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
export async function clearAndFill(page: Page, selector: string, value: string): Promise<void> {
  const input = page.locator(selector);
  await input.click({ clickCount: 3 });
  await input.fill(value);
  await input.press('Tab');
}

/**
 * Click the "Update" button and give the calculator a moment to start its
 * async recalculation (property-tax and rate look-ups fire server requests).
 */
export async function clickUpdate(page: Page): Promise<void> {
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
export async function readStablePayment(page: Page): Promise<string> {
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
export function parseAmount(text: string | null | undefined): number {
  return Number((text ?? '').replace(/[^0-9.]/g, ''));
}

// ─── Amortization helpers (shared by amortization-summary and amortization-schedule) ─

/**
 * Return the value display element for an amortization summary item.
 *
 * Two DOM shapes exist in the summary grid:
 *   Loan amount:  span.text-gray-700 label inside a tooltip wrapper → value in sibling div
 *   Other items:  p.text-gray-700 label directly sibling to the value div
 * XPath walks up to the first ancestor <div> that contains a type-heading-three
 * descendant, then returns that descendant — works for both shapes.
 */
export function amortValue(page: Page, label: string | RegExp) {
  return page
    .locator('p.text-gray-700, span.text-gray-700')
    .filter({ hasText: label })
    .first()
    .locator('xpath=ancestor::div[.//div[contains(@class,"type-heading-three")]][1]//div[contains(@class,"type-heading-three")][1]');
}

/** Parse a payoff date string "Mon YYYY" into a comparable {year, monthIndex}. */
export function parsePayoffDate(text: string): { year: number; monthIndex: number } {
  const MONTHS = ['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'];
  const [mon = '', yr = '0'] = text.trim().split(/\s+/);
  return { year: Number(yr), monthIndex: MONTHS.indexOf(mon.toLowerCase()) };
}

/** Return true when date a is strictly earlier than date b. */
export function payoffBefore(
  a: { year: number; monthIndex: number },
  b: { year: number; monthIndex: number },
): boolean {
  return a.year < b.year || (a.year === b.year && a.monthIndex < b.monthIndex);
}

export interface AmortBaseline {
  interest: number; // Total interest paid
  cost:     number; // Total cost of loan
  payoff:   string; // Payoff date raw text e.g. "Mar 2056"
}

/**
 * Capture the amortization summary values from the Amortization tab.
 * Call BEFORE making any extra-payment changes — the returned values serve
 * as the "no extra payments" baseline for comparison assertions.
 */
export async function captureAmortBaseline(page: Page): Promise<AmortBaseline> {
  await expect(amortValue(page, /Loan amount/i)).toBeVisible({ timeout: 8_000 });
  const interest = parseAmount(await amortValue(page, /Total interest paid/i).textContent());
  const cost     = parseAmount(await amortValue(page, /Total cost of loan/i).textContent());
  const payoff   = (await amortValue(page, /Payoff date/i).textContent())?.trim() ?? '';
  return { interest, cost, payoff };
}
