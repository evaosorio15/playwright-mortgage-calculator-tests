// ─── What is this file? ───────────────────────────────────────────────────────
//
// This file tests the export features available on the Amortization tab:
//
//  1. "Export as CSV" — downloads the full amortization schedule as a
//     spreadsheet file that you can open in Excel or Google Sheets.
//
//  2. "Printer-friendly version" — triggers a print dialog so you can
//     print the schedule or save it as a PDF.
//
// These tests are more complex than the others because they involve file
// downloads and browser APIs. Read the comments below for plain-English
// explanations of each technique used.
//
// ─────────────────────────────────────────────────────────────────────────────

import { test, expect, type Page } from '@playwright/test';
import * as fs   from 'fs';   // Node.js built-in for reading/writing files
import * as path from 'path'; // Node.js built-in for joining file path strings
import * as os   from 'os';   // Node.js built-in for finding the OS temp directory
import {
  CALCULATOR_URL,
  SEL,
  dismissCookieBanner,
  clearAndFill,
  clickUpdate,
  readStablePayment,
} from './helpers';

test.describe('Bankrate Mortgage Calculator — Export Features', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(CALCULATOR_URL, { waitUntil: 'domcontentloaded' });
    await expect(page.locator(SEL.homePrice)).toBeVisible({ timeout: 20_000 });
    await dismissCookieBanner(page);
  });

  // ── 10a. CSV Export ───────────────────────────────────────────────────────
  //
  // "Export as CSV" is an <a> element at the bottom of div.inline-table-container.
  // The file is generated entirely client-side — no server round-trip — and
  // triggers a browser download event. Confirmed structure (7% / 30yr):
  //
  //   Filename:  amortization-schedule-breakdown-{M_D_YYYY}.csv
  //   Delimiter: comma (no quoting; values are raw floats, not currency strings)
  //   Columns (9, 0-indexed):
  //     0=date, 1=year, 2=month, 3=balance, 4=interest, 5=payment,
  //     6=principal, 7=totalInterest, 8=totalPrincipal
  //   Rows: 1 header + 360 data rows (Apr 2026 → Mar 2056 for a loan starting
  //         in the current month)
  //   Last balance: floating-point residual ≈ 0 (e.g. 8.96e-11), not exactly 0.
  //
  // These tests depend on Playwright's download interception, which works
  // reliably in headless Chromium, Firefox, and WebKit but may behave
  // differently in headed mode depending on OS download settings.

  test.describe('10a. CSV Export', () => {
    /**
     * Navigate to the Amortization tab with deterministic inputs (7% / 30yr),
     * wait for the CSV link, click it, save the downloaded file to a uniquely-
     * named temp path, parse the content into headers + rows, delete the temp
     * file, and return the parsed result.
     *
     * The download listener is registered BEFORE clicking — the required order
     * for Playwright's waitForEvent('download') to capture the event reliably.
     *
     * What is a CSV file?
     * CSV stands for "Comma-Separated Values". It's a plain text format for
     * spreadsheet data where each row is on its own line and columns are
     * separated by commas. For example:
     *   date,balance,interest,payment,principal
     *   Apr 2026,339720.45,1983.33,2263.45,280.12
     * Any spreadsheet app (Excel, Google Sheets) can open a CSV file directly.
     *
     * Why register the download listener BEFORE clicking?
     * Playwright's waitForEvent('download') works by setting up a listener that
     * waits for the browser to trigger a download event. If we clicked first
     * and THEN called waitForEvent, the download might happen so quickly that
     * the event fires before our listener is ready — and we'd miss it. By
     * setting up the listener first (as a Promise that hasn't been awaited yet),
     * we guarantee it's ready to catch the event the instant the click fires.
     *
     * Why a temp file?
     * Playwright intercepts the download but doesn't automatically save it to
     * disk. We call download.saveAs() to write it to a temporary location so
     * we can read its contents with Node's fs.readFileSync(). After reading,
     * we delete it with fs.unlinkSync() to keep the system clean — "best effort"
     * because the test should still pass even if the cleanup fails.
     */
    async function downloadCsv(page: Page): Promise<{
      filename: string;
      headers: string[];
      rows:    string[][];
    }> {
      await clearAndFill(page, SEL.interestRate, '7');
      await page.locator(SEL.loanTerm).selectOption({ label: '30 years' });
      await clickUpdate(page);
      await readStablePayment(page);
      await page.getByRole('tab', { name: 'Amortization' }).click();

      const csvLink = page.locator('.inline-table-container a')
        .filter({ hasText: /export as csv/i });
      await csvLink.waitFor({ state: 'visible', timeout: 10_000 });
      await csvLink.scrollIntoViewIfNeeded();

      // Register the download listener BEFORE clicking (see explanation above).
      const downloadPromise = page.waitForEvent('download');
      await csvLink.click();
      const download = await downloadPromise;

      const filename = download.suggestedFilename();
      // os.tmpdir() gives us the operating system's temp folder (e.g. C:\Temp on
      // Windows, /tmp on Mac/Linux). We add a timestamp to the filename so that
      // if two tests run at the same time they don't overwrite each other's file.
      const tmpFile  = path.join(os.tmpdir(), `pw-amort-${Date.now()}.csv`);
      await download.saveAs(tmpFile);

      const raw   = fs.readFileSync(tmpFile, 'utf-8');
      try { fs.unlinkSync(tmpFile); } catch { /* best-effort cleanup */ }

      // Split the file into lines, discard empty ones, then split each line by
      // comma to get individual cell values. The first line is the header row;
      // the rest are data rows. We return all three pieces for tests to use.
      const lines   = raw.split('\n').filter(l => l.trim().length > 0);
      const headers = lines[0].split(',').map(h => h.trim());
      const rows    = lines.slice(1).map(l => l.split(',').map(c => c.trim()));
      return { filename, headers, rows };
    }

    test('download is triggered and filename ends with .csv', async ({ page }) => {
      const { filename } = await downloadCsv(page);
      // The suggested filename varies by environment (e.g. full date-stamped name
      // locally vs. a shorter name in CI). Only assert the extension is reliable.
      expect(filename.toLowerCase()).toMatch(/\.csv$/);
    });

    test('header row contains the expected column names', async ({ page }) => {
      const { headers } = await downloadCsv(page);
      const lower = headers.map(h => h.toLowerCase());
      // Confirmed columns from the live page; these are the minimum required set.
      for (const col of ['date', 'balance', 'interest', 'payment', 'principal']) {
        expect(lower, `Expected column "${col}" in headers ${JSON.stringify(lower)}`).toContain(col);
      }
    });

    test('file contains approximately 360 data rows for a 30-year loan', async ({ page }) => {
      const { rows } = await downloadCsv(page);
      // A 30-yr mortgage = 360 monthly payments. A small tolerance (±5) covers
      // loans that start mid-month and include a partial first or last year.
      expect(rows.length).toBeGreaterThanOrEqual(355);
      expect(rows.length).toBeLessThanOrEqual(365);
    });

    test('first data row values are parseable as positive numbers', async ({ page }) => {
      const { rows } = await downloadCsv(page);
      // Column indices: 3=balance, 4=interest, 5=payment, 6=principal
      // Why index 3, 4, 5, 6? CSV columns are numbered from 0. The CSV has
      // these columns in order: 0=date, 1=year, 2=month, 3=balance, 4=interest,
      // 5=payment, 6=principal, 7=totalInterest, 8=totalPrincipal.
      // So rows[0][3] means "first data row, balance column".
      const first     = rows[0];
      const balance   = Number(first[3]);
      const interest  = Number(first[4]);
      const payment   = Number(first[5]);
      const principal = Number(first[6]);

      expect(Number.isFinite(balance),   'balance should be a finite number').toBe(true);
      expect(Number.isFinite(interest),  'interest should be a finite number').toBe(true);
      expect(Number.isFinite(payment),   'payment should be a finite number').toBe(true);
      expect(Number.isFinite(principal), 'principal should be a finite number').toBe(true);

      expect(balance).toBeGreaterThan(0);
      expect(interest).toBeGreaterThan(0);
      expect(payment).toBeGreaterThan(0);
      expect(principal).toBeGreaterThan(0);
    });

    test('last data row remaining balance is effectively zero after the final payment', async ({ page }) => {
      const { rows } = await downloadCsv(page);
      const last    = rows[rows.length - 1];
      const balance = Number(last[3]); // column 3 = balance
      // Floating-point arithmetic leaves a residual (e.g. 8.96e-11) rather than
      // an exact 0. Any value with |balance| < $1 counts as fully paid off.
      //
      // Why isn't the final balance exactly $0.00?
      // Computers store decimal numbers using binary (base-2) arithmetic, which
      // cannot represent most decimal fractions exactly — similar to how 1/3 in
      // decimal is 0.333... and never ends. After 360 months of mortgage
      // calculations, these tiny rounding errors accumulate to a tiny residual
      // like 0.0000000000896 dollars. We use Math.abs(balance) < 1 to treat
      // any amount under a dollar as "effectively zero" (fully paid off).
      expect(Math.abs(balance)).toBeLessThan(1);
    });
  });

  // ── 10b. Printer-Friendly Version ─────────────────────────────────────────
  //
  // The "Printer-friendly version" link calls window.print() directly inside
  // the current browser tab. It does NOT open a new tab or window — confirmed
  // by diagnostic: window.open is never invoked. Tests intercept window.print()
  // before clicking to suppress the OS print dialog in headless runs, then
  // verify the call was made and the page content remains intact afterwards.

  // ── 10b. Printer-Friendly Version ─────────────────────────────────────────
  //
  // The "Printer-friendly version" link calls window.print() directly inside
  // the current browser tab. It does NOT open a new tab or window — confirmed
  // by diagnostic: window.open is never invoked. Tests intercept window.print()
  // before clicking to suppress the OS print dialog in headless runs, then
  // verify the call was made and the page content remains intact afterwards.
  //
  // What is window.print()? It's a built-in browser function that opens the
  // operating system's print dialog — the same box you'd see if you pressed
  // Ctrl+P in your browser. In a headless test (no visible browser window),
  // this dialog would either hang the test or cause an OS-level interruption.
  // We replace window.print with our own no-op function to prevent this, while
  // still being able to verify that the link actually called it.

  test.describe('10b. Printer-Friendly Version', () => {
    /**
     * Set deterministic inputs (7% / 30yr), navigate to the Amortization tab,
     * and wait for the printer-friendly link to be visible.
     */
    async function setupForPrint(page: Page): Promise<void> {
      await clearAndFill(page, SEL.interestRate, '7');
      await page.locator(SEL.loanTerm).selectOption({ label: '30 years' });
      await clickUpdate(page);
      await readStablePayment(page);
      await page.getByRole('tab', { name: 'Amortization' }).click();
      await page.locator('.inline-table-container a')
        .filter({ hasText: /printer-friendly/i })
        .waitFor({ state: 'visible', timeout: 10_000 });
    }

    test('clicking the link triggers window.print()', async ({ page }) => {
      await setupForPrint(page);

      // Replace window.print with a no-op tracker BEFORE clicking so that
      // no OS print dialog appears and the call can be asserted afterwards.
      //
      // page.evaluate() runs a snippet of JavaScript directly inside the browser
      // (not in Node.js). Here we're doing two things:
      //   1. Creating a custom variable (__printCalled) on the window object to
      //      track whether print() was called.
      //   2. Replacing the real window.print function with our own function that
      //      just sets __printCalled = true without opening any dialog.
      // After clicking the link, we read __printCalled back from the browser to
      // verify the link actually invoked print().
      await page.evaluate(() => {
        (window as any).__printCalled = false;
        window.print = () => { (window as any).__printCalled = true; };
      });

      const printLink = page.locator('.inline-table-container a')
        .filter({ hasText: /printer-friendly/i });
      await printLink.scrollIntoViewIfNeeded();
      await printLink.click();

      const printCalled = await page.evaluate(
        () => (window as any).__printCalled as boolean,
      );
      expect(printCalled).toBe(true);
    });

    test('amortization schedule content is intact after the print call', async ({ page }) => {
      await setupForPrint(page);

      // Suppress the OS print dialog — the page renders the same either way.
      await page.evaluate(() => { window.print = () => {}; });

      const printLink = page.locator('.inline-table-container a')
        .filter({ hasText: /printer-friendly/i });
      await printLink.scrollIntoViewIfNeeded();
      await printLink.click();

      // The page must remain on the Amortization tab with the schedule visible.
      await expect(
        page.locator('h2').filter({ hasText: /amortization schedule breakdown/i }),
      ).toBeVisible({ timeout: 3000 });

      // Both export controls must still be present (no unintended navigation).
      await expect(
        page.locator('.inline-table-container a').filter({ hasText: /export as csv/i }),
      ).toBeVisible();
    });
  });
});
