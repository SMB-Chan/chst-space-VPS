#!/bin/bash
set -e
pnpm install --frozen-lockfile
pnpm run typecheck:libs
pnpm --filter @workspace/db run push
