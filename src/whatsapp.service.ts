import crypto from "node:crypto";
import { Inject, Injectable } from "@nestjs/common";
import { MailService, type OrderMail } from "./mail.service";
import { PrismaService } from "./prisma.service";

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
  /** cod, paid, demo, or free; decides the payment and refund wording. */
  paymentStatus?: string;
  /** "", pending, refunded, or failed. */
  refundStatus?: string;
};

export type WhatsAppWebhookResult = {
  echoes: number;
  inbound: number;
  statuses: number;
  coexEvents: number;
};

type Template = { name: string; parameters: string[] };

@Injectable()
export class WhatsAppService {
  // Meta retries webhooks, so the same inbound message can arrive more than once.
  private readonly seen = new Set<string>();

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(MailService) private readonly mail: MailService,
  ) {}

  configured() {
    return Boolean(process.env.WHATSAPP_TOKEN?.trim() && process.env.WHATSAPP_PHONE_NUMBER_ID?.trim());
  }

  verifyWebhook(mode?: string, token?: string, challenge?: string): string | null {
    const expectedToken = process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN?.trim();
    if (!expectedToken) {
      console.warn("[whatsapp] WHATSAPP_WEBHOOK_VERIFY_TOKEN is not configured.");
      return null;
    }
    if (mode === "subscribe" && token === expectedToken && challenge) {
      console.log("[whatsapp] Webhook subscription verified successfully.");
      return challenge;
    }
    return null;
  }

  /** Webhooks are accepted only when signed with the app secret; without one, nothing is trusted. */
  verifySignature(rawBody?: Buffer | string, signatureHeader?: string): boolean {
    const secret = process.env.WHATSAPP_APP_SECRET?.trim();
    if (!secret) {
      console.warn("[whatsapp] WHATSAPP_APP_SECRET is not configured, so webhooks are refused.");
      return false;
    }
    if (!signatureHeader || !rawBody) return false;
    const signature = signatureHeader.startsWith("sha256=") ? signatureHeader.slice(7) : signatureHeader;
    const expected = crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
    const a = Buffer.from(signature, "hex");
    const b = Buffer.from(expected, "hex");
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }

  async processWebhook(payload: any): Promise<WhatsAppWebhookResult> {
    const summary: WhatsAppWebhookResult = { echoes: 0, inbound: 0, statuses: 0, coexEvents: 0 };
    if (!payload || payload.object !== "whatsapp_business_account" || !Array.isArray(payload.entry)) {
      return summary;
    }

    for (const entry of payload.entry) {
      const changes = Array.isArray(entry.changes) ? entry.changes : [];
      for (const change of changes) {
        const field = change.field;
        const value = change.value;
        if (!value) continue;

        // Coexistence: the number's link between the WhatsApp Business app and the Cloud API changed.
        if (field === "account_update") {
          summary.coexEvents++;
          // The same event can be delivered again; the studio should get one alert, not several.
          const key = `account:${entry.id}:${value.event}:${value.timestamp ?? entry.time ?? ""}:${value.disconnection_info?.reason ?? ""}`;
          if (this.seen.has(key)) continue;
          this.remember(key);
          await this.accountUpdate(value, entry.id);
          continue;
        }

        // Coexistence: one-time chat history and contact sync. Nothing here keeps a chat inbox, so these are only noted.
        if (field === "history" || field === "smb_app_state_sync") {
          summary.coexEvents++;
          console.log(`[whatsapp:coex] ${field} update received for ${entry.id}.`);
          continue;
        }

        // Coexistence: messages staff send from the WhatsApp Business app on the phone.
        const echoes = Array.isArray(value.message_echoes) ? value.message_echoes : [];
        for (const echo of echoes) {
          summary.echoes++;
          console.log(`[whatsapp:echo] Studio replied from the Business app to ${echo.to}: “${echo.text?.body || echo.type || "message"}”`);
        }

        const messages = Array.isArray(value.messages) ? value.messages : [];
        const contacts = Array.isArray(value.contacts) ? value.contacts : [];
        const names = new Map<string, string>();
        for (const contact of contacts) {
          if (contact.wa_id && contact.profile?.name) names.set(contact.wa_id, contact.profile.name);
        }
        for (const message of messages) {
          if (!message.id || this.seen.has(message.id)) continue;
          this.remember(message.id);
          summary.inbound++;
          await this.inbound(message, names.get(message.from) || "Customer");
        }

        const statuses = Array.isArray(value.statuses) ? value.statuses : [];
        for (const status of statuses) {
          summary.statuses++;
          await this.status(status);
        }
      }
    }
    return summary;
  }

  private remember(key: string) {
    this.seen.add(key);
    // Keep the most recent 2000; Sets iterate oldest first.
    if (this.seen.size > 2000) this.seen.delete(this.seen.values().next().value as string);
  }

  /** A customer wrote to the shop's number. STOP and START change reminder consent; everything else goes to the studio's inbox. */
  private async inbound(message: any, sender: string) {
    const content =
      message.type === "text"
        ? message.text?.body || ""
        : message.type === "interactive"
          ? message.interactive?.button_reply?.title || message.interactive?.list_reply?.title || "[interactive reply]"
          : message.type === "button"
            ? message.button?.text || "[button click]"
            : `[${message.type || "media"}]`;
    const word = content.trim().toUpperCase();
    if (["STOP", "UNSUBSCRIBE", "STOP ALL"].includes(word)) {
      const count = await this.setOptIn(message.from, false);
      console.log(`[whatsapp:inbound] ${message.from} asked to stop reminders (${count} account${count === 1 ? "" : "s"} updated).`);
      return;
    }
    if (word === "START") {
      const count = await this.setOptIn(message.from, true);
      console.log(`[whatsapp:inbound] ${message.from} asked for reminders again (${count} account${count === 1 ? "" : "s"} updated).`);
      return;
    }
    console.log(`[whatsapp:inbound] From ${sender} (${message.from}): “${content}”`);
    // Without coexistence this email is the only place the reply shows up. With coexistence the studio already sees it
    // in the WhatsApp Business app, so forwarding can be turned off with WHATSAPP_FORWARD_REPLIES=false.
    if (process.env.WHATSAPP_FORWARD_REPLIES?.trim().toLowerCase() === "false") return;
    await this.mail.toStudio(
      `WhatsApp from ${sender}`,
      [`${sender} (+${message.from}) wrote on WhatsApp:`, "", content, "", "Reply from the WhatsApp Business app or WhatsApp Manager within 24 hours."].join("\n"),
    );
  }

  private async status(status: any) {
    const errors = Array.isArray(status.errors) ? status.errors : [];
    if (!errors.length) {
      console.log(`[whatsapp:status] Message ${status.id} to ${status.recipient_id}: ${status.status}`);
      return;
    }
    for (const error of errors) {
      if (error.code === 131050) {
        // The customer stopped marketing messages in WhatsApp itself; respect it here too.
        await this.setOptIn(status.recipient_id, false);
        console.warn(`[whatsapp:status] ${status.recipient_id} has stopped marketing messages; reminders are off for them.`);
      } else if (error.code === 131056) {
        console.warn(`[whatsapp:status] Too many messages to ${status.recipient_id} in a short time (131056). Wait before messaging them again.`);
      } else if (error.code === 131049) {
        console.warn(`[whatsapp:status] Meta held back a marketing message to ${status.recipient_id} to protect engagement (131049).`);
      } else {
        console.warn(`[whatsapp:status] Message ${status.id} to ${status.recipient_id} failed: [${error.code}] ${error.title || error.message}`);
      }
    }
  }

  /** Coexistence lifecycle. A disconnected number stops all automated messages, so the studio is told at once. */
  private async accountUpdate(value: any, accountId: string) {
    const event = String(value.event || "UNKNOWN");
    const phone = value.phone_number || value.phone_number_id || accountId;
    const info = value.disconnection_info ?? {};
    const reasons: Record<string, string> = {
      ACCOUNT_DISCONNECTED: "someone disconnected it in the WhatsApp Business app",
      BUSINESS_DOWNGRADE: "the account was downgraded",
      CHANGE_NUMBER: "the number was changed in the WhatsApp Business app",
      COMPANION_INACTIVITY: "a linked device was inactive for about 30 days",
      PRIMARY_INACTIVITY: "the phone with the WhatsApp Business app was inactive for about 14 days",
      USER_RE_REGISTERED: "the number was registered again on another phone",
    };
    if (event === "PARTNER_REMOVED" || event === "ACCOUNT_OFFBOARDED") {
      const why = reasons[info.reason] ?? (event === "ACCOUNT_OFFBOARDED" ? "the phone was changed or the app re-registered" : "no reason was given");
      console.error(`[whatsapp:coex] ${phone} disconnected from the Cloud API (${event}): ${why}.`);
      await this.mail.toStudio(
        "WhatsApp is disconnected",
        [
          `The shop's WhatsApp number ${phone} is no longer connected to the store (${event}).`,
          `Why: ${why}${info.initiated_by ? `, started by ${String(info.initiated_by).toLowerCase()}` : ""}.`,
          "",
          "Until it is reconnected, order updates, sign-in codes, and reminders are not sent on WhatsApp.",
          "Reconnect it through your WhatsApp partner's signup flow, then open the WhatsApp Business app on the phone at least every few days.",
        ].join("\n"),
      );
      return;
    }
    if (event === "ACCOUNT_RECONNECTED") {
      console.log(`[whatsapp:coex] ${phone} is connected again.`);
      await this.mail.toStudio("WhatsApp is connected again", `The shop's WhatsApp number ${phone} is connected to the store again.`);
      return;
    }
    console.log(`[whatsapp:coex] Account update “${event}” for ${phone}.`);
  }

  /** Matches on the last 10 digits, since customers type mobiles with or without +91. */
  private async setOptIn(waId: string, optIn: boolean) {
    const national = String(waId || "").replace(/\D/g, "").slice(-10);
    if (national.length !== 10) return 0;
    const result = await this.prisma.customer.updateMany({
      where: { phone: { endsWith: national } },
      data: { whatsappOptIn: optIn, whatsappOptInAt: optIn ? new Date() : null },
    });
    return result.count;
  }

  async order(kind: OrderMail, order: WhatsAppOrder) {
    const template = orderTemplate(kind, order);
    const to = whatsappPhone(order.phone);
    if (!to) {
      console.log(`[whatsapp] Skipped “${template.name}” for ${displayNumber(order.number)}. The mobile is not a valid phone number.`);
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
      console.log(`[whatsapp] Skipped “${template}”. The mobile is not a valid phone number.`);
      return { sent: false, skipped: true };
    }
    return this.sendTemplate(to, template, [customerName(name), ...rest]);
  }

  /**
   * Authentication templates with a copy-code button need the code twice: in the body and in the button
   * (Meta's "copy code" authentication template send example).
   */
  private async oneTimeCode(phone: string, template: string, code: string) {
    const to = whatsappPhone(phone);
    if (!to) {
      console.log(`[whatsapp] Skipped “${template}”. The mobile is not a valid phone number.`);
      return { sent: false, skipped: true };
    }
    return this.sendTemplate(to, template, [templateParam(code)], [{ type: "button", sub_type: "url", index: "0", parameters: [{ type: "text", text: code }] }]);
  }

  private async sendTemplate(to: string, name: string, parameters: string[], extra: Record<string, unknown>[] = []) {
    if (!this.configured()) {
      console.log(`[whatsapp] WhatsApp is not configured. Skipped “${name}” to ${to}`);
      return { sent: false, skipped: true };
    }
    const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID!.trim();
    try {
      const response = await fetch(`https://graph.facebook.com/${apiVersion()}/${phoneNumberId}/messages`, {
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
            // Must match the language the templates were approved in, exactly (en, en_US, en_GB…).
            language: { code: process.env.WHATSAPP_TEMPLATE_LANGUAGE?.trim() || "en" },
            components: [{ type: "body", parameters: parameters.map((text) => ({ type: "text", text })) }, ...extra],
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

// Graph API versions expire about two years after release; v21.0 ends on 21 January 2027.
function apiVersion() {
  return process.env.WHATSAPP_API_VERSION?.trim() || "v25.0";
}

export function whatsappPhone(raw: string) {
  const digits = (raw || "").replace(/\D/g, "");
  if (!digits) return null;
  if (/^\d{10}$/.test(digits)) return `91${digits}`;
  if (/^0\d{10}$/.test(digits)) return `91${digits.slice(1)}`;
  if (/^\d{11,15}$/.test(digits)) return digits;
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
      parameters: [name, number, refundLine(order)],
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
  const paid =
    order.payment === "cod"
      ? "Cash on delivery"
      : order.paymentStatus === "demo"
        ? `${method}, demo order with no payment taken`
        : order.paymentStatus === "free"
          ? "Nothing to pay"
          : `Paid by ${method}`;
  return templateParam(`${paid} · ${speed} delivery`);
}

function refundLine(order: WhatsAppOrder) {
  if (order.payment === "cod") return "Cash on delivery has nothing to refund";
  if (order.paymentStatus === "demo" || order.paymentStatus === "free") return "No payment was taken, so there is nothing to refund";
  if (order.refundStatus === "failed") return "The studio is arranging your refund and will confirm by email";
  return "Your refund has started and reaches your original payment method in 5–7 working days";
}
