# Country-boundary check for supplied coordinates

Code: `apps/api/src/services/geocoding/country_boundary.ts`.

## Why it exists

Geocoder results are restricted to `GEOCODING_COUNTRY` (Google `components`,
Photon `countrycode`, plus a client-side country filter). Coordinates the
caller resolved itself (an aggregator bulk `geo_location` cell, an autocomplete
pick, a partner integration) skip geocoding and are stored as-is, so this check
holds them to the configured country instead.

## Boundary source

The boundary is a GeoJSON file mounted from a ConfigMap
(`GEOCODING_BOUNDARY_PATH`), not bundled in the image, so a deployment picks its
own source map without a rebuild: Natural Earth's India point-of-view file by
default, or the Survey of India outline if required. A bounding box is not used
because India's bounding box contains Bangladesh.

If the country is set but the file is missing or unparseable, the check is
skipped (fail-open) with a warning at boot; blocking every location write over a
config gap would take registrations down.

## Tolerance (`BOUNDARY_TOLERANCE_METERS = 15_000`)

Natural Earth 1:10m has several km of positional error along the Bangladesh
border: Petrapole (WB) sits 6.25 km outside the drawn line, Jogbani (Bihar)
3.5 km, Moreh (Manipur) 2.3 km. A real border address must not fail its write
over that.

15 km clears those with over 2x margin and still rejects the nearest foreign
cities (Lahore 21 km, Jessore 26 km, Sylhet 31 km, Khulna 61 km, Dhaka 74 km,
Kathmandu 84 km outside). Do not raise it past ~20 km or Lahore gets in. What it
admits is the strip just across the border that a 1:10m outline cannot resolve
anyway (Benapole, Birgunj, Rajshahi). A sharper source (Survey of India) would
justify a tighter value.
