/**
 * Create a real Razorpay payment link to fund the agent.
 *
 * The complete money-in loop, using only a standard test key:
 *
 *   this script  →  hosted Razorpay checkout  →  you pay (test card)
 *                →  payment.captured webhook  →  ledger credited
 *
 * Nothing is credited by this script. It only creates the link. The ledger
 * moves when the webhook arrives, which is the whole point — an API response
 * says "accepted", a webhook says "settled".
 *
 *   npm run topup:link -- 500        # ₹500, defaults to DEMO_TOPUP
 */

import { DEMO_POLICY, DEMO_TOPUP } from '../src/config.js';
import { format, rupees, type Micros } from '../src/core/money.js';
import { RazorpayRail } from '../src/rails/razorpay.js';

async function main() {
  const keyId = process.env['RAZORPAY_KEY_ID'];
  const keySecret = process.env['RAZORPAY_KEY_SECRET'];

  if (!keyId || !keySecret) {
    console.error('\n  RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET not set. Run `npm run check:razorpay`.\n');
    process.exit(1);
  }

  const arg = Number(process.argv[2]);
  const amount: Micros = Number.isFinite(arg) && arg > 0 ? rupees(arg) : DEMO_TOPUP;

  const rail = new RazorpayRail({
    keyId,
    keySecret,
    // Not used by createTopUpLink, but the constructor describes a whole rail.
    mandateTokenId: 'token_not_required_for_links',
    customerId: 'cust_not_required_for_links',
    maxAmountPerDebit: DEMO_TOPUP,
    mandateValidUntil: Date.now() + 365 * 24 * 3_600_000,
  });

  console.log(`\n  Creating a ${format(amount)} top-up link for ${DEMO_POLICY.agentId}…`);

  try {
    const link = await rail.createTopUpLink({
      amount,
      agentId: DEMO_POLICY.agentId,
      description: `paise agent budget top-up (${format(amount)})`,
    });

    console.log(`\n  ✓ ${link.id}  [${link.status}]`);
    console.log(`\n      ${link.shortUrl}\n`);
    console.log('  Open that link and pay with a test card:');
    console.log('      card    4111 1111 1111 1111');
    console.log('      expiry  any future date      cvv  any 3 digits\n');
    console.log('  The ledger credits when the payment.captured webhook lands —');
    console.log('  start the dashboard with RAZORPAY_WEBHOOK_SECRET set and a tunnel');
    console.log('  pointed at /webhooks/razorpay first, or nothing will be recorded.\n');
  } catch (e) {
    console.error(`\n  ✗ ${e instanceof Error ? e.message : String(e)}\n`);
    process.exit(1);
  }
}

main();
