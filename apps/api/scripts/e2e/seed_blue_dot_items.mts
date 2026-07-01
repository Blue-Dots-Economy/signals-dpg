/**
 * Seed a handful of blue_dot seekers (profile_1.0) and providers
 * (job_posting_1.0) so connect/apply consent flows can be tested in the UI.
 *
 * Creates dedicated test users as owners (so they don't collide with real
 * sign-ins) and inserts items via the real createItemInternal service — which
 * splits PII into the encrypted private state and classifies lifecycle. No
 * geocoding (item_locations: []).
 *
 * Run (from repo root):
 *   pnpm --filter api exec node --env-file=../../.env --import tsx scripts/e2e/seed_blue_dot_items.mts
 * with the API env pointed at blue_dot (SERVED_DOMAINS=blue_dot/seeker,blue_dot/provider,
 * NETWORK_CONFIG_LOCAL_FILE=../../examples/schemas/blue_dot/network.json).
 */
import { randomUUID } from 'node:crypto';
import { db } from '@api/db/postgres/drizzle_config';
import { user } from '@api/db/postgres/schema';
import { createItemInternal } from '@/services/item_service';

const NETWORK = 'blue_dot';

function phone(i: number): string {
  const suffix = String(90000000 + Math.floor(Math.random() * 9000000) + i).slice(0, 8);
  return `+9190${suffix}`;
}

async function makeUser(name: string, i: number): Promise<string> {
  const id = randomUUID();
  await db.insert(user).values({
    id,
    name,
    phoneNumber: phone(i),
    phoneNumberVerified: true,
    role: 'user',
  });
  return id;
}

const seekers = [
  { name: 'Aarav Sharma', location: 'Lucknow, Uttar Pradesh', age: 24, phone: '+919812300001' },
  { name: 'Priya Verma', location: 'Kanpur, Uttar Pradesh', age: 27, phone: '+919812300002' },
  { name: 'Rohit Yadav', location: 'Varanasi, Uttar Pradesh', age: 22, phone: '+919812300003' },
  { name: 'Sneha Gupta', location: 'Agra, Uttar Pradesh', age: 29, phone: '+919812300004' },
  { name: 'Imran Khan', location: 'Prayagraj, Uttar Pradesh', age: 26, phone: '+919812300005' },
];

const providers = [
  { jobProviderName: 'Ganga Textiles Pvt Ltd', role: 'Machine Operator', jobProviderLocation: 'Kanpur, Uttar Pradesh', hiringManagerName: 'Suresh Nair', hiringManagerPhoneNumber: '+919845100001', hiringManagerEmail: 'hr@gangatextiles.example', positions: 5, natureOfJob: 'Full-time' },
  { jobProviderName: 'Awadh Retail Solutions', role: 'Sales Associate', jobProviderLocation: 'Lucknow, Uttar Pradesh', hiringManagerName: 'Meena Joshi', hiringManagerPhoneNumber: '+919845100002', hiringManagerEmail: 'careers@awadhretail.example', positions: 8, natureOfJob: 'Full-time' },
  { jobProviderName: 'Kashi Hospitality Group', role: 'Front Desk Trainee', jobProviderLocation: 'Varanasi, Uttar Pradesh', hiringManagerName: 'Anil Kumar', hiringManagerPhoneNumber: '+919845100003', hiringManagerEmail: 'jobs@kashihospitality.example', positions: 3, natureOfJob: 'Apprenticeship' },
  { jobProviderName: 'Taj Logistics', role: 'Delivery Coordinator', jobProviderLocation: 'Agra, Uttar Pradesh', hiringManagerName: 'Farah Ali', hiringManagerPhoneNumber: '+919845100004', hiringManagerEmail: 'recruit@tajlogistics.example', positions: 4, natureOfJob: 'Flexible' },
  { jobProviderName: 'Sangam Skills Academy', role: 'Junior Trainer', jobProviderLocation: 'Prayagraj, Uttar Pradesh', hiringManagerName: 'Ravi Tiwari', hiringManagerPhoneNumber: '+919845100005', hiringManagerEmail: 'hiring@sangamskills.example', positions: 2, natureOfJob: 'Internship' },
];

let created = 0;

for (let i = 0; i < seekers.length; i++) {
  const ownerId = await makeUser(`Test Seeker ${i + 1}`, i);
  const res = await createItemInternal(db, {
    item_network: NETWORK,
    item_domain: 'seeker',
    item_type: 'profile_1.0',
    item_state: seekers[i],
    item_locations: [],
    created_by: ownerId,
  });
  created++;
  console.log(`seeker  ${i + 1}: item_id=${res.itemId} owner=${ownerId} (${seekers[i].name})`);
}

for (let i = 0; i < providers.length; i++) {
  const ownerId = await makeUser(`Test Provider ${i + 1}`, 100 + i);
  const res = await createItemInternal(db, {
    item_network: NETWORK,
    item_domain: 'provider',
    item_type: 'job_posting_1.0',
    item_state: providers[i],
    item_locations: [],
    created_by: ownerId,
  });
  created++;
  console.log(`provider ${i + 1}: item_id=${res.itemId} owner=${ownerId} (${providers[i].jobProviderName} — ${providers[i].role})`);
}

console.log(`\nDone. Created ${created} items (${seekers.length} seekers + ${providers.length} providers).`);
process.exit(0);
