# Amex Credit Tracker

A Tampermonkey userscript that adds a **Credits** dashboard to americanexpress.com showing how much is left on each card's benefit credits (Saks, Uber, Dining, Digital Entertainment, Airline Fee, etc.).

## Install

1. Install [Tampermonkey](https://www.tampermonkey.net/) in your browser.
2. Open the dashboard, create a new userscript, and paste in the full contents of [amex-credit-tracker.user.js](amex-credit-tracker.user.js).
3. Save, then log in to https://global.americanexpress.com/.
4. A blue **Credits** button appears in the lower-left corner. Click it, then click **Refresh**.

Each credit gets its own table grouped by benefit, with one row per card (shown by the last five display digits) and the period end date highlighted when it's within 15 days.

## Configure

Two constants at the top of [amex-credit-tracker.user.js](amex-credit-tracker.user.js):

- `DEFAULT_TRACKED_BENEFIT_KEYWORDS` — partial, case-insensitive matches against benefit names (e.g. `saks` matches `$100 Saks Credit`). Empty list shows every tracker.
- `TRACKED_CARD_LAST_FOUR_PATTERN` — regex against the last four display digits. Set to `null` to track every active card.

You can also edit the keyword box live inside the dashboard.

## How it works

The script piggybacks on Amex's own API calls as you browse the site (`ReadLoyaltyAccounts.v1`, `ReadBestLoyaltyBenefitsTrackers.v1`, `/api/servicing/v1/member`) and re-fetches them on demand using your existing session cookies. Everything is cached in Tampermonkey storage — no cookies, headers, passwords, or auth tokens are persisted or sent anywhere else.

## Console helpers

On any Amex page:

```js
AmexCreditTracker.getState()    // sanitized snapshot of current state
AmexCreditTracker.clearCache()  // wipe cached accounts and trackers
```
