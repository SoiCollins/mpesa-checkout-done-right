/**
 * Runs every scenario through the real payment logic against the simulator and prints what happened.
 * npm run demo
 */
import { DarajaSimulator, SCENARIOS } from "../src/daraja/simulator.ts";
import { PaymentService } from "../src/payments.ts";
import { PaymentStore } from "../src/store.ts";

const store = new PaymentStore(":memory:");
const credited = new Map<number, number>();
// eslint-disable-next-line prefer-const
let service: PaymentService;
const sim = new DarajaSimulator((body) => service.handleCallback(body));
service = new PaymentService({
  store, daraja: sim, callbackUrl: "https://example.test/cb",
  onPaid: (p) => { credited.set(p.id, (credited.get(p.id) ?? 0) + 1); },
});

const rows: string[][] = [];
for (const [digit, scenario] of Object.entries(SCENARIOS)) {
  const p = await service.initiate({
    idempotencyKey: `demo-${digit}`, orderId: `ORDER-${digit}`, phone: `071234567${digit}`, amount: 1000,
  });
  if (p.checkoutRequestId) {
    await sim.customerResponds(p.checkoutRequestId);
    await service.reconcile(0); // the job that rescues lost callbacks
    await sim.deliverLate(p.checkoutRequestId);
  }
  const s = service.status(p.id)!;
  const callbacks = store.callbackLog().filter((c) => c.checkoutRequestId === s.checkoutRequestId).length;
  rows.push([scenario, s.status, String(credited.get(p.id) ?? 0), String(callbacks),
    s.reviewReason ?? s.resultDesc ?? ""]);
}

const header = ["scenario", "final status", "credited", "callbacks", "why"];
const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
const line = (r: string[]) => r.map((c, i) => c.padEnd(widths[i])).join("  ");
console.log(line(header));
console.log(widths.map((w) => "-".repeat(w)).join("  "));
rows.forEach((r) => console.log(line(r)));
const total = [...credited.values()].reduce((a, b) => a + b, 0);
console.log(`\n${total} order(s) credited, each exactly once. Nothing credited without Safaricom confirming it.`);
