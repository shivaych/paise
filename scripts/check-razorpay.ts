/**
 * Preflight for Razorpay credentials.
 *
 * Checks the three things independently, because they are provisioned
 * separately and failing on the third is the common surprise:
 *
 *   1. Standard API key   — instant, free, self-serve
 *   2. Webhook secret     — set in the dashboard, verified locally
 *   3. RazorpayX payouts  — a SEPARATE product with separate access
 *
 *   npm run check:razorpay
 */

import { createHmac } from 'node:crypto';
import { verifyWebhookSignature } from '../src/rails/razorpay.js';

const API = 'https://api.razorpay.com/v1';

function tick(ok: boolean) {
  return ok ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m';
}

async function main() {
  const keyId = process.env['RAZORPAY_KEY_ID'];
  const keySecret = process.env['RAZORPAY_KEY_SECRET'];
  const webhookSecret = process.env['RAZORPAY_WEBHOOK_SECRET'];
  const accountNumber = process.env['RAZORPAYX_ACCOUNT_NUMBER'];

  console.log('\n  Razorpay preflight\n' + '  ' + '─'.repeat(50));

  // ---- 1. API key ---------------------------------------------------------
  if (!keyId || !keySecret) {
    const missing = !keyId && !keySecret
      ? 'neither RAZORPAY_KEY_ID nor RAZORPAY_KEY_SECRET is set'
      : !keySecret
        ? `RAZORPAY_KEY_ID is set (${keyId!.slice(0, 14)}…) but RAZORPAY_KEY_SECRET is missing`
        : 'RAZORPAY_KEY_SECRET is set but RAZORPAY_KEY_ID is missing';

    console.log(`  ${tick(false)} API key       ${missing}`);
    console.log('\n     Both halves are needed — the API uses HTTP basic auth (id:secret).');
    console.log('     https://dashboard.razorpay.com/app/website-app-settings/api-keys');
    console.log('     Razorpay shows the secret only once, at creation. If it was not');
    console.log('     saved, regenerate the key pair — the id will change too.\n');
    process.exit(1);
  }

  const mode = keyId.startsWith('rzp_test_') ? 'TEST' : keyId.startsWith('rzp_live_') ? 'LIVE' : '?';
  const auth = `Basic ${Buffer.from(`${keyId}:${keySecret}`).toString('base64')}`;

  let keyOk = false;
  try {
    const res = await fetch(`${API}/payments?count=1`, { headers: { Authorization: auth } });
    keyOk = res.ok;
    console.log(`  ${tick(keyOk)} API key       ${keyId.slice(0, 14)}… (${mode} mode) → HTTP ${res.status}`);
    if (!keyOk) console.log(`     ${(await res.text()).slice(0, 200)}`);
  } catch (e) {
    console.log(`  ${tick(false)} API key       network error: ${e instanceof Error ? e.message : e}`);
  }

  if (mode === 'LIVE') {
    console.log('\n  \x1b[33m⚠ These are LIVE keys. Real money will move. Use rzp_test_ for the demo.\x1b[0m');
  }

  // ---- 2. Webhook secret --------------------------------------------------
  if (!webhookSecret) {
    console.log(`  ${tick(false)} Webhook       RAZORPAY_WEBHOOK_SECRET not set`);
  } else {
    // Verify our own implementation round-trips against a known-good signature.
    const body = JSON.stringify({ event: 'payment.captured', payload: {} });
    const sig = createHmac('sha256', webhookSecret).update(body).digest('hex');
    const ok = verifyWebhookSignature(body, sig, webhookSecret);
    console.log(`  ${tick(ok)} Webhook       secret set, signature check ${ok ? 'round-trips' : 'BROKEN'}`);
  }

  // ---- 3. RazorpayX payouts ----------------------------------------------
  if (!accountNumber) {
    console.log(`  ${tick(false)} RazorpayX     RAZORPAYX_ACCOUNT_NUMBER not set — payouts unavailable`);
    console.log('     This is a separate product from the standard API key.');
    console.log('     Without it the app still runs: settlement uses MockRail.');
  } else {
    try {
      const res = await fetch(
        `${API}/payouts?account_number=${encodeURIComponent(accountNumber)}&count=1`,
        { headers: { Authorization: auth } },
      );
      const ok = res.ok;
      console.log(`  ${tick(ok)} RazorpayX     account ${accountNumber} → HTTP ${res.status}`);
      if (!ok) {
        console.log(`     ${(await res.text()).slice(0, 250)}`);
        console.log('     A 401/403 here usually means payouts are not enabled on this account.');
      }
    } catch (e) {
      console.log(`  ${tick(false)} RazorpayX     network error: ${e instanceof Error ? e.message : e}`);
    }
  }

  console.log('  ' + '─'.repeat(50));
  console.log('\n  Reminder: the app defaults to MockRail. Set PAISE_RAIL=razorpay');
  console.log('  to use the live adapter once the checks above pass.\n');
}

main();
