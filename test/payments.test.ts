import { test } from "node:test";
import assert from "node:assert/strict";
import { PHONE, setup } from "./helpers.ts";

test("happy path: paid, receipt stored, fulfilled once", async () => {
  const { sim, service, fulfilled, pay } = setup();
  const p = await pay(PHONE.success, 1500);
  assert.equal(p.status, "pending");
  await sim.customerResponds(p.checkoutRequestId!);
  const done = service.status(p.id)!;
  assert.equal(done.status, "paid");
  assert.match(done.mpesaReceipt!, /^SIM/);
  assert.equal(fulfilled.length, 1);
});

test("double-click / retry with the same idempotency key sends ONE prompt", async () => {
  const { store, pay } = setup();
  const [a, b] = await Promise.all([pay(PHONE.success, 500, "same", "o-1"), pay(PHONE.success, 500, "same", "o-1")]);
  assert.equal(a.id, b.id);
  const rows = store.db.prepare("SELECT COUNT(*) AS c FROM payments").get() as { c: number };
  assert.equal(rows.c, 1);
});

test("reusing an idempotency key for a different amount is refused", async () => {
  const { pay } = setup();
  await pay(PHONE.success, 500, "k", "o-2");
  await assert.rejects(pay(PHONE.success, 900, "k", "o-2"), /different payment/);
});

test("Safaricom sends the same callback three times: credited once", async () => {
  const { sim, service, fulfilled, store, pay } = setup();
  const p = await pay(PHONE.duplicate);
  await sim.customerResponds(p.checkoutRequestId!);
  assert.equal(service.status(p.id)!.status, "paid");
  assert.equal(fulfilled.length, 1);
  const outcomes = store.callbackLog().map((c) => c.outcome).sort();
  assert.deepEqual(outcomes, ["duplicate", "duplicate", "settled"]);
});

test("callback never arrives: the reconciler asks Safaricom and settles it", async () => {
  const { sim, service, fulfilled, pay } = setup();
  const p = await pay(PHONE.lost);
  await sim.customerResponds(p.checkoutRequestId!); // customer paid, callback lost
  assert.equal(service.status(p.id)!.status, "pending");
  const r = await service.reconcile(0);
  assert.deepEqual(r, { checked: 1, settled: 1 });
  assert.equal(service.status(p.id)!.status, "paid");
  assert.equal(fulfilled.length, 1);
});

test("late callback after the reconciler settled: fills the receipt, no second credit", async () => {
  const { sim, service, fulfilled, pay } = setup();
  const p = await pay(PHONE.late);
  await sim.customerResponds(p.checkoutRequestId!);
  await service.reconcile(0);
  assert.equal(service.status(p.id)!.mpesaReceipt, null);
  await sim.deliverLate(p.checkoutRequestId!);
  assert.match(service.status(p.id)!.mpesaReceipt!, /^SIM/);
  assert.equal(fulfilled.length, 1);
});

test("customer still on the PIN screen: reconciler leaves it pending", async () => {
  const { service, pay } = setup();
  const p = await pay(PHONE.success);
  const r = await service.reconcile(0);
  assert.deepEqual(r, { checked: 1, settled: 0 });
  assert.equal(service.status(p.id)!.status, "pending");
});

test("no answer within the time limit goes to human review, not 'failed'", async () => {
  const { service, pay } = setup({ maxPendingSeconds: -1 });
  const p = await pay(PHONE.success);
  await service.reconcile(0);
  const s = service.status(p.id)!;
  assert.equal(s.status, "review");
  assert.match(s.reviewReason!, /time limit/);
});

for (const [name, phone, message] of [
  ["cancelled on the phone", PHONE.cancelled, "Cancelled on the phone"],
  ["prompt timed out", PHONE.timeout, "Phone not reachable or prompt timed out"],
  ["wrong PIN", PHONE.wrongPin, "Wrong M-Pesa PIN"],
  ["insufficient balance", PHONE.insufficient, "Insufficient M-Pesa balance"],
] as const) {
  test(`${name}: failed with a message a customer understands, nothing fulfilled`, async () => {
    const { sim, service, fulfilled, pay } = setup();
    const p = await pay(phone);
    await sim.customerResponds(p.checkoutRequestId!);
    const s = service.status(p.id)!;
    assert.equal(s.status, "failed");
    assert.equal(s.resultDesc, message);
    assert.equal(fulfilled.length, 0);
  });
}

