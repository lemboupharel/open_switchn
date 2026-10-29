import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ApiClient, ApiError, type Fetcher } from "../src/api.js";
import { Workflow } from "../src/workflow.js";
import { Diagnostics } from "../src/diagnostics.js";
import { paymentObservation, pollPayment } from "../src/lifecycle.js";
import { fixtureTransport as mockTransport, paymentFixture, serviceFixture } from "./fixture.js";
import { moneyBody, objectData } from "../src/models.js";
import { configuration, draft, liveEnv } from "./helpers.js";

test("401 rejects an environment bearer durably and never refreshes/replays a request", async t => {
  const config = await configuration(t, liveEnv);
  let calls = 0;
  const rejected: Fetcher = async () => { calls++; return Response.json({ message: "secret" }, { status: 401 }); };
  const api = new ApiClient(config, undefined, rejected);
  await assert.rejects(api.validateSession(), error => error instanceof ApiError && error.code === "session-rejected");
  assert.equal((await api.session.status()).state, "rejected");
  await assert.rejects(new ApiClient(config, undefined, rejected).validateSession(), /No active bearer/);
  assert.equal(calls, 1);
});

test("expired auth before submit does not consume the ticket; changed sessions cannot reuse its review", async t => {
  const config = await configuration(t, { ...liveEnv, SWITCHN_BEARER_TOKEN: undefined });
  const synthetic = mockTransport();
  let reject = false;
  let initiated = 0;
  const api = new ApiClient(config, undefined, async (url, init) => {
    if (url.pathname === "/my-funds" && reject) return new Response(null, { status: 401 });
    if (url.pathname === "/money-transfers/initiate") initiated++;
    return synthetic(url, init);
  });
  await api.session.save("first-account-session");
  const flow = new Workflow(api);
  const ticket = await flow.reviewMoney(draft);
  reject = true;
  await assert.rejects(flow.submit(ticket.id, ticket.confirmation), /Session rejected/);
  assert.equal((await flow.get(ticket.id)).state, "ready");
  await assert.rejects(readFile(join(config.dataDir, "tickets", `${ticket.id}.attempted`)), { code: "ENOENT" });
  await api.session.save("different-account-session");
  reject = false;
  await assert.rejects(flow.submit(ticket.id, ticket.confirmation), /Session changed/);
  assert.equal(initiated, 0);
});

test("401 during initiation leaves an uncertain one-shot attempt even after reauthentication", async t => {
  const config = await configuration(t, { ...liveEnv, SWITCHN_BEARER_TOKEN: undefined });
  const synthetic = mockTransport();
  let initiated = 0;
  const api = new ApiClient(config, undefined, async (url, init) => {
    if (url.pathname === "/money-transfers/initiate") { initiated++; return new Response(null, { status: 401 }); }
    return synthetic(url, init);
  });
  await api.session.save("first-account-session");
  const flow = new Workflow(api);
  const ticket = await flow.reviewMoney(draft);
  await assert.rejects(flow.submit(ticket.id, ticket.confirmation), /Session rejected/);
  assert.equal((await flow.get(ticket.id)).state, "outcome-unknown");
  await api.session.save("new-account-session");
  await assert.rejects(flow.submit(ticket.id, ticket.confirmation), /already attempted/);
  assert.equal(initiated, 1);
});

test("preflight blocks unsupported shapes, unavailable routes, carrier mismatches and insufficient wallet funds", async t => {
  const cases: { path: string; body: unknown; wallet?: boolean }[] = [
    { path: "/service-status", body: { data: {} } },
    { path: "/service-status", body: { data: { money_transfer: { available: false } } } },
    { path: "/payment-config", body: { data: { payment_methods: [] } } },
    { path: "/get-phone-carrier", body: { success: true, carrier: "unsupported" } },
    { path: "/get-phone-carrier", body: { success: true, carrier: "MTN Cameroon" } },
    { path: "/my-funds", body: { data: { id: 1, balance: "1", withdrawals_enabled: true } }, wallet: true }
  ];
  for (const scenario of cases) {
    const config = await configuration(t, liveEnv);
    const synthetic = mockTransport();
    let payments = 0;
    let reviews = 0;
    const api = new ApiClient(config, undefined, async (url, init) => {
      if (url.pathname.endsWith("/initiate")) payments++;
      if (url.pathname.endsWith("/review")) reviews++;
      return url.pathname === scenario.path ? Response.json(scenario.body) : synthetic(url, init);
    });
    const body = scenario.wallet ? { ...draft, from: "wallet:funds", from_carrier: undefined } : draft;
    await assert.rejects(new Workflow(api).reviewMoney(body));
    assert.equal(payments, 0);
    assert.equal(reviews, 0);
  }
});

