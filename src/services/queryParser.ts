interface ParsedQuery {
  gender?: string;
  age_group?: string;
  country_id?: string;
  min_age?: number;
  max_age?: number;
}

export const COUNTRY_NAME_TO_ISO: Record<string, string> = {
  nigeria: "NG",
  kenya: "KE",
  ghana: "GH",
  tanzania: "TZ",
  uganda: "UG",
  "south africa": "ZA",
  ethiopia: "ET",
  egypt: "EG",
  morocco: "MA",
  algeria: "DZ",
  sudan: "SD",
  cameroon: "CM",
  "ivory coast": "CI",
  senegal: "SN",
  botswana: "BW",
  zimbabwe: "ZW",
  zambia: "ZM",
  malawi: "MW",
  mozambique: "MZ",
  angola: "AO",
  rwanda: "RW",
  burundi: "BI",
  liberia: "LR",
  "sierra leone": "SL",
  guinea: "GN",
  gambia: "GM",
  togo: "TG",
  benin: "BJ",
  lesotho: "LS",
  namibia: "NA",
  swaziland: "SZ",
  eswatini: "SZ",
  mauritius: "MU",
  madagascar: "MG",
  "burkina faso": "BF",
  niger: "NE",
  mali: "ML",
  chad: "TD",
  congo: "CG",
  "democratic republic of congo": "CD",
  drc: "CD",
  "united states": "US",
  usa: "US",
  uk: "GB",
  "united kingdom": "GB",
};

const AGE_GROUP_KEYWORDS: Record<string, string> = {
  child: "child",
  children: "child",
  teenager: "teenager",
  teenagers: "teenager",
  teen: "teenager",
  teens: "teenager",
  adult: "adult",
  adults: "adult",
  senior: "senior",
  seniors: "senior",
  elderly: "senior",
};

export function parseNaturalLanguageQuery(query: string): ParsedQuery | null {
  const normalized = query.toLowerCase().trim();
  const result: ParsedQuery = {};
  let hasValidFilter = false;

  const hasMale = /\b(male|males|boy|boys)\b/.test(normalized);
  const hasFemale = /\b(female|females|girl|girls)\b/.test(normalized);
  if (hasMale && !hasFemale) {
    result.gender = "male";
    hasValidFilter = true;
  }
  if (hasFemale && !hasMale) {
    result.gender = "female";
    hasValidFilter = true;
  }

  for (const [keyword, ageGroup] of Object.entries(AGE_GROUP_KEYWORDS)) {
    if (new RegExp(`\\b${keyword}\\b`).test(normalized)) {
      result.age_group = ageGroup;
      hasValidFilter = true;
      break;
    }
  }

  if (/\byoung\b/.test(normalized) && !result.age_group) {
    result.min_age = 16;
    result.max_age = 24;
    hasValidFilter = true;
  }

  const aboveMatch = normalized.match(/(?:above|over|older than)\s*(\d+)/i);
  if (aboveMatch) {
    result.min_age = parseInt(aboveMatch[1], 10);
    hasValidFilter = true;
  }

  const belowMatch = normalized.match(/(?:below|under|younger than)\s*(\d+)/i);
  if (belowMatch) {
    result.max_age = parseInt(belowMatch[1], 10);
    hasValidFilter = true;
  }

  if (!aboveMatch && !belowMatch) {
    const ageNumMatch = normalized.match(/\b(\d+)\s*(?:years?|yr|y\/o)?\b/i);
    if (ageNumMatch) {
      const age = parseInt(ageNumMatch[1], 10);
      if (/\b(above|over|older)\b/.test(normalized)) {
        result.min_age = age;
        hasValidFilter = true;
      } else if (/\b(below|under|younger)\b/.test(normalized)) {
        result.max_age = age;
        hasValidFilter = true;
      }
    }
  }

  const sortedCountries = Object.entries(COUNTRY_NAME_TO_ISO).sort(
    (a, b) => b[0].length - a[0].length,
  );

  for (const [country, iso] of sortedCountries) {
    const escapedCountry = country.replace(/\s+/g, "\\s+");
    if (new RegExp(`\\b${escapedCountry}\\b`).test(normalized)) {
      result.country_id = iso;
      hasValidFilter = true;
      break;
    }
  }

  return hasValidFilter ? result : null;
}

/**
 * Normalize parsed query filters into a canonical form for consistent caching.
 * Ensures that semantically identical queries produce the same cache key.
 */
export function normalizeQueryFilters(parsed: ParsedQuery): ParsedQuery {
  const normalized: ParsedQuery = {};

  // Copy over all fields, ensuring consistent representation
  if (parsed.gender !== undefined) {
    normalized.gender = parsed.gender.toLowerCase();
  }

  if (parsed.age_group !== undefined) {
    normalized.age_group = parsed.age_group.toLowerCase();
  }

  if (parsed.country_id !== undefined) {
    normalized.country_id = parsed.country_id.toUpperCase();
  }

  // For age ranges, ensure we have both min and max for consistency
  // If only one is specified, we keep it as is but could optionally set defaults
  // We keep the explicit values as parsed to maintain query intent
  if (parsed.min_age !== undefined) {
    normalized.min_age = parsed.min_age;
  }

  if (parsed.max_age !== undefined) {
    normalized.max_age = parsed.max_age;
  }

  return normalized;
}
