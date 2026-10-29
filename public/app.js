const csrf = document.querySelector('meta[name="local-csrf"]').content;
const output = document.querySelector("#output");
const errorBox = document.querySelector("#error");
const submission = document.querySelector("#submission");
const send = document.querySelector("#send");
const transfer = document.querySelector("#transfer");
const accepted = document.querySelector("#accepted");
const quoteMessage = document.querySelector("#quote-message");
const paymentMessage = document.querySelector("#payment-message");
let busy = false;
let session;
let ticket;
let revision = 0;
let watcher;

function canConnect() {
  return Boolean(session?.authenticated);
}
function controls() {
  const wallet = transfer.elements.from_carrier.value === "wallet:funds";
  transfer.elements.inputted_receiver_name.required = wallet ||
    transfer.elements.from_carrier.value !== transfer.elements.to_carrier.value;
  document.querySelector("#funding-message").textContent = wallet
    ? "Internal wallet spends your Switchn wallet balance, not your MTN/Orange phone balance. It does not request an operator USSD prompt."
    : "This charges the selected MTN/Orange phone balance. Choose Operator / USSD approval to request a phone prompt if the provider supports it.";
  document.querySelector("#payment-permission").textContent = session && !session.paymentsEnabled
    ? "Payment submission is disabled in server configuration. You can review fees, but sending requires SWITCHN_ALLOW_PAYMENTS=true and a server restart."
    : "";
  document.querySelector("#review").disabled = busy || !canConnect();
  const ready = ticket?.state === "ready" && ticket.expiresAt > Date.now();
  accepted.disabled = busy || !ready;
  send.disabled = busy || !ready || !accepted.checked || !canConnect() ||
    !session?.paymentsEnabled;
  const enabled = Boolean(session);
  document.querySelector("#signin-start").disabled = busy || !enabled || !session?.auth.bootstrapConfigured || Boolean(session?.auth.challenge);
  document.querySelector("#signin-options").disabled = busy || !enabled;
  document.querySelector("#validate-session").disabled = busy || !canConnect();
  document.querySelector("#cancel-signin").disabled = busy || !session?.auth.challenge;
  document.querySelector("#logout").disabled = busy || !enabled;
  document.querySelector("#verify button").disabled = busy || !enabled || session?.auth.challenge?.expired;
  document.querySelector("#watch").disabled = busy || !canConnect();
  document.querySelector("#stop-watch").disabled = !watcher;
  if (ticket && ticket.expiresAt <= Date.now()) {
    quoteMessage.textContent = "This review expired. Request a fresh review before continuing.";
  }
}
function invalidate() {
  revision++;
  if (ticket) quoteMessage.textContent = "Details changed. Review the amount and fees again.";
  ticket = undefined;
  accepted.checked = false;
  submission.elements.pin.value = "";
  document.querySelector("#quote-fields").replaceChildren();
  document.querySelector("#quote-alerts").replaceChildren();
  controls();
}
async function request(path, body, signal) {
  const response = await fetch(path, {
    method: body === undefined ? "GET" : "POST",
    headers: { "X-Local-CSRF": csrf, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body), signal
  });
  const value = await response.json();
  if (!response.ok) {
    if (["session-required", "session-rejected", "session-changed"].includes(value.code)) invalidate();
    if (path === "/api/review" && value.code === "receiver-name-required") {
      transfer.elements.inputted_receiver_name.focus();
    }
    throw new Error(`${value.error || `Local HTTP ${response.status}`}${value.code ? ` (${value.code})` : ""}`);
  }
  return value;
}
async function run(action) {
  if (busy) return;
  busy = true;
  controls();
  errorBox.textContent = "";
  try {
    const value = await action();
    output.textContent = JSON.stringify(value, null, 2);
    return value;
  } catch (error) {
    errorBox.textContent = error.message || "Request failed";
    output.textContent = JSON.stringify({ error: errorBox.textContent }, null, 2);
  } finally {
    try { await refreshSession(); }
    catch (error) { errorBox.textContent += ` Session display could not refresh: ${error.message}`; }
    busy = false;
    controls();
  }
}
function showQuote(value) {
  ticket = value;
  accepted.checked = false;
  submission.elements.pin.value = "";
  const body = value.action.body;
  const fields = value.action.kind === "money" ? [
    ["From", body.from], ["To", body.to],
    ["Registered name you entered", body.inputted_receiver_name ?? "Not provided"],
    ["Backend recipient name", value.review?.to_name ?? "Not returned"],
    ["Amount before fees", body.amount_before_fees], ["Amount after fees", body.amount_after_fees],
    ["Transfer fee", body.transaction_specific_fee], ["Cash-out fee", body.transaction_specific_cash_out_fee],
    ["Payment method", body.from === "wallet:funds" ? "Internal wallet (no operator prompt)" : body.payment_method],
    ["Provider route", value.preflight?.providerMethodCode ?? "Not returned"]
  ] : value.action.kind === "airtime" ? [
    ["Purchase", "Airtime"], ["Payer", body.payer], ["Recipient", body.to], ["Amount", body.amount],
    ["Pricing", "Local preparation only; not a server quote"]
  ] : [
    ["Purchase", "Bundle activation"], ["Promotion", body.promotion], ["Recipient", body.phone],
    ["Pricing", "Confirm the current catalog price; not a price lock"]
  ];
  const list = document.querySelector("#quote-fields");
  list.replaceChildren();
  for (const [label, amount] of fields) {
    const term = document.createElement("dt");
    const detail = document.createElement("dd");
    term.textContent = label;
    detail.textContent = String(amount ?? "Not returned");
    list.append(term, detail);
  }
  const alerts = document.querySelector("#quote-alerts");
  alerts.replaceChildren();
  for (const alert of value.review?.alerts ?? []) {
    const item = document.createElement("p");
    item.textContent = typeof alert === "string" ? alert : typeof alert?.message === "string"
      ? alert.message : JSON.stringify(alert);
    alerts.append(item);
  }
  quoteMessage.textContent = "Live backend quote. Check every detail. Only your next confirmation can submit this request.";
  controls();
}
async function prepare(action) {
  if (busy) return;
  if (!session) {
    errorBox.textContent = "Wait for the local session status before preparing a request.";
    return;
  }
  invalidate();
  const startedAt = revision;
  quoteMessage.textContent = "Validating session, carrier availability and payment method, then requesting fees...";
  const value = await run(action);
  if (!value) {
    quoteMessage.textContent = `Review failed. Nothing was submitted. ${errorBox.textContent}`;
    return;
  }
  if (startedAt !== revision) {
    quoteMessage.textContent = "Details changed while reviewing. Request a new review.";
    return;
  }
  showQuote(value);
}
function draft() {
  const data = Object.fromEntries(new FormData(transfer));
  data.amount = Number(data.amount);
  data.lang = "en";
  if (!data.inputted_receiver_name) delete data.inputted_receiver_name;
  if (data.from_carrier === "wallet:funds") {
    data.from = "wallet:funds";
    delete data.from_carrier;
  }
  return data;
}
for (const form of [transfer, document.querySelector("#airtime"), document.querySelector("#bundle")]) {
  form.addEventListener("input", invalidate);
  form.addEventListener("change", invalidate);
}
transfer.elements.from_carrier.addEventListener("change", () => {
  const wallet = transfer.elements.from_carrier.value === "wallet:funds";
  transfer.elements.from.disabled = wallet;
  transfer.elements.from.required = !wallet;
});
accepted.onchange = controls;
document.querySelector("#build").onclick = () => {
  if (!transfer.reportValidity()) return;
  document.querySelector("#advanced").open = true;
  run(() => request("/api/build", draft()));
};
transfer.onsubmit = event => {
  event.preventDefault();
  prepare(() => request("/api/review", draft()));
};
submission.onsubmit = async event => {
  event.preventDefault();
  controls();
  if (send.disabled || !ticket) return;
  const pending = ticket;
  const pin = submission.elements.pin.value;
  ticket = undefined;
  accepted.checked = false;
  submission.elements.pin.value = "";
  document.querySelector("#navigation").replaceChildren();
  document.querySelector("#status").elements.id.value = "";
  quoteMessage.textContent = "Submitting once. Do not submit a second request if the result is uncertain.";
  const value = await run(() => request("/api/submit", {
    ticket: pending.id, confirmation: pending.confirmation, ...(pin ? { pin } : {})
  }));
  if (!value) {
    quoteMessage.textContent = "Submission did not return a confirmed acknowledgement. Do not retry blindly.";
    paymentMessage.textContent = "The outcome may be unknown. Check the official account history before creating another request.";
    return;
  }
  quoteMessage.textContent = "Request submitted to Switchn. This does not mean paid.";
  const data = value.response?.body?.data;
  const ids = Array.isArray(data?.payment_requests) ? data.payment_requests
    .map(item => item?.id).filter(id => /^(?:[1-9]\d*)$/.test(String(id))) : [];
  if (ids.length === 1) document.querySelector("#status").elements.id.value = String(ids[0]);
  paymentMessage.textContent = "Follow any provider instructions on your phone or the payment page. We cannot confirm that a prompt was sent. Check the payment status.";
  if (ids.length !== 1) {
    paymentMessage.textContent += ids.length > 1
      ? " Multiple payment-request IDs were returned; choose the appropriate ID from technical details."
      : " No payment-request ID was identified; consult the official account history instead of guessing an ID.";
  }
  const nav = document.querySelector("#navigation");
  if (value.navigation?.href) {
    const link = document.createElement("a");
    link.href = value.navigation.href;
    link.textContent = `Open payment page: ${new URL(link.href).hostname}`;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    nav.append(link);
  }
  if (ids.length === 1 && document.querySelector("#auto-watch").checked) await watchPayment();
};
document.querySelector("#status").onsubmit = async event => {
  event.preventDefault();
  const value = await run(() => request("/api/check", Object.fromEntries(new FormData(event.target))));
  if (value) {
    paymentMessage.textContent = value.observation.message +
      (value.observation.rawStatus ? ` Status: ${value.observation.rawStatus}.` : "");
  }
};
document.querySelector("#fees").onsubmit = event => {
  event.preventDefault();
  const value = Object.fromEntries(new FormData(event.target));
  value.amount = Number(value.amount);
  run(() => request("/api/fees", value));
};
document.querySelector("#airtime").onsubmit = event => {
  event.preventDefault();
  prepare(() => {
    let body;
    try { body = JSON.parse(event.target.elements.body.value); }
    catch { throw new Error("Airtime input must be strict JSON"); }
    return request("/api/airtime/prepare", body);
  });
};
document.querySelector("#bundle").onsubmit = event => {
  event.preventDefault();
  prepare(() => request("/api/bundle/prepare", Object.fromEntries(new FormData(event.target))));
};
document.querySelector("#catalog").onclick = () => run(() => request("/api/catalog"));
document.querySelector("#promotions").onclick = () => run(() => request("/api/promotions", {}));
document.querySelector("#availability").onclick = () => run(() => request("/api/service-status", {}));
document.querySelector("#history").onclick = () => run(() => request("/api/tickets"));
document.querySelector("#diagnostics").onclick = () => run(() => request("/api/diagnostics"));

