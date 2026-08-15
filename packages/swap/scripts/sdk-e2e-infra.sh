#!/usr/bin/env bash
# swap#104 — bring up the OPTIONAL Solana / Mina infra for the Docker
# cross-chain E2E harness.
#
# The EVM leg does not need this script at all: `pnpm --filter
# @toon-protocol/swap test:e2e:docker` boots Anvil + a Nostr relay + peer1
# on its own (`tests/e2e/global-setup.ts`), needing only `anvil` on PATH.
#
# This script only manages `docker-compose.e2e.yml`'s two chain services
# (solana-test-validator, mina-lightnet). See `tests/e2e/README.md` for the
# full picture, including why the EVM leg does not need Docker at all.
#
# Usage:
#   ./scripts/sdk-e2e-infra.sh up      # start Solana + Mina infra, wait for health
#   ./scripts/sdk-e2e-infra.sh down    # stop and remove it
#   ./scripts/sdk-e2e-infra.sh status  # print docker compose ps

set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

COMPOSE_FILE="docker-compose.e2e.yml"

if ! command -v docker >/dev/null 2>&1; then
  echo "error: docker is required for Solana/Mina E2E infra (the EVM leg does not need it)." >&2
  exit 1
fi

compose() {
  docker compose -f "$COMPOSE_FILE" "$@"
}

case "${1:-}" in
  up)
    compose up -d
    echo "Waiting for solana-test-validator + mina-lightnet health checks..."
    compose up -d --wait
    cat <<EOF

Solana/Mina infra is up. Export these before running the E2E suites:

  export SOLANA_E2E_RPC_URL=http://localhost:19899
  export SOLANA_E2E_PROGRAM_ID=<deployed swap-channel program id>
  export MINA_E2E_GRAPHQL_URL=http://localhost:19085/graphql
  export MINA_E2E_ACCOUNTS_MANAGER_URL=http://localhost:19086
  export MINA_E2E_ZKAPP_ADDRESS=<deployed zkApp address>

SOLANA_E2E_PROGRAM_ID / MINA_E2E_ZKAPP_ADDRESS have no default — deploying
the swap-channel program / zkApp against this fresh validator/lightnet is
a separate, chain-specific step outside this script's scope (see
tests/e2e/README.md).
EOF
    ;;
  down)
    compose down -v
    ;;
  status)
    compose ps
    ;;
  *)
    echo "usage: $0 {up|down|status}" >&2
    exit 1
    ;;
esac
