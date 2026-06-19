# 13 — Kubernetes Migration Notes

This stack is Docker-Compose-first but designed for K8s migration. Below is the mapping.

## Stack → Helm chart

A future `hermes-platform/` Helm chart would create:

| Compose primitive | K8s resource |
|---|---|
| `openviking` service | `Deployment` + `Service` (ClusterIP, no `LoadBalancer`) |
| `memory-gateway` service | `Deployment` + `Service` (ClusterIP) — dual-port headless for in-cluster + NodePort/Ingress for ops |
| `hermes-pf-<profile>` services (5) | `StatefulSet` per profile (so volume bindings are 1:1) **OR** `Deployment` with a per-profile `PersistentVolumeClaim` |
| `hermes-platform_data-<profile>` volumes | `PersistentVolumeClaim` (block or filesystem, RWO) per profile |
| `hermes-platform_openviking-workspace` | `PersistentVolumeClaim` (RWO) |
| `hermes-platform-mem-net` (internal) | `NetworkPolicy`: ingress from `memory-gateway` only |
| `hermes-platform-app-net` (internal) | `NetworkPolicy`: hermes-pf-* → memory-gateway only |
| `platform-net` | existing IronNest cluster-network |
| Per-service `cap_drop: ALL` etc. | `securityContext` on each pod |
| `with-infisical.sh` | Replace with the Infisical Kubernetes Operator + `InfisicalSecret` CRDs, mount via `secretRef` |

## NetworkPolicies (sketch)

```yaml
# openviking — only memory-gateway may connect
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata: { name: openviking-ingress-from-gateway-only, namespace: hermes-platform }
spec:
  podSelector: { matchLabels: { app: openviking } }
  policyTypes: [Ingress]
  ingress:
    - from:
        - podSelector: { matchLabels: { app: memory-gateway } }
      ports: [{ protocol: TCP, port: 1933 }]
```

```yaml
# memory-gateway — only hermes-pf-* may connect (incoming)
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata: { name: memory-gateway-ingress-from-hermes-pf, namespace: hermes-platform }
spec:
  podSelector: { matchLabels: { app: memory-gateway } }
  policyTypes: [Ingress]
  ingress:
    - from:
        - podSelector: { matchLabels: { role: hermes-profile } }
      ports: [{ protocol: TCP, port: 8080 }]
```

```yaml
# Block hermes-pf-* from talking to openviking directly (defense in depth)
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata: { name: hermes-pf-egress-denylist, namespace: hermes-platform }
spec:
  podSelector: { matchLabels: { role: hermes-profile } }
  policyTypes: [Egress]
  egress:
    # Allow only DNS + memory-gateway + external LLM provider via in-cluster egress
    - to: [{ podSelector: { matchLabels: { app: memory-gateway } } }]
      ports: [{ protocol: TCP, port: 8080 }]
    - ports: [{ protocol: UDP, port: 53 }]
    # External egress handled by the cluster's egress controller
```

## Secrets

Replace `with-infisical.sh` with the **Infisical Kubernetes Operator**:

```yaml
apiVersion: secrets.infisical.com/v1alpha1
kind: InfisicalSecret
metadata: { name: memory-gateway-secrets, namespace: hermes-platform }
spec:
  hostAPI: http://infisical:8090
  resyncInterval: 60
  authentication:
    universalAuth:
      secretsScope:
        projectId: <hermes-platform-project-id>
        envSlug: dev
        secretsPath: /hermes-platform/gateway
        recursive: true
      credentialsRef:
        secretName: infisical-universal-auth-creds
        secretNamespace: hermes-platform
  managedSecretReference:
    secretName: memory-gateway-secrets-rendered
    secretNamespace: hermes-platform
```

Then reference `memory-gateway-secrets-rendered` in the `Deployment`'s `envFrom`.

## Things that stay the same

- `gateway/app/*.py` runs unchanged.
- `policies/*.yaml`, `registry/profiles-registry.yaml`, `spec/*` ship as a `ConfigMap` (or sidecar git-sync from a config repo).
- Profile lifecycle scripts (`scripts/create-profile.sh` etc.) become a small operator or a `Job`-based bootstrap (the YAML manipulation is the same).

## What needs rewriting

- `with-infisical.sh` — see above (operator replaces wrapper).
- The Squid `HTTPS_PROXY` env vars — replace with the cluster's egress controller config.
- The Rancher Desktop / WSL2 NAT repair scripts — irrelevant on K8s.

## Open questions for the K8s port

- Storage class for per-profile volumes. RWO is fine for single-replica StatefulSet; consider topology-aware scheduling.
- Pod-to-pod mTLS via the cluster's service mesh (Istio, Linkerd). The bearer-token model still works, but mTLS is a clean second factor.
- Per-namespace tenancy: should every profile live in its own K8s namespace? Pros: cleaner RBAC. Cons: more YAML.
