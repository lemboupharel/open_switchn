import test from "node:test";
import assert from "node:assert/strict";
import { get as httpGet } from "node:http";
import { ApiClient } from "../src/api.js";
import { startWeb } from "../src/web.js";
import { configuration, draft } from "./helpers.js";
import { fixtureTransport, fixtureIdentity, sameNetworkRejection, receiverNameRejection } from "./fixture.js";
import { moneyBody } from "../src/models.js";
import { AuthWorkflow } from "../src/auth.js";

test("loopback web flow: CSRF, origin guard, review, confirm, replay rejection and status", async t => {
  const config = await configuration(t, { SWITCHN_DEBUG: "true", SWITCHN_BEARER_TOKEN: undefined, SWITCHN_FIREBASE_API_KEY: "test-key" });
  const api = new ApiClient(config, undefined, fixtureTransport());
  const { server, url } = await startWeb(api, undefined, new AuthWorkflow(api, fixtureIdentity));
  t.after(() => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
  const page = await fetch(url);
  assert.match(page.headers.get("content-security-policy") ?? "", /frame-ancestors 'none'/);
  const html = await page.text();
  assert.ok(html.includes('id="accepted"'));
  assert.ok(html.includes("This client uses the live backend only."));
  assert.ok(!/MOCK|000000|Simulation code/.test(html));
  assert.ok(!html.includes('name="confirmation"'));
  assert.ok(!html.includes('name="ticket"'));
  const csrf = html.match(/name="local-csrf" content="([a-f0-9]+)"/)?.[1];
  assert.ok(csrf);
  assert.equal((await fetch(`${url}/api/session`)).status, 403);
  assert.equal((await fetch(url, { headers: { Origin: "https://foreign.example" } })).status, 403);
  const hostileHostStatus = await new Promise<number | undefined>((resolve, reject) => {
    httpGet(url, { headers: { Host: "foreign.example" } }, response => {
      response.resume();
      resolve(response.statusCode);
    }).on("error", reject);
  });
  assert.equal(hostileHostStatus, 403);
  const headers = { "X-Local-CSRF": csrf, "Content-Type": "application/json", Origin: url };
  const post = (path: string, value: unknown) => fetch(url + path, { method: "POST", headers, body: JSON.stringify(value) });
  const session = await (await fetch(`${url}/api/session`, { headers })).json();
  assert.equal(session.mode, "live");
  assert.equal(session.authenticated, false);
  const started = await (await post("/api/auth/start", { phone: "MOCK-PAYER", transport: "sms" })).json();
  assert.equal(started.challenge.phase, "awaiting-otp");
  assert.ok(!JSON.stringify(started).includes("fixture-identity-not-a-real-token"));
  const wrongCode = await post("/api/auth/verify", { code: "bad-code" });
  assert.equal((await wrongCode.json()).upstreamStatus, 422);
  assert.equal((await post("/api/auth/verify", { code: "000000" })).status, 200);
  assert.equal((await post("/api/auth/validate", {})).status, 200);
  const review = await post("/api/review", draft);
  assert.equal(review.status, 200);
  const ticket = await review.json();
  const invalid = await post("/api/submit", { ticket: ticket.id, confirmation: "wrong" });
  assert.equal(invalid.status, 400);
  const submitted = await post("/api/submit", { ticket: ticket.id, confirmation: ticket.confirmation, pin: "987654" });
  assert.equal(submitted.status, 200);
  const text = await submitted.text();
  assert.ok(!text.includes("987654"));
  assert.equal(JSON.parse(text).ticket.state, "submitted");
  assert.equal((await post("/api/submit", { ticket: ticket.id, confirmation: ticket.confirmation })).status, 400);
  const checked = await (await post("/api/check", { id: "2001" })).json();
  assert.equal(checked.body.data.payment_status, "pending");
  const watched = await (await post("/api/watch", { id: "2001", attempts: 1 })).json();
  assert.equal(watched.phase, "awaiting-provider");
  assert.equal(watched.exhausted, true);
  const diagnostics = await (await fetch(`${url}/api/diagnostics`, { headers })).json();
  assert.equal(diagnostics.enabled, true);
  assert.ok(diagnostics.traces.some((trace: { url: string }) => trace.url.includes("/money-transfers/initiate")));
  assert.ok(!JSON.stringify(diagnostics).includes("987654"));
  assert.ok(!JSON.stringify(diagnostics).includes("fixture-identity-not-a-real-token"));
  const history = await (await fetch(`${url}/api/tickets`, { headers })).json();
  assert.equal(history.length, 1);
});

test("same-network rejection reaches the dashboard without a ticket, initiation or session loss", async t => {
  const config = await configuration(t);
  const synthetic = fixtureTransport();
  const posts: string[] = [];
  const api = new ApiClient(config, undefined, async (url, init) => {
    if (init.method === "POST") posts.push(url.pathname);
    if (url.pathname === "/get-phone-carrier") return Response.json({ success: true, carrier: "MTN Cameroon" });
    if (url.pathname === "/money-transfers/review") return Response.json(sameNetworkRejection, { status: 422 });
    return synthetic(url, init);
  });
  const { server, url } = await startWeb(api);
  t.after(() => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
  const html = await (await fetch(url)).text();
  const csrf = html.match(/name="local-csrf" content="([a-f0-9]+)"/)?.[1];
  assert.ok(csrf);
  const headers = { "X-Local-CSRF": csrf, "Content-Type": "application/json", Origin: url };
  const response = await fetch(url + "/api/review", {
    method: "POST", headers, body: JSON.stringify({ ...draft, to_carrier: "MTN Cameroon" })
  });
  assert.equal(response.status, 422);
  const result = await response.json();
  assert.equal(result.code, "same-network-transfer");
  assert.equal(result.upstreamStatus, 422);
  assert.equal(result.outcomeUnknown, false);
  assert.match(result.error, /direct transfer service/);
  assert.deepEqual(posts, ["/money-transfers/review"]);
  assert.equal((await api.session.status()).state, "validated");
  const history = await (await fetch(url + "/api/tickets", { headers })).json();
  assert.deepEqual(history, []);
});

test("missing name stops locally; rejected name gets actionable guidance; corrected name reaches review unchanged", async t => {
  const config = await configuration(t);
  const synthetic = fixtureTransport();
  const calls: string[] = [];
  const api = new ApiClient(config, undefined, async (url, init) => {
    calls.push(url.pathname);
    if (url.pathname === "/money-transfers/review") {
      const body = moneyBody.parse(JSON.parse(String(init.body)));
      if (body.inputted_receiver_name !== "TEST REGISTERED NAME") return Response.json(receiverNameRejection, { status: 422 });
    }
    return synthetic(url, init);
  });
  const { server, url } = await startWeb(api);
  t.after(() => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
  const html = await (await fetch(url)).text();
  const csrf = html.match(/name="local-csrf" content="([a-f0-9]+)"/)?.[1];
  assert.ok(csrf);
  assert.ok(!html.includes("Recipient name (optional)"));
  assert.ok(html.includes("Recipient's registered Mobile Money name"));
  const headers = { "X-Local-CSRF": csrf, "Content-Type": "application/json", Origin: url };
  const review = (inputted_receiver_name?: string) => fetch(url + "/api/review", {
    method: "POST", headers, body: JSON.stringify({ ...draft, inputted_receiver_name })
  });
  const missing = await review();
  assert.equal(missing.status, 400);
  assert.match((await missing.json()).error, /registered Mobile Money account name/);
  assert.equal(calls.length, 0);
  const rejected = await review("TEST UNACCEPTED NAME");
  assert.equal(rejected.status, 422);
  assert.equal((await rejected.json()).code, "receiver-name-required");
  assert.deepEqual(await (await fetch(url + "/api/tickets", { headers })).json(), []);
  const accepted = await review("TEST REGISTERED NAME");
  assert.equal(accepted.status, 200);
  assert.equal((await accepted.json()).action.body.inputted_receiver_name, "TEST REGISTERED NAME");
  assert.equal(calls.includes("/money-transfers/initiate"), false);
});
