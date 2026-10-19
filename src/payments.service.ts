import { createHmac, timingSafeEqual } from "crypto";
import { BadRequestException, Injectable } from "@nestjs/common";

@Injectable()
export class PaymentsService {
  configured() {
    return Boolean(process.env.RAZORPAY_KEY_ID?.trim() && process.env.RAZORPAY_KEY_SECRET?.trim());
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
    const data = await this.request<{ id: string; amount: number; currency: string }>("/orders", {
      amount: amountPaise,
      currency: "INR",
      receipt,
    });
    return data;
  }

  async refund(paymentId: string, amountPaise: number) {
    if (!this.configured()) {
      console.log(`[pay] Razorpay is not configured. Skipped a refund of ${amountPaise} paise for ${paymentId}.`);
      return;
    }
    try {
      await this.request(`/payments/${paymentId}/refund`, { amount: amountPaise });
      console.log(`[pay] Refund started for ${paymentId}.`);
    } catch (error) {
      console.error(`[pay] Refund failed for ${paymentId}.`, error);
    }
  }

  private async request<T>(path: string, body: Record<string, unknown>): Promise<T> {
    const key = this.keyId();
    const secret = process.env.RAZORPAY_KEY_SECRET?.trim() || "";
    let response: Response;
    try {
      response = await fetch(`https://api.razorpay.com/v1${path}`, {
        method: "POST",
        headers: {
          authorization: `Basic ${Buffer.from(`${key}:${secret}`).toString("base64")}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
      });
    } catch (error) {
      console.error("[pay] Razorpay could not be reached", error);
      throw new BadRequestException("Payment could not be started. Try again in a moment.");
    }
    const data = (await response.json().catch(() => ({}))) as T & { error?: { description?: string } };
    if (!response.ok) {
      console.error("[pay] Razorpay refused the request", data);
      throw new BadRequestException(data.error?.description || "Payment could not be started. Try again in a moment.");
    }
    return data;
  }
}

function safeEqual(left: string, right: string) {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}
