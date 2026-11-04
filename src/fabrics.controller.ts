import { BadRequestException, Body, Controller, Delete, Get, Inject, OnModuleInit, Param, Patch, Post, Req } from "@nestjs/common";
import type { Request } from "express";
import { requireCatalogStaff } from "./auth";
import { cleanFabricLabel, ensureFabrics, freeSlug } from "./fabrics";
import { PrismaService } from "./prisma.service";

@Controller("fabrics")
export class FabricsController implements OnModuleInit {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async onModuleInit() {
    await ensureFabrics(this.prisma);
  }

  @Get()
  list() {
    return this.prisma.fabric.findMany({ orderBy: { label: "asc" } });
  }

  @Post()
  async create(@Req() req: Request, @Body() body: { label?: string }) {
    await requireCatalogStaff(req, this.prisma);
    const label = cleanFabricLabel(body.label);
    if (await this.findByLabel(label)) throw new BadRequestException("That fabric is already in the list.");
    return this.prisma.fabric.create({ data: { slug: await freeSlug(this.prisma, label), label } });
  }

  // Renaming a fabric renames it on every product that uses it.
  @Patch(":slug")
  async rename(@Req() req: Request, @Param("slug") slug: string, @Body() body: { label?: string }) {
    await requireCatalogStaff(req, this.prisma);
    const existing = await this.prisma.fabric.findUnique({ where: { slug } });
    if (!existing) throw new BadRequestException("Fabric not found.");
    const label = cleanFabricLabel(body.label);
    const clash = await this.findByLabel(label);
    if (clash && clash.slug !== slug) throw new BadRequestException("Another fabric already has that name.");
    const [saved] = await this.prisma.$transaction([
      this.prisma.fabric.update({ where: { slug }, data: { label } }),
      this.prisma.product.updateMany({ where: { fabric: existing.label }, data: { fabric: label } }),
    ]);
    return saved;
  }

  @Delete(":slug")
  async remove(@Req() req: Request, @Param("slug") slug: string) {
    await requireCatalogStaff(req, this.prisma);
    const existing = await this.prisma.fabric.findUnique({ where: { slug } });
    if (!existing) throw new BadRequestException("Fabric not found.");
    const used = await this.prisma.product.count({ where: { fabric: existing.label } });
    if (used > 0) throw new BadRequestException(`${used} products use ${existing.label}. Change them first.`);
    await this.prisma.fabric.delete({ where: { slug } });
    return { ok: true };
  }

  private async findByLabel(label: string) {
    return this.prisma.fabric.findFirst({ where: { label: { equals: label, mode: "insensitive" } } });
  }
}