async function watchPayment() {
  const form = document.querySelector("#status");
  if (busy || !form.reportValidity()) return;
  watcher = new AbortController();
  paymentMessage.textContent = "Checking payment status periodically. Stopping this monitor will not cancel the payment.";
  const value = await run(() => request("/api/watch", {
    id: form.elements.id.value, attempts: 12
  }, watcher.signal));
  const cancelled = watcher.signal.aborted;
  watcher = undefined;
  if (value) paymentMessage.textContent = value.message +
    (value.exhausted ? " Local polling limit reached; payment may still be pending. Do not resubmit." : "");
  else paymentMessage.textContent = cancelled
    ? "Monitoring stopped locally. The payment was not cancelled; check official history."
    : "Monitoring failed. The payment outcome remains unconfirmed; inspect diagnostics and official history.";
  controls();
}
document.querySelector("#watch").onclick = watchPayment;
document.querySelector("#stop-watch").onclick = () => watcher?.abort();

document.querySelector("#signin").onsubmit = async event => {
  event.preventDefault();
  invalidate();
  await run(() => request("/api/auth/start", Object.fromEntries(new FormData(event.target))));
};
document.querySelector("#signin-options").onclick = () => {
  const phone = document.querySelector("#signin").elements.phone.value;
  run(async () => {
    const value = await request("/api/auth/options", { phone });
    const select = document.querySelector("#signin").elements.transport;
    for (const option of select.options) option.disabled = !value.options.includes(`otp_${option.value}`);
    const first = [...select.options].find(option => !option.disabled);
    if (first) select.value = first.value;
    return value;
  });
};
document.querySelector("#verify").onsubmit = async event => {
  event.preventDefault();
  const code = event.target.elements.code.value;
  event.target.elements.code.value = "";
  invalidate();
  await run(() => request("/api/auth/verify", { code }));
};
document.querySelector("#validate-session").onclick = () => run(() => request("/api/auth/validate", {}));
document.querySelector("#cancel-signin").onclick = () => run(() => request("/api/auth/cancel", {}));
document.querySelector("#logout").onclick = () => {
  invalidate();
  run(() => request("/api/auth/logout", {}));
};

