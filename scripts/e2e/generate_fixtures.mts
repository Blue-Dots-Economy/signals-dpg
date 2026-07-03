/**
 * Generate Purple Dot seeker or provider fixture data in CSV or JSON.
 *
 * Records are schema-valid against `examples/schemas/purple_dot/network.json`:
 *   - seeker  → profile_1.0 (beneficiary) — every required field populated.
 *   - provider → profile_1.0 (service provider) — every required field populated.
 *
 * Usage:
 *   pnpm tsx scripts/e2e/generate_fixtures.mts \
 *     --output-format <csv|json> \
 *     --domain <seeker|provider> \
 *     --count <integer> \
 *     [--output <path>]   # default: stdout
 *     [--seed <number>]   # default: time-based; pin for deterministic output
 *
 * Examples:
 *   # 25 seekers as JSON to stdout (pipe to a file or jq):
 *   pnpm tsx scripts/e2e/generate_fixtures.mts --output-format json --domain seeker --count 25
 *
 *   # 50 providers as CSV, written to a file, reproducible run:
 *   pnpm tsx scripts/e2e/generate_fixtures.mts \
 *     --output-format csv --domain provider --count 50 --seed 42 \
 *     --output scripts/e2e/fixtures/providers_bulk_50.csv
 *
 * Notes:
 *   - Array values in CSV use `|` as the separator (matches Aggregator's
 *     bulk-upload convention).
 *   - Cells containing commas/quotes/newlines are CSV-quoted with `""` escapes.
 *   - Phone numbers are synthetic (9NNNNNNNNN starting from a high-range prefix)
 *     so they never collide with real subscribers.
 *   - Emails follow `<slug>.<sequence>@purpledots.example` so they're
 *     deterministic per (name, seed) and won't hit real inboxes.
 */
import { writeFileSync } from 'node:fs';

// ───────────────────────────────────────────────────────────────────────────
// CLI parsing
// ───────────────────────────────────────────────────────────────────────────

interface Args {
  outputFormat: 'csv' | 'json';
  domain: 'seeker' | 'provider';
  count: number;
  output: string | null;
  seed: number;
}

function parseArgs(argv: string[]): Args {
  const out: Partial<Args> = { output: null };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const val = argv[i + 1];
    switch (flag) {
      case '--output-format':
        if (val !== 'csv' && val !== 'json') {
          die(`--output-format must be 'csv' or 'json' (got '${val ?? ''}')`);
        }
        out.outputFormat = val;
        i++;
        break;
      case '--domain':
        if (val !== 'seeker' && val !== 'provider') {
          die(`--domain must be 'seeker' or 'provider' (got '${val ?? ''}')`);
        }
        out.domain = val;
        i++;
        break;
      case '--count': {
        const n = Number(val);
        if (!Number.isInteger(n) || n <= 0) {
          die(`--count must be a positive integer (got '${val ?? ''}')`);
        }
        out.count = n;
        i++;
        break;
      }
      case '--output':
        if (!val) die(`--output requires a path`);
        out.output = val;
        i++;
        break;
      case '--seed': {
        const n = Number(val);
        if (!Number.isFinite(n)) die(`--seed must be a number (got '${val ?? ''}')`);
        out.seed = n;
        i++;
        break;
      }
      case '--help':
      case '-h':
        printUsage();
        process.exit(0);
      default:
        die(`unknown argument: ${flag}`);
    }
  }
  if (!out.outputFormat) die(`--output-format is required`);
  if (!out.domain) die(`--domain is required`);
  if (!out.count) die(`--count is required`);
  return {
    outputFormat: out.outputFormat,
    domain: out.domain,
    count: out.count,
    output: out.output ?? null,
    seed: out.seed ?? Date.now(),
  };
}

function die(msg: string): never {
  console.error(`error: ${msg}`);
  printUsage();
  process.exit(1);
}

function printUsage(): void {
  console.error(`
usage: tsx scripts/e2e/generate_fixtures.mts
         --output-format <csv|json>
         --domain <seeker|provider>
         --count <integer>
         [--output <path>]   # default: stdout
         [--seed <number>]   # default: Date.now(); pin for reproducible runs
`);
}

