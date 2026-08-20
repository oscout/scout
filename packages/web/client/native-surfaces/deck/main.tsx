import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ScoutDeckSurface } from "./ScoutDeckSurface.tsx";

const root = document.getElementById("root");
if (!root) throw new Error("missing #root");

createRoot(root).render(
  <StrictMode>
    <ScoutDeckSurface />
  </StrictMode>,
);
