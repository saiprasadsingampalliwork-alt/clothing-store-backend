import { Injectable } from "@nestjs/common";
import type { OrderMail } from "./mail.service";

const PRODUCT_LIMIT = 700;
const MISSING = "not added yet";

export type WhatsAppOrder = {
  phone: string;
  number: string;
  name: string;
  items: { name: string; color: string; size: string; quantity: number }[];
  total: number;
  payment: string;
  delivery: string;
  courier?: string;
  tracking?: string;
};

type Template = { name: string; parameters: string[] };

@Injectable()
export class WhatsAppService {
  configured() {
    return Boolean(process.env.WHATSAPP_TOKEN?.trim() && process.env.WHATSAPP_PHONE_NUMBER_ID?.trim());
  }

  async order(kind: OrderMail, order: WhatsAppOrder) {
    const template = orderTemplate(kind, order);
    const to = whatsappPhone(order.phone);
    if (!to) {
      console.log(`[whatsapp] Skipped “${template.name}” for ${displayNumber(order.number)}. The mobile is not a 10-digit number.`);
      return { sent: false, skipped: true };
    }
    return this.sendTemplate(to, template.name, template.parameters);
  }

  async passwordCode(phone: string, code: string) {
    return this.oneTimeCode(phone, "earthen_password_otp", code);
  }

  async signInCode(phone: string, code: string) {
    return this.oneTimeCode(phone, "earthen_sign_in_otp", code);
  }

  async cartWaiting(phone: string, name: string, items: WhatsAppOrder["items"], total: number) {
    return this.namedPieces(phone, "earthen_cart_waiting", name, [productLine(items), inr(total)]);
  }

  async wishlistWaiting(phone: string, name: string, items: { name: string; color: string }[]) {
    return this.namedPieces(phone, "earthen_wishlist_waiting", name, [savedLine(items)]);
  }

  private async namedPieces(phone: string, template: string, name: string, rest: string[]) {
    const to = whatsappPhone(phone);
    if (!to) {
      console.log(`[whatsapp] Skipped “${template}”. The mobile is not a 10-digit number.`);
      return { sent: false, skipped: true };
    }
    return this.sendTemplate(to, template, [customerName(name), ...rest]);
  }

  private async oneTimeCode(phone: string, template: string, code: string) {
    const to = whatsappPhone(phone);
    if (!to) {
      console.log(`[whatsapp] Skipped “${template}”. The mobile is not a 10-digit number.`);
      return { sent: false, skipped: true };
    }
    return this.sendTemplate(to, template, [templateParam(code)]);
  }

  private async sendTemplate(to: string, name: string, parameters: string[]) {
    if (!this.configured()) {
      console.log(`[whatsapp] WhatsApp is not configured. Skipped “${name}” to ${to}`);
      return { sent: false, skipped: true };
    }
    const version = process.env.WHATSAPP_API_VERSION?.trim() || "v21.0";
    const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID!.trim();
    try {
      const response = await fetch(`https://graph.facebook.com/${version}/${phoneNumberId}/messages`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${process.env.WHATSAPP_TOKEN!.trim()}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          messaging_product: "whatsapp",
          to,
          type: "template",
          template: {
            name,
            language: { code: "en" },
            components: [{ type: "body", parameters: parameters.map((text) => ({ type: "text", text })) }],
          },
        }),
        signal: AbortSignal.timeout(10000),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        console.error(`[whatsapp] Could not send “${name}” to ${to}`, data);
        return { sent: false, skipped: false };
      }
      console.log(`[whatsapp] Sent “${name}” to ${to}`);
      return { sent: true, skipped: false };
    } catch (error) {
      console.error(`[whatsapp] Could not send “${name}” to ${to}`, error);
      return { sent: false, skipped: false };
    }
  }
}

export function whatsappPhone(raw: string) {
  const digits = (raw || "").replace(/\D/g, "");
  if (/^\d{10}$/.test(digits)) return `91${digits}`;
  if (/^0\d{10}$/.test(digits)) return `91${digits.slice(1)}`;
  if (/^91\d{10}$/.test(digits)) return digits;
  return null;
}

