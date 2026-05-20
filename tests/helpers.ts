// ─── What is this file? ───────────────────────────────────────────────────────
//
// This is a shared "toolkit" file. It contains selectors, constants, and
// helper functions that are used by ALL of the test files. Instead of copying
// the same code into every test file, we define it once here and import it.
//
// Think of it like a toolbox: a hammer defined here can be picked up and used
// in any room (test file) of the house.
//
// ─────────────────────────────────────────────────────────────────────────────

import { expect, type Page } from '@playwright/test';

export const CALCULATOR_URL = 'https://www.bankrate.com/mortgages/mortgage-calculator/';

// ─── Selectors ───────────────────────────────────────────────────────────────
//
// What is a "selector"?
// A selector is like an address for a specific element on a web page. Just as
// you'd use a street address to find a building, Playwright uses selectors to
// find buttons, input fields, and other elements on the page before interacting
// with them. The selectors below use CSS syntax (e.g., '#homePrice' means "the
// element with id=homePrice") or custom Playwright syntax like ':text-is()'.
//
// These selectors were verified against the live Bankrate page. The page is
// built with Vue.js, which renders its HTML dynamically in the browser — so we
// have to wait for the page to finish loading before selectors will work.
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
  // '#homePrice' targets the element whose HTML id attribute is "homePrice" —
  // this is the main home price input field at the top of the calculator.
  homePrice:      '#homePrice',

  // The interest rate input field (annual percentage).
  interestRate:   '#interestRate',

  // Loan term: the <select> id is auto-generated; scope to its stable data-test wrapper.
  // The loan term is a dropdown (<select>). Its id changes between page loads, so
  // we target it via a more stable "data-test" attribute on its parent container.
  loanTerm:       '[data-test="loanProduct"] select',

  // Down-payment inputs live in separate data-test wrappers.
  // The down payment can be entered as either a dollar amount OR a percentage.
  // Both fields exist on the page at the same time and stay in sync with each other.
  dpDollar:       'div[data-test="downPaymentAmount"] input',
  dpPercent:      'div[data-test="downPaymentPercent"] input',

  // Primary monthly-payment display in the amortisation chart.
  // This is the large dollar figure shown in the results area after clicking Update.
  monthlyPayment: '.Amortization-chart .Numeral.type-heading-two',

  // Submit button. :text-is() matches the exact trimmed visible text.
  // Using :text-is("Update") ensures we only match the calculator's Update button
  // and not other buttons on the page that happen to share the same CSS class.
  updateBtn:      'button:text-is("Update")',

  // The outer container div of the whole calculator widget.
  calculator:     'div.calculator',

  // The cookie consent banner that appears at the bottom of the page. We need
  // to dismiss it before interacting with the calculator, because it can block
  // clicks on elements that appear behind it.
  cookieBanner:   '#onetrust-banner-sdk',
  cookieClose:    'button.onetrust-close-btn-handler.banner-close-button',
} as const;

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Dismiss the OneTrust cookie banner if it appears.
 *
 * Why is this needed? Many websites show a cookie consent popup the first time
 * you visit them. This banner floats on top of the page and can physically block
 * Playwright from clicking on the calculator inputs underneath it. We dismiss it
 * at the start of every test so the rest of the test can interact freely.
 *
 * The try/catch is intentional: if the banner doesn't appear (e.g., it was
 * already dismissed, or the page loaded differently), we just move on quietly
 * instead of crashing the test.
 */
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
 *
 * Why triple-click? The calculator displays numbers with commas (e.g. "425,000").
 * If you just click once and start typing, you might end up with "4|25,000" and
 * only overwrite part of the value. Triple-clicking the input selects ALL of the
 * existing text first, so our new value completely replaces it.
 *
 * Why press Tab? Pressing Tab moves focus away from the input (called "blur").
 * This is the signal the calculator uses to sync related fields — for example,
 * when you leave the down-payment dollar field, it recalculates the percentage.
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
 *
 * Why the short pause? After clicking Update, the calculator immediately kicks
 * off network requests to a server (to look up property tax rates, current
 * mortgage rates, etc.). The 500 ms pause gives those requests a moment to
 * start so that subsequent code (like readStablePayment) can then wait for
 * them to finish. Without any pause, we might check the result too quickly and
 * see the old value before the update has even begun.
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
 *
 * Why polling instead of just waiting a fixed time?
 * After clicking Update, the calculator fetches updated property tax and rate
 * data from a server. We don't know exactly how long that takes — it depends
 * on network speed. Instead of guessing a fixed wait (e.g., "wait 3 seconds"),
 * we "poll": check the displayed payment every 600 ms, and as soon as two
 * consecutive checks show the same value, we know it has stabilized and is
 * no longer changing. This is faster when the network is quick and more
 * reliable when it's slow.
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

