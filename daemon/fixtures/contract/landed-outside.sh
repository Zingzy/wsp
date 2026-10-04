set -u
root='{root}'; prefix="$root/opt/wsp"; ledger="$prefix/landed"
nl=$(printf '\nx'); nl=${nl%x}
tab=$(printf "\t")
[ -d "$prefix" ] && [ ! -L "$prefix" ] && [ -f "$ledger" ] && [ ! -L "$ledger" ] || exit 0
at="$prefix/.leaving"
states() {
  : > "$1.files"
  while IFS= read -r p; do
    if [ -L "$p" ]; then printf 'link:%s\t%s\n' "$(readlink "$p" | sha256sum | cut -c1-64)" "$p"
    elif [ -d "$p" ]; then printf 'dir\t%s\n' "$p"
    elif [ -f "$p" ]; then printf '%s\000' "$p" >> "$1.files"
    fi
  done
  [ ! -s "$1.files" ] || xargs -0 sha256sum -z -- < "$1.files" | tr '\000' '\n' | awk '{ print substr($0, 1, 64) "\t" substr($0, 67) }'
  rm -f "$1.files"
}
still() {
  find "$root/usr/local" "$root/opt" \( -path "$prefix" -o -path "*$nl*" \) -prune -o -type d -print > "$1.dirs" 2>/dev/null
  wsp_root="$root" wsp_prefix="$prefix" awk -F"\t" 'NR == FNR { d[$0] = 1; next } { s[substr($0, length($1) + 2)] = $1 } END {
    r = ENVIRON["wsp_root"]; px = ENVIRON["wsp_prefix"]
    for (p in s) {
      q = p; sub(/\/[^\/]*$/, "", q)
      if (index(p, r "/usr/local/") != 1 && index(p, r "/opt/") != 1) continue
      if (p == px || index(p, px "/") == 1 || index(p "/", "/./") || index(p "/", "/../") || index(p, "//") || !(q in d)) continue
      print s[p] "\t" p
    }
  }' "$1.dirs" "$ledger" > "$1.latest"
  cut -f2- "$1.latest" | states "$1" > "$1.now"
  awk -F"\t" 'NR == FNR { s[substr($0, length($1) + 2)] = $1; next } { p = substr($0, length($1) + 2); if ((p in s) && s[p] == $1) print }' "$1.latest" "$1.now"
  rm -f "$1.dirs" "$1.latest" "$1.now"
}
rm -f "$at".*
still "$at.s" | LC_ALL=C sort -t"$tab" -k2 -r > "$at.take"
: > "$at.files"; : > "$at.dirs"
while IFS="$tab" read -r was p; do
  if [ "$was" = dir ]; then printf '%s\000' "$p" >> "$at.dirs"; else printf '%s\000' "$p" >> "$at.files"; fi
done < "$at.take"
xargs -0 rm -f -- < "$at.files"
xargs -0 rmdir -- < "$at.dirs" 2>/dev/null
while IFS="$tab" read -r was p; do
  [ -e "$p" ] || [ -L "$p" ] || printf 'wsp-outside\t%s\n' "$p"
done < "$at.take"
rm -f "$ledger" "$at".*
exit 0
