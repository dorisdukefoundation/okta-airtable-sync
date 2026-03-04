const express = require('express');
const app = express();
app.use(express.json());

const AIRTABLE_TOKEN = process.env.AIRTABLE_TOKEN;
const AIRTABLE_BASE  = process.env.AIRTABLE_BASE || 'appJXuJF1SCo1t7Jn';
const AIRTABLE_TABLE = process.env.AIRTABLE_TABLE || 'Okta Users';

// ── Employee Type: Okta string → Airtable linked record ID ──────────────
const EMPLOYEE_TYPE_MAP = {
  'full time':        'recjy2P6bl7kW7O3N',
  'consultant':       'recD2jkb9PsMGlK61',
  'shared login':     'recNzTvS9cPVUB3uj',
  'services account': 'recbwDiVkn3gfJLhy',
  'part time':        'recCIEimd9YDXmd4e',
  'intern':           'rec7eWxoFHmMOPs6B',
  'seasonal':         'recqqyrIxh8e1mVuj',
  'service account':  'rec6oERg4kuIkWPgW',
};
function mapEmployeeType(val) {
  if (!val) return undefined;
  const id = EMPLOYEE_TYPE_MAP[val.toLowerCase().trim()];
  if (!id) { console.log(`Unknown Employee Type: "${val}" — skipping`); return undefined; }
  return [id];
}

// ── Startup diagnostics ───────────────────────────────────────────────────
console.log('=== STARTUP DIAGNOSTICS ===');
console.log('OKTA_DOMAIN:', process.env.OKTA_DOMAIN || 'MISSING');
console.log('OKTA_API_TOKEN:', process.env.OKTA_API_TOKEN ? `set (${process.env.OKTA_API_TOKEN.length} chars)` : 'MISSING');
console.log('AIRTABLE_TOKEN:', process.env.AIRTABLE_TOKEN ? `set (${process.env.AIRTABLE_TOKEN.length} chars)` : 'MISSING');
console.log('AIRTABLE_BASE:', AIRTABLE_BASE);
console.log('AIRTABLE_TABLE:', AIRTABLE_TABLE);
console.log('===========================');

// ── Okta Event Hook verification ──────────────────────────────────────────
app.get('/okta-webhook', (req, res) => {
  const challenge = req.headers['x-okta-verification-challenge'];
  if (challenge) return res.json({ verification: challenge });
  res.sendStatus(200);
});

// ── Okta Event Hook receiver ──────────────────────────────────────────────
app.post('/okta-webhook', async (req, res) => {
  const events = req.body?.data?.events || [];
  console.log(`\n=== INCOMING WEBHOOK: ${events.length} event(s) ===`);

  // Process ALL events BEFORE sending 200 — Vercel cuts off async work after response
  for (const event of events) {
    try {
      await handleEvent(event);
    } catch (err) {
      console.error(`UNHANDLED ERROR in handleEvent:`, err.message, err.stack);
    }
  }

  // Acknowledge AFTER processing — Okta waits up to 3 seconds before retrying
  res.sendStatus(200);
});

