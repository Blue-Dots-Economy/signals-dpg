import {
  geocodeAddress,
  geocodeAddressWithGoogle,
  geocodePincode,
  type GeoCoordinate,
} from '@/components/map/geocoding';

type GeoCoordinates = GeoCoordinate;

/**
 * Domain-specific pincode field configurations
 */
const domainPincodeFields: Record<string, string[]> = {
  student_profile: ['address', 'postal_code'],
  learner_profile: ['pincode'],
  tutor_counsellor_profile: ['pincode'],
  coaching_center: ['city'],
};

const directLocationFields = [
  'location',
  'base_location',
  'current_location',
  'address',
  'area',
  'service_area',
  'full_address',
  'street_address',
  'street',
  'building',
  'house_number',
];

const localityFields = ['city', 'preferred_city', 'town', 'district', 'locality', 'village', 'place'];
const regionFields = ['state', 'province', 'region', 'county'];
const countryFields = ['country', 'nation'];
const pincodeFields = ['pincode', 'pin_code', 'postal_code', 'postal', 'zip', 'zipcode'];

const addressLikeTokens = [
  'location',
  'address',
  'street',
  'area',
];
const localityTokens = ['locality', 'village', 'town', 'city', 'district', 'place'];
const regionTokens = ['state', 'province', 'region', 'county'];
const countryTokens = ['country', 'nation'];

export function normalizeFieldName(key: string): string {
  return key
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function getFieldValue(data: Record<string, unknown>, fieldName: string): unknown {
  const normalizedFieldName = normalizeFieldName(fieldName);
  const exactValue = data[fieldName];
  if (exactValue !== undefined) return exactValue;

  for (const [key, value] of Object.entries(data)) {
    if (normalizeFieldName(key) === normalizedFieldName) {
      return value;
    }
  }

  return undefined;
}

/**
 * Finds the pincode value from form data based on domain configuration.
 * Handles both top-level fields (e.g., "pincode") and nested fields (e.g., "address.postal_code").
 */
export function extractPincodeFromForm(
  formData: Record<string, unknown>,
  domain: string
): string | null {
  const fields = domainPincodeFields[domain];
  
  if (!fields) {
    return findPincodeRecursively(formData);
  }

  if (fields.length === 1) {
    const value = getFieldValue(formData, fields[0]);
    return typeof value === 'string' ? value : null;
  }

  if (fields.length === 2) {
    const parent = getFieldValue(formData, fields[0]);
    if (typeof parent === 'object' && parent !== null) {
      const value = getFieldValue(parent as Record<string, unknown>, fields[1]);
      return typeof value === 'string' ? value : null;
    }
  }

  return null;
}

function getStringField(data: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = getFieldValue(data, key);
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }

  return null;
}

function hasToken(normalizedKey: string, tokens: string[]): boolean {
  const parts = normalizedKey.split('_').filter(Boolean);
  return tokens.some((token) => parts.includes(token));
}

function getStringFieldByToken(data: Record<string, unknown>, tokens: string[]): string | null {
  for (const [key, value] of Object.entries(data)) {
    if (!hasToken(normalizeFieldName(key), tokens)) continue;
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }

  return null;
}

function findAddressInNestedObject(data: Record<string, unknown>): string | null {
  for (const key of ['address', 'location', 'base_location', 'current_location']) {
    const value = getFieldValue(data, key);

    if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      const nestedAddress = extractAddressFromForm(value as Record<string, unknown>);
      if (nestedAddress) return nestedAddress;
    }
  }

  for (const [key, value] of Object.entries(data)) {
    if (!hasToken(normalizeFieldName(key), addressLikeTokens)) continue;
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      const nestedAddress = extractAddressFromForm(value as Record<string, unknown>);
      if (nestedAddress) return nestedAddress;
    }
  }

  return null;
}

export function extractAddressFromForm(formData: Record<string, unknown>): string | null {
  const directLocation = getStringField(formData, directLocationFields);
  if (directLocation) return directLocation;

  const nestedAddress = findAddressInNestedObject(formData);
  if (nestedAddress) return nestedAddress;

  const fuzzyLocation = getStringFieldByToken(formData, addressLikeTokens);
  if (fuzzyLocation) return fuzzyLocation;

  const parts = [
    getStringField(formData, localityFields) ?? getStringFieldByToken(formData, localityTokens),
    getStringField(formData, regionFields) ?? getStringFieldByToken(formData, regionTokens),
    getStringField(formData, countryFields) ?? getStringFieldByToken(formData, countryTokens),
  ].filter((part): part is string => Boolean(part));

  if (parts.length > 0) {
    return parts.join(', ');
  }

  return null;
}

/**
 * Recursively searches form data for pincode-like fields when domain config is not available.
 */
function findPincodeRecursively(data: unknown): string | null {
  if (typeof data === 'string' && /^\d{6}$/.test(data)) {
    return data;
  }

  if (typeof data === 'object' && data !== null) {
    for (const [key, value] of Object.entries(data)) {
      const normalizedKey = normalizeFieldName(key);
      if (pincodeFields.includes(normalizedKey) || hasToken(normalizedKey, pincodeFields)) {
        if (typeof value === 'string' && /^\d{6}$/.test(value)) {
          return value;
        }
      }
      if (typeof value === 'object') {
        const result = findPincodeRecursively(value);
        if (result) return result;
      }
    }
  }

  return null;
}

/**
 * Extracts pincode from form data and returns geocoded coordinates.
 * Returns null coordinates if pincode is not found or geocoding fails.
 */
export async function extractAndGeocode(
  formData: Record<string, unknown>,
  domain: string
): Promise<{ pincode: string | null; coordinates: GeoCoordinates | null }> {
  const pincode = extractPincodeFromForm(formData, domain);
  const address = extractAddressFromForm(formData);

  if (address) {
    const googleCoordinates = await geocodeAddressWithGoogle(address);
    if (googleCoordinates) {
      return { pincode, coordinates: googleCoordinates };
    }

    const fallbackCoordinates = await geocodeAddress(address, 'full');
    if (fallbackCoordinates) {
      return { pincode, coordinates: fallbackCoordinates };
    }
  }

  if (!pincode) {
    return { pincode: null, coordinates: null };
  }

  const coordinates = await geocodePincode(pincode);
  return { pincode, coordinates };
}
