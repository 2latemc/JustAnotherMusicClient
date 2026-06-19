import React from "react";
import ReactDOM from "react-dom/client";
import App from "./ui/App";
import "./ui/styles/global.css";
import { logInternalError, logInternalInfo } from "./internal/logging";
import { applyPaperPcMode, hydratePaperPcMode } from "./ui/settings/paperPcMode";
import {
  applyNativeWindowControls,
  hydrateWindowControlSettings,
} from "./ui/settings/windowControls";
import { hydrateMiniPlayerSettings } from "./ui/settings/miniPlayer";
import { hydratePlayerControlSettings } from "./ui/settings/playerControls";
import { applyPlatformAttributes } from "./ui/platform";
import { DiscordRpcService } from "./player/DiscordRPC";

logInternalInfo("main.bootstrap start");
applyPlatformAttributes();
applyPaperPcMode();
void applyNativeWindowControls();
void Promise.all([
  hydratePaperPcMode(),
  hydrateWindowControlSettings(),
  hydrateMiniPlayerSettings(),
  hydratePlayerControlSettings(),
]).catch((error) => {
  logInternalError("settings hydration failed", error);
});

// Initialize Discord RPC (non-blocking)
logInternalInfo("[Discord RPC] Initializing Discord RPC service");
try {
  void DiscordRpcService.init().catch((error) => {
    logInternalError("[Discord RPC] initialization error", error);
  });
} catch (error) {
  logInternalError("[Discord RPC] failed to initialize", error);
}

window.addEventListener("error", (event) => {
  logInternalError("window.error", event.error ?? event.message, {
    filename: event.filename,
    lineno: event.lineno,
    colno: event.colno,
  });
});

window.addEventListener("unhandledrejection", (event) => {
  logInternalError("window.unhandledrejection", event.reason);
});

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
