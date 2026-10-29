# Switchn Local Client

An **unofficial, live-only** TypeScript/Node.js CLI and local dashboard based on
static analysis of Switchn Android 4.1.2. Network actions use the actual Switchn
backend and Firebase identity service. There is no runtime simulator or fallback.

**Verified:** isolated contract tests, authentication/session lifecycle, headers,
payload validation, one-shot payment protection, local HTTP/UI and configuration.
**Live observations (2026-10-29):** the user completed phone sign-in; local
diagnostics confirmed successful Firebase, OTP, bearer exchange and protected
session responses. A guarded GET-only MTN preflight also passed with current
service/payment configuration and carrier lookups. The user's subsequent
MTN-to-MTN fee review was rejected with HTTP 422 because both numbers use the same
network; Switchn instructed using the mobile money provider directly. After the
receiver-name correction, the user reported a successful real USSD prompt.
That last result is user-reported, not independently captured. Automated tests
stay offline.
**Not verified:** recipient settlement, final live fees or general production
compatibility. A USSD prompt alone does not prove that a transfer completed.

Use only accounts and numbers you are authorized to manage. This is not a
production payment product or an operator settlement backend. Android-only
authentication requirements are not bypassed.

## Legal & Ethical Scope

`open_switchn` is an independent research and educational project focused on
understanding USSD-based cross-network mobile money transfer workflows in Cameroon.

The project aims to document technical behavior and explore reproducible
integrations. It is not affiliated with, endorsed by, or an official product of
Switchn, MTN, or Orange.

All testing should be conducted only on accounts and systems the researcher is
authorized to use, without accessing other users’ data, bypassing security
controls, or initiating unauthorized financial transactions.

No credentials, personal information, or sensitive transaction data should be
published. Any discovered vulnerabilities should be disclosed responsibly to the
relevant parties.

**Important:** Open-source availability does not imply authorization to use
third-party services, APIs, or payment infrastructure. Anyone deploying or
extending this project is responsible for obtaining the necessary permissions and
complying with applicable laws, provider terms, and financial regulations.

## Start here

Requires Node.js 24+ and npm. Run commands from this project directory.

```bash
npm ci --ignore-scripts
npm run check
npm test
npm run build
```

If a private `.env` already exists, keep it. For a fresh installation only:

```bash
cp -n .env.example .env
chmod 600 .env
```

Edit `.env` locally. Minimum phone sign-in configuration:

```dotenv
SWITCHN_MODE=live
SWITCHN_ENABLE_LIVE=true
SWITCHN_ALLOW_PAYMENTS=false
SWITCHN_FIREBASE_API_KEY=YOUR_AUTHORIZED_SWITCHN_PROJECT_CLIENT_KEY
SWITCHN_DEBUG=true
SWITCHN_PORT=4317
```

Replace the key placeholder locally. The key must identify the **Switchn Firebase
project**, not an unrelated project you create. The REST flow needs its client
API key; it does not need a service-account private key or Firebase Admin SDK.
The supplied APK's client configuration can be used for the authorized
integration, but its presence does not prove that Node access is permitted.
Never commit or distribute your real `.env`; the source archive excludes it.

```bash
npm run web
```

The CLI and web server automatically load the current directory's private `.env`.
Existing process variables take precedence. Old `SWITCHN_MODE=mock` or
`SWITCHN_ENABLE_LIVE=false` settings now stop startup with an explicit error;
remove those old shell exports. A missing `.env` is reported on stderr, and
process environment/live-only defaults are used instead.

Open the printed **127.0.0.1** URL, normally <http://127.0.0.1:4317>.
If the old server is still running, stop it with Ctrl+C in its terminal first.
Restart after changing code/configuration, then refresh the page: assets and the
local CSRF token are created at startup. An old tab can otherwise return 403.
Do not expose the server through a tunnel, proxy or network interface.

### Sign in, with payments disabled

