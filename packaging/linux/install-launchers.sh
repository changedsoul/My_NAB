#!/bin/sh
# Adds "My NAB Server", "Open My NAB" and "Stop My NAB Server" to your applications menu (the programs stay where they are).
# Undo it by deleting the three files this creates in ~/.local/share/applications.
set -e
here="$(cd "$(dirname "$0")" && pwd)"
dest="${XDG_DATA_HOME:-$HOME/.local/share}/applications"
mkdir -p "$dest"
cat > "$dest/my-nab-server.desktop" <<EOT
[Desktop Entry]
Type=Application
Name=My NAB Server
Comment=Start My NAB in the background (stays running until you stop it)
Exec=$here/my-nab-server
Terminal=true
Categories=Office;Finance;
EOT
cat > "$dest/open-my-nab.desktop" <<EOT
[Desktop Entry]
Type=Application
Name=Open My NAB
Comment=Open My NAB in your web browser
Exec=$here/open-my-nab
Terminal=false
Categories=Office;Finance;
EOT
cat > "$dest/stop-my-nab.desktop" <<EOT
[Desktop Entry]
Type=Application
Name=Stop My NAB Server
Comment=Stop My NAB if it is running in the background
Exec=$here/my-nab-server --stop
Terminal=false
Categories=Office;Finance;
EOT
echo "Done. Look for \"My NAB Server\", \"Open My NAB\" and \"Stop My NAB Server\" in your applications menu."
