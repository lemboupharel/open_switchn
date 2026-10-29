import { randomUUID } from "node:crypto";

const privateKey = /token|authorization|cookie|password|pin|otp|secret|api.?key|unique_id|payment_link|validate_url|resend_url|hash|phone|^from$|^to$|^payer$|^receiver$|^sender$|primary_number|email|name|reference/i;
export interface Trace {
  id: string;
  at: string;
  method: string;
  url: string;
  requestHeaders: unknown;
  requestBody: unknown;
  responseHeaders?: unknown;
  responseBody?: unknown;
  httpStatus?: number;
  durationMs?: number;
  error?: string;
}

export class Diagnostics {
  private readonly records: Trace[] = [];
  constructor(readonly enabled: boolean) {}
  capture(input: Omit<Trace, "id" | "at">, credentials: (string | undefined)[] = []): void {
    if (!this.enabled) return;
    const secrets = new Set(credentials.filter((value): value is string => Boolean(value)));
    const gather = (value: unknown) => {
      if (!value || typeof value !== "object") return;
      for (const [key, item] of Object.entries(value)) {
        if (privateKey.test(key) && typeof item === "string" && item) secrets.add(item);
        else gather(item);
      }
    };
    gather(input.requestBody);
    gather(input.responseBody);
    const mask = (value: unknown): unknown => {
      if (Array.isArray(value)) return value.map(mask);
      if (value && typeof value === "object") return Object.fromEntries(
        Object.entries(value).map(([key, item]) => [key, privateKey.test(key) ? "[REDACTED]" : mask(item)]));
      if (typeof value === "string") {
        let text = value;
        for (const credential of secrets) text = text.split(credential).join("[REDACTED]");
        return text;
      }
      return value;
    };
    const url = new URL(input.url);
    if (url.pathname.startsWith("/otps/")) url.pathname = "/otps/[REDACTED]/validate";
    for (const key of [...url.searchParams.keys()]) url.searchParams.set(key, "[REDACTED]");
    const safeHeaders = (value: unknown) => value && typeof value === "object"
      ? Object.fromEntries(Object.entries(value).map(([key, item]) =>
        [key, /^(accept|content-type|app-version|platform|user-agent|retry-after)$/i.test(key) ? mask(item) : "[REDACTED]"]))
      : undefined;
    const record: Trace = {
      id: randomUUID(), at: new Date().toISOString(), method: input.method, url: url.href,
      requestHeaders: safeHeaders(input.requestHeaders), requestBody: mask(input.requestBody),
      responseHeaders: safeHeaders(input.responseHeaders), responseBody: mask(input.responseBody),
      httpStatus: input.httpStatus, durationMs: input.durationMs, error: input.error
    };
    // Bound both record size and count; diagnostics are never written to disk automatically.
    if (JSON.stringify(record).length > 32000) {
      record.requestBody = "[OMITTED: trace size limit]";
      record.responseBody = "[OMITTED: trace size limit]";
    }
    this.records.push(record);
    if (this.records.length > 50) this.records.shift();
  }
  list(): readonly Trace[] { return this.records; }
}
