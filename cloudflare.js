const axios = require('axios');
const store = require('./settingsStore');

const CF_BASE = 'https://api.cloudflare.com/client/v4';

function headers() {
  return {
    Authorization: `Bearer ${store.get('CLOUDFLARE_API_TOKEN')}`,
    'Content-Type': 'application/json'
  };
}

async function getZoneId(domain) {
  const res = await axios.get(`${CF_BASE}/zones`, {
    headers: headers(),
    params: { name: domain }
  });
  const zones = res.data.result;
  if (!zones || zones.length === 0) {
    throw new Error(`"${domain}" not found in Cloudflare. Add it first.`);
  }
  return zones[0].id;
}

// ── Fetch all existing DNS records for a zone ──────────────────────────────
async function getExistingRecords(zoneId) {
  try {
    const res = await axios.get(`${CF_BASE}/zones/${zoneId}/dns_records`, {
      headers: headers(),
      params: { per_page: 500 }
    });
    return res.data.result || [];
  } catch (err) {
    return [];
  }
}

// ── Delete a record by ID ──────────────────────────────────────────────────
async function deleteRecord(zoneId, recordId, recordInfo) {
  try {
    await axios.delete(`${CF_BASE}/zones/${zoneId}/dns_records/${recordId}`, {
      headers: headers()
    });
    return { success: true, deleted: true, type: recordInfo.type, name: recordInfo.name, content: recordInfo.content };
  } catch (err) {
    const msg = err.response?.data?.errors?.[0]?.message || err.message;
    return { success: false, error: msg, type: recordInfo.type, name: recordInfo.name };
  }
}

// ── Delete all existing records of a given type+name before adding fresh ones
async function deleteExisting(zoneId, type, name, existingRecords) {
  const matches = existingRecords.filter(r =>
    r.type === type &&
    r.name.toLowerCase() === name.toLowerCase()
  );
  const deleted = [];
  for (const r of matches) {
    const result = await deleteRecord(zoneId, r.id, { type: r.type, name: r.name, content: r.content });
    deleted.push(result);
  }
  return deleted;
}

// ── Add a single record ────────────────────────────────────────────────────
async function addRecord(zoneId, record) {
  try {
    const res = await axios.post(`${CF_BASE}/zones/${zoneId}/dns_records`, record, { headers: headers() });
    return { success: true, skipped: false, type: record.type, name: record.name, content: record.content };
  } catch (err) {
    const msg = err.response?.data?.errors?.[0]?.message || err.message;
    return { success: false, error: msg, type: record.type, name: record.name };
  }
}

// ── Page redirect via Page Rules ───────────────────────────────────────────
async function setupPageRedirect(zoneId, domain, forwardTarget) {
  try {
    await axios.post(
      `${CF_BASE}/zones/${zoneId}/pagerules`,
      {
        targets: [{ target: 'url', constraint: { operator: 'matches', value: `${domain}/*` } }],
        actions: [{ id: 'forwarding_url', value: { url: `${forwardTarget}/$1`, status_code: 301 } }],
        status: 'active',
        priority: 1
      },
      { headers: headers() }
    );
    return { success: true, skipped: false, type: 'REDIRECT', name: domain, content: `-> ${forwardTarget} (301)` };
  } catch (err) {
    const msg = err.response?.data?.errors?.[0]?.message || err.message;
    if (msg.toLowerCase().includes('already exists') || msg.toLowerCase().includes('duplicate')) {
      return { success: true, skipped: true, type: 'REDIRECT', name: domain, content: `-> ${forwardTarget} (301)` };
    }
    return { success: true, skipped: true, type: 'REDIRECT', name: domain, content: `Skipped - add Page Rules permission to token` };
  }
}

