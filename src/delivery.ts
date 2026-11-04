import { readFileSync } from "fs";
import path from "path";
import { BadRequestException } from "@nestjs/common";

/**
 * India Post's PIN code directory, built by server/scripts/build-pincodes.py.
 * Loaded once (about 2 MB); lookups are a map read. Never sent to the browser whole.
 */
type PinData = { states: string[]; districts: string[]; inferred: string[]; pins: Record<string, [number[], number, string[]]> };

let data: PinData | null = null;

function pinData(): PinData {
  if (!data) {
    const file = path.resolve(__dirname, "../data/pincodes.json");
    data = JSON.parse(readFileSync(file, "utf8")) as PinData;
    console.log(`[delivery] Loaded ${Object.keys(data.pins).length.toLocaleString("en-IN")} PIN codes.`);
  }
  return data;
}

/** The 28 states and 8 union territories, by their official names. */
export function indianStates() {
  return pinData().states;
}

const ALIASES: Record<string, string> = {
  orissa: "odisha",
  pondicherry: "puducherry",
  nctofdelhi: "delhi",
  newdelhi: "delhi",
  uttaranchal: "uttarakhand",
  dadraandnagarhaveli: "dadraandnagarhavelianddamananddiu",
  damananddiu: "dadraandnagarhavelianddamananddiu",
  andamanandnicobar: "andamanandnicobarislands",
};

/** "orissa", "NCT of Delhi", "TAMIL NADU" -> the official name, or null if it is not an Indian state or UT. */
export function canonicalState(raw: unknown): string | null {
  let key = String(raw ?? "").toLowerCase().replace(/[^a-z]/g, "");
  if (key.startsWith("the")) key = key.slice(3);
  key = ALIASES[key] ?? key;
  return indianStates().find((state) => state.toLowerCase().replace(/[^a-z]/g, "") === key) ?? null;
}

export type PinInfo = { pin: string; district: string; states: string[]; areas: string[] };

export function lookupPin(pin: string): PinInfo | null {
  if (!/^[1-9]\d{5}$/.test(pin)) return null;
  const row = pinData().pins[pin];
  if (!row) return null;
  const all = pinData();
  return { pin, district: all.districts[row[1]] ?? "", states: row[0].map((index) => all.states[index]), areas: row[2] };
}

/** States switched off under Admin › Settings › Delivery areas. Everything else is delivered to. */
export function disabledStates(settings: Record<string, unknown>) {
  const list = Array.isArray(settings.disabledStates) ? settings.disabledStates : [];
  return new Set(list.map(canonicalState).filter((state): state is string => Boolean(state)));
}

export type CleanAddress = {
  id?: string;
  label?: string;
  name: string;
  phone: string;
  line1: string;
  line2: string;
  landmark: string;
  city: string;
  state: string;
  pin: string;
  isDefault?: boolean;
};

function text(value: unknown, max: number) {
  return String(value ?? "").replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
}

/** A 10-digit Indian mobile starting 6 to 9; "+91 98765 43210" and "098765 43210" are accepted and shortened. */
export function cleanMobile(raw: unknown) {
  const digits = String(raw ?? "").replace(/\D/g, "").replace(/^(91|0)(?=\d{10}$)/, "");
  if (!/^[6-9]\d{9}$/.test(digits)) throw new BadRequestException("Enter a 10-digit mobile number starting with 6, 7, 8, or 9.");
  return digits;
}

/**
 * Keeps only the address fields the shop uses, each trimmed and length-capped, so nothing else
 * (or nothing huge) is ever stored with an order or in an address book. Checks PIN, state, and the basics.
 */
export function cleanAddress(raw: unknown): CleanAddress {
  const input = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const pin = String(input.pin ?? "").replace(/\D/g, "");
  if (!/^[1-9]\d{5}$/.test(pin)) throw new BadRequestException("Enter a 6-digit PIN code.");
  const state = canonicalState(input.state);
  if (!state) throw new BadRequestException("Choose the state from the list.");
  const known = lookupPin(pin);
  // A PIN missing from the directory (new or very recent) is allowed; one that is listed must match the state.
  if (known && !known.states.includes(state)) {
    throw new BadRequestException(`PIN ${pin} is in ${known.states.join(" / ")}, not ${state}. Check the PIN code or the state.`);
  }
  const address: CleanAddress = {
    name: text(input.name, 80),
    phone: cleanMobile(input.phone),
    line1: text(input.line1, 160),
    line2: text(input.line2, 160),
    landmark: text(input.landmark, 120),
    city: text(input.city, 80),
    state,
    pin,
  };
  if (!address.name) throw new BadRequestException("Add the name of the person receiving it.");
  if (!address.line1) throw new BadRequestException("Add the house, flat, or building.");
  if (!address.city) throw new BadRequestException("Add the city or district.");
  if (input.id !== undefined) address.id = text(input.id, 60);
  if (input.label !== undefined) address.label = text(input.label, 30) || "Home";
  if (input.isDefault !== undefined) address.isDefault = input.isDefault === true;
  return address;
}

/** The checks every delivery address goes through before an order is placed, including the delivery areas. */
export function checkDeliveryAddress(raw: unknown, settings: Record<string, unknown>) {
  const address = cleanAddress(raw);
  if (disabledStates(settings).has(address.state)) throw new BadRequestException(`We do not deliver to ${address.state} yet.`);
  return address;
}
