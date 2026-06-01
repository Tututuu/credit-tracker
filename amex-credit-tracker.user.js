// ==UserScript==
// @name         Amex Personal Credit Tracker
// @namespace    local.amex-credit-tracker
// @version      0.2.1
// @description  Personal Amex benefit credit tracker dashboard.
// @match        https://global.americanexpress.com/*
// @match        https://*.americanexpress.com/*
// @run-at       document-start
// @grant        GM.getValue
// @grant        GM.setValue
// @grant        unsafeWindow
// ==/UserScript==

(function () {
  'use strict';

  /*
   * Edit this list for the benefits you care about.
   * Matching is case-insensitive and partial. Example: "saks" matches "$100 Saks Credit".
   * Leave the list empty to show every benefit tracker returned by Amex.
   */
  const DEFAULT_TRACKED_BENEFIT_KEYWORDS = [
    'digital',
    'saks',
    'airline',
    'uber',
    'dining',
  ];

  /*
   * Only track cards whose last four display digits match this pattern.
   * Example: /^[0-9]00[0-9]$/ matches 1001, 2007, 9000, etc.
   * Set to null to track every active credit card returned by Amex.
   */
  const TRACKED_CARD_LAST_FOUR_PATTERN = /^[0-9]00[0-9]$/;

  const CONFIG = {
    locale: 'en-US',
    limit: 'ALL',
    endpoints: {
      loyaltyAccounts: 'ReadLoyaltyAccounts.v1',
      benefitTrackers: 'ReadBestLoyaltyBenefitsTrackers.v1',
      benefitTrackersUrl: 'https://functions.americanexpress.com/ReadBestLoyaltyBenefitsTrackers.v1',
      member: '/api/servicing/v1/member',
      memberUrl: 'https://global.americanexpress.com/api/servicing/v1/member',
    },
    refreshDelayMs: 800,
  };

  const STORAGE_KEYS = {
    accounts: 'act.accounts.v1',
    trackers: 'act.trackers.v1',
    lastUpdated: 'act.lastUpdated.v1',
    keywords: 'act.keywords.v1',
    hideAchieved: 'act.hideAchieved.v1',
  };

  let state = null;

  async function bootstrap() {
    state = await createInitialState();
    NetworkCapture.install();
    await waitForBody();
    Dashboard.initialize();
  }

  async function createInitialState() {
    const [
      accounts,
      trackers,
      lastUpdated,
      keywords,
      hideAchieved,
    ] = await Promise.all([
      Storage.read(STORAGE_KEYS.accounts, []),
      Storage.read(STORAGE_KEYS.trackers, []),
      Storage.read(STORAGE_KEYS.lastUpdated, null),
      Storage.read(STORAGE_KEYS.keywords, DEFAULT_TRACKED_BENEFIT_KEYWORDS),
      Storage.read(STORAGE_KEYS.hideAchieved, false),
    ]);

    return {
      accounts: AccountRepository.normalizeStoredAccounts(accounts),
      trackers: Collection.asArray(trackers),
      lastUpdated,
      keywords: Text.normalizeStoredKeywords(keywords),
      hideAchieved,
      status: 'Waiting for Amex account data',
      error: '',
      refreshFailures: [],
      skippedAccounts: [],
      loading: false,
      memberLoading: false,
      memberError: '',
      panelOpen: false,
      refreshTimer: null,
      memberRefreshTimer: null,
    };
  }

  const Storage = {
    async read(key, fallback) {
      try {
        return await GM.getValue(key, fallback);
      } catch (_error) {
        return fallback;
      }
    },

    write(key, value) {
      try {
        Promise.resolve(GM.setValue(key, value)).catch(() => {});
      } catch (_error) {
        // Storage failures should not break the Amex page.
      }
    },
  };

  const Runtime = {
    pageWindow() {
      return typeof unsafeWindow === 'undefined' ? window : unsafeWindow;
    },

    nowIso() {
      return new Date().toISOString();
    },

    plural(count, singular, plural = `${singular}s`) {
      return count === 1 ? singular : plural;
    },

    isActiveStatus(status) {
      const statuses = Array.isArray(status) ? status : [status];
      const normalized = statuses
        .map((item) => String(item || '').trim().toUpperCase())
        .filter(Boolean);
      return normalized.length === 0 || normalized.includes('ACTIVE');
    },
  };

  const Collection = {
    asArray(value) {
      return Array.isArray(value) ? value : [];
    },

    dedupeBy(items, keyFn) {
      const map = new Map();
      items.forEach((item) => {
        map.set(keyFn(item), item);
      });
      return Array.from(map.values());
    },

    uniqueValues(values) {
      return Array.from(new Set(values.filter((value) => value != null && value !== '')));
    },
  };

  const Text = {
    stringOrEmpty(value) {
      return value == null ? '' : String(value);
    },

    amountOrEmpty(value) {
      if (value == null || value === '') return '';
      return String(value);
    },

    parseKeywords(value) {
      return String(value || '')
        .split(/[\n,]/)
        .map((keyword) => keyword.trim())
        .filter(Boolean);
    },

    normalizeStoredKeywords(value) {
      if (Array.isArray(value)) return value.map(String).filter(Boolean);
      if (typeof value === 'string') return Text.parseKeywords(value);
      return [...DEFAULT_TRACKED_BENEFIT_KEYWORDS];
    },

    normalizedKeywords(keywords) {
      return keywords
        .map((keyword) => String(keyword || '').trim().toLowerCase())
        .filter(Boolean);
    },

    escapeHtml(value) {
      return String(value ?? '').replace(/[&<>"']/g, (char) => ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;',
      }[char]));
    },
  };

  const Walker = {
    walk(value, visit) {
      const seen = new Set();

      function inner(node) {
        if (node && typeof node === 'object') {
          if (seen.has(node)) return;
          seen.add(node);
        }

        visit(node);

        if (Array.isArray(node)) {
          node.forEach(inner);
        } else if (node && typeof node === 'object') {
          Object.values(node).forEach(inner);
        }
      }

      inner(value);
    },

    walkWithContext(value, context, visit) {
      const seen = new Set();

      function inner(node, parentContext) {
        if (node && typeof node === 'object') {
          if (seen.has(node)) return;
          seen.add(node);
        }

        const nextContext = { ...parentContext };
        if (node && typeof node === 'object' && !Array.isArray(node) && typeof node.accountToken === 'string') {
          nextContext.accountToken = node.accountToken;
        }

        visit(node, nextContext);

        if (Array.isArray(node)) {
          node.forEach((child) => inner(child, nextContext));
        } else if (node && typeof node === 'object') {
          Object.values(node).forEach((child) => inner(child, nextContext));
        }
      }

      inner(value, context);
    },
  };

  const NetworkCapture = {
    install() {
      const pageWindow = Runtime.pageWindow();
      NetworkCapture.patchFetch(pageWindow);
      NetworkCapture.patchXhr(pageWindow);
    },

    patchFetch(pageWindow) {
      if (!pageWindow.fetch || pageWindow.fetch.__actPatched) return;

      const originalFetch = pageWindow.fetch;
      const patchedFetch = async function (...args) {
        const requestUrl = NetworkCapture.getFetchUrl(args[0]);
        const requestPayloadPromise = NetworkCapture.readFetchPayload(args[0], args[1]);
        const response = await originalFetch.apply(this, args);

        if (NetworkCapture.isInterestingUrl(requestUrl)) {
          const responseClone = response.clone();
          Promise.all([
            NetworkCapture.readResponseData(responseClone),
            requestPayloadPromise,
          ]).then(([responseData, requestPayload]) => {
            ApiDataHandler.handle(requestUrl, responseData, requestPayload);
          }).catch(() => {});
        }

        return response;
      };

      patchedFetch.__actPatched = true;
      patchedFetch.__actOriginalFetch = originalFetch;
      pageWindow.fetch = patchedFetch;
    },

    patchXhr(pageWindow) {
      const Xhr = pageWindow.XMLHttpRequest;
      if (!Xhr || !Xhr.prototype || Xhr.prototype.__actPatched) return;

      const originalOpen = Xhr.prototype.open;
      const originalSend = Xhr.prototype.send;

      Xhr.prototype.open = function (method, url, ...rest) {
        this.__actUrl = String(url || '');
        return originalOpen.call(this, method, url, ...rest);
      };

      Xhr.prototype.send = function (body) {
        if (NetworkCapture.isInterestingUrl(this.__actUrl)) {
          const requestPayload = Parser.parseMaybeJson(body);
          this.addEventListener('loadend', () => {
            const responseData = Parser.parseMaybeJson(NetworkCapture.readXhrResponse(this));
            ApiDataHandler.handle(this.__actUrl, responseData, requestPayload);
          });
        }

        return originalSend.call(this, body);
      };

      Xhr.prototype.__actPatched = true;
    },

    isInterestingUrl(url) {
      const value = String(url || '');
      return value.includes(CONFIG.endpoints.loyaltyAccounts)
        || value.includes(CONFIG.endpoints.benefitTrackers)
        || value.includes(CONFIG.endpoints.member);
    },

    getFetchUrl(input) {
      if (!input) return '';
      if (typeof input === 'string') return input;
      if (input.url) return String(input.url);
      return String(input);
    },

    async readFetchPayload(input, init) {
      if (init && init.body != null) return Parser.parseMaybeJson(await NetworkCapture.readBodyLike(init.body));
      if (input && typeof input.clone === 'function') {
        try {
          return Parser.parseMaybeJson(await input.clone().text());
        } catch (_error) {
          return null;
        }
      }
      return null;
    },

    async readBodyLike(body) {
      if (body == null) return '';
      if (typeof body === 'string') return body;
      if (typeof URLSearchParams !== 'undefined' && body instanceof URLSearchParams) return body.toString();
      if (typeof FormData !== 'undefined' && body instanceof FormData) {
        const object = {};
        body.forEach((value, key) => {
          object[key] = value;
        });
        return JSON.stringify(object);
      }
      if (typeof Blob !== 'undefined' && body instanceof Blob) return body.text();
      return String(body);
    },

    async readResponseData(response) {
      const text = await response.text();
      return Parser.parseMaybeJson(text);
    },

    readXhrResponse(xhr) {
      try {
        if (typeof xhr.responseText === 'string') return xhr.responseText;
      } catch (_error) {
        // responseText throws for non-text response types.
      }

      try {
        return xhr.response;
      } catch (_error) {
        return null;
      }
    },
  };

  const Parser = {
    parseMaybeJson(value) {
      if (value == null || value === '') return null;
      if (typeof value !== 'string') return value;

      const trimmed = value.trim().replace(/^\)\]\}',?\s*/, '');
      try {
        return JSON.parse(trimmed);
      } catch (_error) {
        return trimmed;
      }
    },
  };

  const ApiDataHandler = {
    handle(url, responseData, requestPayload) {
      if (!state || !responseData || typeof responseData !== 'object') return;

      if (String(url).includes(CONFIG.endpoints.loyaltyAccounts)) {
        ApiDataHandler.handleAccounts(responseData);
      }

      if (String(url).includes(CONFIG.endpoints.benefitTrackers)) {
        ApiDataHandler.handleTrackers(responseData, requestPayload);
      }

      if (String(url).includes(CONFIG.endpoints.member)) {
        ApiDataHandler.handleMember(responseData);
      }
    },

    handleAccounts(responseData) {
      const accounts = DataExtractor.extractAccounts(responseData);
      if (accounts.length === 0) return;

      AccountRepository.mergeAccounts(accounts);
      state.status = `Found ${state.accounts.length} active credit card ${Runtime.plural(state.accounts.length, 'account')}`;
      state.error = '';
      MemberRefresh.schedule();
      TrackerRefresh.schedule();
      Dashboard.render();
    },

    handleMember(responseData) {
      const accounts = DataExtractor.extractMemberAccounts(responseData);
      if (accounts.length === 0) return;

      AccountRepository.mergeAccounts(accounts);
      state.memberError = '';
      Dashboard.render();
    },

    handleTrackers(responseData, requestPayload) {
      const requestAccounts = DataExtractor.extractPayloadAccountTokens(requestPayload);
      const fallbackAccountToken = requestAccounts.length === 1 ? requestAccounts[0] : null;
      const trackers = DataExtractor.extractTrackers(responseData, fallbackAccountToken);
      if (trackers.length === 0) return;

      TrackerRepository.mergeTrackers(trackers);
      state.status = `Updated ${state.trackers.length} benefit ${Runtime.plural(state.trackers.length, 'tracker')}`;
      state.error = '';
      state.lastUpdated = Runtime.nowIso();
      TrackerRepository.persist();
      Dashboard.render();
    },
  };

  const DataExtractor = {
    extractAccounts(data) {
      const found = [];

      Walker.walk(data, (node) => {
        if (!node || typeof node !== 'object' || Array.isArray(node)) return;
        if (typeof node.accountToken !== 'string' || node.accountToken.length === 0) return;

        const status = String(node.status || '').toUpperCase();
        const relationshipType = String(node.productRelationshipType || '').toUpperCase();

        if (status && status !== 'ACTIVE') return;
        if (relationshipType && relationshipType !== 'CREDIT_CARD_ACCOUNT') return;

        const displayAccountNumber = String(node.displayAccountNumber || node.accountNumber || '');
        if (!AccountRepository.isTrackedCardDisplayNumber(displayAccountNumber)) return;

        found.push({
          accountToken: node.accountToken,
          displayAccountNumber,
          primary: Boolean(node.primary),
          status: node.status || '',
          productRelationshipType: node.productRelationshipType || '',
        });
      });

      return Collection.dedupeBy(found, (account) => account.accountToken);
    },

    extractMemberAccounts(data) {
      const found = [];

      Collection.asArray(data?.accounts).forEach((account) => {
        DataExtractor.collectMemberAccount(found, account, true);
        Collection.asArray(account?.supplementary_accounts || account?.supplementaryAccounts).forEach((supplementaryAccount) => {
          DataExtractor.collectMemberAccount(found, supplementaryAccount, false);
        });
      });

      return Collection.dedupeBy(found, (account) => account.accountToken);
    },

    collectMemberAccount(found, memberAccount, primary) {
      if (!memberAccount || typeof memberAccount !== 'object') return;

      const accountToken = Text.stringOrEmpty(memberAccount.account_token || memberAccount.accountToken);
      if (!accountToken) return;

      const displayAccountNumber = Text.stringOrEmpty(
        memberAccount.account?.display_account_number
          || memberAccount.account?.displayAccountNumber
          || memberAccount.display_account_number
          || memberAccount.displayAccountNumber
      );
      if (!AccountRepository.isTrackedCardDisplayNumber(displayAccountNumber)) return;

      const status = memberAccount.status?.account_status || memberAccount.status?.accountStatus || memberAccount.status;
      if (!Runtime.isActiveStatus(status)) return;

      const productDescription = Text.stringOrEmpty(memberAccount.product?.description || memberAccount.productDescription).trim();
      const productDescriptions = Collection.uniqueValues([productDescription]);

      found.push({
        accountToken,
        displayAccountNumber,
        primary,
        status: Array.isArray(status) ? status.join(', ') : Text.stringOrEmpty(status),
        productRelationshipType: 'CREDIT_CARD_ACCOUNT',
        productDescription,
        productDescriptions,
      });
    },

    extractPayloadAccountTokens(payload) {
      const tokens = [];

      Walker.walk(payload, (node) => {
        if (!node || typeof node !== 'object' || Array.isArray(node)) return;
        if (typeof node.accountToken === 'string' && node.accountToken.length > 0) {
          tokens.push(node.accountToken);
        }
      });

      return Array.from(new Set(tokens));
    },

    extractTrackers(data, fallbackAccountToken) {
      const found = [];

      Walker.walkWithContext(data, {}, (node, context) => {
        if (!node || typeof node !== 'object' || Array.isArray(node)) return;

        const benefitName = Text.stringOrEmpty(node.benefitName || node.progress?.title || node.title || node.name);
        const hasTrackerData = Boolean(node.tracker || node.progress || node.periodStartDate || node.periodEndDate);
        if (!benefitName || !hasTrackerData) return;

        const tracker = node.tracker || {};
        const progress = node.progress || {};
        const accountToken = Text.stringOrEmpty(node.accountToken || context.accountToken || fallbackAccountToken);

        found.push({
          accountToken,
          benefitId: Text.stringOrEmpty(node.benefitId || node.sorBenefitId || node.id),
          benefitName,
          progressTitle: Text.stringOrEmpty(progress.title),
          periodStartDate: Text.stringOrEmpty(node.periodStartDate),
          periodEndDate: Text.stringOrEmpty(node.periodEndDate),
          trackerDuration: Text.stringOrEmpty(node.trackerDuration),
          status: Text.stringOrEmpty(node.status),
          targetAmount: Text.amountOrEmpty(tracker.targetAmount ?? node.targetAmount),
          spentAmount: Text.amountOrEmpty(tracker.spentAmount ?? node.spentAmount),
          remainingAmount: Text.amountOrEmpty(tracker.remainingAmount ?? node.remainingAmount),
          targetUnit: Text.stringOrEmpty(tracker.targetUnit),
          targetCurrency: Text.stringOrEmpty(tracker.targetCurrency),
          targetCurrencySymbol: Text.stringOrEmpty(tracker.targetCurrencySymbol || '$'),
          totalSavingsYearToDate: Text.amountOrEmpty(progress.totalSavingsYearToDate ?? node.totalSavingsYearToDate),
          updatedAt: Runtime.nowIso(),
        });
      });

      return Collection.dedupeBy(found, TrackerRepository.trackerKey);
    },
  };

  const AccountRepository = {
    normalizeStoredAccounts(value) {
      return Collection.asArray(value).filter((account) => {
        return AccountRepository.isTrackedCardDisplayNumber(account?.displayAccountNumber);
      }).map((account) => AccountRepository.normalizeAccount(account));
    },

    isTrackedCardDisplayNumber(displayAccountNumber) {
      if (!TRACKED_CARD_LAST_FOUR_PATTERN) return true;
      const digits = String(displayAccountNumber || '').replace(/\D/g, '');
      if (digits.length < 4) return false;
      return TRACKED_CARD_LAST_FOUR_PATTERN.test(digits.slice(-4));
    },

    mergeAccounts(accounts) {
      const byToken = new Map(state.accounts.map((account) => [account.accountToken, account]));
      accounts.forEach((account) => {
        byToken.set(account.accountToken, AccountRepository.mergeAccount(byToken.get(account.accountToken), account));
      });

      state.accounts = Array.from(byToken.values())
        .map((account) => AccountRepository.normalizeAccount(account))
        .sort(AccountRepository.compareAccounts)
        .filter((account) => AccountRepository.isTrackedCardDisplayNumber(account.displayAccountNumber));

      Storage.write(STORAGE_KEYS.accounts, state.accounts);
    },

    normalizeAccount(account) {
      const productDescriptions = AccountRepository.productDescriptionsForAccount(account);
      return {
        ...account,
        productDescription: productDescriptions[0] || '',
        productDescriptions,
      };
    },

    mergeAccount(current = {}, next = {}) {
      const merged = { ...current, ...next };
      const productDescriptions = Collection.uniqueValues([
        ...AccountRepository.productDescriptionsForAccount(current),
        ...AccountRepository.productDescriptionsForAccount(next),
      ]);
      return {
        ...merged,
        productDescription: productDescriptions[0] || '',
        productDescriptions,
      };
    },

    productDescriptionsForAccount(account) {
      return Collection.uniqueValues([
        ...Collection.asArray(account?.productDescriptions),
        account?.productDescription,
      ].map((description) => Text.stringOrEmpty(description).trim()));
    },

    compareAccounts(left, right) {
      if (left.primary !== right.primary) return left.primary ? -1 : 1;
      return AccountRepository.maskAccount(left).localeCompare(AccountRepository.maskAccount(right));
    },

    accountForToken(accountToken) {
      return state.accounts.find((account) => account.accountToken === accountToken) || {
        accountToken,
        displayAccountNumber: '',
      };
    },

    maskAccount(account) {
      const display = Text.stringOrEmpty(account?.displayAccountNumber);
      if (display) return display.slice(-5);
      if (account?.accountToken) return `Card token ...${account.accountToken.slice(-4)}`;
      return 'Unknown card';
    },
  };

  const MemberRefresh = {
    schedule() {
      if (state.memberRefreshTimer) window.clearTimeout(state.memberRefreshTimer);
      state.memberRefreshTimer = window.setTimeout(() => {
        MemberRefresh.refreshMemberAccounts();
      }, CONFIG.refreshDelayMs);
    },

    async refreshMemberAccounts() {
      if (state.memberLoading) return;

      state.memberLoading = true;
      state.memberError = '';
      Dashboard.render();

      try {
        const data = await MemberApi.getMember();
        const accounts = DataExtractor.extractMemberAccounts(data);
        if (accounts.length > 0) {
          AccountRepository.mergeAccounts(accounts);
        }
      } catch (error) {
        state.memberError = error?.message || 'Could not load card product names from the member API.';
      } finally {
        state.memberLoading = false;
        Dashboard.render();
      }
    },
  };

  const TrackerRepository = {
    mergeTrackers(trackers) {
      const byKey = new Map(state.trackers.map((tracker) => [TrackerRepository.trackerKey(tracker), tracker]));
      trackers.forEach((tracker) => {
        byKey.set(TrackerRepository.trackerKey(tracker), {
          ...byKey.get(TrackerRepository.trackerKey(tracker)),
          ...tracker,
        });
      });

      state.trackers = Array.from(byKey.values()).sort(TrackerRepository.compareTrackers);
    },

    replaceTrackersForAccounts(accountTokens, trackers) {
      const tokenSet = new Set(accountTokens.filter(Boolean));
      if (tokenSet.size > 0) {
        state.trackers = state.trackers.filter((tracker) => !tokenSet.has(tracker.accountToken));
      }
      TrackerRepository.mergeTrackers(trackers);
    },

    persist() {
      Storage.write(STORAGE_KEYS.trackers, state.trackers);
      Storage.write(STORAGE_KEYS.lastUpdated, state.lastUpdated);
    },

    trackerKey(tracker) {
      return [
        tracker.accountToken || 'unknown-account',
        tracker.benefitId || tracker.benefitName || 'unknown-benefit',
        tracker.periodStartDate || '',
        tracker.periodEndDate || '',
      ].join('|');
    },

    compareTrackers(left, right) {
      const leftAccount = AccountRepository.maskAccount(AccountRepository.accountForToken(left.accountToken));
      const rightAccount = AccountRepository.maskAccount(AccountRepository.accountForToken(right.accountToken));
      const accountCompare = leftAccount.localeCompare(rightAccount);
      if (accountCompare !== 0) return accountCompare;
      return left.benefitName.localeCompare(right.benefitName);
    },
  };

  const TrackerRefresh = {
    schedule() {
      if (state.refreshTimer) window.clearTimeout(state.refreshTimer);
      state.refreshTimer = window.setTimeout(() => {
        TrackerRefresh.refreshKnownAccounts();
      }, CONFIG.refreshDelayMs);
    },

    async refreshKnownAccounts() {
      if (state.loading) return;
      if (state.accounts.length === 0) {
        state.status = 'Waiting for Amex account data';
        Dashboard.render();
        return;
      }

      state.loading = true;
      state.status = 'Refreshing benefit trackers';
      state.error = '';
      state.refreshFailures = [];
      state.skippedAccounts = [];
      Dashboard.render();

      const payload = state.accounts.map((account) => TrackerRefresh.trackerPayload(account.accountToken));

      try {
        const batchData = await TrackerApi.postTrackerPayload(payload);
        const batchRows = DataExtractor.extractTrackers(batchData, payload.length === 1 ? payload[0].accountToken : null);
        const batchHasAccountMapping = TrackerRefresh.batchCoversRequestedAccounts(payload, batchRows);

        if (payload.length === 1 || batchHasAccountMapping) {
          TrackerRepository.replaceTrackersForAccounts(payload.map((item) => item.accountToken), batchRows);
        } else {
          throw new Error('Batch response did not include complete account mapping');
        }
      } catch (_batchError) {
        await TrackerRefresh.refreshSequentially();
      } finally {
        state.loading = false;
        state.lastUpdated = Runtime.nowIso();
        state.status = `Updated ${state.trackers.length} benefit ${Runtime.plural(state.trackers.length, 'tracker')}`;
        TrackerRepository.persist();
        Dashboard.render();
      }
    },

    batchCoversRequestedAccounts(payload, rows) {
      const requestedTokens = new Set(payload.map((item) => item.accountToken).filter(Boolean));
      if (requestedTokens.size <= 1) return true;
      if (rows.length === 0) return false;

      const returnedTokens = new Set(rows.map((row) => row.accountToken).filter(Boolean));
      if (returnedTokens.size === 0) return false;

      return Array.from(requestedTokens).every((token) => returnedTokens.has(token));
    },

    async refreshSequentially() {
      const failures = [];

      for (const account of state.accounts) {
        try {
          const data = await TrackerApi.postTrackerPayload([TrackerRefresh.trackerPayload(account.accountToken)]);
          const rows = DataExtractor.extractTrackers(data, account.accountToken);
          TrackerRepository.replaceTrackersForAccounts([account.accountToken], rows);
        } catch (error) {
          if (TrackerRefresh.isInaccessibleAccountError(error)) {
            const skipped = {
              account: AccountRepository.maskAccount(account),
              reason: 'Tracker API says this account token is not authorized. This usually means the card is closed or no longer accessible.',
            };
            state.skippedAccounts.push(skipped);
            TrackerRepository.replaceTrackersForAccounts([account.accountToken], []);
            continue;
          }

          const failure = {
            account: AccountRepository.maskAccount(account),
            message: error?.message || 'Unknown refresh error',
          };
          failures.push(failure.account);
          state.refreshFailures.push(failure);
        }
      }

      if (failures.length > 0) {
        state.error = `Some cards could not refresh. Refresh/login to Amex may be required. Failed: ${failures.join(', ')}`;
      }
    },

    isInaccessibleAccountError(error) {
      const message = String(error?.message || '');
      return message.includes('HTTP 401')
        && (message.includes('access_denied') || message.includes('not authorized') || message.includes('execution status denied'));
    },

    trackerPayload(accountToken) {
      return {
        accountToken,
        locale: CONFIG.locale,
        limit: CONFIG.limit,
      };
    },
  };

  const TrackerApi = {
    async postTrackerPayload(payload) {
      const pageWindow = Runtime.pageWindow();
      const fetchImpl = pageWindow.fetch?.__actOriginalFetch || pageWindow.fetch || window.fetch;
      const response = await fetchImpl.call(pageWindow, CONFIG.endpoints.benefitTrackersUrl, {
        method: 'POST',
        credentials: 'include',
        headers: {
          accept: 'application/json',
          'content-type': 'application/json',
        },
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        const responseText = await response.text().catch(() => '');
        throw new Error(`Tracker API returned HTTP ${response.status}${responseText ? `: ${responseText.slice(0, 500)}` : ''}`);
      }

      return Parser.parseMaybeJson(await response.text());
    },
  };

  const MemberApi = {
    async getMember() {
      const pageWindow = Runtime.pageWindow();
      const fetchImpl = pageWindow.fetch?.__actOriginalFetch || pageWindow.fetch || window.fetch;
      const response = await fetchImpl.call(pageWindow, CONFIG.endpoints.memberUrl, {
        method: 'GET',
        credentials: 'include',
        headers: {
          accept: 'application/json',
        },
      });

      if (!response.ok) {
        const responseText = await response.text().catch(() => '');
        throw new Error(`Member API returned HTTP ${response.status}${responseText ? `: ${responseText.slice(0, 500)}` : ''}`);
      }

      return Parser.parseMaybeJson(await response.text());
    },
  };

  const Dashboard = {
    initialize() {
      StyleInjector.install();

      const button = document.createElement('button');
      button.id = 'act-button';
      button.type = 'button';
      button.textContent = 'Credits';
      button.addEventListener('click', () => {
        state.panelOpen = !state.panelOpen;
        if (state.panelOpen && state.accounts.length > 0) MemberRefresh.schedule();
        Dashboard.render();
      });

      const panel = document.createElement('section');
      panel.id = 'act-panel';
      panel.setAttribute('aria-live', 'polite');

      document.body.append(button, panel);
      Dashboard.render();
    },

    render() {
      const panel = document.getElementById('act-panel');
      if (!panel || !state) return;

      panel.classList.toggle('act-open', state.panelOpen);
      if (!state.panelOpen) return;

      const filteredTrackers = Dashboard.filteredTrackersForDisplay();
      const grouped = Dashboard.groupTrackersByBenefit(filteredTrackers);

      panel.innerHTML = `
        <div class="act-header">
          <h2 class="act-title">Amex Credits</h2>
          <div class="act-actions">
            <button class="act-icon-button" type="button" data-act-refresh ${state.loading || state.memberLoading ? 'disabled' : ''}>${state.loading || state.memberLoading ? 'Refreshing' : 'Refresh'}</button>
            <button class="act-icon-button" type="button" data-act-close>Close</button>
          </div>
        </div>
        <div class="act-body">
          ${Dashboard.renderStatus()}
          ${state.error ? `<p class="act-error">${Text.escapeHtml(state.error)}</p>` : ''}
          ${state.memberError ? `<p class="act-warning">${Text.escapeHtml(state.memberError)}</p>` : ''}
          ${state.skippedAccounts.length > 0 ? `<p class="act-warning">Skipped inaccessible cards: ${Text.escapeHtml(state.skippedAccounts.map((item) => item.account).join(', '))}</p>` : ''}
          ${Dashboard.renderSettings()}
          ${Dashboard.renderBenefitGroups(grouped, filteredTrackers)}
        </div>
      `;

      Dashboard.bindPanelEvents(panel);
    },

    bindPanelEvents(panel) {
      panel.querySelector('[data-act-refresh]')?.addEventListener('click', Dashboard.refreshAll);
      panel.querySelector('[data-act-close]')?.addEventListener('click', () => {
        state.panelOpen = false;
        Dashboard.render();
      });
      panel.querySelector('[data-act-hide-achieved]')?.addEventListener('change', (event) => {
        state.hideAchieved = Boolean(event.currentTarget.checked);
        Storage.write(STORAGE_KEYS.hideAchieved, state.hideAchieved);
        Dashboard.render();
      });
      panel.querySelector('#act-keywords')?.addEventListener('change', (event) => {
        state.keywords = Text.parseKeywords(event.currentTarget.value);
        Storage.write(STORAGE_KEYS.keywords, state.keywords);
        Dashboard.render();
      });
    },

    async refreshAll() {
      await MemberRefresh.refreshMemberAccounts();
      await TrackerRefresh.refreshKnownAccounts();
    },

    renderStatus() {
      return `
        <div class="act-status">
          <span>${Text.escapeHtml(state.status)}</span>
          <span>${state.lastUpdated ? `Last updated ${Text.escapeHtml(Format.dateTime(state.lastUpdated))}` : 'No tracker refresh completed yet'}</span>
          <span>${state.accounts.length} ${Runtime.plural(state.accounts.length, 'card')} found, ${state.trackers.length} ${Runtime.plural(state.trackers.length, 'tracker')} cached</span>
          ${state.memberLoading ? '<span>Loading card product names</span>' : ''}
          ${state.skippedAccounts.length > 0 ? `<span>${state.skippedAccounts.length} inaccessible/closed ${Runtime.plural(state.skippedAccounts.length, 'card')} skipped</span>` : ''}
          ${state.refreshFailures.length > 0 ? `<span>${state.refreshFailures.length} card refresh ${Runtime.plural(state.refreshFailures.length, 'failure', 'failures')} recorded in diagnostics</span>` : ''}
        </div>
      `;
    },

    renderSettings() {
      return `
        <div class="act-settings">
          <label class="act-label" for="act-keywords">Benefit keywords</label>
          <textarea id="act-keywords" class="act-keywords" spellcheck="false">${Text.escapeHtml(state.keywords.join(', '))}</textarea>
          <label class="act-toggle">
            <input type="checkbox" data-act-hide-achieved ${state.hideAchieved ? 'checked' : ''}>
            Hide achieved
          </label>
        </div>
      `;
    },

    renderBenefitGroups(grouped, filteredTrackers) {
      if (state.trackers.length === 0) {
        return '<p class="act-empty">Open an Amex logged-in page that loads loyalty accounts, then click Refresh.</p>';
      }

      if (filteredTrackers.length === 0) {
        return '<p class="act-empty">No trackers match the current keywords. Clear the keyword list to show every returned tracker.</p>';
      }

      return Array.from(grouped.entries())
        .sort(([leftName], [rightName]) => leftName.localeCompare(rightName))
        .map(([_benefitName, trackers]) => Dashboard.renderBenefitTable(trackers))
        .join('');
    },

    renderBenefitTable(trackers) {
      const sortedTrackers = [...trackers].sort((left, right) => {
        const leftAccount = AccountRepository.maskAccount(AccountRepository.accountForToken(left.accountToken));
        const rightAccount = AccountRepository.maskAccount(AccountRepository.accountForToken(right.accountToken));
        return leftAccount.localeCompare(rightAccount);
      });
      const sample = sortedTrackers[0] || {};
      const currencySymbol = sample.targetCurrencySymbol || '$';
      const benefitTitle = Format.benefitTitle(sortedTrackers);
      const endDate = Format.creditEndDate(sortedTrackers);
      const endDateClass = endDate.isSoon ? 'act-credit-end-date act-credit-end-date-warning' : 'act-credit-end-date';

      return `
        <section class="act-credit-group">
          <div class="act-credit-table">
            <div class="act-credit-heading">
              <div class="act-credit-title">
                <h3 class="act-credit-name">${Text.escapeHtml(benefitTitle)}</h3>
                ${endDate.text ? `<div class="${endDateClass}">${Text.escapeHtml(endDate.text)}</div>` : ''}
                <div class="act-credit-subtitle">${Text.escapeHtml(Format.creditSubtitle(sortedTrackers, currencySymbol))}</div>
              </div>
              <span class="act-count">${sortedTrackers.length} ${Runtime.plural(sortedTrackers.length, 'card')}</span>
            </div>
            <div class="act-table-wrap">
              <table class="act-table">
                <thead>
                  <tr>
                    <th>Card</th>
                    <th>Spent</th>
                    <th>Remaining</th>
                    <th>Progress</th>
                  </tr>
                </thead>
                <tbody>
                  ${sortedTrackers.map(Dashboard.renderBenefitRow).join('')}
                </tbody>
              </table>
            </div>
          </div>
        </section>
      `;
    },

    renderBenefitRow(tracker) {
      const account = AccountRepository.accountForToken(tracker.accountToken);
      const currencySymbol = tracker.targetCurrencySymbol || '$';
      const progress = Format.trackerProgressPercent(tracker);

      return `
        <tr>
          <td>
            <div class="act-card-cell">${Text.escapeHtml(AccountRepository.maskAccount(account))}</div>
          </td>
          <td class="act-money-cell">${Text.escapeHtml(Format.money(tracker.spentAmount, currencySymbol))}</td>
          <td class="act-money-cell">${Text.escapeHtml(Format.money(tracker.remainingAmount, currencySymbol))}</td>
          <td>
            <div class="act-progress" title="${Text.escapeHtml(Format.status(tracker.status) || `${progress}%`)}">
              <div class="act-progress-track">
                <span class="act-progress-fill ${Format.progressClassName(progress)}" style="width: ${progress}%"></span>
              </div>
              <span class="act-progress-label">${progress}%</span>
            </div>
            ${tracker.totalSavingsYearToDate ? `<div class="act-row-note">YTD ${Text.escapeHtml(Format.money(tracker.totalSavingsYearToDate, currencySymbol))}</div>` : ''}
          </td>
        </tr>
      `;
    },

    filteredTrackersForDisplay() {
      const currentAccountTrackers = Dashboard.trackersForCurrentAccounts();
      const trackersForTrackedCards = state.hideAchieved
        ? currentAccountTrackers.filter((tracker) => !Format.isAchievedStatus(tracker.status))
        : currentAccountTrackers;

      const keywords = Text.normalizedKeywords(state.keywords);
      if (keywords.length === 0) return trackersForTrackedCards;

      return trackersForTrackedCards.filter((tracker) => {
        const haystack = `${tracker.benefitName || ''} ${tracker.progressTitle || ''}`.toLowerCase();
        return keywords.some((keyword) => haystack.includes(keyword));
      });
    },

    trackersForCurrentAccounts() {
      const accountTokens = new Set(state.accounts.map((account) => account.accountToken));
      return state.trackers.filter((tracker) => accountTokens.has(tracker.accountToken));
    },

    groupTrackersByBenefit(trackers) {
      const grouped = new Map();
      trackers.forEach((tracker) => {
        const benefitName = tracker.benefitName || 'Unknown credit';
        if (!grouped.has(benefitName)) grouped.set(benefitName, []);
        grouped.get(benefitName).push(tracker);
      });
      return grouped;
    },
  };

  const Format = {
    benefitTitle(trackers) {
      const sample = trackers[0] || {};
      const benefitName = sample.benefitName || 'Unknown credit';
      const productDescriptions = Collection.uniqueValues(trackers.flatMap((tracker) => {
        const account = AccountRepository.accountForToken(tracker.accountToken);
        return AccountRepository.productDescriptionsForAccount(account);
      }));

      if (productDescriptions.length === 0) return benefitName;
      return `${benefitName} -- ${productDescriptions.join(' / ')}`;
    },

    creditSubtitle(trackers, currencySymbol) {
      const targets = Collection.uniqueValues(trackers.map((tracker) => {
        return Format.money(tracker.targetAmount, tracker.targetCurrencySymbol || currencySymbol);
      }));
      const durations = Collection.uniqueValues(trackers.map((tracker) => tracker.trackerDuration || 'Period'));
      const targetText = targets.length === 1 ? `Target ${targets[0]}` : 'Mixed targets';
      const durationText = durations.length === 1 ? durations[0] : 'Mixed frequencies';
      return `${targetText} | ${durationText}`;
    },

    creditEndDate(trackers) {
      const endDates = Collection.uniqueValues(trackers.map((tracker) => tracker.periodEndDate)).sort();
      if (endDates.length === 0) return { text: '', isSoon: false };

      return {
        text: `Ends ${endDates.join(' / ')}`,
        isSoon: endDates.some((endDate) => Format.isDateLessThanDaysAway(endDate, 15)),
      };
    },

    isDateLessThanDaysAway(value, days) {
      const date = Format.parseDateOnly(value);
      if (!date) return false;

      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const diffDays = (date.getTime() - today.getTime()) / 86400000;
      return diffDays >= 0 && diffDays < days;
    },

    parseDateOnly(value) {
      const match = String(value || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
      if (!match) return null;

      const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
      return Number.isNaN(date.getTime()) ? null : date;
    },

    money(value, symbol) {
      if (value === '' || value == null) return 'n/a';
      const numeric = Number(value);
      if (!Number.isFinite(numeric)) return `${symbol || '$'}${String(value)}`;
      return `${symbol || '$'}${numeric.toFixed(2)}`;
    },

    status(status) {
      return String(status || '').replace(/_/g, ' ').toLowerCase().replace(/\b\w/g, (char) => char.toUpperCase());
    },

    trackerProgressPercent(tracker) {
      const spent = Format.numericAmount(tracker.spentAmount);
      const remaining = Format.numericAmount(tracker.remainingAmount);
      const target = Format.numericAmount(tracker.targetAmount);
      let percent = null;

      if (target > 0 && spent != null) {
        percent = (spent / target) * 100;
      } else if (target > 0 && remaining != null) {
        percent = ((target - remaining) / target) * 100;
      } else if (spent != null && remaining != null && spent + remaining > 0) {
        percent = (spent / (spent + remaining)) * 100;
      } else if (Format.isAchievedStatus(tracker.status)) {
        percent = 100;
      } else {
        percent = 0;
      }

      return Math.max(0, Math.min(100, Math.round(percent)));
    },

    numericAmount(value) {
      if (value === '' || value == null) return null;
      const normalized = String(value).replace(/[^0-9.-]/g, '');
      if (!normalized) return null;
      const numeric = Number(normalized);
      return Number.isFinite(numeric) ? numeric : null;
    },

    progressClassName(percent) {
      if (percent >= 100) return 'act-progress-fill-complete';
      if (percent <= 0) return 'act-progress-fill-empty';
      return '';
    },

    isAchievedStatus(status) {
      return Format.normalizedStatus(status) === 'ACHIEVED';
    },

    normalizedStatus(status) {
      return String(status || '').trim().toUpperCase().replace(/[\s-]+/g, '_');
    },

    dateTime(value) {
      const date = new Date(value);
      if (Number.isNaN(date.getTime())) return String(value);
      return date.toLocaleString();
    },
  };

  const Diagnostics = {
    getSanitizedState() {
      return {
        accounts: state.accounts.map(Diagnostics.sanitizeAccount),
        trackers: state.trackers.map(Diagnostics.sanitizeTracker),
        lastUpdated: state.lastUpdated,
        keywords: state.keywords,
        hideAchieved: state.hideAchieved,
        status: state.status,
        error: state.error,
        memberError: state.memberError,
        refreshFailures: state.refreshFailures,
        skippedAccounts: state.skippedAccounts,
      };
    },

    getDebugText() {
      return JSON.stringify(Diagnostics.getSanitizedState(), null, 2);
    },

    debug() {
      const text = Diagnostics.getDebugText();
      console.log(text);

      const clipboard = Runtime.pageWindow().navigator?.clipboard || navigator.clipboard;
      if (clipboard?.writeText) {
        clipboard.writeText(text)
          .then(() => console.info('AmexCreditTracker debug output copied to clipboard.'))
          .catch(() => console.info('AmexCreditTracker debug output printed above. Copy it from the console.'));
      } else {
        console.info('AmexCreditTracker debug output printed above. Copy it from the console.');
      }

      return text;
    },

    sanitizeAccount(account) {
      return {
        ...account,
        accountToken: Diagnostics.maskToken(account.accountToken),
      };
    },

    sanitizeTracker(tracker) {
      return {
        ...tracker,
        accountToken: Diagnostics.maskToken(tracker.accountToken),
      };
    },

    maskToken(token) {
      if (!token) return '';
      const value = String(token);
      if (value.length <= 8) return 'REDACTED';
      return `${value.slice(0, 4)}...${value.slice(-4)}`;
    },

    clearCache() {
      state.accounts = [];
      state.trackers = [];
      state.lastUpdated = null;
      state.refreshFailures = [];
      state.skippedAccounts = [];
      state.memberError = '';
      Storage.write(STORAGE_KEYS.accounts, []);
      Storage.write(STORAGE_KEYS.trackers, []);
      Storage.write(STORAGE_KEYS.lastUpdated, null);
      Dashboard.render();
    },
  };

  const StyleInjector = {
    install() {
      if (document.getElementById('act-styles')) return;

      const style = document.createElement('style');
      style.id = 'act-styles';
      style.textContent = `
        #act-button {
          position: fixed;
          left: 18px;
          bottom: 18px;
          z-index: 2147483646;
          min-width: 74px;
          height: 36px;
          border: 1px solid #006fc9;
          border-radius: 6px;
          background: #006fc9;
          color: #fff;
          font: 700 14px/1 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
          box-shadow: 0 8px 22px rgba(0, 0, 0, 0.18);
          cursor: pointer;
        }

        #act-panel {
          position: fixed;
          left: 18px;
          bottom: 64px;
          z-index: 2147483646;
          width: min(680px, calc(100vw - 24px));
          max-height: min(740px, calc(100vh - 84px));
          overflow: hidden;
          display: none;
          border: 1px solid #c8d7e8;
          border-radius: 8px;
          background: #fff;
          color: #1f2933;
          box-shadow: 0 18px 50px rgba(0, 0, 0, 0.24);
          font: 14px/1.45 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        }

        #act-panel.act-open {
          display: flex;
          flex-direction: column;
        }

        .act-header {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 12px;
          padding: 14px 16px 12px;
          border-bottom: 1px solid #e4edf7;
        }

        .act-title {
          margin: 0;
          color: #102a43;
          font-size: 16px;
          font-weight: 800;
          letter-spacing: 0;
        }

        .act-actions {
          display: flex;
          align-items: center;
          gap: 8px;
          flex-shrink: 0;
        }

        .act-icon-button {
          height: 30px;
          border: 1px solid #bdd4ee;
          border-radius: 6px;
          background: #fff;
          color: #006fc9;
          font: 700 13px/1 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
          cursor: pointer;
          padding: 0 10px;
        }

        .act-icon-button:disabled {
          opacity: 0.6;
          cursor: wait;
        }

        .act-body {
          overflow: auto;
          padding: 12px 16px 16px;
        }

        .act-status {
          display: flex;
          flex-direction: column;
          gap: 2px;
          margin-bottom: 12px;
          color: #52606d;
          font-size: 12px;
        }

        .act-error {
          margin: 0 0 12px;
          padding: 8px 10px;
          border: 1px solid #f5c2c7;
          border-radius: 6px;
          background: #fff5f5;
          color: #842029;
          font-size: 12px;
        }

        .act-warning {
          margin: 0 0 12px;
          padding: 8px 10px;
          border: 1px solid #ffd8a8;
          border-radius: 6px;
          background: #fff9db;
          color: #7c4a03;
          font-size: 12px;
        }

        .act-settings {
          display: grid;
          gap: 8px;
          margin-bottom: 14px;
          padding: 10px;
          border: 1px solid #d9e8f8;
          border-radius: 6px;
          background: #f7fbff;
        }

        .act-label {
          color: #334e68;
          font-size: 12px;
          font-weight: 700;
        }

        .act-keywords {
          width: 100%;
          min-height: 34px;
          resize: vertical;
          box-sizing: border-box;
          border: 1px solid #b8c7d9;
          border-radius: 6px;
          padding: 7px 8px;
          color: #102a43;
          font: 13px/1.35 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
        }

        .act-toggle {
          display: inline-flex;
          align-items: center;
          gap: 7px;
          color: #334e68;
          font-size: 12px;
          user-select: none;
        }

        .act-credit-group {
          margin-top: 14px;
        }

        .act-credit-table {
          border: 1px solid #d9e2ec;
          border-radius: 8px;
          background: #fff;
          overflow: hidden;
        }

        .act-credit-heading {
          display: flex;
          align-items: flex-start;
          justify-content: space-between;
          gap: 10px;
          padding: 11px 12px;
          border-bottom: 1px solid #e4edf7;
          background: #fbfdff;
        }

        .act-credit-title {
          min-width: 0;
        }

        .act-credit-name {
          margin: 0;
          color: #102a43;
          font-size: 14px;
          font-weight: 800;
          letter-spacing: 0;
        }

        .act-credit-end-date {
          margin-top: 3px;
          color: #627d98;
          font-size: 12px;
          font-weight: 700;
        }

        .act-credit-end-date-warning {
          color: #9a6700;
        }

        .act-credit-subtitle {
          margin-top: 2px;
          color: #627d98;
          font-size: 12px;
        }

        .act-count {
          flex-shrink: 0;
          color: #627d98;
          font-size: 12px;
          font-weight: 600;
        }

        .act-table-wrap {
          overflow-x: auto;
        }

        .act-table {
          width: 100%;
          min-width: 500px;
          border-collapse: collapse;
          table-layout: fixed;
        }

        .act-table th,
        .act-table td {
          padding: 9px 12px;
          border-bottom: 1px solid #eef3f8;
          text-align: left;
          vertical-align: top;
        }

        .act-table tr:last-child td {
          border-bottom: 0;
        }

        .act-table th {
          color: #627d98;
          font-size: 11px;
          font-weight: 800;
          text-transform: uppercase;
        }

        .act-card-cell {
          color: #102a43;
          font-size: 13px;
          font-weight: 800;
        }

        .act-money-cell {
          color: #102a43;
          font-size: 13px;
          font-weight: 800;
          white-space: nowrap;
        }

        .act-row-note {
          margin-top: 2px;
          color: #627d98;
          font-size: 12px;
        }

        .act-progress {
          display: grid;
          grid-template-columns: minmax(84px, 1fr) 42px;
          align-items: center;
          gap: 8px;
          max-width: 180px;
        }

        .act-progress-track {
          height: 9px;
          overflow: hidden;
          border-radius: 999px;
          background: #e8eef5;
        }

        .act-progress-fill {
          display: block;
          height: 100%;
          border-radius: inherit;
          background: #fbbc04;
        }

        .act-progress-fill-empty {
          background: #b8c7d9;
        }

        .act-progress-fill-complete {
          background: #34a853;
        }

        .act-progress-label {
          color: #102a43;
          font-size: 12px;
          font-weight: 800;
          text-align: right;
          white-space: nowrap;
        }

        .act-empty {
          margin: 20px 0 8px;
          color: #52606d;
          font-size: 13px;
        }

        @media (max-width: 520px) {
          #act-button {
            left: 12px;
            bottom: 12px;
          }

          #act-panel {
            left: 12px;
            bottom: 58px;
          }

          .act-credit-heading {
            flex-direction: column;
          }

          .act-table {
            min-width: 440px;
          }
        }
      `;

      document.head.append(style);
    },
  };

  const PublicApi = {
    refresh: () => (state ? Dashboard.refreshAll() : Promise.resolve()),
    getState: () => (state ? Diagnostics.getSanitizedState() : { status: 'Initializing' }),
    debug: () => (state ? Diagnostics.debug() : JSON.stringify({ status: 'Initializing' }, null, 2)),
    clearCache: () => {
      if (state) Diagnostics.clearCache();
    },
  };

  exposePublicApi();
  bootstrap();

  function exposePublicApi() {
    try {
      Runtime.pageWindow().AmexCreditTracker = PublicApi;
    } catch (_error) {
      window.AmexCreditTracker = PublicApi;
    }
  }

  function waitForBody() {
    if (document.body) return Promise.resolve();
    return new Promise((resolve) => {
      const observer = new MutationObserver(() => {
        if (document.body) {
          observer.disconnect();
          resolve();
        }
      });

      observer.observe(document.documentElement, { childList: true });
    });
  }
})();
