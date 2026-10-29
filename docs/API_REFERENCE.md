# Reconstructed API reference

## Authority and scope

Source: user-supplied Switchn Android `net.switchn.switchn`, 4.1.2 (236).

- XAPK SHA-256: `900f8f2c51b596fd46df8be56929958f7d20a2bd3883b8fff7a02f37ce7539d0`
- Base APK SHA-256: `bdf6e222224c1610c50466adca37e83f4594897a546394e297f95a8867582ccd`
- Original analysis: `switchn-analysis/REPORT.md`, kept outside this repository.
  Decompiled artifacts and private evidence are not required to run this client.
- Relevant REA IDs: `ev_d735046f708353f5ba45444a9ccfdea3b269549e40627bde98ac992f5a6cbbf9` (legacy transfer method), `ev_f3042e1ab399e08aa8f192522e0940df615030f3ead3f1eb60aeb8bd489938e2` (newer initiation references), `ev_627d84c73e1b3625b7871b1589c03ca603deb70fe982bafbcf1f2338d082953a` (fee calculation).

This is the route inventory recovered in the investigation, **not an exhaustive backend specification**. Static declarations prove shipped client expectations, not live service behavior.

## Base URL, headers and transport

Base: `https://api.switchn.net`.

The application is live-only: there is no mock transport or runtime fallback.
The CLI/web entry point automatically loads private `.env` configuration.
`SWITCHN_MODE=mock` and `SWITCHN_ENABLE_LIVE=false` are rejected. Payment
initiation still requires separate explicit permission and user confirmation.
Firebase identity initialization uses its fixed Google endpoint, not this API
origin; see the [authentication chain](./AUTH_WORKFLOW.md).

The implemented shared client uses:

| Header | Value / provenance |
|---|---|
| `Authorization` | `Bearer <authorized access token>` for protected operations |
| `Content-Type` | `application/json` |
| `Accept` | `application/json` |
| `app-version` | `4.1.2` by default, observed APK value |
| `platform` | `android`, observed newer Ktor/auth header |
| `User-Agent` | Configurable; defaults to an honest unofficial client identifier |
| `fcm-token` | Only supplied when a legitimate value is configured |

Payment namespaces are separate: request `payment_method` uses the selected
`ussd_pay`/`web_pay`/`merchant_pay`; `/payment-config` maps that mode and payer
carrier to `final_api_code` for provider availability checks in `/service-status`.
The public configuration observed on 2026-10-29 mapped MTN USSD to `mtn_momo_cm`
and Orange USSD to `om_cm_v2`. Wallet availability uses `funds`, not an external
mode/code. These mappings are snapshots, not hardcoded protocol constants.

Legacy annotations vary by route; not all legacy endpoints explicitly have all these headers. The newer Ktor client installs common defaults. Bearer auth is not attached to identity-token exchanges or OTP validation. OTP creation allows an existing session without requiring one locally.

No separate Switchn API key, payment-body HMAC, or application-encrypted envelope was established in the inspected online path. Do not invent a key or signature header.

Redirects are **not followed** by the JSON client, preventing bearer forwarding to an unrelated URL. Dynamic OTP URLs must stay on the same HTTPS origin and within `/otps/`; this restriction is a deliberate local safety policy, not a proven complete set of server URL formats.

## HTTP status codes: observed versus assumed

The initial APK analysis was static; later live observations are listed below.
They do not establish that every creation returns 201, every success returns 200,
or every validation failure returns 422.

The implementation:

- Accepts HTTP 2xx **only as transport success**, then parses JSON and validates operation-specific fields.
- Rejects non-2xx, including 3xx, without automatic retries.
- Rejects `success: false` or a non-null `action_required` even on HTTP 2xx.
- Preserves the actual HTTP status as `httpStatus` in successful client results and `httpStatus` on `ApiError`.
- Treats unknown/malformed response shapes after submission conservatively; the ticket stays `outcome-unknown`.

