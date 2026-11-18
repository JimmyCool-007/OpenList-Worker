#!/usr/bin/env bash
set -euo pipefail
root=$(cd "$(dirname "$0")/.." && pwd)
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
mkdir -p "$tmp/bin" "$tmp/assets/0.1.5" "$tmp/assets/0.1.6" "$tmp/home"
export TEST_ASSETS="$tmp/assets" TEST_LOG="$tmp/requests" TEST_ARCH=x86_64
printf '0.1.5\n' > "$tmp/assets/latest"
for version in 0.1.5 0.1.6; do
  for arch in amd64 arm64; do
    printf '#!/bin/sh\necho %s-%s\n' "$version" "$arch" > "$tmp/assets/$version/ol-linux-$arch"
  done
  (cd "$tmp/assets/$version" && sha256sum ol-linux-amd64 ol-linux-arm64 > SHA256SUMS)
done
cat > "$tmp/bin/uname" <<'SH'
#!/usr/bin/env bash
case "$1" in -s) echo Linux ;; -m) echo "$TEST_ARCH" ;; esac
SH
cat > "$tmp/bin/curl" <<'SH'
#!/usr/bin/env bash
url= out=
while (($#)); do
  case "$1" in
    https://*) url=$1 ;;
    -o) shift; out=$1 ;;
  esac
  shift
done
[[ $url == https://drive.jimmy007.com/cli-releases/* && -n $out ]] || exit 1
printf '%s\n' "$url" >> "$TEST_LOG"
cp "$TEST_ASSETS/${url#https://drive.jimmy007.com/cli-releases/}" "$out"
SH
chmod +x "$tmp/bin/"*
export HOME="$tmp/home" PATH="$tmp/bin:$PATH"
bash "$root/scripts/install-cli.sh" >/dev/null
[[ $("$HOME/.local/bin/ol") == 0.1.5-amd64 ]]
bash "$root/scripts/install-cli.sh" >/dev/null
[[ $(grep -Fxc 'export PATH="$HOME/.local/bin:$PATH"' "$HOME/.bashrc") == 1 ]]
[[ $(grep -Fxc 'export PATH="$HOME/.local/bin:$PATH"' "$HOME/.zshrc") == 1 ]]
OL_VERSION=0.1.6 bash "$root/scripts/install-cli.sh" >/dev/null
[[ $("$HOME/.local/bin/ol") == 0.1.6-amd64 ]]
# A corrupt downloaded binary must leave the previous installation intact.
printf 'tampered\n' >> "$tmp/assets/0.1.5/ol-linux-amd64"
if OL_VERSION=0.1.5 bash "$root/scripts/install-cli.sh" >/dev/null 2>&1; then exit 1; fi
[[ $("$HOME/.local/bin/ol") == 0.1.6-amd64 ]]
export HOME="$tmp/arm-home" TEST_ARCH=aarch64
mkdir -p "$HOME"
bash "$root/scripts/install-cli.sh" >/dev/null
[[ $("$HOME/.local/bin/ol") == 0.1.5-arm64 ]]
TEST_ARCH=riscv64 bash "$root/scripts/install-cli.sh" >/dev/null 2>&1 && exit 1
export HOME="$tmp/unmanaged-home" TEST_ARCH=amd64
mkdir -p "$HOME/.local/bin"
printf 'user file\n' > "$HOME/.local/bin/ol"
if bash "$root/scripts/install-cli.sh" >/dev/null 2>&1; then exit 1; fi
[[ $(cat "$HOME/.local/bin/ol") == 'user file' ]]
if OL_VERSION=../../etc bash "$root/scripts/install-cli.sh" >/dev/null 2>&1; then exit 1; fi
if grep -Ev '^https://drive\.jimmy007\.com/cli-releases/' "$TEST_LOG"; then exit 1; fi
printf 'CLI installer tests passed\n'