// ───────────────────────────────────────────────────────────────────────────
// Seeded PRNG (mulberry32) — deterministic output when --seed is provided
// ───────────────────────────────────────────────────────────────────────────

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

let rng: () => number = Math.random;
const rint = (max: number): number => Math.floor(rng() * max);
const pick = <T>(arr: readonly T[]): T => arr[rint(arr.length)]!;
const pickSubset = <T>(arr: readonly T[], min: number, max: number): T[] => {
  const k = min + rint(max - min + 1);
  const copy = [...arr];
  const out: T[] = [];
  for (let i = 0; i < k && copy.length > 0; i++) {
    const idx = rint(copy.length);
    out.push(copy.splice(idx, 1)[0]!);
  }
  return out;
};

// ───────────────────────────────────────────────────────────────────────────
// Vocab pools (from examples/schemas/purple_dot/network.json)
// ───────────────────────────────────────────────────────────────────────────

const GENDERS = ['Male', 'Female', 'Other', 'Prefer not to say'] as const;

const DISABILITY_TYPES = [
  'Acid Attack Victim',
  'Autism Spectrum Disorder',
  'Blindness',
  'Cerebral Palsy',
  'Dwarfism',
  'Hearing Impairment',
  'Hemophilia',
  'Intellectual Disability',
  'Leprosy Cured',
  'Locomotor Disability',
  'Low Vision',
  'Mental Illness',
  'Multiple Sclerosis',
  'Muscular Dystrophy',
  "Parkinson's Disease",
  'Sickle Cell Anaemia',
  'Specific Learning Disabilities',
  'Speech and Language Disability',
  'Thalassemia',
  'Chronic Neurological Conditions',
  'Multiple Disabilities including deaf-blindness',
] as const;

const LOOKING_FOR = [
  'Assistive Devices',
  'Health & Rehabilitation',
  'Training & Skill Building',
  'Scheme Application Support',
  'Counselling & Mentorship',
  'Accessibility Support',
  'Employment Opportunities',
  'Scholarships',
  'Financial Products (Loans/Insurance)',
  'Other',
] as const;

const SERVICES_OFFERED = LOOKING_FOR; // same vocab on the provider side

const DOCUMENTS_AVAILABLE = [
  'Aadhaar',
  'Income Certificate',
  'Disability Certificate',
  'School ID',
  'Bank Account',
  'Other',
] as const;

const PROVIDER_CATEGORIES = [
  'NGO / Trust',
  'Government Body',
  'Private Company',
  'Community Group',
  'Private Individual Practice',
  'Hospital / Clinic',
  'Educational Institution',
  'Professional Network',
  'Digital Platform',
] as const;

const HIGHEST_QUALIFICATIONS = [
  '10th Pass',
  '12th Pass',
  'Diploma Pass',
  'ITI Graduate',
  'College Graduate',
  'Post Graduate',
  'None of the above',
] as const;

const CITIES = [
  { city: 'Lucknow', district: 'Lucknow', block: 'Hazratganj', pincode: '226001', state: 'Uttar Pradesh' },
  { city: 'Kanpur', district: 'Kanpur', block: 'Patel Nagar', pincode: '208002', state: 'Uttar Pradesh' },
  { city: 'Varanasi', district: 'Varanasi', block: 'Sigra', pincode: '221001', state: 'Uttar Pradesh' },
  { city: 'Allahabad', district: 'Allahabad', block: 'Civil Lines', pincode: '211001', state: 'Uttar Pradesh' },
  { city: 'Agra', district: 'Agra', block: 'Sadar', pincode: '282001', state: 'Uttar Pradesh' },
  { city: 'Meerut', district: 'Meerut', block: 'Cantt', pincode: '250001', state: 'Uttar Pradesh' },
  { city: 'Noida', district: 'Gautam Buddha Nagar', block: 'Sector 18', pincode: '201301', state: 'Uttar Pradesh' },
  { city: 'Ghaziabad', district: 'Ghaziabad', block: 'Vasundhara', pincode: '201012', state: 'Uttar Pradesh' },
  { city: 'Bareilly', district: 'Bareilly', block: 'Civil Lines', pincode: '243001', state: 'Uttar Pradesh' },
  { city: 'Gorakhpur', district: 'Gorakhpur', block: 'Civil Lines', pincode: '273001', state: 'Uttar Pradesh' },
] as const;

