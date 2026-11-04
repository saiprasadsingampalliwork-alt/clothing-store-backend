import { BadRequestException, Controller, Get, Inject, NotFoundException, Param, Query, Req } from "@nestjs/common";
import type { Request } from "express";
import { canonicalState, disabledStates, indianStates, lookupPin } from "./delivery";
import { OrdersService } from "./orders.service";
import { RateLimit } from "./rate-limit";

// Generous for people typing, tight enough that the directory cannot be scraped quickly.
const lookups = new RateLimit(120, 10 * 60 * 1000, "Too many PIN lookups. Wait a few minutes and try again.");
const locates = new RateLimit(10, 10 * 60 * 1000, "Too many location lookups. Wait a few minutes, or type the PIN code.");

type Reverse = { pin: string; line2: string; city: string; state: string };

// OpenStreetMap's Nominatim allows one request a second and asks for caching. Nearby taps (about 10 m) share a result.
const cache = new Map<string, Reverse>();
let nextSlot = 0;

@Controller("delivery")
export class DeliveryController {
  constructor(@Inject(OrdersService) private readonly orders: OrdersService) {}

  /** States and union territories, with whether the studio delivers to each. */
  @Get("states")
  async states() {
    const off = disabledStates(await this.orders.settings());
    return indianStates().map((name) => ({ name, delivers: !off.has(name) }));
  }

  /** City, state, and areas for a PIN code, and whether the studio delivers there. */
  @Get("pincode/:pin")
  async pincode(@Req() req: Request, @Param("pin") pin: string) {
    lookups.take(req.ip || "unknown");
    if (!/^[1-9]\d{5}$/.test(pin)) throw new BadRequestException("Enter a 6-digit PIN code.");
    const info = lookupPin(pin);
    if (!info) throw new NotFoundException("We could not find that PIN code. Check it, or fill in the city and state yourself.");
    const settings = await this.orders.settings();
    const off = disabledStates(settings);
    const delivers = info.states.some((state) => !off.has(state));
    return {
      ...info,
      delivers,
      estimate: typeof settings.deliveryEstimate === "string" ? settings.deliveryEstimate : "3–5 days",
      cod: settings.codEnabled !== false,
    };
  }

  /**
   * Turns the shopper's location into an address to check, using OpenStreetMap.
   * The house number is never guessed; the shopper fills it in.
   */
  @Get("reverse")
  async reverse(@Req() req: Request, @Query("lat") latRaw?: string, @Query("lng") lngRaw?: string) {
    locates.take(req.ip || "unknown");
    const lat = Number(latRaw);
    const lng = Number(lngRaw);
    // Roughly India's bounding box; anything else is not an address we can deliver to.
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || lat < 6 || lat > 37.5 || lng < 68 || lng > 97.5) {
      throw new BadRequestException("That location is outside India. Fill in the address yourself.");
    }
    const key = `${lat.toFixed(4)},${lng.toFixed(4)}`;
    const hit = cache.get(key);
    if (hit) return hit;

    const wait = Math.max(0, nextSlot - Date.now());
    // Refused requests do not take a slot, so a burst cannot leave the queue blocked afterwards.
    if (wait > 5000) throw new BadRequestException("Location lookup is busy. Try again in a few seconds, or type the PIN code.");
    nextSlot = Math.max(Date.now(), nextSlot) + 1100;
    if (wait) await new Promise((resolve) => setTimeout(resolve, wait));

    let place: { address?: Record<string, string> };
    try {
      const url = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&addressdetails=1&zoom=18&accept-language=en&lat=${lat}&lon=${lng}`;
      const response = await fetch(url, {
        // Nominatim's usage policy asks every app to identify itself.
        headers: { "user-agent": `EarthenStore/1.0 (${process.env.NOMINATIM_CONTACT?.trim() || process.env.APP_URL || "earthen"})` },
        signal: AbortSignal.timeout(8000),
      });
      if (!response.ok) throw new Error(`Nominatim answered ${response.status}`);
      place = (await response.json()) as typeof place;
    } catch (error) {
      console.error("[delivery] Location lookup failed", error);
      throw new BadRequestException("We could not look up your location. Type the PIN code instead.");
    }
    const address = place.address ?? {};
    const pin = (address.postcode ?? "").replace(/\D/g, "").slice(0, 6);
    const known = lookupPin(pin);
    const state = canonicalState(address.state) ?? known?.states[0] ?? "";
    const result: Reverse = {
      pin: known || /^[1-9]\d{5}$/.test(pin) ? pin : "",
      line2: [address.road, address.neighbourhood ?? address.suburb ?? address.quarter].filter(Boolean).join(", "),
      city: address.city ?? address.town ?? address.village ?? address.municipality ?? address.city_district ?? known?.district ?? address.county ?? "",
      state,
    };
    if (cache.size > 500) cache.delete(cache.keys().next().value as string);
    cache.set(key, result);
    return result;
  }
}
