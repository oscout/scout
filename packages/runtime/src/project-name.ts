import { basename, resolve } from "node:path";
import { homedir } from "node:os";

/**
 * A project is a place, and its name comes from the folder it lives in — with
 * one guard: the folder must not BE you.
 *
 * A session that starts with no cwd boots in `$HOME`, and `basename("/Users/art")`
 * is a username, not a project. That name then travels the whole way down: it
 * becomes the agent's definition id (`art`), its instance id
 * (`art.arts-mac-mini-local`) and its display name ("Art") — and because a
 * direct conversation's title is built from its participants' display names,
 * the thread ends up reading `Art <> openscout-einstein-6`, as if the operator
 * were talking to themselves through a third party. 48 conversations in this
 * control plane carry that today, across two usernames and 34 drifted node ids.
 *
 * Naming the home directory `home` says where the agent is instead of who you
 * are, which is the thing a project name is actually for.
 */
export function projectNameForRoot(projectRoot: string, home = homedir()): string {
  const root = projectRoot.trim();
  if (!root) return "";
  const resolved = resolve(root);
  if (home.trim() && resolved === resolve(home)) return "home";
  /* basename("/") is "" — callers already fall back to "agent" for empty. */
  return basename(resolved);
}
