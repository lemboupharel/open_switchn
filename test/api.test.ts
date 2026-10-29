import test from "node:test";
import assert from "node:assert/strict";
import { ApiClient, ApiError, type Fetcher } from "../src/api.js";
import { buildMoneyBody, objectData } from "../src/models.js";
import { SessionStore } from "../src/storage.js";
import { configuration, draft, liveEnv } from "./helpers.js";
import { fixtureTransport, sameNetworkRejection, receiverNameRejection } from "./fixture.js";

test("default API transport uses fetch and never substitutes a simulated response on failure", async t => {
  const config = await configuration(t);
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => { calls++; throw new Error("Injected network failure"); });
  const api = new ApiClient(config);
  await assert.rejects(api.reviewMoney(buildMoneyBody(draft, config.appVersion)), /Network\/timeout failure/);
  assert.equal(calls, 1);
});
test("live requests use exact headers, POST payment-check, encoded queries and no redirect following", async t => {
  const config = await configuration(t, { ...liveEnv, SWITCHN_FCM_TOKEN: "test-fcm" });
  const calls: { url: URL; init: RequestInit }[] = [];
  const send: Fetcher = async (url, init) => { calls.push({ url, init }); return Response.json({ success: true, data: {} }); };
  const api = new ApiClient(config, undefined, send);
  await api.checkPayment("1234567890123456789");
  await api.lookup("+237 600&admin=1", "carrier");
  assert.equal(calls[0]?.url.href, "https://api.switchn.net/payment-requests/1234567890123456789/payment-check");
  assert.equal(calls[0]?.init.method, "POST");
  assert.equal(calls[0]?.init.redirect, "manual");
  const headers = new Headers(calls[0]?.init.headers);
  assert.equal(headers.get("authorization"), "Bearer test-owned-token");
  assert.equal(headers.get("fcm-token"), "test-fcm");
  assert.equal(headers.get("app-version"), "4.1.2");
  assert.equal(headers.get("user-agent"), "switchn-local-client/0.1");
  assert.equal(headers.get("platform"), "android");
  assert.equal(calls[1]?.url.searchParams.get("phone"), "+237 600&admin=1");
  assert.equal(calls[1]?.url.searchParams.has("admin"), false);
  await assert.rejects(api.checkPayment("../other"));
});
test("old offline settings are rejected and payment gate prevents transport calls", async t => {
  let calls = 0;
  const send: Fetcher = async () => { calls++; return Response.json({ data: {} }); };
  await assert.rejects(configuration(t, { SWITCHN_ENABLE_LIVE: "false" }), /live-only/);
  await assert.rejects(configuration(t, { SWITCHN_MODE: "mock" }), /live-only/);
  const noPayments = await configuration(t, { ...liveEnv, SWITCHN_ALLOW_PAYMENTS: "false" });
  await assert.rejects(new ApiClient(noPayments, undefined, send).initiateMoney(buildMoneyBody(draft, "4.1.2")), /payments disabled/);
  assert.equal(calls, 0);
});
test("HTTP errors, semantic failures, invalid JSON, redirects and timeouts never retry", async t => {
  const config = await configuration(t, liveEnv);
  const responses: (() => Promise<Response>)[] = [
    async () => new Response("sensitive raw data", { status: 401 }),
    async () => new Response(null, { status: 302, headers: { Location: "https://foreign.example" } }),
    async () => Response.json({ success: false, message: "do not log this secret" }),
    async () => Response.json({ success: true, action_required: { challenge: true } }),
    async () => new Response('{"data":{"id":9223372036854775807}}'),
    async () => new Response('{"data":{"amount":1e400}}'),
    async () => new Response(" ".repeat(2_000_001)),
    async () => new Response("<html>not JSON</html>"),
    async () => { throw new Error("private-token-in-low-level-error"); }
  ];
  for (const response of responses) {
    await new SessionStore(config).remove("session-health.json");
    let calls = 0;
    const api = new ApiClient(config, undefined, async () => { calls++; return response(); });
    await assert.rejects(api.checkPayment("1"), error => {
      assert.ok(error instanceof ApiError);
      assert.equal(error.outcomeUnknown, true);
      assert.ok(!error.message.includes("private-token"));
      assert.ok(!error.message.includes("sensitive raw"));
      return true;
    });
    assert.equal(calls, 1);
  }
});
test("token acquisition persists only the issued token; OTP response is not a login token", async t => {
  const config = await configuration(t, { ...liveEnv, SWITCHN_BEARER_TOKEN: undefined });
  const api = new ApiClient(config, undefined, async (_url, init) => {
    assert.equal(new Headers(init.headers).has("authorization"), false);
    return Response.json({ success: true, data: { access_token: "test-issued-token" } });
  });
  assert.deepEqual(await api.login("device", { token: "owned-identity-token", device_name: "test", device_lang: "en", phone: "OWNED" }),
    { mode: "live", saved: true });
  assert.equal(await new SessionStore(config).token(), "test-issued-token");
  const mock = new ApiClient(await configuration(t), undefined, fixtureTransport());
  const challenge = await mock.createOtp({ token: "mock", phone_number: "MOCK", device_lang: "en", transport: "sms" });
  const result = await mock.validateOtp(String(objectData(challenge.body.data).validate_url), { otp: "000000", device_lang: "en", device_name: "test", do_login: true });
  assert.equal(objectData(result.body.data).access_token, undefined);
  await assert.rejects(mock.validateOtp("https://evil.example/otps/1", { otp: "1", device_lang: "en", device_name: "test", do_login: true }), /Switchn/);
  await assert.rejects(mock.validateOtp("https://api.switchn.net/money-transfers/initiate", {}), /OTP validation/);
});