// ── Event router ──────────────────────────────────────────────────────────
async function handleEvent(event) {
  const type = event.eventType;
  console.log(`\n--- EVENT: ${type} ---`);
  console.log('Full event payload:', JSON.stringify(event, null, 2));

  const target = event.target?.find(t => t.type === 'User');
  if (!target) {
    console.log('No User target found in event — skipping');
    return;
  }

  const oktaId = target.id;
  const email  = target.alternateId;
  console.log(`User: ${email} (${oktaId})`);

  // ── Find Airtable record ────────────────────────────────────────────────
  console.log(`\nStep 1: Looking up Airtable record...`);
  const record = await findAirtableRecord(oktaId, email);
  console.log(`Step 1 result: ${record ? `Found — record ID ${record.id}` : 'NOT FOUND'}`);

  // ── DEACTIVATE / DELETE ─────────────────────────────────────────────────
  if (['user.lifecycle.deactivate', 'user.lifecycle.delete'].includes(type)) {
    console.log(`\nStep 2: Marking INACTIVE...`);
    if (record) {
      const result = await updateAirtableRecord(record.id, { Status: 'INACTIVE' });
      console.log(`Step 2 result: ${result ? 'Success' : 'Failed'}`);
    } else {
      console.log(`Step 2: No record to update`);
    }
    return;
  }

  // ── CREATE ──────────────────────────────────────────────────────────────
  if (type === 'user.lifecycle.create') {
    console.log(`\nStep 2: Fetching Okta profile for new user...`);
    const profile = await fetchOktaUser(oktaId);
    if (!profile) { console.error('Step 2 FAILED: Could not fetch Okta profile'); return; }
    const fields = buildAirtableFields(oktaId, profile);
    console.log(`Step 2: Fields to write:`, JSON.stringify(fields, null, 2));
    console.log(`\nStep 3: ${record ? 'Updating' : 'Creating'} Airtable record...`);
    const result = record
      ? await updateAirtableRecord(record.id, fields)
      : await createAirtableRecord(fields);
    console.log(`Step 3 result: ${result ? 'Success' : 'Failed'}`);
    return;
  }

  // ── PROFILE UPDATE / ACTIVATE / REACTIVATE ──────────────────────────────
  if (['user.profile.update', 'user.account.update_profile', 'user.lifecycle.activate', 'user.lifecycle.reactivate'].includes(type)) {
    console.log(`\nStep 2: Fetching Okta profile...`);
    const profile = await fetchOktaUser(oktaId);
    if (!profile) { console.error('Step 2 FAILED: Could not fetch Okta profile'); return; }
    const fields = buildAirtableFields(oktaId, profile);
    console.log(`Step 2: Fields to write:`, JSON.stringify(fields, null, 2));
    console.log(`\nStep 3: ${record ? 'Updating' : 'Creating'} Airtable record...`);
    const result = record
      ? await updateAirtableRecord(record.id, fields)
      : await createAirtableRecord(fields);
    console.log(`Step 3 result: ${result ? 'Success' : 'Failed'}`);
    return;
  }

  console.log(`No handler for event type: ${type}`);
}

// ── Okta API: fetch full user profile ─────────────────────────────────────
async function fetchOktaUser(oktaId) {
  const OKTA_DOMAIN = process.env.OKTA_DOMAIN;
  const OKTA_TOKEN  = process.env.OKTA_API_TOKEN;

  if (!OKTA_DOMAIN || !OKTA_TOKEN) {
    console.error('FATAL: Missing OKTA_DOMAIN or OKTA_API_TOKEN');
    return null;
  }

  const url = `https://${OKTA_DOMAIN}/api/v1/users/${oktaId}`;
  console.log(`Okta API call: GET ${url}`);

  try {
    const res = await fetch(url, {
      headers: { Authorization: `SSWS ${OKTA_TOKEN}`, Accept: 'application/json' }
    });
    const text = await res.text();
    console.log(`Okta API response: ${res.status}`);
    if (!res.ok) {
      console.error(`Okta API error body: ${text}`);
      return null;
    }
    const user = JSON.parse(text);
    console.log(`Okta profile fields:`, JSON.stringify(user.profile, null, 2));
    return user;
  } catch (err) {
    console.error(`Okta API fetch exception: ${err.message}`);
    return null;
  }
}

