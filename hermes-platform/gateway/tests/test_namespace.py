"""Tests for gateway/app/namespace.py — URI parsing + glob matching."""

from __future__ import annotations

import pytest

from app.namespace import NamespaceError, matches_glob, parse_uri


# ─── parse_uri: happy paths ─────────────────────────────────────────────────

@pytest.mark.parametrize("uri,top,profile,sub", [
    ("viking://shared/org",              "shared",   None,    ("org",)),
    ("viking://shared/org/subteam",      "shared",   None,    ("org", "subteam")),
    ("viking://shared/",                 "shared",   None,    ()),
    ("viking://profiles/mark",           "profiles", "mark",  ()),
    ("viking://profiles/mark/",          "profiles", "mark",  ()),
    ("viking://profiles/mark/notes",     "profiles", "mark",  ("notes",)),
    ("viking://profiles/mark/notes/a/b", "profiles", "mark",  ("notes", "a", "b")),
    ("viking://profiles/wifey-2/x",      "profiles", "wifey-2", ("x",)),
    ("viking://profiles/test_1/y",       "profiles", "test_1",  ("y",)),
])
def test_parse_uri_happy(uri, top, profile, sub):
    p = parse_uri(uri)
    assert p.top == top
    assert p.profile == profile
    assert p.sub == sub


# ─── parse_uri: rejections ──────────────────────────────────────────────────

@pytest.mark.parametrize("uri,fragment_of_reason", [
    ("",                                       "must start with 'viking://'"),
    ("http://shared/x",                        "must start with 'viking://'"),
    ("viking:///foo",                          "empty path segment"),
    ("viking://shared//foo",                   "empty path segment"),
    ("viking://shared/foo/./bar",              "path traversal"),
    ("viking://shared/foo/../bar",             "path traversal"),
    ("viking://profiles/mark/../../etc/passwd","path traversal"),
    ("viking://other/foo",                     "unknown top-level"),
    ("viking://profiles",                      "missing profile name"),  # parser correctly identifies the missing name
    ("viking://profiles/",                     "missing profile name"),
    ("viking://profiles/MARK/foo",             "profile name 'MARK' does not match"),
    ("viking://profiles/1mark/foo",            "does not match"),
    ("viking://profiles/mark.bad/foo",         "does not match"),
    ("viking://shared/foo\\bar",               "control characters or backslash"),
    ("viking://shared/foo\x00bar",             "control characters or backslash"),
])
def test_parse_uri_rejects(uri, fragment_of_reason):
    with pytest.raises(NamespaceError) as ei:
        parse_uri(uri)
    assert fragment_of_reason in str(ei.value), \
        f"expected {fragment_of_reason!r} in {ei.value!r}"


def test_parse_uri_type_error():
    with pytest.raises(NamespaceError):
        parse_uri(None)  # type: ignore[arg-type]


# ─── matches_glob ───────────────────────────────────────────────────────────

@pytest.mark.parametrize("uri,pattern,expected", [
    # ** matches zero or more segments
    ("viking://shared/org",              "viking://shared/**",                True),
    ("viking://shared/org/sub/deep",     "viking://shared/**",                True),
    ("viking://shared",                  "viking://shared/**",                True),  # zero-segment

    # * matches exactly one segment
    ("viking://shared/org",              "viking://shared/*",                 True),
    ("viking://shared/org/sub",          "viking://shared/*",                 False),
    ("viking://profiles/mark/notes",     "viking://profiles/*/notes",         True),
    ("viking://profiles/steve/notes/x",  "viking://profiles/*/notes",         False),

    # Exact pattern with **
    ("viking://profiles/mark/notes",     "viking://profiles/mark/**",         True),
    ("viking://profiles/mark/notes/x",   "viking://profiles/mark/**",         True),
    ("viking://profiles/steve/notes",    "viking://profiles/mark/**",         False),

    # ? matches one char in a segment
    ("viking://shared/abc",              "viking://shared/a?c",               True),
    ("viking://shared/abc/x",            "viking://shared/a?c",               False),

    # approved/<self>/** pattern (the collaboration-write rule)
    ("viking://shared/approved/mark/x",  "viking://shared/approved/mark/**",  True),
    ("viking://shared/approved/steve/x", "viking://shared/approved/mark/**",  False),
])
def test_matches_glob(uri, pattern, expected):
    assert matches_glob(uri, pattern) is expected


def test_matches_glob_rejects_bad_pattern():
    with pytest.raises(NamespaceError):
        matches_glob("viking://shared/x", "shared/x")  # missing scheme
