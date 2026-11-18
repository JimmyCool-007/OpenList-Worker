#!/usr/bin/env bash
set -euo pipefail

base=https://drive.jimmy007.com/cli-releases
bin="$HOME/.local/bin"
path="$bin/ol"
proof="$bin/.ol-install.sha256"
die() { printf 'ol installer: %s\n' "$*" >&2; exit 1; }

[[ $(uname -s) == Linux ]] || die 'Linux is required.'
case "$(uname -m)" in
  x86_64|amd64) arch=amd64 ;;
  aarch64|arm64) arch=arm64 ;;
  *) die "Unsupported CPU architecture $(uname -m)." ;;
esac
for command in curl sha256sum mktemp chmod mkdir ln mv grep rm rmdir; do
  command -v "$command" >/dev/null || die "Missing required command $command."
done
fetch() {
  curl --proto '=https' --proto-redir '=https' --tlsv1.2 --retry 4 --retry-delay 1 \
    --connect-timeout 15 --max-time 900 -fsSL "$1" -o "$2" || die "Download failed for $1."
}

mkdir -p -- "$bin"
lock="$bin/.ol-install.lock"
mkdir -- "$lock" 2>/dev/null || die "Could not acquire the installer lock at $lock."
tmp=
trap 'if [[ -n "$tmp" ]]; then rm -rf -- "$tmp"; fi; rmdir -- "$lock"' EXIT
trap 'exit 1' HUP INT TERM
tmp=$(mktemp -d "$bin/.ol-install.XXXXXXXX")

if [[ -n ${OL_VERSION:-} ]]; then
  version=$OL_VERSION
else
  fetch "$base/latest" "$tmp/version"
  version=$(<"$tmp/version")
fi
[[ $version =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || die 'Invalid release version.'
asset="ol-linux-$arch"
url="$base/$version"

if [[ -e "$path" || -L "$path" ]]; then
  [[ -f "$path" && ! -L "$path" && -f "$proof" && ! -L "$proof" ]] ||
    die "$path already exists and is unmanaged. Move it before installing."
  current=$(sha256sum -- "$path")
  [[ ${current%% *} == "$(<"$proof")" ]] ||
    die "$path differs from the managed installation. Move it before installing."
fi

fetch "$url/SHA256SUMS" "$tmp/SHA256SUMS"
fetch "$url/$asset" "$tmp/$asset"
expected=
while read -r hash name extra; do
  if [[ $name == "$asset" ]]; then
    [[ -z $expected && -z $extra && $hash =~ ^[a-f0-9]{64}$ ]] || die 'Invalid checksum manifest.'
    expected=$hash
  fi
done < "$tmp/SHA256SUMS"
[[ -n $expected ]] || die "No checksum found for $asset."
actual=$(sha256sum -- "$tmp/$asset")
[[ ${actual%% *} == "$expected" ]] || die 'Downloaded executable failed SHA-256 verification.'
chmod 0755 "$tmp/$asset"
printf '%s\n' "$expected" > "$tmp/proof"
chmod 0600 "$tmp/proof"
if [[ -e "$path" ]]; then
  mv -fT -- "$tmp/$asset" "$path"
else
  ln -T -- "$tmp/$asset" "$path" || die "$path appeared during installation."
fi
mv -fT -- "$tmp/proof" "$proof"

# These files affect subsequent shells; a child process cannot change this shell.
path_line='export PATH="$HOME/.local/bin:$PATH"'
for rc in "$HOME/.bashrc" "$HOME/.zshrc"; do
  if ! grep -Fxq -- "$path_line" "$rc" 2>/dev/null; then
    printf '\n%s\n' "$path_line" >> "$rc" || die "Cannot update $rc."
  fi
done
printf 'Installed ol %s at %s\n' "$version" "$path"
case ":$PATH:" in
  *":$bin:"*)
    if [[ $(command -v ol || true) != "$path" ]]; then
      printf 'Another ol appears earlier in PATH. Run %s or put %s first in PATH.\n' "$path" "$bin"
    fi ;;
  *) printf 'For this shell run: export PATH="$HOME/.local/bin:$PATH"\n' ;;
esac
