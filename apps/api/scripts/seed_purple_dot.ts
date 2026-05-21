/**
 * Seed Purple Dot sample records.
 *
 * Idempotent: short-circuits if any rows already exist for network=purple_dot.
 * Mirrors apps/api/src/routes/v1/item/create_item.ts for partition setup,
 * schema validation, and item_instance_url / item_schema_url construction.
 *
 * Invocation:
 *   pnpm --filter api db:seed:purple_dot
 *
 * Env overrides:
 *   PURPLE_DOT_NETWORK_JSON   path to network.json (default: examples/schemas/purple_dot/network.json)
 *   PURPLE_DOT_INSTANCE_URL   item_instance_url to record (default: http://localhost:2742)
 *   PURPLE_DOT_SEED_DRY_RUN   if set, validates records against the schema and exits without touching DB
 */

import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import {
  getDomainItemSchema,
  parseNetworkConfigDocument,
  validateAgainstJsonSchema,
} from '@dpg/schemas';

const DRY_RUN = Boolean(process.env.PURPLE_DOT_SEED_DRY_RUN);

const NETWORK = 'purple_dot';
const ITEM_TYPE = 'profile_1.0';
const SEED_USER_ID = 'purple_dot_seed';
const SEED_USER_EMAIL = 'purple-dot-seed@dpg.local';

const SCRIPT_DIR = fileURLToPath(new URL('.', import.meta.url));
const DEFAULT_NETWORK_JSON = resolve(
  SCRIPT_DIR,
  '../../../examples/schemas/purple_dot/network.json'
);
const NETWORK_JSON_PATH =
  process.env.PURPLE_DOT_NETWORK_JSON ?? DEFAULT_NETWORK_JSON;
const INSTANCE_URL =
  process.env.PURPLE_DOT_INSTANCE_URL ?? 'http://localhost:2742';

type SeedRecord = {
  state: Record<string, unknown>;
  latitude?: number;
  longitude?: number;
};

// Approximate centroid of Lucknow, UP — many PDF records share this city.
const LUCKNOW: [number, number] = [26.8467, 80.9462];

