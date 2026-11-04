import { BadRequestException, Body, Controller, Delete, Get, Inject, OnModuleInit, Param, Patch, Post, Req } from "@nestjs/common";
import type { Request } from "express";
import { ensureAudiences, GROUP_SIZES, GROUPS, presentAudience, requireSizes, type Group } from "./audiences";
import { isStaff, requireOwner } from "./auth";
import { categorySlug } from "./category-slug";
import { PrismaService } from "./prisma.service";

type AudienceBody = { label?: string; group?: string; shared?: boolean; sizes?: unknown; active?: boolean; sort?: number };

@Controller("audiences")
export class AudiencesController implements OnModuleInit {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async onModuleInit() {
    await ensureAudiences(this.prisma);
  }

  @Get()
  async list(@Req() req: Request) {
    const rows = await this.prisma.audience.findMany({ where: isStaff(req) ? {} : { active: true }, orderBy: [{ sort: "asc" }, { label: "asc" }] });
    return rows.map(presentAudience);
  }

  @Post()
  async create(@Req() req: Request, @Body() body: AudienceBody) {
    await requireOwner(req, this.prisma, "change audiences");
    const label = cleanLabel(body.label);
    const slug = categorySlug(label);
    if (!slug || slug === "all") throw new BadRequestException("Choose another name.");
    if (await this.prisma.audience.findUnique({ where: { slug } })) throw new BadRequestException("An audience with that name already exists.");
    const group = groupOf(body.group);
    const sort = await this.prisma.audience.count();
    const saved = await this.prisma.audience.create({
      data: {
        slug,
        label,
        group,
        shared: Boolean(body.shared),
        sizes: body.sizes === undefined ? GROUP_SIZES[group] : requireSizes(body.sizes),
        active: body.active ?? true,
        sort,
      },
    });
    return presentAudience(saved);
  }

  @Patch(":slug")
  async update(@Req() req: Request, @Param("slug") slug: string, @Body() body: AudienceBody) {
    await requireOwner(req, this.prisma, "change audiences");
    const existing = await this.prisma.audience.findUnique({ where: { slug } });
    if (!existing) throw new BadRequestException("Audience not found.");
    const group = body.group === undefined ? (existing.group as Group) : groupOf(body.group);
    if (group !== existing.group && (await this.prisma.product.count({ where: { gender: slug } })) > 0) {
      throw new BadRequestException("Products already use this audience. Move them to another audience before changing its group.");
    }
    const saved = await this.prisma.audience.update({
      where: { slug },
      data: {
        label: body.label === undefined ? existing.label : cleanLabel(body.label),
        group,
        shared: body.shared === undefined ? existing.shared : Boolean(body.shared),
        // Changing an audience's sizes only affects products added afterwards; existing products keep theirs.
        sizes: body.sizes === undefined ? (existing.sizes as string[]) : requireSizes(body.sizes),
        active: body.active === undefined ? existing.active : Boolean(body.active),
        sort: typeof body.sort === "number" && Number.isInteger(body.sort) ? body.sort : existing.sort,
      },
    });
    return presentAudience(saved);
  }

  @Delete(":slug")
  async remove(@Req() req: Request, @Param("slug") slug: string) {
    await requireOwner(req, this.prisma, "change audiences");
    const used = await this.prisma.product.count({ where: { gender: slug } });
    if (used > 0) throw new BadRequestException(`${used} products are for this audience. Move them first, or switch the audience off.`);
    if ((await this.prisma.audience.count()) <= 1) throw new BadRequestException("Keep at least one audience.");
    await this.prisma.audience.delete({ where: { slug } });
    return { ok: true };
  }
}

function cleanLabel(value?: string) {
  const label = (value ?? "").trim().replace(/\s+/g, " ").slice(0, 40);
  if (!label) throw new BadRequestException("An audience needs a name.");
  return label;
}

function groupOf(value?: string): Group {
  const group = (value ?? "adults").trim().toLowerCase();
  if (!(GROUPS as readonly string[]).includes(group)) throw new BadRequestException("Group must be adults, kids, or baby.");
  return group as Group;
}
