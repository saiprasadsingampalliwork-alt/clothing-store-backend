import { applyStoreSale, type SaleRules } from "../../lib/sale";

export type CouponRecord = {
  code: string;
  type: "percent" | "fixed" | "free_shipping";
  value: number;
  minOrder: number;
  usageLimit: number;
  used: number;
  starts: string;
  ends: string;
  active: boolean;
};

export type ShippingRules = {
  freeShippingAt: number;
  standardShipping: number;
  expressShipping: number;
  codEnabled: boolean;
  codFee: number;
  codMax: number;
  returnWindowDays: number;
};

export function livePrice(product: { price: number; salePrice: number | null; saleStart: string; saleEnd: string }, sale?: SaleRules) {
  const today = new Date().toISOString().slice(0, 10);
  const saleLive =
    typeof product.salePrice === "number" &&
    product.salePrice > 0 &&
    (!product.saleStart || today >= product.saleStart) &&
    (!product.saleEnd || today <= product.saleEnd);
  const current = saleLive ? product.salePrice! : product.price;
  return sale ? applyStoreSale(product.price, current, sale) : current;
}

export function evaluateCoupon(coupon: CouponRecord, subtotal: number): { ok: true; discount: number } | { ok: false; reason: string } {
  const today = new Date().toISOString().slice(0, 10);
  if (!coupon.active) return { ok: false, reason: "That coupon is not active." };
  if (coupon.starts && today < coupon.starts) return { ok: false, reason: "That coupon is not active yet." };
  if (coupon.ends && today > coupon.ends) return { ok: false, reason: "That coupon has expired." };
  if (coupon.usageLimit > 0 && coupon.used >= coupon.usageLimit) return { ok: false, reason: "That coupon has reached its usage limit." };
  if (subtotal < coupon.minOrder) return { ok: false, reason: `${coupon.code} needs an order of ₹${coupon.minOrder.toLocaleString("en-IN")} or more.` };
  if (coupon.type === "percent") return { ok: true, discount: Math.round(subtotal * (coupon.value / 100)) };
  if (coupon.type === "fixed") return { ok: true, discount: Math.min(coupon.value, subtotal) };
  return { ok: true, discount: 0 };
}

export function shippingFee(subtotalAfterDiscount: number, method: "standard" | "express", freeShipCoupon: boolean, rules: ShippingRules) {
  if (freeShipCoupon) return 0;
  if (method === "express") return rules.expressShipping;
  return subtotalAfterDiscount >= rules.freeShippingAt ? 0 : rules.standardShipping;
}
