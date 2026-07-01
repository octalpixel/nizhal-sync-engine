import React from "react";
import ReactDOM from "react-dom/client";
import { AppCF } from "./App.CF.js";
import { AppRealtime } from "./App.Realtime.js";
import { App } from "./App.js";
import "./styles.css";

const root = document.getElementById("root");
if (!root) throw new Error("Tabkeep root element is missing");

// Route selects the realtime transport (all three share one UI):
//   /          → usual local-first ledger (realtime via the Node server when it's running)
//   /realtime  → explicit Node realtime / multi-device demo
//   /cf        → realtime via a Cloudflare Durable Object
const path = window.location.pathname.replace(/\/+$/, "");
const Demo = path === "/cf" ? AppCF : path === "/realtime" ? AppRealtime : App;

ReactDOM.createRoot(root).render(
  <React.StrictMode>
    <Demo />
  </React.StrictMode>,
);
