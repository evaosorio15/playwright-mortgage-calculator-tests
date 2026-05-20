// ─── What is this file? ───────────────────────────────────────────────────────
//
// This is the Playwright configuration file. It tells Playwright HOW to run
// your tests — which browsers to use, how many tests to run at once, what
// to do when a test fails, and where to find the test files.
//
// You only need to change this file if you want to adjust how the whole test
// suite behaves (e.g., add a new browser, change the retry count, etc.).
// You don't need to touch it just to add or modify individual tests.
//
// ─────────────────────────────────────────────────────────────────────────────

import { defineConfig, devices } from '@playwright/test';

/**
 * Read environment variables from file.
 * https://github.com/motdotla/dotenv
 */
// import dotenv from 'dotenv';
// import path from 'path';
// dotenv.config({ path: path.resolve(__dirname, '.env') });

/**
 * See https://playwright.dev/docs/test-configuration.
 */
export default defineConfig({
  // Where Playwright looks for test files. Every .spec.ts file inside the
  // "tests" folder will be automatically picked up and run.
  testDir: './tests',

  /* Run tests in files in parallel */
  // Run all tests at the same time instead of one after another. This makes
  // the full test run much faster when you have many tests.
  fullyParallel: true,

  /* Fail the build on CI if you accidentally left test.only in the source code. */
  // "test.only" is a shortcut developers use during debugging to run just one
  // test. This setting prevents accidentally leaving it in when pushing code to
  // a CI (Continuous Integration) server — if found, the whole run fails loudly
  // instead of silently skipping all other tests.
  // process.env.CI is a variable that CI servers set automatically; locally it
  // is undefined, so this restriction only applies when running in CI.
  forbidOnly: !!process.env.CI,

  /* Retry on CI only */
  // If a test fails, how many extra times should Playwright try it before
  // giving up? On CI we allow 2 retries to absorb flaky network conditions.
  // Locally we set it to 0 so failures are immediately visible.
  retries: process.env.CI ? 2 : 0,

  /* Opt out of parallel tests on CI. */
  // How many browser windows (workers) to open simultaneously. On CI we use
  // only 1 to avoid resource contention. Locally, "undefined" lets Playwright
  // choose automatically based on your CPU cores.
  workers: process.env.CI ? 1 : undefined,

  /* Reporter to use. See https://playwright.dev/docs/test-reporters */
  // How Playwright reports the results after the run. 'html' generates a pretty
  // web page (open with "npx playwright show-report") showing pass/fail, timing,
  // screenshots, and traces. Great for reviewing results visually.
  reporter: 'html',

  /* Shared settings for all the projects below. See https://playwright.dev/docs/api/class-testoptions. */
  use: {
    /* Base URL to use in actions like `await page.goto('')`. */
    // baseURL: 'http://localhost:3000',

    /* Collect trace when retrying the failed test. See https://playwright.dev/docs/trace-viewer */
    // A "trace" is a detailed recording of everything that happened during a
    // test run — every click, every network request, every screenshot. It's like
    // a black box flight recorder for your test. 'on-first-retry' means: only
    // record a trace when a test fails and is being retried, so you can open the
    // trace viewer to debug exactly what went wrong.
    trace: 'on-first-retry',
  },

  /* Configure projects for major browsers */
  // Each "project" tells Playwright to run ALL of your tests in a specific
  // browser. By having three projects below, every test runs three times —
  // once in Chrome, once in Firefox, once in Safari — to catch bugs that
  // only appear in certain browsers.
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },  // simulates a desktop Chrome browser
    },

    {
      name: 'firefox',
      use: { ...devices['Desktop Firefox'] }, // simulates a desktop Firefox browser
    },

    {
      name: 'webkit',
      use: { ...devices['Desktop Safari'] },  // simulates a desktop Safari browser
    },

    /* Test against mobile viewports. */
    // {
    //   name: 'Mobile Chrome',
    //   use: { ...devices['Pixel 5'] },
    // },
    // {
    //   name: 'Mobile Safari',
    //   use: { ...devices['iPhone 12'] },
    // },

    /* Test against branded browsers. */
    // {
    //   name: 'Microsoft Edge',
    //   use: { ...devices['Desktop Edge'], channel: 'msedge' },
    // },
    // {
    //   name: 'Google Chrome',
    //   use: { ...devices['Desktop Chrome'], channel: 'chrome' },
    // },
  ],

  /* Run your local dev server before starting the tests */
  // webServer: {
  //   command: 'npm run start',
  //   url: 'http://localhost:3000',
  //   reuseExistingServer: !process.env.CI,
  // },
});
