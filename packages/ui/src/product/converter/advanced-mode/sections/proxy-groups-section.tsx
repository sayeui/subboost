"use client";

import * as React from "react";
import { Layers } from "lucide-react";
import { Badge } from "@subboost/ui/components/ui/badge";
import { Switch } from "@subboost/ui/components/ui/switch";
import { PROXY_GROUP_MODULES } from "@subboost/core/generator/proxy-groups";
import { useConfigStore } from "@subboost/ui/store/config-store";
import { SectionHeader } from "../section-header";
import { ProxyGroupsCategories } from "./proxy-groups-categories";

export function ProxyGroupsSection({
  isExpanded,
  onToggle,
}: {
  isExpanded: boolean;
  onToggle: () => void;
}) {
  const { enabledProxyGroups, hiddenProxyGroups, sharedHealthChecks, setSharedHealthChecks } = useConfigStore();
  const hiddenIds = new Set(hiddenProxyGroups);
  const enabledCount = enabledProxyGroups.filter((id) => !hiddenIds.has(id)).length;
  const totalCount = PROXY_GROUP_MODULES.filter((module) => !hiddenIds.has(module.id)).length;

  return (
    <div>
      <SectionHeader
        icon={Layers}
        title="分流代理组"
        isExpanded={isExpanded}
        onToggle={onToggle}
        badge={
          <Badge variant="outline" className="ml-auto border-blue-500/50 bg-blue-500/10 text-blue-300">
            {enabledCount}/{totalCount}
          </Badge>
        }
      />

      {isExpanded && (
        <div className="mt-2 space-y-2 pl-6">
          <div className="flex items-center justify-between gap-4 rounded-xl border border-ink/10 bg-ink/5 px-3 py-2">
            <div>
              <label htmlFor="shared-health-checks" className="text-sm font-medium text-fg">共享节点测速</label>
              <p className="text-xs text-fg-60">普通导入的节点统一主动测速，各分组复用结果，减少重复探测。需使用 Mihomo。</p>
            </div>
            <Switch id="shared-health-checks" aria-label="共享节点测速" checked={sharedHealthChecks} onCheckedChange={setSharedHealthChecks} />
          </div>
          <ProxyGroupsCategories />
        </div>
      )}
    </div>
  );
}
