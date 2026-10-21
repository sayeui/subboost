import type { ClashConfig, ProxyGroup } from "@subboost/core/types/config";
import type { ParsedNode } from "@subboost/core/types/node";
import { canonicalizeProxy } from "./yaml";

const CHECKED_GROUP_TYPES = new Set(["url-test", "fallback", "load-balance"]);

function exactNamePattern(name: string): string {
  // Mihomo splits group filters on backticks, including inside regexes.
  return `^${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/`/g, "\\x60")}$`;
}

function collectReferencedNames(value: unknown, nodeNames: Set<string>, out: Set<string>): void {
  if (typeof value === "string") {
    if (nodeNames.has(value)) out.add(value);
  } else if (Array.isArray(value)) {
    for (const item of value) collectReferencedNames(item, nodeNames, out);
  } else if (value && typeof value === "object") {
    for (const item of Object.values(value)) collectReferencedNames(item, nodeNames, out);
  }
}

/** Share already-resolved nodes, after source filters, renames and dialer processing. */
export function shareNodeHealthChecks(
  config: ClashConfig,
  options: { testUrl: string; testInterval: number },
): ClashConfig {
  const nodes = config.proxies ?? [];
  const groups = config["proxy-groups"] ?? [];
  const nodeNames = new Set(nodes.map((node) => node.name));
  const candidates = new Set(
    groups.filter((group) => CHECKED_GROUP_TYPES.has(group.type))
      .flatMap((group) => (group.proxies ?? []).filter((name) => nodeNames.has(name))),
  );
  if (candidates.size === 0) return config;

  // Existing provider members are unknown at generation time. An exact-name filter
  // for local nodes would also filter them, so require normal source import here.
  if (groups.some((group) => (group.use?.length ?? 0) > 0)) {
    throw new Error("共享节点测速不能与 URL 源的 proxy-providers 模式同时使用，请先改为普通导入。");
  }

  const pinned = new Set<string>();
  for (const [key, value] of Object.entries(config)) {
    if (!["proxies", "proxy-groups", "rules"].includes(key)) {
      collectReferencedNames(value, nodeNames, pinned);
    }
  }
  for (const node of nodes) {
    collectReferencedNames(node["dialer-proxy"], nodeNames, pinned);
  }
  for (const rule of config.rules ?? []) {
    for (const name of candidates) {
      if (rule.endsWith(`,${name}`) || rule.endsWith(`,${name},no-resolve`)) pinned.add(name);
    }
  }
  // Fallback order includes both node and group/builtin members. Keep those
  // nodes inline when moving only part of the list could change failover order.
  let changed = true;
  while (changed) {
    changed = false;
    for (const group of groups) {
      if (group.type !== "fallback" || !(group.proxies ?? []).some((name) => !candidates.has(name) || pinned.has(name))) continue;
      for (const name of group.proxies ?? []) {
        if (nodeNames.has(name) && !pinned.has(name)) {
          pinned.add(name);
          changed = true;
        }
      }
    }
  }

  // Provider payload bypasses the top-level proxy serializer. Apply its protocol
  // sanitation and defaults here as well (including UDP and metadata removal).
  const payload = nodes.filter((node) => candidates.has(node.name) && !pinned.has(node.name))
    .map((node) => canonicalizeProxy(node as unknown as Record<string, unknown>) as unknown as ParsedNode);
  if (payload.length === 0) return config;
  const sharedNames = new Set(payload.map((node) => node.name));
  const providers = config["proxy-providers"] ?? {};
  const usedNames = new Set([...Object.keys(providers), ...nodeNames, ...groups.map((group) => group.name)]);
  let providerName = "subboost_shared";
  for (let suffix = 2; usedNames.has(providerName); suffix++) providerName = `subboost_shared_${suffix}`;

  const rewrittenGroups = groups.map((group): ProxyGroup => {
    const members = group.proxies ?? [];
    const selected = members.filter((name) => sharedNames.has(name));
    if (selected.length === 0) return group;
    const proxies = members.filter((name) => !sharedNames.has(name));
    const selectedNames = new Set(selected);
    const providerOrder = payload.filter((node) => selectedNames.has(node.name)).map((node) => node.name);
    const ordered = selected.some((name, index) => name !== providerOrder[index]);
    // Multiple exact filters preserve explicitly ordered node lists. Most groups
    // already follow provider order and need only a single union regex.
    const filter = ordered
      ? selected.map(exactNamePattern).join("`")
      : selected.length === payload.length ? undefined : `^(?:${selected.map((name) => exactNamePattern(name).slice(1, -1)).join("|")})$`;
    const first = members[0];
    return {
      ...group,
      ...(proxies.length ? { proxies } : { proxies: undefined }),
      use: [providerName],
      ...(filter ? { filter } : {}),
      ...(group.type === "select" && sharedNames.has(first) && !group["default-selected"]
        ? { "default-selected": first } : {}),
    };
  });
  const firstCheck = groups.find((group) => CHECKED_GROUP_TYPES.has(group.type) &&
    (group.proxies ?? []).some((name) => sharedNames.has(name)));

  return {
    ...config,
    proxies: nodes.filter((node) => !sharedNames.has(node.name)),
    "proxy-groups": rewrittenGroups,
    "proxy-providers": {
      ...providers,
      [providerName]: {
        type: "inline",
        payload,
        "health-check": {
          enable: true,
          url: firstCheck?.url || options.testUrl,
          interval: Number.isInteger(options.testInterval) && options.testInterval > 0 ? options.testInterval : 300,
          timeout: 5000,
          lazy: false,
        },
      },
    },
  };
}
