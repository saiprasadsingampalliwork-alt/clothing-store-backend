"""
Builds server/data/pincodes.json from India Post's "All India Pincode Directory" CSV (data.gov.in).

    python3 -I server/scripts/build-pincodes.py ~/Downloads/<file>.csv

Run it again whenever India Post publishes a newer file. The CSV itself is not kept in the project.

Output, kept small for the API server:
  states:    the 36 states and union territories, by their official names
  districts: district names, referenced by index
  pins:      { "560001": [[state indexes], district index, [area names]] }
  inferred:  PIN codes whose state was missing in the source and taken from neighbouring PINs
"""

import collections
import csv
import json
import re
import sys
from datetime import date
from pathlib import Path

STATES = [
    "Andhra Pradesh", "Arunachal Pradesh", "Assam", "Bihar", "Chhattisgarh", "Goa", "Gujarat", "Haryana",
    "Himachal Pradesh", "Jharkhand", "Karnataka", "Kerala", "Madhya Pradesh", "Maharashtra", "Manipur",
    "Meghalaya", "Mizoram", "Nagaland", "Odisha", "Punjab", "Rajasthan", "Sikkim", "Tamil Nadu", "Telangana",
    "Tripura", "Uttar Pradesh", "Uttarakhand", "West Bengal",
    "Andaman and Nicobar Islands", "Chandigarh", "Dadra and Nagar Haveli and Daman and Diu", "Delhi",
    "Jammu and Kashmir", "Ladakh", "Lakshadweep", "Puducherry",
]
BY_KEY = {re.sub(r"[^a-z]", "", name.lower()): index for index, name in enumerate(STATES)}
ALIASES = {"thedadraandnagarhaveliananddamananddiu": "dadraandnagarhavelianddamananddiu", "orissa": "odisha", "pondicherry": "puducherry", "nctofdelhi": "delhi"}

# "Kothimir B.O", "Indiranagar S.O (Bengaluru)", "Bangalore G.P.O." -> "Kothimir", "Indiranagar", "Bangalore"
OFFICE_SUFFIX = re.compile(r"\s+(B|S|H|G\.?\s?P|P|E\.?\s?D)\.?\s?O\.?(\s*\(.*\))?$", re.IGNORECASE)
SMALL_WORDS = {"and", "of", "the"}
VOWELS = set("AEIOUaeiou")


def state_index(raw: str):
    key = re.sub(r"[^a-z]", "", raw.lower())
    key = ALIASES.get(key, key)
    if key.startswith("the") and key[3:] in BY_KEY:
        key = key[3:]
    return BY_KEY.get(key)


def title(raw: str) -> str:
    """Title case that keeps abbreviations: "CMM COURT" -> "CMM Court", "N.S.BUILDING" -> "N.S.Building"."""

    def word(text: str, first: bool) -> str:
        if not first and text.lower() in SMALL_WORDS:
            return text.lower()
        # Consonant-only short words are abbreviations (CMM, MPT, GPO); keep them in capitals.
        if text.isalpha() and len(text) <= 4 and not (set(text) & VOWELS):
            return text.upper()
        return re.sub(r"[A-Za-z]+", lambda part: part.group(0).capitalize(), text)

    words = raw.strip().replace("_", " ").split()
    return " ".join(word(text, index == 0) for index, text in enumerate(words))


def main(path: str) -> None:
    with open(path, newline="", encoding="utf-8-sig", errors="replace") as handle:
        rows = list(csv.DictReader(handle))
    states_by_pin = collections.defaultdict(set)
    districts_by_pin = collections.defaultdict(collections.Counter)
    areas_by_pin = collections.defaultdict(list)
    unknown_states = collections.Counter()
    for row in rows:
        pin = (row.get("pincode") or "").strip()
        if not re.fullmatch(r"[1-9]\d{5}", pin):
            continue
        state = (row.get("statename") or "").strip()
        if state and state.upper() != "NA":
            index = state_index(state)
            if index is None:
                unknown_states[state] += 1
            else:
                states_by_pin[pin].add(index)
        district = (row.get("district") or "").strip()
        if district and district.upper() != "NA":
            districts_by_pin[pin][title(district)] += 1
        office = OFFICE_SUFFIX.sub("", (row.get("officename") or "").strip())
        if office:
            area = title(office)
            # Offices that deliver mail are listed first: they are the localities people write.
            entry = (0 if (row.get("delivery") or "").strip().lower() == "delivery" else 1, area)
            if area not in (existing for _, existing in areas_by_pin[pin]):
                areas_by_pin[pin].append(entry)
        districts_by_pin[pin]  # make sure every PIN appears

    if unknown_states:
        sys.exit(f"Unrecognised state names, add them to ALIASES: {dict(unknown_states)}")

    # A few PINs have no state in the source; take the most common state among PINs with the same first three digits.
    by_prefix = collections.defaultdict(collections.Counter)
    for pin, states in states_by_pin.items():
        for index in states:
            by_prefix[pin[:3]][index] += 1
    inferred = []
    for pin in sorted(districts_by_pin):
        if not states_by_pin.get(pin) and by_prefix.get(pin[:3]):
            states_by_pin[pin] = {by_prefix[pin[:3]].most_common(1)[0][0]}
            inferred.append(pin)

    districts: list[str] = []
    district_index: dict[str, int] = {}
    pins = {}
    for pin in sorted(districts_by_pin):
        states = sorted(states_by_pin.get(pin, ()))
        if not states:
            continue
        district = districts_by_pin[pin].most_common(1)[0][0] if districts_by_pin[pin] else ""
        if district not in district_index:
            district_index[district] = len(districts)
            districts.append(district)
        areas = [area for _, area in sorted(areas_by_pin[pin], key=lambda entry: (entry[0], entry[1]))][:25]
        pins[pin] = [states, district_index[district], areas]

    output = {
        "source": "India Post, All India Pincode Directory, data.gov.in. Government Open Data License - India (GODL).",
        "built": date.today().isoformat(),
        "states": STATES,
        "districts": districts,
        "inferred": inferred,
        "pins": pins,
    }
    target = Path(__file__).resolve().parent.parent / "data" / "pincodes.json"
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(json.dumps(output, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    multi = sum(1 for value in pins.values() if len(value[0]) > 1)
    print(f"{len(rows):,} rows -> {len(pins):,} PIN codes, {len(districts):,} districts, {multi} in two states, {len(inferred)} states inferred")
    print(f"wrote {target} ({target.stat().st_size / 1024 / 1024:.1f} MB)")


if __name__ == "__main__":
    if len(sys.argv) != 2:
        sys.exit("usage: python3 -I server/scripts/build-pincodes.py <All India Pincode Directory CSV>")
    main(sys.argv[1])
