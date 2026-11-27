import { useEffect, useState } from "react";
type Mode = "light" | "dark" | "system";
function read(): Mode { try { return (localStorage.getItem("theme") as Mode) || "system"; } catch { return "system"; } }
export function applyTheme(m: Mode = read()) {
  const dark = m === "dark" || (m === "system" && matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.classList.toggle("dark", dark);
}
export function useTheme() {
  const [mode, setMode] = useState<Mode>(read);
  useEffect(() => { try { localStorage.setItem("theme", mode); } catch { /* ignore */ } applyTheme(mode); }, [mode]);
  return [mode, setMode] as const;
}
