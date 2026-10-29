import test from "node:test";
import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { ApiClient, ApiError, type Fetcher } from "../src/api.js";
import { AuthWorkflow } from "../src/auth.js";
import { SessionStore } from "../src/storage.js";
import { fixtureTransport as mockTransport, fixtureIdentity } from "./fixture.js";
import { configuration, liveEnv } from "./helpers.js";

const start = { phone: "MOCK-PAYER", transport: "sms" };
const identityReply = () => Response.json({
  idToken: "owned-anonymous-identity", refreshToken: "never-persist-this-refresh", expiresIn: "3600", localId: "identity-owner"
});

test("guided sign-in rejects wrong upstream codes and stores no synthetic default session", async t => {
  const config = await configuration(t, { SWITCHN_FIREBASE_API_KEY: "test-key", SWITCHN_BEARER_TOKEN: undefined });
  const api = new ApiClient(config, undefined, mockTransport());
  assert.equal(await api.session.token(), undefined);
  const auth = new AuthWorkflow(api, fixtureIdentity);
  assert.equal((await auth.begin(start)).challenge?.phase, "awaiting-otp");
  await assert.rejects(auth.verify("wrong-code"), error => error instanceof ApiError && error.httpStatus === 422);
  assert.equal((await auth.status()).challenge?.phase, "awaiting-otp");
  assert.equal((await auth.verify("000000")).challenge, undefined);
  assert.equal((await api.session.status()).state, "validated");
});

test("Firebase identity -> OTP -> same-identity device exchange -> protected session validation survives process restart", async t => {
  const config = await configuration(t, {
    ...liveEnv, SWITCHN_ALLOW_PAYMENTS: "false", SWITCHN_BEARER_TOKEN: undefined,
    SWITCHN_FIREBASE_API_KEY: "authorized-client-key", SWITCHN_DEBUG: "true"
  });
  const calls: string[] = [];
  const synthetic = mockTransport();
  const send: Fetcher = async (url, init) => {
    calls.push(url.pathname);
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    if (url.pathname === "/otps" || url.pathname === "/auth/sanctum/token") {
      assert.equal(body.token, "owned-anonymous-identity");
      assert.equal(new Headers(init.headers).has("authorization"), false);
    }
    if (url.pathname === "/auth/sanctum/token") {
      return Response.json({ success: true, data: { access_token: "issued-bearer-credential" } });
    }
    if (url.pathname === "/my-funds") {
      assert.equal(new Headers(init.headers).get("authorization"), "Bearer issued-bearer-credential");
    }
    return synthetic(url, init);
  };
  const identity: Fetcher = async (url, init) => {
    calls.push("firebase");
    assert.equal(url.origin, "https://identitytoolkit.googleapis.com");
    assert.equal(url.pathname, "/v1/accounts:signUp");
    assert.equal(url.searchParams.get("key"), "authorized-client-key");
    assert.equal(init.redirect, "manual");
    assert.equal(new Headers(init.headers).has("authorization"), false);
    assert.deepEqual(JSON.parse(String(init.body)), { returnSecureToken: true });
    return identityReply();
  };
  const api = new ApiClient(config, undefined, send);
  await new AuthWorkflow(api, identity).begin(start);
  const path = join(config.dataDir, "login-challenge.json");
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  assert.ok(!(await readFile(path, "utf8")).includes("never-persist-this-refresh"));
  const resumed = new AuthWorkflow(api, identity);
  const finished = await resumed.verify("000000");
  assert.equal(finished.session.state, "validated");
  assert.equal(await new SessionStore(config).token(), "issued-bearer-credential");
  await assert.rejects(readFile(path), { code: "ENOENT" });
  assert.deepEqual(calls, [
    "/auth/login-options", "firebase", "/otps", "/otps/mock-id/validate", "/auth/sanctum/token", "/my-funds"
  ]);
  const log = JSON.stringify(api.diagnostics.list());
  for (const value of ["owned-anonymous-identity", "never-persist-this-refresh", "issued-bearer-credential", "authorized-client-key", "MOCK-PAYER"]) {
    assert.ok(!log.includes(value), `Diagnostics leaked ${value}`);
  }
  assert.deepEqual(api.diagnostics.list().find(row => row.url.endsWith("/validate"))?.requestBody, {
    otp: "[REDACTED]", device_name: "[REDACTED]", device_lang: "en", do_login: true
  });
});

test("configuration gates and unsupported login choices never create an identity or send OTP", async t => {
  for (const env of [
    { SWITCHN_FIREBASE_API_KEY: undefined },
    { SWITCHN_BEARER_TOKEN: "existing-environment-override" }
  ]) {
    const config = await configuration(t, { ...liveEnv, SWITCHN_BEARER_TOKEN: undefined, SWITCHN_FIREBASE_API_KEY: "key", ...env });
    let calls = 0;
    const denied: Fetcher = async () => { calls++; throw new Error("Unexpected call"); };
    await assert.rejects(new AuthWorkflow(new ApiClient(config, undefined, denied), denied).begin(start));
    assert.equal(calls, 0);
  }
  const config = await configuration(t, { ...liveEnv, SWITCHN_BEARER_TOKEN: undefined, SWITCHN_FIREBASE_API_KEY: "key" });
  let identities = 0;
  const auth = new AuthWorkflow(new ApiClient(config, undefined, async () => Response.json({ data: ["google.com"] })),
    async () => { identities++; return identityReply(); });
  await assert.rejects(auth.begin(start), /not offered/);
  assert.equal(identities, 0);
});

