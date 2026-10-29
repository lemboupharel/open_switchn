import { setTimeout as sleep } from "node:timers/promises";
import { Decimal } from "decimal.js";
import { z } from "zod";
import { ApiClient, ApiError, type ApiResult } from "./api.js";
import { carrier, identifier, type MoneyBody } from "./models.js";
import { tokenFingerprint } from "./storage.js";

const carrierState = z.object({
  carrier: z.string(), enabled: z.boolean().nullable().optional(),
  can_transfer: z.boolean().nullable().optional(), status: z.string().nullable().optional(),
  external_enabled: z.boolean().nullable().optional(), funds_enabled: z.boolean().nullable().optional(),
  payment_methods: z.record(z.boolean()).nullable().optional()
});
const serviceState = z.object({
  enabled_payment_methods: z.record(z.boolean()).nullable().optional(),
  money_transfer: z.object({
    available: z.boolean().nullable().optional(), status: z.string().nullable().optional(),
    carriers: z.array(carrierState).nullable().optional()
  })
});
const paymentConfiguration = z.object({
  payment_methods: z.array(z.object({
    method: z.string(), carriers: z.record(z.object({
      enabled: z.boolean().nullable().optional(), final_api_code: z.string().nullable().optional()
    })).nullable().optional()
  }))
});

export async function activeIdentity(api: ApiClient): Promise<string> {
  const token = await api.session.token();
  if (!token) throw new ApiError("Sign in before continuing. No payment attempted.", undefined, false, "session-required");
  return tokenFingerprint(token);
}
export async function sameIdentity(api: ApiClient, fingerprint: string): Promise<void> {
  if (await activeIdentity(api) !== fingerprint) throw new ApiError(
    "Session changed since this flow started. Obtain a fresh review under the current session.", undefined, false, "session-changed");
}
export async function preflight(api: ApiClient, body: MoneyBody) {
  const fingerprint = await activeIdentity(api);
  const { wallet } = await api.validateSession();
  const walletFunded = body.from === "wallet:funds";
  function blocked(message: string): never { throw new ApiError(message, undefined, false, "preflight-blocked"); }
  if (walletFunded) {
    if (wallet.withdrawals_enabled !== true) {
      blocked("Internal wallet withdrawals are disabled or unconfirmed. To pay from your MTN/Orange phone balance, select that network instead of Internal wallet.");
    }
    if (new Decimal(wallet.balance).lt(body.amount_before_fees)) blocked("Wallet balance is insufficient for the reviewed payer amount.");
  }
  const status = serviceState.parse((await api.serviceStatus()).body.data);
  const money = status.money_transfer;
  if (money.available !== true || money.status === "unavailable") blocked("Money transfers are unavailable or availability is unconfirmed.");
  if (money.status === "funds_only" && body.from !== "wallet:funds") blocked("Only wallet-funded transfers are currently available.");
  const recipient = money.carriers?.find(row => row.carrier.toLowerCase() === body.to_carrier?.toLowerCase());
  if (!recipient || recipient.enabled === false || recipient.can_transfer === false || recipient.status === "unavailable") {
    blocked("Recipient carrier is unavailable or missing from the service snapshot.");
  }
  if ((walletFunded ? recipient.funds_enabled : recipient.external_enabled) !== true) {
    blocked("The selected funding route is disabled or not explicitly available.");
  }
  let providerMethodCode = "funds";
  if (!walletFunded) {
    if (!body.from_carrier || !body.payment_method) blocked("External payment requires a payer carrier and payment method.");
    const payment = paymentConfiguration.parse((await api.paymentConfig()).body.data);
    const selected = payment.payment_methods.find(item => item.method === body.payment_method);
    if (!selected) blocked("Payment method is absent from the current payment configuration.");
    const payerMethod = selected.carriers?.[body.from_carrier];
    if (!payerMethod || payerMethod.enabled !== true) blocked("Payer carrier does not currently offer the selected payment method.");
    const code = payerMethod.final_api_code;
    if (!code || !/^[a-z0-9_]{1,128}$/.test(code)) {
      blocked("Payment configuration is missing a valid provider method code. No route was guessed.");
    }
    providerMethodCode = code;
    // Requests retain ussd_pay/web_pay/merchant_pay; availability uses the provider namespace.
    if (status.enabled_payment_methods?.[providerMethodCode] !== true) {
      blocked("The configured provider payment route is disabled or availability is unconfirmed.");
    }
  }
  if (recipient.payment_methods?.[providerMethodCode] === false) {
    blocked("The recipient carrier does not accept the configured funding method.");
  }
  for (const [phone, expected] of [[body.to, body.to_carrier], [body.from, body.from_carrier]]) {
    if (!phone || phone === "wallet:funds") continue;
    const result = await api.lookup(phone, "carrier");
    // The recovered carrier response has carrier at the root, not in data.
    const actual = carrier.parse(result.body.carrier);
    if (actual !== expected) blocked("Carrier lookup disagrees with the selected network. Correct it and obtain a fresh review.");
  }
  await sameIdentity(api, fingerprint);
  return { checkedAt: new Date().toISOString(), fingerprint, walletBalance: wallet.balance,
    recipientCarrier: body.to_carrier, paymentMethod: body.payment_method, providerMethodCode };
}

