import { z } from "zod";
import { API_ORIGIN, requirePayment, type Config } from "./config.js";
import { SessionStore, tokenFingerprint } from "./storage.js";
import {
  airtimeBody, deviceLogin, envelope, googleLogin, identifier, moneyBody,
  objectData, otpCreate, otpValidate, secret, type Envelope
} from "./models.js";
import { readJson } from "./http.js";
import { Diagnostics } from "./diagnostics.js";

export type Fetcher = (url: URL, init: RequestInit) => Promise<Response>;
export interface ApiResult {
  mode: "live";
  httpStatus: number;
  body: Envelope;
}
export class ApiError extends Error {
  constructor(message: string, readonly httpStatus?: number, readonly outcomeUnknown = false,
    readonly code = "upstream-error") { super(message); }
}
export class ApiClient {
  private readonly send: Fetcher;
  readonly diagnostics: Diagnostics;
  constructor(readonly config: Config, readonly session = new SessionStore(config), transport?: Fetcher) {
    this.send = transport ?? fetch;
    this.diagnostics = new Diagnostics(config.debug);
  }
  private async request(
    method: "GET" | "POST", path: string, body?: unknown,
    auth: "required" | "optional" | "none" = "required", payment = false,
    expectedIdentity?: string, cancellation?: AbortSignal
  ): Promise<ApiResult> {
    if (payment) requirePayment(this.config);
    const url = new URL(path, API_ORIGIN);
    if (url.origin !== API_ORIGIN || url.username || url.password || url.hash) {
      throw new Error("Requests must stay on the configured Switchn HTTPS origin");
    }
    const token = auth === "none" ? undefined : await this.session.token();
    if (auth === "required" && !token) {
      throw new ApiError("No active bearer session. Complete Sign in / auth bootstrap, then obtain a fresh review.",
        undefined, false, "session-required");
    }
    if (expectedIdentity && (!token || tokenFingerprint(token) !== expectedIdentity)) {
      throw new ApiError("Session changed before submission. Obtain a fresh review.", undefined, false, "session-changed");
    }
    const headers: Record<string, string> = {
      Accept: "application/json", "Content-Type": "application/json",
      "app-version": this.config.appVersion, platform: "android", "User-Agent": this.config.userAgent
    };
    if (token) headers.Authorization = `Bearer ${token}`;
    if (this.config.fcmToken) headers["fcm-token"] = this.config.fcmToken;
    const timeout = AbortSignal.timeout(this.config.timeoutMs);
    const signal = cancellation ? AbortSignal.any([timeout, cancellation]) : timeout;
    let response: Response | undefined;
    let decoded: unknown;
    let failure: string | undefined;
    const started = Date.now();
    try {
      response = await this.send(url, {
        method, headers, body: body === undefined ? undefined : JSON.stringify(body),
        redirect: "manual", signal
      });
      if (response.status === 401 && token) await this.session.mark(token, "rejected");
      try { decoded = await readJson(response); }
      catch {
        if (response.ok) throw new ApiError("Backend did not return supported bounded JSON. No retry attempted.",
          response.status, method === "POST", "invalid-response");
        decoded = { detail: "[Non-JSON or oversized error body withheld]" };
      }
      if (!response.ok) {
        if (response.status === 422 && method === "POST" && url.pathname === "/money-transfers/review" &&
            decoded !== null && typeof decoded === "object" && "message" in decoded && typeof decoded.message === "string") {
          const message = decoded.message.replaceAll("\u2019", "'");
          if (message === "The payer and receiver use the same network. Please transfer directly using your mobile money service.") {
            throw new ApiError(
              "Switchn rejected this same-network transfer. Use your mobile money provider's direct transfer service instead. No payment was submitted.",
              422, false, "same-network-transfer");
          }
          if (message === "Enter the receiver's Mobile Money account name. Already entered or no field? Update Switchn, then try again.") {
            throw new ApiError(
              "Switchn requires the recipient's registered Mobile Money account name. Enter or correct it in the recipient-name field, then request a new review. No payment was submitted.",
              422, false, "receiver-name-required");
          }
        }
        const code = response.status === 401 ? "session-rejected" : response.status === 403 ? "forbidden"
          : [400, 409, 422].includes(response.status) ? "invalid-payload"
          : response.status === 429 ? "rate-limited" : response.status >= 500 ? "upstream-unavailable" : "http-error";
        const advice = response.status === 401 ? "Session rejected; sign in again. No payment was replayed."
          : response.status === 403 ? "Access forbidden; re-authentication does not bypass permission checks."
          : response.status === 429 ? "Rate limited. Respect Retry-After; no automatic retry."
          : "Inspect sanitized diagnostics; no automatic retry.";
        throw new ApiError(`Backend HTTP ${response.status}. ${advice}`, response.status, method === "POST", code);
      }
      const parsed = envelope.safeParse(decoded);
      if (!parsed.success) throw new ApiError("Backend returned an unsupported response shape.",
        response.status, method === "POST", "invalid-response");
      if (parsed.data.success === false || parsed.data.action_required != null) {
        throw new ApiError("Backend rejected the operation or requires an additional action. Inspect diagnostics and use the official flow.",
          response.status, method === "POST", parsed.data.action_required != null ? "action-required" : "rejected");
      }
      return { mode: this.config.mode, httpStatus: response.status, body: parsed.data };
    } catch (error) {
      if (response && !(error instanceof ApiError)) {
        failure = "local-state-error";
        throw error;
      }
      const problem = error instanceof ApiError ? error :
        new ApiError("Network/timeout failure. POST outcome may be unknown; check status before any new submission.",
          response?.status, method === "POST", signal.aborted ? "timeout" : "network-error");
      failure = problem.code;
      throw problem;
    } finally {
      this.diagnostics.capture({
        method, url: url.href, requestHeaders: headers, requestBody: body,
        responseHeaders: response ? Object.fromEntries(response.headers) : undefined,
        responseBody: decoded, httpStatus: response?.status, durationMs: Date.now() - started, error: failure
      }, [token, this.config.fcmToken]);
    }
  }
  async login(kind: "device" | "google", input: unknown): Promise<{ mode: string; saved: true }> {
    if (this.config.envToken) {
      throw new Error("Unset SWITCHN_BEARER_TOKEN before acquiring a stored session");
    }
    const body = kind === "device" ? deviceLogin.parse(input) : googleLogin.parse(input);
    const result = await this.request("POST",
      kind === "device" ? "/auth/sanctum/token" : "/auth/google.com/token-anonymous", body, "none");
    if (result.body.success !== true) throw new ApiError("Token exchange did not explicitly confirm success.",
      result.httpStatus, false, "invalid-response");
    const token = secret.parse(objectData(result.body.data).access_token);
    await this.session.save(token);
    return { mode: this.config.mode, saved: true };
  }
  async createOtp(input: unknown, includeExistingSession = true): Promise<ApiResult> {
    return this.request("POST", "/otps", otpCreate.parse(input), includeExistingSession ? "optional" : "none");
  }
  async validateOtp(url: string, input: unknown): Promise<ApiResult> {
    const destination = this.otpUrl(url);
    return this.request("POST", destination.href, otpValidate.parse(input), "none");
  }
  otpUrl(value: string): URL {
    const url = new URL(value, API_ORIGIN);
    if (url.origin !== API_ORIGIN || url.username || url.password || url.hash || !url.pathname.startsWith("/otps/")) {
      throw new Error("OTP validation URL must be a returned /otps/ URL on the Switchn API origin");
    }
    return url;
  }
  async validateSession() {
    const token = await this.session.token();
    if (!token) throw new ApiError("No active bearer session. Complete Sign in / auth bootstrap first.",
      undefined, false, "session-required");
    const result = await this.wallet();
    const wallet = z.object({
      id: z.union([z.number().int().positive().max(Number.MAX_SAFE_INTEGER), identifier]),
      balance: z.string().regex(/^\d+(?:\.\d+)?$/),
      withdrawals_enabled: z.boolean().nullable().optional()
    }).parse(result.body.data);
    if (token !== await this.session.token()) throw new Error("Session changed during validation; sign in and review again");
    await this.session.mark(token, "validated");
    return { session: await this.session.status(), wallet };
  }
  wallet(): Promise<ApiResult> { return this.request("GET", "/my-funds"); }
  async reviewMoney(body: unknown): Promise<ApiResult> {
    return this.request("POST", "/money-transfers/review", moneyBody.parse(body));
  }
  async initiateMoney(body: unknown, expectedIdentity?: string): Promise<ApiResult> {
    return this.request("POST", "/money-transfers/initiate", moneyBody.parse(body), "required", true, expectedIdentity);
  }
  async checkPayment(id: string, signal?: AbortSignal): Promise<ApiResult> {
    return this.request("POST", `/payment-requests/${identifier.parse(id)}/payment-check`, undefined, "required", false, undefined, signal);
  }
  withdrawalFees(): Promise<ApiResult> { return this.request("GET", "/momo-withdrawal-fees"); }
  crossNetworkFees(): Promise<ApiResult> { return this.request("GET", "/momo-cross-network-fees"); }
  promotions(): Promise<ApiResult> { return this.request("GET", "/active-promotions"); }
  serviceStatus(): Promise<ApiResult> { return this.request("GET", "/service-status"); }
  paymentConfig(): Promise<ApiResult> { return this.request("GET", "/payment-config"); }
  async lookup(phone: string, kind: "carrier" | "name", context?: string): Promise<ApiResult> {
    z.string().min(1).max(64).parse(phone);
    const query = new URLSearchParams({ phone });
    if (context) query.set("context", context);
    return this.request("GET", `${kind === "carrier" ? "/get-phone-carrier" : "/momo-name"}?${query}`);
  }
  async loginOptions(phone: string): Promise<ApiResult> {
    const query = new URLSearchParams({ primary_number: z.string().min(1).max(64).parse(phone) });
    return this.request("GET", `/auth/login-options?${query}`, undefined, "none");
  }
  async buyAirtime(body: unknown, expectedIdentity?: string): Promise<ApiResult> {
    return this.request("POST", "/airtime-requests/web?channel=android_app", airtimeBody.parse(body), "required", true, expectedIdentity);
  }
  async activateBundle(promotion: string, phone: string, expectedIdentity?: string): Promise<ApiResult> {
    const value = z.string().min(1).max(128).regex(/^[a-zA-Z0-9+_-]+$/);
    return this.request("POST", `/bundles/${encodeURIComponent(value.parse(promotion))}/activate/${encodeURIComponent(value.parse(phone))}`,
      undefined, "required", true, expectedIdentity);
  }
}
