import type { DarajaClient, StkPushAccepted, StkPushRequest, StkQueryResult } from "./types.ts";

export interface DarajaCredentials {
  baseUrl: string; // https://sandbox.safaricom.co.ke or https://api.safaricom.co.ke
  consumerKey: string;
  consumerSecret: string;
  shortCode: string; // Paybill, or the store number for Buy Goods
  passkey: string;
  /** "CustomerPayBillOnline" for Paybill, "CustomerBuyGoodsOnline" for a Till. */
  transactionType: "CustomerPayBillOnline" | "CustomerBuyGoodsOnline";
  /** PartyB: the Paybill number, or the Till number for Buy Goods. */
  partyB: string;
}

/** Daraja wants YYYYMMDDHHmmss in Kenyan time. */
export function darajaTimestamp(now: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Africa/Nairobi",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
  }).formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)!.value;
  return `${get("year")}${get("month")}${get("day")}${get("hour")}${get("minute")}${get("second")}`;
}

export function stkPassword(shortCode: string, passkey: string, timestamp: string): string {
  return Buffer.from(`${shortCode}${passkey}${timestamp}`).toString("base64");
}

/** Daraja's "still waiting for the customer" error on STK Query. */
const STILL_PROCESSING = "500.001.1001";

export class HttpDarajaClient implements DarajaClient {
  private token: { value: string; expiresAt: number } | null = null;
  private readonly creds: DarajaCredentials;
  private readonly fetchImpl: typeof fetch;

  constructor(creds: DarajaCredentials, fetchImpl: typeof fetch = fetch) {
    this.creds = creds;
    this.fetchImpl = fetchImpl;
  }

  private async accessToken(): Promise<string> {
    if (this.token && Date.now() < this.token.expiresAt) return this.token.value;
    const basic = Buffer.from(`${this.creds.consumerKey}:${this.creds.consumerSecret}`).toString("base64");
    const res = await this.fetchImpl(`${this.creds.baseUrl}/oauth/v1/generate?grant_type=client_credentials`, {
      headers: { Authorization: `Basic ${basic}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`Daraja OAuth failed with HTTP ${res.status}`); // never log the body or headers
    const json = (await res.json()) as { access_token: string; expires_in: string | number };
    // Refresh a minute early so a token never expires mid-request.
    this.token = { value: json.access_token, expiresAt: Date.now() + (Number(json.expires_in) - 60) * 1000 };
    return this.token.value;
  }

  private async post(path: string, body: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
    const res = await this.fetchImpl(`${this.creds.baseUrl}${path}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${await this.accessToken()}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    return { status: res.status, json };
  }

  async stkPush(req: StkPushRequest): Promise<StkPushAccepted> {
    const timestamp = darajaTimestamp();
    const { status, json } = await this.post("/mpesa/stkpush/v1/processrequest", {
      BusinessShortCode: this.creds.shortCode,
      Password: stkPassword(this.creds.shortCode, this.creds.passkey, timestamp),
      Timestamp: timestamp,
      TransactionType: this.creds.transactionType,
      Amount: req.amount,
      PartyA: req.phone,
      PartyB: this.creds.partyB,
      PhoneNumber: req.phone,
      CallBackURL: req.callbackUrl,
      // Daraja documents short limits for these two fields; keep them short.
      AccountReference: req.accountReference.slice(0, 12),
      TransactionDesc: req.description.slice(0, 13),
    });
    if (status !== 200 || String(json.ResponseCode) !== "0") {
      throw new Error(`STK push rejected: ${json.errorMessage ?? json.ResponseDescription ?? `HTTP ${status}`}`);
    }
    return {
      merchantRequestId: String(json.MerchantRequestID),
      checkoutRequestId: String(json.CheckoutRequestID),
    };
  }

  async stkQuery(checkoutRequestId: string): Promise<StkQueryResult> {
    const timestamp = darajaTimestamp();
    const { status, json } = await this.post("/mpesa/stkpushquery/v1/query", {
      BusinessShortCode: this.creds.shortCode,
      Password: stkPassword(this.creds.shortCode, this.creds.passkey, timestamp),
      Timestamp: timestamp,
      CheckoutRequestID: checkoutRequestId,
    });
    if (json.errorCode === STILL_PROCESSING) return { state: "processing" };
    if (status !== 200 || json.ResultCode === undefined) {
      throw new Error(`STK query failed: ${json.errorMessage ?? `HTTP ${status}`}`);
    }
    return { state: "final", resultCode: Number(json.ResultCode), resultDesc: String(json.ResultDesc ?? "") };
  }
}