1. Confirm the banner says **LIVE BACKEND**.
2. Enter your own Switchn account number and choose SMS or WhatsApp.
3. Click **Request real sign-in code** once. This contacts login-options,
   Firebase anonymous authentication, then Switchn's OTP endpoint.
4. Enter the code received for **this local sign-in**. A code requested separately
   in the phone app is not interchangeable.
5. The client verifies the OTP, exchanges the original identity token for the
   Switchn bearer, saves it privately and checks it with protected `/my-funds`.

A challenge acknowledgement is not proof of message delivery. If an upstream
step fails, inspect Advanced diagnostics; the client never substitutes a code
or successful session. Sign-in does not submit a payment.

CLI alternatives:

```bash
npm run cli -- auth bootstrap
npm run cli -- auth status
npm run cli -- auth validate
# Separate steps:
npm run cli -- auth start YOUR_PHONE --transport sms
npm run cli -- auth verify
```

`auth verify` uses a hidden prompt. Never pass OTPs or PINs in shell arguments.
If you already have an authorized bearer, use the hidden `auth import` prompt.
Leave `SWITCHN_BEARER_TOKEN` empty/unset when acquiring a stored session: an
environment bearer overrides it. `auth cancel` forgets only a local challenge;
`auth logout` does not revoke server-side tokens or clear environment variables.

### Make a user-confirmed payment

Only when you intend to submit a real payment, set
`SWITCHN_ALLOW_PAYMENTS=true` in `.env`, restart, and refresh the page.

1. Enter payer/recipient numbers, actual networks and a whole-unit amount.
   Enter the **recipient's exact registered Mobile Money account name** in the
   visible recipient-name field. It is required for cross-network and
   wallet-funded transfers; obtain it from the recipient, not a guess/nickname.
2. Select `ussd_pay` for operator/USSD approval, if supported by current
   carrier/payment configuration. No number-prefix guessing is used.
3. Click **Review amount and fees**. The client validates the session and
   carrier/payment availability before obtaining the backend quote.
4. Check numbers, units/currency, recipient, final amounts, fees and alerts.
5. Tick the confirmation checkbox and personally click **Send payment request**.
   The same preflight runs again; initiation is attempted only once.
6. Follow legitimate provider instructions and approve on your own phone.
   The client never dials USSD or enters your operator/SIM PIN.
7. Follow the returned **payment-request ID**, not the transfer ID. Check official
   history too. If the outcome is uncertain, do not submit another transfer.

For a phone-funded MTN payment, **Your network must be MTN MoMo**, not Internal
wallet. Internal wallet spends the Switchn wallet balance, requires wallet
withdrawals to be enabled, and does not generate an operator collection prompt.
Review is allowed with payments disabled; final submission is not.

**Same-network transfers:** the observed live backend rejects MTN-to-MTN review
and instructs using the operator's direct transfer service. Passing preflight
does not override this backend rule. Do not change a number's carrier to Orange
to get around it, or keep retrying. Use genuine cross-network details only when
that is the intended transfer, and still obtain an accepted backend review.

**Receiver-name validation:** the observed MTN-to-Orange review also returned
422 requesting the receiver's Mobile Money account name. The client now rejects
missing cross-network/wallet names before making upstream requests; the CLI
prompts for the name and the dashboard displays it beside the recipient number.
If Switchn still rejects a supplied name, the UI explains which field to correct.
Do not guess another name or automatically resend. Verify the registered name
with the recipient; use the official app/support if the correct name is refused.
Names remain redacted in diagnostics, so logs do not establish what was entered.

Payment modes and provider codes are distinct. `/payment-config` maps, for example,
`ussd_pay` + MTN to `mtn_momo_cm` and `ussd_pay` + Orange to `om_cm_v2` in the
observed configuration. Preflight checks those codes against `/service-status`;
the outgoing request still uses `ussd_pay`, following the APK builder. Codes are
read dynamically, never hardcoded as routing rules. A code change after review
requires a new review before any submission.

