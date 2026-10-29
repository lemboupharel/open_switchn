import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, rename, unlink } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import { z } from "zod";
import { secret } from "./models.js";
import type { Config } from "./config.js";

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
export async function privateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("State directory must be a real directory");
  await chmod(path, 0o700);
}
export async function readPrivate(path: string): Promise<unknown | undefined> {
  let file;
  try { file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW); }
  catch (error) { if (isMissing(error)) return undefined; throw error; }
  try {
    const stat = await file.stat();
    if (!stat.isFile() || (stat.mode & 0o077) !== 0 || stat.size > 2_000_000) {
      throw new Error("Unsafe state file: expected a private regular file (chmod 600), maximum 2 MB");
    }
    const text = await file.readFile("utf8");
    try { return JSON.parse(text) as unknown; }
    catch { throw new Error("Invalid JSON in private state; contents withheld"); }
  } finally { await file.close(); }
}
export async function writePrivate(directory: string, name: string, value: unknown): Promise<void> {
  await privateDirectory(directory);
  const temporary = join(directory, `.${randomUUID()}.tmp`);
  const file = await open(temporary, "wx", 0o600);
  try {
    await file.writeFile(JSON.stringify(value, null, 2) + "\n");
    await file.sync();
  } catch (error) {
    await file.close();
    await unlink(temporary);
    throw error;
  }
  await file.close();
  try { await rename(temporary, join(directory, name)); }
  catch (error) { await unlink(temporary); throw error; }
  const dir = await open(directory, constants.O_RDONLY);
  try { await dir.sync(); } finally { await dir.close(); }
}

const sessionSchema = z.object({
  token: secret, mode: z.literal("live"), savedAt: z.string().datetime()
}).strict();
const healthSchema = z.object({
  fingerprint: z.string(), state: z.enum(["validated", "rejected"]), checkedAt: z.string().datetime()
}).strict();
export function tokenFingerprint(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}
export class SessionStore {
  constructor(readonly config: Config) {}
  private async rawToken(): Promise<string | undefined> {
    if (this.config.envToken) return this.config.envToken;
    const stored = await readPrivate(join(this.config.dataDir, "session.json"));
    if (stored === undefined) return undefined;
    const session = sessionSchema.parse(stored);
    if (session.mode !== this.config.mode) throw new Error("Session mode does not match configuration");
    return session.token;
  }
  async status() {
    const token = await this.rawToken();
    const health = await readPrivate(join(this.config.dataDir, "session-health.json"));
    const record = health === undefined ? undefined : healthSchema.parse(health);
    const matches = token && record?.fingerprint === tokenFingerprint(token);
    return {
      tokenPresent: Boolean(token),
      state: !token ? "missing" : matches ? record.state : "unverified",
      checkedAt: matches ? record.checkedAt : undefined,
      source: this.config.envToken ? "environment" : "private session file"
    };
  }
  async token(): Promise<string | undefined> {
    const token = await this.rawToken();
    if (!token) return undefined;
    const health = await readPrivate(join(this.config.dataDir, "session-health.json"));
    if (health !== undefined) {
      const record = healthSchema.parse(health);
      if (record.state === "rejected" && record.fingerprint === tokenFingerprint(token)) return undefined;
    }
    return token;
  }
  async mark(token: string, state: "validated" | "rejected"): Promise<void> {
    if (token !== await this.rawToken()) throw new Error("Session changed during the request; start again with a fresh review");
    await writePrivate(this.config.dataDir, "session-health.json", {
      fingerprint: tokenFingerprint(token), state, checkedAt: new Date().toISOString()
    });
  }
  async save(value: string): Promise<void> {
    if (this.config.envToken) {
      throw new Error("Unset SWITCHN_BEARER_TOKEN before saving a different session; environment takes precedence.");
    }
    await writePrivate(this.config.dataDir, "session.json", {
      token: secret.parse(value), mode: this.config.mode, savedAt: new Date().toISOString()
    });
    await this.remove("session-health.json");
  }
  async remove(name: "session.json" | "session-health.json" | "login-challenge.json"): Promise<void> {
    try { await unlink(join(this.config.dataDir, name)); }
    catch (error) { if (!isMissing(error)) throw error; }
  }
  async clear(): Promise<void> {
    await this.remove("session.json");
    await this.remove("login-challenge.json");
    if (!this.config.envToken) await this.remove("session-health.json");
  }
}
