export interface StkPushRequest {
  phone: string; // normalised 254XXXXXXXXX
  amount: number; // whole KES
  accountReference: string;
  description: string;
  callbackUrl: string;
}

export interface StkPushAccepted {
  merchantRequestId: string;
  checkoutRequestId: string;
}

/** Result of asking Daraja what happened to an STK request. */
export type StkQueryResult =
  | { state: "final"; resultCode: number; resultDesc: string }
  | { state: "processing" }; // customer hasn't finished yet, ask again later

export interface DarajaClient {
  stkPush(req: StkPushRequest): Promise<StkPushAccepted>;
  stkQuery(checkoutRequestId: string): Promise<StkQueryResult>;
}

/** Shape of the callback Safaricom POSTs to your CallBackURL. */
export interface StkCallbackBody {
  Body: {
    stkCallback: {
      MerchantRequestID: string;
      CheckoutRequestID: string;
      ResultCode: number;
      ResultDesc: string;
      CallbackMetadata?: {
        Item: Array<{ Name: string; Value?: string | number }>;
      };
    };
  };
}

/** Result codes worth explaining to a customer. Anything else is shown as a generic failure. */
export const RESULT_CODES: Record<number, string> = {
  0: "Paid",
  1: "Insufficient M-Pesa balance",
  1032: "Cancelled on the phone",
  1037: "Phone not reachable or prompt timed out",
  2001: "Wrong M-Pesa PIN",
};

export function describeResult(code: number, fallback: string): string {
  return RESULT_CODES[code] ?? fallback;
}
