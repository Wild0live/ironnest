# Architecture

The canonical architecture document is **[`docs/01-ARCHITECTURE.md`](docs/01-ARCHITECTURE.md)**.

This top-level file exists to mirror the IronNest convention (each stack has an `ARCHITECTURE.md` at its root). See:

- [`docs/01-ARCHITECTURE.md`](docs/01-ARCHITECTURE.md) — picture + word description.
- [`docs/02-SERVICES.md`](docs/02-SERVICES.md) — service inventory.
- [`docs/06-NAMESPACE-AND-POLICY-MODEL.md`](docs/06-NAMESPACE-AND-POLICY-MODEL.md) — gateway-logical vs OpenViking-native namespaces.
- [`docs/08-SECURITY-MODEL.md`](docs/08-SECURITY-MODEL.md) — threat model and defense layers.
- [`docs/16-DECISION-LOG.md`](docs/16-DECISION-LOG.md) — every non-obvious architectural choice and why.
- [`docs/18-AUTOMATIC-CONVERSATIONAL-MEMORY.md`](docs/18-AUTOMATIC-CONVERSATIONAL-MEMORY.md) — how Hermes conversations call gateway-backed memory, survive restarts, and are verified.
- [`spec/system.manifest.yaml`](spec/system.manifest.yaml) — machine-readable manifest with invariants I1-I6.
