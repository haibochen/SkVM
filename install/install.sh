#!/usr/bin/env sh
# SkVM one-liner installer.
#
# Usage:
#   curl -fsSL <public-mirror>/install.sh | sh
#
# Options (via environment):
#   SKVM_VERSION=v0.1.0     # pin a specific version (default: latest)
#   SKVM_PREFIX=<dir>       # install root (default: ~/.local/share/skvm)
#   SKVM_BIN_DIR=<dir>      # symlink location (default: ~/.local/bin)
#   SKVM_SKIP_OPENCODE=1    # skip bundling opencode (see plan §1.8)
#
# The script is intentionally zero-interactive so agents reading docs can copy
# the single curl|sh line and succeed without follow-up prompts.

set -eu

# ------------ release host ------------
RELEASE_OWNER="SJTU-IPADS"
RELEASE_REPO="SkVM"

# ------------ download sources (auto-fallback) ------------
# The installer tries each base in order. If GitHub is unreachable or stalls
# (common from mainland China), the script silently falls back to the
# configured non-GitHub mirror — no env var or user action required.
#
# Keep this list in sync with install/release-host.json (postinstall.js uses it).
# The mirror must mirror GitHub's path structure:
#   <releases_base>/<owner>/<repo>/releases/download/<tag>/<asset>
#   <api_base>/repos/<owner>/<repo>/releases/latest     (static JSON ok)
DEFAULT_MIRROR_BASE="https://skvm.oss-cn-shanghai.aliyuncs.com"
MIRROR_RELEASES="${DEFAULT_MIRROR_BASE}/gh"
MIRROR_API="${DEFAULT_MIRROR_BASE}/gh-api"
SOURCE_RELEASES="https://github.com ${MIRROR_RELEASES}"
SOURCE_API="https://api.github.com ${MIRROR_API}"

# Optional override (advanced): SKVM_DOWNLOAD_BASE=github|mirror|<custom-url>
case "${SKVM_DOWNLOAD_BASE:-}" in
  "") ;;
  github)
    SOURCE_RELEASES="https://github.com"
    SOURCE_API="https://api.github.com"
    ;;
  mirror|cn)
    SOURCE_RELEASES="${MIRROR_RELEASES}"
    SOURCE_API="${MIRROR_API}"
    ;;
  http*|https*)
    _base="${SKVM_DOWNLOAD_BASE%/}"
    SOURCE_RELEASES="${_base}/gh"
    SOURCE_API="${_base}/gh-api"
    ;;
esac

# fetch_with_fallback KIND REL_PATH [OUT_FILE]
#   KIND: "releases" | "api"
#   REL_PATH: path after the base (must start with "/")
#   OUT_FILE: when provided, body is written there; otherwise echoed to stdout
# Returns 0 on the first source that succeeds, non-zero if all sources fail.
#
# Timeout rationale (matters for CN ↔ GitHub):
#   --connect-timeout 8   : fail fast if TCP can't establish
#   --speed-time 15 / --speed-limit 1024 : abort stalled transfers (<1KB/s for 15s)
#   --max-time 30 (text)  : bound small metadata fetches
#   --retry 1 --retry-connrefused : one retry on the same URL before giving up
fetch_with_fallback() {
  _kind="$1"
  _rel="$2"
  _out="${3:-}"

  case "$_kind" in
    releases) _bases="$SOURCE_RELEASES" ;;
    api)      _bases="$SOURCE_API"      ;;
    *) echo "fetch_with_fallback: unknown kind $_kind" >&2; return 2 ;;
  esac

  for _base in $_bases; do
    _u="${_base}${_rel}"
    if [ -n "$_out" ]; then
      if curl -fsSL --connect-timeout 8 --speed-time 15 --speed-limit 1024 \
              --retry 1 --retry-connrefused "$_u" -o "$_out"; then
        return 0
      fi
    else
      if curl -fsSL --connect-timeout 8 --max-time 30 \
              --retry 1 --retry-connrefused "$_u"; then
        return 0
      fi
    fi
    echo "skvm install.sh: ${_base} unreachable, trying next source..." >&2
  done
  return 1
}

# ------------ prefix ------------
: "${SKVM_PREFIX:=${HOME}/.local/share/skvm}"
: "${SKVM_BIN_DIR:=${HOME}/.local/bin}"

# ------------ platform detection ------------
uname_s=$(uname -s)
uname_m=$(uname -m)

case "$uname_s" in
  Darwin) os="darwin" ;;
  Linux)  os="linux"  ;;
  *)
    echo "skvm install.sh: unsupported OS $uname_s. Supported: Darwin, Linux." >&2
    exit 1
    ;;
esac

