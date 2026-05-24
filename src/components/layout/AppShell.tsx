import { motion } from "framer-motion";
import { Outlet, useLocation } from "react-router-dom";
import { Sidebar } from "./Sidebar";
import { TopBar } from "./TopBar";
import { TooltipProvider } from "../ui/Tooltip";
import { Toaster } from "../ui/Toast";

export function AppShell() {
  const { pathname } = useLocation();

  return (
    <TooltipProvider delayDuration={200}>
      <div className="flex h-screen w-screen overflow-hidden bg-bg-base text-text-primary">
        <Sidebar />
        <div className="flex flex-1 flex-col">
          <TopBar />
          <main className="relative flex-1 overflow-y-auto">
            <motion.div
              key={pathname}
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.18, ease: [0.4, 0, 0.2, 1] }}
              className="h-full"
            >
              <Outlet />
            </motion.div>
          </main>
        </div>
      </div>
      <Toaster />
    </TooltipProvider>
  );
}
