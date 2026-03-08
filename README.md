# Playwright Mortgage Calculator Tests

> End-to-end test suite for a live, production mortgage calculator — built to demonstrate real-world Playwright automation against a dynamic, third-party Vue.js application.

![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?style=flat&logo=typescript&logoColor=white)
![Playwright](https://img.shields.io/badge/Playwright-2EAD33?style=flat&logo=playwright&logoColor=white)
![Node.js](https://img.shields.io/badge/Node.js-339933?style=flat&logo=node.js&logoColor=white)
![Browsers](https://img.shields.io/badge/Browsers-Chromium%20%7C%20Firefox%20%7C%20WebKit-blue?style=flat)

---

## About

This project is an end-to-end test suite targeting the [Bankrate Mortgage Calculator](https://www.bankrate.com/mortgages/mortgage-calculator/) — a client-side rendered Vue.js application with async server calls, reactive state, and a cookie consent overlay. The tests validate core calculator behaviors across 10 functional areas and run on all three major browser engines.

Writing tests against a live third-party app you don't control is a different challenge from testing your own code. It requires reverse-engineering framework behavior, handling race conditions, and building resilient selectors that survive UI changes — skills that transfer directly to any large-scale test automation role.

---

## Tech Stack

| Tool | Purpose |
|---|---|
| [Playwright](https://playwright.dev) v1.58 | Browser automation & test runner |
| TypeScript | Type-safe test authoring |
| Chromium / Firefox / WebKit | Cross-browser coverage |
| HTML Reporter | Visual test result reporting |

---

## Features

- **36 tests across 10 functional areas** — calculator inputs, amortization summary, amortization schedule breakdown, CSV export, and printer-friendly version
- **Cross-browser** — runs on Chromium, Firefox, and WebKit with a single command (108 test runs total)
- **Vue.js reactivity-aware patterns** — discovered and worked around a non-obvious interaction between Playwright's `fill()`, Vue's internal state, and the app's live rate API; tests wait for reactive DOM updates as the synchronisation signal rather than using fixed delays
- **Async-stable payment polling** — polls the payment display every 600 ms until two consecutive reads agree, correctly handling mid-flight server-side property tax and rate lookups
- **Amortization schedule validation** — tests year-by-year and month-by-month rows, individual expand toggles, the expand/collapse-all toggle, and the first-payment date picker
- **Extra payments coverage** — verifies that monthly, yearly, and one-time lump-sum extra payments reduce total interest, total cost, and payoff date as expected
- **CSV download testing** — intercepts the browser download event, saves to a temp file, and asserts filename, headers, row count, and first/last row values
- **`window.print()` interception** — mocks `window.print` before clicking the printer-friendly link to suppress the OS dialog while still asserting the call was made
- **Cookie consent handling** — gracefully dismisses the OneTrust banner before interacting with the form
- **Documented test commentary** — every non-obvious decision is explained inline, including the key behaviours discovered through live testing

---

## Getting Started

### Prerequisites

- [Node.js](https://nodejs.org) v18 or higher
- npm (bundled with Node.js)

### Installation

```bash
# 1. Clone the repository
git clone https://github.com/evaosorio15/playwright-mortgage-calculator-tests.git
cd playwright-mortgage-calculator-tests

# 2. Install dependencies
npm install

# 3. Install Playwright browsers
npx playwright install
```

### Running Tests

```bash
# Run all tests on all browsers
npx playwright test

# Run on a single browser (faster for development)
npx playwright test --project=chromium

# Run a specific test group by name
npx playwright test -g "Monthly Payment"

# Run sequentially (useful when debugging timing-sensitive tests)
npx playwright test --workers=1
```

### Viewing the Report

```bash
npx playwright show-report
```

An HTML report opens in your browser showing pass/fail status, durations, and traces for any failures.

---

## Project Structure

```
├── tests/
│   ├── helpers.ts                      # Shared selectors, constants, and helper functions
│   ├── calculator-inputs.spec.ts       # Describes 1–6: inputs, payment calc, validation (10 tests)
│   ├── amortization-summary.spec.ts    # Describes 7–8: summary values, extra payments (8 tests)
│   ├── amortization-schedule.spec.ts   # Describe 9: schedule table, expand/collapse (12 tests)
│   └── export-features.spec.ts         # Describes 10a–10b: CSV export, printer-friendly (7 tests)
├── playwright.config.ts                # Browser projects, reporter, retry config
└── package.json                        # Dependencies
```

**`tests/helpers.ts`** is the shared foundation — it exports:

- A `SEL` constants object with all CSS selectors (documented and justified)
- Shared helper functions (`clearAndFill`, `clickUpdate`, `readStablePayment`, `dismissCookieBanner`, `parseAmount`)
- Amortization-specific helpers (`amortValue`, `parsePayoffDate`, `payoffBefore`, `captureAmortBaseline`)

Each spec file imports only what it needs from `helpers.ts` and focuses on a single area of the calculator, making it easy to find and extend tests without navigating a large monolith.

---

## What Made This Interesting

Testing a live site you don't own forces you to go deeper than you would with your own code. A few things discovered during this project:

- The calculator requires an explicit **"Update" button click** to recalculate — no auto-recalculation on input change
- Playwright's `fill()` updates the DOM but Vue reads its internal state for loan calculations; the fix was to wait for Vue's async API call to confirm the new home price and reactively update the down-payment field — a signal that Vue's state is ready
- The **"Update" button** shares a CSS class with several "View offer" buttons on the page; `:text-is("Update")` was required for an unambiguous selector
- Property tax is **recalculated server-side** on every Update — zeroing it out before clicking is silently undone

---

## Author

**Eva Osorio**
[LinkedIn](https://www.linkedin.com/in/evaosorio15)
