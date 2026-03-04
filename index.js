const express = require('express');
const app = express();
app.use(express.json());

const AIRTABLE_TOKEN = process.env.AIRTABLE_TOKEN;
const AIRTABLE_BASE  = process.env.AIRTABLE_BASE || 'appJXuJF1SCo1t7Jn';
const AIRTABLE_TABLE = process.env.AIRTABLE_TABLE || 'Okta Users';
const OKTA_VERIFY_TOKEN = process.env.OKTA_VERIFY_TOKEN; // set this to any secret string

// ── Okta Event Hook verification (one-time handshake) ──────────────────────
app.get('/okta-webhook', (req, res) => {
  const challenge = req.headers['x-okta-verification-challenge'];
  if (challenge) {
    return res.json({ verification: challenge });
  }
  res.sendStatus(200);
});

// ── Okta Event Hook receiver ───────────────────────────────────────────────
app.post('/okta-webhook', async (req, res) => {
  // Acknowledge immediately — Okta requires a fast response
  res.sendStatus(200);

  const events = req.body?.data?.events || [];
  console.log(`Received ${events.length} event(s)`);

  for (const event of events) {
    await handleEvent(event);
  }
});

// ── Event router ──────────────────────────────────────────────────────────
async function handleEvent(event) {
  const type = event.eventType;
  const target = event.target?.find(t => t.type === 'User');
  if (!target) return;

  const oktaId    = target.id;
  const email     = target.alternateId; // Okta uses email as alternateId
  const firstName = target.displayName?.split(' ')[0] || '';
  const lastName  = target.displayName?.split(' ').slice(1).join(' ') || '';

  console.log(`Event: ${type} | User: ${email} (${oktaId})`);

  // Find the Airtable record
  const record = await findAirtableRecord(oktaId, email);

  if (['user.lifecycle.deactivate', 'user.lifecycle.delete'].includes(type)) {
    // Mark INACTIVE
    if (record) {
      await updateAirtableRecord(record.id, { Status: 'INACTIVE' });
      console.log(`Marked INACTIVE: ${email}`);
    } else {
      console.log(`No Airtable record found for deactivated user: ${email}`);
    }
    return;
  }

  if (type === 'user.lifecycle.create') {
    // Fetch full user profile from Okta
    const profile = await fetchOktaUser(oktaId);
    if (record) {
      // Already exists — update it
      await updateAirtableRecord(record.id, buildAirtableFields(oktaId, profile));
    } else {
      // New user — create record
      await createAirtableRecord(buildAirtableFields(oktaId, profile));
    }
    console.log(`Created/updated new user: ${email}`);
    return;
  }

  if (['user.profile.update', 'user.account.update_profile', 'user.lifecycle.activate', 'user.lifecycle.reactivate'].includes(type)) {
    const profile = await fetchOktaUser(oktaId);
    const fields  = buildAirtableFields(oktaId, profile);
    if (record) {
      await updateAirtableRecord(record.id, fields);
    } else {
      await createAirtableRecord(fields);
    }
    console.log(`Updated user: ${email}`);
    return;
  }

  console.log(`Unhandled event type: ${type}`);
}

// ── Okta API: fetch full user profile ────────────────────────────────────
async function fetchOktaUser(oktaId) {
  const OKTA_DOMAIN = process.env.OKTA_DOMAIN; // e.g. yourorg.okta.com
  const OKTA_TOKEN  = process.env.OKTA_API_TOKEN;

  const res = await fetch(`https://${OKTA_DOMAIN}/api/v1/users/${oktaId}`, {
    headers: { Authorization: `SSWS ${OKTA_TOKEN}`, Accept: 'application/json' }
  });

  if (!res.ok) {
    console.error(`Failed to fetch Okta user ${oktaId}: ${res.status}`);
    return null;
  }
  return res.json();
}

// ── Map Okta profile → Airtable fields ───────────────────────────────────
function buildAirtableFields(oktaId, oktaUser) {
  if (!oktaUser) return {};
  const p = oktaUser.profile || {};
  return {
    'User Id':          oktaId,
    'Status':           oktaUser.status || '',
    'Activated Date':   oktaUser.activated || '',
    'Last Login Date':  oktaUser.lastLogin || '',
    'Username':         p.login || '',
    'First name':       p.firstName || '',
    'Last name':        p.lastName || '',
    'Primary email':    p.email || '',
    'Full Name':        `${p.firstName || ''} ${p.lastName || ''}`.trim(),
    'Title':            p.title || '',
    'Display name':     p.displayName || '',
    'Secondary email':  p.secondEmail || '',
    'Mobile phone':     p.mobilePhone || '',
    'Primary phone':    p.primaryPhone || '',
    'Employee Type':    p.userType || p.employeeType || p.user_type || '',
    'Employee number':  p.employeeNumber || '',
    'Cost center':      p.costCenter || '',
    'Organization':     p.organization || '',
    'Department':       p.department || '',
    'ManagerId':        p.managerId || '',
  };
}

// ── Airtable: find record by Okta User Id or email ────────────────────────
async function findAirtableRecord(oktaId, email) {
  // Try by User Id first
  let record = await airtableSearch('User Id', oktaId);
  if (record) return record;
  // Fall back to email
  if (email) record = await airtableSearch('Primary email', email);
  return record || null;
}

async function airtableSearch(field, value) {
  const formula = encodeURIComponent(`{${field}}="${value}"`);
  const url = `https://api.airtable.com/v0/${AIRTABLE_BASE}/${encodeURIComponent(AIRTABLE_TABLE)}?filterByFormula=${formula}&maxRecords=1`;

  const res = await fetch(url, { headers: airtableHeaders() });
  if (!res.ok) return null;
  const data = await res.json();
  return data.records?.[0] || null;
}

// ── Airtable: update record ───────────────────────────────────────────────
async function updateAirtableRecord(recordId, fields) {
  const url = `https://api.airtable.com/v0/${AIRTABLE_BASE}/${encodeURIComponent(AIRTABLE_TABLE)}/${recordId}`;
  const res = await fetch(url, {
    method: 'PATCH',
    headers: airtableHeaders(),
    body: JSON.stringify({ fields })
  });
  if (!res.ok) console.error(`Airtable update failed: ${res.status}`, await res.text());
}

// ── Airtable: create record ───────────────────────────────────────────────
async function createAirtableRecord(fields) {
  const url = `https://api.airtable.com/v0/${AIRTABLE_BASE}/${encodeURIComponent(AIRTABLE_TABLE)}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: airtableHeaders(),
    body: JSON.stringify({ fields })
  });
  if (!res.ok) console.error(`Airtable create failed: ${res.status}`, await res.text());
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
