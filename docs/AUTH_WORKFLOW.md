# Authentication and transfer lifecycle

## What changed, and what is not proved

The client now runs exclusively against the live services, with a guided identity
-> phone verification -> bearer exchange and protected session validation. Runtime
simulation, synthetic credentials and mode toggles have been removed. Tests alone
use explicitly injected fixtures.

The original missing-code report came from a mock-mode dashboard. On 2026-10-29,
the user completed a live phone sign-in: cached diagnostics showed HTTP 200 for
Firebase initialization, Switchn OTP creation/verification, bearer exchange and
protected session validation. The next failure occurred locally during preflight,
before review/initiation: it compared `ussd_pay` with a provider-code dictionary.
That namespace mismatch is now fixed. GET-only live preflight passed afterward;
no payment was initiated by the assistant and settlement remains unverified.

The user's next live fee review reached `/money-transfers/review` and returned
422: both numbers use the same network, so the backend instructed using the
mobile money provider directly. This is separate from authentication and
availability. No local payload change or re-login overrides that business rule.

## Recovered authentication chain

The inspected artifact is Switchn 4.1.2 (236), base APK SHA-256
`bdf6e222224c1610c50466adca37e83f4594897a546394e297f95a8867582ccd`.

| Step | Evidence | Implementation |
|---|---|---|
| Discover login methods | `AccountAPI.getLoginOptions`, `LoginOptionsResponse.data: List<String>` | GET `/auth/login-options?primary_number=...`; require the chosen `otp_sms` or `otp_whatsapp` option |
| Initialize identity | `jb.j.onCreate` calls Firebase anonymous sign-in; `jb.g.onComplete` obtains an ID token and assigns `j.h` | Firebase's documented REST anonymous sign-in, using an explicitly configured, authorized project client key |
| Request a phone challenge | `SmsVerifyActivity.q` / `WhatsappVerifyActivity.q`, `AccountAPI.createOtpCode` | POST `/otps` with identity `token`, `phone_number`, `device_lang`, `transport` (`sms`/`whatsapp`) |
| Validate code | `AccountAPI.validateOtpCode`, `jb.d.onResponse` Smali | POST returned validation URL with `otp`, `device_lang`, `device_name`, `do_login: true`; require `success: true` |
| Acquire bearer | `SmsVerifyActivity.r` -> `jb.e.m/h` -> `AccountAPI.registerDevice` | POST `/auth/sanctum/token` with the **original Firebase ID token**, phone and device metadata |
| Store bearer | `jb.c.onResponse`, `n9.y.p/c` | Only `data.access_token` becomes the session credential |

`OtpValidateResponse.data.unique_id` is **not** a bearer. The APK's verification
callback checks explicit success and then performs a separate token exchange.
An OTP creation response with `status: "otp_verified"` also reaches that exchange.
Anonymous Firebase sign-in alone never proves ownership of a phone number.

The new guided login intentionally does not attach an old bearer to OTP creation:
it is a new phone sign-in, not the APK's add-payment-number/account-link flow.
The low-level OTP adapter retains its optional existing-session behavior.

### Evidence references

- Private REA auth bundle: `switchn-analysis/auth-evidence.json` (not distributed):
  - `ev_bb24b8e1470215aabc80f4c108e9794de6d31b06aa5ac4da58fceae2499cccda`: exact `SmsVerifyActivity` member inventory.
  - `ev_b31f848ea8843ab793f9f08a658641ec92f6f9e25a59fac7244037a69299af9c`: `SmsVerifyActivity.r`, complete static method evidence.
