import { useState, useCallback } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { apiGet, apiPost } from "@/lib/api";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import {
  Plus,
  Server,
  Trash2,
  Wifi,
  WifiOff,
  ChevronDown,
  ChevronRight,
  Zap,
  Brain,
  Crown,
} from "lucide-react";

// ─── Types ────────────────────────────────────────────────────────

interface ModelEntry {
  id: string;
  name: string;
  contextWindow: number;
  defaultMaxTokens: number;
  supportsThinking: boolean;
  supportsAttachments: boolean;
  inputPricePer1M?: number;
  outputPricePer1M?: number;
}

interface ProviderChannel {
  id: string;
  name: string;
  kind: string;
  baseUrl?: string;
  apiKey?: string;
  enabled: boolean;
  modelCount: number;
  models: ModelEntry[];
}

interface TierTarget {
  channel: string;
  model: string;
}

interface TierMapping {
  fast?: TierTarget;
  default?: TierTarget;
  high?: TierTarget;
}

interface ChannelsResponse {
  ok: boolean;
  channels: ProviderChannel[];
}

interface TiersResponse {
  ok: boolean;
  tiers: TierMapping;
}

interface KindsResponse {
  ok: boolean;
  kinds: string[];
}

interface CatalogResponse {
  ok: boolean;
  kind: string;
  models: ModelEntry[];
}

const PROVIDER_KIND_LABELS: Record<string, string> = {
  anthropic: "Anthropic",
  openai: "OpenAI",
  "openai-compatible": "OpenAI Compatible",
  "google-gemini": "Google Gemini",
  "azure-openai": "Azure OpenAI",
  bedrock: "AWS Bedrock",
};

const TIER_CONFIG = [
  { key: "fast" as const, label: "Fast", icon: Zap, color: "text-green-500" },
  { key: "default" as const, label: "Default", icon: Brain, color: "text-blue-500" },
  { key: "high" as const, label: "High", icon: Crown, color: "text-amber-500" },
];

// ─── Main Component ───────────────────────────────────────────────

