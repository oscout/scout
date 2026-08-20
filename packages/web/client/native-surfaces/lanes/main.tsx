import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { NativeSurfaceApp } from "../shared/NativeSurfaceApp.tsx";
import { NativeAgentLanes } from "./NativeAgentLanes.tsx";

const root = document.getElementById("root");
if (!root) throw new Error("missing #root");

createRoot(root).render(
  <StrictMode>
    <NativeSurfaceApp
      surface="lanes"
      title="Lanes"
      renderContent={({ bootstrap, client }) => (
        <NativeAgentLanes bootstrap={bootstrap} client={client} />
      )}
    />
  </StrictMode>,
);
