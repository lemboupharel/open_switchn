import { open, unlink } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { ApiClient, ApiError, type Fetcher } from "./api.js";
import { objectData, secret } from "./models.js";
import { readJson } from "./http.js";
import { privateDirectory, readPrivate, writePrivate } from "./storage.js";

const startInput = z.object({
  phone: z.string().trim().min(1).max(64), transport: z.enum(["sms", "whatsapp"]),
  device_name: z.string().trim().min(1).max(128).default("Switchn Local Lab"),
  device_lang: z.string().trim().min(1).max(16).default("en")
}).strict();
const challengeSchema = startInput.extend({
  identityToken: secret, expiresAt: z.number(),
  validateUrl: z.string().optional(),
  phase: z.enum(["creating", "awaiting-otp", "verified", "exchanging", "outcome-unknown"])
}).strict();
type Challenge = z.infer<typeof challengeSchema>;

export class AuthWorkflow {
  constructor(readonly api: ApiClient, private readonly identityTransport: Fetcher = fetch,
    private readonly clock = Date.now) {}
  private async locked<T>(operation: () => Promise<T>): Promise<T> {
    await privateDirectory(this.api.config.dataDir);
    const path = join(this.api.config.dataDir, "auth.lock");
    let lock;
    try { lock = await open(path, "wx", 0o600); }
    catch (error) {
      if (error instanceof Error && "code" in error && error.code === "EEXIST") {
        throw new Error("Another sign-in operation is active. If its process crashed, follow auth.lock recovery in the guide.");
      }
      throw error;
    }
    try { return await operation(); }
    finally { await lock.close(); await unlink(path); }
  }
  private async load(): Promise<Challenge | undefined> {
    const value = await readPrivate(join(this.api.config.dataDir, "login-challenge.json"));
    return value === undefined ? undefined : challengeSchema.parse(value);
  }
  private save(challenge: Challenge): Promise<void> {
    return writePrivate(this.api.config.dataDir, "login-challenge.json", challenge);
  }
  async status() {
    const challenge = await this.load();
    return {
      session: await this.api.session.status(),
      bootstrapConfigured: Boolean(this.api.config.firebaseApiKey),
      challenge: challenge ? {
        phase: challenge.phase, expiresAt: challenge.expiresAt, expired: challenge.expiresAt <= this.clock(),
        transport: challenge.transport
      } : undefined
    };
  }
  async options(phone: string): Promise<string[]> {
    const result = await this.api.loginOptions(phone);
    return z.array(z.string()).parse(result.body.data);
  }
  private async identity(): Promise<{ identityToken: string; expiresAt: number }> {
    const config = this.api.config;
    if (!config.firebaseApiKey) {
      throw new ApiError("Configure SWITCHN_FIREBASE_API_KEY for the authorized Switchn Firebase project, or import an authorized bearer. A different Firebase project will not work.",
        undefined, false, "bootstrap-not-configured");
    }
    const url = new URL("https://identitytoolkit.googleapis.com/v1/accounts:signUp");
    url.searchParams.set("key", config.firebaseApiKey);
    const body = { returnSecureToken: true };
    const headers = { "Content-Type": "application/json", Accept: "application/json" };
    const started = Date.now();
    const signal = AbortSignal.timeout(config.timeoutMs);
    let response: Response | undefined;
    let decoded: unknown;
    let failure: string | undefined;
    try {
      response = await this.identityTransport(url, {
        method: "POST", headers, body: JSON.stringify(body), redirect: "manual", signal
      });
      try { decoded = await readJson(response); }
      catch { throw new ApiError("Identity provider returned unsupported bounded JSON.", response.status, false, "identity-response"); }
      if (!response.ok) throw new ApiError(
        `Firebase HTTP ${response.status}. Check the authorized project configuration; Android-only restrictions or additional verification require the official app. No bypass or retry attempted.`,
        response.status, false, "identity-rejected");
      const identity = z.object({
        idToken: secret, expiresIn: z.string().regex(/^\d+$/).transform(Number).pipe(z.number().int().min(60).max(86400))
      }).parse(decoded);
      return {
        identityToken: identity.idToken,
        expiresAt: this.clock() + Math.min(600_000, (identity.expiresIn - 30) * 1000)
      };
    } catch (error) {
      const problem = error instanceof ApiError ? error :
        new ApiError("Firebase identity initialization failed. No automatic retry; inspect sanitized diagnostics.",
          response?.status, false, signal.aborted ? "timeout" : "identity-failed");
      failure = problem.code;
      throw problem;
    } finally {
      this.api.diagnostics.capture({
        method: "POST", url: url.href, requestHeaders: headers, requestBody: body,
        responseHeaders: response ? Object.fromEntries(response.headers) : undefined,
        responseBody: decoded, httpStatus: response?.status, durationMs: Date.now() - started, error: failure
      }, [config.firebaseApiKey]);
    }
  }
  async begin(input: unknown) {
    return this.locked(async () => {
      const value = startInput.parse(input);
      if (this.api.config.envToken) {
        throw new Error("Unset SWITCHN_BEARER_TOKEN before starting phone sign-in; it overrides stored sessions.");
      }
      if (await this.load()) throw new Error("A sign-in challenge already exists. Resume it or explicitly cancel before starting another.");
      if (!this.api.config.firebaseApiKey) {
        throw new ApiError("Phone sign-in needs SWITCHN_FIREBASE_API_KEY for the authorized Switchn Firebase project.",
          undefined, false, "bootstrap-not-configured");
      }
      const options = await this.options(value.phone);
      if (!options.includes(`otp_${value.transport}`)) {
        throw new ApiError("The chosen OTP transport is not offered for this number. Use an offered option or the official app.",
          undefined, false, "unsupported-login-option");
      }
      const challenge: Challenge = { ...value, ...await this.identity(), phase: "creating" };
      await this.save(challenge);
      let result;
      try {
        result = await this.api.createOtp({
          token: challenge.identityToken, phone_number: value.phone,
          device_lang: value.device_lang, transport: value.transport
        }, false);
      } catch (error) {
        challenge.phase = "outcome-unknown";
        await this.save(challenge);
        throw error;
      }
      if (result.body.success !== true) throw new ApiError("OTP creation did not confirm success. No resend attempted.");
      const data = objectData(result.body.data);
      if (data.status === "otp_verified") {
        challenge.phase = "verified";
        await this.save(challenge);
        return this.exchange(challenge);
      }
      challenge.validateUrl = this.api.otpUrl(z.string().min(1).parse(data.validate_url)).href;
      challenge.phase = "awaiting-otp";
      await this.save(challenge);
      return this.status();
    });
  }
  async verify(code: string) {
    return this.locked(async () => {
      if (this.api.config.envToken) {
        throw new Error("Unset SWITCHN_BEARER_TOKEN before verifying a phone sign-in; it overrides stored sessions.");
      }
      const challenge = await this.load();
      if (!challenge || challenge.phase !== "awaiting-otp" || !challenge.validateUrl) {
        throw new Error("No challenge awaiting a code. Inspect sign-in status; do not repeat an uncertain exchange.");
      }
      if (challenge.expiresAt <= this.clock()) throw new Error("Local sign-in window expired. Cancel and explicitly start sign-in again.");
      const result = await this.api.validateOtp(challenge.validateUrl, {
        otp: z.string().trim().min(1).max(32).parse(code),
        device_lang: challenge.device_lang, device_name: challenge.device_name, do_login: true
      });
      // The APK callback checks success, then registers with the original identity token, not unique_id.
      if (result.body.success !== true) throw new ApiError("Phone verification did not explicitly succeed. No token exchange performed.");
      challenge.phase = "verified";
      await this.save(challenge);
      return this.exchange(challenge);
    });
  }
  private async exchange(challenge: Challenge) {
    if (challenge.expiresAt <= this.clock()) throw new Error("Identity token window expired; start a new sign-in explicitly.");
    challenge.phase = "exchanging";
    await this.save(challenge);
    await this.api.login("device", {
      token: challenge.identityToken, phone: challenge.phone,
      device_name: challenge.device_name, device_lang: challenge.device_lang
    });
    await this.api.session.remove("login-challenge.json");
    await this.api.validateSession();
    return this.status();
  }
  async cancel() {
    return this.locked(async () => {
      await this.api.session.remove("login-challenge.json");
      return { cancelledLocally: true, serverChallengeRevoked: false };
    });
  }
  async logout() {
    return this.locked(async () => {
      await this.api.session.clear();
      return { removedLocally: true, serverRevoked: false, environmentOverride: Boolean(this.api.config.envToken) };
    });
  }
}