const FIRST_NAMES_M = ['Aarav', 'Vihaan', 'Ayaan', 'Krishna', 'Arjun', 'Rohan', 'Ishaan', 'Kabir', 'Sahil', 'Manoj', 'Vikram', 'Rakesh', 'Sanjay', 'Deepak', 'Ravi', 'Anil', 'Ramesh', 'Sunil', 'Naveen', 'Prakash'];
const FIRST_NAMES_F = ['Aanya', 'Ananya', 'Diya', 'Priya', 'Anjali', 'Meera', 'Asha', 'Sunita', 'Kavita', 'Pooja', 'Rekha', 'Shalini', 'Sneha', 'Rashmi', 'Tara', 'Indira', 'Lakshmi', 'Geeta', 'Divya', 'Ritu'];
const LAST_NAMES = ['Sharma', 'Verma', 'Kumar', 'Singh', 'Yadav', 'Pal', 'Gupta', 'Mishra', 'Tiwari', 'Shukla', 'Pandey', 'Joshi', 'Mehta', 'Reddy', 'Iyer', 'Devi', 'Bhatia', 'Sinha', 'Bose', 'Nair'];

const ORG_PREFIXES = ['Helping Hands', 'Access', 'Inclusive', 'Empower', 'Bright Future', 'Pathways', 'Sahayog', 'Sanjeevani', 'Unnati', 'Sankalp', 'Pragati', 'Disha', 'Aastha', 'Drishti', 'Saksham'];
const ORG_SUFFIXES = ['Foundation', 'Trust', 'Society', 'NGO', 'Care', 'Services', 'Hospital', 'Clinic', 'Centre', 'Academy', 'Institute', 'Network', 'Initiative', 'Enterprises', 'Pvt Ltd'];

const LOOKING_FOR_DETAILS_BY_KEY: Record<string, string[]> = {
  'Employment Opportunities': [
    'Remote-friendly desk role accessible to wheelchair users',
    'Computer operator or data-entry role with screen-reader support',
    'Part-time customer service with flexible hours',
    'Sheltered workshop or supported employment placement',
    'Tailoring or handicraft work with assistive setup',
  ],
  'Training & Skill Building': [
    'Computer literacy and basic accounting training',
    'Sign-language proficiency and interpreter coaching',
    'Vocational training in handloom / handicraft',
    'Digital-skills bootcamp accessible to visually impaired learners',
    'Soft-skills and communication coaching',
  ],
  'Assistive Devices': [
    'Manual wheelchair with cushion',
    'Refreshable braille display',
    'Hearing aid with rechargeable battery',
    'Smart cane for navigation',
    'Adapted keyboard / pointer for limited mobility',
  ],
  'Health & Rehabilitation': [
    'Monthly physiotherapy sessions',
    'Speech therapy and AAC support',
    'Mental health counselling — weekly',
    'Occupational therapy + home visits',
    'Rehabilitation post-surgery',
  ],
  'Scheme Application Support': [
    'Pension scheme application assistance',
    'UDID card renewal',
    'Disability certificate processing',
    'Education concession paperwork',
  ],
  'Counselling & Mentorship': [
    'Career counselling for accessible roles',
    'One-on-one mentorship with industry professional',
    'Peer support group facilitator',
  ],
  'Accessibility Support': [
    'Workplace accessibility audit',
    'Reasonable accommodation guidance',
    'Built-environment retrofit advice',
  ],
  'Scholarships': [
    'College tuition support for the 2026 cohort',
    'Skill-development course scholarship',
    'Boarding-cost coverage for residential training',
  ],
  'Financial Products (Loans/Insurance)': [
    'Microloan for an assistive-tech-equipped tailoring shop',
    'Health insurance with disability cover',
    'Small business working-capital loan',
  ],
  Other: [
    'Information about local resources',
    'Referral to specialist services',
  ],
};

