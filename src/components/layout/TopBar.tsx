import { useLocation, Link } from "react-router-dom";
import { Mic, ChevronRight } from "lucide-react";
import { Button } from "../ui/Button";
import { Avatar, AvatarFallback } from "../ui/Avatar";
import { Kbd } from "../ui/Kbd";

const routeLabels: Record<string, string> = {
  "": "Home",
  modes: "Modes",
  apps: "Apps",
  vocabulary: "Vocabulary",
  history: "History",
  settings: "Settings",
  account: "Account",
  editor: "Editor",
};

export function TopBar() {
  const { pathname } = useLocation();
  const segments = pathname.split("/").filter(Boolean);
  const crumbs = segments.length === 0 ? ["Home"] : segments.map((s) => routeLabels[s] ?? s);

  return (
    <header className="flex h-14 shrink-0 items-center justify-between border-b border-border-subtle bg-bg-base/60 px-6 backdrop-blur-xl">
      {/* Breadcrumb */}
      <nav className="flex items-center gap-1.5 text-sm">
        {crumbs.map((label, i) => (
          <div key={i} className="flex items-center gap-1.5">
            {i > 0 && <ChevronRight className="h-3.5 w-3.5 text-text-muted" />}
            <Link
              to={i === 0 ? "/" : `/${segments.slice(0, i).join("/")}`}
              className={
                i === crumbs.length - 1
                  ? "font-medium text-text-primary"
                  : "text-text-secondary hover:text-text-primary"
              }
            >
              {label}
            </Link>
          </div>
        ))}
      </nav>

      {/* Right cluster */}
      <div className="flex items-center gap-2">
        <Button variant="secondary" size="sm" className="gap-1.5">
          <Mic className="h-3.5 w-3.5" />
          <span>Record now</span>
          <Kbd className="ml-1">Ctrl Space</Kbd>
        </Button>
        <Avatar className="h-8 w-8">
          <AvatarFallback>SW</AvatarFallback>
        </Avatar>
      </div>
    </header>
  );
}
