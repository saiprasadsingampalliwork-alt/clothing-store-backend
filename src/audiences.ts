import { BadRequestException } from "@nestjs/common";
import type { PrismaClient } from "@prisma/client";

export const GROUPS = ["adults", "kids", "baby"] as const;
export type Group = (typeof GROUPS)[number];

export const GROUP_SIZES: Record<Group, string[]> = {
  adults: ["XS", "S", "M", "L", "XL"],
  kids: ["2-3Y", "3-4Y", "4-5Y", "5-6Y", "7-8Y", "9-10Y", "11-12Y", "13-14Y"],
  baby: ["0-3M", "3-6M", "6-12M", "12-18M", "18-24M"],
};

export type AudienceRow = { slug: string; label: string; group: string; shared: boolean; sizes: unknown; active: boolean; sort: number };

// The adult audiences match the shop as it has always been. Kids and Baby are ready but switched off.
export const DEFAULT_AUDIENCES: AudienceRow[] = [
  { slug: "women", label: "Women", group: "adults", shared: false, sizes: GROUP_SIZES.adults, active: true, sort: 0 },
  { slug: "men", label: "Men", group: "adults", shared: false, sizes: GROUP_SIZES.adults, active: true, sort: 1 },
  { slug: "unisex", label: "Unisex", group: "adults", shared: true, sizes: GROUP_SIZES.adults, active: true, sort: 2 },
  { slug: "girls", label: "Girls", group: "kids", shared: false, sizes: GROUP_SIZES.kids, active: false, sort: 3 },
  { slug: "boys", label: "Boys", group: "kids", shared: false, sizes: GROUP_SIZES.kids, active: false, sort: 4 },
  { slug: "kids-unisex", label: "Kids unisex", group: "kids", shared: true, sizes: GROUP_SIZES.kids, active: false, sort: 5 },
  { slug: "baby", label: "Baby", group: "baby", shared: true, sizes: GROUP_SIZES.baby, active: false, sort: 6 },
];

/** Creates the default audiences the first time the API starts against a database without any. */
export async function ensureAudiences(prisma: PrismaClient) {
  if ((await prisma.audience.count()) > 0) return;
  await prisma.audience.createMany({ data: DEFAULT_AUDIENCES.map((row) => ({ ...row, sizes: row.sizes as string[] })) });
}

export function presentAudience(row: AudienceRow) {
  return {
    slug: row.slug,
    label: row.label,
    group: (GROUPS as readonly string[]).includes(row.group) ? row.group : "adults",
    shared: row.shared,
    sizes: cleanSizes(row.sizes) ?? GROUP_SIZES.adults,
    active: row.active,
    sort: row.sort,
  };
}

/** Sizes are short labels such as M, 4-5Y, or 0-3M. Returns null when the list is unusable. */
export function cleanSizes(value: unknown) {
  if (!Array.isArray(value)) return null;
  const seen = new Set<string>();
  const sizes: string[] = [];
  for (const item of value) {
    const size = String(item ?? "").replace(/\|/g, "").trim().replace(/\s+/g, " ").slice(0, 12);
    if (!size || seen.has(size.toLowerCase())) continue;
    seen.add(size.toLowerCase());
    sizes.push(size);
  }
  return sizes.length && sizes.length <= 20 ? sizes : null;
}

export function requireSizes(value: unknown) {
  const sizes = cleanSizes(value);
  if (!sizes) throw new BadRequestException("Add between 1 and 20 sizes, for example XS, S, M or 2-3Y, 3-4Y.");
  return sizes;
}

/**
 * Picks the audience for a product. Accepts a slug or a name ("Women", "woman", "Kids unisex"),
 * falls back to skirts for women, then the adult shared audience.
 */
export async function resolveAudience(prisma: PrismaClient, value: string | undefined, silhouette?: string) {
  const audiences = await prisma.audience.findMany();
  const text = (value ?? "").trim().toLowerCase();
  const alias: Record<string, string> = { woman: "women", man: "men", girl: "girls", boy: "boys", babies: "baby" };
  const wanted = alias[text] ?? text;
  const found = audiences.find((row) => row.slug === wanted || row.label.toLowerCase() === wanted || row.slug === wanted.replace(/\s+/g, "-"));
  if (found) return found;
  if (text) throw new BadRequestException(`"${value}" is not an audience. Add it under Audiences first.`);
  if (silhouette === "skirt" && audiences.some((row) => row.slug === "women")) return audiences.find((row) => row.slug === "women")!;
  return audiences.find((row) => row.group === "adults" && row.shared) ?? audiences[0];
}

/** Selected audiences also show the shared pieces of their own group: Girls includes Kids unisex, never adult Unisex. */
export function audienceMatcher(audiences: AudienceRow[], selected: string[]) {
  if (!selected.length) return () => true;
  const chosen = new Set(selected);
  const groups = new Set(audiences.filter((row) => chosen.has(row.slug)).map((row) => row.group));
  const shared = new Set(audiences.filter((row) => row.shared && groups.has(row.group)).map((row) => row.slug));
  return (audience: string) => chosen.has(audience) || shared.has(audience);
}

/** Products are on sale only when Active and their audience is switched on. Use as a Prisma `where`. */
export async function onSaleWhere(prisma: PrismaClient) {
  const off = await prisma.audience.findMany({ where: { active: false }, select: { slug: true } });
  return { status: "active", gender: { notIn: off.map((row) => row.slug) } };
}

export async function isOnSale(prisma: PrismaClient, product: { status: string; gender: string }) {
  if (product.status !== "active") return false;
  const audience = await prisma.audience.findUnique({ where: { slug: product.gender } });
  return !audience || audience.active;
}