const SERVICE_DETAILS_BY_CATEGORY: Record<string, string[]> = {
  'NGO / Trust': [
    'Skilling and job placement for PWDs across northern UP',
    'Education funding and life-skills mentorship for school dropouts',
    'Peer-led counselling and family support',
  ],
  'Government Body': [
    'Implementing scheme for UDID and benefits delivery',
    'District-level disability welfare programs',
  ],
  'Private Company': [
    'Wheelchairs, prosthetics, and mobility aids — wholesale + retail',
    'Microloans and disability-friendly insurance products',
    'Assistive-tech distribution and after-sales support',
  ],
  'Community Group': [
    'Local self-help group with monthly meetings',
    'Volunteer-led tutoring for children with learning disabilities',
  ],
  'Private Individual Practice': [
    'Speech therapy and audiology — solo practice',
    'Occupational therapy with home-visit option',
  ],
  'Hospital / Clinic': [
    'Multi-specialty rehabilitation department',
    'Audiology, speech therapy, and orthotics on site',
  ],
  'Educational Institution': [
    'Inclusive education with trained special educators',
    'Vocational training streams with accessibility built in',
  ],
  'Professional Network': [
    'PWD employment exchange — match candidates to inclusive employers',
    'Professional development cohort for the disability sector',
  ],
  'Digital Platform': [
    'Online catalog of assistive products with home delivery',
    'Telerehabilitation video-call platform',
  ],
};

// ───────────────────────────────────────────────────────────────────────────
// Record builders
// ───────────────────────────────────────────────────────────────────────────

function pad(n: number, w: number): string {
  return String(n).padStart(w, '0');
}

function buildSeeker(i: number): Record<string, unknown> {
  const gender = pick(GENDERS);
  const firstNamePool = gender === 'Female' ? FIRST_NAMES_F : gender === 'Male' ? FIRST_NAMES_M : [...FIRST_NAMES_M, ...FIRST_NAMES_F];
  const first = pick(firstNamePool);
  const last = pick(LAST_NAMES);
  const name = `${first} ${last}`;
  const loc = pick(CITIES);
  const lookingFor = pickSubset(LOOKING_FOR, 1, 3);
  const primaryNeed = lookingFor[0]!;
  const detailPool = LOOKING_FOR_DETAILS_BY_KEY[primaryNeed] ?? ['Need not specified'];
  const disabilities = pickSubset(DISABILITY_TYPES, 1, 2);
  const docs = pickSubset(DOCUMENTS_AVAILABLE, 1, 4);

  // Mobile starting with 9, sequential per record so uniqueness is guaranteed.
  const mobile = `9${pad(20_000_000 + i, 9)}`;
  const slug = `${first}.${last}.${i + 1}`.toLowerCase().replace(/[^a-z0-9.]/g, '');

  const record: Record<string, unknown> = {
    beneficiary_name: name,
    mobile_number: mobile,
    age: 15 + rint(50),
    gender,
    disability_type: disabilities,
    disability_percentage: 30 + rint(70),
    looking_for: lookingFor,
    looking_for_details: pick(detailPool),
    service_city: loc.city,
    documents_available: docs,
  };

  // Optional fields (~50% populated, deterministic per rng)
  if (rng() < 0.5) record.email = `${slug}@purpledots.example`;
  if (rng() < 0.4) record.address = `${10 + rint(990)} ${pick(['MG Road', 'Civil Lines', 'Sector 5', 'Patel Marg', 'Gandhi Nagar'])}, ${loc.city}`;
  if (rng() < 0.4) record.state = loc.state;
  if (rng() < 0.3) record.district = loc.district;
  if (rng() < 0.3) record.block = loc.block;
  if (rng() < 0.4) record.pincode = loc.pincode;
  if (rng() < 0.5) record.highest_qualification = pick(HIGHEST_QUALIFICATIONS);

  return record;
}

