import test from "node:test";
import assert from "node:assert/strict";
import { chmod, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ApiClient, type Fetcher } from "../src/api.js";
import { Workflow } from "../src/workflow.js";
import { SessionStore } from "../src/storage.js";
import { configuration, draft, liveEnv, withPreflight } from "./helpers.js";
import { fixtureTransport } from "./fixture.js";

test("reviewed fees are used for submission; two concurrent confirmations result in one attempt", async t => {
  const config = await configuration(t);
  const workflow = new Workflow(new ApiClient(config, undefined, fixtureTransport()));
  const ticket = await workflow.reviewMoney(draft);
  assert.equal(ticket.action.kind === "money" && ticket.action.body.inputted_receiver_name, draft.inputted_receiver_name);
  assert.equal(ticket.action.kind, "money");
  if (ticket.action.kind !== "money") throw new Error("Wrong kind");
  assert.equal(ticket.action.body.amount_after_fees, 975);
  assert.equal(ticket.action.body.transaction_specific_fee, 25);
  await assert.rejects(workflow.submit(ticket.id, "wrong"), /Confirmation/);
  const attempts = await Promise.allSettled([
    workflow.submit(ticket.id, ticket.confirmation, "1234"),
    workflow.submit(ticket.id, ticket.confirmation, "1234")
  ]);
  assert.equal(attempts.filter(v => v.status === "fulfilled").length, 1);
  assert.equal((await workflow.get(ticket.id)).state, "submitted");
  const persisted = await readFile(join(config.dataDir, "tickets", `${ticket.id}.json`), "utf8");
  assert.ok(!persisted.includes("1234"));
  await assert.rejects(new Workflow(new ApiClient(config, undefined, fixtureTransport())).submit(ticket.id, ticket.confirmation), /already/);
});
test("interrupted POST remains outcome-unknown across restart and cannot be retried", async t => {
  const config = await configuration(t, liveEnv);
  let posts = 0;
  const send: Fetcher = withPreflight(async (url, init) => {
    if (url.pathname.endsWith("/review")) return Response.json({
      success: true, data: { ...JSON.parse(String(init.body)), name_match: true }
    });
    posts++; throw new Error("connection lost after write");
  });
  const workflow = new Workflow(new ApiClient(config, undefined, send));
  const ticket = await workflow.reviewMoney(draft);
  await assert.rejects(workflow.submit(ticket.id, ticket.confirmation), /outcome may be unknown/);
  assert.equal((await workflow.get(ticket.id)).state, "outcome-unknown");
  await assert.rejects(new Workflow(new ApiClient(config, undefined, send)).submit(ticket.id, ticket.confirmation), /already/);
  assert.equal(posts, 1);
});
test("expiry, name mismatch and unsupported responses stop the flow", async t => {
  const config = await configuration(t);
  let now = Date.now();
  const flow = new Workflow(new ApiClient(config, undefined, fixtureTransport()), () => now);
  const ticket = await flow.reviewMoney(draft);
  now += 300001;
  await assert.rejects(flow.submit(ticket.id, ticket.confirmation), /expired/);
  const live = await configuration(t, liveEnv);
  const badName: Fetcher = withPreflight(async (_url, init) => Response.json({
    success: true, data: { ...JSON.parse(String(init.body)), name_match: false }
  }));
  await assert.rejects(new Workflow(new ApiClient(live, undefined, badName)).reviewMoney(draft), /mismatch/);
  const missingData: Fetcher = withPreflight(async (url, init) => Response.json(url.pathname.endsWith("/review")
    ? { data: { ...JSON.parse(String(init.body)), name_match: true } } : { success: true }));
  const badFlow = new Workflow(new ApiClient(live, undefined, missingData));
  const badTicket = await badFlow.reviewMoney(draft);
  await assert.rejects(badFlow.submit(badTicket.id, badTicket.confirmation));
  assert.equal((await badFlow.get(badTicket.id)).state, "outcome-unknown");
});
test("airtime and bundle actions share explicit confirmation and never persist PINs", async t => {
  const flow = new Workflow(new ApiClient(await configuration(t), undefined, fixtureTransport()));
  const body = { payer: "MOCK-PAYER", to: "MOCK-RECIPIENT", amount: 100, lang: "en" };
  await assert.rejects(flow.prepareAirtime({ ...body, pin: "1234" }), /PIN/);
  const airtime = await flow.prepareAirtime(body);
  assert.equal((await flow.submit(airtime.id, airtime.confirmation)).ticket.state, "submitted");
  const bundle = await flow.prepareBundle({ promotion: "MOCK-BUNDLE", phone: "MOCK-RECIPIENT" });
  assert.equal((await flow.submit(bundle.id, bundle.confirmation)).ticket.state, "submitted");
});
test("sessions are private, mode-separated, and unsafe permissions/corrupt state are explicit errors", async t => {
  const config = await configuration(t, { ...liveEnv, SWITCHN_BEARER_TOKEN: undefined });
  const store = new SessionStore(config);
  await store.save("owned-token");
  const file = join(config.dataDir, "session.json");
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  assert.equal((await stat(config.dataDir)).mode & 0o777, 0o700);
  assert.equal(await store.token(), "owned-token");
  await chmod(file, 0o644);
  await assert.rejects(store.token(), /Unsafe state file/);
  await chmod(file, 0o600);
  await writeFile(file, "{secret broken");
  await assert.rejects(store.token(), /Invalid JSON in private state/);
  await store.clear();
  assert.equal(await store.token(), undefined);
});
