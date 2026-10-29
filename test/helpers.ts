import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";
import { loadConfig, type Config } from "../src/config.js";
import { fixtureTransport } from "./fixture.js";
import type { Fetcher } from "../src/api.js";

const nativeFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const url = new URL(input instanceof Request ? input.url : input.toString());
  if (url.protocol === "http:" && url.hostname === "127.0.0.1") return nativeFetch(input, init);
  throw new Error("Tests must inject external transports; real upstream network access is forbidden");
};

export async function configuration(t: TestContext, env: NodeJS.ProcessEnv = {}): Promise<Config> {
  const root = await mkdtemp(join(tmpdir(), "switchn-client-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return loadConfig({ ...liveEnv, SWITCHN_DATA_DIR: root, SWITCHN_PORT: "0", ...env });
}
export const draft = {
  from: "MOCK-PAYER", to: "MOCK-RECIPIENT", amount: 1000,
  from_carrier: "MTN Cameroon", to_carrier: "Orange", payment_method: "ussd_pay",
  inputted_receiver_name: "TEST RECIPIENT"
};
export const liveEnv = {
  SWITCHN_MODE: "live", SWITCHN_ENABLE_LIVE: "true",
  SWITCHN_ALLOW_PAYMENTS: "true", SWITCHN_BEARER_TOKEN: "test-owned-token"
};
export function withPreflight(transport: Fetcher): Fetcher {
  const synthetic = fixtureTransport();
  return (url, init) => init.method === "GET" ? synthetic(url, init) : transport(url, init);
}