// ── Map Okta profile → Airtable fields ────────────────────────────────────
function buildAirtableFields(oktaId, oktaUser) {
  if (!oktaUser) { console.error('buildAirtableFields: oktaUser is null'); return {}; }
  const p = oktaUser.profile || {};
  const fields = {
    'User Id':            oktaId,
    'Status':             oktaUser.status || '',
    'Activated Date':     oktaUser.activated || '',
    'Last Login Date':    oktaUser.lastLogin || '',
    'Username':           p.login || '',
    'First name':         p.firstName || '',
    'Last name':          p.lastName || '',
    'Primary email':      p.email || '',
    'Title':              p.title || '',
    'Display name':       p.displayName || '',
    'Nickname':           p.nickName || p.nickname || '',
    'Secondary email':    p.secondEmail || '',
    'Mobile phone':       p.mobilePhone || '',
    'Primary phone':      p.primaryPhone || '',
    'State':              p.state || '',
    ...(mapEmployeeType(p.userType || p.employeeType || p.user_type) !== undefined
      ? { 'Employee Type': mapEmployeeType(p.userType || p.employeeType || p.user_type) }
      : {}),
    'Employee number':    p.employeeNumber || '',
    'Cost center':        p.costCenter || '',
    'ManagerId':          p.managerId || '',
    // NOTE: Organization, Department, Full Name, Manager, People Data, Calculation
    // are computed/lookup fields in Airtable — do not write to these
  };
  console.log('Built Airtable fields:', JSON.stringify(fields, null, 2));
  return fields;
}

// ── Airtable: find record ─────────────────────────────────────────────────
async function findAirtableRecord(oktaId, email) {
  let record = await airtableSearch('User Id', oktaId);
  if (record) return record;
  if (email) {
    console.log(`User Id not found, trying email fallback...`);
    record = await airtableSearch('Primary email', email);
  }
  return record || null;
}

async function airtableSearch(field, value) {
  const formula = encodeURIComponent(`{${field}}="${value}"`);
  const url = `https://api.airtable.com/v0/${AIRTABLE_BASE}/${encodeURIComponent(AIRTABLE_TABLE)}?filterByFormula=${formula}&maxRecords=1`;
  console.log(`Airtable search: ${field} = "${value}"`);
  console.log(`Airtable URL: ${url}`);

  try {
    const res = await fetch(url, { headers: airtableHeaders() });
    const text = await res.text();
    console.log(`Airtable search response: ${res.status} — ${text.substring(0, 500)}`);
    if (!res.ok) return null;
    const data = JSON.parse(text);
    console.log(`Airtable records returned: ${data.records?.length || 0}`);
    return data.records?.[0] || null;
  } catch (err) {
    console.error(`Airtable search exception: ${err.message}`);
    return null;
  }
}

// ── Airtable: update record ───────────────────────────────────────────────
async function updateAirtableRecord(recordId, fields) {
  const url = `https://api.airtable.com/v0/${AIRTABLE_BASE}/${encodeURIComponent(AIRTABLE_TABLE)}/${recordId}`;
  console.log(`Airtable PATCH: ${url}`);
  console.log(`Airtable PATCH fields:`, JSON.stringify(fields, null, 2));
  try {
    const res = await fetch(url, {
      method: 'PATCH',
      headers: airtableHeaders(),
      body: JSON.stringify({ fields })
    });
    const text = await res.text();
    console.log(`Airtable PATCH response: ${res.status} — ${text.substring(0, 500)}`);
    return res.ok;
  } catch (err) {
    console.error(`Airtable PATCH exception: ${err.message}`);
    return false;
  }
}

// ── Airtable: create record ───────────────────────────────────────────────
async function createAirtableRecord(fields) {
  const url = `https://api.airtable.com/v0/${AIRTABLE_BASE}/${encodeURIComponent(AIRTABLE_TABLE)}`;
  console.log(`Airtable POST: ${url}`);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: airtableHeaders(),
      body: JSON.stringify({ fields })
    });
    const text = await res.text();
    console.log(`Airtable POST response: ${res.status} — ${text.substring(0, 500)}`);
    return res.ok;
  } catch (err) {
    console.error(`Airtable POST exception: ${err.message}`);
    return false;
  }
}

function airtableHeaders() {
  return {
    Authorization: `Bearer ${AIRTABLE_TOKEN}`,
    'Content-Type': 'application/json'
  };
}

// ── Start server ──────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Okta→Airtable webhook listener running on port ${PORT}`));