const SEEKER_RECORDS: SeedRecord[] = [
  {
    state: {
      beneficiary_name: 'Name_290',
      mobile_number: '9000000290',
      age: 44,
      gender: 'Male',
      disability_type: ['Locomotor Disability'],
      disability_percentage: 90,
      looking_for: ['Assistive Devices', 'Employment Opportunities', 'Financial Products (Loans/Insurance)'],
      looking_for_details: 'Monetary support, walking aid.',
      service_city: 'Lucknow',
      address: 'Dauli Kheda Badagar Kakori, Lucknow, Uttar Pradesh',
      state: 'Uttar Pradesh',
      district: 'Lucknow',
      block: 'Bakshi Ka Talab',
      documents_available: ['Income Certificate', 'Disability Certificate'],
    },
    latitude: LUCKNOW[0],
    longitude: LUCKNOW[1],
  },
  {
    state: {
      beneficiary_name: 'Name_294',
      mobile_number: '9000000294',
      age: 41,
      gender: 'Male',
      disability_type: ['Locomotor Disability'],
      disability_percentage: 97,
      looking_for: ['Assistive Devices', 'Employment Opportunities', 'Financial Products (Loans/Insurance)'],
      looking_for_details:
        'Motor scooter for locomotor disability; financial aid to run a small shop.',
      service_city: 'Lucknow',
      address: 'Sijanpur, Lucknow, Uttar Pradesh',
      state: 'Uttar Pradesh',
      district: 'Lucknow',
      block: 'Bakshi Ka Talab',
      documents_available: ['Aadhaar'],
    },
    latitude: LUCKNOW[0],
    longitude: LUCKNOW[1],
  },
  {
    state: {
      beneficiary_name: 'Name_301',
      mobile_number: '9000000301',
      age: 28,
      gender: 'Female',
      disability_type: ['Locomotor Disability'],
      disability_percentage: 100,
      looking_for: ['Assistive Devices', 'Employment Opportunities'],
      looking_for_details: 'Support to find work and start a small business.',
      service_city: 'Lucknow',
      address: '628-S/177-C, Peer Bagh Colony, Shakti Nagar, Lucknow, Uttar Pradesh',
      state: 'Uttar Pradesh',
      district: 'Lucknow',
      block: 'Bakshi Ka Talab',
      documents_available: ['Disability Certificate'],
    },
    latitude: LUCKNOW[0],
    longitude: LUCKNOW[1],
  },
  {
    state: {
      beneficiary_name: 'Name_319',
      mobile_number: '9000000319',
      age: 21,
      gender: 'Male',
      disability_type: ['Blindness'],
      disability_percentage: 100,
      looking_for: ['Assistive Devices', 'Scholarships', 'Financial Products (Loans/Insurance)'],
      looking_for_details:
        '3G phone, around twenty-nine thousand rupees, financial assistance of five to six thousand rupees per month for education.',
      service_city: 'Lucknow',
      address: '588/7, Birhana Kheda Aurangabad Khalsa, L D A Colony, Lucknow, Uttar Pradesh',
      state: 'Uttar Pradesh',
      district: 'Lucknow',
      block: 'Bakshi Ka Talab',
      documents_available: ['Aadhaar', 'Disability Certificate'],
      highest_qualification: '12th Pass',
    },
    latitude: LUCKNOW[0],
    longitude: LUCKNOW[1],
  },
  {
    state: {
      beneficiary_name: 'Name_390',
      mobile_number: '9000000390',
      age: 23,
      gender: 'Female',
      disability_type: ['Blindness'],
      disability_percentage: 100,
      looking_for: ['Assistive Devices'],
      looking_for_details:
        'Aid or appliance to make daily activities easier despite blindness.',
      service_city: 'Lucknow',
      address: 'Mirgapur Pandi-Pedwa, Gomtinath, Ward 12, Lucknow, Uttar Pradesh',
      state: 'Uttar Pradesh',
      district: 'Lucknow',
      block: 'Bakshi Ka Talab',
      documents_available: ['Aadhaar'],
    },
    latitude: LUCKNOW[0],
    longitude: LUCKNOW[1],
  },
  {
    state: {
      beneficiary_name: 'Name_414',
      mobile_number: '9000000414',
      age: 10,
      gender: 'Male',
      disability_type: ['Locomotor Disability'],
      disability_percentage: 50,
      looking_for: ['Assistive Devices', 'Health & Rehabilitation', 'Scholarships'],
      looking_for_details:
        'Access to government benefits, hand aids and appliances for locomotor disability, in-kind support such as a battery-operated cycle for travel to school.',
      service_city: 'Bakshi Ka Talab',
      address: 'Mall Post Thawar, Lucknow, Uttar Pradesh',
      state: 'Uttar Pradesh',
      district: 'Lucknow',
      block: 'Bakshi Ka Talab',
      documents_available: ['Disability Certificate'],
    },
    latitude: LUCKNOW[0],
    longitude: LUCKNOW[1],
  },
  {
    state: {
      beneficiary_name: 'Name_421',
      mobile_number: '9000000421',
      age: 21,
      gender: 'Female',
      disability_type: ['Blindness'],
      disability_percentage: 100,
      looking_for: ['Scholarships'],
      looking_for_details:
        'Exam fees and Education-related expenses; preparing for competitive exams; support with school or college fees.',
      service_city: 'Lucknow',
      address: 'Chander Nagar Alambagh Bakshi Ka Talab, Lucknow, Uttar Pradesh',
      state: 'Uttar Pradesh',
      district: 'Lucknow',
      block: 'Bakshi Ka Talab',
      documents_available: ['Aadhaar'],
      highest_qualification: 'College Graduate',
    },
    latitude: LUCKNOW[0],
    longitude: LUCKNOW[1],
  },
  {
    state: {
      beneficiary_name: 'Name_516',
      mobile_number: '9000000516',
      age: 30,
      gender: 'Male',
      disability_type: ['Locomotor Disability'],
      disability_percentage: 90,
      looking_for: ['Assistive Devices'],
      looking_for_details: 'Aid or appliance for locomotor disability.',
      service_city: 'Lucknow',
      address: 'Gram Post Karbiyora Sitapur, Lucknow, Uttar Pradesh',
      state: 'Uttar Pradesh',
      district: 'Lucknow',
      block: 'Bakshi Ka Talab',
      documents_available: ['Aadhaar'],
    },
    latitude: LUCKNOW[0],
    longitude: LUCKNOW[1],
  },
  {
    state: {
      beneficiary_name: 'Name_612',
      mobile_number: '9000000612',
      age: 62,
      gender: 'Male',
      disability_type: ['Locomotor Disability'],
      disability_percentage: 45,
      looking_for: ['Employment Opportunities', 'Training & Skill Building', 'Other'],
      looking_for_details:
        'Job opportunities, upskilling or training for new skills.',
      service_city: 'Bakshi Ka Talab',
      address: 'Iskel Khera Gehndo, Lucknow, Uttar Pradesh',
      state: 'Uttar Pradesh',
      district: 'Lucknow',
      block: 'Bakshi Ka Talab',
      documents_available: ['Aadhaar'],
    },
    latitude: LUCKNOW[0],
    longitude: LUCKNOW[1],
  },
  {
    state: {
      beneficiary_name: 'Name_722',
      mobile_number: '9000000722',
      age: 45,
      gender: 'Male',
      disability_type: ['Locomotor Disability'],
      disability_percentage: 100,
      looking_for: ['Assistive Devices'],
      looking_for_details: 'Battery-operated bicycle.',
      service_city: 'Lucknow',
      address: 'Kasmandi Khurd Mahilabad, Lucknow, Uttar Pradesh',
      state: 'Uttar Pradesh',
      district: 'Lucknow',
      block: 'Bakshi Ka Talab',
      documents_available: ['Disability Certificate'],
    },
    latitude: LUCKNOW[0],
    longitude: LUCKNOW[1],
  },
  {
    state: {
      beneficiary_name: 'Name_758',
      mobile_number: '9000000758',
      age: 34,
      gender: 'Male',
      disability_type: ['Locomotor Disability'],
      disability_percentage: 65,
      looking_for: ['Financial Products (Loans/Insurance)'],
      looking_for_details:
        'Government housing support for disabled people.',
      service_city: 'Bakshi Ka Talab',
      address: 'Pitali Bharwan Hardoi, Lucknow, Uttar Pradesh',
      state: 'Uttar Pradesh',
      district: 'Lucknow',
      block: 'Bakshi Ka Talab',
      documents_available: ['Aadhaar'],
    },
    latitude: LUCKNOW[0],
    longitude: LUCKNOW[1],
  },
  {
    state: {
      beneficiary_name: 'Name_778',
      mobile_number: '9000000778',
      age: 56,
      gender: 'Other',
      disability_type: ['Locomotor Disability'],
      disability_percentage: 90,
      looking_for: ['Assistive Devices', 'Employment Opportunities', 'Financial Products (Loans/Insurance)'],
      looking_for_details:
        'Financial aid, employment opportunities, society support for locomotor disability.',
      service_city: 'Lucknow',
      address: '256/4S/151 Takiya Chand Ali Shah Chota Imambada Ground Aishbagh, Lucknow, Uttar Pradesh',
      state: 'Uttar Pradesh',
      district: 'Lucknow',
      block: 'Bakshi Ka Talab',
      documents_available: ['Aadhaar', 'Bank Account'],
    },
    latitude: LUCKNOW[0],
    longitude: LUCKNOW[1],
  },
  {
    state: {
      beneficiary_name: 'Name_887',
      mobile_number: '9000000887',
      age: 40,
      gender: 'Female',
      disability_type: ['Locomotor Disability'],
      disability_percentage: 90,
      looking_for: ['Assistive Devices'],
      looking_for_details:
        'Aids or appliances for locomotor disability, ration and household items.',
      service_city: 'Lucknow',
      address: 'D/O Mohd Raheem Khan, 270/345, Lakad Mandi Hata Noor Beg Saharab Nagar, Lucknow, Uttar Pradesh',
      state: 'Uttar Pradesh',
      district: 'Lucknow',
      block: 'Bakshi Ka Talab',
      documents_available: ['Disability Certificate'],
    },
    latitude: LUCKNOW[0],
    longitude: LUCKNOW[1],
  },
  {
    state: {
      beneficiary_name: 'Name_991',
      mobile_number: '9000000991',
      age: 36,
      gender: 'Male',
      disability_type: ['Locomotor Disability'],
      disability_percentage: 85,
      looking_for: ['Assistive Devices', 'Financial Products (Loans/Insurance)'],
      looking_for_details:
        'Battery-operated cycle as an aid for locomotor disability; financial support like a government loan to start a small business.',
      service_city: 'Bakshi Ka Talab',
      address: 'Sainpa Thakur Mall, Lucknow, Bakshi Ka Talab, Uttar Pradesh',
      state: 'Uttar Pradesh',
      district: 'Lucknow',
      block: 'Bakshi Ka Talab',
      documents_available: ['Aadhaar', 'Disability Certificate'],
    },
    latitude: LUCKNOW[0],
    longitude: LUCKNOW[1],
  },
  {
    state: {
      beneficiary_name: 'Name_1023',
      mobile_number: '9000001023',
      age: 28,
      gender: 'Female',
      disability_type: ['Locomotor Disability'],
      disability_percentage: 90,
      looking_for: ['Assistive Devices', 'Other'],
      looking_for_details:
        'Battery-operated cycle to assist with daily activities and work; housing support, ration card, BPL card related support.',
      service_city: 'Lucknow',
      address: 'Bankudipur Bakshi Ka Talab, Lucknow, Uttar Pradesh',
      state: 'Uttar Pradesh',
      district: 'Lucknow',
      block: 'Bakshi Ka Talab',
      documents_available: ['Income Certificate', 'Disability Certificate'],
    },
    latitude: LUCKNOW[0],
    longitude: LUCKNOW[1],
  },
];

