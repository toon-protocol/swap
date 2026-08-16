/**
 * Unit cover for the leg-B return-route binder's decision table.
 *
 * The DELIVERY proof lives in `swap-node.leg-b-wire.test.ts`, which drives a
 * real BTP session against a real `ConnectorNode`. What is checked here is the
 * part a wire test cannot enumerate cheaply: the guards that stop this from
 * becoming a routing-table hijack, and the bookkeeping that stops it from
 * growing without bound.
 */

import { describe, it, expect } from 'vitest';

import { createLegBReturnRouteBinder } from './leg-b-return-path.js';

const MAKER_ILP = 'g.toon.swap.fixture';

interface Route {
  prefix: string;
  nextHop: string;
  priority?: number;
}

function fakeConnector(seed: Route[] = []) {
  const routes: Route[] = [...seed];
  const relations = new Map<string, string>();
  return {
    routes,
    relations,
    addRoute(route: Route) {
      const at = routes.findIndex((r) => r.prefix === route.prefix);
      if (at >= 0) routes.splice(at, 1);
      routes.push(route);
    },
    removeRoute(prefix: string) {
      const at = routes.findIndex((r) => r.prefix === prefix);
      if (at < 0) throw new Error(`Route not found: ${prefix}`);
      routes.splice(at, 1);
    },
    listRoutes(): Route[] {
      return routes.map((r) => ({ ...r }));
    },
    _packetHandler: {
      setPeerRelation(peerId: string, relation: string) {
        relations.set(peerId, relation);
      },
      getPeerRelation(peerId: string) {
        return relations.get(peerId);
      },
    },
  };
}

