import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import {
  applyScheme,
  applyTheme,
  readStoredScheme,
  readStoredTheme,
} from "./lib/theme";
import "./styles/globals.css";

// Runs before the first paint so the window never flashes the wrong palette.
applyTheme(readStoredTheme());
applyScheme(readStoredScheme());

ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
