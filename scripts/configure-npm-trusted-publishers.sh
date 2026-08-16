#!/usr/bin/env bash

set -Eeuo pipefail

readonly EXPECTED_NPM_USER="signalridge"
readonly NPM_REGISTRY="https://registry.npmjs.org"
readonly REPOSITORY="signalridge/pi-extensions"
readonly WORKFLOW_FILE="publish-packages.yml"
readonly ENVIRONMENT="npm-publish"
REPOSITORY_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
readonly REPOSITORY_ROOT

for command_name in npm jq; do
  if ! command -v "$command_name" >/dev/null 2>&1; then
    printf 'error: required command not found: %s\n' "$command_name" >&2
    exit 1
  fi
done

if ! npm trust github --help >/dev/null 2>&1; then
  printf 'error: this npm CLI does not support `npm trust github`; upgrade npm to a Trusted Publishing-capable version and rerun this script.\n' >&2
  exit 1
fi

npm_user="$(npm whoami --registry="$NPM_REGISTRY")"
if [[ "$npm_user" != "$EXPECTED_NPM_USER" ]]; then
  printf 'error: npm CLI is logged in as %s; expected %s\n' "$npm_user" "$EXPECTED_NPM_USER" >&2
  exit 1
fi

publishable_packages=()
shopt -s nullglob
manifests=("$REPOSITORY_ROOT"/packages/*/package.json)
for manifest in "${manifests[@]}"; do
  package_name="$(jq -r '
    select(.private != true and .publishConfig.access == "public")
    | if (.name | type) == "string" then .name else error("publishable package has no string name") end
  ' "$manifest")"
  if [[ -n "$package_name" ]]; then
    publishable_packages+=("$package_name")
  fi
done

if (( ${#publishable_packages[@]} == 0 )); then
  printf 'error: no publishable packages found\n' >&2
  exit 1
fi

sorted_packages=()
while IFS= read -r package_name; do
  sorted_packages+=("$package_name")
done < <(printf '%s\n' "${publishable_packages[@]}" | LC_ALL=C sort)
publishable_packages=("${sorted_packages[@]}")

printf 'Preflighting package names on npm...\n'
for index in "${!publishable_packages[@]}"; do
  package_name="${publishable_packages[$index]}"
  printf '[%d/%d] Checking %s...\n' \
    "$((index + 1))" "${#publishable_packages[@]}" "$package_name"
  if ! published_name="$(npm view "$package_name" name --json --registry="$NPM_REGISTRY" | jq -er '.')"; then
    printf 'error: npm package lookup failed for %s; verify that the package exists and that the npm account can read it\n' \
      "$package_name" >&2
    exit 1
  fi
  if [[ "$published_name" != "$package_name" ]]; then
    printf 'error: npm returned package name %s for %s\n' "$published_name" "$package_name" >&2
    exit 1
  fi
done

printf '\nnpm user: %s\n' "$npm_user"
printf 'npm registry: %s\n' "$NPM_REGISTRY"
printf 'trusted GitHub repository: %s\n' "$REPOSITORY"
printf 'trusted workflow: .github/workflows/%s\n' "$WORKFLOW_FILE"
printf 'trusted environment: %s\n' "$ENVIRONMENT"
printf 'packages to configure (%d):\n' "${#publishable_packages[@]}"
printf '  %s\n' "${publishable_packages[@]}"
printf '\nEach package may require browser-based npm two-factor authentication.\n'

if [[ "${1:-}" != "--yes" ]]; then
  read -r -p 'Configure Trusted Publishing for every package above? [y/N] ' answer
  case "$answer" in
    y|Y|yes|YES) ;;
    *)
      printf 'Cancelled.\n'
      exit 0
      ;;
  esac
fi

for index in "${!publishable_packages[@]}"; do
  package_name="${publishable_packages[$index]}"
  printf '\n[%d/%d] Configuring %s...\n' \
    "$((index + 1))" "${#publishable_packages[@]}" "$package_name"
  npm trust github "$package_name" \
    --registry="$NPM_REGISTRY" \
    --repository "$REPOSITORY" \
    --file "$WORKFLOW_FILE" \
    --environment "$ENVIRONMENT" \
    --allow-publish \
    --yes
done

printf '\nConfigured npm Trusted Publishing for all %d packages.\n' "${#publishable_packages[@]}"
printf 'GitHub Actions can now publish them through %s in environment %s.\n' \
  "$WORKFLOW_FILE" "$ENVIRONMENT"
