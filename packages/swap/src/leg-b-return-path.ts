/**
 * Leg-B return path (rolling-swap spec §3) — how a maker addresses the
 * sender's daemon.
 *
 * ## The defect this module exists to fix
 *
 * A rolling session negotiates over leg 0 (the RFQ) and then every fill's
 * leg B is an ILP PREPARE the maker ORIGINATES back to the sender's
 * `senderIlpAddress`. The maker originates it through the connector's public
 * `sendPacket`, which resolves the destination the only way a connector can:
 * `RoutingTable.getNextHop()`, a longest-prefix match over the routing table
 * (connector `core/packet-handler.ts` `handlePreparePacket`).
 *
 * A client that DIRECT-DIALS the maker's BTP server is in nobody's routing
 * table. It is an *inbound BTP session*, bound in the connector's
 * `BTPServer.peers` map under the `peerId` it declared on the BTP auth
 * greeting, verbatim (connector `btp/btp-server.ts` `authenticatePeer` —
 * `this.peers.set(peerId, peerConn)`). Nothing in `ConnectorNode` ever turns
 * that session into a route. So leg B was rejected
 * `F02 no route found` before it left the maker, every single fill, and the
 * rolling protocol was undeliverable against a stock client:
 *
 * ```
 * maker: REJECT destination=g.toon.client errorCode=F02 "no route found"
 * maker: swap.rolling.fill_unwound streamNonce=… seq=1 cause=F02
 * ```
 *
 * The connector already knows how to send over an inbound session — its
 * `forwardToNextHop` prefers an outbound client, then falls back to
 * `btpServer.sendPacketToPeer(nextHop, …)` when `btpServer.hasPeer(nextHop)`.
 * The ONLY missing ingredient is a routing-table entry whose `nextHop` names
 * that session. This module adds exactly that entry, for the lifetime of the
 * maker process, keyed off the session the RFQ actually arrived on — so a
 * stock client works against a stock maker with **no operator routing
 * configuration** (the direct-dial model swap#105 proved and
 * `docker-compose.relay.swap.yml` documents).
 *
 * ## Why the binding requires `senderIlpAddress === sourcePeer`
 *
 * The route this module adds is always `prefix: X → nextHop: X`, where `X` is
 * the string the peer **authenticated under** on this connector's BTP server
 * (`LocalDeliveryRequest.sourcePeer`, which the connector sets to
 * `peerConn.peerId`). It is never a name the RFQ payload alone can choose.
 *
 * That is not a limitation for a stock client: `ToonClient.getOwnIlpAddress()`
 * — the default `senderIlpAddress` an RFQ carries — is literally the same
 * expression the client uses for its BTP greeting `peerId`
 * (`config.btpPeerId ?? config.ilpInfo.ilpAddress`), so the two match by
 * construction. But it closes a hijack: without it, any peer could publish an
 * RFQ claiming `senderIlpAddress: 'g.proxy'` and install a routing-table entry
 * that shadows the maker's own upstream route for every packet under that
 * prefix. Requiring the address to equal the authenticated session id means an
 * ephemeral route can only ever capture traffic addressed to that peer's own
 * name — which the peer already owns on this connector.
 *
 * Two further guards, for the same reason:
 *
 *  - never bind a prefix that would shadow the maker's own `ilpAddress`
 *    (that would divert the maker's local delivery to a peer);
 *  - never overwrite a route this module did not add (operator/static config
 *    always wins — see {@link LegBReturnRouteBinder.bind}'s `'routed'`).
 *
 * ## Why the peer is also marked a `child`
 *
 * A route alone is still not enough. `PacketHandler` requires a per-packet
 * settlement claim on **every value-bearing forward to a non-`child` next
 * hop** (`requiresSettlementClaim` — `peerRelations.get(peerId) !== 'child'`),
 * and a maker has no payment channel toward a client it is *paying*. So a
 * routed leg B answers `T00 "No payment channel available for peer"` instead
 * of `F02 "no route found"` — the same undeliverable fill, one layer down.
 *
 * `'child'` is the ILP-correct relation here, not a workaround. The connector's
 * own comment for the skip says it: *"a parent settles DOWN to a child by
 * letting the child accrue a balance owed up (the child settles via its own
 * up-claims)"*. That is precisely the rolling swap's netting — the sender pays
 * the maker on leg A, and leg B's value is the signed chain-B claim carried in
 * the packet's `data`, never an ILP settlement the maker owes back over the
 * link.
 *
 * The connector exposes `setPeerRelation` only to its admin HTTP server
 * (`core/connector-node.ts` wires it into `AdminServer`), and a swap node runs
 * with `adminApi: { enabled: false }`, so this reaches the `PacketHandler`
 * directly. It is guarded and best-effort: a connector that does not expose it
 * still gets the route, and a leg B that then trips the claim gate fails
 * loudly and benignly (T00, nothing revealed) rather than silently.
 *
 * Ordering is load-bearing: the route is added FIRST. `ConnectorNode.addRoute`
 * validates relation↔route admission, and a `'child'` peer may only hold
 * routes *under the connector's own address* — which a sender's address never
 * is. Adding the route while the peer is still an ordinary `'peer'` and
 * marking it a child afterwards satisfies both rules.
 *
 * ## When there is no return path
 *
 * `bind()` reports `'unreachable'` when it can positively determine that the
 * maker can neither reply on the arrival session nor route to the address.
 * The RFQ intake turns that into a leg-0 REJECT, which is the ONLY safe
 * moment to fail: nothing has been quoted, no inventory reserved, no leg A
 * revealed — and a sender's existing RFQ-failure fallback (toon-client#591)
 * quietly takes the legacy swap path, which works. Establishing a session the
 * maker knows it cannot deliver on is what turned a working default swap into
 * `F99 leg B failed; fill not executed`.
 */