test("preflight runs again at confirmation and uses the reviewed payer amount", async t => {
  const config = await configuration(t, liveEnv);
  const synthetic = mockTransport();
  const seen: string[] = [];
  let disabled = false;
  const api = new ApiClient(config, undefined, async (url, init) => {
    seen.push(url.pathname);
    if (disabled && url.pathname === "/service-status") return Response.json({ data: { money_transfer: { available: false } } });
    return synthetic(url, init);
  });
  const flow = new Workflow(api);
  const ticket = await flow.reviewMoney(draft);
  assert.equal(seen[0], "/my-funds");
  assert.equal(seen.at(-1), "/money-transfers/review");
  disabled = true;
  await assert.rejects(flow.submit(ticket.id, ticket.confirmation), /unavailable/);
  assert.equal(seen.includes("/money-transfers/initiate"), false);
});

test("live-shaped provider codes allow MTN and Orange reviews without changing request payment_method", async t => {
  for (const fromCarrier of ["MTN Cameroon", "Orange"]) {
    const config = await configuration(t);
    const synthetic = mockTransport();
    const posted: string[] = [];
    const api = new ApiClient(config, undefined, async (url, init) => {
      if (url.pathname === "/my-funds") {
        return Response.json({ success: true, data: { id: 1, balance: "0", withdrawals_enabled: false } });
      }
      if (init.method === "POST") {
        const body = moneyBody.parse(JSON.parse(String(init.body)));
        assert.equal(body.payment_method, "ussd_pay");
        posted.push(url.pathname);
      }
      return synthetic(url, init);
    });
    const input = fromCarrier === "Orange"
      ? { ...draft, from: draft.to, to: draft.from, from_carrier: fromCarrier, to_carrier: "MTN Cameroon" }
      : draft;
    const flow = new Workflow(api);
    const ticket = await flow.reviewMoney(input);
    assert.equal(objectData(ticket.preflight).providerMethodCode, fromCarrier === "Orange" ? "om_cm_v2" : "mtn_momo_cm");
    assert.equal((await flow.submit(ticket.id, ticket.confirmation)).ticket.state, "submitted");
    assert.deepEqual(posted, ["/money-transfers/review", "/money-transfers/initiate"]);
  }
});

test("provider availability is checked by mapped code and cannot be replaced by a UI-mode flag", async t => {
  for (const failure of ["global-disabled", "global-missing", "recipient-disabled", "mapping-missing", "payer-disabled", "unsupported-ui-method"]) {
    const config = await configuration(t);
    const synthetic = mockTransport();
    const status = serviceFixture();
    const payment = paymentFixture();
    status.enabled_payment_methods.ussd_pay = true;
    if (failure === "global-disabled") status.enabled_payment_methods.mtn_momo_cm = false;
    if (failure === "global-missing") delete status.enabled_payment_methods.mtn_momo_cm;
    if (failure === "recipient-disabled") status.money_transfer.carriers.forEach(c => { c.payment_methods.mtn_momo_cm = false; });
    const selected = payment.payment_methods.find(p => p.method === "ussd_pay");
    assert.ok(selected);
    if (failure === "mapping-missing") selected.carriers["MTN Cameroon"].final_api_code = null;
    if (failure === "payer-disabled") selected.carriers["MTN Cameroon"].enabled = false;
    let posts = 0;
    const api = new ApiClient(config, undefined, async (url, init) => {
      if (init.method === "POST") posts++;
      if (url.pathname === "/service-status") return Response.json({ data: status });
      if (url.pathname === "/payment-config") return Response.json({ data: payment });
      return synthetic(url, init);
    });
    await assert.rejects(new Workflow(api).reviewMoney({
      ...draft, payment_method: failure === "unsupported-ui-method" ? "web_pay" : "ussd_pay"
    }), error => error instanceof ApiError && error.code === "preflight-blocked");
    assert.equal(posts, 0);
  }
});

test("wallet uses funds availability, not external provider configuration or USSD collection", async t => {
  const config = await configuration(t);
  const synthetic = mockTransport();
  const api = new ApiClient(config, undefined, async (url, init) => {
    assert.notEqual(url.pathname, "/payment-config");
    if (url.pathname === "/get-phone-carrier") assert.equal(url.searchParams.get("phone"), draft.to);
    return synthetic(url, init);
  });
  const flow = new Workflow(api);
  const ticket = await flow.reviewMoney({ ...draft, from: "wallet:funds", from_carrier: undefined });
  assert.equal(objectData(ticket.preflight).providerMethodCode, "funds");
  assert.equal((await flow.submit(ticket.id, ticket.confirmation)).ticket.state, "submitted");

  const denied = new ApiClient(config, undefined, async (url, init) => {
    if (url.pathname === "/my-funds") return Response.json({ data: { id: 1, balance: "10000", withdrawals_enabled: false } });
    throw new Error(`Unexpected call after disabled wallet: ${init.method} ${url.pathname}`);
  });
  await assert.rejects(new Workflow(denied).reviewMoney({ ...draft, from: "wallet:funds", from_carrier: undefined }),
    /select that network instead of Internal wallet/);
});

