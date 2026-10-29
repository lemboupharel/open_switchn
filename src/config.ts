import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { parseEnv } from "node:util";
import { z } from "zod";
import { secret } from "./models.js";

export const API_ORIGIN = "https://api.switchn.net";
const header = z.string().min(1).max(16384).regex(/^[\x20-\x7e]+$/, "Invalid header value");
const envSchema = z.object({
  SWITCHN_MODE: z.literal("live").default("live"),
  SWITCHN_ENABLE_LIVE: z.literal("true").default("true"),
  SWITCHN_ALLOW_PAYMENTS: z.enum(["true", "false"]).default("false"),
  SWITCHN_APP_VERSION: header.default("4.1.2"),
  SWITCHN_USER_AGENT: header.default("switchn-local-client/0.1"),
  SWITCHN_FCM_TOKEN: z.string().optional(),
  SWITCHN_BEARER_TOKEN: z.string().optional(),
  SWITCHN_FIREBASE_API_KEY: z.string().optional(),
  SWITCHN_DEBUG: z.enum(["true", "false"]).default("false"),
  SWITCHN_DATA_DIR: z.string().optional(),
  SWITCHN_TIMEOUT_MS: z.coerce.number().int().min(100).max(120000).default(15000),
  SWITCHN_PORT: z.coerce.number().int().min(0).max(65535).default(4317),
  SWITCHN_PAYMENT_HOSTS: z.string().default("")
});
export interface Config {
  mode: "live";
  allowPayments: boolean;
  appVersion: string;
  userAgent: string;
  fcmToken?: string;
  envToken?: string;
  firebaseApiKey?: string;
  debug: boolean;
  dataDir: string;
  timeoutMs: number;
  port: number;
  paymentHosts: string[];
}
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  if (env.SWITCHN_MODE !== undefined && env.SWITCHN_MODE !== "live") {
    throw new Error("This client is live-only. Remove the old SWITCHN_MODE value or set SWITCHN_MODE=live.");
  }
  if (env.SWITCHN_ENABLE_LIVE !== undefined && env.SWITCHN_ENABLE_LIVE !== "true") {
    throw new Error("This client is live-only. Remove the old SWITCHN_ENABLE_LIVE value or set it to true.");
  }
  const parsed = envSchema.parse(env);
  const root = parsed.SWITCHN_DATA_DIR || join(homedir(), ".local", "state", "switchn-local-client");
  if (!isAbsolute(root)) throw new Error("SWITCHN_DATA_DIR must be absolute");
  const hosts = parsed.SWITCHN_PAYMENT_HOSTS.split(",").map(v => v.trim().toLowerCase()).filter(Boolean);
  for (const host of hosts) {
    if (!/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/.test(host)) {
      throw new Error("Payment hosts must be exact DNS names without schemes, ports or wildcards");
    }
  }
  return {
    mode: parsed.SWITCHN_MODE,
    allowPayments: parsed.SWITCHN_ALLOW_PAYMENTS === "true",
    appVersion: parsed.SWITCHN_APP_VERSION,
    userAgent: parsed.SWITCHN_USER_AGENT,
    fcmToken: parsed.SWITCHN_FCM_TOKEN ? header.parse(parsed.SWITCHN_FCM_TOKEN) : undefined,
    envToken: parsed.SWITCHN_BEARER_TOKEN ? secret.parse(parsed.SWITCHN_BEARER_TOKEN) : undefined,
    firebaseApiKey: parsed.SWITCHN_FIREBASE_API_KEY ? secret.parse(parsed.SWITCHN_FIREBASE_API_KEY) : undefined,
    debug: parsed.SWITCHN_DEBUG === "true",
    dataDir: join(root, parsed.SWITCHN_MODE),
    timeoutMs: parsed.SWITCHN_TIMEOUT_MS,
    port: parsed.SWITCHN_PORT,
    paymentHosts: hosts
  };
}
export function requirePayment(config: Config): void {
  if (!config.allowPayments) {
    throw new Error("Live payments disabled. SWITCHN_ALLOW_PAYMENTS=true is also required.");
  }
}
export async function loadEnvironment(path = join(process.cwd(), ".env"), env = process.env): Promise<boolean> {
  let file;
  try { file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW); }
  catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
  try {
    const stat = await file.stat();
    if (!stat.isFile() || (stat.mode & 0o077) !== 0 || stat.size > 65536) {
      throw new Error(".env must be a private regular file (chmod 600), maximum 64 KB");
    }
    const values = parseEnv(await file.readFile("utf8"));
    for (const [key, value] of Object.entries(values)) {
      if (env[key] === undefined) env[key] = value;
    }
    return true;
  } finally { await file.close(); }
}
export function safePaymentLink(value: unknown, config: Config): string | undefined {
  if (typeof value !== "string") return undefined;
  let url: URL;
  try { url = new URL(value); } catch { return undefined; }
  if (url.protocol !== "https:" || url.username || url.password || url.port || !config.paymentHosts.includes(url.hostname)) {
    return undefined;
  }
  return url.href;
}
