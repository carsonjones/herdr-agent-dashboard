#!/usr/bin/env bun
/** @jsxImportSource @opentui/react */
//
// herdr-agents.tsx — live TUI table of running herdr agents.
//
// Diff-rendered (no flash): the screen is a persistent React tree; each poll only
// repaints the cells whose data actually changed. The table reflows to the terminal
// frame — the TASK column grows/shrinks to fill the remaining width.
//
// Keys:  ↑/k ↓/j move · enter = focus that agent · r = refresh now · q / ctrl-c = quit
//
// Usage:  bun scripts/herdr-agents.tsx [--interval 2000]   (ms between polls)

import { createCliRenderer } from "@opentui/core";
import {
  createRoot,
  useKeyboard,
  useRenderer,
  useTerminalDimensions,
} from "@opentui/react";
import { useEffect, useRef, useState } from "react";

// ── data ────────────────────────────────────────────────────────────────────

type Agent = {
  agent: string;
  agent_status: "working" | "idle" | "blocked" | "unknown" | string;
  cwd: string;
  focused: boolean;
  tab_id?: string;
  pane_id?: string;
  agent_session?: { value?: string };
  task?: string; // the agent's latest user prompt (from its Claude Code transcript)
};

const HOME = process.env.HOME ?? "";
const short = (p: string) => (HOME && p.startsWith(HOME) ? "~" + p.slice(HOME.length) : p);
const seg = (id?: string) => (id ? (id.split(":")[1] ?? id) : "-");

const STATUS_RANK: Record<string, number> = { working: 0, blocked: 1, idle: 2, unknown: 3 };
const STATUS_FG: Record<string, string> = {
  working: "#3fb950", // green
  idle: "#8b949e", // gray
  blocked: "#f85149", // red
  unknown: "#d29922", // yellow
};

// selection highlight — band tinted by the selected agent's status, dark ink
const SEL_FG = "#272B35";
const SEL_BG: Record<string, string> = {
  working: "#3fb950", // green
  idle: "#8b949e", // gray
  blocked: "#f85149", // red
  unknown: "#d29922", // yellow
};
const SEL_BG_DEFAULT = "#61AFF0"; // fallback soft blue
const HEADER_FG = "#6e7681";
const NORMAL_FG = "#c9d1d9";

async function run(args: string[]): Promise<string> {
  const proc = Bun.spawn(["herdr", ...args], { stdout: "pipe", stderr: "ignore" });
  const text = await new Response(proc.stdout).text();
  await proc.exited;
  return text;
}

// Resolve a Claude Code session UUID to its transcript file (cached after first hit).
// The OSC terminal title is set once and goes stale, so we read the real transcript.
const PROJECTS = `${HOME}/.claude/projects`;
const txCache = new Map<string, string>();
async function resolveTranscript(sessionId: string, cwd: string): Promise<string> {
  const cached = txCache.get(sessionId);
  if (cached) return cached;
  const direct = `${PROJECTS}/${cwd.replace(/[^a-zA-Z0-9]/g, "-")}/${sessionId}.jsonl`;
  if (await Bun.file(direct).exists()) {
    txCache.set(sessionId, direct);
    return direct;
  }
  const glob = new Bun.Glob(`*/${sessionId}.jsonl`); // fallback: find by id anywhere
  for await (const m of glob.scan({ cwd: PROJECTS, absolute: true })) {
    txCache.set(sessionId, m);
    return m;
  }
  return "";
}

const SKIP = /^<|local-command-|command-name|command-message|system-reminder|^Caveat:/;