case "$uname_m" in
  arm64|aarch64) arch="arm64" ;;
  x86_64|amd64)  arch="x64"   ;;
  *)
    echo "skvm install.sh: unsupported arch $uname_m. Supported: arm64, x64." >&2
    exit 1
    ;;
esac

target="${os}-${arch}"

# ------------ resolve version ------------
if [ -z "${SKVM_VERSION:-}" ]; then
  latest_rel="/repos/${RELEASE_OWNER}/${RELEASE_REPO}/releases/latest"
  latest_body=$(fetch_with_fallback api "$latest_rel") || {
    echo "skvm install.sh: failed to resolve latest release from any source" >&2
    exit 1
  }
  tag=$(echo "$latest_body" | sed -n 's/.*"tag_name":[ ]*"\([^"]*\)".*/\1/p' | head -n1)
  if [ -z "$tag" ]; then
    echo "skvm install.sh: failed to parse latest release tag" >&2
    exit 1
  fi
  SKVM_VERSION="$tag"
fi

version="${SKVM_VERSION#v}"
tag="v${version}"
tarball_name="skvm-${tag}-${target}.tar.gz"
tarball_rel="/${RELEASE_OWNER}/${RELEASE_REPO}/releases/download/${tag}/${tarball_name}"

# ------------ download + verify ------------
tmp_dir=$(mktemp -d -t skvm-install.XXXXXX)
trap 'rm -rf "$tmp_dir"' EXIT

echo "skvm install.sh: downloading ${tarball_name}"
fetch_with_fallback releases "$tarball_rel" "${tmp_dir}/${tarball_name}" || {
  echo "skvm install.sh: failed to download ${tarball_name} from any source" >&2
  exit 1
}

if fetch_with_fallback releases "${tarball_rel}.sha256" "${tmp_dir}/${tarball_name}.sha256" 2>/dev/null; then
  expected=$(cut -d' ' -f1 < "${tmp_dir}/${tarball_name}.sha256")
  if command -v sha256sum >/dev/null 2>&1; then
    actual=$(sha256sum "${tmp_dir}/${tarball_name}" | cut -d' ' -f1)
  elif command -v shasum >/dev/null 2>&1; then
    actual=$(shasum -a 256 "${tmp_dir}/${tarball_name}" | cut -d' ' -f1)
  else
    echo "skvm install.sh: no sha256sum/shasum available, skipping checksum verification" >&2
    actual="$expected"
  fi
  if [ "$expected" != "$actual" ]; then
    echo "skvm install.sh: sha256 mismatch (expected $expected, got $actual)" >&2
    exit 1
  fi
else
  echo "skvm install.sh: no checksum published for ${tarball_name}, skipping verification" >&2
fi

# ------------ extract ------------
mkdir -p "$SKVM_PREFIX" "$SKVM_BIN_DIR"
tar -xzf "${tmp_dir}/${tarball_name}" -C "$SKVM_PREFIX"

binary_src="${SKVM_PREFIX}/bin/skvm"
if [ ! -f "$binary_src" ]; then
  echo "skvm install.sh: binary not found after extraction at $binary_src" >&2
  exit 1
fi
chmod +x "$binary_src"

ln -sf "$binary_src" "${SKVM_BIN_DIR}/skvm"

# ------------ opencode bundling (plan §1.8) ------------
# Keep these constants in sync with install/opencode-version.json and
# install/postinstall.js. When bumping, refresh version + sha256 values from the
# upstream release at https://github.com/anomalyco/opencode/releases
OPENCODE_VERSION="v1.4.3"
OPENCODE_OWNER="anomalyco"
OPENCODE_REPO="opencode"

# Each upstream release asset is a flat archive containing a single `opencode`
# executable at the top level (no bin/ wrapper). Darwin targets ship as .zip,
# Linux targets as .tar.gz. Per-target sha256 values are verified before install.
opencode_asset_for_target() {
  case "$1" in
    darwin-arm64) echo "opencode-darwin-arm64.zip zip d085c072087fa1cf076058ae28785a31a9368e0f3c42985ea8c558036fcb9b0c" ;;
    darwin-x64)   echo "opencode-darwin-x64.zip zip 1431028e324dcdd2322e5aa710444a52c6de74d1a382f8082a4ad12fdae0768f"   ;;
    linux-x64)    echo "opencode-linux-x64.tar.gz tar.gz 34d503ebb029853293be6fd4d441bbb2dbb03919bfa4525e88b1ca55d68f3e17" ;;
    linux-arm64)  echo "opencode-linux-arm64.tar.gz tar.gz 4cbf32f4c31da7dae14712b65aadbce6acfa1a7a85bee986a2ce4eaaed4eb5c8" ;;
    *) return 1 ;;
  esac
}

