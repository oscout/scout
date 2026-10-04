# Scout terminal UI

The default `now` view is a calm session list: Working, Requests and Earlier.
It uses the existing Ash and Ember palette, with orange reserved for live
spinners and the focused composer cursor. Earlier is newest first. Narrow
terminals keep the three groups visible, showing the selected (or first)
session in each group; arrow navigation still traverses the whole list.

- `↑↓` / `j k`: move between sessions
- `Enter`: open the selected session's detail stream
- `a` / `i`: focus the composer; `Enter` sends through the existing ask worker
- `/`: edit the session filter; `Enter` or `Esc` leaves filter editing
- `f`: legacy fleet (hero, floor plan and trace); `q`: quota; `Esc`: return to the list
- `?`: help; `Q` / `Ctrl+C`: quit

Other views remain accessible through `--take`, number keys and Tab. No
numbered tabs, hero, floor plan or sparkline are drawn on the first screen.

Titles are the earliest usable user prompt in the retained tail window, not
AI-generated titles. Command/skill/continuation boilerplate is discarded.
If the window contains no usable prompt, the title says `Untitled session`.
The tail feed does not expose session approval policy, so the composer
honestly reports `approval unknown`. Steps are observed tools/reasoning
from the tail, not an invented task plan; the list keeps at most four (two on
compact terminals). The feed's existing recency-based live detection is
unchanged; it is not an authoritative process-lifecycle status.

Animations repaint at about 90ms only when the list has live sessions or the
composer is focused (cursor period 530ms). Otherwise the renderer only
repaints on input or worker changes; there is no unconditional age tick.

```sh
cargo run -p scout-tui --release
cargo test -p scout-tui
cargo clippy -p scout-tui -- -D warnings
```

For an explicit read-only local broker capture, set
`OPENSCOUT_BROKER_INTERNAL_URL=http://127.0.0.1:43110`; the URL takes precedence
above port-only configuration. Do not submit a composer while capturing.
