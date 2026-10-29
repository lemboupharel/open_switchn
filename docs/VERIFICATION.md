# Verification and safe operation

## Automated checks (no production requests)

```bash
npm run check
node --check public/app.js
npm test
npm run build
```

Tests use private temporary state and explicitly injected test-only transports.
External fetch calls in the unit/HTTP tests are denied unless explicitly stubbed.
CLI subprocess tests run in a temporary working directory with a test-only fetch
preload, never the real project `.env`. Local web tests bind an ephemeral loopback
port and close it afterwards. No environment toggle enables fixtures in the app.

Coverage includes:

- Live-only defaults and explicit rejection of old mock/offline settings.
- Default API transport calls fetch; network failures never synthesize success.
- Private `.env` loading, process precedence, permission/symlink rejection and
  automatic CLI startup loading without exposing keys.
- Missing session stays missing; persisted mock-mode state is rejected.
- Exact transfer fields, carrier/wallet routing and safe integer amounts.
- Required registered receiver name for cross-network/wallet drafts, safe local
  validation before any upstream calls, CLI input wiring and unchanged name
  propagation through fee review/confirmation. Backend receiver-name 422s remain
  actionable without exposing names or invalidating an otherwise valid session.
- Fixed/percentage fee ranges and rejection of missing/overlapping brackets.
- Headers, encoded queries, exact POST payment-check and no redirect following.
- HTTP/semantic/JSON/network failures without automatic retries.
- Observed same-network 422 review response becomes actionable CLI/dashboard
  guidance, without a ticket, initiation, session loss or arbitrary upstream
  message disclosure; unrelated validation errors keep conservative handling.
- Firebase identity -> real-shaped OTP verification -> same-identity device
  exchange -> protected bearer validation, including process resumption.
- Wrong/expired OTP, unsupported methods, foreign validation URLs, concurrent
  sign-in, missing configuration and uncertain exchange recovery.
- Environment credential override rejected before consuming an OTP.
- Durable 401 rejection and session-bound expiring reviews.
- Carrier/payment availability and wallet balance checks repeated at submission.
- Actual-shape provider-code dictionaries (not invented UI-mode dictionaries),
  MTN/Orange mappings without rewriting outgoing modes, wallet-specific routing,
  disabled/missing mapping errors and a fresh-review requirement after route changes.
- Exact confirmation, one-shot concurrency and permanent uncertain outcomes.
- Airtime/bundle confirmation and PIN omission from persisted state.
- Acknowledgement-only/pending/failed/collection-success status interpretation,
  bounded monitoring and cancellation without payment cancellation.
- Sanitized bounded diagnostics, including echoed credentials.
- Local Host/Origin and CSRF protection, sign-in, review, submission, replay
  rejection, history and status through HTTP adapters.

## Local startup/UI checks (no upstream actions required)

Keep `SWITCHN_ALLOW_PAYMENTS=false`; start `npm run web`.

1. Confirm **LIVE BACKEND**, missing/unverified session and blocked payment
   submission. Merely opening the page must not request authentication or payment.
2. Confirm sign-in is unavailable if the Firebase client key is missing.
3. Check mobile-width layout and field validation without submitting forms.
4. Check old tabs after restart: stale CSRF errors must instruct a page refresh.
5. Stop the server; local failures must be visible, never replaced by fake state.

Do not click real challenge/review/payment actions merely to run an offline UI
test. Full flow coverage uses the injected transports in the automated suite.

## User-operated production validation

An offline pass is **not** production-readiness certification. Follow the
[live authentication guide](./AUTH_WORKFLOW.md) with your own account:

- Confirm integration authorization and provider rules.
- Use the authorized project's client key and legitimate required headers.
- Request a code once; inspect the actual upstream status in sanitized traces.
- Enter the OTP only in the local UI/hidden terminal prompt; do not reuse one
  requested in a separate phone-app login.
- Verify that `/auth/sanctum/token` returned a bearer and `/my-funds` accepted it.
- Confirm current app-version requirements, phone format, units and carriers.
- Keep payments disabled until personally ready for a specific reviewed payment.
- Confirm recipient identity, all fees and the payment method.
- Follow official records for reconciliation. A 2xx, browser return, collection
  success or USSD approval alone is not proof of recipient settlement.

No real verification code was requested and no real transfer was initiated or
approved by the assistant during the live-only refactor.

## Recovery and limits

The user's live sign-in was confirmed in cached diagnostics on 2026-10-29.
The provider-namespace regression was reproduced from those service responses
and public payment configuration. After correction, a guarded GET-only live
preflight passed for an MTN-funded transfer: protected wallet/session check,
service status, payment config and both carrier lookups returned 200. No review
or initiation POST was sent by this diagnostic, so payment success is unverified.

The user's later MTN-to-MTN review returned 422 with an explicit same-network
restriction. That cached response now has API and local HTTP regression tests.
This is a rejected business operation, not a successful live fee quote; preflight
alone cannot establish that the backend will accept a transfer.

If **Payments blocked: missing payment permission** appears, fee review may still
run, but submission requires `SWITCHN_ALLOW_PAYMENTS=true` and a server restart.
If you want an MTN collection prompt, choose **MTN MoMo**, not **Internal wallet**.

For `outcome-unknown`, inspect official history/support and any known
payment-request status. Never delete an attempt marker merely to retry.
A new ticket can also duplicate an already-successful payment.

For authentication failure, use the supported login flow, not guessed tokens
or spoofed identity metadata. Native-only restrictions require the official
app/integration. Local logout does not revoke backend sessions.

Old mock state is ignored, not converted into live credentials. If state has
unsafe permissions, inspect ownership and repair only the specific file to
`600`; do not broadly change directory permissions.

See [lifecycle recovery](./AUTH_WORKFLOW.md) for expired challenges, rejected
environment overrides and stale `auth.lock` recovery.

Native phone-verification fallbacks, background notification feeds, operator
WebViews, automatic dialing, account recovery, optional offline transfer
protocols and backend settlement remain outside the verified implementation.
