import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join, resolve } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { configuration, draft } from "./helpers.js";

const execute = promisify(execFile);
test("CLI automatically loads private dotenv, exposes no key and refuses stale mock configuration", async t => {
  const config = await configuration(t);
  await mkdir(config.dataDir, { mode: 0o700 });
  const file = join(config.dataDir, ".env");
  await writeFile(file, `SWITCHN_FIREBASE_API_KEY=test-file-key\nSWITCHN_DATA_DIR=${config.dataDir}\n`, { mode: 0o600 });
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith("SWITCHN_")) delete env[key];
  const args = ["--import", import.meta.resolve("tsx"), "--import", resolve("test/helpers.ts"), resolve("src/cli.ts"), "auth", "status"];
  const result = await execute(process.execPath, args, { env, cwd: config.dataDir });
  const status = JSON.parse(result.stdout);
  assert.equal(status.mode, "live");
  assert.equal(status.bootstrapConfigured, true);
  assert.equal(status.session.state, "missing");
  assert.ok(!result.stdout.includes("test-file-key"));
  await writeFile(file, "SWITCHN_MODE=mock\n");
  await assert.rejects(execute(process.execPath, args, { env, cwd: config.dataDir }), /live-only/);
});

test("CLI with test-only fetch injection: login, OTP, quote, submit, check, catalog, fees and malformed input", async t => {
  const config = await configuration(t);
  await mkdir(config.dataDir, { mode: 0o700 });
  const env = {
    ...process.env, SWITCHN_MODE: "live", SWITCHN_ENABLE_LIVE: "true",
    SWITCHN_ALLOW_PAYMENTS: "true", SWITCHN_BEARER_TOKEN: "", SWITCHN_FCM_TOKEN: "", SWITCHN_FIREBASE_API_KEY: "test-key",
    SWITCHN_DATA_DIR: join(config.dataDir, "cli")
  };
  const cli = async (...args: string[]) => {
    const result = await execute(process.execPath, [
      "--import", import.meta.resolve("tsx"), "--import", resolve("test/install-fixture.ts"), resolve("src/cli.ts"), ...args
    ], { env, cwd: config.dataDir });
    return JSON.parse(result.stdout);
  };
  assert.equal((await cli("auth", "login", "device", resolve("test/fixtures/device-login.json"))).saved, true);
  await cli("auth", "otp-create", resolve("test/fixtures/otp-create.json"));
  assert.equal((await cli("auth", "otp-verify", resolve("test/fixtures/otp-verify.json"))).body.data.status_code, "otp_verified");
  const ticket = await cli("transfer", "review", resolve("test/fixtures/transfer.json"));
  assert.equal((await cli("submit", ticket.id, "--confirm", ticket.confirmation)).ticket.state, "submitted");
  assert.equal((await cli("transfer", "check", "2001")).body.data.payment_status, "pending");
  assert.equal((await cli("fees", "mtn_mobile_money", "1000")).estimate, "10");
  assert.equal((await cli("bundles", "remote")).body.data[0].code, "MOCK-BUNDLE");
  assert.equal((await cli("bundles", "local")).source, "not-imported");
  const file = join(config.dataDir, "catalog-input.json");
  await writeFile(file, JSON.stringify([{ id: 1, cost: 100, code: "LOCAL", name: "Synthetic", network_carrier: "Orange", extra: "stripped" }]));
  assert.equal((await cli("bundles", "import", file)).imported, 1);
  assert.equal((await cli("bundles", "local")).entries[0].extra, undefined);
  await writeFile(file, "{private-invalid-input");
  await assert.rejects(cli("transfer", "build", file), error => {
    assert.ok(error instanceof Error);
    assert.ok(!error.message.includes("private-invalid-input"));
    return true;
  });
  await writeFile(file, JSON.stringify({ ...draft, inputted_receiver_name: undefined }));
  await assert.rejects(cli("transfer", "review", file), /registered Mobile Money account name/);
});
