import React from "react";
import ReactDOM from "react-dom/client";

import "./ui/styles/global.css";
import { applyPlatformAttributes } from "./ui/platform";
import MiniPlayer from "./ui/components/mini-player/MiniPlayer";

applyPlatformAttributes();

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <MiniPlayer />
  </React.StrictMode>,
);