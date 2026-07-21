import { Circle } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { supportPresentation, type SupportTone } from "@/lib/product-truth";

export function StatusBadge({ support }: { support: string }) {
  const presentation = supportPresentation[support] ?? { label: support, tone: "neutral" as SupportTone };
  return (
    <Badge tone={presentation.tone}>
      <Circle aria-hidden="true" className="size-1.5 fill-current" />
      {presentation.label}
    </Badge>
  );
}