const PROVIDER_RECORDS: SeedRecord[] = [
  {
    state: {
      contact_name: 'Test Provider 1',
      contact_phone: '8005542316',
      contact_email: 'provider1@dironl.com',
      provider_category: 'Private Individual Practice',
      organisation_name: 'TestProvider1',
      disabilities_served: [
        'Hearing Impairment',
        'Low Vision',
        'Locomotor Disability',
      ],
      services_offered: ['Assistive Devices'],
      service_cities: 'Lucknow',
      official_address: 'Anjora, Near Nigam Chouraha, Lucknow, Uttar Pradesh',
      state: 'Uttar Pradesh',
      district: 'Lucknow',
      block: 'Lucknow',
      service_details:
        'Hearing aids, visual aids, camp distribution, subsidised; call or contact web for booking.',
    },
    latitude: LUCKNOW[0],
    longitude: LUCKNOW[1],
  },
  {
    state: {
      contact_name: 'Rajesh Sharma',
      contact_phone: '9879043213',
      contact_email: 'rajesh.sharma@hopedis-ability.org',
      provider_category: 'NGO / Trust',
      organisation_name: 'Hope Disability Foundation',
      disabilities_served: [
        'Blindness',
        'Low Vision',
        'Hearing Impairment',
        'Deaf',
        'Hard of Hearing',
        'Locomotor Disability',
        'Intellectual Disability',
      ],
      services_offered: ['Training & Skill Building'],
      service_cities: 'Hosadarshini, New Town Domalur, Lucknow',
      official_address: 'New Town Domalur, Lucknow, Uttar Pradesh',
      state: 'Uttar Pradesh',
      district: 'Lucknow',
      block: 'Lucknow',
      service_details:
        'For adults aged 18 to 35 with UDID. Walk-in registration available.',
    },
    latitude: LUCKNOW[0],
    longitude: LUCKNOW[1],
  },
  {
    state: {
      contact_name: 'Dr Meena Kulkarni',
      contact_phone: '8838812278',
      contact_email: 'meena@retailcare.in',
      provider_category: 'Private Individual Practice',
      organisation_name: 'RetailCare Physiotherapy',
      disabilities_served: [
        'Locomotor Disability',
        'Cerebral Palsy',
        'Muscular Dystrophy',
        'Chronic Neurological Conditions',
      ],
      services_offered: ['Health & Rehabilitation'],
      service_cities: 'Lucknow, Kanpur',
      official_address: 'Rajajipuram, Sector C, Near Rajajipuram Railway, Lucknow, Uttar Pradesh',
      state: 'Uttar Pradesh',
      district: 'Lucknow',
      block: 'Lucknow',
      service_details: 'Outpatient physiotherapy. Walk-in or call for appointment.',
    },
    latitude: LUCKNOW[0],
    longitude: LUCKNOW[1],
  },
  {
    state: {
      contact_name: 'Suresh Patil',
      contact_phone: '9803123456',
      contact_email: 'suresh@mobilityworld.com',
      provider_category: 'Private Company',
      organisation_name: 'Mobility World India',
      disabilities_served: ['Locomotor Disability', 'Multiple Disabilities'],
      services_offered: ['Assistive Devices'],
      service_cities: 'Lucknow',
      official_address: 'Rambagh, Near Kawnbagh Bus Stand, Lucknow, Uttar Pradesh',
      state: 'Uttar Pradesh',
      district: 'Lucknow',
      block: 'Lucknow',
      service_details:
        'Wheelchairs, crutches, prosthetic limbs, showroom + home delivery (Rs 5,000 to Rs 50,000). Call or visit showroom.',
      catalog_url: 'https://mobilityworldindia.example/catalog.pdf',
    },
    latitude: LUCKNOW[0],
    longitude: LUCKNOW[1],
  },
  {
    state: {
      contact_name: 'Anita Desai',
      contact_phone: '9883752426',
      contact_email: 'anita.desai@sambhavyam-incl.org',
      provider_category: 'NGO / Trust',
      organisation_name: 'Sambhavyam Inclusion Centre',
      disabilities_served: [
        'Autism Spectrum Disorder',
        'Intellectual Disability',
        'Specific Learning Disabilities',
        'Multiple Disabilities',
      ],
      services_offered: ['Training & Skill Building'],
      service_cities: 'Chinhat, Lucknow',
      official_address: 'Chinhat, Near Chinhat Tiraha, Lucknow, Uttar Pradesh',
      state: 'Uttar Pradesh',
      district: 'Lucknow',
      block: 'Lucknow',
      service_details:
        'Subsidised PWD activities aged 16-35. Online application.',
    },
    latitude: LUCKNOW[0],
    longitude: LUCKNOW[1],
  },
  {
    state: {
      contact_name: 'Mohammed Irfan',
      contact_phone: '9712345697',
      contact_email: 'irfan@soundbridge.in',
      provider_category: 'Private Company',
      organisation_name: 'SoundBridge Hearing Solutions',
      disabilities_served: ['Hearing Impairment', 'Deaf', 'Hard of Hearing'],
      services_offered: ['Assistive Devices'],
      service_cities: 'Lucknow',
      official_address: 'Gomti Nagar, Near Lulu Mall, Lucknow, Uttar Pradesh',
      state: 'Uttar Pradesh',
      district: 'Lucknow',
      block: 'Lucknow',
      service_details:
        'Hearing aids, cochlear implant accessories, ear moulds; in-store fitting + home visit (Rs 5,000 to Rs 75,000). Book appointment online.',
    },
    latitude: LUCKNOW[0],
    longitude: LUCKNOW[1],
  },
  {
    state: {
      contact_name: 'Priya Hegde',
      contact_phone: '9832123478',
      contact_email: 'priya@enableindia.org',
      provider_category: 'NGO / Trust',
      organisation_name: 'Enable India Mysuru Chapter',
      disabilities_served: [
        'Blindness',
        'Low Vision',
        'Hearing Impairment',
        'Deaf',
        'Locomotor Disability',
        'Cerebral Palsy',
        'Multiple Disabilities',
      ],
      services_offered: ['Training & Skill Building'],
      service_cities: 'Lucknow, Bengaluru',
      official_address: 'Hosadarshini, Near GPO, Lucknow, Uttar Pradesh',
      state: 'Uttar Pradesh',
      district: 'Lucknow',
      block: 'Lucknow',
      service_details:
        'For adults aged 18 to 35 with UDID. Walk-in registration.',
    },
    latitude: LUCKNOW[0],
    longitude: LUCKNOW[1],
  },
  {
    state: {
      contact_name: 'Dr. Venkatesh Rao',
      contact_phone: '9843979834',
      contact_email: 'venkatesh@spandana.org',
      provider_category: 'Hospital / Clinic',
      organisation_name: 'Spandana Rehabilitation Centre',
      disabilities_served: [
        'Locomotor Disability',
        'Cerebral Palsy',
        'Chronic Neurological Conditions',
        'Multiple Disabilities',
      ],
      services_offered: ['Health & Rehabilitation'],
      service_cities: 'Lucknow, Kanpur',
      official_address: 'Annandiad, Near Annandiad Station, Lucknow, Uttar Pradesh',
      state: 'Uttar Pradesh',
      district: 'Lucknow',
      block: 'Lucknow',
      service_details:
        'Multidisciplinary rehabilitation, outpatient and inpatient; BPL pricing available.',
    },
    latitude: LUCKNOW[0],
    longitude: LUCKNOW[1],
  },
];

