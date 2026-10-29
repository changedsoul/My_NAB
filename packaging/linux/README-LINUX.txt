My NAB - a private budgeting app that runs on your own computer
================================================================

Two programs in this folder:

  my-nab-server   Starts My NAB. Run it in a terminal and leave that terminal open:
                      ./my-nab-server
                  It keeps running when you close your browser. Press Ctrl+C (or close the
                  terminal) to stop it. If it was started for you in the background (by
                  open-my-nab), stop it from any terminal with:
                      ./my-nab-server --stop
                  It only listens on 127.0.0.1, so nothing else on your network can reach it.

  open-my-nab     Opens your web browser on My NAB. If the server isn't running, it offers to
                  start it (in the background; stop it later with ./my-nab-server --stop).
                      ./open-my-nab

TO GET STARTED
  1. In a terminal, in this folder:   ./my-nab-server
  2. In your browser go to  http://localhost:8000   (or run ./open-my-nab)
  3. The first screen lists your budgets. A ready-made "Demo Budget" (made-up data) is already
     there; its password is shown next to it:  demo1234
  4. To start your own budget, click "+ New Budget", then "Set Up" and choose a password.
     "Close Budget" (bottom of the left menu) takes you back to the list.

YOUR DATA
  All your budgets are saved in the "data" folder next to these programs. Back it up by copying
  that folder. To update, replace the two programs with the new ones and keep "data".

OPTIONAL: ./install-launchers.sh   adds both programs to your applications menu.

NOTES
  * If it won't start, make sure the files are executable:  chmod +x my-nab-server open-my-nab
  * Built on Ubuntu 22.04; it needs a reasonably recent Linux (glibc 2.35 or newer).
  * For an always-on server (a NAS, a home server), use the Docker setup in the project's README.