test("untrusted challenge URLs, failed OTP and non-explicit success cannot become bearer sessions", async t => {
  for (const url of ["https://evil.example/otps/1", "https://api.switchn.net/money-transfers/initiate",
    "https://user:password@api.switchn.net/otps/1"]) {
    const config = await configuration(t, { ...liveEnv, SWITCHN_BEARER_TOKEN: undefined, SWITCHN_FIREBASE_API_KEY: "key" });
    const send: Fetcher = async destination => destination.pathname === "/auth/login-options"
      ? Response.json({ data: ["otp_sms"] })
      : Response.json({ success: true, data: { status: "pending", validate_url: url } });
    const api = new ApiClient(config, undefined, send);
    await assert.rejects(new AuthWorkflow(api, async () => identityReply()).begin(start));
    assert.equal(await api.session.token(), undefined);
  }
  const config = await configuration(t, { ...liveEnv, SWITCHN_BEARER_TOKEN: undefined, SWITCHN_FIREBASE_API_KEY: "key" });
  const synthetic = mockTransport();
  let exchanges = 0;
  const api = new ApiClient(config, undefined, async (url, init) => {
    if (url.pathname.endsWith("/validate")) return Response.json({ data: { unique_id: "not-a-bearer" } });
    if (url.pathname === "/auth/sanctum/token") exchanges++;
    return synthetic(url, init);
  });
  const auth = new AuthWorkflow(api, async () => identityReply());
  await auth.begin(start);
  await assert.rejects(auth.verify("000000"), /did not explicitly succeed/);
  assert.equal(exchanges, 0);
  assert.equal(await api.session.token(), undefined);
});

test("expired and concurrent challenges never automatically resend or exchange", async t => {
  const config = await configuration(t, { SWITCHN_FIREBASE_API_KEY: "test-key", SWITCHN_BEARER_TOKEN: undefined });
  let now = Date.now();
  const auth = new AuthWorkflow(new ApiClient(config, undefined, mockTransport()), fixtureIdentity, () => now);
  const concurrent = await Promise.allSettled([auth.begin(start), auth.begin(start)]);
  assert.equal(concurrent.filter(v => v.status === "fulfilled").length, 1);
  now += 600001;
  await assert.rejects(auth.verify("000000"), /expired/);
  await assert.rejects(auth.begin(start), /already exists/);
  await auth.cancel();
  assert.equal((await auth.begin(start)).challenge?.phase, "awaiting-otp");
});

test("uncertain device exchange is not replayed; identity failures do not fall back to forged tokens", async t => {
  const config = await configuration(t, { ...liveEnv, SWITCHN_BEARER_TOKEN: undefined, SWITCHN_FIREBASE_API_KEY: "key" });
  const synthetic = mockTransport();
  let exchanges = 0;
  const api = new ApiClient(config, undefined, async (url, init) => {
    if (url.pathname === "/auth/sanctum/token") { exchanges++; throw new Error("lost acknowledgement"); }
    return synthetic(url, init);
  });
  const auth = new AuthWorkflow(api, async () => identityReply());
  await auth.begin(start);
  await assert.rejects(auth.verify("000000"), /outcome may be unknown/);
  assert.equal((await auth.status()).challenge?.phase, "exchanging");
  await assert.rejects(auth.verify("000000"), /No challenge awaiting/);
  assert.equal(exchanges, 1);
  await auth.cancel();
  const denied = new AuthWorkflow(api, async () => Response.json({ error: { message: "OPERATION_NOT_ALLOWED" } }, { status: 403 }));
  await assert.rejects(denied.begin(start), /Firebase HTTP 403/);
  assert.equal((await denied.status()).challenge, undefined);
});

test("resuming with an environment override fails before consuming the verification code", async t => {
  const config = await configuration(t, { ...liveEnv, SWITCHN_BEARER_TOKEN: undefined, SWITCHN_FIREBASE_API_KEY: "key" });
  const synthetic = mockTransport();
  let verifications = 0;
  const api = new ApiClient(config, undefined, async (url, init) => {
    if (url.pathname.endsWith("/validate")) verifications++;
    return synthetic(url, init);
  });
  const auth = new AuthWorkflow(api, async () => identityReply());
  await auth.begin(start);
  const restarted = new ApiClient({ ...config, envToken: "new-environment-override" }, undefined, async (url, init) => {
    if (url.pathname.endsWith("/validate")) verifications++;
    return synthetic(url, init);
  });
  await assert.rejects(new AuthWorkflow(restarted).verify("000000"), /Unset SWITCHN_BEARER_TOKEN/);
  assert.equal(verifications, 0);
});
