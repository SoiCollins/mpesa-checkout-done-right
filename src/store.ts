import { DatabaseSync } from "node:sqlite";

export type PaymentStatus =
  | "pending" // STK prompt sent, waiting for the customer
  | "paid" // confirmed by Safaricom
  | "failed" // confirmed failure (cancelled, wrong PIN, timeout...)
  | "review"; // something doesn't add up (amount mismatch, unresolved after max wait): a human looks

export interface Payment {
  id: number;
  idempotencyKey: string;
  orderId: string;
  phone: string;
  amount: number;
  status: PaymentStatus;
  merchantRequestId: string | null;
  checkoutRequestId: string | null;
  mpesaReceipt: string | null;
  resultCode: number | null;
  resultDesc: string | null;
  reviewReason: string | null;
  fulfilledAt: string | null;
  createdAt: string;
  updatedAt: string;
}

const COLUMNS = `id, idempotency_key AS idempotencyKey, order_id AS orderId, phone, amount, status,
  merchant_request_id AS merchantRequestId, checkout_request_id AS checkoutRequestId,
  mpesa_receipt AS mpesaReceipt, result_code AS resultCode, result_desc AS resultDesc,
  review_reason AS reviewReason, fulfilled_at AS fulfilledAt, created_at AS createdAt, updated_at AS updatedAt`;

export class PaymentStore {
  readonly db: DatabaseSync;

  constructor(path = ":memory:") {
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS payments (
        id INTEGER PRIMARY KEY,
        idempotency_key TEXT NOT NULL UNIQUE,
        order_id TEXT NOT NULL,
        phone TEXT NOT NULL,
        amount INTEGER NOT NULL CHECK (amount > 0),
        status TEXT NOT NULL CHECK (status IN ('pending','paid','failed','review')),
        merchant_request_id TEXT,
        checkout_request_id TEXT UNIQUE,
        mpesa_receipt TEXT UNIQUE,
        result_code INTEGER,
        result_desc TEXT,
        review_reason TEXT,
        fulfilled_at TEXT,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      );
      -- At most one successful payment per order, enforced by the database, not by hope.
      CREATE UNIQUE INDEX IF NOT EXISTS one_paid_per_order ON payments(order_id) WHERE status = 'paid';
      -- Every callback is kept verbatim, including ones we ignore. This is your audit trail.
      CREATE TABLE IF NOT EXISTS callback_log (
        id INTEGER PRIMARY KEY,
        checkout_request_id TEXT,
        body TEXT NOT NULL,
        outcome TEXT NOT NULL,
        received_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      );
    `);
  }

  insertPending(p: { idempotencyKey: string; orderId: string; phone: string; amount: number }): Payment {
    const row = this.db
      .prepare(`INSERT INTO payments (idempotency_key, order_id, phone, amount, status)
                VALUES (?, ?, ?, ?, 'pending') RETURNING ${COLUMNS}`)
      .get(p.idempotencyKey, p.orderId, p.phone, p.amount);
    return row as unknown as Payment;
  }

  attachCheckout(id: number, merchantRequestId: string, checkoutRequestId: string): void {
    this.db
      .prepare(`UPDATE payments SET merchant_request_id = ?, checkout_request_id = ?,
                updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`)
      .run(merchantRequestId, checkoutRequestId, id);
  }

  byId(id: number): Payment | undefined {
    return this.db.prepare(`SELECT ${COLUMNS} FROM payments WHERE id = ?`).get(id) as Payment | undefined;
  }
  byIdempotencyKey(key: string): Payment | undefined {
    return this.db.prepare(`SELECT ${COLUMNS} FROM payments WHERE idempotency_key = ?`).get(key) as Payment | undefined;
  }
  byCheckoutId(checkoutRequestId: string): Payment | undefined {
    return this.db.prepare(`SELECT ${COLUMNS} FROM payments WHERE checkout_request_id = ?`).get(checkoutRequestId) as
      | Payment
      | undefined;
  }
  paidForOrder(orderId: string): Payment | undefined {
    return this.db.prepare(`SELECT ${COLUMNS} FROM payments WHERE order_id = ? AND status = 'paid'`).get(orderId) as
      | Payment
      | undefined;
  }
  pendingOlderThan(seconds: number): Payment[] {
    return this.db
      .prepare(`SELECT ${COLUMNS} FROM payments WHERE status = 'pending' AND checkout_request_id IS NOT NULL
                AND created_at <= strftime('%Y-%m-%dT%H:%M:%fZ','now', ?)`)
      .all(`-${seconds} seconds`) as unknown as Payment[];
  }

  /**
   * Move a payment out of 'pending'. The WHERE clause makes this a compare-and-set:
   * if two callbacks (or a callback and the reconciler) race, exactly one wins.
   */
  settle(id: number, to: Exclude<PaymentStatus, "pending">, fields: {
    resultCode?: number; resultDesc?: string; mpesaReceipt?: string | null; reviewReason?: string;
  }): boolean {
    const r = this.db
      .prepare(`UPDATE payments SET status = ?, result_code = ?, result_desc = ?, mpesa_receipt = ?,
                review_reason = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
                WHERE id = ? AND status = 'pending'`)
      .run(to, fields.resultCode ?? null, fields.resultDesc ?? null, fields.mpesaReceipt ?? null,
        fields.reviewReason ?? null, id);
    return Number(r.changes) === 1;
  }

  /** A late callback can fill in the receipt for a payment the reconciler already confirmed. */
  fillReceipt(id: number, receipt: string): void {
    this.db
      .prepare(`UPDATE payments SET mpesa_receipt = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
                WHERE id = ? AND status = 'paid' AND mpesa_receipt IS NULL`)
      .run(receipt, id);
  }

  /** Claim the right to fulfil (unlock credit, ship the order). Returns true for exactly one caller, ever. */
  claimFulfilment(id: number): boolean {
    const r = this.db
      .prepare(`UPDATE payments SET fulfilled_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
                WHERE id = ? AND status = 'paid' AND fulfilled_at IS NULL`)
      .run(id);
    return Number(r.changes) === 1;
  }

  logCallback(checkoutRequestId: string | null, body: string, outcome: string): void {
    this.db.prepare(`INSERT INTO callback_log (checkout_request_id, body, outcome) VALUES (?, ?, ?)`)
      .run(checkoutRequestId, body, outcome);
  }

  callbackLog(): Array<{ checkoutRequestId: string | null; outcome: string }> {
    return this.db.prepare(`SELECT checkout_request_id AS checkoutRequestId, outcome FROM callback_log ORDER BY id`)
      .all() as unknown as Array<{ checkoutRequestId: string | null; outcome: string }>;
  }
}