Conventional interpretations of 401/403 (authentication/authorization), 409/422 (conflict/validation), 429 (rate limit), and 5xx (server failure) are **general HTTP expectations**, not verified Switchn endpoint contracts. Test fixture 200/501 and local dashboard 400/403/404/502 responses are project behavior, not REA observations.

On 2026-10-29, cached diagnostics from the user's completed sign-in showed 200
responses for login-options, Firebase anonymous identity, Switchn OTP creation and
verification, bearer exchange and `/my-funds`. Guarded live GET-only validation
also observed 200 for `/my-funds`, `/service-status`, `/payment-config` and both
phone carrier lookups.

The user's subsequent `POST /money-transfers/review` returned **422** for an
MTN-to-MTN transfer, with the message: "The payer and receiver use the same network.
Please transfer directly using your mobile money service." This is a backend
business-rule rejection, not evidence of expired authentication. The client
recognizes this exact route/status/message and exposes a safe local
`same-network-transfer` error without replaying or submitting anything.
Other backend messages remain in sanitized diagnostics, not interpolated into
user-facing errors. No successful live review, initiation or payment outcome
has been verified.

## Common response model

`StandardResponse` declares nullable/optional fields:

```typescript
interface StandardResponse {
  success?: boolean | null;
  message?: string | null;
  error_code?: string | null;
  action_required?: unknown;
}
```

Specific responses add `data`; it may be absent/null in the decompiled model. Do not default a missing field to a successful transaction. The tool requires usable review data and an ID for money/airtime acknowledgements, rather than silently synthesizing missing values.

## Money transfer models and routes

`MoneyRequestBody` fields:

| Field | Type / origin |
|---|---|
| `from`, `to` | String payer/recipient identifiers |
| `from_carrier`, `to_carrier` | Optional/nullable carrier strings; supported UI labels: `MTN Cameroon`, `Orange` |
| `amount_before_fees`, `amount_after_fees` | Android Long; client accepts safe positive integer numbers |
| `transaction_specific_fee`, `transaction_specific_cash_out_fee` | Android Long; safe nonnegative integer numbers |
| `lang`, `app_version`, `channel` | Strings; observed channel `android_app` |
| `transaction_reference` | String, possibly empty |
| `payment_method` | Optional string; builder values `ussd_pay`, `web_pay`, `merchant_pay` |
| `schedule_at` | Optional string; exact server date-format contract not fully recovered |
| `pin` | Optional string; does not establish that an operator/SIM PIN is required |
| `inputted_receiver_name` | Nullable/optional in the wire model; required in local cross-network/wallet drafts and observed as required in live MTN-to-Orange review |
| `force_rerun` | Optional boolean; not enabled by the high-level workflow |

Internal-wallet payment uses `from: "wallet:funds"`. The high-level builder does not attach an external `from_carrier` to this source. External payers must explicitly identify their carrier; number prefixes are not used to infer it.

The draft builder starts before/after amounts at the entered amount and transfer fee at zero, matching the inspected form shape. **Those are review inputs, not a claim of free pricing.** Confirmation substitutes the backend review's amounts/fees.

`MoneyTransferReview.data` includes payer/recipient/carriers, before/after amounts, transaction-specific fees, recipient/name-match information and alerts. Android represents these review amounts as floats; this implementation rejects fractional/unsafe monetary values before creating a final integer request.

The user's MTN-to-Orange review returned HTTP 422 with: "Enter the receiver's
Mobile Money account name. Already entered or no field? Update Switchn, then try
again." The original text used a curly apostrophe. The client recognizes either
apostrophe for this exact route/status/message and exposes `receiver-name-required`
without copying arbitrary upstream text. The `errors.inputted_receiver_name`
value and the supplied name stay redacted. This evidence does not establish
whether the submitted name was missing, null or unacceptable.

