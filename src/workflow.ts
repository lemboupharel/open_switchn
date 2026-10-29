import { randomUUID } from "node:crypto";
import { open, readdir } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { ApiClient, type ApiResult } from "./api.js";
import { requirePayment, safePaymentLink } from "./config.js";
import { airtimeBody, buildMoneyBody, moneyBody, objectData, reviewData } from "./models.js";
import { privateDirectory, readPrivate, writePrivate } from "./storage.js";
import { redact } from "./presentation.js";
import { activeIdentity, preflight, sameIdentity } from "./lifecycle.js";

export const bundleBody = z.object({
  promotion: z.string().regex(/^[a-zA-Z0-9+_-]{1,128}$/),
  phone: z.string().regex(/^[a-zA-Z0-9+_-]{1,128}$/)
}).strict();
const action = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("money"), body: moneyBody }),
  z.object({ kind: z.literal("airtime"), body: airtimeBody }),
  z.object({ kind: z.literal("bundle"), body: bundleBody })
]);
const ticketSchema = z.object({
  id: z.string().uuid(), mode: z.literal("live"),
  createdAt: z.number(), expiresAt: z.number(), confirmation: z.string(),
  state: z.enum(["ready", "outcome-unknown", "submitted"]),
  sessionFingerprint: z.string().optional(), preflight: z.unknown().optional(),
  action, review: z.unknown().optional(), result: z.unknown().optional()
}).strict();
export type Ticket = z.infer<typeof ticketSchema>;
export class Workflow {
  constructor(readonly api: ApiClient, private readonly clock = Date.now) {}
  private get directory(): string { return join(this.api.config.dataDir, "tickets"); }
  private async prepare(value: z.infer<typeof action>, review?: unknown, checked?: Awaited<ReturnType<typeof preflight>>): Promise<Ticket> {
    const id = randomUUID();
    const ticket: Ticket = {
      id, mode: this.api.config.mode, createdAt: this.clock(), expiresAt: this.clock() + 300_000,
      confirmation: `CONFIRM ${id}`, state: "ready", action: value, review: redact(review),
      sessionFingerprint: checked?.fingerprint ?? await activeIdentity(this.api), preflight: checked
    };
    await writePrivate(this.directory, `${id}.json`, ticket);
    return ticket;
  }
  async reviewMoney(draft: unknown): Promise<Ticket> {
    const body = buildMoneyBody(draft, this.api.config.appVersion);
    const checked = await preflight(this.api, body);
    const result = await this.api.reviewMoney(body);
    const review = reviewData.parse(result.body.data);
    if (review.name_match === false) throw new Error("Recipient name mismatch: resolve it in the official flow before proceeding");
    const reviewed = moneyBody.parse({
      ...body, from: review.from, to: review.to,
      from_carrier: review.from_carrier ?? body.from_carrier,
      to_carrier: review.to_carrier ?? body.to_carrier,
      amount_before_fees: review.amount_before_fees,
      amount_after_fees: review.amount_after_fees,
      transaction_specific_fee: review.transaction_specific_fee,
      transaction_specific_cash_out_fee: review.transaction_specific_cash_out_fee,
      inputted_receiver_name: review.inputted_receiver_name ?? body.inputted_receiver_name
    });
    await sameIdentity(this.api, checked.fingerprint);
    return this.prepare({ kind: "money", body: reviewed }, review, checked);
  }
  async prepareAirtime(input: unknown): Promise<Ticket> {
    const body = airtimeBody.parse(input);
    if (body.pin) throw new Error("Supply PIN only at confirmation; it must not be stored in a ticket");
    delete body.pin;
    await this.api.validateSession();
    return this.prepare({ kind: "airtime", body });
  }
  async prepareBundle(input: unknown): Promise<Ticket> {
    await this.api.validateSession();
    return this.prepare({ kind: "bundle", body: bundleBody.parse(input) });
  }
  async get(id: string): Promise<Ticket> {
    z.string().uuid().parse(id);
    const stored = await readPrivate(join(this.directory, `${id}.json`));
    if (stored === undefined) throw new Error("Ticket not found in this mode");
    const ticket = ticketSchema.parse(stored);
    if (ticket.mode !== this.api.config.mode || ticket.id !== id) throw new Error("Ticket identity mismatch");
    return ticket;
  }
  async list(): Promise<Ticket[]> {
    await privateDirectory(this.directory);
    const names = await readdir(this.directory);
    const tickets: Ticket[] = [];
    for (const name of names.filter(n => n.endsWith(".json"))) {
      tickets.push(await this.get(name.slice(0, -5)));
    }
    return tickets.sort((a, b) => b.createdAt - a.createdAt).slice(0, 100);
  }
  async submit(id: string, confirmation: string, pin?: string): Promise<{ ticket: Ticket; response: ApiResult; paymentLink?: string }> {
    const ticket = await this.get(id);
    requirePayment(this.api.config);
    if (ticket.state !== "ready") throw new Error("Ticket already attempted. Check payment status; never blindly resubmit.");
    if (ticket.expiresAt <= this.clock()) throw new Error("Local review expired; obtain a new review");
    if (confirmation !== ticket.confirmation) throw new Error("Confirmation phrase does not match the reviewed ticket");
    if (pin !== undefined) z.string().min(1).max(256).parse(pin);
    if (ticket.action.kind === "bundle" && pin) throw new Error("Bundle activation has no recovered PIN body field");
    if (!ticket.sessionFingerprint) throw new Error("Ticket predates session binding. Obtain a fresh review.");
    await sameIdentity(this.api, ticket.sessionFingerprint);
    if (ticket.action.kind === "money") {
      const reviewedRoute = z.object({ providerMethodCode: z.string() }).safeParse(ticket.preflight);
      if (!reviewedRoute.success) throw new Error("Ticket predates provider route validation. Obtain a fresh review.");
      const checked = await preflight(this.api, ticket.action.body);
      if (checked.providerMethodCode !== reviewedRoute.data.providerMethodCode) {
        throw new Error("Provider payment route changed since review. Obtain a fresh review before confirming.");
      }
    } else await this.api.validateSession();
    await sameIdentity(this.api, ticket.sessionFingerprint);
    if (ticket.expiresAt <= this.clock()) throw new Error("Local review expired during preflight; obtain a new review");
    let lock;
    try { lock = await open(join(this.directory, `${id}.attempted`), "wx", 0o600); }
    catch (error) {
      if (error instanceof Error && "code" in error && error.code === "EEXIST") {
        throw new Error("Ticket has already been claimed by a submission; inspect status before any new payment");
      }
      throw error;
    }
    // Keep this marker permanently: an interrupted POST is not safe to repeat.
    await lock.close();
    ticket.state = "outcome-unknown";
    await writePrivate(this.directory, `${id}.json`, ticket);
    let response: ApiResult;
    switch (ticket.action.kind) {
      case "money":
        response = await this.api.initiateMoney({ ...ticket.action.body, ...(pin ? { pin } : {}) }, ticket.sessionFingerprint);
        break;
      case "airtime":
        response = await this.api.buyAirtime({ ...ticket.action.body, ...(pin ? { pin } : {}) }, ticket.sessionFingerprint);
        break;
      case "bundle":
        response = await this.api.activateBundle(ticket.action.body.promotion, ticket.action.body.phone, ticket.sessionFingerprint);
        break;
    }
    const data = objectData(response.body.data);
    if (ticket.action.kind !== "bundle") {
      z.union([z.number().int().positive().max(Number.MAX_SAFE_INTEGER), z.string().regex(/^[1-9]\d*$/)]).parse(data.id);
    }
    // Submission acknowledgement is not proof of settlement.
    ticket.state = "submitted";
    ticket.result = redact(response);
    await writePrivate(this.directory, `${id}.json`, ticket);
    const link = safePaymentLink(data.payment_link, this.api.config);
    return { ticket, response, paymentLink: link };
  }
}
