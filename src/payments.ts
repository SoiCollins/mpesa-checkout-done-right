import { normaliseKenyanMsisdn } from "./phone.ts";
import type { Payment, PaymentStore } from "./store.ts";
import { describeResult, type DarajaClient, type StkCallbackBody } from "./daraja/types.ts";

export class PaymentError extends Error {
  readonly httpStatus: number;
  constructor(message: string, httpStatus: number) {
    super(message);
    this.httpStatus = httpStatus;
  }
}

export interface PaymentServiceOptions {
  store: PaymentStore;
  daraja: DarajaClient;
  callbackUrl: string;
  /**
   * Safaricom does not sign callbacks. With this on (the default), a callback is only trusted
   * after an STK Query returns the same result, so a forged POST can't unlock or block anything.
   */
  verifyCallbacks?: boolean;
  /** Called exactly once per successful payment. Unlock credit / ship the order here. */
  onPaid?: (payment: Payment) => void | Promise<void>;
  /** After this long without an answer, a pending payment goes to human review instead of guessing. */
  maxPendingSeconds?: number;
}

export type CallbackOutcome =
  | "settled" | "duplicate" | "unknown-checkout" | "malformed" | "unverified" | "receipt-filled";

export class PaymentService {
  private readonly o: Required<Omit<PaymentServiceOptions, "onPaid">> & Pick<PaymentServiceOptions, "onPaid">;

  constructor(options: PaymentServiceOptions) {
    this.o = { verifyCallbacks: true, maxPendingSeconds: 600, ...options };
  }

  /**
   * Start a payment. Safe to call twice with the same idempotency key (double-click, retry,
   * flaky network): the customer gets one prompt, and both calls return the same payment.
   */
  async initiate(input: { idempotencyKey: string; orderId: string; phone: string; amount: number }): Promise<Payment> {
    if (!input.idempotencyKey) throw new PaymentError("Idempotency-Key header is required", 400);
    const existing = this.o.store.byIdempotencyKey(input.idempotencyKey);
    if (existing) {
      if (existing.orderId !== input.orderId || existing.amount !== input.amount) {
        throw new PaymentError("Idempotency-Key was already used for a different payment", 409);
      }
      return existing;
    }

    const phone = normaliseKenyanMsisdn(input.phone);
    if (!phone) throw new PaymentError("Not a Kenyan mobile number", 422);
    if (!Number.isInteger(input.amount) || input.amount < 1) {
      throw new PaymentError("Amount must be a whole number of KES, at least 1", 422);
    }
    if (this.o.store.paidForOrder(input.orderId)) throw new PaymentError("This order is already paid", 409);

    let payment: Payment;
    try {
      payment = this.o.store.insertPending({ ...input, phone });
    } catch (e) {
      // Two identical requests raced past the lookup above: return the winner's row.
      const winner = this.o.store.byIdempotencyKey(input.idempotencyKey);
      if (winner) return winner;
      throw e;
    }

    try {
      const accepted = await this.o.daraja.stkPush({
        phone,
        amount: input.amount,
        accountReference: input.orderId,
        description: "Payment",
        callbackUrl: this.o.callbackUrl,
      });
      this.o.store.attachCheckout(payment.id, accepted.merchantRequestId, accepted.checkoutRequestId);
    } catch (e) {
      // No prompt reached the customer, so this is a definite failure, not an unknown.
      this.o.store.settle(payment.id, "failed", { resultDesc: (e as Error).message });
    }
    return this.o.store.byId(payment.id)!;
  }

  /** What the frontend polls. The browser never decides whether a payment succeeded. */
  status(id: number): Payment | undefined {
    return this.o.store.byId(id);
  }

