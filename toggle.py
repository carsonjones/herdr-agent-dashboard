#!/usr/bin/env python3
"""Launch the agents dashboard, or jump to it if it's already running.

The dashboard is a one-of-a-kind tab tagged with a sentinel LABEL. On each press:

  * sentinel tab exists AND its pane is running the dashboard -> just focus it.
  * sentinel tab exists but the process is dead (you pressed `q`)  -> focus it
    and relaunch the dashboard in place, reusing the tab.
  * no sentinel tab                                              -> create one
    and launch the dashboard in it.

So the keybind is an idempotent "show me the dashboard" — never stacks copies.
"""
import json
import os
import subprocess
import sys
from pathlib import Path

BIN = os.environ.get("HERDR_BIN_PATH") or "herdr"

LABEL = "◆ agents"  # sentinel that marks the dashboard's tab
# Self-contained plugin: the dashboard (and its bun deps) live beside this
# script, so node_modules resolves when we launch with cwd = HERE.
HERE = Path(__file__).resolve().parent
SCRIPT = HERE / "herdr-agents.tsx"
LAUNCH = f"bun {SCRIPT}"
RUN_CWD = str(HERE)


def herdr(*args):
    res = subprocess.run([BIN, *args], capture_output=True, text=True)
    if res.returncode != 0:
        sys.exit("herdr %s failed: %s" % (
            " ".join(args), (res.stderr or res.stdout).strip()))
    return res.stdout


def jget(text, *path):
    cur = json.loads(text)
    for k in path:
        cur = cur[k]
    return cur


def find_tab():
    """tab_id of the sentinel-labeled dashboard tab, or None."""
    for t in jget(herdr("tab", "list"), "result", "tabs"):
        if t.get("label") == LABEL:
            return t["tab_id"]
    return None


def pane_of(tab_id):
    """pane_id of the (single) pane in tab_id, or None."""
    for p in jget(herdr("pane", "list"), "result", "panes"):
        if p.get("tab_id") == tab_id:
            return p["pane_id"]
    return None


def dashboard_alive(pane_id):
    info = jget(herdr("pane", "process-info", "--pane", pane_id),
                "result", "process_info")
    return any("herdr-agents.tsx" in (p.get("cmdline") or "")
               for p in info.get("foreground_processes", []))


def launch(pane_id):
    herdr("pane", "run", pane_id, LAUNCH)


def main():
    tab_id = find_tab()
    if tab_id:
        herdr("tab", "focus", tab_id)
        pane_id = pane_of(tab_id)
        if pane_id and not dashboard_alive(pane_id):
            launch(pane_id)  # tab survived a `q` quit — relaunch in place
        return

    out = herdr("tab", "create", "--label", LABEL, "--cwd", RUN_CWD, "--focus")
    launch(jget(out, "result", "root_pane", "pane_id"))


if __name__ == "__main__":
    main()
