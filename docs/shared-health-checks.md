# 共享节点测速 / Shared node health checks

## 中文

在高级模式的「分流代理组」中开启「共享节点测速」。此功能默认关闭，需要支持 inline proxy-provider 的 Mihomo 内核。

SubBoost 先完成普通导入、节点重命名、来源/地区/名称筛选和中转配置，再将参与健康检查的节点移动到同一个 inline provider。各组以精确名称筛选共享节点；节点配置不会再复制一份。provider 使用全局测速间隔，主动测速（lazy false），相同测试 URL 的组复用结果。不同 URL 仍需要分别探测，手动测速及失败触发的检查也可能额外执行。

候选节点集合、规则和默认手动选择保留。明确指定的节点排序会转换为有序筛选表达式；混合节点与策略组/内置出站的列表中，保留的直接成员会显示在 provider 节点之前。带混合成员的 fallback 组保留原有节点定义和优先顺序。

节点监听、规则直接指向节点、直接 dialer-proxy 节点依赖等需要顶层节点名的场景，会保留这些节点在顶层。原本不参与健康检查的节点也保留原状。这些例外仍可能发生组内重复测试。中转组引用保持有效，已经应用的 dialer-proxy 字段会随节点一起移动。

此模式不能与 URL 源的「proxy-providers 模式」同时使用：后者的节点无法在生成时获取完整候选集合。请继续使用普通导入，以保留高级筛选和中转功能。开关会保存到草稿、订阅及配置模板，自动刷新时继续使用。

开启后减少的是重复调度，不保证内存按相同比例下降。部署后应重新观察实际负载下的峰值。

## English

Enable **共享节点测速** under Proxy Groups in advanced mode. It is off by default and requires Mihomo with inline proxy-provider support.

Normal import, renaming, source/region/name filtering and dialer processing run first. Nodes used by health-check groups then move into one inline provider, with exact-name group filters and no duplicate node definitions. The provider uses the global interval with lazy disabled. Groups sharing a test URL reuse node results; different URLs, manual tests and failure-triggered checks can still cause additional probes.

Candidate sets, rules and default manual selections are retained. Explicit node ordering uses ordered filters. In mixed lists, retained direct members precede provider nodes. Mixed-member fallback groups keep their original node definitions and priority order.

Nodes required by fixed listeners, direct rule targets or direct dialer-proxy node dependencies stay at the top level, as do nodes that were never health-checked. These exceptions may still be tested by multiple groups. Generated dialer groups remain valid, and node dialer-proxy fields are preserved.

Do not combine this option with the URL-source proxy-providers mode, whose members are unknown during generation. Use normal import to retain advanced filters and chained proxies. The setting survives drafts, subscription saves, templates and automatic refreshes.

Fewer duplicate checks do not imply a proportional memory reduction. Measure peak memory under representative traffic after deployment.