`MoneyRequestResponse.data` is a money request/transaction with fields including `id`, `last_state`, `cash_in_status`, `payment_status`, `payment_link`, `sender`, `receiver`, and **`payment_requests` (plural, a list)**.

Each `PaymentRequest` declares `id`, `payer_id`, `payable_id`, `amount`, `payment_method`, `request_state`, `payment_status`. Do not substitute the transfer ID for a payment-request ID.

| Method | Route | Request / result | Implementation |
|---|---|---|---|
| POST | `/money-transfers/review` | `MoneyRequestBody` -> review `data` | CLI + dashboard |
| POST | `/money-transfers/initiate` | Confirmed `MoneyRequestBody` -> money request `data` | One-shot ticket confirmation |
| POST | `/payment-requests/{id}/payment-check` | Path ID; no body; APK consumes Unit/standard acknowledgement, not a guaranteed status snapshot | Single check + bounded monitor, never infers payment from acknowledgement |
| POST | `/money-transfers/{id}/cancel` | `CancelRequestBody`; fields not fully mapped here | Inventory only |
| POST | `/money-transfers/{money_transfer}/refund` | Path parameter; no body in legacy declaration | Inventory only |
| POST | `/money-transfers/{money_transfer}/change-receiver` | `{ "new_receiver": "<number>" }` | Inventory only |
| GET | `/momo-cross-network-fees` | Cross-provider fee data | CLI |
| GET | `/momo-withdrawal-fees` | Provider withdrawal tables | CLI + dashboard |
| GET | `/momo-name?phone=...` | Phone display-name response | CLI lookup |
| GET | `/get-phone-carrier?phone=...&context=...` | `carrier` and `options` at response root; `context` optional in legacy wrapper | CLI and preflight use phone |
| GET | `/service-status` | `data.money_transfer`, `enabled_payment_methods`; no live values observed | CLI + dashboard + preflight |
| GET | `/payment-config` | `data.payment_methods[].method/carriers`; no live values observed | CLI + preflight |

Source map:

- `Ha.N.invokeSuspend`: initial money body, provider/method selection.
- `La.a` -> `Ea.h.b`: review call.
- `Ha.B`: confirmed values from review.
- `Ea.i.a`: final request mapping.
- `Ka.x.invokeSuspend` -> `Ea.h.e`: initiation.
- `Ea.h.d`: **POST**, not GET, payment check.
- `P5.u0.m` -> `u7.u` POST constant; `P5.u0.k` -> GET constant.
- `ka.b`, `ka.d`, `Da.i`: common headers and bearer injection.
- `m9.n`, `JsonApi`, `MoneyApi`: older Retrofit/OkHttp implementation.

## Authentication, verification and account endpoints

| Method | Route | Payload/query and response evidence | Implementation |
|---|---|---|---|
| POST | `/auth/sanctum/token` | `UserDevice`; response `data.access_token` | `auth login device` + guided sign-in after OTP |
| POST | `/auth/{provider}/token-anonymous` | `UserDeviceGoogleAnonymous`; provider `google.com`; `data.access_token` | `auth login google` |
| POST | `/auth/{provider}/token` | `UserDeviceGoogle` (`token`, `device_name`, `device_lang`); existing bearer | Inventory only |
| GET | `/auth/login-options` | Query `primary_number`; `data` is a string list | `auth options` + guided SMS/WhatsApp choice validation |
| POST | `/otps` (default creation URL) | `OtpCreateRequest`; returned `validate_url`, identifiers and retry metadata | Low-level adapter + guided sign-in |
| POST | Server-returned OTP validation URL | `OtpValidateRequest`; `data.status_code`, `data.unique_id`; callback checks explicit success | Low-level adapter + guided validation, followed by separate device exchange |
| POST | `/missed-call-verifications` | `CallVerificationCreateRequest`; full schema not mapped here | Inventory only |
| GET | `/missed-call-verifications/{uuid}` | UUID status lookup | Inventory only |
| POST | `/oauth/{provider}/link` | `UserDeviceGoogle` | Inventory only |
| POST | `/oauth/{provider}/link-anonymous` | `UserDeviceGoogleAnonymous` + bearer | Inventory only |
| GET | `/oauth/linked` | Query `device_lang`, bearer | Inventory only |
| POST | `/payment-numbers` | `PaymentNumber`; full schema not mapped here | Inventory only |
| DELETE | `/payment-numbers/{payment_number}` | Path parameter, bearer | Inventory only |
| POST | `/fcm-token` | `UserFcm` (token and device metadata) | Inventory only |
| GET | `/users/{primary_number}/payer-identifier-tokens` | Offline payer-hash response | Inventory only; no offline payment protocol |

