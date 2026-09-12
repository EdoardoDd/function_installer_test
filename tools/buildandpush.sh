#!/usr/bin/env bash

# l'immagine viene sempre pubblicata come:
#   edoardodd/prism-function-installer:latest
#
# Assunzione sulla struttura repo, stessa di workflow-master/buildandpush.sh:
# questo script vive in <root>/tools (o admin/), e la root del repo
# function-installer (quella col Dockerfile) e' la directory superiore.
# Correggi il "cd" sotto se la disposizione reale e' diversa.

set -euo pipefail

IMAGE="edoardodd/prism-function-installer:latest"

cd "$(dirname "$0")/.."

echo "Build directory: $(pwd)" >&2
echo "Building: $IMAGE" >&2

docker build -t "$IMAGE" .

echo "Pushing: $IMAGE" >&2
docker push "$IMAGE"

echo "Pubblicata: $IMAGE" >&2