function buildProvider(i: number): Record<string, unknown> {
  const first = pick([...FIRST_NAMES_M, ...FIRST_NAMES_F]);
  const last = pick(LAST_NAMES);
  const contactName = `${first} ${last}`;
  const category = pick(PROVIDER_CATEGORIES);
  const orgName = `${pick(ORG_PREFIXES)} ${pick(ORG_SUFFIXES)}`;
  const services = pickSubset(SERVICES_OFFERED, 1, 4);
  const disabilities = pickSubset(DISABILITY_TYPES, 1, 5);
  const cityCount = 1 + rint(3);
  const cities = pickSubset(CITIES, cityCount, cityCount);
  const primaryCity = cities[0]!;
  const detailPool = SERVICE_DETAILS_BY_CATEGORY[category] ?? ['Service description not provided'];

  const phone = `9${pad(11_100_000 + i, 9)}`;
  const slug = `${orgName}`.toLowerCase().replace(/[^a-z0-9]+/g, '');

  const record: Record<string, unknown> = {
    contact_name: contactName,
    contact_phone: phone,
    contact_email: `${slug}.${i + 1}@purpledots.example`,
    provider_category: category,
    organisation_name: orgName,
    disabilities_served: disabilities,
    services_offered: services,
    service_cities: cities.map((c) => c.city).join('|'),
    official_address: `${10 + rint(990)} ${pick(['MG Road', 'Banking Street', 'Hospital Lane', 'Education Park', 'Industrial Area'])}, ${primaryCity.city}`,
    state: primaryCity.state,
    district: primaryCity.district,
    block: primaryCity.block,
    pincode: primaryCity.pincode,
    service_details: pick(detailPool),
  };

  // ~60% populated catalog_url
  if (rng() < 0.6) record.catalog_url = `https://${slug}.example/services`;

  return record;
}

// ───────────────────────────────────────────────────────────────────────────
// Output formatters
// ───────────────────────────────────────────────────────────────────────────

const SEEKER_COLUMNS = [
  'beneficiary_name',
  'mobile_number',
  'age',
  'gender',
  'disability_type',
  'disability_percentage',
  'looking_for',
  'looking_for_details',
  'service_city',
  'documents_available',
  'email',
  'address',
  'state',
  'district',
  'block',
  'pincode',
  'highest_qualification',
] as const;

const PROVIDER_COLUMNS = [
  'contact_name',
  'contact_phone',
  'contact_email',
  'provider_category',
  'organisation_name',
  'disabilities_served',
  'services_offered',
  'service_cities',
  'official_address',
  'state',
  'district',
  'block',
  'pincode',
  'service_details',
  'catalog_url',
] as const;

function csvEscape(v: unknown): string {
  if (v === null || v === undefined) return '';
  let s: string;
  if (Array.isArray(v)) s = v.join('|');
  else s = String(v);
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function toCsv(records: Array<Record<string, unknown>>, columns: readonly string[]): string {
  const lines: string[] = [];
  lines.push(columns.join(','));
  for (const r of records) {
    lines.push(columns.map((c) => csvEscape(r[c])).join(','));
  }
  return lines.join('\n') + '\n';
}

function toJson(records: Array<Record<string, unknown>>): string {
  return JSON.stringify(records, null, 2) + '\n';
}

// ───────────────────────────────────────────────────────────────────────────
// Main
// ───────────────────────────────────────────────────────────────────────────

const args = parseArgs(process.argv.slice(2));
rng = mulberry32(args.seed);

const records: Array<Record<string, unknown>> = [];
const build = args.domain === 'seeker' ? buildSeeker : buildProvider;
for (let i = 0; i < args.count; i++) {
  records.push(build(i));
}

let serialised: string;
if (args.outputFormat === 'csv') {
  const columns = args.domain === 'seeker' ? SEEKER_COLUMNS : PROVIDER_COLUMNS;
  serialised = toCsv(records, columns);
} else {
  serialised = toJson(records);
}

if (args.output) {
  writeFileSync(args.output, serialised, 'utf8');
  console.error(`wrote ${records.length} ${args.domain} record(s) → ${args.output} (seed=${args.seed})`);
} else {
  process.stdout.write(serialised);
}