// Latest *human* prompt: scan the transcript tail backwards, skipping tool-results,
// meta/sidechain entries, and Claude Code's injected command/reminder wrappers.
async function latestPrompt(sessionId: string, cwd: string): Promise<string> {
  try {
    const path = await resolveTranscript(sessionId, cwd);
    if (!path) return "";
    const file = Bun.file(path);
    const size = file.size;
    const TAIL = 256 * 1024;
    const buf = await file.slice(Math.max(0, size - TAIL)).text();
    const lines = buf.split("\n");
    if (size > TAIL) lines.shift(); // drop the partial first line
    for (let i = lines.length - 1; i >= 0; i--) {
      const ln = lines[i].trim();
      if (!ln) continue;
      let ev: any;
      try {
        ev = JSON.parse(ln);
      } catch {
        continue;
      }
      if (ev?.type !== "user" || ev?.isSidechain || ev?.isMeta) continue;
      const c = ev?.message?.content;
      let text =
        typeof c === "string"
          ? c
          : Array.isArray(c)
            ? c.filter((b) => b?.type === "text").map((b) => b.text).join(" ")
            : "";
      text = text.replace(/\s+/g, " ").trim();
      if (text && !SKIP.test(text)) return text;
    }
    return "";
  } catch {
    return "";
  }
}

async function fetchAgents(): Promise<Agent[]> {
  const j = JSON.parse(await run(["agent", "list"]));
  const agents: Agent[] = j?.result?.agents ?? [];
  await Promise.all(
    agents.map(async (a) => {
      const id = a.agent_session?.value;
      if (id) a.task = await latestPrompt(id, a.cwd);
    }),
  );
  return agents.sort(
    (a, b) => (STATUS_RANK[a.agent_status] ?? 9) - (STATUS_RANK[b.agent_status] ?? 9),
  );
}

function focusAgent(target: string) {
  Bun.spawn(["herdr", "agent", "focus", target], { stdout: "ignore", stderr: "ignore" });
}

// ── layout ──────────────────────────────────────────────────────────────────

type Col = { header: string; width?: number; grow?: boolean };
// TASK grows to fill; everything else is a fixed width. One space gap between cells.
const COLS: Col[] = [
  { header: "STATUS", width: 7 },
  { header: "AGENT", width: 7 },
  { header: "LATEST PROMPT", grow: true },
  { header: "CWD", width: 22 },
  { header: "TAB", width: 4 },
  { header: "PANE", width: 5 },
  { header: "", width: 1 }, // focus marker
];
const GAP = 1;
const FIXED_W = COLS.filter((c) => !c.grow).reduce((n, c) => n + (c.width ?? 0) + GAP, 0);

const trunc = (s: string, w: number) => (w > 0 && s.length > w ? s.slice(0, w - 1) + "…" : s);
const pad = (s: string, w: number) => trunc(s, w).padEnd(w);

function Row({
  cells,
  taskW,
  fg,
  bg,
  statusFg,
}: {
  cells: string[];
  taskW: number;
  fg: string;
  bg?: string;
  statusFg?: string;
}) {
  return (
    <box style={{ flexDirection: "row", width: "100%", backgroundColor: bg }}>
      {COLS.map((col, i) => {
        const w = col.grow ? taskW : col.width ?? 0;
        return (
          <text key={i} style={{ width: w, marginRight: GAP }} bg={bg} fg={i === 0 ? statusFg ?? fg : fg}>
            {pad(cells[i] ?? "", w)}
          </text>
        );
      })}
    </box>
  );
}

// ── app ─────────────────────────────────────────────────────────────────────

