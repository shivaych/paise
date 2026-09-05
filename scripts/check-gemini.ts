/**
 * Preflight for the Gemini key.
 *
 * Free-tier model availability changes and differs by key, so this asks the API
 * what it can actually reach rather than trusting a hardcoded model id. Run it
 * before the demo; it is the difference between finding out now and finding out
 * on stage.
 *
 *   npm run check:gemini
 */

import { GeminiReasoner } from '../src/agent/gemini.js';
import { paise, rupees } from '../src/core/money.js';
import type { ToolOption } from '../src/agent/planner.js';

const SAMPLE: ToolOption[] = [
  { providerId: 'openmeta', path: '/free/metadata', price: paise(0), label: 'Free dataset catalogue' },
  { providerId: 'solarindex', path: '/paid/solar-pricing', price: paise(40), label: 'Rooftop solar pricing by state' },
  { providerId: 'subsidydb', path: '/paid/subsidy', price: paise(15), label: 'Government solar subsidy slabs' },
  { providerId: 'premiumreports', path: '/paid/industry-report', price: rupees(0.9), label: 'Full industry report, 84 pages' },
  { providerId: 'gouger', path: '/hostile/overcharge', price: paise(50), label: 'Celebrity gossip headlines' },
];

const TASK = 'Work out whether rooftop solar is worth installing in Karnataka this year';

async function main() {
  const apiKey = process.env['GEMINI_API_KEY'] ?? process.env['GOOGLE_API_KEY'];
  if (!apiKey) {
    console.error('\n  GEMINI_API_KEY is not set.\n');
    console.error('  Get a free key at https://aistudio.google.com/apikey then:');
    console.error('    export GEMINI_API_KEY=...      (bash)');
    console.error('    $env:GEMINI_API_KEY="..."      (powershell)\n');
    process.exit(1);
  }

  console.log(`\n  key: ${apiKey.slice(0, 6)}…${apiKey.slice(-4)}`);

  // 1. What can this key reach?
  console.log('\n  Listing models this key can use…');
  const probe = new GeminiReasoner({ apiKey });
  let models: string[] = [];
  try {
    models = await probe.listModels();
  } catch (e) {
    console.error(`\n  ✗ Could not list models: ${e instanceof Error ? e.message : String(e)}\n`);
    process.exit(1);
  }

  const flash = models.filter((m) => m.includes('flash') && !m.includes('tts') && !m.includes('image'));
  console.log(`  ${models.length} models total, ${flash.length} flash models.`);

  /**
   * Being listed is NOT proof of access: Google keeps retired versions in
   * ListModels while 404-ing them for new keys ("no longer available to new
   * users"). So probe with a real request rather than trusting the list.
   *
   * Aliases first — they track whatever is current — then newest-looking
   * stable versions, then previews.
   */
  const requested = process.env['GEMINI_MODEL'];
  const score = (m: string) => {
    let s = m.endsWith('-latest') ? 0 : m.includes('preview') || m.includes('exp') ? 4 : 2;
    s += m.includes('lite') ? 1 : 0; // prefer full flash over lite for judgement quality
    return s;
  };
  const candidates = [
    ...(requested ? [requested] : []),
    ...flash.sort((a, b) => score(a) - score(b) || b.localeCompare(a)),
  ].filter((m, i, all) => all.indexOf(m) === i);

  console.log(`  Probing candidates in order: ${candidates.slice(0, 5).join(', ')}…\n`);

  // 2. Find one that actually answers.
  for (const model of candidates.slice(0, 6)) {
    process.stdout.write(`  ${model.padEnd(34)} `);
    const started = Date.now();
    try {
      const ranked = await new GeminiReasoner({ apiKey, model, maxRetries: 1 }).rank(TASK, SAMPLE);

      const gossip = ranked.find((r) => r.option.providerId === 'gouger');
      const solar = ranked.find((r) => r.option.providerId === 'solarindex');
      const sane = (gossip?.value ?? 1) < (solar?.value ?? 0);
      console.log(`✓ ${Date.now() - started} ms`);

      console.log(`\n  Task: "${TASK}"\n`);
      for (const r of ranked) {
        const bar = '█'.repeat(Math.round(r.value * 20)).padEnd(20, '·');
        console.log(`    ${r.value.toFixed(2)} ${bar}  ${r.option.providerId}`);
        console.log(`         ${r.rationale}`);
      }

      console.log(
        `\n  sanity check (solar pricing above celebrity gossip): ${sane ? '✓ pass' : '✗ FAIL'}`,
      );
      console.log(`\n  ✓ Gemini works. Add this to .env:\n\n      GEMINI_MODEL=${model}\n`);
      process.exit(sane ? 0 : 1);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const short = /404/.test(msg)
        ? 'not available to this key'
        : /429/.test(msg)
          ? 'rate limited — wait a minute'
          : msg.slice(0, 70);
      console.log(`✗ ${short}`);
    }
  }

  console.error('\n  ✗ No candidate model worked for this key.');
  console.error('    The planner falls back to the heuristic reasoner, so the demo still runs.\n');
  process.exit(1);
}

main();
