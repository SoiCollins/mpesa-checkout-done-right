import { randomBytes } from "node:crypto";
import { HttpDarajaClient } from "./daraja/http-client.ts";
import { DarajaSimulator } from "./daraja/simulator.ts";
import type { DarajaClient } from "./daraja/types.ts";
import { PaymentService } from "./payments.ts";
import { buildServer } from "./server.ts";
import { PaymentStore } from "./store.ts";

/**
 * MPESA_MODE=simulator (default) needs no credentials.
 * MPESA_MODE=sandbox|production reads Daraja credentials from the process environment.
 * Inject them from a secret manager at runtime; don't keep them in files.
 */
const mode = process.env.MPESA_MODE ?? "simulator";
const port = Number(process.env.PORT ?? 3000);
const publicBaseUrl = process.env.PUBLIC_BASE_URL ?? `http://localhost:${port}`;
const callbackToken = process.env.CALLBACK_TOKEN ?? randomBytes(24).toString("base64url");

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} must be set for MPESA_MODE=${mode}`);
  return v;
}

const store = new PaymentStore(process.env.DB_PATH ?? "payments.db");
const callbackUrl = `${publicBaseUrl}/mpesa/callback/${callbackToken}`;

let simulator: DarajaSimulator | undefined;
let daraja: DarajaClient;
if (mode === "simulator") {
  simulator = new DarajaSimulator((body) =>
    fetch(callbackUrl, { method: "POST", headers: { "Content-Type": "application/json" }, body }));
  daraja = simulator;
} else if (mode === "sandbox" || mode === "production") {
  daraja = new HttpDarajaClient({
    baseUrl: mode === "sandbox" ? "https://sandbox.safaricom.co.ke" : "https://api.safaricom.co.ke",
    consumerKey: required("DARAJA_CONSUMER_KEY"),
    consumerSecret: required("DARAJA_CONSUMER_SECRET"),
    shortCode: required("DARAJA_SHORTCODE"),
    passkey: required("DARAJA_PASSKEY"),
    transactionType: process.env.DARAJA_TILL ? "CustomerBuyGoodsOnline" : "CustomerPayBillOnline",
    partyB: process.env.DARAJA_TILL ?? required("DARAJA_SHORTCODE"),
  });
} else {
  throw new Error(`Unknown MPESA_MODE: ${mode}`);
}

const service = new PaymentService({
  store, daraja, callbackUrl,
  onPaid: (p) => console.log(`Fulfil order ${p.orderId}: KES ${p.amount}, receipt ${p.mpesaReceipt ?? "(pending)"}`),
});

setInterval(() => {
  service.reconcile().catch((e) => console.error("Reconcile failed:", (e as Error).message));
}, 30_000).unref();

buildServer({ service, callbackToken, simulator }).listen(port, () => {
  console.log(`M-Pesa checkout (${mode}) on http://localhost:${port}`);
  if (!process.env.CALLBACK_TOKEN) console.log("CALLBACK_TOKEN not set: generated a random one for this run.");
});
