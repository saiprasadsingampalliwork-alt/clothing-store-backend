import { BadRequestException, Body, Controller, Delete, Get, Inject, OnModuleInit, Param, Patch, Post, Put, Req } from "@nestjs/common";
import type { Request } from "express";
import { isStaff, requireCatalogStaff } from "./auth";
import { PrismaService } from "./prisma.service";
import { cleanStyleLabel, ensureStyles, freeStyleSlug } from "./styles";

@Controller("styles")
export class StylesController implements OnModuleInit {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async onModuleInit() {
    await ensureStyles(this.prisma);
  }

  @Get()
  list(@Req() req: Request) {
    return this.prisma.style.findMany({ where: isStaff(req) ? {} : { active: true }, orderBy: [{ sort: "asc" }, { label: "asc" }] });
  }

  @Post()
  async create(@Req() req: Request, @Body() body: { label?: string; active?: boolean }) {
    await requireCatalogStaff(req, this.prisma);
    const label = cleanStyleLabel(body.label);
    if (await this.findByLabel(label)) throw new BadRequestException("That style is already in the list.");
    const sort = ((await this.prisma.style.aggregate({ _max: { sort: true } }))._max.sort ?? -1) + 1;
    return this.prisma.style.create({ data: { slug: await freeStyleSlug(this.prisma, label), label, active: body.active ?? true, sort } });
  }

  // Saves the order shoppers see styles in.
  @Put("order")
  async order(@Req() req: Request, @Body() body: { slugs?: unknown }) {
    await requireCatalogStaff(req, this.prisma);
    const slugs = Array.isArray(body.slugs) ? body.slugs.map(String) : [];
    const known = new Set((await this.prisma.style.findMany({ select: { slug: true } })).map((row) => row.slug));
    if (slugs.length !== known.size || new Set(slugs).size !== slugs.length || !slugs.every((slug) => known.has(slug))) {
      throw new BadRequestException("The list changed while you were ordering it. Reload the page and try again.");
    }
    await this.prisma.$transaction(slugs.map((slug, sort) => this.prisma.style.update({ where: { slug }, data: { sort } })));
    return { ok: true };
  }

  @Patch(":slug")
  async update(@Req() req: Request, @Param("slug") slug: string, @Body() body: { label?: string; active?: boolean }) {
    await requireCatalogStaff(req, this.prisma);
    const existing = await this.prisma.style.findUnique({ where: { slug } });
    if (!existing) throw new BadRequestException("Style not found.");
    const label = body.label === undefined ? existing.label : cleanStyleLabel(body.label);
    const clash = await this.findByLabel(label);
    if (clash && clash.slug !== slug) throw new BadRequestException("Another style already has that name.");
    return this.prisma.style.update({
      where: { slug },
      data: { label, active: typeof body.active === "boolean" ? body.active : existing.active },
    });
  }

  @Delete(":slug")
  async remove(@Req() req: Request, @Param("slug") slug: string) {
    await requireCatalogStaff(req, this.prisma);
    const existing = await this.prisma.style.findUnique({ where: { slug } });
    if (!existing) throw new BadRequestException("Style not found.");
    const used = await this.prisma.product.count({ where: { styles: { has: slug } } });
    if (used > 0) throw new BadRequestException(`${used} products use ${existing.label}. Untick it on them first, or switch the style off.`);
    await this.prisma.style.delete({ where: { slug } });
    return { ok: true };
  }

  private findByLabel(label: string) {
    return this.prisma.style.findFirst({ where: { label: { equals: label, mode: "insensitive" } } });
  }
}
