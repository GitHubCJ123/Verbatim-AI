import { Loader2 } from "lucide-react";
import { cn } from "../../lib/utils";

export function Spinner({ className, ...props }: React.SVGProps<SVGSVGElement>) {
  return <Loader2 className={cn("h-4 w-4 animate-spin text-text-secondary", className)} {...props} />;
}
