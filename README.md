# herdr agents dashboard

simple, real-time dashboard showing `herdr` agents
plus+ a herdr plugin to view


<video src="https://pub-8ba3b6abfd76456798637811981eea3f.r2.dev/2026-06-30-demo-4x.mp4" controls width="600"></video>

## Install
```sh
# clone, then:
herdr plugin link [dir]
herdr server reload-config
```

Then bind the action in `~/.config/herdr/config.toml`:

```toml
[[keys.command]]
key = "prefix+a"
type = "plugin_action"
command = "local.agents.toggle"
description = "agents: launch / jump to the dashboard"
```

> Linking is machine-local (recorded in `~/.config/herdr/plugins.json`), so
> re-run `herdr plugin link` when setting up a new machine.


## Run directly

```sh
bun herdr-agents.tsx [--interval 2000]   # ms between polls
#alias agents="bun run ~/[dir]/herdr-agents.tsx
```

