import { NavLink } from "react-router-dom";
import {
  Home,
  Layers,
  AppWindow,
  BookText,
  History,
  Settings,
  CircleUser,
  Search,
  Mic,
} from "lucide-react";
import { Input } from "../ui/Input";
import { Kbd } from "../ui/Kbd";
import { cn } from "../../lib/utils";
import { useAuth } from "../../lib/store/useAuth";
import { useProfile } from "../../lib/store/useProfile";

const navItems = [
  { to: "/", label: "Home", icon: Home, end: true },
  { to: "/modes", label: "Modes", icon: Layers },
  { to: "/apps", label: "Apps", icon: AppWindow },
  { to: "/vocabulary", label: "Vocabulary", icon: BookText },
  { to: "/history", label: "History", icon: History },
  { to: "/settings", label: "Settings", icon: Settings },
  { to: "/account", label: "Account", icon: CircleUser },
];

export function Sidebar() {
  const user = useAuth((s) => s.user);
  const profile = useProfile((s) => s.profile);
  const name = profile?.display_name || user?.email?.split("@")[0] || "Signed in";
  const sub = user?.email ?? "—";
  return (
    <aside className="flex h-full w-60 shrink-0 flex-col gap-4 border-r border-border-subtle bg-bg-base/60 px-3 py-4 backdrop-blur-xl">
      {/* Logo */}
      <div className="flex items-center gap-2 px-2 py-1">
        <div className="flex h-7 w-7 items-center justify-center rounded-md bg-gradient-to-br from-accent-start to-accent-end shadow-glow">
          <Mic className="h-3.5 w-3.5 text-white" strokeWidth={2.5} />
        </div>
        <span className="text-sm font-semibold tracking-tight">SuperWisper</span>
      </div>

      {/* Search */}
      <div className="relative px-1">
        <Search className="pointer-events-none absolute left-3.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-text-muted" />
        <Input placeholder="Search…" className="h-8 pl-8 pr-12 text-xs" />
        <div className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2">
          <Kbd>⌘K</Kbd>
        </div>
      </div>

      {/* Nav */}
      <nav className="flex flex-1 flex-col gap-0.5">
        {navItems.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            end={item.end}
            className={({ isActive }) =>
              cn(
                "group flex items-center gap-2.5 rounded-md px-3 py-2 text-sm transition-colors",
                isActive
                  ? "bg-white/[0.06] text-text-primary"
                  : "text-text-secondary hover:bg-white/[0.04] hover:text-text-primary",
              )
            }
          >
            <item.icon className="h-4 w-4" strokeWidth={1.75} />
            <span>{item.label}</span>
          </NavLink>
        ))}
      </nav>

      {/* Status pill */}
      <div className="flex items-center gap-2 rounded-md border border-border-subtle bg-bg-elevated px-3 py-2 text-xs">
        <span className="relative flex h-1.5 w-1.5">
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-success opacity-50" />
          <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-success" />
        </span>
        <div className="flex min-w-0 flex-col leading-tight">
          <span className="truncate text-text-primary">{name}</span>
          <span className="truncate text-[10px] text-text-muted">{sub}</span>
        </div>
      </div>
    </aside>
  );
}
