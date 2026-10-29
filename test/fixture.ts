import type { Fetcher } from "../src/api.js";
import { moneyBody, objectData, reviewData } from "../src/models.js";

export const sameNetworkRejection = {
  message: "The payer and receiver use the same network. Please transfer directly using your mobile money service.",
  errors: { to: ["The payer and receiver use the same network. Please transfer directly using your mobile money service."] }
};

export const receiverNameRejection = {
  message: "Enter the receiver\u2019s Mobile Money account name. Already entered or no field? Update Switchn, then try again.",
  errors: { inputted_receiver_name: ["Enter the receiver's registered Mobile Money account name."] }
};

export const fixtureIdentity: Fetcher = async url => {
  if (url.origin !== "https://identitytoolkit.googleapis.com") throw new Error("Unexpected identity fixture origin");
  return Response.json({ idToken: "fixture-identity-not-a-real-token", expiresIn: "3600" });
};

export function serviceFixture() {
  const enabled: Record<string, boolean> = {
    mtn_momo_cm: true, mtn_momo_cc_cm: false, om_cm: true, om_cm_v2: true, om_pm_cm: false
  };
  return {
    enabled_payment_methods: enabled, money_transfer: { available: true, status: "ok",
      carriers: ["MTN Cameroon", "Orange"].map(carrier => {
        const payment_methods: Record<string, boolean> = { ...enabled, funds: true };
        return { carrier, enabled: true, can_transfer: true, funds_enabled: true, external_enabled: true, payment_methods };
      })
    }
  };
}
export function paymentFixture() {
  return {
    payment_methods: ["ussd_pay", "web_pay", "merchant_pay"].map(method => ({
      method, carriers: {
        "MTN Cameroon": { enabled: method === "ussd_pay", final_api_code: method === "ussd_pay" ? "mtn_momo_cm" : null },
        Orange: { enabled: method === "ussd_pay", final_api_code: method === "ussd_pay" ? "om_cm_v2" : null }
      }
    }))
  };
}

export function fixtureTransport(): Fetcher {
  return async (url, init) => {
    if (url.origin !== "https://api.switchn.net") throw new Error("Unexpected fixture origin");
    const input: unknown = typeof init.body === "string" ? JSON.parse(init.body) : {};
    const ok = (data: unknown) => Response.json({ success: true, data, mock: true });
    const route = `${init.method} ${url.pathname}`;
    if (route === "POST /money-transfers/review") {
      const body = moneyBody.parse(input);
      return ok(reviewData.parse({ ...body, transaction_specific_fee: 25,
        amount_after_fees: Math.max(1, body.amount_before_fees - 25),
        to_name: "MOCK RECIPIENT", name_match: true,
        alerts: [{ message: "Synthetic quote. These are not Switchn prices." }] }));
    }
    if (route === "POST /money-transfers/initiate") {
      return ok({ ...moneyBody.parse(input), id: 1001, last_state: "pending", payment_status: "pending",
        payment_requests: [{ id: 2001, request_state: "pending", payment_status: "pending" }] });
    }
    if (/^POST \/(payment-requests|airtime-requests)\/\d+\/payment-check$/.test(route)) {
      return ok({ id: 2001, payment_status: "pending", request_state: "pending" });
    }
    if (route === "GET /momo-withdrawal-fees") {
      return ok({
        mtn_mobile_money: [{ amount_range: { min: 1, max: 1000000 }, fee: { unit: "percentage", value: 1 } }],
        orange_money: [{ amount_range: { min: 1, max: 1000000 }, fee: { unit: "currency", value: 50 } }]
      });
    }
    if (route === "GET /momo-cross-network-fees") return ok([]);
    if (route === "GET /active-promotions") {
      return ok([{ id: 1, cost: 100, code: "MOCK-BUNDLE", name: "Synthetic bundle", network_carrier: "MTN Cameroon" }]);
    }
    if (route === "POST /airtime-requests/web") return ok({ ...objectData(input), id: 3001, status: "pending" });
    if (/^POST \/bundles\/[^/]+\/activate\/[^/]+$/.test(route)) return ok({ status: "pending", mock_activation: true });
    if (route === "POST /auth/sanctum/token" || route === "POST /auth/google.com/token-anonymous") {
      return ok({ access_token: "mock-issued-token-not-valid-in-production" });
    }
    if (route === "POST /otps") {
      return ok({ status: "successfully_sent_otp", unique_id: "mock-id",
        validate_url: "https://api.switchn.net/otps/mock-id/validate" });
    }
    if (route === "POST /otps/mock-id/validate") {
      if (objectData(input).otp !== "000000") return Response.json({ success: false, error_code: "invalid_otp_given" }, { status: 422 });
      return ok({ status_code: "otp_verified", unique_id: "mock-id" });
    }
    if (route === "GET /get-phone-carrier") return Response.json({
      success: true, carrier: url.searchParams.get("phone")?.includes("RECIPIENT") ? "Orange" : "MTN Cameroon", mock: true
    });
    if (route === "GET /momo-name") return ok({ name: "MOCK RECIPIENT" });
    if (route === "GET /my-funds") return ok({ id: 5001, balance: "1000000", withdrawals_enabled: true });
    if (route === "GET /service-status") return ok(serviceFixture());
    if (route === "GET /payment-config") return ok(paymentFixture());
    if (route === "GET /auth/login-options") return ok(["otp_sms", "otp_whatsapp", "google.com"]);
    return Response.json({ success: false, error_code: "MOCK_ROUTE_NOT_IMPLEMENTED" }, { status: 501 });
  };
}
