import { useScout } from "../Provider.tsx";
import { resolveContentPane } from "../../screens/resolve-panes.tsx";
import { ScoutSurface } from "./ScoutSurface.tsx";

export function ScoutContent() {
  const { route, navigate, agents } = useScout();
  return (
    <ScoutSurface>
      {resolveContentPane(route, navigate, agents)}
    </ScoutSurface>
  );
}