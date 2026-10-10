import { hash } from "bcryptjs";
import { PrismaClient, type Prisma } from "@prisma/client";
import { products } from "../../lib/catalog";

const prisma = new PrismaClient();

const settings = {
  freeShippingAt: 1999,
  standardShipping: 99,
  expressShipping: 149,
  deliveryEstimate: "3–5 days",
  codEnabled: true,
  codFee: 40,
  codMax: 10000,
  returnWindowDays: 7,
  refundMethod: "Original payment",
  exchanges: true,
  businessName: "Earthen",
  gstin: "29AABCE1234F1Z5",
  pricesIncludeGst: true,
};

async function main() {
  for (const product of products) {
    await prisma.product.upsert({
      where: { slug: product.slug },
      create: {
        slug: product.slug,
        name: product.name,
        price: product.price,
        category: product.category,
        fabric: product.fabric,
        description: product.description,
        details: product.details,
        care: product.care,
        rating: product.rating,
        reviewCount: product.reviewCount,
        isNew: Boolean(product.isNew),
        reviews: product.reviews,
        colors: product.colors,
        sizes: product.sizes,
        stock: product.stock,
        status: "active",
      },
      update: {},
    });
  }

  const password = await hash("quietclothes", 10);
  await prisma.customer.upsert({
    where: { email: "aisha@earthen.in" },
    create: {
      name: "Aisha Menon",
      email: "aisha@earthen.in",
      phone: "9876543210",
      passwordHash: password,
      addresses: [
        {
          id: "addr-home",
          label: "Home",
          name: "Aisha Menon",
          phone: "9876543210",
          line1: "14, Coconut Avenue",
          line2: "Indiranagar",
          city: "Bengaluru",
          state: "Karnataka",
          pin: "560038",
          isDefault: true,
        },
      ],
    },
    update: {},
  });

  const studio = await hash("studio", 10);
  const staff = [
    { id: "staff-owner", name: "Sai", email: "owner@earthen.in", role: "Owner" },
    { id: "staff-catalog", name: "Anika Rao", email: "catalog@earthen.in", role: "Catalog manager" },
    { id: "staff-orders", name: "Kabir Sen", email: "orders@earthen.in", role: "Order and support" },
  ];
  for (const member of staff) {
    await prisma.staff.upsert({
      where: { email: member.email },
      create: { ...member, passwordHash: studio },
      update: {},
    });
  }

  const coupons = [
    { code: "WELCOME10", type: "percent", value: 10, minOrder: 0, usageLimit: 500, used: 0, starts: "", ends: "", active: true },
    { code: "EARTHEN200", type: "fixed", value: 200, minOrder: 1999, usageLimit: 200, used: 0, starts: "", ends: "", active: true },
    { code: "FREESHIP", type: "free_shipping", value: 0, minOrder: 0, usageLimit: 200, used: 0, starts: "", ends: "", active: true },
  ];
  for (const coupon of coupons) {
    await prisma.coupon.upsert({ where: { code: coupon.code }, create: coupon, update: {} });
  }

  await prisma.banner.upsert({
    where: { id: "banner-aw26" },
    create: {
      id: "banner-aw26",
      title: "Autumn / Winter 2026",
      subtitle: "Quiet clothes for every day",
      href: "/shop?category=new",
      starts: "",
      ends: "",
    },
    update: {},
  });

  await prisma.setting.upsert({
    where: { id: "store" },
    create: { id: "store", data: settings as Prisma.InputJsonValue },
    update: {},
  });

  await prisma.sequence.upsert({
    where: { id: "order" },
    create: { id: "order", value: 10423 },
    update: {},
  });

  const aisha = await prisma.customer.findUnique({ where: { email: "aisha@earthen.in" } });
  const daysAgo = (days: number) => new Date(Date.now() - days * 86400000).toISOString();
  const orders = [
    {
      id: "order-seed",
      number: "EH-10421",
      createdAt: new Date(daysAgo(4)),
      email: "aisha@earthen.in",
      phone: "9876543210",
      address: { id: "addr-home", name: "Aisha Menon", phone: "9876543210", line1: "14, Coconut Avenue", line2: "Indiranagar", city: "Bengaluru", state: "Karnataka", pin: "560038" },
      items: [{ slug: "knit-cardigan", name: "Knit Cardigan", price: 3890, color: "Moss", hex: "#8A9168", size: "M", quantity: 1 }],
      delivery: "standard",
      payment: "upi",
      subtotal: 3890,
      discount: 0,
      shipping: 0,
      codFee: 0,
      total: 3890,
      status: "Delivered",
      timeline: [
        { status: "Confirmed", date: daysAgo(4) },
        { status: "Delivered", date: daysAgo(2) },
      ],
      customerId: aisha?.id,
    },
    {
      id: "order-pack",
      number: "EH-10423",
      createdAt: new Date(daysAgo(1)),
      email: "leela@example.com",
      phone: "9811122233",
      address: { name: "Leela Nair", phone: "9811122233", line1: "14, Coconut Avenue", line2: "", city: "Kochi", state: "Kerala", pin: "682001" },
      items: [{ slug: "linen-overshirt", name: "Linen Overshirt", price: 3499, color: "Olive", hex: "#6E764E", size: "M", quantity: 1 }],
      delivery: "standard",
      payment: "upi",
      subtotal: 3499,
      discount: 0,
      shipping: 0,
      codFee: 0,
      total: 3499,
      status: "Packed",
      timeline: [
        { status: "Confirmed", date: daysAgo(1) },
        { status: "Packed", date: daysAgo(0) },
      ],
    },
  ];
  for (const order of orders) {
    await prisma.order.upsert({
      where: { id: order.id },
      create: order,
      update: {},
    });
  }
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (error) => {
    console.error(error);
    await prisma.$disconnect();
    process.exit(1);
  });
