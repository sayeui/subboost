import { describe, expect, it } from "vitest";
import yaml from "js-yaml";
import type { ClashConfig, ProxyGroup } from "@subboost/core/types/config";
import type { ParsedNode } from "@subboost/core/types/node";
import { buildGenerateOptionsFromConfig } from "@subboost/core/subscription/config-utils";
import { generateClashConfig, generateClashYaml } from "./index";
import { shareNodeHealthChecks } from "./shared-health-checks";

const url = "https://probe.example.com/204";
const options = { testUrl: url, testInterval: 300 };
function node(name: string, extra: Record<string, unknown> = {}): ParsedNode {
  return { name, type: "ss", server: "proxy.example.com", port: 443, cipher: "aes-128-gcm", password: "example", ...extra } as ParsedNode;
}
function fixture(groups?: ProxyGroup[]): ClashConfig {
  return {
    proxies: [node("HK A"), node("JP B"), node("Private")],
    "proxy-groups": groups ?? [
      { name: "Auto", type: "url-test", proxies: ["HK A", "JP B"], url, interval: 300, lazy: false },
      { name: "HK", type: "url-test", proxies: ["HK A"], url, interval: 300, lazy: false },
      { name: "Manual", type: "select", proxies: ["JP B", "DIRECT", "HK A", "Private"] },
    ],
    rules: ["MATCH,Auto"],
  };
}
function provider(config: ClashConfig) {
  return Object.values(config["proxy-providers"] ?? {})[0] as { payload: ParsedNode[]; "health-check": Record<string, unknown> };
}
function members(config: ClashConfig, group: ProxyGroup): string[] {
  const result = [...(group.proxies ?? [])];
  for (const key of group.use ?? []) {
    const payload = (config["proxy-providers"]?.[key] as { payload: ParsedNode[] }).payload;
    const patterns = group.filter?.split("`").map((pattern) => new RegExp(pattern));
    if (!patterns) result.push(...payload.map((item) => item.name));
    else for (const pattern of patterns) for (const item of payload) {
      if (pattern.test(item.name) && !result.includes(item.name)) result.push(item.name);
    }
  }
  return result;
}