describe('leg-B return-route binder', () => {
  it('[P0] binds the arrival session and marks it a child so a paid leg B is not claim-gated', () => {
    const connector = fakeConnector();
    const binder = createLegBReturnRouteBinder(connector, {
      ilpAddress: MAKER_ILP,
    });

    const result = binder.bind({
      senderIlpAddress: 'g.toon.client.a',
      sourcePeer: 'g.toon.client.a',
    });

    expect(result).toEqual({ status: 'bound', nextHop: 'g.toon.client.a' });
    expect(connector.listRoutes()).toContainEqual(
      expect.objectContaining({
        prefix: 'g.toon.client.a',
        nextHop: 'g.toon.client.a',
      })
    );
    // Without this the forward is gated on a settlement claim the maker can
    // never produce toward its own customer (T00, not F02).
    expect(connector.relations.get('g.toon.client.a')).toBe('child');
  });

  it('[P0] refuses to bind an address the arrival session did not authenticate under', () => {
    const connector = fakeConnector();
    const binder = createLegBReturnRouteBinder(connector, {
      ilpAddress: MAKER_ILP,
    });

    // The hijack this guard exists for: claim someone else's prefix in the
    // RFQ payload and the maker would install a route shadowing it.
    const result = binder.bind({
      senderIlpAddress: 'g.proxy',
      sourcePeer: 'g.toon.client.a',
    });

    expect(result.status).toBe('unreachable');
    expect(connector.listRoutes()).toHaveLength(0);
    expect(connector.relations.size).toBe(0);
  });

  it('[P0] never shadows the maker own ilpAddress (no self-delivery hijack)', () => {
    const connector = fakeConnector([
      { prefix: MAKER_ILP, nextHop: 'toon-swap-fixture', priority: 100 },
    ]);
    const binder = createLegBReturnRouteBinder(connector, {
      ilpAddress: MAKER_ILP,
    });

    // A peer that authenticated as an ANCESTOR of our own address. Binding it
    // would divert the maker's own local delivery out over that session.
    const result = binder.bind({
      senderIlpAddress: 'g.toon.swap',
      sourcePeer: 'g.toon.swap',
    });

    expect(result.status).not.toBe('bound');
    expect(connector.listRoutes()).toEqual([
      { prefix: MAKER_ILP, nextHop: 'toon-swap-fixture', priority: 100 },
    ]);
  });

  it('[P0] an operator route for the same prefix wins and is left untouched', () => {
    const connector = fakeConnector([
      { prefix: 'g.toon.client.a', nextHop: 'apex', priority: 10 },
    ]);
    const binder = createLegBReturnRouteBinder(connector, {
      ilpAddress: MAKER_ILP,
    });

    const result = binder.bind({
      senderIlpAddress: 'g.toon.client.a',
      sourcePeer: 'g.toon.client.a',
    });

    expect(result).toEqual({ status: 'routed', nextHop: 'apex' });
    expect(connector.listRoutes()).toEqual([
      { prefix: 'g.toon.client.a', nextHop: 'apex', priority: 10 },
    ]);
  });

  it('[P0] adopts a return route replayed from the registry after a restart', () => {
    // Runtime routes are persisted and replayed on boot; the peer RELATION is
    // not. Deferring to the replayed route would leave every leg B gated on a
    // settlement claim (T00) until the process was restarted again.
    const connector = fakeConnector([
      { prefix: 'g.toon.client.a', nextHop: 'g.toon.client.a', priority: 50 },
    ]);
    const binder = createLegBReturnRouteBinder(connector, {
      ilpAddress: MAKER_ILP,
    });

    const result = binder.bind({
      senderIlpAddress: 'g.toon.client.a',
      sourcePeer: 'g.toon.client.a',
    });

    expect(result).toEqual({ status: 'bound', nextHop: 'g.toon.client.a' });
    expect(connector.relations.get('g.toon.client.a')).toBe('child');
    expect(connector.listRoutes()).toHaveLength(1);
  });

  it('an apex-forwarded RFQ needs no ephemeral route — the default-up route already reaches the sender', () => {
    const connector = fakeConnector([
      { prefix: MAKER_ILP, nextHop: 'toon-swap-fixture', priority: 100 },
      { prefix: 'g', nextHop: 'apex', priority: 0 },
    ]);
    const binder = createLegBReturnRouteBinder(connector, {
      ilpAddress: MAKER_ILP,
    });

    const result = binder.bind({
      senderIlpAddress: 'g.toon.client.a',
      sourcePeer: 'apex',
    });

    expect(result).toEqual({ status: 'routed', nextHop: 'apex' });
    expect(binder.boundPrefixes()).toEqual([]);
  });

  it('an ILP-over-HTTP arrival has no session to reply on and no route: unreachable', () => {
    const connector = fakeConnector([
      { prefix: MAKER_ILP, nextHop: 'toon-swap-fixture', priority: 100 },
    ]);
    const binder = createLegBReturnRouteBinder(connector, {
      ilpAddress: MAKER_ILP,
    });

    expect(
      binder.bind({
        senderIlpAddress: 'g.toon.client.a',
        sourcePeer: 'http:anon',
      }).status
    ).toBe('unreachable');
  });

  it('a connector with no routing introspection degrades to the pre-fix behaviour', () => {
    const binder = createLegBReturnRouteBinder(
      { sendPacket: async () => ({ type: 'reject' }) },
      { ilpAddress: MAKER_ILP }
    );

    // `unavailable`, NOT `unreachable`: an embedder's own connector must keep
    // minting sessions exactly as it did before this module existed.
    expect(
      binder.bind({
        senderIlpAddress: 'g.toon.client.a',
        sourcePeer: 'g.toon.client.a',
      })
    ).toEqual({ status: 'unavailable' });
  });

  it('re-binding the same session is idempotent', () => {
    const connector = fakeConnector();
    const binder = createLegBReturnRouteBinder(connector, {
      ilpAddress: MAKER_ILP,
    });
    const args = {
      senderIlpAddress: 'g.toon.client.a',
      sourcePeer: 'g.toon.client.a',
    };

    binder.bind(args);
    binder.bind(args);

    expect(connector.listRoutes()).toHaveLength(1);
    expect(binder.boundPrefixes()).toEqual(['g.toon.client.a']);
  });

  it('bindings are bounded — the least recent is withdrawn, never accumulated', () => {
    const connector = fakeConnector();
    const binder = createLegBReturnRouteBinder(connector, {
      ilpAddress: MAKER_ILP,
      maxBindings: 2,
    });

    for (const id of ['a', 'b', 'c']) {
      binder.bind({
        senderIlpAddress: `g.toon.client.${id}`,
        sourcePeer: `g.toon.client.${id}`,
      });
    }

    expect(binder.boundPrefixes()).toEqual([
      'g.toon.client.b',
      'g.toon.client.c',
    ]);
    expect(connector.listRoutes().map((r) => r.prefix)).toEqual([
      'g.toon.client.b',
      'g.toon.client.c',
    ]);
  });

  it('release() hands a caller-owned connector back its original routing table', () => {
    const connector = fakeConnector([
      { prefix: MAKER_ILP, nextHop: 'toon-swap-fixture', priority: 100 },
    ]);
    const binder = createLegBReturnRouteBinder(connector, {
      ilpAddress: MAKER_ILP,
    });

    binder.bind({
      senderIlpAddress: 'g.toon.client.a',
      sourcePeer: 'g.toon.client.a',
    });
    binder.release();
    binder.release(); // idempotent

    expect(connector.listRoutes()).toEqual([
      { prefix: MAKER_ILP, nextHop: 'toon-swap-fixture', priority: 100 },
    ]);
    expect(binder.boundPrefixes()).toEqual([]);
  });
});