`UserDevice`:

```typescript
{ token: string; device_name: string; device_lang: string; phone: string }
```

`UserDeviceGoogleAnonymous`:

```typescript
{
  token: string;
  device_name: string;
  device_lang: string;
  primary_number: string;
  provider_data: {
    rawId: string | null;
    displayName: string | null;
    screenName: string | null;
    email: string | null;
    photoUrl: string | null;
    providerId: string | null;
    phoneNumber: string | null;
  };
}
```

The APK permits a nullable Google token; this client requires a nonempty token rather than attempting an undocumented null-token authentication path. `provider_data` must describe the caller's legitimate identity-provider result; populating strings is not identity verification.

`OtpCreateRequest`:

```typescript
{ token: string; phone_number: string; device_lang: string; transport: string }
```

The DTO alone did not establish provenance. Follow-up tracing now identifies a
Firebase anonymous ID token passed through the phone-login activities.
`SmsVerifyActivity.q` and `WhatsappVerifyActivity.q` select `sms` and `whatsapp`;
`googlesms` is a separate native Firebase phone-verification fallback and is not
implemented here. The guided client first requires the matching `otp_sms` or
`otp_whatsapp` option from the server. Current live acceptance remains unverified.

`OtpValidateRequest`:

```typescript
{ otp: string; device_lang: string; device_name: string; do_login: boolean }
```

Creation response data includes `status`, `unique_id`, `resend_url`, `validate_url`, `phone_number`, `phone_carrier`, `resend_sms_gap`, `attempts`, `max_resend`, `is_local`. The tool does not automatically resend or consume attempt budgets.

The validation response model is **not** a `SanctumTokenResponse`. The APK then
calls device registration using the original Firebase ID token and phone number;
that separate response supplies the bearer. This chain is now implemented.
No Switchn refresh/revocation contract was found in the inspected clients.
An opaque bearer's expiry is not guessed: protected validation and 401 handling
determine readiness, with user-driven reauthentication and no payment replay.

The Node identity adapter uses Firebase's documented REST endpoint
`POST https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=...` with
`{"returnSecureToken":true}`. This is an official SDK-equivalent REST contract,
not a new Switchn endpoint or proof that the shipped project's restrictions
permit Node access. No key is hardcoded; the authorized project's client key
must be configured. See [authentication evidence and run guide](./AUTH_WORKFLOW.md).

## Airtime, data, wallet and linked workflows