test("forged success callback for a real checkout is not trusted", async () => {
  const { sim, service, fulfilled, store, pay } = setup();
  const p = await pay(PHONE.success, 2000);
  // Attacker learned the CheckoutRequestID and posts a fake success before the customer paid.
  const outcome = await service.handleCallback(sim.forgedSuccess(p.checkoutRequestId!, 2000));
  assert.equal(outcome, "unverified");
  assert.equal(service.status(p.id)!.status, "pending");
  assert.equal(fulfilled.length, 0);
  assert.equal(store.callbackLog().at(-1)!.outcome, "unverified");
});

test("forged 'cancelled' callback can't block the real payment that follows", async () => {
  const { sim, service, fulfilled, pay } = setup();
  const p = await pay(PHONE.success, 800);
  const forged = JSON.stringify({ Body: { stkCallback: {
    MerchantRequestID: "x", CheckoutRequestID: p.checkoutRequestId, ResultCode: 1032, ResultDesc: "Request cancelled by user" } } });
  assert.equal(await service.handleCallback(forged), "unverified");
  await sim.customerResponds(p.checkoutRequestId!);
  assert.equal(service.status(p.id)!.status, "paid");
  assert.equal(fulfilled.length, 1);
});

test("callback amount differs from the order: held for review, not fulfilled", async () => {
  const { sim, service, fulfilled, pay } = setup();
  const p = await pay(PHONE.mismatch, 1000);
  await sim.customerResponds(p.checkoutRequestId!);
  const s = service.status(p.id)!;
  assert.equal(s.status, "review");
  assert.match(s.reviewReason!, /expected 1000, callback says 999/);
  assert.equal(fulfilled.length, 0);
});

test("customer pays the same order twice from two prompts: second one flagged for refund", async () => {
  const { sim, service, fulfilled, pay } = setup();
  const a = await pay(PHONE.success, 700, "device-a", "order-x");
  const b = await pay(PHONE.success, 700, "device-b", "order-x");
  await sim.customerResponds(a.checkoutRequestId!);
  await sim.customerResponds(b.checkoutRequestId!);
  assert.equal(service.status(a.id)!.status, "paid");
  const second = service.status(b.id)!;
  assert.equal(second.status, "review");
  assert.match(second.reviewReason!, /refund/);
  assert.equal(fulfilled.length, 1);
});

test("new payment for an already-paid order is refused up front", async () => {
  const { sim, pay } = setup();
  const a = await pay(PHONE.success, 700, "k1", "order-y");
  await sim.customerResponds(a.checkoutRequestId!);
  await assert.rejects(pay(PHONE.success, 700, "k2", "order-y"), /already paid/);
});

test("STK push rejected by Safaricom: failed immediately, never left hanging", async () => {
  const { service, pay } = setup();
  const p = await pay(PHONE.rejected);
  assert.equal(p.status, "failed");
  assert.equal(service.status(p.id)!.checkoutRequestId, null);
});

test("callbacks for unknown checkouts and garbage bodies are logged and ignored", async () => {
  const { service, store } = setup();
  assert.equal(await service.handleCallback("not json"), "malformed");
  assert.equal(await service.handleCallback(JSON.stringify({ Body: { stkCallback: {
    MerchantRequestID: "x", CheckoutRequestID: "ws_CO_nope", ResultCode: 0, ResultDesc: "ok" } } })), "unknown-checkout");
  assert.deepEqual(store.callbackLog().map((c) => c.outcome), ["malformed", "unknown-checkout"]);
});

test("input validation: non-Kenyan number and fractional amount", async () => {
  const { pay } = setup();
  await assert.rejects(pay("+447700900123"), /Kenyan mobile/);
  await assert.rejects(pay(PHONE.success, 10.5), /whole number/);
});
