import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App, applyTheme } from "./App.tsx";
import "./styles.css";

applyTheme();
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
