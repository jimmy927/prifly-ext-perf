# Performance for prifly

Is this machine out of CPU, memory or disk, and what is using it? This
extension answers that in green, orange and red, for WSL and for the Windows
around it. A second tab answers the same question for prifly itself: how many
processes it runs, for which sessions, and how many MCP servers those sessions
started.

It adds one item to prifly's status bar: a **Performance** button whose icon
is green, orange or red for the worst of CPU, memory and disk over the last
10 s. Hover it for what is short ("Out of CPU in WSL") and each resource's
colour; click it for the window below, over nearly the whole of prifly. The
window's ↗ button opens it in a window of its own. (A prifly from before
2026-10-01 shows the colour as a separate chip beside the button.)

![The Machine tab, light](screenshots/machine-light.png)

## Every second, or every five minutes

The window has a control for the period it averages over: 1 s, 2 s, 5 s, 10 s,
30 s, 1 min or 5 min (2 s to begin with, and it remembers your choice). It
repaints every second whatever the period, each time with the average of the
trailing period, and says so: *Average of the trailing 30 s, updated every
second*. So the numbers move every second but hold still: two repaints of a
30 s period share 29 of their seconds, and a 2 s spike counts for a fifteenth.
Before a period has filled it averages what there is and says so (*Average of
the last 8 s*).

- **Rates are exact.** CPU (per process, session and kind, and in total),
  disk read and write, and Linux's busy share are the change of a cumulative
  counter between the window's start and its end, over the time between. A
  process born mid-window counts what it used since its first sample, spread
  over the whole window; one that ended inside it is gone from the table.
- **Levels are means.** Available memory, the run queue, swap, load, the
  pressure figures (the kernel's own 10 s averages, averaged again) and
  Windows' counters are the mean of the one-second samples in the window.
- **Colours and the headline** are judged from the averaged numbers.
- **Sparklines** have one point per window: the last 60 that fit in the last
  hour.
- The status-bar colour always judges the last 10 s, with the window open or not.
  The busiest Windows processes are read every 10 s whatever the window.

## Machine

The headline names whatever is short or out, worst first. Under it, WSL and
Windows each get four rows, each with a colour, the reading, what it means,
and a sparkline of the averages:

| | WSL | Windows |
|---|---|---|
| **CPU** | tasks ready to run against cores, and how long they waited for one | % busy, the processor queue, and the WSL VM's share of the machine |
| **Memory** | available of total, time stalled waiting for memory, swap | available, committed, and the total |
| **Disk** | read and write rates, time stalled waiting for disk | % busy, time per request, rates, queue |
| last row | load average, uncoloured | writes to the page file, uncoloured |

**What uses the CPU now** lists the busiest processes on both sides. A WSL
process that belongs to a prifly session is named with that session.

![The Machine tab, dark](screenshots/machine-dark.png)

### When it turns orange or red

| | Orange | Red |
|---|---|---|
| WSL CPU: tasks waiting for a core (PSI `cpu some avg10`) | 10 % of the time | 40 % |
| WSL memory: every task stalled on memory (PSI `memory full avg10`) | 0.5 % | 5 % |
| WSL memory: available | under 20 % | under 10 % |
| WSL disk: every task stalled on disk (PSI `io full avg10`) | 5 % | 20 % |
| Windows CPU: processor queue per core | 1 | 2 |
| Windows memory: committed | 90 % | 97 % |
| Windows memory: writes to the page file | 1 MB/s | 10 MB/s |
| Windows memory: available | under 10 % or 2 GB | under 5 % or 1 GB |
| Windows disk: time per read or write | 15 ms | 25 ms |

On Linux the colours come from [pressure stall
information](https://docs.kernel.org/accounting/psi.html), not from how busy
something is. PSI measures how long tasks actually waited, which is what makes
a machine feel slow. Load average is shown without a colour because Linux also
counts tasks waiting on disk in it. Without PSI, a run queue of more than twice
the cores stands in for CPU.

Windows memory is judged mainly by commit charge (can Windows still hand
memory out?) and by writes to the page file (is it pushing memory out to make
room?). Low available memory counts only when it is truly low. The WSL VM
keeps its own file cache, which Windows counts as used, so 18 % available with
70 % committed and no paging is a calm machine.

For CPU and disk, the Windows thresholds are the usual Performance Monitor
guidance. One
rule from that guidance is left out on purpose: "`Pages Input/sec` under 15"
dates from spinning disks. An NVMe laptop reads thousands a second with
nothing wrong (4,195 measured on the machine this was written on).

## prifly

![The prifly tab](screenshots/prifly-light.png)

- **Tiles**: processes, sessions working and idle (plus cloud sessions active
  this hour), MCP server copies, memory, and CPU and disk.
- **By kind**: stacked bars for memory, CPU and processes, split into each
  session's `claude`, MCP servers, the tools turns run (shells, tests,
  builds), the host with its helpers, and the relays that keep sessions alive
  through a host restart. The memory and CPU bars span the whole of WSL, so
  other programs (striped) and what is free (the empty track) show beside
  prifly's share.
- **MCP servers**: each server, how many copies run, and what they cost. A
  stdio server (configured as a `command`) runs once per session, so 25
  sessions means 25 copies. An HTTP server (a `url`) runs once for all of them
  and costs nothing here. The tile turns orange when one server runs more than
  one copy.
- **By session**: each session's processes, CPU, memory, disk, MCP servers
  and the busiest program its turn is running now, grouped into working,
  waiting for you, idle at their prompt, and other.

Cloud sessions run on Anthropic's machines and their MCP servers run in that
sandbox, so they add no processes here. They are only counted.

## Where the numbers come from

- **WSL**: `/proc/pressure/{cpu,memory,io}`, `/proc/stat`, `/proc/meminfo`,
  `/proc/vmstat` and `/proc/loadavg`, every second, the last hour kept. This is the WSL VM's single
  kernel, so Docker Desktop's containers count in these totals. They run in a
  distro of their own, though, so they never appear in the process list.
- **Windows**: one `typeperf.exe` that stays running and prints its counters
  every second, the last hour kept; if it ends, it is started again. A PowerShell call reads the
  machine's name, cores and memory once.
- **Processes**: `/proc/<pid>/stat`, `cmdline` and `io`, every second, only
  while the window is open (it asks every second; 10 s without, and it counts as closed), the last five
  minutes kept. The extension runs inside the host, so the host is its own
  process. Relays outlive the host, so after a restart they belong to init
  and are found by their command line instead.
- **MCP servers**: matched against the `mcpServers` in `~/.claude.json` (user
  scope, and per folder under `projects`) and the nearest `.mcp.json`, by the
  package or script each one runs. `npx -y @playwright/mcp` runs as `npm exec
  @playwright/mcp`, so the launcher alone tells nothing. A process that looks
  like an MCP server but is in no config read here shows as *unlisted*.
- **Windows' busiest processes** (PowerShell, every 10 s) and **cloud
  sessions** (prifly's accounts, every 5 min) are read only while the window
  is open.

Outside WSL there is no Windows to read: the window shows Linux alone.

## Install

In prifly: Extensions → install from `https://github.com/jimmy927/prifly-ext-perf`, or link a
checkout into `~/.local/share/prifly/extensions/` and restart prifly, then enable it.

## Develop

```sh
bun install
bun test
bun run typecheck
bun run check
```