/**
 * The slice of `ConnectorNode`'s public API this module drives. All optional:
 * a test double or an HTTP-mode connector that exposes none of it degrades to
 * `'unavailable'`, i.e. exactly the pre-fix behaviour.
 */
export interface ReturnRouteConnectorLike {
  addRoute?(route: {
    prefix: string;
    nextHop: string;
    priority?: number;
  }): void;
  removeRoute?(prefix: string): void;
  listRoutes?(): readonly { prefix: string; nextHop: string }[];
  /**
   * `ConnectorNode`'s internal forwarding seam. Only the admin HTTP server is
   * handed a public `setPeerRelation`, and a swap node runs without one — see
   * the module doc. Structurally typed and fully optional.
   */
  _packetHandler?: {
    setPeerRelation?: (peerId: string, relation: string) => void;
    getPeerRelation?: (peerId: string) => string | undefined;
  };
}

/** Outcome of resolving a session's leg-B return path. */
export type LegBReturnPath =
  /** An ephemeral route now points `senderIlpAddress` at the arrival session. */
  | { status: 'bound'; nextHop: string }
  /** The routing table already resolves the address (operator/parent route). */
  | { status: 'routed'; nextHop: string }
  /** The connector exposes no routing introspection — behave as before. */
  | { status: 'unavailable' }
  /** No arrival session to reply on and no route: leg B cannot be delivered. */
  | { status: 'unreachable'; reason: string };

export interface LegBReturnRouteBinderOptions {
  /**
   * The maker's own ILP address. A sender may never bind a prefix that
   * equals it or is one of its ancestors.
   */
  ilpAddress?: string;
  /** Cap on simultaneously bound ephemeral routes; oldest is evicted. */
  maxBindings?: number;
  /**
   * Priority of the ephemeral route. Longest-prefix match decides first, so
   * this only breaks ties against another route with the SAME prefix — which
   * the `'routed'` guard already refuses to create.
   */
  priority?: number;
  logger?: {
    debug?: (msg: string, meta?: Record<string, unknown>) => void;
    warn?: (msg: string, meta?: Record<string, unknown>) => void;
  };
}

export const DEFAULT_MAX_RETURN_ROUTE_BINDINGS = 256;
export const DEFAULT_RETURN_ROUTE_PRIORITY = 50;

