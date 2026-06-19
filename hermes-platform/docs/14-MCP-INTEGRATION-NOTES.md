# 14 — MCP Integration Notes

This stack does NOT need an MCP server for conversational memory. It now ships
the `ironnest_gateway` Hermes `MemoryProvider`, mounted into each
`hermes-pf-*` container and selected as `memory.provider` at startup. The
provider uses only `http://memory-gateway:8080/memory/*`, so OpenViking remains
behind the policy and audit boundary.

The provider automatically:

- searches the profile's private OpenViking namespace before each answer;
- stores completed conversation turns under
  `viking://profiles/<profile>/conversations/<session>/`;
- exposes `memory_search`, `memory_read_private`, `memory_remember`, and
  `memory_publish_approved` tools to Hermes;
- redacts common token/password/API-key patterns before automatic transcript
  storage.

The MCP patterns below remain extension points for external clients or future
tool protocol unification, not a prerequisite for Hermes profile memory.

## The two MCP shapes hermes-platform can take

### Shape A — Memory as an MCP tool exposed to Hermes agents

Hermes already supports MCP tools. Wire the memory gateway as an MCP server:

1. Add a thin MCP server image under `mcp-server/` that exposes tools `memory.read`, `memory.write`, `memory.search`, `memory.publish_approved`. The server is just an HTTP-proxy MCP shim around `http://memory-gateway:8080/memory/*`.
2. Add it to each profile's `tools.yaml.template` (commented out by default):

   ```yaml
   tools:
     - name: hermes-memory
       transport: http
       url: "http://hermes-platform-mcp:8000"
       auth:
         bearer_env: MEMORY_GATEWAY_TOKEN
       timeout_seconds: 30
   ```

3. Per-profile MCP enablement controlled by `tools.yaml`. Disabled by default for new profiles — operators opt in explicitly.

The MCP server lives on `hermes-platform-app-net` (with `memory-gateway`) and on the per-profile network for hermes-pf-* clients. It NEVER joins `hermes-platform-mem-net`.

### Shape B — Memory gateway becomes an MCP server

A more invasive option: the gateway itself speaks MCP (in addition to its current REST surface). The `routes/memory.py` endpoints would have an MCP-tool sibling. Adds protocol coupling but removes the Shape A proxy layer.

Recommended: start with Shape A. The gateway's REST surface is simpler to test and audit.

## Per-profile MCP server scoping

Each profile's `tools.yaml` enumerates the MCP servers it may use. The Memory Gateway sees only that profile's bearer token, so even if a profile "knows" about another profile's MCP endpoint, it can't authenticate to it. Compare with the existing `browser-intent` per-bearer-token-site-scoping pattern (memory note `project_browser_intent_tool_consolidation`).

## What MCP does NOT replace

- Policy enforcement. The MCP layer is a transport; the policy engine still runs in the gateway. Allow/deny decisions are unchanged whether the caller is HTTP-curl or an MCP client.
- Audit log. Same audit fields apply.
- Rate limiting. Same per-profile token bucket.

## Wiring sketch

If Shape A is chosen, the eventual directory layout adds:

```
hermes-platform/
└── mcp-server/
    ├── Dockerfile
    ├── server.py            # MCP server using @modelcontextprotocol/sdk
    └── README.md
```

And `docker-compose.yml` adds:

```yaml
hermes-platform-mcp:
  build: ./mcp-server
  image: platform/hermes-platform-mcp:0.1.0
  container_name: hermes-platform-mcp
  restart: unless-stopped
  depends_on:
    memory-gateway: { condition: service_healthy }
  networks:
    - hermes-platform-app-net    # gateway access + hermes-pf-* clients
  # No platform-net join — MCP is purely internal
```

## Don't expose MCP externally

Same rule as OpenViking: this is internal infrastructure. No host port publication. No Traefik route.