export function ProvidersTab() {
  const queryClient = useQueryClient();

  const { data: channelsData, isLoading: channelsLoading } = useQuery({
    queryKey: ["providers", "channels"],
    queryFn: () => apiGet<ChannelsResponse>("/api/providers/channels"),
  });

  const { data: tiersData } = useQuery({
    queryKey: ["providers", "tiers"],
    queryFn: () => apiGet<TiersResponse>("/api/providers/tiers"),
  });

  const { data: kindsData } = useQuery({
    queryKey: ["providers", "kinds"],
    queryFn: () => apiGet<KindsResponse>("/api/providers/kinds"),
  });

  const channels = channelsData?.channels ?? [];
  const tiers = tiersData?.tiers ?? {};
  const kinds = kindsData?.kinds ?? [];

  const testMutation = useMutation({
    mutationFn: async (channelId: string) => {
      return apiPost<{ ok: boolean; message?: string; error?: string }>(
        `/api/providers/channels/${channelId}/test`,
      );
    },
    onSuccess: (data) => {
      if (data.ok) {
        toast.success(data.message ?? "Connection successful");
      } else {
        toast.error(data.error ?? "Connection failed");
      }
    },
    onError: (err: Error) => {
      toast.error(err.message);
    },
  });

  const refresh = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: ["providers"] });
  }, [queryClient]);

  if (channelsLoading) {
    return (
      <div className="space-y-3">
        <div className="h-10 w-full animate-pulse rounded-md bg-muted" />
        <div className="h-24 w-full animate-pulse rounded-md bg-muted" />
        <div className="h-24 w-full animate-pulse rounded-md bg-muted" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Channel List */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-3">
          <div>
            <CardTitle className="text-base">Provider Channels</CardTitle>
            <p className="text-sm text-muted-foreground mt-1">
              Configure LLM providers with API keys and model catalogs
            </p>
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          {channels.length === 0 ? (
            <div className="rounded-lg border border-dashed border-border p-6 text-center">
              <Server className="size-8 text-muted-foreground/40 mx-auto mb-2" />
              <p className="text-sm text-muted-foreground">
                No provider channels configured yet.
              </p>
              <p className="text-xs text-muted-foreground/70 mt-1">
                Edit your config.yaml to add channels under <code className="font-mono">llm.channels</code>
              </p>
            </div>
          ) : (
            channels.map((ch) => (
              <ChannelCard
                key={ch.id}
                channel={ch}
                onTest={() => testMutation.mutate(ch.id)}
                isTesting={testMutation.isPending}
              />
            ))
          )}
        </CardContent>
      </Card>

      {/* Tier Mapping */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Tier Mapping</CardTitle>
          <p className="text-sm text-muted-foreground mt-1">
            Map fast / default / high tiers to specific channel + model combos.
            Edit in config.yaml under <code className="font-mono">llm.tiers</code>
          </p>
        </CardHeader>
        <CardContent className="space-y-3">
          {TIER_CONFIG.map(({ key, label, icon: Icon, color }) => {
            const target = tiers[key];
            const channel = target
              ? channels.find((c) => c.id === target.channel)
              : null;

            return (
              <div
                key={key}
                className="flex items-center gap-3 rounded-lg border border-border px-3 py-2.5 md:px-3 md:py-2"
              >
                <Icon className={cn("size-4 shrink-0", color)} />
                <span className="text-sm font-medium w-16 md:w-20 shrink-0">
                  {label}
                </span>
                {target ? (
                  <div className="flex items-center gap-2 min-w-0 text-sm text-muted-foreground">
                    <span className="inline-flex items-center gap-1 rounded-md bg-accent px-2 py-0.5 text-xs font-mono">
                      {target.channel}
                    </span>
                    <span className="truncate">{target.model}</span>
                  </div>
                ) : (
                  <span className="text-sm text-muted-foreground/60 italic">
                    Not configured — using defaults
                  </span>
                )}
              </div>
            );
          })}
        </CardContent>
      </Card>
    </div>
  );
}

// ─── Channel Card ─────────────────────────────────────────────────

function ChannelCard({
  channel,
  onTest,
  isTesting,
}: {
  channel: ProviderChannel;
  onTest: () => void;
  isTesting: boolean;
}) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="rounded-lg border border-border">
      {/* Header */}
      <div className="flex items-center gap-3 px-3 py-2.5 md:px-3 md:py-2">
        <button
          onClick={() => setExpanded(!expanded)}
          className="shrink-0 p-1 rounded hover:bg-accent transition-colors"
        >
          {expanded ? (
            <ChevronDown className="size-4" />
          ) : (
            <ChevronRight className="size-4" />
          )}
        </button>

        <div className="flex items-center gap-2 min-w-0 flex-1">
          {channel.enabled ? (
            <Wifi className="size-3.5 text-green-500 shrink-0" />
          ) : (
            <WifiOff className="size-3.5 text-muted-foreground shrink-0" />
          )}
          <span className="text-sm font-medium truncate">{channel.name}</span>
          <span className="text-[11px] text-muted-foreground font-mono shrink-0">
            {PROVIDER_KIND_LABELS[channel.kind] ?? channel.kind}
          </span>
        </div>

        <span className="text-xs text-muted-foreground shrink-0">
          {channel.modelCount} models
        </span>

        <Button
          variant="ghost"
          size="sm"
          onClick={onTest}
          disabled={isTesting || !channel.enabled}
          className="shrink-0 text-xs h-8 md:h-7"
        >
          {isTesting ? "Testing..." : "Test"}
        </Button>
      </div>

      {/* Models list (expandable) */}
      {expanded && channel.models.length > 0 && (
        <div className="border-t border-border px-3 py-2 max-h-64 overflow-y-auto">
          <div className="grid grid-cols-[1fr_auto_auto_auto] gap-x-3 gap-y-1 text-xs">
            <span className="font-medium text-muted-foreground">Model</span>
            <span className="font-medium text-muted-foreground text-right">Context</span>
            <span className="font-medium text-muted-foreground text-right">Max Out</span>
            <span className="font-medium text-muted-foreground text-right">Price (in/out)</span>

            {channel.models.map((m) => (
              <ModelRow key={m.id} model={m} />
            ))}
          </div>
        </div>
      )}

      {expanded && channel.models.length === 0 && (
        <div className="border-t border-border px-3 py-3 text-xs text-muted-foreground text-center">
          No models configured for this channel
        </div>
      )}
    </div>
  );
}

// ─── Model Row ────────────────────────────────────────────────────

function ModelRow({ model }: { model: ModelEntry }) {
  const formatTokens = (n: number) => {
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
    if (n >= 1_000) return `${(n / 1_000).toFixed(0)}K`;
    return String(n);
  };

  return (
    <>
      <span className="font-mono truncate" title={model.id}>
        {model.name}
      </span>
      <span className="text-right text-muted-foreground">
        {formatTokens(model.contextWindow)}
      </span>
      <span className="text-right text-muted-foreground">
        {formatTokens(model.defaultMaxTokens)}
      </span>
      <span className="text-right text-muted-foreground">
        {model.inputPricePer1M != null
          ? `$${model.inputPricePer1M}/${model.outputPricePer1M ?? "-"}`
          : "—"}
      </span>
    </>
  );
}
