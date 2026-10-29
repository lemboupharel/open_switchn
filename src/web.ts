import { createServer, type IncomingMessage, type Server } from "node:http";
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { z, ZodError } from "zod";
import { ApiClient, ApiError } from "./api.js";
import { Workflow } from "./workflow.js";
import { buildMoneyBody } from "./models.js";
import { errorMessage, redact } from "./presentation.js";
import { localCatalog } from "./catalogs.js";
import { estimateWithdrawal } from "./fees.js";
import { AuthWorkflow } from "./auth.js";
import { paymentObservation, pollPayment } from "./lifecycle.js";

async function jsonInput(request: IncomingMessage): Promise<unknown> {
  if (request.headers["content-type"]?.split(";")[0] !== "application/json") {
    throw new Error("Use application/json");
  }
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > 65536) throw new Error("Request too large (64 KB maximum)");
    chunks.push(bytes);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown; }
  catch { throw new Error("Invalid JSON request"); }
}

export async function startWeb(api: ApiClient, workflow = new Workflow(api), auth = new AuthWorkflow(api)): Promise<{ server: Server; url: string }> {
  const csrf = randomBytes(32).toString("hex");
  // Both source and dist/src resolve to the same project public directory.
  const source = fileURLToPath(import.meta.url);
  const publicDir = new URL(source.includes("/dist/src/") ? "../../public/" : "../public/", import.meta.url);
  const [html, script, css] = await Promise.all([
    readFile(new URL("index.html", publicDir), "utf8"),
    readFile(new URL("app.js", publicDir), "utf8"),
    readFile(new URL("style.css", publicDir), "utf8")
  ]);
  let origin = "";
  const server = createServer(async (request, response) => {
    response.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Referrer-Policy", "no-referrer");
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("X-Frame-Options", "DENY");
    const reply = (status: number, body: unknown) => {
      response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
      response.end(JSON.stringify(redact(body)));
    };
    try {
      if (request.headers.host !== new URL(origin).host ||
          (request.headers.origin && request.headers.origin !== origin) ||
          request.headers["sec-fetch-site"] === "cross-site") {
        reply(403, { error: "Host/origin rejected" }); return;
      }
      const path = new URL(request.url ?? "/", origin).pathname;
      if (request.method === "GET" && ["/", "/app.js", "/style.css"].includes(path)) {
        response.setHeader("Content-Type", path === "/" ? "text/html; charset=utf-8" :
          path === "/app.js" ? "text/javascript; charset=utf-8" : "text/css; charset=utf-8");
        response.end(path === "/" ? html.replace("CSRF_PLACEHOLDER", csrf) : path === "/app.js" ? script : css);
        return;
      }
      if (request.headers["x-local-csrf"] !== csrf) {
        reply(403, { error: "Local page token is missing or outdated. Refresh this page after restarting the server.", code: "reload-required" }); return;
      }
      if (request.method === "GET" && path === "/api/session") {
        const status = await auth.status();
        reply(200, {
          mode: api.config.mode, liveEnabled: true, paymentsEnabled: api.config.allowPayments,
          authenticated: Boolean(await api.session.token()), appVersion: api.config.appVersion,
          userAgent: api.config.userAgent, fcmConfigured: Boolean(api.config.fcmToken),
          auth: status, debugEnabled: api.config.debug
        }); return;
      }
      if (request.method === "GET" && path === "/api/diagnostics") {
        reply(200, { enabled: api.config.debug, traces: api.diagnostics.list() }); return;
      }
      if (request.method === "GET" && path === "/api/tickets") { reply(200, await workflow.list()); return; }
      if (request.method === "GET" && path === "/api/catalog") { reply(200, await localCatalog(api.config)); return; }
      if (request.method !== "POST") { reply(404, { error: "Route not found" }); return; }
      const body = await jsonInput(request);
      let result: unknown;
      switch (path) {
        case "/api/auth/options": {
          const value = z.object({ phone: z.string() }).strict().parse(body);
          result = { options: await auth.options(value.phone) }; break;
        }
        case "/api/auth/start": result = await auth.begin(body); break;
        case "/api/auth/verify": {
          const value = z.object({ code: z.string() }).strict().parse(body);
          result = await auth.verify(value.code); break;
        }
        case "/api/auth/cancel": result = await auth.cancel(); break;
        case "/api/auth/validate": result = await api.validateSession(); break;
        case "/api/auth/logout": result = await auth.logout(); break;
        case "/api/build": result = buildMoneyBody(body, api.config.appVersion); break;
        case "/api/review": result = await workflow.reviewMoney(body); break;
        case "/api/airtime/prepare": result = await workflow.prepareAirtime(body); break;
        case "/api/bundle/prepare": result = await workflow.prepareBundle(body); break;
        case "/api/submit": {
          const value = z.object({ ticket: z.string().uuid(), confirmation: z.string(), pin: z.string().optional() }).strict().parse(body);
          const submitted = await workflow.submit(value.ticket, value.confirmation, value.pin);
          result = { ...submitted, navigation: submitted.paymentLink
            ? { href: submitted.paymentLink, warning: "External allowlisted host; navigation is not proof of payment" }
            : { warning: "No allowlisted payment link. Verify returned host independently before enabling it." } };
          break;
        }
        case "/api/check": {
          const value = z.object({ id: z.string() }).strict().parse(body);
          const checked = await api.checkPayment(value.id);
          result = { ...checked, observation: paymentObservation(checked, value.id) }; break;
        }
        case "/api/watch": {
          const value = z.object({
            id: z.string(), attempts: z.number().int().min(1).max(12).optional()
          }).strict().parse(body);
          const abort = new AbortController();
          const closed = () => abort.abort();
          response.once("close", closed);
          try { result = await pollPayment(api, value.id, { attempts: value.attempts, signal: abort.signal }); }
          finally { response.off("close", closed); }
          break;
        }
        case "/api/fees": {
          const value = z.object({ provider: z.string(), amount: z.number() }).strict().parse(body);
          const fees = await api.withdrawalFees();
          result = { ...fees, calculation: estimateWithdrawal(fees.body.data, value.provider, value.amount) }; break;
        }
        case "/api/promotions": result = await api.promotions(); break;
        case "/api/service-status": result = await api.serviceStatus(); break;
        default: reply(404, { error: "Route not found" }); return;
      }
      reply(200, result);
    } catch (error) {
      const status = error instanceof ApiError ?
        ["session-required", "session-rejected"].includes(error.code) ? 401 :
          ["same-network-transfer", "receiver-name-required"].includes(error.code) ? 422 : 502 : error instanceof ZodError ? 400 : 400;
      if (!response.destroyed) reply(status, {
        error: errorMessage(error), upstreamStatus: error instanceof ApiError ? error.httpStatus : undefined,
        code: error instanceof ApiError ? error.code : "invalid-input",
        outcomeUnknown: error instanceof ApiError ? error.outcomeUnknown : false
      });
    }
  });
  server.requestTimeout = 30000;
  server.headersTimeout = 10000;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(api.config.port, "127.0.0.1", () => { server.off("error", reject); resolve(); });
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close(); throw new Error("Unexpected listening address");
  }
  origin = `http://127.0.0.1:${address.port}`;
  return { server, url: origin };
}
