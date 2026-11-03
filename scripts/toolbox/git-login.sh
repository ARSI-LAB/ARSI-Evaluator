#!/usr/bin/env bash
set +x
set -euo pipefail

if [[ "${HOME:-}" != "/toolbox-home" ]]; then
  printf '%s\n' "Run bash scripts/toolbox/run.sh first, then run this login script inside the toolbox container." >&2
  exit 1
fi

repository_url="https://gitcode.com/evanTang/AgentBundle.git"
credential_section="credential.$repository_url"

printf '%s\n' "Accessing AgentBundle over HTTPS; use a GitCode access token with read permission for the private repository as the password."
read -r -p "GitCode username: " gitcode_username
read -r -s -p "GitCode access token (used as the password): " gitcode_token
printf '\n'
if [[ -z "$gitcode_username" || -z "$gitcode_token" ]]; then
  printf '%s\n' "The username and access token must not be empty." >&2
  exit 1
fi

# Scope transport and authentication changes to this dependency repository.
git config --global --replace-all "url.$repository_url.insteadOf" "ssh://git@gitcode.com/evanTang/AgentBundle.git"
git config --global --add "url.$repository_url.insteadOf" "ssh://gitcode.com/evanTang/AgentBundle.git"
git config --global --add "url.$repository_url.insteadOf" "git@gitcode.com:evanTang/AgentBundle.git"
git config --global "$credential_section.useHttpPath" true
git config --global --replace-all "$credential_section.helper" ""
git config --global --add "$credential_section.helper" "cache --timeout=28800"

# Reset inherited helpers above so the token is kept only in the cache daemon.
printf 'protocol=https\nhost=gitcode.com\npath=evanTang/AgentBundle.git\nusername=%s\npassword=%s\n\n' \
  "$gitcode_username" "$gitcode_token" | git credential approve
unset gitcode_token gitcode_username

if ! GIT_TERMINAL_PROMPT=0 GIT_ASKPASS=/bin/false git ls-remote "$repository_url" HEAD >/dev/null; then
  printf 'protocol=https\nhost=gitcode.com\npath=evanTang/AgentBundle.git\n\n' | git credential reject
  printf '%s\n' "AgentBundle access verification failed; cached credentials from this attempt were cleared. Check the username, token permissions and network, then retry." >&2
  exit 1
fi

printf '%s\n' "AgentBundle HTTPS access verified. The token is cached in memory for 8 hours; log in again after leaving the toolbox container."
printf '%s\n' "You can now run pnpm install --frozen-lockfile && pnpm build."