function validateBatch(
  domain: 'seeker' | 'provider',
  itemSchema: Record<string, unknown>,
  records: SeedRecord[]
) {
  for (const [index, record] of records.entries()) {
    validateAgainstJsonSchema(
      itemSchema,
      record.state,
      `${domain} record #${index + 1}`
    );
  }
}

async function ensureSeedUser(
  database: NodePgDatabase<any>,
  userTable: any
) {
  await database
    .insert(userTable)
    .values({
      id: SEED_USER_ID,
      name: 'Purple Dot Seed',
      email: SEED_USER_EMAIL,
      emailVerified: true,
    })
    .onConflictDoNothing({ target: userTable.id });
}

async function insertDomainRecords(
  database: NodePgDatabase<any>,
  itemsTable: typeof import('@dpg/database').items,
  domain: 'seeker' | 'provider',
  records: SeedRecord[]
) {
  const schemaUrl = `${INSTANCE_URL}/api/v1/network/schema/${NETWORK}/${domain}/${ITEM_TYPE}`;

  for (const record of records) {
    await database
      .insert(itemsTable)
      .values({
        item_network: NETWORK,
        item_domain: domain,
        item_type: ITEM_TYPE,
        item_instance_url: INSTANCE_URL,
        item_schema_url: schemaUrl,
        item_state: record.state,
        item_latitude: record.latitude ?? null,
        item_longitude: record.longitude ?? null,
        created_by: SEED_USER_ID,
      })
      .onConflictDoNothing({
        target: [
          itemsTable.item_network,
          itemsTable.item_domain,
          itemsTable.item_type,
          itemsTable.item_id,
        ],
      });
  }
}

