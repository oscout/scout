import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { AccessPane } from "./AccessPane.tsx";
import "../styles/tokens.css";
createRoot(document.getElementById("root")!).render(<StrictMode><AccessPane /></StrictMode>);
