/**
 * Ask Razorpay what actually happened.
 *
 * Test-mode payments fail for mundane, specific reasons and the checkout UI
 * says only "payment failed". The API carries the real cause in
 * `error_description` / `error_reason`, so read that rather than guessing.
 *
 *   npm run diagnose
 */

const API = 'https://api.razorpay.com/v1';

interface Payment {
  id?: string;
  status?: string;
  amount?: number;
  method?: string;
  created_at?: number;
  error_code?: string | null;
  error_description?: string | null;
  error_source?: string | null;
  error_step?: string | null;
  error_reason?: string | null;
  notes?: Record<string, unknown>;
}

interface PaymentLink {
  id?: string;
  status?: string;
  amount?: number;
  short_url?: string;
  payments?: { payment_id?: string; status?: string }[];
}

async function main() {
  const keyId = process.env['RAZORPAY_KEY_ID'];
  const keySecret = process.env['RAZORPAY_KEY_SECRET'];
  if (!keyId || !keySecret) {
    console.error('\n  Credentials not set. Run `npm run check:razorpay`.\n');
    process.exit(1);
  }
  const auth = `Basic ${Buffer.from(`${keyId}:${keySecret}`).toString('base64')}`;

  const get = async <T>(path: string): Promise<T> => {
    const res = await fetch(`${API}${path}`, { headers: { Authorization: auth } });
    const text = await res.text();
    if (!res.ok) throw new Error(`${path} → ${res.status}: ${text.slice(0, 300)}`);
    return JSON.parse(text) as T;
  };

  console.log('\n  Recent payments on this account\n  ' + '─'.repeat(66));

  const payments = await get<{ items?: Payment[] }>('/payments?count=10');
  const items = payments.items ?? [];

  if (items.length === 0) {
    console.log('  (none — the checkout was never submitted, or it failed before');
    console.log('   a payment record was created)');
  }

  for (const p of items) {
    const when = p.created_at ? new Date(p.created_at * 1000).toLocaleString() : '?';
    const rupees = ((p.amount ?? 0) / 100).toFixed(2);
    const flag = p.status === 'captured' ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m';

    console.log(`\n  ${flag} ${p.id}   ₹${rupees}   ${p.status}   ${p.method ?? '?'}   ${when}`);
    if (p.error_code || p.error_description) {
      console.log(`      code        ${p.error_code ?? '—'}`);
      console.log(`      reason      ${p.error_description ?? '—'}`);
      if (p.error_step) console.log(`      failed at   ${p.error_step}`);
      if (p.error_source) console.log(`      source      ${p.error_source}`);
    }
    if (p.notes && Object.keys(p.notes).length) {
      console.log(`      notes       ${JSON.stringify(p.notes)}`);
    }
  }

  // Payment links, so we can see whether the link itself was even opened.
  console.log('\n\n  Payment links\n  ' + '─'.repeat(66));
  try {
    const links = await get<{ payment_links?: PaymentLink[] }>('/payment_links');
    for (const l of (links.payment_links ?? []).slice(0, 5)) {
      const rupees = ((l.amount ?? 0) / 100).toFixed(2);
      console.log(`\n  ${l.id}   ₹${rupees}   ${l.status}`);
      console.log(`      ${l.short_url}`);
      for (const p of l.payments ?? []) {
        console.log(`      attempt: ${p.payment_id} → ${p.status}`);
      }
    }
  } catch (e) {
    console.log(`  (could not list links: ${e instanceof Error ? e.message : String(e)})`);
  }

  console.log('');
}

main().catch((e) => {
  console.error(`\n  ✗ ${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
