import { createHash, randomBytes } from "crypto";
import { Injectable } from "@nestjs/common";
import nodemailer from "nodemailer";

const RESET_MINUTES = 30;

export type MailItem = { name: string; color: string; size: string; quantity: number; price: number };

export type MailOrder = {
  email: string;
  number: string;
  name: string;
  items: MailItem[];
  total: number;
  payment: string;
  delivery: string;
  lines: string[];
  courier?: string;
  tracking?: string;
  trackingUrl?: string;
};

export type OrderMail =
  | "confirmed"
  | "packed"
  | "shipped"
  | "out"
  | "delivered"
  | "cancelled"
  | "return-requested"
  | "return-approved"
  | "return-exchange"
  | "return-declined"
  | "returned";

@Injectable()
export class MailService {
  configured() {
    return Boolean(process.env.SMTP_HOST?.trim());
  }

  appUrl() {
    return (process.env.APP_URL || "http://localhost:3000").replace(/\/$/, "");
  }

  resetMinutes() {
    return RESET_MINUTES;
  }

  newResetToken() {
    const token = randomBytes(32).toString("base64url");
    return { token, tokenHash: hashToken(token), expiresAt: new Date(Date.now() + RESET_MINUTES * 60 * 1000) };
  }

  async passwordReset(email: string, url: string) {
    return this.send({
      to: email,
      subject: "Reset your Earthen password",
      text: [`Set a new Earthen password.`, ``, url, ``, `This link expires in ${RESET_MINUTES} minutes. If you did not ask for it, you can ignore this email.`, ``, signoff()].join("\n"),
    });
  }

  async restockNoted(email: string, product: string, color: string, size: string) {
    return this.send({
      to: email,
      subject: `We'll tell you when the ${product} is back`,
      text: [`We'll email you when the ${product} in ${color}, size ${size}, is back in the shop.`, ``, `Nothing else will come from this note.`, ``, signoff()].join("\n"),
    });
  }

  async restockBack(email: string, product: string, color: string, size: string, url: string) {
    return this.send({
      to: email,
      subject: `The ${product} in ${color}, size ${size}, is back`,
      text: [`The ${product} in ${color}, size ${size}, is back in the shop.`, ``, url, ``, signoff()].join("\n"),
    });
  }

  async order(kind: OrderMail, order: MailOrder) {
    const message = orderMessage(kind, order);
    await this.send({ to: order.email, ...message });
  }

  private async send(message: { to: string; subject: string; text: string }) {
    if (!this.configured()) {
      console.log(`[mail] SMTP is not configured. Skipped “${message.subject}” to ${message.to}`);
      return { sent: false, skipped: true };
    }
    try {
      const port = Number(process.env.SMTP_PORT || 587);
      const user = process.env.SMTP_USER?.trim();
      const transport = nodemailer.createTransport({
        host: process.env.SMTP_HOST,
        port,
        secure: port === 465,
        auth: user ? { user, pass: process.env.SMTP_PASS ?? "" } : undefined,
        connectionTimeout: 10000,
      });
      await transport.sendMail({
        from: process.env.SMTP_FROM?.trim() || "Earthen <hello@earthen.in>",
        to: message.to,
        subject: message.subject,
        text: message.text,
      });
      console.log(`[mail] Sent “${message.subject}” to ${message.to}`);
      return { sent: true, skipped: false };
    } catch (error) {
      console.error(`[mail] Could not send “${message.subject}” to ${message.to}`, error);
      return { sent: false, skipped: false };
    }
  }
}

export function hashToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

export function orderMessage(kind: OrderMail, order: MailOrder) {
  const code = displayNumber(order.number);
  const greeting = order.name ? `${order.name},` : "Hello,";
  const pieces = order.items
    .map((item) => `${item.name}\n${item.color} · size ${item.size} · × ${item.quantity} · ${inr(item.price * item.quantity)}`)
    .join("\n\n");
  const summary = [`Total ${inr(order.total)}`, `${paymentLabel(order.payment)} · ${order.delivery === "express" ? "Express" : "Standard"} delivery`, ``, ...order.lines.filter(Boolean)].join("\n");
  const lead: Record<OrderMail, string> = {
    confirmed: `Your order ${code} is confirmed.`,
    packed: `Your order ${code} is packed and will leave the studio in Bengaluru shortly.`,
    shipped: `Your order ${code} has shipped.`,
    out: `Your order ${code} is out for delivery.`,
    delivered: `Your order ${code} was delivered.`,
    cancelled: `Your order ${code} was cancelled.`,
    "return-requested": `We have your return request for ${code}.`,
    "return-approved": `Your return for ${code} was approved.`,
    "return-exchange": `Your exchange for ${code} was approved.`,
    "return-declined": `Your return for ${code} was declined.`,
    returned: `Your order ${code} was marked returned.`,
  };
  const extra: Record<OrderMail, string> = {
    confirmed: "",
    packed: "",
    shipped: [order.courier ? `Courier: ${order.courier}` : "", order.tracking ? `Tracking: ${order.tracking}` : "", order.trackingUrl || ""].filter(Boolean).join("\n"),
    out: "",
    delivered: "You have 7 days to return or exchange a piece. Start from the order page.",
    cancelled: order.payment === "cod" ? "Cash on delivery has nothing to refund." : "The refund goes back to the original payment method.",
    "return-requested": "We will arrange the pickup and write again when it is decided.",
    "return-approved": "The refund goes back to the original payment method.",
    "return-exchange": "We will send the replacement from the studio.",
    "return-declined": "The order stays with you. Write to hello@earthen.in if this is a mistake.",
    returned: "",
  };
  const subject: Record<OrderMail, string> = {
    confirmed: `Your Earthen order ${code} is confirmed`,
    packed: `Your Earthen order ${code} is packed`,
    shipped: `Your Earthen order ${code} has shipped`,
    out: `Your Earthen order ${code} is out for delivery`,
    delivered: `Your Earthen order ${code} was delivered`,
    cancelled: `Your Earthen order ${code} was cancelled`,
    "return-requested": `Return request received for ${code}`,
    "return-approved": `Return approved for ${code}`,
    "return-exchange": `Exchange approved for ${code}`,
    "return-declined": `Return declined for ${code}`,
    returned: `Your Earthen order ${code} was marked returned`,
  };
  const body = [greeting, ``, lead[kind], extra[kind], ``, pieces, ``, summary, ``, signoff()].filter((line) => line !== "").join("\n");
  return { subject: subject[kind], text: body.replace(/\n{3,}/g, "\n\n") };
}

function displayNumber(number: string) {
  return `#${number.replace(/^EH-/, "EA-")}`;
}

function inr(amount: number) {
  return new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 0 }).format(amount);
}

function paymentLabel(payment: string) {
  if (payment === "card") return "Card";
  if (payment === "netbanking") return "Net banking";
  if (payment === "cod") return "Cash on delivery";
  return "UPI";
}

function signoff() {
  return "Earthen\nhello@earthen.in";
}
