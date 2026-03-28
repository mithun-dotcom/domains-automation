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
    throw new Error(`"${domain}" not found in your Cloudflare account. Add it to Cloudflare first.`);
  }
  return zones[0].id;
}

async function addRecord(zoneId, record) {
  try {
    const res = await axios.post(`${CF_BASE}/zones/${zoneId}/dns_records`, record, { headers: headers() });
    return { success: true, skipped: false, type: record.type, name: record.name, content: record.content };
  } catch (err) {
    const msg = err.response?.data?.errors?.[0]?.message || err.message;
    if (msg.toLowerCase().includes('already exists')) {
      return { success: true, skipped: true, type: record.type, name: record.name, content: record.content };
    }
    return { success: false, error: msg, type: record.type, name: record.name };
  }
}

async function setupPageRedirect(zoneId, domain, forwardTarget) {
  // Try Page Rules first (needs Zone.Zone Edit), fallback gracefully
  try {
    await axios.post(
      `${CF_BASE}/zones/${zoneId}/pagerules`,
      {
        targets: [{ target: 'url', constraint: { operator: 'matches', value: `${domain}/*` } }],
        actions: [{ id: 'forwarding_url', value: { url: forwardTarget.includes('$1') ? forwardTarget : `${forwardTarget}/$1`, status_code: 301 } }],
        status: 'active',
        priority: 1
      },
      { headers: headers() }
    );
    return { success: true, skipped: false, type: 'REDIRECT', name: domain, content: `→ ${forwardTarget} (301)` };
  } catch (err) {
    const msg = err.response?.data?.errors?.[0]?.message || err.message;
    if (msg.toLowerCase().includes('already exists') || msg.toLowerCase().includes('duplicate')) {
      return { success: true, skipped: true, type: 'REDIRECT', name: domain, content: `→ ${forwardTarget} (301)` };
    }
    // If permission denied, skip redirect gracefully — DNS records still work fine
    // User can add redirect manually in Cloudflare dashboard (1 click)
    return { success: true, skipped: true, type: 'REDIRECT', name: domain, content: `Skipped — add manually in Cloudflare dashboard (needs Zone Edit permission)` };
  }
}


module.exports = { setupDNS };