// ── Main DNS setup ─────────────────────────────────────────────────────────
async function setupDNS(domain, options = {}) {
  const results = [];
  const deletedResults = [];
  const forwardTarget = options.forwardUrl || `https://www.${domain}`;
  const zoneId = await getZoneId(domain);

  // Fetch ALL existing records once upfront
  const existing = await getExistingRecords(zoneId);

  // ── Clean duplicates before adding ──────────────────────────────────────

  // Delete existing MX records
  const delMX = await deleteExisting(zoneId, 'MX', domain, existing);
  deletedResults.push(...delMX);

  // Delete existing SPF (TXT on root domain containing spf1)
  const rootTXTs = existing.filter(r =>
    r.type === 'TXT' &&
    r.name.toLowerCase() === domain.toLowerCase()
  );
  for (const r of rootTXTs) {
    if (r.content.toLowerCase().includes('v=spf1')) {
      const del = await deleteRecord(zoneId, r.id, { type: 'TXT', name: r.name, content: r.content });
      deletedResults.push({ ...del, label: 'SPF (old)' });
    }
  }

  // Delete existing DMARC (_dmarc.domain TXT)
  const dmarcName = `_dmarc.${domain}`;
  const delDMARC = await deleteExisting(zoneId, 'TXT', dmarcName, existing);
  deletedResults.push(...delDMARC.map(d => ({ ...d, label: 'DMARC (old)' })));

  // Delete existing DKIM TXT (google._domainkey.domain)
  const dkimName = `google._domainkey.${domain}`;
  const delDKIM = await deleteExisting(zoneId, 'TXT', dkimName, existing);
  deletedResults.push(...delDKIM.map(d => ({ ...d, label: 'DKIM (old)' })));

  // Delete existing www CNAME
  const delWWW = await deleteExisting(zoneId, 'CNAME', `www.${domain}`, existing);
  deletedResults.push(...delWWW.map(d => ({ ...d, label: 'www CNAME (old)' })));

  // Delete existing custom CNAME if host provided
  if (options.cnameHost) {
    const customCnameName = `${options.cnameHost}.${domain}`;
    const delCustom = await deleteExisting(zoneId, 'CNAME', customCnameName, existing);
    deletedResults.push(...delCustom.map(d => ({ ...d, label: 'Custom CNAME (old)' })));
  }

  // ── Now add fresh records ────────────────────────────────────────────────

  // MX Records
  const mxList = [
    { priority: 1,  content: 'aspmx.l.google.com' },
    { priority: 5,  content: 'alt1.aspmx.l.google.com' },
    { priority: 5,  content: 'alt2.aspmx.l.google.com' },
    { priority: 10, content: 'alt3.aspmx.l.google.com' },
    { priority: 10, content: 'alt4.aspmx.l.google.com' },
  ];
  for (const mx of mxList) {
    results.push(await addRecord(zoneId, {
      type: 'MX', name: domain, content: mx.content, priority: mx.priority, ttl: 3600
    }));
  }

  // SPF
  results.push(await addRecord(zoneId, {
    type: 'TXT', name: domain,
    content: 'v=spf1 include:_spf.google.com ~all',
    ttl: 3600
  }));

  // DMARC
  results.push(await addRecord(zoneId, {
    type: 'TXT', name: `_dmarc.${domain}`,
    content: `v=DMARC1; p=quarantine; rua=mailto:postmaster@${domain}; fo=1`,
    ttl: 3600
  }));

  // DKIM placeholder
  results.push(await addRecord(zoneId, {
    type: 'TXT', name: `google._domainkey.${domain}`,
    content: 'v=DKIM1; k=rsa; p=REPLACE_WITH_YOUR_DKIM_KEY',
    ttl: 3600
  }));

  // www CNAME
  results.push(await addRecord(zoneId, {
    type: 'CNAME', name: 'www', content: domain, ttl: 3600, proxied: true
  }));

  // Domain redirect
  results.push(await setupPageRedirect(zoneId, domain, forwardTarget));

  // Custom CNAME
  if (options.cnameHost && options.cnameTarget) {
    results.push(await addRecord(zoneId, {
      type: 'CNAME', name: options.cnameHost, content: options.cnameTarget, ttl: 3600, proxied: false
    }));
  }

  const allSuccess = results.every(r => r.success);
  return { domain, records: results, deleted: deletedResults, allSuccess };
}

module.exports = { setupDNS };
