import { useMemo } from "react";
import { useNavigate } from "react-router-dom";
import {
  DndContext,
  PointerSensor,
  KeyboardSensor,
  useSensor,
  useSensors,
  closestCenter,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  arrayMove,
  SortableContext,
  rectSortingStrategy,
  sortableKeyboardCoordinates,
  useSortable,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
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
import { confirmDialog } from "../components/ui/confirmDialog";
import type { Mode } from "../types/mode";

function pickIcon(
  name: string,
): React.ComponentType<{ className?: string; strokeWidth?: number }> {
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

  const sorted = useMemo(
    () => [...modes].sort((a, b) => a.position - b.position),
    [modes],
  );
  const ids = useMemo(() => sorted.map((m) => m.id), [sorted]);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const oldIndex = ids.indexOf(String(active.id));
    const newIndex = ids.indexOf(String(over.id));
    if (oldIndex < 0 || newIndex < 0) return;
    reorder(arrayMove(ids, oldIndex, newIndex));
  };

  const handleCreate = async () => {
    const m = await create({
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

      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
        <SortableContext items={ids} strategy={rectSortingStrategy}>
          <div className="grid grid-cols-2 gap-4 lg:grid-cols-3">
            {sorted.map((mode) => (
              <SortableModeCard
                key={mode.id}
                mode={mode}
                isDefault={mode.id === defaultModeId}
                onEdit={() => navigate(`/modes/editor?id=${mode.id}`)}
                onDuplicate={async () => {
                  const dup = await duplicate(mode.id);
                  if (dup) navigate(`/modes/editor?id=${dup.id}`);
                }}
                onDelete={async () => {
                  if (
                    await confirmDialog({
                      title: `Delete "${mode.name}"?`,
                      message: "This mode and its app mappings won't be recoverable.",
                      confirmLabel: "Delete",
                      destructive: true,
                    })
                  ) {
                    void remove(mode.id);
                  }
                }}
                onSetDefault={() => {
                  setDefault(mode.id);
                  toast.success(`${mode.name} is now your default`);
                }}
              />
            ))}
          </div>
        </SortableContext>
      </DndContext>
    </PageContainer>
  );
}

interface SortableModeCardProps {
  mode: Mode;
  isDefault: boolean;
  onEdit: () => void;
  onDuplicate: () => void;
  onDelete: () => void;
  onSetDefault: () => void;
}

function SortableModeCard({
  mode,
  isDefault,
  onEdit,
  onDuplicate,
  onDelete,
  onSetDefault,
}: SortableModeCardProps) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: mode.id });

  const Icon = pickIcon(mode.icon);

  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    zIndex: isDragging ? 10 : undefined,
    opacity: isDragging ? 0.8 : 1,
  };

  return (
    <div ref={setNodeRef} style={style}>
      <Card
        className={
          "group relative transition-all hover:border-border-strong hover:bg-bg-elevated/80" +
          (isDragging ? " shadow-glow ring-1 ring-accent-solid/40" : "")
        }
      >
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

          <button
            type="button"
            onClick={onEdit}
            className="text-left"
          >
            <div className="text-sm font-semibold">{mode.name}</div>
            <div className="mt-0.5 line-clamp-2 text-xs text-text-secondary">
              {mode.description}
            </div>
          </button>

          <div className="mt-1 flex items-center justify-between gap-2">
            <button
              type="button"
              {...attributes}
              {...listeners}
              className="flex cursor-grab items-center gap-1 rounded px-1 py-0.5 text-text-muted opacity-0 transition-opacity hover:bg-white/[0.04] active:cursor-grabbing group-hover:opacity-100"
              aria-label="Drag handle"
            >
              <GripVertical className="h-3.5 w-3.5" />
              <span className="text-[10px]">Drag</span>
            </button>
            <div className="flex items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
              {!isDefault && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <IconButton size="sm" onClick={onSetDefault} aria-label="Set default">
                      <CheckCircle2 className="h-3.5 w-3.5" />
                    </IconButton>
                  </TooltipTrigger>
                  <TooltipContent>Set as default</TooltipContent>
                </Tooltip>
              )}
              <Tooltip>
                <TooltipTrigger asChild>
                  <IconButton size="sm" onClick={onEdit} aria-label="Edit">
                    <Pencil className="h-3.5 w-3.5" />
                  </IconButton>
                </TooltipTrigger>
                <TooltipContent>Edit</TooltipContent>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger asChild>
                  <IconButton size="sm" onClick={onDuplicate} aria-label="Duplicate">
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
                      onClick={onDelete}
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
    </div>
  );
}
