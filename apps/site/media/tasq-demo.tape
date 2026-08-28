# Rebuild from the repository root with:
#   vhs apps/site/media/tasq-demo.tape

Output apps/site/public/tasq-demo.gif

Require npx

Set Shell "bash"
Set FontSize 18
Set Width 640
Set Height 520
Set Padding 18
Set Framerate 30
Set TypingSpeed 20ms
Set Theme "Catppuccin Mocha"
Set WindowBar Rings

Type "npx --yes @tasq-run/cli@0.6.0 demo"
Sleep 400ms
Enter
Sleep 6s
