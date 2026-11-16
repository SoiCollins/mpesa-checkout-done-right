import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { buildServer } from "../src/server.ts";
import { PHONE, setup } from "./helpers.ts";

test("HTTP: create, poll, callback with secret path; wrong secret is a 404", async () => {
  const { service, sim } = setup();
  const server = buildServer({ service, callbackToken: "s3cret-token", simulator: sim }).listen(0);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const created = await fetch(`${base}/payments`, {
      method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": "http-1" },
      body: JSON.stringify({ orderId: "o-http", phone: PHONE.success, amount: 250 }),
    });
    assert.equal(created.status, 201);
    const p = (await created.json()) as { id: number; status: string };
    assert.equal(p.status, "pending");
    assert.equal("checkoutRequestId" in p, false, "internal ids are not exposed to the browser");

    const missingKey = await fetch(`${base}/payments`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ orderId: "o2", phone: PHONE.success, amount: 1 }),
    });
    assert.equal(missingKey.status, 400);

    const wrong = await fetch(`${base}/mpesa/callback/guess`, { method: "POST", body: "{}" });
    assert.equal(wrong.status, 404);

    const ack = await fetch(`${base}/mpesa/callback/s3cret-token`, { method: "POST", body: "garbage" });
    assert.deepEqual(await ack.json(), { ResultCode: 0, ResultDesc: "Accepted" });

    await sim.customerResponds(service.status(p.id)!.checkoutRequestId!);
    const polled = (await (await fetch(`${base}/payments/${p.id}`)).json()) as { status: string; receipt: string };
    assert.equal(polled.status, "paid");
    assert.match(polled.receipt, /^SIM/);
  } finally {
    server.close();
  }
});
