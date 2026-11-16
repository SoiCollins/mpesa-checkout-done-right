import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { PaymentError, type PaymentService } from "./payments.ts";
import type { DarajaSimulator } from "./daraja/simulator.ts";
import type { Payment } from "./store.ts";

const MAX_BODY = 64 * 1024;

async function readBody(req: IncomingMessage): Promise<string> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) throw new PaymentError("Body too large", 413);
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

function sameSecret(a: string, b: string): boolean {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** What the customer's browser is allowed to see. No internal ids or raw provider text. */
function publicView(p: Payment) {
  return {
    id: p.id,
    orderId: p.orderId,
    amount: p.amount,
    status: p.status,
    message: p.status === "failed" ? p.resultDesc : p.status === "review" ? "We're checking this payment" : null,
    receipt: p.mpesaReceipt,
  };
}

export function buildServer(opts: {
  service: PaymentService;
  callbackToken: string;
  simulator?: DarajaSimulator;
}): Server {
  const { service, callbackToken, simulator } = opts;

  return createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname;
    try {
      if (req.method === "GET" && path === "/health") return send(res, 200, { ok: true });

      if (req.method === "POST" && path === "/payments") {
        const body = JSON.parse(await readBody(req) || "{}") as { orderId?: string; phone?: string; amount?: number };
        if (!body.orderId || !body.phone || body.amount === undefined) {
          throw new PaymentError("orderId, phone and amount are required", 400);
        }
        const p = await service.initiate({
          idempotencyKey: String(req.headers["idempotency-key"] ?? ""),
          orderId: body.orderId, phone: body.phone, amount: body.amount,
        });
        return send(res, 201, publicView(p));
      }

      const statusMatch = path.match(/^\/payments\/(\d+)$/);
      if (req.method === "GET" && statusMatch) {
        const p = service.status(Number(statusMatch[1]));
        return p ? send(res, 200, publicView(p)) : send(res, 404, { error: "Not found" });
      }

      // Safaricom doesn't sign callbacks, so the URL carries a secret and success is re-checked by STK Query.
      const cbMatch = path.match(/^\/mpesa\/callback\/([A-Za-z0-9_-]+)$/);
      if (req.method === "POST" && cbMatch) {
        if (!sameSecret(cbMatch[1], callbackToken)) return send(res, 404, { error: "Not found" });
        await service.handleCallback(await readBody(req));
        // Always acknowledge, even duplicates, so Safaricom stops retrying.
        return send(res, 200, { ResultCode: 0, ResultDesc: "Accepted" });
      }

      const simMatch = path.match(/^\/simulator\/respond\/([A-Za-z0-9_]+)$/);
      if (simulator && req.method === "POST" && simMatch) {
        await simulator.customerResponds(simMatch[1]);
        return send(res, 200, { ok: true });
      }

      send(res, 404, { error: "Not found" });
    } catch (e) {
      if (e instanceof PaymentError) return send(res, e.httpStatus, { error: e.message });
      if (e instanceof SyntaxError) return send(res, 400, { error: "Invalid JSON" });
      console.error("Unhandled error:", (e as Error).message);
      send(res, 500, { error: "Internal error" });
    }
  });
}
