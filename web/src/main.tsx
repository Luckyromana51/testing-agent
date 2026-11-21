import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App, applyTheme } from "./App.tsx";
// Fonts ship with the app (no outside font service): IBM Plex Sans for reading, Plex Mono for readings.
import "@fontsource/ibm-plex-sans/latin-400.css";
import "@fontsource/ibm-plex-sans/latin-500.css";
import "@fontsource/ibm-plex-sans/latin-600.css";
import "@fontsource/ibm-plex-mono/latin-400.css";
import "@fontsource/ibm-plex-mono/latin-500.css";
import "@fontsource/ibm-plex-mono/latin-600.css";
import "./styles.css";

applyTheme();
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
