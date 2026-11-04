import { createHmac, timingSafeEqual } from "crypto";
import { ForbiddenException, UnauthorizedException } from "@nestjs/common";
import type { Request } from "express";

export type Actor = { kind: "customer" | "staff"; email: string; role?: string };

const secret = () => process.env.TOKEN_SECRET || "earthen-dev-secret";

export function signToken(actor: Actor) {
  const body = Buffer.from(JSON.stringify({ ...actor, exp: Date.now() + 1000 * 60 * 60 * 24 * 14 })).toString("base64url");
  const sig = createHmac("sha256", secret()).update(body).digest("base64url");
  return `${body}.${sig}`;
}

export function readToken(header?: string): Actor | null {
  if (!header?.startsWith("Bearer ")) return null;
  const token = header.slice(7);
  const [body, sig] = token.split(".");
  if (!body || !sig) return null;
  const expected = createHmac("sha256", secret()).update(body).digest("base64url");
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  const payload = JSON.parse(Buffer.from(body, "base64url").toString()) as Actor & { exp: number };
  if (payload.exp < Date.now()) return null;
  return { kind: payload.kind, email: payload.email, role: payload.role };
}

export function actorFrom(req: Request) {
  return readToken(req.header("authorization"));
}

export function customerFrom(req: Request) {
  const header = req.header("x-customer-token");
  if (!header) return null;
  return readToken(header.startsWith("Bearer ") ? header : `Bearer ${header}`);
}

// Products, categories of products, and their photos belong to the owner and the catalog manager.
// The role is read from the database so a changed role or removed account takes effect at once.
export async function requireCatalogStaff(req: Request, prisma: { staff: { findUnique(args: { where: { email: string } }): Promise<{ role: string } | null> } }) {
  const actor = actorFrom(req);
  if (!actor || actor.kind !== "staff") throw new UnauthorizedException("Staff sign-in is required.");
  const member = await prisma.staff.findUnique({ where: { email: actor.email } });
  if (!member) throw new UnauthorizedException("Staff sign-in is required.");
  if (member.role !== "Owner" && member.role !== "Catalog manager") throw new ForbiddenException("Only the owner or a catalog manager can change products.");
  return { ...actor, role: member.role };
}

export function isStaff(req: Request) {
  return actorFrom(req)?.kind === "staff";
}

// Shop structure (audiences) is the owner's to change.
export async function requireOwner(
  req: Request,
  prisma: { staff: { findUnique(args: { where: { email: string } }): Promise<{ role: string } | null> } },
  what = "make this change",
) {
  const actor = actorFrom(req);
  if (!actor || actor.kind !== "staff") throw new UnauthorizedException("Staff sign-in is required.");
  const member = await prisma.staff.findUnique({ where: { email: actor.email } });
  if (!member) throw new UnauthorizedException("Staff sign-in is required.");
  if (member.role !== "Owner") throw new ForbiddenException(`Only the owner can ${what}.`);
  return { ...actor, role: member.role };
}