export function paymentObservation(result: ApiResult, requestedId: string) {
  identifier.parse(requestedId);
  const data = result.body.data;
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return { phase: "status-unavailable" as const, terminal: true,
      message: "Payment check acknowledged without a status snapshot. Check official history; this does not prove payment." };
  }
  const row = z.object({
    id: z.union([z.string(), z.number().int().max(Number.MAX_SAFE_INTEGER)]).optional(),
    payment_status: z.string().optional()
  }).parse(data);
  if (row.id !== undefined && String(row.id) !== requestedId) {
    throw new ApiError("Payment-check response ID does not match the requested ID.", result.httpStatus, false, "invalid-response");
  }
  const state = row.payment_status?.toUpperCase();
  if (state === "SUCCESSFUL") return { phase: "payment-confirmed" as const, terminal: true, rawStatus: row.payment_status,
    message: "Backend reports collection successful. Recipient settlement must still be confirmed in official history." };
  if (state && ["REJECTED", "FAILED", "INSUFFICIENT_BALANCE", "ACCOUNT_NOT_FOUND", "INITIATION_FAILED"].includes(state)) {
    return { phase: "payment-failed" as const, terminal: true, rawStatus: row.payment_status, message: "Backend reports payment failure. Do not retry automatically." };
  }
  if (state === "PENDING" || state === "QUEUED") return { phase: "awaiting-provider" as const, terminal: false,
    rawStatus: row.payment_status, message: "Waiting for provider confirmation. Approve only on your own phone or verified provider page." };
  return { phase: "status-unavailable" as const, terminal: true, rawStatus: row.payment_status,
    message: "Status is unknown, timed out or unsupported. Stop polling and reconcile through official history; do not resubmit." };
}
export async function pollPayment(api: ApiClient, id: string, options: {
  attempts?: number; intervalMs?: number; signal?: AbortSignal;
  onUpdate?: (value: ReturnType<typeof paymentObservation>) => void;
} = {}) {
  identifier.parse(id);
  const attempts = z.number().int().min(1).max(12).parse(options.attempts ?? 12);
  const intervalMs = z.number().int().min(5000).max(30000).parse(options.intervalMs ?? 5000);
  options.signal?.throwIfAborted();
  const fingerprint = await activeIdentity(api);
  await api.validateSession();
  for (let attempt = 1; attempt <= attempts; attempt++) {
    options.signal?.throwIfAborted();
    await sameIdentity(api, fingerprint);
    const response = await api.checkPayment(id, options.signal);
    const observation = paymentObservation(response, id);
    options.onUpdate?.(observation);
    if (observation.terminal || attempt === attempts) return {
      ...observation, pollingStopped: true, exhausted: !observation.terminal, attempts: attempt, response
    };
    await sleep(intervalMs, undefined, { signal: options.signal });
  }
  throw new Error("Unreachable polling state");
}
