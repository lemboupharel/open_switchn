import test from "node:test";
import assert from "node:assert/strict";
import { buildMoneyBody, requiresReceiverName } from "../src/models.js";
import { loadConfig, safePaymentLink } from "../src/config.js";
import { estimateWithdrawal } from "../src/fees.js";
import { redact, errorMessage } from "../src/presentation.js";
import { draft } from "./helpers.js";

test("exact body shape, carrier labels and wallet semantics", () => {
  const result = buildMoneyBody(draft, "4.1.2");
  assert.deepEqual(result, {
    from: "MOCK-PAYER", to: "MOCK-RECIPIENT", from_carrier: "MTN Cameroon", to_carrier: "Orange",
    amount_before_fees: 1000, amount_after_fees: 1000,
    transaction_specific_cash_out_fee: 0, transaction_specific_fee: 0,
    lang: "en", app_version: "4.1.2", channel: "android_app", payment_method: "ussd_pay",
    transaction_reference: "", inputted_receiver_name: "TEST RECIPIENT", schedule_at: undefined
  });
  const wallet = buildMoneyBody({ ...draft, from: "wallet:funds", from_carrier: undefined }, "4.1.2");
  assert.equal(wallet.from, "wallet:funds");
  assert.equal("from_carrier" in JSON.parse(JSON.stringify(wallet)), false);
  assert.throws(() => buildMoneyBody({ ...draft, from: "wallet:funds" }, "4.1.2"));
  assert.throws(() => buildMoneyBody({ ...draft, from_carrier: "mtn_mobile_money" }, "4.1.2"));
  for (const payment_method of ["ussd_pay", "web_pay", "merchant_pay"]) {
    assert.equal(buildMoneyBody({ ...draft, payment_method }, "4.1.2").payment_method, payment_method);
  }
});
test("registered recipient name is required for cross-network and wallet drafts, without guessing a name", () => {
  assert.equal(requiresReceiverName("MTN Cameroon", "Orange"), true);
  assert.equal(requiresReceiverName("Orange", "MTN Cameroon"), true);
  assert.equal(requiresReceiverName(undefined, "MTN Cameroon"), true);
  assert.equal(requiresReceiverName("MTN Cameroon", "MTN Cameroon"), false);
  for (const inputted_receiver_name of [undefined, null, "", "  "]) {
    assert.throws(() => buildMoneyBody({ ...draft, inputted_receiver_name }, "4.1.2"), error => {
      assert.match(errorMessage(error), /registered Mobile Money account name/);
      return true;
    });
    assert.throws(() => buildMoneyBody({ ...draft, from: "wallet:funds", from_carrier: undefined, inputted_receiver_name }, "4.1.2"));
  }
  assert.equal(buildMoneyBody({ ...draft, inputted_receiver_name: "  TEST REGISTERED NAME  " }, "4.1.2").inputted_receiver_name,
    "TEST REGISTERED NAME");
  assert.equal(buildMoneyBody({ ...draft, to_carrier: "MTN Cameroon", inputted_receiver_name: undefined }, "4.1.2").inputted_receiver_name, undefined);
});
test("invalid and unsafe monetary values are rejected, not silently rounded", () => {
  for (const amount of [0, -1, 0.1, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, "1000"]) {
    assert.throws(() => buildMoneyBody({ ...draft, amount }, "4.1.2"));
  }
  assert.throws(() => buildMoneyBody({ ...draft, unexpected: true }, "4.1.2"));
});
test("fixed/percentage fee boundaries and missing brackets", () => {
  const tables = {
    mtn_mobile_money: [{ amount_range: { min: 100, max: 1000 }, fee: { unit: "percentage", value: 0.1 } }],
    orange_money: [{ amount_range: { min: 1, max: 1000 }, fee: { unit: "currency", value: 25 } }]
  };
  assert.equal(estimateWithdrawal(tables, "mtn_mobile_money", 100).estimate, "0.1");
  assert.equal(estimateWithdrawal(tables, "mtn_mobile_money", 1000).estimate, "1");
  assert.equal(estimateWithdrawal(tables, "orange_money", 100).estimate, "25");
  assert.throws(() => estimateWithdrawal(tables, "mtn_mobile_money", 99), /unknown/);
  assert.throws(() => estimateWithdrawal({ ...tables, mtn_mobile_money: [...tables.mtn_mobile_money, ...tables.mtn_mobile_money] }, "mtn_mobile_money", 100), /exactly one/);
});
test("configuration flags fail closed and payment URLs require exact trusted HTTPS hosts", () => {
  assert.equal(loadConfig({}).mode, "live");
  assert.throws(() => loadConfig({ SWITCHN_MODE: "mock" }), /live-only/);
  assert.throws(() => loadConfig({ SWITCHN_MODE: "production" }));
  assert.throws(() => loadConfig({ SWITCHN_ENABLE_LIVE: "yes" }));
  assert.throws(() => loadConfig({ SWITCHN_FCM_TOKEN: "a\nb" }));
  const config = loadConfig({ SWITCHN_PAYMENT_HOSTS: "pay.example.com" });
  assert.equal(safePaymentLink("https://pay.example.com/payment/1", config), "https://pay.example.com/payment/1");
  for (const value of ["javascript:alert(1)", "http://pay.example.com", "https://pay.example.com.evil.test",
    "https://u:p@pay.example.com", "https://pay.example.com:8443", "https://127.0.0.1"]) {
    assert.equal(safePaymentLink(value, config), undefined);
  }
});
test("redaction covers nested credentials, and validation errors do not echo user input", () => {
  const text = JSON.stringify(redact({ Authorization: "secret-A", data: [{ pin: "1234", access_token: "secret-B", payment_link: "secret-C", id: 1 }] }));
  assert.ok(!text.includes("secret"));
  assert.ok(!text.includes("1234"));
  try { buildMoneyBody({ ...draft, payment_method: "secret-value" }, "4.1.2"); }
  catch (error) { assert.ok(!errorMessage(error).includes("secret-value")); }
});