/**
 * `sourcePeer` values that can never name a duplex session to reply on.
 *
 * `http:*` is the connector's namespace for an ILP-over-HTTP arrival
 * (`http/ilp-http-adapter.ts` — `http:anon` / `http:<claim-signer>`): a
 * request/response hop with no socket the maker can originate a PREPARE on.
 * `unknown` is `PacketHandler`'s placeholder for an unattributed packet.
 */
function isReplyableSessionId(sourcePeer: string | undefined): boolean {
  if (typeof sourcePeer !== 'string' || sourcePeer.length === 0) return false;
  if (sourcePeer === 'unknown' || sourcePeer === 'local') return false;
  if (sourcePeer.startsWith('http:')) return false;
  return true;
}

/** ILP longest-prefix semantics: `p` covers `addr` on label boundaries only. */
function covers(prefix: string, addr: string): boolean {
  return addr === prefix || addr.startsWith(`${prefix}.`);
}

export interface LegBReturnRouteBinder {
  /**
   * Resolve (and if possible install) the leg-B return path for a session.
   * Idempotent: re-binding the same address to the same session is a no-op
   * that only refreshes its eviction recency.
   */
  bind(args: { senderIlpAddress: string; sourcePeer?: string }): LegBReturnPath;
  /** Prefixes this binder currently owns — introspection for tests/diagnostics. */
  boundPrefixes(): string[];
  /** Withdraw every ephemeral route this binder added. Safe to call twice. */
  release(): void;
}

/**
 * Build the leg-B return-route binder over a connector's public routing API.
 *
 * Adds **no configuration key**: everything it needs is either already on the
 * connector or arrives on the wire with the RFQ.
 */