async function main() {
  console.log(`[seed:purple_dot] loading network config from ${NETWORK_JSON_PATH}`);
  const networkConfig = parseNetworkConfigDocument(
    JSON.parse(readFileSync(NETWORK_JSON_PATH, 'utf8'))
  );

  if (networkConfig.id !== NETWORK) {
    throw new Error(
      `Loaded network config id "${networkConfig.id}" does not match expected "${NETWORK}".`
    );
  }

  const seekerSchema = getDomainItemSchema(networkConfig, 'seeker', ITEM_TYPE);
  const providerSchema = getDomainItemSchema(
    networkConfig,
    'provider',
    ITEM_TYPE
  );

  validateBatch('seeker', seekerSchema, SEEKER_RECORDS);
  validateBatch('provider', providerSchema, PROVIDER_RECORDS);
  console.log(
    `[seed:purple_dot] validated ${SEEKER_RECORDS.length} seeker + ${PROVIDER_RECORDS.length} provider records`
  );

  if (DRY_RUN) {
    console.log('[seed:purple_dot] DRY_RUN set; skipping DB writes.');
    return;
  }

  // Defer DB-side imports until we know we will actually touch the DB so the
  // dry-run path can run without a configured PG connection.
  const { ensureItemPartition, items } = await import('@dpg/database');
  const { db } = await import('../db/postgres/drizzle_config');
  const { user } = await import('../db/postgres/schema/auth');

  const existing = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(items)
    .where(sql`${items.item_network} = ${NETWORK}`);

  const existingCount = existing[0]?.count ?? 0;
  if (existingCount > 0) {
    console.log(
      `[seed:purple_dot] skipping: network "${NETWORK}" already has ${existingCount} item(s).`
    );
    return;
  }

  await ensureSeedUser(db, user);
  await ensureItemPartition(db, NETWORK, 'seeker');
  await ensureItemPartition(db, NETWORK, 'provider');

  await insertDomainRecords(db, items, 'seeker', SEEKER_RECORDS);
  console.log(`[seed:purple_dot] inserted ${SEEKER_RECORDS.length} seeker records`);

  await insertDomainRecords(db, items, 'provider', PROVIDER_RECORDS);
  console.log(`[seed:purple_dot] inserted ${PROVIDER_RECORDS.length} provider records`);

  console.log('[seed:purple_dot] done.');
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('[seed:purple_dot] failed:', err);
    process.exit(1);
  });