async function refreshSession() {
  let value;
  try {
    value = await request("/api/session");
    if (value.mode !== "live" || !value.auth) {
      throw new Error("This server is outdated. Restart it from the updated project and refresh this page.");
    }
  } catch (error) {
    session = undefined;
    invalidate();
    document.querySelector("#session").textContent = "Local server unavailable or outdated. Restart the server and refresh this page.";
    document.querySelector("#session").className = "notice";
    throw error;
  }
  session = value;
  const status = value.auth.session;
  const challenge = value.auth.challenge;
  document.querySelector("#verify").hidden = challenge?.phase !== "awaiting-otp" || challenge.expired;
  document.querySelector("#auth-message").textContent = challenge
    ? `${challenge.expired ? "Expired" : challenge.phase} sign-in challenge. ${challenge.phase === "awaiting-otp" && !challenge.expired
      ? "Switchn accepted the challenge request. Enter the code received for this sign-in; delivery is not yet confirmed." : "Cancel locally before starting again; no automatic resend."}`
    : status.state === "validated" ? `Session accepted at ${status.checkedAt}. It will be rechecked before review and payment.`
    : status.state === "rejected" ? "Session rejected by the backend. Sign in again; no payment will be replayed."
    : status.state === "unverified" ? "A bearer is present but has not been validated. Check it or request a review."
    : value.auth.bootstrapConfigured ? "Sign in with your own phone before reviewing a transfer."
    : "Phone sign-in is not configured. Set the authorized Firebase project key on the server, or import your own bearer in the terminal.";
  const badge = document.querySelector("#session");
  const missing = [];
  if (!session.authenticated) missing.push("a valid session");
  if (!session.paymentsEnabled) missing.push("payment permission");
  badge.textContent = "LIVE BACKEND - sign-in requests contact Firebase and Switchn. " +
    (missing.length ? `Payments blocked: missing ${missing.join(", ")}.`
      : "Confirmed submissions can move real money.");
  badge.className = "live";
  controls();
}
refreshSession().catch(error => { errorBox.textContent = error.message; controls(); });
setInterval(controls, 1000);
