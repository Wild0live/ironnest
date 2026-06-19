# 06 — Namespace and Policy Model

## Logical namespaces

The gateway accepts URIs in exactly two top-level shapes:

```
viking://shared/<path>
viking://profiles/<profile-name>/<path>
```

`<profile-name>` MUST match `^[a-z][a-z0-9_-]{0,31}$`. All paths are normalized; path traversal (`..`, `//`, `\`, NUL, control chars) is rejected at parse time in `gateway/app/namespace.py:parse_uri()`.

### Sub-trees of `viking://shared/`

- `viking://shared/org/`        — organizational/about-IronNest knowledge
- `viking://shared/project/`    — current project context
- `viking://shared/knowledge/`  — durable references
- `viking://shared/reference/`  — reusable templates, prompts
- `viking://shared/security/`   — security-policy decisions
- `viking://shared/approved/`   — cross-profile collaboration sink

### `viking://shared/approved/`

This is the ONLY way a profile shares curated content with other profiles. Within it:

```
viking://shared/approved/<source-profile>/<...>
```

- **Write:** only the matching profile may write under its own subtree.
- **Read:** every profile may read everyone's `approved/` subtree.

`POST /memory/publish-approved` is the dedicated promotion endpoint — it requires `read` on source + `write` on target AND additionally enforces that the target URI is under `viking://shared/approved/<caller-profile>/`.

## Policy file format

Each profile has `policies/<profile>.policy.yaml`. Schema in `spec/policies.schema.json`.

```yaml
profile: mark
description: |
  Free-form prose, not used by the engine.

read:
  allow:
    - "viking://shared/**"
    - "viking://profiles/mark/**"

write:
  allow:
    - "viking://profiles/mark/**"
    - "viking://shared/approved/mark/**"
```

**Default-deny is implicit.** A URI that matches no `allow` rule is denied. The `deny:` block is reserved for *narrower exclusions inside an allow*, e.g.:

```yaml
read:
  allow:
    - "viking://shared/**"
  deny:
    - "viking://shared/security/incidents/**"   # narrower than allow
```

Do NOT write blanket denies like `viking://profiles/*/**` — they would match the profile's OWN namespace, and since deny wins over allow (see "Evaluation order" below), the profile would lose access to its own data. See [`docs/16-DECISION-LOG.md`](16-DECISION-LOG.md) §D-009 for the rationale.

## Glob syntax

`gateway/app/namespace.py:matches_glob()` supports:

| Token | Meaning |
|---|---|
| `*` | exactly one path segment, any characters except `/` |
| `**` | zero or more path segments |
| `?` | exactly one character within a segment |

Examples:

| Pattern | Matches | Doesn't match |
|---|---|---|
| `viking://shared/**` | `viking://shared/foo`, `viking://shared/foo/bar/baz` | `viking://profiles/x` |
| `viking://profiles/*/notes` | `viking://profiles/mark/notes` | `viking://profiles/mark/notes/2024` |
| `viking://profiles/mark/**` | `viking://profiles/mark/anything/...` | `viking://profiles/steve/...` |

## Evaluation order (deny-first)

For each request, `gateway/app/policy.py:evaluate(policy, operation, uri)`:

1. Authenticate the caller → `CallerIdentity(profile=<name>)`  (`gateway/app/auth.py`)
2. Look up `policies[<name>]` — if absent → DENY (logged as `no policy loaded for profile`).
3. Parse + normalize the URI → reject traversal as DENY (logged as `invalid uri`).
4. Walk `<operation>.deny` rules in order — any match → DENY (logged with the matched rule).
5. Walk `<operation>.allow` rules in order — any match → ALLOW (logged with the matched rule).
6. Default DENY (logged as `no allow rule matched`).

**Deny ALWAYS wins.** There is no implicit allow path.

## Why deny-first

The IronNest convention (`ARCHITECTURE.md §"Design Principles"`) is least-privilege-by-default with explicit allows. A policy author writes "allow my own private namespace + the shared tree" and the schema-enforced `deny: ["viking://profiles/*/**"]` line is the safety net that breaks the policy if the allow accidentally widens.

## Adding a new sub-namespace under `viking://shared/`

1. Choose a name (must not collide with `approved/`).
2. Decide who writes. If everyone may write: add `viking://shared/<name>/**` to each profile's `write.allow`. If only specific profiles may write: add the more restrictive glob.
3. Update `docs/05-OPENVIKING-MEMORY-MODEL.md §"Sub-trees of viking://shared/"`.
4. `POST /admin/reload-policies`.

## What `*` cannot do

`*` matches a single path segment with NO slashes. So `viking://shared/*` matches `viking://shared/org` but NOT `viking://shared/org/sub`. Use `**` to cross slashes. The `gateway/app/namespace.py:matches_glob()` regex enforces this.
