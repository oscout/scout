/**
 * Repos inspector — the worktree CONTEXT panel, hosted in the app's global
 * right rail (driven by `ScoutInspector`'s `case "repos"`). The panel itself is
 * `RepoWatchContext`; ReposScreen owns the scan and publishes the current
 * selection through the selection bridge, so this rail just renders it.
 *
 * The panel's palette + fonts resolve from a `.rw-scope` ancestor, so we wrap it
 * in one carrying the live tone. The `--rail` modifier drops the standalone
 * card chrome (border/radius/viewport max-height) so the panel fills the rail
 * flush — the SidePanel already provides the surrounding chrome.
 */

import RepoWatchContext from "../../scout/repo-watch/RepoWatchContext.tsx";
import { useRepoWatchSelection } from "../../scout/repo-watch/selection-bridge.ts";
import "../../scout/repo-watch/console.css";

export function ReposInspector() {
  const { worktree, project, generatedAt, tone } = useRepoWatchSelection();
  return (
    <div className={"rw-scope rw-ctx-rail-scope tone-" + tone}>
      <RepoWatchContext
        worktree={worktree}
        project={project}
        generatedAt={generatedAt}
      />
    </div>
  );
}

export default ReposInspector;
