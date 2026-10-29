My NAB - a private budgeting app that runs on your own computer
================================================================

Two apps:

  My NAB Server   Starts My NAB in the background. It does not open anything on its own.
                  A small icon appears in the menu bar (top right of the screen) to show it is
                  running. It KEEPS RUNNING when you close your browser, until you click the
                  icon and choose "Quit My NAB Server" (or you log out or shut down).

  Open My NAB     Opens your web browser on My NAB. If the server isn't running yet, it offers to
                  start it for you.

FIRST TIME (macOS blocks apps from unidentified developers)
  1. Drag both apps into your Applications folder (or anywhere you like - keep them together).
  2. Double-click "My NAB Server". macOS will say it can't be opened. Click Done (or OK).
  3. Open System Settings > Privacy & Security, scroll down, and click "Open Anyway" next to
     "My NAB Server". Enter your password if asked, then click Open. (On older macOS versions you
     can instead right-click the app, choose Open, then Open.)
  4. Do the same once for "Open My NAB".
  If macOS says the app is "damaged", open the Terminal app and run this, then try again:
      xattr -dr com.apple.quarantine "/Applications/My NAB Server.app" "/Applications/Open My NAB.app"

TO GET STARTED
  1. Open "My NAB Server" (look for the icon in the menu bar).
  2. Open "Open My NAB". Your browser shows My NAB.
  3. The first screen lists your budgets. A ready-made "Demo Budget" (made-up data) is already
     there; its password is shown next to it:  demo1234
  4. To start your own budget, click "+ New Budget", then "Set Up" and choose a password.
     "Close Budget" (bottom of the left menu) takes you back to the list.

TO STOP IT
  Click the My NAB icon in the menu bar and choose "Quit My NAB Server". Closing the browser
  does not stop it.

YOUR DATA
  Your budgets are saved in  ~/Library/Application Support/My NAB/data  (the menu-bar icon has
  "Open the data folder"). Back that folder up. Updating the apps never touches it.

NOTES
  * Everything stays on your computer. Nothing is sent anywhere, and it can't be reached from
    other computers.
  * Use the "Apple Silicon" download for M1/M2/M3/M4 Macs and the "Intel" one for older Macs.
  * If something goes wrong, look for "My NAB.log" in the data folder's parent
    (~/Library/Application Support/My NAB).