export function orderTemplate(kind: OrderMail, order: WhatsAppOrder): Template {
  const name = customerName(order.name);
  const number = displayNumber(order.number);
  const templates: Record<OrderMail, Template> = {
    confirmed: {
      name: "earthen_order_confirmed",
      parameters: [name, number, productLine(order.items), inr(order.total), paymentLine(order)],
    },
    packed: { name: "earthen_order_packed", parameters: [name, number] },
    shipped: { name: "earthen_order_shipped", parameters: [name, number, filled(order.courier), filled(order.tracking)] },
    out: { name: "earthen_order_out", parameters: [name, number] },
    delivered: { name: "earthen_order_delivered", parameters: [name, number] },
    cancelled: {
      name: "earthen_order_cancelled",
      parameters: [name, number, order.payment === "cod" ? "Cash on delivery has nothing to refund" : "The refund goes back to the original payment method"],
    },
    "return-requested": { name: "earthen_return_requested", parameters: [name, number] },
    "return-approved": { name: "earthen_return_approved", parameters: [name, number] },
    "return-exchange": { name: "earthen_exchange_approved", parameters: [name, number] },
    "return-declined": { name: "earthen_return_declined", parameters: [name, number] },
    returned: { name: "earthen_order_returned", parameters: [name, number] },
  };
  return templates[kind];
}

export function savedLine(items: { name: string; color: string }[]) {
  return joinedLine(
    items.filter((item) => item.name?.trim()).map((item) => (item.color?.trim() ? `${item.name}, ${item.color}` : item.name)),
  );
}

export function productLine(items: WhatsAppOrder["items"]) {
  return joinedLine(
    items.filter((item) => item.name?.trim()).map((item) => `${item.name}, ${item.color}, size ${item.size}, ×${item.quantity}`),
  );
}

function joinedLine(raw: string[]) {
  const parts = raw.map((part) => templateParam(part)).filter((part) => part !== MISSING);
  if (parts.length === 0) return MISSING;
  if (parts.join("; ").length <= PRODUCT_LIMIT) return parts.join("; ");
  const kept: string[] = [];
  for (const part of parts) {
    const remaining = parts.length - kept.length - 1;
    const next = [...kept, part].join("; ");
    const withTail = remaining > 0 ? `${next}; and ${remaining} more` : next;
    if (withTail.length > PRODUCT_LIMIT) break;
    kept.push(part);
  }
  if (kept.length === 0) {
    const extra = parts.length > 1 ? `; and ${parts.length - 1} more` : "";
    return clip(`${parts[0]}${extra}`, PRODUCT_LIMIT);
  }
  const hidden = parts.length - kept.length;
  return hidden > 0 ? `${kept.join("; ")}; and ${hidden} more` : kept.join("; ");
}

function customerName(name: string) {
  const flat = (name || "").replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").trim();
  return flat || "there";
}

function filled(value: string | undefined) {
  return templateParam(value || "");
}

export function templateParam(value: string) {
  const flat = value.replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").trim();
  return flat || MISSING;
}

function clip(value: string, limit: number) {
  if (value.length <= limit) return value;
  return `${value.slice(0, Math.max(0, limit - 1)).trimEnd()}…`;
}

function displayNumber(number: string) {
  return `#${number.replace(/^EH-/, "EA-")}`;
}

function inr(amount: number) {
  return new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 0 }).format(amount);
}

function paymentLine(order: WhatsAppOrder) {
  const method = order.payment === "card" ? "Card" : order.payment === "netbanking" ? "Net banking" : order.payment === "cod" ? "Cash on delivery" : "UPI";
  const speed = order.delivery === "express" ? "Express" : "Standard";
  const paid = order.payment === "cod" ? "Cash on delivery" : `Paid by ${method}`;
  return templateParam(`${paid} · ${speed} delivery`);
}
