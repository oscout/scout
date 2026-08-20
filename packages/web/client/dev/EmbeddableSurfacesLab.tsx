import { useEffect, useState } from "react";
import { listEmbeddableSurfaceSummaries } from "../surfaces/discover.ts";

type SurfaceSummary = Awaited<ReturnType<typeof listEmbeddableSurfaceSummaries>>[number];

export function EmbeddableSurfacesLab() {
  const [surfaces, setSurfaces] = useState<SurfaceSummary[]>([]);

  useEffect(() => {
    let cancelled = false;
    void listEmbeddableSurfaceSummaries().then((nextSurfaces) => {
      if (!cancelled) setSurfaces(nextSurfaces);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="s-embeddable-surfaces-lab" data-scout-theme>
      <header className="s-embeddable-surfaces-lab__header">
        <h1>Embeddable surfaces</h1>
        <p>
          Screens that exported <code>scoutSurface.embed</code> and were discovered from
          {" "}
          <code>client/screens/**</code>
          . No separate embed registry file — parity comes from the screen declaration.
        </p>
      </header>

      <table className="s-embeddable-surfaces-lab__table">
        <thead>
          <tr>
            <th>ID</th>
            <th>Label</th>
            <th>Web</th>
            <th>Embed</th>
            <th>Profile</th>
            <th>Module</th>
          </tr>
        </thead>
        <tbody>
          {surfaces.map((surface) => (
            <tr key={surface.id}>
              <td><code>{surface.id}</code></td>
              <td>{surface.label}</td>
              <td>
                <a href={surface.webPath}>{surface.webPath}</a>
              </td>
              <td>
                <div>
                  <a href={surface.embedPath}>{surface.embedPath}</a>
                </div>
                {surface.embedAliases.length > 0 && (
                  <div className="s-embeddable-surfaces-lab__aliases">
                    {surface.embedAliases.map((alias) => (
                      <a key={alias} href={alias}>{alias}</a>
                    ))}
                  </div>
                )}
              </td>
              <td><code>{surface.profile}</code></td>
              <td><code>{surface.modulePath.replace("../", "")}</code></td>
            </tr>
          ))}
        </tbody>
      </table>

      {surfaces.length === 0 && (
        <p className="s-embeddable-surfaces-lab__empty">No embeddable screens discovered yet.</p>
      )}
    </div>
  );
}
