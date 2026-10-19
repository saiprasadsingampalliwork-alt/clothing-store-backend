import { Inject, Injectable, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { livePrice } from "./pricing";
import { PrismaService } from "./prisma.service";
import { WhatsAppService, type WhatsAppOrder } from "./whatsapp.service";

const HOUR = 60 * 60 * 1000;
const NOT_BOUGHT = new Set(["Cancelled", "Returned"]);

type CartLine = { slug?: string; name?: string; color?: string; size?: string; quantity?: number; price?: number };
type WishLine = { slug?: string; color?: string };

export function nudgeAfterMs() {
  const minutes = Number(process.env.WHATSAPP_NUDGE_MINUTES ?? 60);
  if (!Number.isFinite(minutes) || minutes < 1) return HOUR;
  return minutes * 60 * 1000;
}

export function cartKey(cart: unknown) {
  if (!Array.isArray(cart)) return "";
  return cart
    .map((item) => {
      const line = item as CartLine;
      const quantity = Math.max(0, Math.round(Number(line.quantity) || 0));
      if (!line.slug || quantity < 1) return "";
      return [line.slug, line.color ?? "", line.size ?? "", quantity].join("|");
    })
    .filter(Boolean)
    .sort()
    .join(";");
}

export function wishlistKey(wishlist: unknown) {
  if (!Array.isArray(wishlist)) return "";
  return wishlist
    .map((item) => {
      const line = item as WishLine;
      if (!line.slug) return "";
      return [line.slug, line.color ?? ""].join("|");
    })
    .filter(Boolean)
    .sort()
    .join(";");
}

@Injectable()
export class NudgesService implements OnModuleInit, OnModuleDestroy {
  private timer: NodeJS.Timeout | undefined;
  private running = false;
  private notedWaiting = false;

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(WhatsAppService) private readonly whatsapp: WhatsAppService,
  ) {}

  onModuleInit() {
    void this.remindDue();
    this.timer = setInterval(() => {
      void this.remindDue();
    }, 60_000);
    this.timer.unref?.();
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  async remindDue(now = new Date()) {
    if (this.running) return;
    this.running = true;
    try {
      if (!this.whatsapp.configured()) {
        if (!this.notedWaiting) {
          console.log("[whatsapp] WhatsApp is not configured. Bag and wishlist reminders are waiting.");
          this.notedWaiting = true;
        }
        return;
      }
      const cutoff = new Date(now.getTime() - nudgeAfterMs());
      const customers = await this.prisma.customer.findMany({
        where: {
          blocked: false,
          OR: [{ cartUpdatedAt: { lte: cutoff } }, { wishlistUpdatedAt: { lte: cutoff } }],
        },
      });
      if (customers.length === 0) return;
      const idByEmail = new Map(customers.map((customer) => [customer.email, customer.id]));
      const orders = await this.prisma.order.findMany({
        where: {
          OR: [{ customerId: { in: customers.map((customer) => customer.id) } }, { email: { in: [...idByEmail.keys()] } }],
        },
        select: { customerId: true, email: true, status: true, items: true },
      });
      const ids = new Set(customers.map((customer) => customer.id));
      const bought = new Map<string, Set<string>>();
      for (const order of orders) {
        const ownerId = order.customerId && ids.has(order.customerId) ? order.customerId : idByEmail.get(order.email);
        if (!ownerId || NOT_BOUGHT.has(order.status)) continue;
        const set = bought.get(ownerId) ?? new Set<string>();
        for (const item of Array.isArray(order.items) ? order.items : []) {
          const line = item as { slug?: string; color?: string };
          if (line.slug) set.add(`${line.slug}|${line.color ?? ""}`);
        }
        bought.set(ownerId, set);
      }
      const slugs = new Set<string>();
      for (const customer of customers) {
        for (const item of [...asArray(customer.cart), ...asArray(customer.wishlist)]) {
          const slug = (item as { slug?: string }).slug;
          if (slug) slugs.add(slug);
        }
      }
      const products = await this.prisma.product.findMany({ where: { slug: { in: [...slugs] } } });
      const bySlug = new Map(products.map((product) => [product.slug, product]));
      const settings = await this.prisma.setting.findUnique({ where: { id: "store" } });
      const sale = (settings?.data ?? {}) as { saleEnabled?: boolean; salePercent?: number; saleStart?: string; saleEnd?: string };

      for (const customer of customers) {
        const key = cartKey(customer.cart);
        if (customer.cartUpdatedAt && customer.cartUpdatedAt <= cutoff && key && key !== customer.cartRemindedKey) {
          const items = pricedCart(customer.cart, bySlug, sale);
          if (items.length === 0) {
            await this.prisma.customer.update({ where: { id: customer.id }, data: { cartRemindedKey: key } });
          } else {
            await this.markAndSend(customer.id, "cartRemindedKey", key, () =>
              this.whatsapp.cartWaiting(
                customer.phone,
                customer.name,
                items,
                items.reduce((sum, item) => sum + item.lineTotal, 0),
              ),
            );
          }
        }
        const wishKey = wishlistKey(customer.wishlist);
        const owned = bought.get(customer.id) ?? new Set<string>();
        const waiting = waitingWishlist(customer.wishlist, owned, bySlug);
        const remindKey = waiting.length === 0 ? wishKey : wishlistKey(waiting);
        if (customer.wishlistUpdatedAt && customer.wishlistUpdatedAt <= cutoff && wishKey && remindKey !== customer.wishlistRemindedKey) {
          if (waiting.length === 0) {
            await this.prisma.customer.update({ where: { id: customer.id }, data: { wishlistRemindedKey: wishKey } });
          } else {
            await this.markAndSend(customer.id, "wishlistRemindedKey", remindKey, () =>
              this.whatsapp.wishlistWaiting(customer.phone, customer.name, waiting),
            );
          }
        }
      }
    } catch (error) {
      console.error("[whatsapp] Could not check bag and wishlist reminders", error);
    } finally {
      this.running = false;
    }
  }

  private async markAndSend(
    id: string,
    field: "cartRemindedKey" | "wishlistRemindedKey",
    key: string,
    send: () => Promise<{ sent: boolean; skipped: boolean }>,
  ) {
    await this.prisma.customer.update({ where: { id }, data: { [field]: key } });
    const result = await send();
    if (!result.sent && !result.skipped) {
      await this.prisma.customer.update({ where: { id }, data: { [field]: "" } });
    }
  }
}

function asArray(value: unknown) {
  return Array.isArray(value) ? value : [];
}

function pricedCart(
  cart: unknown,
  bySlug: Map<string, { slug: string; name: string; price: number; salePrice: number | null; saleStart: string; saleEnd: string }>,
  sale: { saleEnabled?: boolean; salePercent?: number; saleStart?: string; saleEnd?: string },
) {
  const items: (WhatsAppOrder["items"][number] & { lineTotal: number })[] = [];
  for (const raw of asArray(cart)) {
    const line = raw as CartLine;
    const quantity = Math.max(0, Math.round(Number(line.quantity) || 0));
    if (!line.slug || quantity < 1) continue;
    const product = bySlug.get(line.slug);
    const name = product?.name || line.name || "";
    if (!name.trim()) continue;
    const price = product ? livePrice(product, sale) : Math.max(0, Math.round(Number(line.price) || 0));
    items.push({
      name,
      color: line.color || "",
      size: line.size || "",
      quantity,
      lineTotal: price * quantity,
    });
  }
  return items;
}

function waitingWishlist(
  wishlist: unknown,
  owned: Set<string>,
  bySlug: Map<string, { name: string }>,
) {
  const items: { slug: string; color: string; name: string }[] = [];
  for (const raw of asArray(wishlist)) {
    const line = raw as WishLine;
    if (!line.slug || owned.has(`${line.slug}|${line.color ?? ""}`)) continue;
    const name = bySlug.get(line.slug)?.name;
    if (!name) continue;
    items.push({ slug: line.slug, color: line.color ?? "", name });
  }
  return items;
}
