import { z } from "zod";

export const safeAmount = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const identifier = z.string().regex(/^[1-9]\d{0,18}$/, "Expected a positive decimal ID")
  .refine(value => /^[1-9]\d{0,18}$/.test(value) && BigInt(value) <= 9223372036854775807n, "ID exceeds Android Long range");
export const carrier = z.enum(["MTN Cameroon", "Orange"]);
export const method = z.enum(["ussd_pay", "web_pay", "merchant_pay"]);
const text = z.string().trim().min(1).max(256);
const optionalText = text.nullable().optional();
export const secret = z.string().min(1).max(16384).regex(/^[^\s\x00-\x1f\x7f]+$/, "Invalid token");

export const moneyBody = z.object({
  to: text,
  from: text,
  amount_before_fees: safeAmount.positive(),
  amount_after_fees: safeAmount.positive(),
  lang: text,
  app_version: text,
  channel: z.literal("android_app"),
  transaction_specific_cash_out_fee: safeAmount,
  transaction_specific_fee: safeAmount,
  transaction_reference: z.string().max(256),
  schedule_at: optionalText,
  pin: optionalText,
  from_carrier: carrier.nullable().optional(),
  to_carrier: carrier.nullable().optional(),
  payment_method: method.nullable().optional(),
  inputted_receiver_name: optionalText,
  force_rerun: z.boolean().nullable().optional()
}).strict();
export type MoneyBody = z.infer<typeof moneyBody>;

export function requiresReceiverName(fromCarrier: string | null | undefined, toCarrier: string | null | undefined): boolean {
  return !fromCarrier || !toCarrier || fromCarrier !== toCarrier;
}

export const transferDraft = z.object({
  from: text,
  to: text,
  amount: safeAmount.positive(),
  from_carrier: carrier.optional(),
  to_carrier: carrier,
  payment_method: method,
  lang: text.default("en"),
  transaction_reference: z.string().max(256).default(""),
  inputted_receiver_name: optionalText,
  schedule_at: optionalText,
  transaction_specific_cash_out_fee: safeAmount.default(0)
}).strict().superRefine((value, ctx) => {
  if (value.from !== "wallet:funds" && !value.from_carrier) {
    ctx.addIssue({ code: "custom", path: ["from_carrier"], message: "External payer needs a carrier" });
  }
  if (value.from === "wallet:funds" && value.from_carrier) {
    ctx.addIssue({ code: "custom", path: ["from_carrier"], message: "A wallet is not an external carrier" });
  }
  if (requiresReceiverName(value.from_carrier, value.to_carrier) && !value.inputted_receiver_name) {
    ctx.addIssue({ code: "custom", path: ["inputted_receiver_name"],
      message: "Enter the recipient's registered Mobile Money account name." });
  }
});

export function buildMoneyBody(input: unknown, appVersion: string): MoneyBody {
  const draft = transferDraft.parse(input);
  return moneyBody.parse({
    from: draft.from, to: draft.to,
    from_carrier: draft.from_carrier, to_carrier: draft.to_carrier,
    amount_before_fees: draft.amount, amount_after_fees: draft.amount,
    transaction_specific_cash_out_fee: draft.transaction_specific_cash_out_fee,
    transaction_specific_fee: 0,
    lang: draft.lang, app_version: appVersion, channel: "android_app",
    payment_method: draft.payment_method,
    transaction_reference: draft.transaction_reference,
    inputted_receiver_name: draft.inputted_receiver_name, schedule_at: draft.schedule_at
  });
}

export const reviewData = z.object({
  from: text, to: text,
  from_carrier: carrier.nullable().optional(),
  to_carrier: carrier.nullable().optional(),
  amount_before_fees: safeAmount.positive(),
  amount_after_fees: safeAmount.positive(),
  transaction_specific_cash_out_fee: safeAmount,
  transaction_specific_fee: safeAmount,
  inputted_receiver_name: optionalText,
  to_name: optionalText,
  name_match: z.boolean().nullable().optional(),
  alerts: z.array(z.unknown()).nullable().optional()
}).passthrough();

export const deviceLogin = z.object({
  token: secret, device_name: text, device_lang: text, phone: text
}).strict();
export const googleLogin = z.object({
  token: secret, device_name: text, device_lang: text, primary_number: text,
  provider_data: z.object({
    rawId: z.string().nullable(), displayName: z.string().nullable(),
    screenName: z.string().nullable(), email: z.string().nullable(),
    photoUrl: z.string().nullable(), providerId: z.string().nullable(),
    phoneNumber: z.string().nullable()
  }).strict()
}).strict();
export const otpCreate = z.object({
  token: secret, phone_number: text, device_lang: text, transport: text
}).strict();
export const otpValidate = z.object({
  otp: text, device_lang: text, device_name: text, do_login: z.boolean()
}).strict();

export const airtimeBody = z.object({
  to: text, payer: text, amount: safeAmount.positive(), lang: text,
  code: z.string().max(256).optional(),
  payer_carrier: optionalText, to_carrier: optionalText,
  payment_method: method.optional(), schedule_at: optionalText, pin: optionalText,
  cancel_url: z.string().url().optional(), return_url: z.string().url().optional()
}).strict();

export const feeRow = z.object({
  amount_range: z.object({ min: safeAmount, max: safeAmount }).strict(),
  fee: z.object({ unit: z.enum(["currency", "percentage"]), value: z.number().finite().nonnegative() }).strict()
}).passthrough().refine(v => v.amount_range.min <= v.amount_range.max, "Invalid amount range");
export const feeTables = z.object({
  mtn_mobile_money: z.array(feeRow),
  orange_money: z.array(feeRow)
}).passthrough();

export const catalog = z.array(z.object({
  id: safeAmount, cost: safeAmount, code: text, name: text,
  network_carrier: text, duration: safeAmount.optional(),
  data_total_amount: z.number().finite().nonnegative().optional()
})).max(10000);
export type Catalog = z.infer<typeof catalog>;

export const envelope = z.object({
  success: z.boolean().nullable().optional(),
  error_code: z.string().nullable().optional(),
  action_required: z.unknown().optional(),
  data: z.unknown().optional()
}).passthrough();
export type Envelope = z.infer<typeof envelope>;

export function objectData(value: unknown): Record<string, unknown> {
  return z.record(z.unknown()).parse(value);
}