The CLI provides the same guided review/confirmation:

```bash
npm run cli -- transfer interactive
npm run cli -- transfer watch PAYMENT_REQUEST_ID
```

The dashboard fills an ID only when exactly one is returned and can monitor at
most 12 checks, five seconds apart plus request timeouts. **Stop watching** stops
monitoring, not the payment. Acknowledgement-only or unknown responses stop
explicitly. `SUCCESSFUL` means collection confirmed, not proven recipient
settlement. A 2xx, payment link or USSD approval alone is not settlement proof.

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `SWITCHN_MODE` | `live` | Only `live` accepted; no mode switch |
| `SWITCHN_ENABLE_LIVE` | `true` | Compatibility setting; only `true` accepted |
| `SWITCHN_ALLOW_PAYMENTS` | `false` | Separate initiation/airtime/bundle permission |
| `SWITCHN_FIREBASE_API_KEY` | absent | Switchn Firebase client configuration, not a bearer |
| `SWITCHN_BEARER_TOKEN` | absent | Authorized bearer override; prevents saving a different session |
| `SWITCHN_FCM_TOKEN` | absent | Legitimate FCM token if required; not fabricated here |
| `SWITCHN_APP_VERSION` | `4.1.2` | Analyzed APK version; current backend acceptance unknown |
| `SWITCHN_USER_AGENT` | `switchn-local-client/0.1` | Honest unofficial client identifier |
| `SWITCHN_DEBUG` | `false` | Sanitized, bounded in-memory traces; CLI stderr / Advanced |
| `SWITCHN_DATA_DIR` | `~/.local/state/switchn-local-client` | Absolute root; live state under `live/` |
| `SWITCHN_TIMEOUT_MS` | `15000` | Per-request timeout; no automatic retries |
| `SWITCHN_PORT` | `4317` | Loopback port; `0` chooses an available port |
| `SWITCHN_PAYMENT_HOSTS` | empty | Independently verified exact HTTPS hostnames, comma-separated |

The fixed API origin is `https://api.switchn.net`. Firebase uses only
`https://identitytoolkit.googleapis.com/v1/accounts:signUp`. There is no
arbitrary-URL proxy, configurable fake backend, automatic redirect following or
production-to-fixture fallback. Test fixtures are confined to `test/` and injected
explicitly by the test runner.

State files use `0600`, directories `0700`; this is **not encryption or a
keychain**. Old mock state is neither loaded nor migrated into live credentials.
A rejected bearer remains rejected across restarts. Reviews expire after five
minutes and are bound to the session that obtained them. Permanent attempt
markers prevent automatic replay, even after reauthentication.

## Architecture

```text
src/
  config.ts       Live-only validation and private .env loader
  models.ts       Reconstructed schemas and safe monetary types
  api.ts          Fixed-origin JSON transport, auth and service methods
  auth.ts         Firebase -> Switchn OTP -> bearer lifecycle
  storage.ts      Private session/challenge/state persistence
  lifecycle.ts    Protected preflight and bounded payment monitoring
  workflow.ts     Review -> expiring ticket -> confirmed one-shot submission
  diagnostics.ts  Sanitized request/response traces
  http.ts         Bounded JSON reader and lossless-number checks
  fees.ts         Decimal fixed/percentage withdrawal estimates
  catalogs.ts     Validated catalog import
  presentation.ts Redaction and safe errors
  cli.ts          Interactive/scriptable commands
  web.ts          Loopback server, Host/Origin guards and CSRF
public/           Dashboard, no external assets or browser token storage
test/             Explicit fixtures and isolated offline tests only
docs/             Endpoint mapping, lifecycle evidence and verification guide
```

Compiled execution: `node dist/src/cli.js web`. Keep `public/` beside `dist/`
and run from the directory containing your private `.env`.