| Method | Route | Payload/query | Implementation |
|---|---|---|---|
| POST | `/airtime-requests/web?channel=android_app` | `AirtimeRequestBody` | Prepared ticket + confirmation |
| GET | `/airtime-requests/web/{airtime_request_id}` | Path ID | Inventory only |
| POST | `/airtime-requests/{id}/cancel` | `CancelRequestBody` | Inventory only |
| POST | `/airtime-requests/{id}/payment-check` | Path ID | Inventory only |
| POST | `/airtime-request-reviews` | `AirtimeRequestReviewBody` | Inventory only |
| POST | `/airtime-request-reviews/{id}/process` | `AirtimeRequestReviewProcessBody`; fields not fully mapped | Inventory only |
| GET | `/active-promotions` | No body | Remote catalogs |
| POST | `/bundles/{promotion}/activate/{phone}` | Path parameters, bearer, User-Agent; no body in legacy declaration | Prepared ticket + confirmation |
| POST | `/transactions/{transaction_id}/retry` | Query `lang` | Inventory only; never automatic |
| POST | `/receiver-switches/{receiver_switch_id}/user-response` | `ReceiverSwitchServer`; full schema not mapped here | Inventory only |
| GET | `/users/{primary_number}/good-deal` | Path parameter | Inventory only |
| GET | `/users/{primary_number}/history-items` | `page[number]`, `page[size]` | Inventory only |
| GET | `/my-funds` | Wallet data: `id`, string `balance`, `withdrawals_enabled`, etc. | Protected session readiness probe; balance check for wallet source |
| POST | `/my-funds/deposit` | `WalletFundRequest`; full schema not mapped here | Inventory only |
| POST | `/scheduled-tasks/{id}/reschedule` | `RescheduleTransactionBody` | Inventory only |
| POST | `/scheduled-tasks/{id}/run-now` | Path ID; airtime/money response variants | Inventory only |
| POST | `/transaction-pin/set` | `CreatePinRequest` | Inventory only |
| POST | `/transaction-pin/change` | `ChangePinRequest` | Inventory only |
| POST | `/transaction-pin/initiate-reset` | `InitiatePinResetRequest` | Inventory only |
| POST | `/transaction-pin/complete-reset` | `CompletePinResetRequest` | Inventory only |

`AirtimeRequestBody` fields: `to`, `payer`, `amount`, `code`, `lang`, `cancel_url`, `return_url`, `schedule_at`, `pin`, `payer_carrier`, `to_carrier`, `payment_method`. The implementation supports these fields and keeps PIN out of saved tickets.

The separate newer `AirtimeRequestReviewBody` also contains `channel` and `test_notifications`; the latter is not exposed as an automation feature. The older `BundleRequestBody` has `bundle_id`, `to`, `payer`, `lang`, `cancel_url`, `return_url`; its presence does not establish that current bundle activation uses it.

Receipt URL strings were observed for `/money-transfers/{id}/receipt` and `/airtime-requests/{id}/receipt`. They are not treated as payment-status APIs.

The distinct airtime-to-cash repository contains `/airtime-to-cash/config`, `/airtime-to-cash/requests`, and a `/airtime-to-cash/requests/{...}` family. These were located, not fully reconstructed as a complete HTTP/payload contract; no adapter is guessed here.

## Fee response shapes

Withdrawal:

```typescript
{
  data: {
    mtn_mobile_money: FeeBracket[];
    orange_money: FeeBracket[];
  };
}
interface FeeBracket {
  amount_range: { min: number; max: number };
  fee: { unit: "currency" | "percentage"; value: number };
}
```

Cross-network rows have `from_provider`, `to_provider`, `amount_range`, `fee`. No live brackets or prices were obtained.

The original UI uses inclusive boundaries and fixed/percentage arithmetic. This client deliberately rejects overlapping brackets rather than choosing an ambiguous price. An estimate is labeled `authoritative: false`; before/after totals are taken from the transfer review.

## Provider navigation is not a webhook

The Android Orange payment screen consumes an intent/response `payment_link` and loads it in a WebView. The URI is dynamic; an operator host cannot safely be guessed from a route name.

This project exposes an external link only after exact-host HTTPS allowlisting and explicit user navigation. No credentials are forwarded by the JSON client. USSD approval must be performed by the account owner outside the tool.

No server-to-server MTN/Orange API contract, OAuth secret, webhook signature, settlement ordering, reconciliation or backend idempotency guarantee was recovered. The local one-shot ticket is a client safety measure, not a substitute for those backend controls.
