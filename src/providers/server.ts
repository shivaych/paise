/**
 * The mock API fleet, served over real HTTP.
 *
 * Real sockets rather than a stubbed transport: the concurrency, the header
 * round-tripping and the timeout behaviour are all part of what we are claiming
 * works, and none of them are exercised by an in-process fake.
 */

import express, { type Express } from 'express';
import type { Server } from 'node:http';
import { systemClock } from '../core/clock.js';
import { isMainModule } from '../core/main.js';
import { HmacSigner } from '../core/signer.js';
import { SIGNING_SECRET, PROVIDERS_PORT } from '../config.js';
import { paidRoute } from '../x402/server.js';
import { FLEET } from './fleet.js';

export function createProviderApp(): Express {
  const app = express();
  const signer = new HmacSigner(SIGNING_SECRET);

  for (const spec of FLEET) {
    app.get(
      spec.path,
      paidRoute({
        provider: spec.id,
        price: spec.price,
        clock: systemClock,
        behaviour: spec.behaviour,
        signer,
        quoteTtlMs: spec.quoteTtlMs,
      }),
      (_req, res) => {
        res.json(spec.payload());
      },
    );
  }

  /** Service discovery, so the agent can see what is on offer and at what price. */
  app.get('/_fleet', (_req, res) => {
    res.json(
      FLEET.map((p) => ({
        id: p.id,
        path: p.path,
        price: p.price,
        label: p.label,
        hostile: p.hostile,
        behaviour: p.behaviour.kind,
      })),
    );
  });

  app.get('/_health', (_req, res) => res.json({ ok: true, providers: FLEET.length }));

  return app;
}

/** Start on an ephemeral port (0) or a fixed one. Resolves once listening. */
export function startProviders(port = PROVIDERS_PORT): Promise<{ server: Server; port: number }> {
  return new Promise((resolve, reject) => {
    const server = createProviderApp().listen(port, '127.0.0.1');
    server.once('listening', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        reject(new Error('Provider server bound to an unexpected address'));
        return;
      }
      resolve({ server, port: address.port });
    });
    server.once('error', reject);
  });
}

// Run directly: `npm run providers`
if (isMainModule(import.meta.url)) {
  startProviders().then(({ port }) => {
    console.log(`paise provider fleet listening on http://127.0.0.1:${port}`);
    for (const p of FLEET) {
      console.log(`  ${p.hostile ? '☠ ' : '  '}${p.path.padEnd(30)} ${p.label}`);
    }
  });
}