## Repository contents and first push

Commit the application source (`src/`, `public/`), documentation, `test/`,
`package.json`, **`package-lock.json`**, `tsconfig.json`, `.env.example`,
`.gitignore` and `.gitattributes`. Keep the tests: they contain synthetic inputs,
not real account credentials, and protect the authentication/payment safeguards.
No APK, decompiler or private analysis folder is required to build or run tests.
References to analysis files in the docs are provenance identifiers, not runtime
dependencies or files to upload.

`.gitignore` excludes real `.env` files, private state, keys, logs, captures,
decompiled artifacts, archives, dependencies, build output and coverage.
Your local files are not deleted. Do not use `git add -f` to override these
protections. If you choose a custom state directory, keep it outside the
repository or under `.state/`. Ignore rules do not remove files already committed
in an existing repository's history.

Before your first commit, inspect exactly what Git will include:

```bash
git status --short
git add .
git diff --cached --stat
git diff --cached --check
# Review locally; do not paste credential-bearing output into chat:
git diff --cached
git commit -m "Initial Switchn local client"
```

Then verify your remote locally with `git remote -v` and push:

```bash
git push -u origin main
```

If there is no `origin` yet, create an empty remote repository and use
`git remote add origin YOUR_REPOSITORY_URL` first. If one already exists, verify
its destination rather than replacing it blindly. Do not put access tokens in
remote URLs. Use SSH or your Git credential manager.

After cloning elsewhere, run `npm ci --ignore-scripts`, `npm run check`,
`npm test` and `npm run build`. Create a new private `.env` from `.env.example`
and configure your authorized credentials locally; they are intentionally not
included in Git. `private: true` prevents accidental npm publication, **not**
public visibility on Git hosting. No open-source license is selected; choose
one you are entitled to grant before inviting public redistribution.

## Airtime, catalogs and fees

Advanced retains airtime/bundle preparation, catalogs, fees and local ticket
history. Local history is not complete account history.

```bash
npm run cli -- airtime prepare /absolute/path/airtime.secret.json
npm run cli -- bundles prepare AUTHORIZED_PROMOTION_CODE RECIPIENT_PHONE
npm run cli -- bundles remote
npm run cli -- fees mtn_mobile_money 1000
npm run cli -- fees orange_money 1000
npm run cli -- cross-fees
```

Use your own validated inputs, not test fixtures. Airtime and bundle preparation
are local confirmation steps, not backend price locks; submission uses the same
payment gate and explicit confirmation. Imported catalogs can be stale. Import
only valid strict catalog JSON using `bundles import`, not the APK's malformed
template-like generic catalog.

Fee-table `currency` is fixed; `percentage` is amount * value / 100. Missing,
overlapping or unsupported ranges fail explicitly, never become zero fees.
Final transfer fees come from backend review. Transfer carriers `MTN Cameroon`
and `Orange` differ from fee keys `mtn_mobile_money` and `orange_money`.
The internal-wallet source is `wallet:funds`.

## Diagnostics and limits

Enable `SWITCHN_DEBUG=true` for the last 50 sanitized traces. They include request
method/path, headers/body, actual upstream status/body, timing and error category.
Authorization, keys, OTPs, PINs, phone identifiers and signed URLs are masked,
including known secret values echoed elsewhere. Traces are memory-only; inspect
them before sharing because unknown backend fields may contain personal data.

Restricted Android keys, attestation, CAPTCHA, required FCM registration,
disabled anonymous sign-in or native Google SMS fallback can block this REST
adapter. Use an officially supported integration/native app; no bypass is
implemented. No Switchn bearer-refresh/revocation contract was recovered.

See [API mapping](./docs/API_REFERENCE.md),
[authentication, lifecycle and recovery](./docs/AUTH_WORKFLOW.md), and
[verification guide](./docs/VERIFICATION.md) for exact contracts and limitations.
