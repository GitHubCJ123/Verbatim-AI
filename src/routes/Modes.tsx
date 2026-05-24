import { useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { Reorder } from "framer-motion";
import * as Icons from "lucide-react";
import {
  Plus,
  CheckCircle2,
  Copy as CopyIcon,
  Pencil,
  Trash2,
  GripVertical,
} from "lucide-react";
import { Button } from "../components/ui/Button";
import { Card, CardContent } from "../components/ui/Card";
import { Badge } from "../components/ui/Badge";
import { IconButton } from "../components/ui/IconButton";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "../components/ui/Tooltip";
import { PageContainer, PageHeader } from "../components/layout/PageHeader";
import { useModes } from "../lib/store/useModes";
import { toast } from "../components/ui/Toast";

function pickIcon(name: string): React.ComponentType<{ className?: string; strokeWidth?: number }> {
  const Comp = (Icons as unknown as Record<string, unknown>)[name];
  if (typeof Comp === "function" || typeof Comp === "object") {
    return Comp as React.ComponentType<{ className?: string; strokeWidth?: number }>;
  }
  return Icons.Sparkles;
}

export default function Modes() {
  const navigate = useNavigate();
  const modes = useModes((s) => s.modes);
  const defaultModeId = useModes((s) => s.defaultModeId);
  const reorder = useModes((s) => s.reorder);
  const create = useModes((s) => s.create);
  const duplicate = useModes((s) => s.duplicate);
  const remove = useModes((s) => s.remove);
  const setDefault = useModes((s) => s.setDefault);

  const sorted = useMemo(() => [...modes].sort((a, b) => a.position - b.position), [modes]);

  const handleCreate = () => {
    const m = create({
      name: "New Mode",
      icon: "Sparkles",
      description: "Describe what this mode does.",
      systemPrompt: "Polish naturally; preserve the speaker's tone.",
    });
    navigate(`/modes/editor?id=${m.id}`);
  };

  return (
    <PageContainer>
      <PageHeader
        title="Modes"
        description="Reusable presets for cleanup, language, and output behavior."
        actions={
          <Button variant="primary" size="sm" onClick={handleCreate}>
            <Plus className="h-4 w-4" />
            New Mode
          </Button>
        }
      />

      <Reorder.Group
        axis="y"
        values={sorted.map((m) => m.id)}
        onReorder={(ids) => reorder(ids as string[])}
        className="grid grid-cols-2 gap-4 lg:grid-cols-3"
      >
        {sorted.map((mode) => {
          const Icon = pickIcon(mode.icon);
          const isDefault = mode.id === defaultModeId;
          return (
            <Reorder.Item
              key={mode.id}
              value={mode.id}
              className="list-none"
              whileDrag={{ scale: 1.03, zIndex: 10 }}
            >
              <Card className="group relative cursor-pointer transition-all hover:border-border-strong hover:bg-bg-elevated/80">
                <CardContent className="flex flex-col gap-3 p-5 pt-5">
                  <div className="flex items-start justify-between">
                    <div className="flex h-9 w-9 items-center justify-center rounded-md bg-bg-elevated text-text-primary">
                      <Icon className="h-4 w-4" strokeWidth={1.75} />
                    </div>
                    <div className="flex items-center gap-1">
                      {isDefault && (
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <span className="inline-flex">
                              <CheckCircle2 className="h-3.5 w-3.5 text-accent-start" />
                            </span>
                          </TooltipTrigger>
                          <TooltipContent>Default mode</TooltipContent>
                        </Tooltip>
                      )}
                      <Badge variant={mode.outputStyle === "review" ? "warning" : "accent"}>
                        {mode.outputStyle === "review" ? "Review" : "Auto-paste"}
                      </Badge>
                    </div>
                  </div>

                  <div
                    className="cursor-pointer"
                    onClick={() => navigate(`/modes/editor?id=${mode.id}`)}
                  >
                    <div className="text-sm font-semibold">{mode.name}</div>
                    <div className="mt-0.5 line-clamp-2 text-xs text-text-secondary">
                      {mode.description}
                    </div>
                  </div>

                  <div className="mt-1 flex items-center justify-between gap-2">
                    <div className="flex items-center gap-1 text-text-muted opacity-0 transition-opacity group-hover:opacity-100">
                      <GripVertical className="h-3.5 w-3.5" />
                      <span className="text-[10px]">Drag to reorder</span>
                    </div>
                    <div className="flex items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
                      {!isDefault && (
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <IconButton
                              size="sm"
                              onClick={(e) => {
                                e.stopPropagation();
                                setDefault(mode.id);
                                toast.success(`${mode.name} is now your default`);
                              }}
                              aria-label="Set default"
                            >
                              <CheckCircle2 className="h-3.5 w-3.5" />
                            </IconButton>
                          </TooltipTrigger>
                          <TooltipContent>Set as default</TooltipContent>
                        </Tooltip>
                      )}
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <IconButton
                            size="sm"
                            onClick={(e) => {
                              e.stopPropagation();
                              navigate(`/modes/editor?id=${mode.id}`);
                            }}
                            aria-label="Edit"
                          >
                            <Pencil className="h-3.5 w-3.5" />
                          </IconButton>
                        </TooltipTrigger>
                        <TooltipContent>Edit</TooltipContent>
                      </Tooltip>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <IconButton
                            size="sm"
                            onClick={(e) => {
                              e.stopPropagation();
                              const dup = duplicate(mode.id);
                              if (dup) navigate(`/modes/editor?id=${dup.id}`);
                            }}
                            aria-label="Duplicate"
                          >
                            <CopyIcon className="h-3.5 w-3.5" />
                          </IconButton>
                        </TooltipTrigger>
                        <TooltipContent>Duplicate</TooltipContent>
                      </Tooltip>
                      {!mode.isBuiltin && (
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <IconButton
                              size="sm"
                              onClick={(e) => {
                                e.stopPropagation();
                                if (confirm(`Delete "${mode.name}"?`)) remove(mode.id);
                              }}
                              aria-label="Delete"
                              className="hover:text-danger"
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                            </IconButton>
                          </TooltipTrigger>
                          <TooltipContent>Delete</TooltipContent>
                        </Tooltip>
                      )}
                    </div>
                  </div>
                </CardContent>
              </Card>
            </Reorder.Item>
          );
        })}
      </Reorder.Group>
    </PageContainer>
  );
}
