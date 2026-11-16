import { DarajaSimulator } from "../src/daraja/simulator.ts";
import { PaymentService, type PaymentServiceOptions } from "../src/payments.ts";
import { PaymentStore, type Payment } from "../src/store.ts";

/** Phone numbers whose last digit picks the simulator scenario. */
export const PHONE = {
  success: "0712345670",
  cancelled: "0712345671",
  timeout: "0712345672",
  wrongPin: "0712345673",
  insufficient: "0712345674",
  duplicate: "0712345675",
  lost: "0712345676",
  late: "0712345677",
  mismatch: "0712345678",
  rejected: "0712345679",
};

let n = 0;
export function setup(opts: Partial<PaymentServiceOptions> = {}) {
  const store = new PaymentStore(":memory:");
  const fulfilled: Payment[] = [];
  // eslint-disable-next-line prefer-const
  let service: PaymentService;
  const sim = new DarajaSimulator((body) => service.handleCallback(body));
  service = new PaymentService({
    store, daraja: sim, callbackUrl: "https://example.test/cb/x",
    onPaid: (p) => { fulfilled.push(p); },
    ...opts,
  });
  const pay = (phone: string, amount = 500, key = `key-${++n}`, orderId = `order-${n}`) =>
    service.initiate({ idempotencyKey: key, orderId, phone, amount });
  return { store, sim, service, fulfilled, pay };
}
