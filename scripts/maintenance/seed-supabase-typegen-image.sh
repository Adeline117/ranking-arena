#!/usr/bin/env bash

# Supabase CLI 2.109.1 runs `gen types --db-url` through postgres-meta v0.96.6.
# On a cold GitHub runner its default Public ECR pull can be rate-limited before
# type generation starts. Seed the exact same official multi-arch image from
# Supabase's Docker Hub mirror, pinned by the shared immutable manifest digest,
# then tag it with the name the CLI expects.
#
# Verified 2026-07-17:
#   supabase/postgres-meta:v0.96.6
#   public.ecr.aws/supabase/postgres-meta:v0.96.6
# both resolve to the manifest digest below.

set -Eeuo pipefail

POSTGRES_META_VERSION="v0.96.6"
POSTGRES_META_DIGEST="sha256:a84cc713585eea7b401e4a2561ec4a1e48c87083d1c7ecb4502f204bb4391300"
MIRROR_IMAGE="supabase/postgres-meta@$POSTGRES_META_DIGEST"
ECR_IMAGE="public.ecr.aws/supabase/postgres-meta@$POSTGRES_META_DIGEST"
CLI_IMAGE="public.ecr.aws/supabase/postgres-meta:$POSTGRES_META_VERSION"
MAX_ATTEMPTS=3

if ! command -v docker >/dev/null 2>&1; then
  echo "docker is required to seed the Supabase typegen image" >&2
  exit 1
fi

pull_with_retry() {
  local image="$1"
  local attempt

  for ((attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1)); do
    if docker pull "$image"; then
      return 0
    fi
    if ((attempt < MAX_ATTEMPTS)); then
      local delay=$((attempt * 10))
      echo "image pull attempt $attempt/$MAX_ATTEMPTS failed; retrying in ${delay}s" >&2
      sleep "$delay"
    fi
  done
  return 1
}

if pull_with_retry "$MIRROR_IMAGE"; then
  source_image="$MIRROR_IMAGE"
else
  echo "Docker Hub mirror unavailable; falling back to the CLI's Public ECR source" >&2
  pull_with_retry "$ECR_IMAGE"
  source_image="$ECR_IMAGE"
fi

docker tag "$source_image" "$CLI_IMAGE"

expected_id="$(docker image inspect "$source_image" --format '{{.Id}}')"
actual_id="$(docker image inspect "$CLI_IMAGE" --format '{{.Id}}')"
if [[ "$actual_id" != "$expected_id" ]]; then
  echo "seeded postgres-meta image does not match the pinned mirror" >&2
  exit 1
fi

echo "Seeded $CLI_IMAGE ($actual_id)"
