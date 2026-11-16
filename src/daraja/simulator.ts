import { randomUUID } from "node:crypto";
import type { DarajaClient, StkCallbackBody, StkPushAccepted, StkPushRequest, StkQueryResult } from "./types.ts";

/**
 * The Daraja sandbox only ever succeeds. Real customers cancel, mistype their PIN, run out of
 * balance and ignore the prompt, and real callbacks arrive twice, late or never.
 * This simulator reproduces those cases so you can test them before production does it for you.
 *
 * The scenario is picked by the last digit of the phone number (see SCENARIOS).
 */
export type Scenario =
  | "success" | "cancelled" | "timeout" | "wrong-pin" | "insufficient-funds"
  | "duplicate-callback" | "lost-callback" | "late-callback" | "amount-mismatch" | "push-rejected";

export const SCENARIOS: Record<string, Scenario> = {
  "0": "success",
  "1": "cancelled",
  "2": "timeout",
  "3": "wrong-pin",
  "4": "insufficient-funds",
  "5": "duplicate-callback",
  "6": "lost-callback",
  "7": "late-callback",
  "8": "amount-mismatch",
  "9": "push-rejected",
};

const RESULT: Record<string, { code: number; desc: string }> = {
  success: { code: 0, desc: "The service request is processed successfully." },
  cancelled: { code: 1032, desc: "Request cancelled by user" },
  timeout: { code: 1037, desc: "DS timeout user cannot be reached" },
  "wrong-pin": { code: 2001, desc: "The initiator information is invalid." },
  "insufficient-funds": { code: 1, desc: "The balance is insufficient for the transaction" },
};

interface Pending {
  req: StkPushRequest;
  scenario: Scenario;
  merchantRequestId: string;
  done: boolean;
}

export class DarajaSimulator implements DarajaClient {
  private readonly pending = new Map<string, Pending>();
  private readonly deliver: (body: string) => Promise<unknown>;
  /** Callbacks held back by the late-callback scenario, keyed by CheckoutRequestID. */
  readonly withheld = new Map<string, string>();

  /** `deliver` posts a callback body to your app (in-process in tests, HTTP in the dev server). */
  constructor(deliver: (body: string) => Promise<unknown>) {
    this.deliver = deliver;
  }

  scenarioFor(phone: string): Scenario {
    return SCENARIOS[phone.at(-1)!] ?? "success";
  }

  async stkPush(req: StkPushRequest): Promise<StkPushAccepted> {
    const scenario = this.scenarioFor(req.phone);
    if (scenario === "push-rejected") throw new Error("STK push rejected: Invalid PhoneNumber");
    const merchantRequestId = `sim-${randomUUID().slice(0, 8)}`;
    const checkoutRequestId = `ws_CO_SIM_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
    this.pending.set(checkoutRequestId, { req, scenario, merchantRequestId, done: false });
    return { merchantRequestId, checkoutRequestId };
  }

  /** Simulate the customer finishing on their phone. Returns once the callback(s) were delivered. */
  async customerResponds(checkoutRequestId: string): Promise<void> {
    const p = this.pending.get(checkoutRequestId);
    if (!p) throw new Error(`Unknown checkout ${checkoutRequestId}`);
    p.done = true;
    const body = this.callbackBody(checkoutRequestId, p);
    switch (p.scenario) {
      case "duplicate-callback":
        await Promise.all([this.deliver(body), this.deliver(body), this.deliver(body)]);
        return;
      case "lost-callback":
        return; // never delivered: only the reconciler can find out what happened
      case "late-callback":
        this.withheld.set(checkoutRequestId, body);
        return;
      default:
        await this.deliver(body);
    }
  }

  /** Deliver a callback that was held back by the late-callback scenario. */
  async deliverLate(checkoutRequestId: string): Promise<void> {
    const body = this.withheld.get(checkoutRequestId);
    if (body) await this.deliver(body);
  }

  /** A forged "success" callback, as an attacker who learned a CheckoutRequestID might send. */
  forgedSuccess(checkoutRequestId: string, amount: number): string {
    return JSON.stringify(successBody("forged", checkoutRequestId, amount, "FAKE000000", "254700000000"));
  }

  async stkQuery(checkoutRequestId: string): Promise<StkQueryResult> {
    const p = this.pending.get(checkoutRequestId);
    if (!p) return { state: "final", resultCode: 1032, resultDesc: "Request cancelled by user" };
    if (!p.done) return { state: "processing" };
    const r = this.resultFor(p.scenario);
    return { state: "final", resultCode: r.code, resultDesc: r.desc };
  }

  private resultFor(s: Scenario) {
    return RESULT[s] ?? RESULT.success;
  }

  private callbackBody(checkoutRequestId: string, p: Pending): string {
    const r = this.resultFor(p.scenario);
    if (r.code !== 0) {
      const body: StkCallbackBody = { Body: { stkCallback: {
        MerchantRequestID: p.merchantRequestId, CheckoutRequestID: checkoutRequestId,
        ResultCode: r.code, ResultDesc: r.desc,
      } } };
      return JSON.stringify(body);
    }
    const amount = p.scenario === "amount-mismatch" ? p.req.amount - 1 : p.req.amount;
    const receipt = `SIM${randomUUID().replaceAll("-", "").slice(0, 7).toUpperCase()}`;
    return JSON.stringify(successBody(p.merchantRequestId, checkoutRequestId, amount, receipt, p.req.phone));
  }
}

function successBody(mrid: string, crid: string, amount: number, receipt: string, phone: string): StkCallbackBody {
  return { Body: { stkCallback: {
    MerchantRequestID: mrid, CheckoutRequestID: crid, ResultCode: 0,
    ResultDesc: "The service request is processed successfully.",
    CallbackMetadata: { Item: [
      { Name: "Amount", Value: amount },
      { Name: "MpesaReceiptNumber", Value: receipt },
      { Name: "TransactionDate", Value: 20261116120000 },
      { Name: "PhoneNumber", Value: Number(phone) },
    ] },
  } } };
}
