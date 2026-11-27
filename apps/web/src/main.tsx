import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import { router } from "./router";
import { ApiError } from "./api";
import { applyTheme } from "./theme";
import "./styles.css";

applyTheme();
const qc = new QueryClient({
  defaultOptions: {
    queries: {
      retry: (n, e) => !(e instanceof ApiError && e.status < 500) && n < 2,
      refetchOnWindowFocus: true,
    },
  },
});
createRoot(document.getElementById("root")!).render(
  <StrictMode><QueryClientProvider client={qc}><RouterProvider router={router} /></QueryClientProvider></StrictMode>,
);
