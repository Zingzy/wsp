# The init screenshot in the README, recorded with vhs (charm.sh/vhs) from a
# fresh state file so the screens start from the first one.
Set Shell zsh
Set FontSize 15
Set Width 1120
Set Height 760
Set Padding 28
Set Theme "Catppuccin Mocha"
Type "wsp init --state /tmp/wsp-demo/state.json --port 4401"
Enter
Sleep 36s
Enter
Sleep 8s
Screenshot docs/screenshots/init.png
Sleep 3s