export function createLegBReturnRouteBinder(
  connector: unknown,
  options: LegBReturnRouteBinderOptions = {}
): LegBReturnRouteBinder {
  const c = (connector ?? {}) as ReturnRouteConnectorLike;
  const addRoute =
    typeof c.addRoute === 'function' ? c.addRoute.bind(c) : undefined;
  const removeRoute =
    typeof c.removeRoute === 'function' ? c.removeRoute.bind(c) : undefined;
  const listRoutes =
    typeof c.listRoutes === 'function' ? c.listRoutes.bind(c) : undefined;
  const logger = options.logger;
  const maxBindings = options.maxBindings ?? DEFAULT_MAX_RETURN_ROUTE_BINDINGS;
  const priority = options.priority ?? DEFAULT_RETURN_ROUTE_PRIORITY;
  const ilpAddress = options.ilpAddress;

  /** prefix → nextHop, insertion-ordered so the head is the least recent. */
  const owned = new Map<string, string>();

  /**
   * Mark the return peer a `child` so leg B — value-bearing, and paid in the
   * chain-B claim it CARRIES — is not gated on a settlement channel the maker
   * could never hold toward its own customer. See the module doc.
   */
  const markReturnPeerAsChild = (peerId: string): void => {
    const setRelation = c._packetHandler?.setPeerRelation;
    if (typeof setRelation !== 'function') {
      logger?.warn?.('swap.rolling.return_peer_relation_unavailable', {
        peerId,
        reason:
          'connector exposes no setPeerRelation; a value-bearing leg B to this ' +
          'peer will be gated on a per-packet settlement claim (T00)',
      });
      return;
    }
    try {
      setRelation.call(c._packetHandler, peerId, 'child');
      logger?.debug?.('swap.rolling.return_peer_marked_child', { peerId });
    } catch (err) {
      logger?.warn?.('swap.rolling.return_peer_relation_failed', {
        peerId,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  };

  const resolveExistingRoute = (
    addr: string
  ): { prefix: string; nextHop: string } | undefined => {
    if (!listRoutes) return undefined;
    let best: { prefix: string; nextHop: string } | undefined;
    for (const route of listRoutes()) {
      if (typeof route?.prefix !== 'string') continue;
      if (!covers(route.prefix, addr)) continue;
      if (!best || route.prefix.length > best.prefix.length) {
        best = { prefix: route.prefix, nextHop: route.nextHop };
      }
    }
    return best;
  };

  const evictIfFull = (): void => {
    while (owned.size >= maxBindings) {
      const oldest = owned.keys().next();
      if (oldest.done) return;
      const prefix = oldest.value;
      owned.delete(prefix);
      try {
        removeRoute?.(prefix);
      } catch (err) {
        logger?.warn?.('swap.rolling.return_route_evict_failed', {
          prefix,
          err: err instanceof Error ? err.message : String(err),
        });
      }
    }
  };

  return {
    bind({ senderIlpAddress, sourcePeer }): LegBReturnPath {
      if (!addRoute || !listRoutes) {
        // No routing introspection at all (test double / HTTP-mode connector):
        // leave the RFQ exactly as it behaved before this module existed.
        return { status: 'unavailable' };
      }

      const existing = resolveExistingRoute(senderIlpAddress);
      const alreadyOwned = owned.get(senderIlpAddress);

      const canReply =
        isReplyableSessionId(sourcePeer) && sourcePeer === senderIlpAddress;

      if (canReply) {
        // Never divert the maker's own local delivery.
        if (ilpAddress && covers(senderIlpAddress, ilpAddress)) {
          logger?.warn?.('swap.rolling.return_route_refused', {
            senderIlpAddress,
            reason: 'would shadow the maker ilpAddress',
          });
        } else if (
          existing &&
          existing.prefix === senderIlpAddress &&
          existing.nextHop !== senderIlpAddress &&
          alreadyOwned === undefined
        ) {
          // A static/operator route owns this exact prefix and points it
          // somewhere ELSE — it wins. (An existing entry that already points
          // the address at itself IS a return route — most likely one this
          // maker persisted before a restart — so it is adopted below rather
          // than deferred to: the peer relation does NOT survive a restart,
          // and deferring would leave leg B claim-gated forever.)
          return { status: 'routed', nextHop: existing.nextHop };
        } else if (alreadyOwned === senderIlpAddress) {
          // Refresh eviction recency without touching the routing table.
          owned.delete(senderIlpAddress);
          owned.set(senderIlpAddress, senderIlpAddress);
          markReturnPeerAsChild(senderIlpAddress);
          return { status: 'bound', nextHop: senderIlpAddress };
        } else {
          owned.delete(senderIlpAddress);
          evictIfFull();
          try {
            addRoute({
              prefix: senderIlpAddress,
              nextHop: senderIlpAddress,
              priority,
            });
            owned.set(senderIlpAddress, senderIlpAddress);
            // AFTER the route: `addRoute` refuses a child-held prefix that is
            // not under the connector's own address (see the module doc).
            markReturnPeerAsChild(senderIlpAddress);
            logger?.debug?.('swap.rolling.return_route_bound', {
              prefix: senderIlpAddress,
              nextHop: senderIlpAddress,
            });
            return { status: 'bound', nextHop: senderIlpAddress };
          } catch (err) {
            logger?.warn?.('swap.rolling.return_route_bind_failed', {
              senderIlpAddress,
              err: err instanceof Error ? err.message : String(err),
            });
          }
        }
      }

      // Could not reply on the arrival session — is the address routable
      // anyway (an operator route, or the default-up-to-parent route on a
      // child maker, which is how an apex-forwarded sender is reached)?
      if (existing) return { status: 'routed', nextHop: existing.nextHop };

      return {
        status: 'unreachable',
        reason: isReplyableSessionId(sourcePeer)
          ? `the RFQ arrived on BTP session "${String(sourcePeer)}" but advertised ` +
            `senderIlpAddress "${senderIlpAddress}"; leg B can only be returned ` +
            `to the address the session authenticated under`
          : `no BTP session to return leg B on (arrival peer ` +
            `"${String(sourcePeer ?? 'unknown')}") and no route to "${senderIlpAddress}"`,
      };
    },

    boundPrefixes(): string[] {
      return [...owned.keys()];
    },

    release(): void {
      for (const prefix of [...owned.keys()]) {
        try {
          removeRoute?.(prefix);
        } catch {
          // Best effort: the connector may already be stopped.
        }
      }
      owned.clear();
    },
  };
}
