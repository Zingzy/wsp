# Run from an empty scratch folder with vhs 0.11: vhs screens.tape, then vhs build.tape.
# Screens one to five stop with Ctrl-C on screen five, so nothing is installed here; build.tape
# stops on the confirm, so nothing boots. Crop the bottoms and copy into assets/init.
Output screens.gif
Set Shell zsh
Set FontFamily "Menlo"
Set FontSize 30
Set Width 2240
Set Height 1520
Set Padding 56
Set Theme { "name": "wsp", "background": "#0b0c10", "foreground": "#f5f6f8", "cursor": "#8fc9f5", "selection": "#1f2430", "black": "#0b0c10", "red": "#f07a7a", "green": "#62d99a", "yellow": "#e8c46a", "blue": "#8fc9f5", "magenta": "#c9a7f5", "cyan": "#8fe3e8", "white": "#c9ced8", "brightBlack": "#6b7280", "brightRed": "#f59a9a", "brightGreen": "#8fe8b6", "brightYellow": "#f2d68a", "brightBlue": "#b3dcf9", "brightMagenta": "#dcc6f9", "brightCyan": "#b0eef1", "brightWhite": "#f5f6f8" }
Hide
Type `wsp() { command wsp "$@" --state /tmp/wsp-shots/state.json --port 4401 --ws-port 4411; }`
Enter
Type "clear"
Enter
Sleep 500ms
Show
Type "wsp init"
Enter
Wait+Screen@240s /Which project are you bringing first/
Sleep 1s
Screenshot project.png
Enter
Wait+Screen@60s /Which coding agents go on your machine image/
Sleep 1s
Screenshot agents.png
Enter
Wait+Screen@60s /What installs on the image, from what you use/
Sleep 1s
Screenshot tools.png
Enter
Wait+Screen@60s /We found these installed on this Mac/
Sleep 1s
Screenshot also.png
Enter
Wait+Screen@60s /Each row is something the machine needs to be signed in to/
Sleep 1s
Screenshot signins.png
Enter
Wait+Screen@60s /MCP server and skill to the agents installed here/
Sleep 1s
Screenshot wsp.png
Ctrl+C
Sleep 2s
