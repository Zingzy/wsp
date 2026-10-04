set -u
root='{root}'; prefix="$root/opt/wsp"; ledger="$prefix/landed"
[ -d "$prefix" ] && [ ! -L "$prefix" ] && [ -f "$ledger" ] && [ ! -L "$ledger" ] || exit 0
tab=$(printf "\t")
state() {
  if [ -L "$1" ]; then printf 'link:%s\n' "$(readlink "$1" | sha256sum | cut -c1-64)"
  elif [ -d "$1" ]; then echo dir
  elif [ -f "$1" ]; then sha256sum < "$1" | cut -c1-64
  fi
}
under() {
  case "$1" in "$root/usr/local/"*|"$root/opt/"*) ;; *) return 1 ;; esac
  case "$1" in "$prefix"|"$prefix/"*) return 1 ;; esac
  case "$1/" in */../*|*/./*|*//*) return 1 ;; esac
  d=$(dirname "$1")
  [ "$(cd -P "$d" 2>/dev/null && pwd)" = "$d" ]
}
awk -F"\t" '{ s[substr($0, length($1) + 2)] = $1 } END { for (p in s) print s[p] FS p }' "$ledger" | LC_ALL=C sort -t"$tab" -k2 -r | while IFS="$tab" read -r was p; do
  under "$p" || continue
  if [ "$was" = dir ]; then
    [ -d "$p" ] && [ ! -L "$p" ] && rmdir "$p" 2>/dev/null && printf 'wsp-outside\t%s\n' "$p"
  elif [ -n "$was" ] && [ "$(state "$p")" = "$was" ]; then
    rm -f "$p" && printf 'wsp-outside\t%s\n' "$p"
  fi
done
exit 0