describe("shared node health checks", () => {
  it("shares overlapping candidates once, keeps untested nodes inline and preserves each candidate set", () => {
    const before = fixture();
    const untouched = structuredClone(before);
    const after = shareNodeHealthChecks(before, options);
    expect(before).toEqual(untouched);
    expect(provider(after).payload.map((item) => item.name)).toEqual(["HK A", "JP B"]);
    expect(provider(after)["health-check"]).toEqual({ enable: true, url, interval: 300, timeout: 5000, lazy: false });
    expect(after.proxies?.map((item) => item.name)).toEqual(["Private"]);
    for (const [index, group] of (after["proxy-groups"] ?? []).entries()) {
      expect(members(after, group).sort()).toEqual([...(before["proxy-groups"]![index].proxies ?? [])].sort());
      expect(group.proxies ?? []).not.toContain("HK A");
    }
    expect(after["proxy-groups"]?.[2]["default-selected"]).toBe("JP B");
    expect(after.rules).toEqual(before.rules);
  });

  it("escapes node names as exact literals, including regex syntax and Mihomo filter separators", () => {
    const special = "🇭🇰 [a].+?($)|x`end\\";
    const input: ClashConfig = {
      proxies: [node(special), node("Other")],
      "proxy-groups": [
        { name: "All", type: "url-test", proxies: [special, "Other"], url },
        { name: "Special", type: "select", proxies: [special] },
      ],
    };
    const after = shareNodeHealthChecks(input, options);
    expect(members(after, after["proxy-groups"]![1])).toEqual([special]);
    expect(after["proxy-groups"]![1].filter).not.toContain("`");
  });

  it("preserves explicit node ordering, including node-only fallback priority", () => {
    const input = fixture([
      { name: "Reverse", type: "fallback", proxies: ["JP B", "HK A"], url },
      { name: "Auto", type: "url-test", proxies: ["HK A", "JP B"], url },
    ]);
    const after = shareNodeHealthChecks(input, options);
    expect(members(after, after["proxy-groups"]![0])).toEqual(["JP B", "HK A"]);
  });

  it("pins fixed listener, rule target and direct dialer dependencies", () => {
    const input = fixture();
    input.listeners = [{ name: "fixed", type: "mixed", port: 12000, proxy: "HK A" }];
    const after = shareNodeHealthChecks(input, options);
    expect(after.proxies?.map((item) => item.name)).toEqual(["HK A", "Private"]);
    expect(after.listeners).toEqual(input.listeners);
    const rules = fixture();
    rules.rules = ["DOMAIN,example.com,JP B,no-resolve", "MATCH,Auto"];
    expect(shareNodeHealthChecks(rules, options).proxies?.map((item) => item.name)).toContain("JP B");
    const dialer = fixture();
    dialer.proxies!.push(node("Target", { "dialer-proxy": "JP B" }));
    expect(shareNodeHealthChecks(dialer, options).proxies?.map((item) => item.name)).toContain("JP B");
  });

  it("keeps mixed fallback members in their original priority order", () => {
    const input = fixture([
      { name: "Fallback", type: "fallback", proxies: ["HK A", "DIRECT", "JP B"], url },
    ]);
    expect(shareNodeHealthChecks(input, options)).toBe(input);
  });

  it("avoids provider name collisions and retains unrelated providers", () => {
    const input = fixture();
    input["proxy-providers"] = { subboost_shared: { type: "file", path: "./other.yaml" } };
    const after = shareNodeHealthChecks(input, options);
    expect(after["proxy-providers"]).toHaveProperty("subboost_shared_2");
    expect(after["proxy-providers"]!.subboost_shared).toEqual(input["proxy-providers"]!.subboost_shared);
  });

  it("does not broaden unknown external provider members", () => {
    const input = fixture();
    input["proxy-groups"]![0].use = ["remote"];
    expect(() => shareNodeHealthChecks(input, options)).toThrow("普通导入");
  });

  it("retains group-specific URLs and nested policy references", () => {
    const input = fixture();
    input["proxy-groups"]![1].url = "https://other.example.com/204";
    input["proxy-groups"]![1].proxies!.push("Auto");
    const after = shareNodeHealthChecks(input, options);
    expect(after["proxy-groups"]![1].url).toBe("https://other.example.com/204");
    expect(after["proxy-groups"]![1].proxies).toEqual(["Auto"]);
  });

  it("leaves legacy output unchanged unless enabled and persists through server regeneration", () => {
    const nodes = [node("HK A"), node("JP B")];
    const base = { nodes, userConfig: { dnsYaml: "", enabledGroups: ["select", "auto"] } };
    expect(generateClashConfig(base)).toEqual(generateClashConfig({ ...base, userConfig: { ...base.userConfig, sharedHealthChecks: false } }));
    const config = { enabledGroups: ["select", "auto"], sharedHealthChecks: true, dnsYaml: "" };
    const generated = generateClashConfig(buildGenerateOptionsFromConfig(config, { nodes }));
    expect(provider(generated).payload).toHaveLength(2);
    expect(generated.proxies).toEqual([]);
    const parsed = yaml.load(generateClashYaml(buildGenerateOptionsFromConfig(config, { nodes }))) as ClashConfig;
    expect(provider(parsed).payload.map((item) => item.name)).toEqual(["HK A", "JP B"]);
    expect(parsed["proxy-groups"]!.find((group) => group.type === "url-test")?.proxies).toBeUndefined();
  });

  it("preserves region/source filtering and dialer group targets through the full generator", () => {
    const nodes = [node("HK A", { _sourceIds: ["airport-a"] }), node("JP B"), node("Relay"), node("HK other", { _sourceIds: ["airport-b"] })];
    const base = {
      nodes,
      userConfig: { enabledGroups: ["select", "auto"], dnsYaml: "" },
      customProxyGroups: [{ id: "hk", name: "Hong Kong", emoji: "", groupType: "url-test" as const, memberSource: "filtered-nodes" as const, advanced: { regions: ["hk" as const], sourceIds: ["airport-a"] } }],
      dialerProxyGroups: [{ id: "relay", name: "Relay group", relayNodes: ["Relay"], targetNodes: ["HK A"], type: "select" as const }],
    };
    const before = generateClashConfig(base);
    const after = generateClashConfig({ ...base, userConfig: { ...base.userConfig, sharedHealthChecks: true } });
    for (const group of before["proxy-groups"] ?? []) {
      const rewritten = after["proxy-groups"]!.find((item) => item.name === group.name)!;
      expect(members(after, rewritten).sort()).toEqual([...(group.proxies ?? [])].sort());
    }
    expect(provider(after).payload.find((item) => item.name === "HK A")).toHaveProperty("dialer-proxy", "Relay group");
    expect(members(after, after["proxy-groups"]!.find((group) => group.name === "Hong Kong")!)).toEqual(["HK A"]);
  });

  it("retains the same serialized protocol fields, UDP defaults and metadata stripping", () => {
    const nodes = [node("HK A", { _sourceIds: ["airport-a"] }), node("JP B", { udp: false })];
    const base = { nodes, userConfig: { enabledGroups: ["select", "auto"], dnsYaml: "" } };
    const legacy = yaml.load(generateClashYaml(base)) as ClashConfig;
    const shared = yaml.load(generateClashYaml({ ...base, userConfig: { ...base.userConfig, sharedHealthChecks: true } })) as ClashConfig;
    expect(provider(shared).payload).toEqual(legacy.proxies);
    expect(provider(shared).payload[0]).toHaveProperty("udp", true);
    expect(provider(shared).payload[1]).toHaveProperty("udp", false);
    expect(provider(shared).payload[0]).not.toHaveProperty("_sourceIds");
  });
});
