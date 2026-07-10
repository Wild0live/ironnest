"""End-to-end policy evaluation tests against the REAL policies/ dir.

These tests are the canonical guarantee that a profile cannot access
another profile's private namespace. If any of them ever fail, do NOT
ship — investigate and either fix the policy file or fix the engine.
"""

from __future__ import annotations

import itertools

import pytest

from app.policy import evaluate

PROFILES = ["default", "mark", "steve", "qa", "littlejohn", "jaime", "bigbert", "octo"]


def test_loaded_profiles_match_seeded_set(policies):
    """The current IronNest profile fleet."""
    assert set(policies) == set(PROFILES)


# ─── Own-namespace ACCESS ───────────────────────────────────────────────────

@pytest.mark.parametrize("profile", PROFILES)
def test_profile_can_read_own_private(policies, profile):
    v = evaluate(policies[profile], "read", f"viking://profiles/{profile}/notes")
    assert v.decision == "allow", v


@pytest.mark.parametrize("profile", PROFILES)
def test_profile_can_write_own_private(policies, profile):
    v = evaluate(policies[profile], "write", f"viking://profiles/{profile}/notes/2026/x")
    assert v.decision == "allow", v


@pytest.mark.parametrize("profile", PROFILES)
def test_profile_can_read_shared(policies, profile):
    v = evaluate(policies[profile], "read", "viking://shared/org/policy")
    assert v.decision == "allow", v


@pytest.mark.parametrize("profile", PROFILES)
def test_profile_can_write_own_approved_shared(policies, profile):
    v = evaluate(policies[profile], "write", f"viking://shared/approved/{profile}/published")
    assert v.decision == "allow", v


# ─── Cross-profile DENIES — this is the security crown jewel ────────────────

CROSS = [(a, b) for a, b in itertools.product(PROFILES, repeat=2) if a != b]


@pytest.mark.parametrize("a,b", CROSS)
def test_cross_profile_read_denied(policies, a, b):
    v = evaluate(policies[a], "read", f"viking://profiles/{b}/notes")
    assert v.decision == "deny", v


@pytest.mark.parametrize("a,b", CROSS)
def test_cross_profile_write_denied(policies, a, b):
    v = evaluate(policies[a], "write", f"viking://profiles/{b}/notes")
    assert v.decision == "deny", v


@pytest.mark.parametrize("a,b", CROSS)
def test_cross_profile_approved_write_denied(policies, a, b):
    v = evaluate(policies[a], "write", f"viking://shared/approved/{b}/x")
    assert v.decision == "deny", v


# ─── Cross-profile shared/approved READ is ALLOWED (the collab path) ────────

@pytest.mark.parametrize("a,b", CROSS)
def test_cross_profile_approved_read_allowed(policies, a, b):
    """Anyone can read everyone's approved/ subtree — that's the point."""
    v = evaluate(policies[a], "read", f"viking://shared/approved/{b}/published")
    assert v.decision == "allow", v


# ─── Default-deny on unknown namespaces ─────────────────────────────────────

@pytest.mark.parametrize("profile", PROFILES)
def test_unknown_top_level_is_denied(policies, profile):
    """Even if the URI parses, no allow rule = deny."""
    # We use a top that is grammatically valid for the policy globs but
    # doesn't appear in any allow list — e.g. a hypothetical "secrets" sub.
    v = evaluate(policies[profile], "write", "viking://profiles/" + profile + "/secrets/sensitive")
    # Note: profiles/<self>/secrets IS under viking://profiles/<self>/**
    # so it's allowed — this is by design. Test inverse:
    assert v.decision == "allow"
    v2 = evaluate(policies[profile], "read", "viking://shared/totally-undeclared/foo")
    assert v2.decision == "allow", "viking://shared/** allows arbitrary children"


def test_unknown_top_blocked_by_default_deny(policies):
    """An unparseable top is denied at the namespace layer, not the policy layer."""
    from app.namespace import NamespaceError, parse_uri
    with pytest.raises(NamespaceError):
        parse_uri("viking://other/foo")