function App({ interval }: { interval: number }) {
  const renderer = useRenderer();
  const { width, height } = useTerminalDimensions();
  const [agents, setAgents] = useState<Agent[]>([]);
  const [sel, setSel] = useState(-1); // -1 = nothing selected (watch indicators cleanly)
  const [tick, setTick] = useState(0);
  const [lastPoll, setLastPoll] = useState("—");
  const [error, setError] = useState<string | null>(null);
  const selRef = useRef(sel);
  selRef.current = sel;

  const taskW = Math.max(10, width - 2 /*padding*/ - FIXED_W - GAP);

  useEffect(() => {
    let alive = true;
    const poll = async () => {
      try {
        const next = await fetchAgents();
        if (!alive) return;
        setAgents(next);
        setError(null);
        const d = new Date();
        const p = (n: number) => String(n).padStart(2, "0");
        setLastPoll(`${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`);
      } catch (e: any) {
        if (alive) setError(e?.message ?? String(e));
      }
    };
    poll();
    const h = setInterval(poll, interval);
    return () => {
      alive = false;
      clearInterval(h);
    };
  }, [interval, tick]);

  useEffect(() => {
    if (sel > agents.length - 1) setSel(Math.max(0, agents.length - 1));
  }, [agents.length, sel]);

  const quit = () => {
    renderer.destroy();
    process.exit(0);
  };

  useKeyboard((key) => {
    const n = agents.length;
    // movement cycles through a ring of n+1 slots: none(-1) → 0 … n-1 → none
    const move = (dir: 1 | -1) =>
      setSel((s) => {
        if (n === 0) return -1;
        if (dir === 1) return s === -1 ? 0 : s === n - 1 ? -1 : s + 1;
        return s === -1 ? n - 1 : s === 0 ? -1 : s - 1;
      });
    switch (key.name) {
      case "q":
        return quit();
      case "c":
        if (key.ctrl) return quit();
        break;
      case "escape":
        setSel(-1);
        break;
      case "up":
      case "k":
        move(-1);
        break;
      case "down":
      case "j":
        move(1);
        break;
      case "r":
        setTick((t) => t + 1);
        break;
      case "return": {
        const a = selRef.current >= 0 ? agents[selRef.current] : undefined;
        if (a?.pane_id) focusAgent(a.pane_id);
        break;
      }
    }
  });

  const counts = agents.reduce<Record<string, number>>((m, a) => {
    m[a.agent_status] = (m[a.agent_status] ?? 0) + 1;
    return m;
  }, {});
  const summary =
    Object.entries(counts)
      .map(([k, v]) => `${v} ${k}`)
      .join("  ·  ") || "no agents";

  return (
    <box style={{ width, height, flexDirection: "column", paddingLeft: 1, paddingRight: 1 }}>
      <Row cells={COLS.map((c) => c.header)} taskW={taskW} fg={HEADER_FG} />
      <box style={{ flexDirection: "column", flexGrow: 1 }}>
        {agents.length === 0 && !error ? (
          <text fg={HEADER_FG}>(no agents running)</text>
        ) : (
          agents.map((a, i) => {
            const selected = i === sel;
            const selBg = SEL_BG[a.agent_status] ?? SEL_BG_DEFAULT;
            return (
              <Row
                key={a.pane_id ?? i}
                taskW={taskW}
                bg={selected ? selBg : undefined}
                fg={selected ? SEL_FG : NORMAL_FG}
                statusFg={selected ? SEL_FG : STATUS_FG[a.agent_status] ?? NORMAL_FG}
                cells={[
                  a.agent_status,
                  a.agent,
                  a.task || "—",
                  short(a.cwd),
                  seg(a.tab_id),
                  seg(a.pane_id),
                  a.focused ? "←" : "",
                ]}
              />
            );
          })
        )}
      </box>
      {error ? (
        <text fg="#f85149">! {error}</text>
      ) : (
        <text fg={HEADER_FG}>{summary}   ·   updated {lastPoll}</text>
      )}
      <text fg={HEADER_FG}>↑/↓ move · enter focus · esc clear · r refresh · q quit</text>
    </box>
  );
}

// ── boot ────────────────────────────────────────────────────────────────────

const intervalArg = process.argv.indexOf("--interval");
const interval = intervalArg >= 0 ? Number(process.argv[intervalArg + 1]) || 2000 : 2000;

const renderer = await createCliRenderer({ exitOnCtrlC: true, clearOnShutdown: true });
createRoot(renderer).render(<App interval={interval} />);
