#!/usr/bin/env node
import { Command } from "commander";
import { confirm, input, password, select } from "@inquirer/prompts";
import { z } from "zod";
import { join } from "node:path";
import { ApiClient, ApiError } from "./api.js";
import { loadConfig, loadEnvironment } from "./config.js";
import { Workflow } from "./workflow.js";
import { buildMoneyBody, requiresReceiverName } from "./models.js";
import { errorMessage, redact } from "./presentation.js";
import { importCatalog, localCatalog, readJsonFile } from "./catalogs.js";
import { estimateWithdrawal } from "./fees.js";
import { startWeb } from "./web.js";
import { readPrivate, writePrivate } from "./storage.js";
import { objectData } from "./models.js";
import { AuthWorkflow } from "./auth.js";
import { pollPayment } from "./lifecycle.js";

const print = (value: unknown) => console.log(JSON.stringify(redact(value), null, 2));
async function main(): Promise<void> {
  if (!await loadEnvironment()) console.error("No .env found in the current directory; using process environment and live-only defaults.");
  const config = loadConfig();
  const api = new ApiClient(config);
  const workflow = new Workflow(api);
  const authentication = new AuthWorkflow(api);
  const program = new Command().name("switchn").description("Unofficial live-only Switchn client. Sign-in sends real challenges; payments require confirmation.")
    .version("0.1.0");

  const auth = program.command("auth").description("Authorized token import/acquisition; no provider-login bypass");
  auth.command("status").action(async () => print({ mode: config.mode, ...await authentication.status() }));
  auth.command("validate").description("Validate the current bearer with protected GET /my-funds")
    .action(async () => print(await api.validateSession()));
  auth.command("start <phone>").option("--transport <transport>", "sms or whatsapp", "sms")
    .description("Request a real phone verification challenge; never submits a payment")
    .action(async (phone: string, options: { transport: string }) =>
      print(await authentication.begin({ phone, transport: options.transport })));
  auth.command("verify").description("Enter a code privately, then acquire and validate a bearer")
    .action(async () => {
      if (!process.stdin.isTTY) throw new Error("Code entry requires a terminal; use the local dashboard for guided sign-in.");
      print(await authentication.verify(await password({ message: "Verification code received on your phone:" })));
    });
  auth.command("cancel").description("Forget only the local challenge; does not revoke a code already sent")
    .action(async () => print(await authentication.cancel()));
  async function bootstrap(): Promise<void> {
    if (!process.stdin.isTTY) throw new Error("Sign-in prompts require a terminal. Use auth start / auth verify or the dashboard.");
    let state = await authentication.status();
    if (state.session.tokenPresent && state.session.state !== "rejected") {
      try { print(await api.validateSession()); return; }
      catch (error) {
        if (!(error instanceof ApiError) || error.code !== "session-rejected") throw error;
        console.error(error.message);
        state = await authentication.status();
      }
    }
    if (config.envToken) throw new Error("Unset the rejected SWITCHN_BEARER_TOKEN before phone sign-in.");
    if (state.challenge && (state.challenge.expired || state.challenge.phase !== "awaiting-otp")) {
      throw new Error("Existing sign-in cannot be resumed. Inspect auth status; explicitly auth cancel before starting again.");
    }
    let current = state;
    if (!state.challenge) {
      const phone = await input({ message: "Your Switchn phone number:" });
      const choices = (await authentication.options(phone)).filter(v => ["otp_sms", "otp_whatsapp"].includes(v));
      if (!choices.length) throw new Error("No supported phone-verification transport offered; use the official app.");
      const choice = await select<string>({ message: "Receive a sign-in code via", choices });
      current = await authentication.begin({ phone, transport: choice.slice(4) });
    }
    if (current.challenge?.phase === "awaiting-otp") {
      current = await authentication.verify(await password({ message: "Verification code received on your phone:" }));
    }
    print(current);
  }
  auth.command("bootstrap").description("Check a session or prompt for phone sign-in; no payment is executed")
    .action(bootstrap);
  auth.command("import").description("Prompt for your own bearer token without shell history exposure")
    .action(async () => {
      if (!process.stdin.isTTY) throw new Error("Token import requires a terminal. For automation use SWITCHN_BEARER_TOKEN.");
      const token = await password({ message: "Your authorized bearer token (hidden):" });
      await api.session.save(token);
      print({ saved: true, mode: config.mode });
    });
  auth.command("logout").action(async () => {
    print(await authentication.logout());
  });
  auth.command("login <kind> <file>").description("device or google token exchange; body from a private JSON file")
    .action(async (kind: string, file: string) => {
      print(await api.login(z.enum(["device", "google"]).parse(kind), await readJsonFile(file)));
    });
  auth.command("options <phone>").action(async (phone: string) => print(await api.loginOptions(phone)));
  auth.command("otp-create <file>").description("May send a real SMS in live mode; use your own number")
    .action(async (file: string) => {
      const result = await api.createOtp(await readJsonFile(file));
      const url = z.string().url().parse(objectData(result.body.data).validate_url);
      await writePrivate(config.dataDir, "otp-challenge.json", { url });
      print(result);
      console.error("Validation URL saved privately. Continue with auth otp-verify <file>. OTP verification is not a bearer token.");
    });
  auth.command("otp-verify <file>").description("Validate the last privately saved challenge; no automatic resend")
    .action(async (file: string) => {
      const challenge = z.object({ url: z.string().url() }).strict().parse(
        await readPrivate(join(config.dataDir, "otp-challenge.json")));
      print(await api.validateOtp(challenge.url, await readJsonFile(file)));
    });
  auth.command("otp-validate <url> <file>").description("Only a returned Switchn /otps/ URL is accepted")
    .action(async (url: string, file: string) => print(await api.validateOtp(url, await readJsonFile(file))));

  const transfers = program.command("transfer");
  transfers.command("build <file>").description("Validate/build a payload without any network request")
    .action(async (file: string) => print(buildMoneyBody(await readJsonFile(file), config.appVersion)));
  transfers.command("review <file>").description("Fetch a quote and create a single-use local confirmation ticket")
    .action(async (file: string) => print(await workflow.reviewMoney(await readJsonFile(file))));
  transfers.command("check <paymentRequestId>").description("POST payment-check; use the payment-request ID, not transfer ID")
    .action(async (id: string) => print(await api.checkPayment(id)));
  transfers.command("watch <paymentRequestId>").description("Bounded checks only; never initiates or retries a payment")
    .option("--attempts <count>", "1-12 checks, 5 seconds between pending responses", "12")
    .action(async (id: string, options: { attempts: string }) => print(await pollPayment(api, id, {
      attempts: Number(options.attempts), onUpdate: update => console.error(JSON.stringify(update))
    })));
  transfers.command("interactive").description("Guided carrier/amount selection, review, then optional submission")
    .action(async () => {
      if (!process.stdin.isTTY) throw new Error("Interactive transfer requires a terminal");
      await bootstrap();
      const fromCarrier = await select<string>({ message: "Payer source", choices: [
        { name: "MTN MoMo", value: "MTN Cameroon" }, { name: "Orange Money", value: "Orange" },
        { name: "Internal wallet", value: "wallet:funds" }
      ] });
      const from = fromCarrier === "wallet:funds" ? fromCarrier : await input({ message: "Payer phone:" });
      const to = await input({ message: "Recipient phone:" });
      const toCarrier = await select<string>({ message: "Recipient carrier", choices: ["MTN Cameroon", "Orange"] });
      const nameRequired = requiresReceiverName(fromCarrier === "wallet:funds" ? undefined : fromCarrier, toCarrier);
      const receiverName = (await input({
        message: `Recipient's registered Mobile Money account name (${nameRequired ? "required" : "optional for this route"}):`,
        validate: value => nameRequired && !value.trim() ? "Enter the exact registered name supplied by the recipient."
          : value.trim().length > 256 ? "Account name must be at most 256 characters." : true
      })).trim();
      const amount = Number(await input({ message: "Amount (integer, in backend units):" }));
      const paymentMethod = await select({ message: "Payment method", choices: ["ussd_pay", "web_pay", "merchant_pay"] });
      const ticket = await workflow.reviewMoney({
        from, to, amount, from_carrier: fromCarrier === "wallet:funds" ? undefined : fromCarrier,
        to_carrier: toCarrier, payment_method: paymentMethod,
        inputted_receiver_name: receiverName || undefined,
        transaction_reference: await input({ message: "Reference (optional):" })
      });
      print(ticket);
      if (await confirm({ message: `Continue with this ${config.mode.toUpperCase()} submission?`, default: false })) {
        await submit(ticket.id, {});
      }
    });

  async function submit(id: string, options: { confirm?: string; pin?: boolean }): Promise<void> {
    const ticket = await workflow.get(id);
    console.error(JSON.stringify(redact({
      mode: config.mode, action: ticket.action, review: ticket.review, expiresAt: new Date(ticket.expiresAt).toISOString()
    }), null, 2));
    if (!options.confirm && !process.stdin.isTTY) throw new Error(`Use --confirm '${ticket.confirmation}' after inspecting this exact ticket.`);
    const phrase = options.confirm ?? await input({ message: `Type exactly: ${ticket.confirmation}` });
    if (options.pin && !process.stdin.isTTY) throw new Error("PIN entry requires a terminal; do not put a PIN in shell arguments");
    const pin = options.pin ? await password({ message: "Transaction PIN (hidden, never persisted):" }) : undefined;
    const result = await workflow.submit(id, phrase, pin);
    print(result);
    console.error("Submitted does not mean paid. Check the returned payment-request ID; never infer completion from a redirect.");
  }
  program.command("submit <ticket>").description("Confirm and submit money, airtime or bundle ticket exactly once")
    .option("--confirm <phrase>", "Exact ticket-specific confirmation phrase for automation")
    .option("--pin", "Prompt for optional transaction PIN")
    .action(submit);
  program.command("tickets").action(async () => print(await workflow.list()));
  const airtime = program.command("airtime");
  airtime.command("prepare <file>").action(async (file: string) => print(await workflow.prepareAirtime(await readJsonFile(file))));
  const bundles = program.command("bundles");
  bundles.command("prepare <promotion> <phone>").action(async (promotion: string, phone: string) =>
    print(await workflow.prepareBundle({ promotion, phone })));
  bundles.command("remote").action(async () => print(await api.promotions()));
  bundles.command("import <file>").action(async (file: string) => print({ imported: await importCatalog(config, file) }));
  bundles.command("local").action(async () => print(await localCatalog(config)));
  program.command("fees <provider> <amount>").description("Display withdrawal estimate; provider is mtn_mobile_money or orange_money")
    .action(async (provider: string, amount: string) => {
      const result = await api.withdrawalFees();
      print({ mode: config.mode, ...estimateWithdrawal(result.body.data, provider, Number(amount)), tables: result.body.data });
    });
  program.command("cross-fees").action(async () => print(await api.crossNetworkFees()));
  program.command("lookup <kind> <phone>").action(async (kind: string, phone: string) =>
    print(await api.lookup(phone, z.enum(["carrier", "name"]).parse(kind))));
  program.command("service-status").action(async () => print(await api.serviceStatus()));
  program.command("payment-config").action(async () => print(await api.paymentConfig()));
  program.command("web").description("Start loopback-only dashboard").action(async () => {
    const running = await startWeb(api, workflow);
    console.log(`Dashboard: ${running.url} (${config.mode.toUpperCase()})`);
    const stop = () => running.server.close(() => process.exit(0));
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
  try { await program.parseAsync(process.argv); }
  finally {
    if (config.debug && api.diagnostics.list().length) console.error(JSON.stringify({ diagnostics: api.diagnostics.list() }, null, 2));
  }
}
main().catch(error => {
  console.error(errorMessage(error));
  process.exitCode = 1;
});
