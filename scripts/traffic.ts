// traffic — simulates Tallybook's real users against production so the census has data.
// Usage: node scripts/traffic.ts https://tallybook-xxxx.run.app [requests=600]
// The mix matches what live clients call. Legacy endpoints get no traffic, except the monthly
// partner export, which this script deliberately never calls (it runs on the 1st of the month).
const base = process.argv[2]?.replace(/\/$/, '');
const total = Number(process.argv[3] ?? 600);
if (!base) throw new Error('usage: node scripts/traffic.ts <url> [requests]');

const mix: [number, string][] = [
  [45, '/'],
  [35, '/api/invoices'],
  [12, '/api/invoices/inv_1002'],
  [5, '/api/invoices/inv_1001/pdf'],
  [3, '/healthz'],
];
const pick = () => {
  let r = Math.random() * 100;
  for (const [weight, path] of mix) {
    r -= weight;
    if (r < 0) return path;
  }
  return '/';
};

// Writes need the API key (Secret Manager: tallybook-api-key). Without it, only reads are simulated.
const apiKey = process.env.TALLYBOOK_API_KEY;
async function write() {
  const headers = { 'content-type': 'application/json', 'x-api-key': apiKey ?? '' };
  const body = JSON.stringify({
    customer: 'Simulated Co',
    amountCents: 1000 + Math.floor(Math.random() * 90000),
    currency: 'USD',
  });
  const created = await fetch(`${base}/api/invoices`, { method: 'POST', headers, body });
  if (created.ok)
    await fetch(`${base}/api/invoices/${(await created.json()).id}/pay`, { method: 'POST', headers });
  return created.ok;
}

let ok = 0;
for (let i = 0; i < total; i += 10) {
  const batch = Array.from({ length: Math.min(10, total - i) }, () =>
    fetch(`${base}${pick()}`, { redirect: 'manual' }).then((r) => r.status < 400 && ok++),
  );
  if (apiKey) batch.push(write().then((r) => r && ok++));
  await Promise.allSettled(batch);
}
console.log(`traffic: ${ok}/${total} ok against ${base}`);