- Anonymous identity callback: `jadx/sources/p128jb/g.java`, cases 2/default in `onComplete`.
- Login activity base: `jadx/sources/p128jb/j.java`, `onCreate`.
- Registration chain: `jadx/sources/p128jb/e.java`, `m`, `h`.
- Verification callback Smali: `apktool-base/smali_classes2/jb/d.smali`, success branches around lines 1485-1517 (JADX could not reconstruct this method).
- Account API wrapper: `jadx/sources/net/switchn/switchn/api/AccountAPI.java`.
- Bearer persistence: `jadx/sources/p170n9/y.java` (private analysis): `switchn_access_token` in Android `SwitchnPref`.
- [Firebase REST reference](https://firebase.google.com/docs/reference/rest/auth#section-sign-in-anonymously):
  POST `https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=...`,
  JSON `{ "returnSecureToken": true }`; response includes `idToken`, `expiresIn`.

These references describe static evidence and a documented Firebase adapter.
Later live observations are identified separately. Paths above are relative to
the private `switchn-analysis/` archive, not this Git repository. Keep it separate;
do not upload the APK, decompiled source or credential-bearing resources merely
to satisfy a documentation reference. Building and testing need none of them.

### Deliberate limits

- Use the **authorized Switchn Firebase project's client API key**. A key from a
  newly created unrelated Firebase project cannot authenticate to Switchn.
- No APK key is hardcoded or included in versioned source. Configure the key privately
  on the Node server. An API key identifies a project; it is not a bearer and does
  not bypass phone verification.
- Restricted Android keys, Play Integrity, CAPTCHA, required FCM registration,
  device attestation, disabled anonymous sign-in or `googlesms` fallback may
  prevent the REST adapter from working. Stop and use an officially supported
  integration/the native app; there is no spoofed Android identity or bypass.
- Native Google sign-in UI, Firebase phone-SMS fallback and missed-call verification
  are not implemented. Existing device/Google exchange adapters remain available
  for legitimately obtained identity material.
- No Switchn bearer refresh/expiry/revocation endpoint was found in the inspected
  account routes and auth clients. Do not invent `/auth/refresh`, assume a JWT
  lifetime, or substitute a Firebase refresh token for a Switchn bearer.
- Firebase documents its own refresh endpoint, but this implementation deliberately
  uses a short-lived sign-in challenge and does not persist its refresh token.
  A new sign-in requires a new user-requested challenge. Rejected Switchn sessions
  require reauthentication, not automatic payment replay.

## Session and payment state machines

```text
missing / unverified / rejected session
  -> user starts sign-in
  -> login options -> Firebase identity -> OTP creation
  -> awaiting user code
  -> explicit OTP success -> device token exchange
  -> private bearer storage -> protected session validation
  -> ready

ready -> validate session -> carrier/payment availability -> backend fee review
  -> expiring, session-bound quote -> USER CONFIRMS
  -> validate session and availability again
  -> permanent attempt marker -> POST /money-transfers/initiate ONCE
  -> acknowledgement with payment-request ID(s)
  -> bounded POST /payment-requests/{id}/payment-check
  -> pending / collection confirmed / failed / status unavailable
```

### Session validation and storage

The reconstructed APK stores a bearer in preferences. This client instead uses
`0600` files under a `0700` live-state directory. They are **not encrypted**.
Old mock state is not read or migrated into live credentials.

- `session.json`: bearer and save timestamp, not a fabricated expiry.
- `session-health.json`: credential fingerprint, validation/rejection state and
  time. A 401 rejection also disables an environment-provided bearer across
  process restarts. A different token requires a fresh validation.
- `login-challenge.json`: temporary Firebase ID token, returned validation URL,
  device/phone metadata, phase and local deadline. No OTP is stored. Removed once
  the bearer is saved or the user cancels locally.
- `auth.lock`: prevents concurrent CLI/browser sign-in operations. After an actual
  crash, first ensure no sign-in process is active, then remove only this lock
  in the `live/` state directory. Do not delete payment attempt markers.

The local challenge deadline is at most 10 minutes and ends before the reported
Firebase ID-token expiry. This is not a claim about Switchn's OTP lifetime.
Expired, uncertain or incomplete exchanges require explicit recovery; the client
never automatically resends codes, guesses OTPs or restarts payments.

`GET /my-funds` is a recovered protected route used here as a **local readiness
probe**, not a recovered dedicated token-introspection API. Its wallet ID and
balance must be well-formed before the session is marked validated. If an account
has no supported wallet response, validation stops explicitly; a token's presence
is not promoted to success. No separate profile endpoint is invented.

### Pre-flight

Before preflight, the shared draft validator requires a registered receiver name
when payer and recipient carriers differ or the payer is the internal wallet.
The CLI prompts for it; the dashboard shows the field outside collapsed details.
The inspected `Pa.b.b` (`jadx/sources/Pa/b.java` in the private analysis) enables
name confirmation for a nonempty ordinary recipient when either carrier is
unknown or they differ. `Ha.N` (`jadx/sources/Ha/N.java`)
blocks a blank name in that state and sends `inputted_receiver_name`.
The user's live MTN-to-Orange review corroborated the requirement with a 422.
The wire field remains nullable/optional for routes not requiring confirmation;
backend review is still authoritative. No name is inferred or synthesized.

Before a money review and again before submission:

1. Validate the session with `/my-funds`.
2. Read `/service-status`. Check transfer availability, the recipient carrier,
   funding route and enabled payment method.
3. Read `/payment-config`. Require the method and an enabled payer-carrier entry
   for external payment. Resolve its nonempty `final_api_code` and use that code,
   not the UI method, for global/recipient payment-method availability checks.
   Missing/disabled mappings stop explicitly. The request still carries
   `ussd_pay`, `web_pay` or `merchant_pay`, as in the APK form builder.
4. Query `/get-phone-carrier?phone=...` for external payer and recipient. Its
   recovered `carrier` field is at the **response root**, not under `data`.
   Do not guess carrier by prefix or silently override the user's selection.
5. For `wallet:funds`, require withdrawals enabled and enough balance for the
   payer amount, including the final reviewed value at submission. These wallet
   checks run first for a clear error. Wallet funding uses recipient `funds`
   availability, not external provider configuration or a global `ussd_pay` flag.
   It spends wallet balance and does not request an operator USSD collection.
6. `/money-transfers/review` supplies authoritative fee and amount values. Static
   fee tables are estimates, not an alternative to review.

`Ha.N` (`jadx/sources/Ha/N.java` in the private analysis) checks the recipient's
`money_transfer.carriers` flags, including `funds_enabled`, `external_enabled`
and `can_transfer`. Serializers establish snake-case response fields.
The local client is deliberately stricter about missing availability data than
the APK's nullable/default-true fields; it stops rather than assuming a service
is available. A successful preflight is a snapshot, not a settlement guarantee.

Tickets are bound to a credential fingerprint and expire after five minutes.
Changing sessions or the resolved provider code requires a new review. Tickets
without the recorded provider route cannot
be submitted without a fresh review. Authentication may prompt the user, but
**never confirms or submits a transfer automatically**.

### Provider-code evidence

Public `GET /payment-config` on 2026-10-29 returned `ussd_pay` mappings
`MTN Cameroon -> mtn_momo_cm` and `Orange -> om_cm_v2`; web/merchant entries were
disabled. Cached `/service-status` used provider codes in both
`enabled_payment_methods` and recipient `payment_methods`; recipient maps also
contained `funds`. The global map did not contain `funds` or `ussd_pay`.

These observations establish the availability namespaces, not a requirement to
replace the outgoing mode. `Ha.N` (`jadx/sources/Ha/N.java`)
sets the request's selected UI mode, and
`Ea.i` (`jadx/sources/Ea/i.java`) copies that payment-method
string into the initiation body. The client therefore resolves the provider code
only for local availability checks and keeps the request contract unchanged.
Tests cover both external carriers, wallet isolation, disabled/missing codes and
changed mappings between review and confirmation.

### Payment checks and provider prompts

`/money-transfers/initiate` creates the money request. It is not replaced with an
invented `POST /payment-requests` creation route.

`payment_requests` is a list of IDs distinct from the transfer ID. The dashboard
selects an ID only when exactly one is returned; otherwise it requires manual
selection from the result.

The APK's `Ea.h.d` consumes a `Unit`/standard acknowledgement for payment-check.
It does **not** establish that each check returns `data.payment_status`. The local
monitor accepts a recognizable snapshot if one is returned, but stops on an empty
acknowledgement instead of inventing progress. The app also has asynchronous local
state/notification paths; these have not been reconstructed into a live event feed.

Recognized statuses come from `MoneyTransactionFailedActivity`: `QUEUED`,
`PENDING`, `TIMEOUT`, `SUCCESSFUL`, `REJECTED`, `FAILED`, `INSUFFICIENT_BALANCE`,
`ACCOUNT_NOT_FOUND`, `UNKNOWN`, `INITIATION_FAILED`. `SUCCESSFUL` is displayed as
**collection confirmed**, not proof of recipient settlement. Unknown states,
acknowledgement-only responses, 401/403/429/5xx and network errors stop monitoring.

Polling is a local policy: at most 12 checks, 5 seconds between pending responses,
plus each request's timeout.
Stopping monitoring does not cancel the payment. There are no automatic retries
of initiation, refunds or cancellation.

Provider links require an independently configured exact HTTPS host allowlist.
They are never opened automatically. No USSD is dialed and no approval/webhook is
fabricated. A URL, HTTP 2xx or completed phone interaction is not settlement proof.

## Run guide

### Verify with isolated tests

```bash
npm run check
npm test
npm run build
```

Tests inject fixture transports and use temporary state. They never load the
real project `.env` or send production requests. `npm run web` is **not** a test
simulator: all its upstream actions contact the real services.

### User-operated live authentication, payments disabled

Edit a private, untracked `.env` file (do not overwrite an existing one):

```dotenv
SWITCHN_MODE=live
SWITCHN_ENABLE_LIVE=true
SWITCHN_ALLOW_PAYMENTS=false
SWITCHN_FIREBASE_API_KEY=YOUR_AUTHORIZED_SWITCHN_PROJECT_CLIENT_KEY
SWITCHN_DEBUG=true
SWITCHN_PORT=4317
```

Replace the placeholder locally. Leave `SWITCHN_BEARER_TOKEN` unset when acquiring
a stored session; an environment bearer overrides stored credentials. Configure
a legitimate FCM token only if your authorized integration requires one. The
Firebase REST request needs the client key, not a service-account private key.
Client keys recovered from the supplied APK remain private local configuration,
not committed source or exported archive contents.

```bash
chmod 600 .env
npm run web
```

Both interfaces load the current directory's `.env` automatically and reject
public permissions/symlinks. Existing process variables take precedence; unset
old shell exports such as `SWITCHN_MODE=mock` or `SWITCHN_ENABLE_LIVE=false`, which
now fail startup explicitly. Stop the old server with Ctrl+C, restart and refresh
the browser to get current assets and a new CSRF token.

Confirm **LIVE BACKEND** in the dashboard. Use the sign-in panel with your own
phone. Click **Request real sign-in code** once and enter the code received for
this exact sign-in only in the local interface. A separate phone-app code is not
interchangeable. Challenge acceptance does not prove SMS/WhatsApp delivery.
The server obtains the bearer and performs the protected readiness check.
If blocked by provider configuration/attestation, use the official integration;
do not generate fake identity tokens or headers.

CLI equivalents (also load `.env` automatically):

```bash
npm run cli -- auth bootstrap
npm run cli -- auth status
npm run cli -- auth validate
# Separate steps, if preferred:
npm run cli -- auth start YOUR_PHONE --transport sms
npm run cli -- auth verify
```

Do not pass OTPs, identity tokens or PINs in command arguments. `auth verify` uses
a hidden prompt. `auth cancel` only forgets the local challenge; `auth logout`
does not revoke server-side sessions or remove environment credentials.

If you already have your own authorized bearer, `auth import` remains supported;
then run `auth validate`. The UI never exposes a saved bearer to the browser.

### User-operated transfer

Only when you personally intend to attempt a real payment, enable
`SWITCHN_ALLOW_PAYMENTS=true` and restart the server with the same private
environment. Confirm the currency, units, recipient, fees and provider rules
independently. Review and click the final confirmation yourself.

The default dashboard monitor starts after a user-confirmed submission with one
payment-request ID. You may disable automatic monitoring or stop it at any time.
CLI: `transfer interactive` checks/signs in first and still requires explicit
review and confirmation; use `transfer watch PAYMENT_REQUEST_ID` afterwards.

User-completed authentication and GET-only preflight have now been observed
successfully. Payment initiation/USSD delivery and settlement have not. Reconcile
uncertain outcomes in the official account history before any new transaction.

## Diagnostics and recovery

Enable `SWITCHN_DEBUG=true` before starting the process.

- CLI prints sanitized traces to **stderr**, keeping stdout JSON usable.
- Dashboard: Advanced -> Request/response diagnostics.
- Records contain method, fixed-origin URL/path, headers, JSON bodies, actual
  status, elapsed time and error category. The last 50 are kept in process memory;
  bodies are omitted if an individual trace exceeds the size limit.
- Authorization, identity/access/refresh/FCM tokens, API keys, OTPs, PINs, phone
  identifiers, account hashes and signed challenge/payment URLs are masked.
  Known credentials echoed into another response field are also masked.
- This is deliberately not raw wire logging. Inspect non-sensitive structures
  and status codes, not secrets. Review even sanitized logs before sharing;
  unmodeled backend fields may contain personal data.

| Category | Meaning / next action |
|---|---|
| `receiver-name-required` | Enter or correct the recipient's registered Mobile Money account name. No payment was submitted. If the correct name is still refused, use the official app/support; do not guess or auto-resend. |
| `same-network-transfer` | Backend rejected same-network fee review; use the operator's direct transfer service. No payment was submitted. Do not falsify carrier selection. |
| `reload-required` | Local page has an old CSRF token; refresh after restarting the server |
| `bootstrap-not-configured` | Configure the authorized project's client key or import your legitimate bearer |
| `identity-rejected` | Firebase refused initialization; check project authorization/restrictions, use official flow if necessary |
| `session-required` / `session-rejected` | Sign in again; 401 disables this credential; payments are never replayed |
| `forbidden` | 403 permission refusal; re-login is not a bypass |
| `invalid-payload` | 400/409/422; inspect sanitized body/field diagnostics, correct input and review again |
| `action-required` | Backend requires an additional official verification/action; do not bypass it |
| `rate-limited` | 429; respect `Retry-After`, no automatic retry |
| `timeout` / `network-error` | Unknown network/provider outcome; do not blindly repeat a submission |
| `preflight-blocked` | Availability, carrier, method or wallet check failed; no initiation occurred |
| `invalid-response` | Unsupported/malformed response or mismatched ID; do not infer success |

A failed preflight leaves a ticket unattempted. A failure once the permanent
submission marker exists leaves `outcome-unknown`, including 401 during the POST.
Neither new authentication nor restarting the process unlocks that ticket.