install_opencode() {
  asset_line=$(opencode_asset_for_target "$target") || {
    echo "skvm install.sh: no bundled opencode for target $target; jit-optimize will require an external opencode" >&2
    return 0
  }
  set -- $asset_line
  opencode_asset="$1"
  opencode_format="$2"
  opencode_expected_sum="$3"

  opencode_rel="/${OPENCODE_OWNER}/${OPENCODE_REPO}/releases/download/${OPENCODE_VERSION}/${opencode_asset}"
  vendor_root="${SKVM_PREFIX}/vendor/opencode"
  version_dir="${vendor_root}/${OPENCODE_VERSION}"
  profile_root="${vendor_root}/profile"

  if [ -x "${version_dir}/bin/opencode" ]; then
    echo "skvm install.sh: bundled opencode ${OPENCODE_VERSION} already present"
  else
    echo "skvm install.sh: downloading bundled opencode ${OPENCODE_VERSION}"
    mkdir -p "$version_dir"
    opencode_tmp="${tmp_dir}/${opencode_asset}"
    if ! fetch_with_fallback releases "$opencode_rel" "$opencode_tmp"; then
      echo "skvm install.sh: failed to download opencode from any source" >&2
      echo "  Falling back to external opencode (global install or adapters.opencode)." >&2
      return 0
    fi

    # Verify sha256
    if command -v sha256sum >/dev/null 2>&1; then
      actual_sum=$(sha256sum "$opencode_tmp" | cut -d' ' -f1)
    elif command -v shasum >/dev/null 2>&1; then
      actual_sum=$(shasum -a 256 "$opencode_tmp" | cut -d' ' -f1)
    else
      actual_sum="$opencode_expected_sum"
    fi
    if [ "$actual_sum" != "$opencode_expected_sum" ]; then
      echo "skvm install.sh: opencode sha256 mismatch (expected $opencode_expected_sum, got $actual_sum)" >&2
      return 1
    fi

    # Extract to a staging dir, then relocate the flat `opencode` binary into bin/
    stage="${tmp_dir}/opencode-extract"
    rm -rf "$stage"
    mkdir -p "$stage"
    case "$opencode_format" in
      zip)
        if ! command -v unzip >/dev/null 2>&1; then
          echo "skvm install.sh: unzip not available; cannot extract $opencode_asset" >&2
          return 1
        fi
        unzip -q "$opencode_tmp" -d "$stage"
        ;;
      tar.gz)
        tar -xzf "$opencode_tmp" -C "$stage"
        ;;
      *)
        echo "skvm install.sh: unknown opencode archive format $opencode_format" >&2
        return 1
        ;;
    esac

    # Locate the extracted `opencode` binary (flat-single-binary layout per the
    # current upstream releases; fallback-search the stage dir for robustness).
    found=""
    if [ -f "${stage}/opencode" ]; then
      found="${stage}/opencode"
    else
      found=$(find "$stage" -type f -name opencode 2>/dev/null | head -n1 || true)
    fi
    if [ -z "$found" ]; then
      echo "skvm install.sh: opencode binary not found in extracted archive" >&2
      return 1
    fi
    mkdir -p "${version_dir}/bin"
    mv "$found" "${version_dir}/bin/opencode"
    chmod +x "${version_dir}/bin/opencode"
  fi

  # Update the "current" pointer used by src/adapters/opencode.ts resolver
  ln -sfn "$OPENCODE_VERSION" "${vendor_root}/current"

  # Create isolated profile dirs on first install (preserve contents on upgrades)
  for sub in config data state cache plugins skills; do
    mkdir -p "${profile_root}/${sub}"
  done

  echo "skvm install.sh: bundled opencode ready at ${version_dir}/bin/opencode"
  echo "  Profile root (isolated from global opencode): ${profile_root}"
}

if [ "${SKVM_SKIP_OPENCODE:-0}" = "1" ]; then
  echo "skvm install.sh: SKVM_SKIP_OPENCODE=1, skipping bundled opencode"
else
  install_opencode
fi

# ------------ PATH hint ------------
case ":${PATH:-}:" in
  *":${SKVM_BIN_DIR}:"*) path_ok=1 ;;
  *) path_ok=0 ;;
esac

echo ""
echo "skvm ${tag} installed to ${SKVM_PREFIX}"
echo "Symlink: ${SKVM_BIN_DIR}/skvm"
if [ "$path_ok" = "0" ]; then
  echo ""
  echo "Add ${SKVM_BIN_DIR} to your PATH:"
  echo "  export PATH=\"${SKVM_BIN_DIR}:\$PATH\""
fi
echo ""
echo "Next:"
echo "  export OPENROUTER_API_KEY=sk-or-..."
echo "  skvm --help"
