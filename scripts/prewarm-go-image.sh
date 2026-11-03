#!/usr/bin/env bash
# Build only public baseline code; never mount an attempt, tests, keys or patch.
set -euo pipefail

if [[ $# -lt 3 ]]; then
  echo "Usage: bash scripts/prewarm-go-image.sh BASE_IMAGE NEW_IMAGE BASE_COMMIT [PUBLIC_WORKDIR [PACKAGE...]]" >&2
  exit 2
fi
base_image=$1
new_image=$2
base_commit=$3
public_workdir=${4:-/app}
packages=("${@:5}")
[[ ${#packages[@]} != 0 ]] || packages=(./...)
if [[ -z $base_image || -z $new_image || $base_image == -* || $new_image == -* ]]; then
  echo "BASE_IMAGE and NEW_IMAGE must be image references" >&2
  exit 2
fi
if [[ ! $base_commit =~ ^[0-9a-f]{40}$ ]]; then
  echo "BASE_COMMIT must be a full Git commit ID" >&2
  exit 2
fi
if [[ $public_workdir != /app && $public_workdir != /app/* ]] ||
   [[ $public_workdir == *..* || ! $public_workdir =~ ^/[a-zA-Z0-9_./-]+$ ]]; then
  echo "PUBLIC_WORKDIR must be /app or a directory below it" >&2
  exit 2
fi
for package in "${packages[@]}"; do
  if [[ ! $package =~ ^\./[a-zA-Z0-9_./-]+$ || $package == */../* || $package == */.. ]]; then
    echo "PACKAGE must be a relative Go package pattern" >&2
    exit 2
  fi
done
if docker image inspect "$new_image" >/dev/null 2>&1; then
  echo "NEW_IMAGE already exists; inspect it or choose a new tag" >&2
  exit 2
fi
identity=$(docker image inspect "$base_image" --format '{{.Os}}/{{.Architecture}} {{.Id}}')
read -r image_platform base_id <<< "$identity"
if [[ $image_platform != linux/amd64 || ! $base_id =~ ^sha256:[0-9a-f]{64}$ ]]; then
  echo "BASE_IMAGE must be a locally available linux/amd64 image" >&2
  exit 2
fi
entrypoint=$(docker image inspect "$base_id" --format '{{json .Config.Entrypoint}}')
command=$(docker image inspect "$base_id" --format '{{json .Config.Cmd}}')
cache_dir=/root/.cache/go-build
image_environment=$(docker image inspect "$base_id" --format '{{range .Config.Env}}{{println .}}{{end}}')
while IFS= read -r setting; do
  [[ $setting != GOCACHE=* ]] || cache_dir=${setting#GOCACHE=}
done <<< "$image_environment"
if [[ ! $cache_dir =~ ^/[a-zA-Z0-9_./-]+$ || $cache_dir == *..* ]]; then
  echo "BASE_IMAGE GOCACHE must be an absolute cache directory" >&2
  exit 2
fi
[[ $entrypoint != null ]] || entrypoint='[]'
[[ $command != null ]] || command='[]'
name="ember-public-go-cache-$$-$RANDOM"
cleanup() {
  local result=$?
  trap - EXIT
  local removal
  if ! removal=$(docker rm -f "$name" 2>&1); then
    if [[ $removal != *"No such container"* ]]; then
      echo "[prewarm] Cannot confirm temporary container removal: $name" >&2
      [[ $result != 0 ]] || result=1
    fi
  fi
  exit "$result"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
started=$SECONDS
docker create --name "$name" --platform linux/amd64 --init \
  --network none --cpus 2 --memory 8192m \
  --label ember.purpose=public-go-cache \
  --env "GOCACHE=$cache_dir" \
  --entrypoint bash "$base_id" -lc '
    set -euo pipefail
    cd "$2"
    if [[ $(git rev-parse HEAD) != "$1" ]]; then
      echo "[prewarm] Public base commit mismatch; build was not started" >&2
      exit 10
    fi
    if [[ -n $(git status --porcelain) ]]; then
      echo "[prewarm] Public worktree is not clean; build was not started" >&2
      exit 11
    fi
    export GOGC=off GOMAXPROCS=2
    echo "[prewarm] Public base commit confirmed; building with 2 CPUs"
    go version
    go env GOCACHE
    shift 2
    go build -v "$@"
    test -z "$(git status --porcelain)"
    echo "[prewarm] Public baseline build complete"
  ' prewarm "$base_commit" "$public_workdir" "${packages[@]}" >/dev/null
attach_code=0
docker start --attach "$name" || attach_code=$?
state=$(docker inspect "$name" --format '{{.State.Status}} {{.State.ExitCode}}')
read -r status exit_code <<< "$state"
if [[ $status != exited || $exit_code != 0 || $attach_code != 0 ]]; then
  echo "[prewarm] Public build failed: state=$status exit=$exit_code attach=$attach_code; no image committed" >&2
  [[ $exit_code == 0 ]] || exit "$exit_code"
  exit 1
fi
docker commit \
  --change "ENTRYPOINT $entrypoint" --change "CMD $command" \
  --change "LABEL ember.cache.source=public-baseline" \
  --change "LABEL ember.cache.base=$base_id" \
  --change "LABEL ember.cache.commit=$base_commit" \
  --change "ENV GOCACHE=$cache_dir" \
  "$name" "$new_image"
echo "[prewarm] Completed in $((SECONDS - started))s; image=$new_image"
docker image inspect "$new_image" --format '{{.Id}}'
