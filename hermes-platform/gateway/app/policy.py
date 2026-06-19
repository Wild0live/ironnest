"""Deny-first policy evaluator. Pure functions — fully unit-testable.

Evaluation order (matches docs/06-NAMESPACE-AND-POLICY-MODEL.md):

    1. Caller identity already established (auth.py)
    2. URI normalized + traversal-checked (namespace.py)
    3. Check `deny` list for the operation — any match → DENY
    4. Check `allow` list for the operation — any match → ALLOW
    5. Default → DENY

Deny ALWAYS wins. There is no implicit allow.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

from .namespace import matches_glob
from .policy_loader import ProfilePolicy

Operation = Literal["read", "write"]
Decision  = Literal["allow", "deny"]


@dataclass(frozen=True, slots=True)
class PolicyVerdict:
    decision: Decision
    reason: str            # human-readable; goes to audit log
    matched_rule: str | None  # the glob that matched (allow or deny)


def evaluate(
    policy: ProfilePolicy,
    operation: Operation,
    uri: str,
) -> PolicyVerdict:
    """Return the verdict for (profile, operation, uri)."""
    if operation == "read":
        deny_list  = policy.read_deny
        allow_list = policy.read_allow
    elif operation == "write":
        deny_list  = policy.write_deny
        allow_list = policy.write_allow
    else:
        return PolicyVerdict(decision="deny", reason=f"unknown operation {operation!r}", matched_rule=None)

    # 1. Explicit deny wins, always.
    for rule in deny_list:
        if matches_glob(uri, rule):
            return PolicyVerdict(
                decision="deny",
                reason=f"matched deny rule for {operation}",
                matched_rule=rule,
            )

    # 2. Allow if any allow rule matches.
    for rule in allow_list:
        if matches_glob(uri, rule):
            return PolicyVerdict(
                decision="allow",
                reason=f"matched allow rule for {operation}",
                matched_rule=rule,
            )

    # 3. Default deny.
    return PolicyVerdict(
        decision="deny",
        reason=f"no allow rule matched for {operation}",
        matched_rule=None,
    )
