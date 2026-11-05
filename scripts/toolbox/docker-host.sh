#!/usr/bin/env bash
set -euo pipefail
docker_real="${EVALUATOR_DOCKER_CLI:-docker}"

if [[ "${1:-}" == "image" && "${2:-}" == "inspect" && "${3:-}" == "--platform" ]]; then
  api_version="$("$docker_real" version --format '{{.Server.APIVersion}}')"
  if [[ ! "$api_version" =~ ^([0-9]+)\.([0-9]+)$ ]]; then
    printf 'Cannot identify the Docker daemon API version: %s\n' "$api_version" >&2
    exit 1
  fi
  if (( BASH_REMATCH[1] == 1 && BASH_REMATCH[2] < 49 )); then
    requested_platform="$4"
    image="$5"
    actual_platform="$("$docker_real" image inspect "$image" --format '{{.Os}}/{{.Architecture}}')"
    if [[ "$actual_platform" != "$requested_platform" ]]; then
      printf 'Image %s has architecture %s, but %s is required; pull or build the image with the required --platform first.\n' \
        "$image" "$actual_platform" "$requested_platform" >&2
      exit 1
    fi
    shift 4
    exec "$docker_real" image inspect "$@"
  fi
fi

if [[ "${EVALUATOR_TOOLBOX_HOST_NETWORK:-0}" == "1" && ( "${1:-}" == "create" || "${1:-}" == "run" ) ]]; then
  has_network=false
  for argument in "$@"; do
    case "$argument" in
      --network|--network=*|--net|--net=*) has_network=true ;;
    esac
  done
  # Preserve explicit policies such as none and the isolated model-api task.
  if [[ "$has_network" == false ]]; then
    operation="$1"
    shift
    exec "$docker_real" "$operation" --network host "$@"
  fi
fi

exec "$docker_real" "$@"