/**
 * Strip currency symbols, commas, and whitespace; return a plain JS number.
 *
 * The calculator displays money as formatted strings like "$1,234.56". To do
 * math on these values (e.g., compare two payments), we need to convert them
 * to plain numbers first.
 *
 * How it works: the regex /[^0-9.]/g means "match any character that is NOT
 * a digit (0-9) or a decimal point (.)". Calling .replace() with that regex
 * removes every such character from the string, leaving only digits and dots.
 * For example: "$1,234.56" → "1234.56" → Number("1234.56") = 1234.56.
 */
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
 *
 * What is XPath? XPath is an older but powerful language for navigating HTML
 * structure. While CSS selectors can only look "downward" (from parent to child),
 * XPath can look in any direction — including UP to a parent element and then
 * back DOWN to a sibling. Here we use it to:
 *   1. Start at the label text (e.g., "Total interest paid")
 *   2. Walk UP the tree to find a containing <div> that has a bold value inside
 *   3. Return that bold value element
 * This handles the fact that some labels have a slightly different HTML structure
 * than others, without needing a separate selector for each.
 */
export function amortValue(page: Page, label: string | RegExp) {
  return page
    .locator('p.text-gray-700, span.text-gray-700')
    .filter({ hasText: label })
    .first()
    .locator('xpath=ancestor::div[.//div[contains(@class,"type-heading-three")]][1]//div[contains(@class,"type-heading-three")][1]');
}

/**
 * Parse a payoff date string "Mon YYYY" into a comparable {year, monthIndex}.
 *
 * The calculator displays payoff dates as human-readable text like "Mar 2056".
 * To compare two payoff dates (e.g., check that an extra payment makes you
 * pay off the loan earlier), we need to convert them into numbers we can
 * compare mathematically. This function splits the string and returns:
 *   { year: 2056, monthIndex: 2 }  ← 2 because March is the 3rd month (0-indexed)
 */
export function parsePayoffDate(text: string): { year: number; monthIndex: number } {
  const MONTHS = ['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'];
  const [mon = '', yr = '0'] = text.trim().split(/\s+/);
  return { year: Number(yr), monthIndex: MONTHS.indexOf(mon.toLowerCase()) };
}

/**
 * Return true when date a is strictly earlier than date b.
 *
 * How the comparison works: first compare the years. If year A is earlier than
 * year B, A is definitely before B. If they're the same year, compare the
 * month numbers (0=Jan, 11=Dec). This two-level comparison correctly handles
 * cases like "Dec 2055" being earlier than "Jan 2056" despite December's month
 * number (11) being larger than January's (0).
 */
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
 *
 * What is a "baseline"?
 * A baseline is a snapshot of the "before" state — the values when nothing
 * special has been done yet. After we make a change (like adding extra monthly
 * payments), we compare the new values to this baseline to confirm the change
 * had the expected effect (e.g., "total interest is now LESS than the baseline").
 * Without a baseline, we couldn't tell whether a change made things better,
 * worse, or had no effect at all.
 */
export async function captureAmortBaseline(page: Page): Promise<AmortBaseline> {
  await expect(amortValue(page, /Loan amount/i)).toBeVisible({ timeout: 8_000 });
  const interest = parseAmount(await amortValue(page, /Total interest paid/i).textContent());
  const cost     = parseAmount(await amortValue(page, /Total cost of loan/i).textContent());
  const payoff   = (await amortValue(page, /Payoff date/i).textContent())?.trim() ?? '';
  return { interest, cost, payoff };
}
