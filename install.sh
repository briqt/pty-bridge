#!/usr/bin/env bash
set -euo pipefail

# Check prerequisites
if ! command -v node &>/dev/null; then
  echo "Error: Node.js is required but not installed."
  echo "Install Node.js 18+: https://nodejs.org/"
  exit 1
fi

REPO="briqt/pty-bridge"
VERSION=""
PREFIX=""

usage() {
  echo "Usage: install.sh [--version VERSION] [--prefix DIR]"
  echo "  --version   Version to install (e.g. 1.2.0), default: latest"
  echo "  --prefix    Install directory, default: ~/.local/share/pty-bridge"
  exit 1
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --version) VERSION="$2"; shift 2 ;;
    --prefix)  PREFIX="$2"; shift 2 ;;
    -h|--help) usage ;;
    *) echo "Unknown option: $1"; usage ;;
  esac
done

# Detect platform
OS="$(uname -s | tr '[:upper:]' '[:lower:]')"
ARCH="$(uname -m)"
case "$OS" in
  linux)  PLATFORM="linux" ;;
  darwin) PLATFORM="darwin" ;;
  *) echo "Error: unsupported OS: $OS"; exit 1 ;;
esac
case "$ARCH" in
  x86_64|amd64) ARCH="x64" ;;
  arm64|aarch64) ARCH="arm64" ;;
  *) echo "Error: unsupported architecture: $ARCH"; exit 1 ;;
esac

# Resolve version
if [[ -z "$VERSION" ]]; then
  VERSION="$(curl -fsSL "https://api.github.com/repos/${REPO}/releases/latest" | grep '"tag_name"' | sed -E 's/.*"v([^"]+)".*/\1/')"
  if [[ -z "$VERSION" ]]; then
    echo "Error: could not determine latest version"; exit 1
  fi
fi

INSTALL_DIR="${PREFIX:-${PTY_BRIDGE_HOME:-$HOME/.local/share/pty-bridge}}"
BIN_DIR="$HOME/.local/bin"

ARCHIVE="pty-bridge-${VERSION}-${PLATFORM}-${ARCH}.tar.gz"
URL="https://github.com/${REPO}/releases/download/v${VERSION}/${ARCHIVE}"

echo "Installing pty-bridge v${VERSION} (${PLATFORM}-${ARCH})..."

# Download and extract
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
curl -fsSL "$URL" -o "$TMP/$ARCHIVE"
tar -xzf "$TMP/$ARCHIVE" -C "$TMP"

# Install
rm -rf "$INSTALL_DIR"
mkdir -p "$INSTALL_DIR"
cp -r "$TMP/pty-bridge/." "$INSTALL_DIR/"
chmod +x "$INSTALL_DIR/bin/pty-bridge"

# Symlink
mkdir -p "$BIN_DIR"
ln -sf "$INSTALL_DIR/bin/pty-bridge" "$BIN_DIR/pty-bridge"

echo "Installed to $INSTALL_DIR"
echo "Symlinked $BIN_DIR/pty-bridge"

# Check PATH
if ! echo "$PATH" | tr ':' '\n' | grep -qx "$BIN_DIR"; then
  echo ""
  echo "Add ~/.local/bin to your PATH:"
  echo "  export PATH=\"\$HOME/.local/bin:\$PATH\""
fi