test("changed provider route requires a fresh review before any initiation or attempt marker", async t => {
  const config = await configuration(t);
  const synthetic = mockTransport();
  const payment = paymentFixture();
  let initiated = 0;
  const flow = new Workflow(new ApiClient(config, undefined, async (url, init) => {
    if (url.pathname === "/payment-config") return Response.json({ data: payment });
    if (url.pathname === "/money-transfers/initiate") initiated++;
    return synthetic(url, init);
  }));
  const ticket = await flow.reviewMoney(draft);
  const selected = payment.payment_methods.find(p => p.method === "ussd_pay");
  assert.ok(selected);
  selected.carriers["MTN Cameroon"].final_api_code = "om_cm";
  await assert.rejects(flow.submit(ticket.id, ticket.confirmation), /route changed since review/);
  assert.equal(initiated, 0);
  assert.equal((await flow.get(ticket.id)).state, "ready");
  await assert.rejects(readFile(join(config.dataDir, "tickets", `${ticket.id}.attempted`)), { code: "ENOENT" });
});

test("payment observations never mistake acknowledgements, unsupported states or redirects for settlement", () => {
  const result = (data?: unknown) => ({ mode: "live" as const, httpStatus: 200, body: { success: true, data } });
  assert.equal(paymentObservation(result(), "1").phase, "status-unavailable");
  assert.equal(paymentObservation(result({ payment_link: "https://example.test/paid" }), "1").phase, "status-unavailable");
  assert.equal(paymentObservation(result({ id: 1, payment_status: "SUCCESSFUL" }), "1").phase, "payment-confirmed");
  assert.equal(paymentObservation(result({ id: 1, payment_status: "PENDING" }), "1").terminal, false);
  for (const state of ["TIMEOUT", "UNKNOWN", "PAID_MAYBE"]) {
    assert.equal(paymentObservation(result({ id: 1, payment_status: state }), "1").phase, "status-unavailable");
  }
  assert.throws(() => paymentObservation(result({ id: 2, payment_status: "SUCCESSFUL" }), "1"), /does not match/);
});

test("polling is bounded, cancellable, stops on errors and never initiates a payment", async t => {
  const config = await configuration(t, liveEnv);
  const synthetic = mockTransport();
  const paths: string[] = [];
  const api = new ApiClient(config, undefined, async (url, init) => {
    paths.push(url.pathname);
    return synthetic(url, init);
  });
  const result = await pollPayment(api, "2001", { attempts: 1 });
  assert.equal(result?.exhausted, true);
  assert.equal(result?.phase, "awaiting-provider");
  assert.deepEqual(paths, ["/my-funds", "/payment-requests/2001/payment-check"]);
  await assert.rejects(pollPayment(api, "2001", { attempts: 13 }));
  await assert.rejects(pollPayment(api, "2001", { intervalMs: 1 }));
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(pollPayment(api, "2001", { signal: controller.signal }));
  assert.equal(paths.length, 2);
  let checks = 0;
  const failure = new ApiClient(config, undefined, async (url, init) => {
    if (url.pathname.endsWith("/payment-check")) { checks++; return new Response(null, { status: 503 }); }
    return synthetic(url, init);
  });
  await assert.rejects(pollPayment(failure, "2001"), error => error instanceof ApiError && error.code === "upstream-unavailable");
  assert.equal(checks, 1);
});

test("diagnostics mask credentials even when echoed elsewhere; records are bounded and disabled by default", () => {
  const log = new Diagnostics(true);
  const trace = {
    method: "POST", url: "https://api.switchn.net/otps/private-path/validate?token=private-query",
    requestHeaders: { Authorization: "Bearer bearer-value", "fcm-token": "fcm-value", "Content-Type": "application/json" },
    requestBody: { token: "identity-value", otp: "654321", pin: "112233", from: "MOCK-PAYER", amount: 100 },
    responseHeaders: { "Set-Cookie": "cookie-value", Location: "https://provider.test/private" },
    responseBody: { access_token: "returned-value", message: "identity-value bearer-value returned-value 654321 MOCK-PAYER",
      payment_link: "https://provider.test/secret-link" }, httpStatus: 422
  };
  for (let i = 0; i < 55; i++) log.capture(trace, ["bearer-value", "fcm-value"]);
  assert.equal(log.list().length, 50);
  const text = JSON.stringify(log.list());
  for (const value of ["bearer-value", "identity-value", "returned-value", "fcm-value", "cookie-value", "MOCK-PAYER",
    "private-path", "private-query", "654321", "112233", "secret-link"]) assert.ok(!text.includes(value));
  assert.ok(text.includes('"amount":100'));
  const disabled = new Diagnostics(false);
  disabled.capture(trace);
  assert.equal(disabled.list().length, 0);
});
