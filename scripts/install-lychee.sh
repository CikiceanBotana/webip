#!/usr/bin/env bash
#
# Fetch the pinned lychee binary into ./bin/.
#
# lychee is a Rust binary, not an npm package, so it cannot live in
# package-lock.json. This script is its reproducibility record: the version and
# the SHA-256 below are pinned, and the checksum is verified before install.
#
# Resolution order tried during setup (per project requirements):
#   a) official prebuilt binary from github.com/lycheeverse/lychee/releases  <- USED
#   b) official Docker image lycheeverse/lychee                              <- not used
# (a) succeeded, so (b) was never needed. Docker is also absent on the dev host.
#
# Usage: ./scripts/install-lychee.sh
set -euo pipefail

LYCHEE_VERSION="0.24.2"
LYCHEE_TARGET="x86_64-unknown-linux-gnu"
LYCHEE_SHA256="1f4e0ef7f6554a6ed33dd7ac144fb2e1bbed98598e7af973042fc5cd43951c9a"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BIN_DIR="${ROOT}/bin"
TARBALL="lychee-${LYCHEE_TARGET}.tar.gz"
URL="https://github.com/lycheeverse/lychee/releases/download/lychee-v${LYCHEE_VERSION}/${TARBALL}"

TMP="$(mktemp -d)"
trap 'rm -rf "${TMP}"' EXIT

echo "==> Downloading lychee v${LYCHEE_VERSION} (${LYCHEE_TARGET})"
curl -fsSL -o "${TMP}/${TARBALL}" "${URL}"

echo "==> Verifying SHA-256"
echo "${LYCHEE_SHA256}  ${TMP}/${TARBALL}" | sha256sum -c -

echo "==> Extracting"
tar -xzf "${TMP}/${TARBALL}" -C "${TMP}"

mkdir -p "${BIN_DIR}"
install -m 0755 "${TMP}/lychee-${LYCHEE_TARGET}/lychee" "${BIN_DIR}/lychee"

echo "==> Installed: $("${BIN_DIR}/lychee" --version)"
