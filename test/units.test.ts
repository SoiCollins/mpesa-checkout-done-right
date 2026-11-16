import { test } from "node:test";
import assert from "node:assert/strict";
import { normaliseKenyanMsisdn } from "../src/phone.ts";
import { darajaTimestamp, HttpDarajaClient, stkPassword } from "../src/daraja/http-client.ts";

test("phone normalisation", () => {
  for (const input of ["0712345678", "712345678", "+254712345678", "254712345678", "0712 345 678", "0712-345-678"]) {
    assert.equal(normaliseKenyanMsisdn(input), "254712345678", input);
  }
  assert.equal(normaliseKenyanMsisdn("0110123456"), "254110123456");
  for (const bad of ["0812345678", "071234567", "07123456789", "+447700900123", "abc"]) {
    assert.equal(normaliseKenyanMsisdn(bad), null, bad);
  }
});

test("timestamp is Nairobi time (UTC+3) in YYYYMMDDHHmmss", () => {
  assert.equal(darajaTimestamp(new Date("2026-11-16T21:30:05Z")), "20261117003005");
});

test("STK password is base64(shortcode + passkey + timestamp)", () => {
  assert.equal(stkPassword("600000", "pk", "20260101000000"),
    Buffer.from("600000pk20260101000000").toString("base64"));
});

/** A fake fetch so the HTTP client is tested without a network or real credentials. */
function fakeFetch(routes: Record<string, { status: number; body: unknown }>) {
  const calls: Array<{ url: string; body?: unknown }> = [];
  const impl = (async (url: string, init?: RequestInit) => {
    const path = new URL(url).pathname;
    calls.push({ url: path, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const r = routes[path];
    return new Response(JSON.stringify(r.body), { status: r.status });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

const creds = {
  baseUrl: "https://sandbox.example", consumerKey: "placeholder-key", consumerSecret: "placeholder-secret",
  shortCode: "600000", passkey: "placeholder-passkey", transactionType: "CustomerPayBillOnline" as const, partyB: "600000",
};

test("HTTP client: token cached across calls, STK push body shaped as Daraja expects", async () => {
  const { impl, calls } = fakeFetch({
    "/oauth/v1/generate": { status: 200, body: { access_token: "t", expires_in: "3599" } },
    "/mpesa/stkpush/v1/processrequest": { status: 200, body: {
      MerchantRequestID: "m1", CheckoutRequestID: "ws_CO_1", ResponseCode: "0" } },
  });
  const c = new HttpDarajaClient(creds, impl);
  const req = { phone: "254712345678", amount: 10, accountReference: "ORDER-123456789", description: "Payment for order", callbackUrl: "https://x/cb" };
  assert.deepEqual(await c.stkPush(req), { merchantRequestId: "m1", checkoutRequestId: "ws_CO_1" });
  await c.stkPush(req);
  assert.equal(calls.filter((x) => x.url === "/oauth/v1/generate").length, 1);
  const body = calls[1].body as Record<string, unknown>;
  assert.equal(body.TransactionType, "CustomerPayBillOnline");
  assert.equal(body.PartyA, "254712345678");
  assert.equal(String(body.AccountReference).length <= 12, true);
  assert.equal(String(body.TransactionDesc).length <= 13, true);
});

test("HTTP client: 'still processing' query maps to processing, final result maps through", async () => {
  const processing = fakeFetch({
    "/oauth/v1/generate": { status: 200, body: { access_token: "t", expires_in: "3599" } },
    "/mpesa/stkpushquery/v1/query": { status: 500, body: { errorCode: "500.001.1001", errorMessage: "The transaction is being processed" } },
  });
  assert.deepEqual(await new HttpDarajaClient(creds, processing.impl).stkQuery("ws_CO_1"), { state: "processing" });

  const final = fakeFetch({
    "/oauth/v1/generate": { status: 200, body: { access_token: "t", expires_in: "3599" } },
    "/mpesa/stkpushquery/v1/query": { status: 200, body: { ResponseCode: "0", ResultCode: "1032", ResultDesc: "Request cancelled by user" } },
  });
  assert.deepEqual(await new HttpDarajaClient(creds, final.impl).stkQuery("ws_CO_1"),
    { state: "final", resultCode: 1032, resultDesc: "Request cancelled by user" });
});

test("HTTP client: rejected STK push throws with Daraja's message", async () => {
  const { impl } = fakeFetch({
    "/oauth/v1/generate": { status: 200, body: { access_token: "t", expires_in: "3599" } },
    "/mpesa/stkpush/v1/processrequest": { status: 400, body: { errorCode: "400.002.02", errorMessage: "Bad Request - Invalid PhoneNumber" } },
  });
  await assert.rejects(new HttpDarajaClient(creds, impl).stkPush({
    phone: "254712345678", amount: 1, accountReference: "o", description: "d", callbackUrl: "https://x" }), /Invalid PhoneNumber/);
});