test("observed same-network review rejection has safe actionable guidance and is not retried", async t => {
  const config = await configuration(t);
  let calls = 0;
  const api = new ApiClient(config, undefined, async () => {
    calls++;
    return Response.json({ ...sameNetworkRejection, errors: { to: ["private-phone-or-token"] } }, { status: 422 });
  });
  await assert.rejects(api.reviewMoney(buildMoneyBody(draft, config.appVersion)), error => {
    assert.ok(error instanceof ApiError);
    assert.equal(error.code, "same-network-transfer");
    assert.equal(error.httpStatus, 422);
    assert.equal(error.outcomeUnknown, false);
    assert.match(error.message, /direct transfer service/);
    assert.ok(!error.message.includes("private-phone-or-token"));
    return true;
  });
  assert.equal(calls, 1);
});

test("unrecognized validation messages and other endpoints retain conservative generic errors", async t => {
  const config = await configuration(t);
  for (const scenario of ["unknown-message", "wrong-status", "different-endpoint"]) {
    const api = new ApiClient(config, undefined, async () => Response.json(
      scenario === "unknown-message" ? { message: "private-phone-or-token" } : sameNetworkRejection,
      { status: scenario === "wrong-status" ? 400 : 422 }
    ));
    const operation = scenario === "different-endpoint" ? api.checkPayment("1")
      : api.reviewMoney(buildMoneyBody(draft, config.appVersion));
    await assert.rejects(operation, error => {
      assert.ok(error instanceof ApiError);
      assert.equal(error.code, "invalid-payload");
      assert.equal(error.outcomeUnknown, true);
      assert.ok(!error.message.includes("private-phone-or-token"));
      return true;
    });

  }
});

test("observed receiver-name validation provides safe guidance without leaking name errors or retrying", async t => {
  const config = await configuration(t, { SWITCHN_DEBUG: "true" });
  for (const message of [receiverNameRejection.message, receiverNameRejection.message.replaceAll("\u2019", "'")]) {
    let calls = 0;
    const api = new ApiClient(config, undefined, async () => {
      calls++;
      return Response.json({ ...receiverNameRejection, message,
        errors: { inputted_receiver_name: ["private-name-or-token"] } }, { status: 422 });
    });
    await assert.rejects(api.reviewMoney(buildMoneyBody(draft, config.appVersion)), error => {
      assert.ok(error instanceof ApiError);
      assert.equal(error.code, "receiver-name-required");
      assert.equal(error.httpStatus, 422);
      assert.equal(error.outcomeUnknown, false);
      assert.match(error.message, /registered Mobile Money account name/);
      assert.ok(!error.message.includes("private-name-or-token"));
      return true;
    });
    assert.equal(calls, 1);
    const trace = api.diagnostics.list()[0];
    assert.equal(objectData(trace?.requestBody).inputted_receiver_name, "[REDACTED]");
    assert.equal(objectData(objectData(trace?.responseBody).errors).inputted_receiver_name, "[REDACTED]");
  }
});
