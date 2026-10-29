import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { loadConfig, loadEnvironment } from "../src/config.js";
import { SessionStore, writePrivate } from "../src/storage.js";
import { configuration } from "./helpers.js";

test("private dotenv loads live settings without overriding process environment", async t => {
  const config = await configuration(t);
  await mkdir(config.dataDir, { mode: 0o700 });
  const path = join(config.dataDir, ".env");
  await writeFile(path, "SWITCHN_MODE=live\nSWITCHN_FIREBASE_API_KEY=test-key\nSWITCHN_PORT=4317\nSWITCHN_DEBUG=true\n", { mode: 0o600 });
  const env: NodeJS.ProcessEnv = { SWITCHN_PORT: "0" };
  assert.equal(await loadEnvironment(path, env), true);
  const loaded = loadConfig(env);
  assert.equal(loaded.mode, "live");
  assert.equal(loaded.firebaseApiKey, "test-key");
  assert.equal(loaded.port, 0);
  assert.equal(loaded.debug, true);
  assert.equal(loaded.allowPayments, false);
  await writeFile(path, "SWITCHN_MODE=mock\n");
  const stale: NodeJS.ProcessEnv = {};
  await loadEnvironment(path, stale);
  assert.throws(() => loadConfig(stale), /live-only/);
});

test("dotenv rejects public permissions and symlinks instead of ignoring unsafe files", async t => {
  const config = await configuration(t);
  await mkdir(config.dataDir, { mode: 0o700 });
  const path = join(config.dataDir, ".env");
  assert.equal(await loadEnvironment(path, {}), false);
  await writeFile(path, "SWITCHN_FIREBASE_API_KEY=private-test-key", { mode: 0o600 });
  await chmod(path, 0o644);
  await assert.rejects(loadEnvironment(path, {}), /private regular file/);
  await chmod(path, 0o600);
  const link = join(config.dataDir, "linked.env");
  await symlink(path, link);
  await assert.rejects(loadEnvironment(link, {}), { code: "ELOOP" });
});

test("missing sessions stay missing and old mock credentials cannot be imported as live state", async t => {
  const config = await configuration(t, { SWITCHN_BEARER_TOKEN: undefined });
  const session = new SessionStore(config);
  assert.equal(await session.token(), undefined);
  assert.equal((await session.status()).state, "missing");
  await writePrivate(config.dataDir, "session.json", {
    mode: "mock", token: "synthetic-old-token", savedAt: new Date().toISOString()
  });
  await assert.rejects(session.token());
});
