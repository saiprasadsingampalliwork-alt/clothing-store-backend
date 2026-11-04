import { createHmac, timingSafeEqual } from "crypto";
import { BadRequestException, Injectable } from "@nestjs/common";

/**
 * live: Razorpay keys are set and online payments are charged.
 * demo: no keys, PAYMENTS_DEMO=true; online orders complete without a charge and are marked demo.
 * off:  no keys; only cash on delivery is accepted. The safe default.
 */
export type PaymentMode = "live" | "demo" | "off";

export type RefundResult = { status: "pending" | "refunded" | "failed"; id?: string; note: string };

/**
 * Razorpay could not confirm the payment yet (unreachable, or not captured). The payment may still be good,
 * so it is never refunded for this; the browser retries and the webhook can still complete the order.
 */
export class PaymentNotConfirmedException extends BadRequestException {}

type RazorpayPayment = { id: string; order_id?: string; amount: number; currency: string; status: string };

@Injectable()
export class PaymentsService {
  configured() {
    return Boolean(process.env.RAZORPAY_KEY_ID?.trim() && process.env.RAZORPAY_KEY_SECRET?.trim());
  }

  mode(): PaymentMode {
    if (this.configured()) return "live";
    return process.env.PAYMENTS_DEMO?.trim().toLowerCase() === "true" ? "demo" : "off";
  }

  keyId() {
    return process.env.RAZORPAY_KEY_ID?.trim() || "";
  }

  verifyPayment(orderId: string, paymentId: string, signature: string) {
    const secret = process.env.RAZORPAY_KEY_SECRET?.trim();
    if (!secret || !signature) return false;
    const expected = createHmac("sha256", secret).update(`${orderId}|${paymentId}`).digest("hex");
    return safeEqual(expected, signature);
  }

  verifyWebhook(rawBody: string, signature?: string) {
    const secret = process.env.RAZORPAY_WEBHOOK_SECRET?.trim();
    if (!secret || !signature) return false;
    const expected = createHmac("sha256", secret).update(rawBody).digest("hex");
    return safeEqual(expected, signature);
  }

  async createOrder(amountPaise: number, receipt: string) {
    // payment_capture asks Razorpay to capture as soon as the customer pays; ensureCaptured is the backstop.
    return this.request<{ id: string; amount: number; currency: string }>("POST", "/orders", {
      amount: amountPaise,
      currency: "INR",
      receipt,
      payment_capture: 1,
    });
  }

  /**
   * A valid signature only proves the customer authorised the payment. This confirms the money is
   * captured for this exact Razorpay order and amount, capturing it if the account is on manual capture.
   */
  async ensureCaptured(paymentId: string, razorpayOrderId: string, amountPaise: number) {
    const unconfirmed = "We could not confirm your payment with Razorpay yet. Please do not pay again; try again in a minute.";
    let payment: RazorpayPayment;
    try {
      payment = await this.request<RazorpayPayment>("GET", `/payments/${paymentId}`);
    } catch {
      throw new PaymentNotConfirmedException(unconfirmed);
    }
    if (payment.order_id !== razorpayOrderId || payment.amount !== amountPaise || payment.currency !== "INR") {
      throw new PaymentNotConfirmedException("This payment does not match the order. Contact the studio and quote your payment ID.");
    }
    if (payment.status === "captured") return;
    if (payment.status !== "authorized") throw new PaymentNotConfirmedException("The payment was not completed.");
    try {
      await this.request("POST", `/payments/${paymentId}/capture`, { amount: amountPaise, currency: "INR" });
    } catch {
      throw new PaymentNotConfirmedException(unconfirmed);
    }
  }

  /** Starts a refund and reports what happened, so the caller can record it. Never throws. */
  async refund(paymentId: string, amountPaise: number): Promise<RefundResult> {
    if (!this.configured()) return { status: "failed", note: "Razorpay is not configured, so the refund could not be started." };
    try {
      const refund = await this.request<{ id: string; status?: string }>("POST", `/payments/${paymentId}/refund`, { amount: amountPaise });
      console.log(`[pay] Refund ${refund.id} started for ${paymentId}.`);
      return {
        status: refund.status === "processed" ? "refunded" : "pending",
        id: refund.id,
        note: refund.status === "processed" ? "Refunded by Razorpay." : "Refund started with Razorpay.",
      };
    } catch (error) {
      console.error(`[pay] Refund failed for ${paymentId}.`, error);
      return { status: "failed", note: error instanceof Error ? error.message : "Razorpay refused the refund." };
    }
  }

  private async request<T>(method: "GET" | "POST", path: string, body?: Record<string, unknown>): Promise<T> {
    const key = this.keyId();
    const secret = process.env.RAZORPAY_KEY_SECRET?.trim() || "";
    let response: Response;
    try {
      response = await fetch(`https://api.razorpay.com/v1${path}`, {
        method,
        headers: {
          authorization: `Basic ${Buffer.from(`${key}:${secret}`).toString("base64")}`,
          ...(body ? { "content-type": "application/json" } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch (error) {
      console.error("[pay] Razorpay could not be reached", error);
      throw new BadRequestException("The payment service could not be reached. Try again in a moment.");
    }
    const data = (await response.json().catch(() => ({}))) as T & { error?: { description?: string } };
    if (!response.ok) {
      console.error("[pay] Razorpay refused the request", data);
      throw new BadRequestException(data.error?.description || "The payment service refused the request.");
    }
    return data;
  }
}

function safeEqual(left: string, right: string) {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}
