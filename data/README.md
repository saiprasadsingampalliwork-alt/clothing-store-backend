# Delivery data

`pincodes.json` is built from India Post's **All India Pincode Directory**, published on
[data.gov.in](https://data.gov.in) under the Government Open Data License – India (GODL).
Source: India Post, Department of Posts, Government of India.

To refresh it with a newer download from data.gov.in:

```bash
python3 -I server/scripts/build-pincodes.py ~/Downloads/<all-india-pincode-directory>.csv
```

The CSV itself is not kept in the project; only the compact `pincodes.json` (about 2 MB) is.

"Use my current location" turns coordinates into an address with OpenStreetMap's Nominatim service
(address data © OpenStreetMap contributors, ODbL). Its usage policy allows about one request a second;
the API caches results and queues requests to stay within it. Set `NOMINATIM_CONTACT` in `server/.env`
to an email or site address so OpenStreetMap can reach the shop if needed.
