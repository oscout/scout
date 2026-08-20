// ─────────────────────────────────────────────────────────────────────────
// design-sync synthetic entry — NOT used by the app.
//
// Re-exports the scoped agents-view components into a single module that the
// claude.ai/design converter bundles into window.ScoutWeb.*. The global CSS
// imports below make esbuild inline the hudsonkit base + theme aliases +
// token scales into _ds_bundle.css (the styles.css closure designs receive).
// See .design-sync/config.json and .design-sync/NOTES.md.
// ─────────────────────────────────────────────────────────────────────────

// Global app stylesheets (the app loads these from main.tsx, not per-component).
import "../app.css"; // @hudsonkit/styles base + [data-scout-theme] aliases + font tokens
import "../styles/tokens.css"; // theme-independent spacing/radius/type scales
import "./fonts.css"; // remote brand fonts (index.html loads these via <link>)

// Provider wrapper for previews (cfg.provider) — lightweight: real dark theme
// vars + a mock ScoutContext + ContextMenuProvider, with NO app chrome (no
// fixed settings-drawer), so cards stay inside the design tool's grid cells.
export { DesignProvider } from "./design-provider.tsx";

// ── Scoped agents-view components ──────────────────────────────────────────
// Identity atoms (pure):
export { SpriteAvatar } from "../components/SpriteAvatar.tsx";
export { AgentAvatar } from "../components/AgentAvatar.tsx";
export { HarnessMark } from "../components/HarnessMark.tsx";
export { AgentsSubnav } from "../screens/agents/AgentsSubnav.tsx";

// Classic message input (pure, prop-driven):
export { MessageComposer } from "../components/MessageComposer/index.ts";


// Directory hero (context-coupled) — renders the agents directory from
// fixture props inside ScoutProvider (cfg.provider supplies its context):
export { AgentsLibrary } from "../screens/agents/library.tsx";

// Operations console (pure, prop-driven) — the three-pane agent browser:
// agent tree · facet reading pane · facts rail. Real-data port of the
// "agents directory" design canvas (see AgentsConsole.tsx).
export { AgentsConsole } from "../screens/agents/AgentsConsole.tsx";