  /** Handle Safaricom's callback. Always safe to receive the same callback many times. */
  async handleCallback(rawBody: string): Promise<CallbackOutcome> {
    let cb: StkCallbackBody["Body"]["stkCallback"];
    try {
      cb = (JSON.parse(rawBody) as StkCallbackBody).Body.stkCallback;
      if (!cb?.CheckoutRequestID || typeof cb.ResultCode !== "number") throw new Error();
    } catch {
      this.o.store.logCallback(null, rawBody, "malformed");
      return "malformed";
    }

    const payment = this.o.store.byCheckoutId(cb.CheckoutRequestID);
    if (!payment) {
      this.o.store.logCallback(cb.CheckoutRequestID, rawBody, "unknown-checkout");
      return "unknown-checkout";
    }

    const meta = Object.fromEntries((cb.CallbackMetadata?.Item ?? []).map((i) => [i.Name, i.Value]));
    const receipt = meta.MpesaReceiptNumber ? String(meta.MpesaReceiptNumber) : null;

    if (payment.status !== "pending") {
      if (payment.status === "paid" && cb.ResultCode === 0 && receipt && !payment.mpesaReceipt) {
        this.o.store.fillReceipt(payment.id, receipt);
        this.o.store.logCallback(cb.CheckoutRequestID, rawBody, "receipt-filled");
        return "receipt-filled";
      }
      this.o.store.logCallback(cb.CheckoutRequestID, rawBody, "duplicate");
      return "duplicate";
    }

    // Verify failures too: a forged "cancelled" would otherwise block the real success that follows.
    if (this.o.verifyCallbacks) {
      const q = await this.o.daraja.stkQuery(cb.CheckoutRequestID).catch(() => null);
      if (!q || q.state !== "final" || q.resultCode !== cb.ResultCode) {
        // Leave it pending; the reconciler will ask Safaricom again.
        this.o.store.logCallback(cb.CheckoutRequestID, rawBody, "unverified");
        return "unverified";
      }
    }

    let won: boolean;
    if (cb.ResultCode === 0) {
      const paidAmount = Number(meta.Amount);
      if (meta.Amount !== undefined && paidAmount !== payment.amount) {
        won = await this.settle(payment, "review", {
          resultCode: 0, resultDesc: cb.ResultDesc, mpesaReceipt: receipt,
          reviewReason: `Amount mismatch: expected ${payment.amount}, callback says ${paidAmount}`,
        });
      } else {
        won = await this.settle(payment, "paid", { resultCode: 0, resultDesc: cb.ResultDesc, mpesaReceipt: receipt });
      }
    } else {
      won = await this.settle(payment, "failed", {
        resultCode: cb.ResultCode, resultDesc: describeResult(cb.ResultCode, cb.ResultDesc),
      });
    }
    // Concurrent copies of the same callback all get here; only one wins the compare-and-set.
    const outcome = won ? "settled" : "duplicate";
    this.o.store.logCallback(cb.CheckoutRequestID, rawBody, outcome);
    return outcome;
  }

  /**
   * Run every minute or so. Callbacks get lost (your server was down, a deploy, a network blip);
   * this asks Safaricom directly about anything still pending.
   */
  async reconcile(minAgeSeconds = 30): Promise<{ checked: number; settled: number }> {
    let settled = 0;
    const pending = this.o.store.pendingOlderThan(minAgeSeconds);
    for (const p of pending) {
      const q = await this.o.daraja.stkQuery(p.checkoutRequestId!).catch(() => null);
      if (q?.state === "final") {
        const to = q.resultCode === 0 ? "paid" : "failed";
        // The query doesn't return the receipt number; a late callback fills it in.
        if (await this.settle(p, to, { resultCode: q.resultCode, resultDesc: describeResult(q.resultCode, q.resultDesc) })) {
          settled++;
        }
      } else if (ageSeconds(p.createdAt) > this.o.maxPendingSeconds) {
        // Don't guess "failed": the customer may have paid. A human checks the M-Pesa statement.
        if (await this.settle(p, "review", { reviewReason: "No final answer from Safaricom within the time limit" })) {
          settled++;
        }
      }
    }
    return { checked: pending.length, settled };
  }

  private async settle(p: Payment, to: "paid" | "failed" | "review",
    fields: Parameters<PaymentStore["settle"]>[2]): Promise<boolean> {
    let won: boolean;
    try {
      won = this.o.store.settle(p.id, to, fields);
    } catch (e) {
      if (to !== "paid" || !String(e).includes("UNIQUE")) throw e;
      // The customer paid this order twice (two devices, two prompts). Money arrived: flag for refund.
      won = this.o.store.settle(p.id, "review", {
        ...fields, reviewReason: "Order was already paid by another payment: refund this one",
      });
      return won;
    }
    if (won && to === "paid" && this.o.store.claimFulfilment(p.id)) {
      await this.o.onPaid?.(this.o.store.byId(p.id)!);
    }
    return won;
  }
}

function ageSeconds(isoUtc: string): number {
  return (Date.now() - Date.parse(isoUtc)) / 1000;
}
