"""viking:// URI parsing + traversal-safe normalization.

The gateway accepts URIs in two top-level forms:

    viking://shared/<path>
    viking://profiles/<profile-name>/<path>

These map to OpenViking's native namespace as described in
spec/namespaces.yaml. All translation happens here (and in
openviking_client.py); no other module concatenates URI fragments.

Path safety rules — rejected with NamespaceError:

    * absent or non-viking scheme
    * empty segments (e.g. "viking://shared//foo" — collapsed double slash)
    * "." or ".." segments (path traversal)
    * backslash, NUL, or control characters (windows/poison paths)
    * profile-name not matching ^[a-z][a-z0-9_-]{0,31}$ (registry rule)
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Literal

NamespaceTop = Literal["shared", "profiles"]

_PROFILE_NAME_RE = re.compile(r"^[a-z][a-z0-9_-]{0,31}$")
_BAD_CHARS_RE = re.compile(r"[\x00-\x1f\x7f\\]")


class NamespaceError(ValueError):
    """Raised for any invalid viking:// URI."""


@dataclass(frozen=True, slots=True)
class ParsedURI:
    """Result of parse_uri(). Immutable."""

    top: NamespaceTop          # "shared" or "profiles"
    profile: str | None        # set when top == "profiles"
    sub: tuple[str, ...]       # remaining path segments (may be empty for the namespace root)

    @property
    def is_root(self) -> bool:
        return len(self.sub) == 0

    def render(self) -> str:
        """Re-render the canonical form (for logging/audit)."""
        if self.top == "shared":
            tail = "/".join(self.sub)
            return f"viking://shared/{tail}".rstrip("/")
        return f"viking://profiles/{self.profile}/{'/'.join(self.sub)}".rstrip("/")


def parse_uri(uri: str) -> ParsedURI:
    """Parse + validate a viking:// URI. Returns ParsedURI or raises NamespaceError."""
    if not isinstance(uri, str):
        raise NamespaceError(f"uri must be str, got {type(uri).__name__}")
    if _BAD_CHARS_RE.search(uri):
        raise NamespaceError("uri contains control characters or backslash")
    if not uri.startswith("viking://"):
        raise NamespaceError(f"uri must start with 'viking://': {uri!r}")

    # strip scheme
    body = uri[len("viking://"):]

    # tokenize
    parts = body.split("/")
    if "" in parts:  # double slash, leading/trailing slash collapsed to empty segment
        # allow exactly one trailing slash on a namespace-root URI like "viking://shared/"
        if parts.count("") == 1 and parts[-1] == "":
            parts = parts[:-1]
        else:
            raise NamespaceError(f"uri contains empty path segment: {uri!r}")

    if not parts:
        raise NamespaceError(f"uri is empty after scheme: {uri!r}")

    for seg in parts:
        if seg in (".", ".."):
            raise NamespaceError(f"path traversal segment {seg!r} in uri: {uri!r}")

    top = parts[0]
    if top == "shared":
        return ParsedURI(top="shared", profile=None, sub=tuple(parts[1:]))

    if top == "profiles":
        if len(parts) < 2:
            raise NamespaceError(f"profiles/ uri missing profile name: {uri!r}")
        profile = parts[1]
        if not _PROFILE_NAME_RE.match(profile):
            raise NamespaceError(
                f"profile name {profile!r} does not match {_PROFILE_NAME_RE.pattern}"
            )
        return ParsedURI(top="profiles", profile=profile, sub=tuple(parts[2:]))

    raise NamespaceError(
        f"unknown top-level namespace {top!r} (expected 'shared' or 'profiles'): {uri!r}"
    )


def matches_glob(uri: str, pattern: str) -> bool:
    """Match a viking:// uri against a policy glob like 'viking://shared/**'.

    Supported glob syntax (intentionally narrow):
        *   — exactly one path segment, any characters except '/'
        **  — zero or more path segments
        ?   — exactly one character within a segment

    Implementation is pure-python (no fnmatch globbing across '/').
    """
    parts = parse_uri(uri)
    pattern_parts = parse_pattern(pattern)
    uri_segments = _flatten(parts)
    return _segments_match(uri_segments, pattern_parts)


def parse_pattern(pattern: str) -> list[str]:
    """Split a glob pattern into segments. Validates the scheme prefix."""
    if not pattern.startswith("viking://"):
        raise NamespaceError(f"glob pattern must start with viking://: {pattern!r}")
    body = pattern[len("viking://"):]
    if body == "":
        raise NamespaceError(f"glob pattern is empty after scheme: {pattern!r}")
    return body.split("/")


def _flatten(p: ParsedURI) -> list[str]:
    """Render a ParsedURI as a flat segment list (for glob matching)."""
    if p.top == "shared":
        return ["shared", *p.sub]
    return ["profiles", p.profile or "", *p.sub]


def _segments_match(uri_segs: list[str], pat_segs: list[str]) -> bool:
    """Recursive ** matcher (segment-aware, '/' never matched by '*')."""
    # Trim trailing empty segments (rendered URI root case)
    while uri_segs and uri_segs[-1] == "":
        uri_segs.pop()
    while pat_segs and pat_segs[-1] == "":
        pat_segs.pop()

    if not pat_segs:
        return not uri_segs

    head, *rest = pat_segs

    if head == "**":
        # Try matching ** against 0..len(uri_segs) leading segments
        if not rest:
            return True
        for i in range(len(uri_segs) + 1):
            if _segments_match(uri_segs[i:], rest):
                return True
        return False

    if not uri_segs:
        return False

    if _single_segment_match(uri_segs[0], head):
        return _segments_match(uri_segs[1:], rest)
    return False


def _single_segment_match(segment: str, pattern: str) -> bool:
    """Match one segment against a pattern with '*' and '?' (no '/')."""
    if "/" in pattern:
        return False
    # convert to a regex anchored to the full segment
    regex_parts: list[str] = []
    for ch in pattern:
        if ch == "*":
            regex_parts.append(r"[^/]*")
        elif ch == "?":
            regex_parts.append(r"[^/]")
        else:
            regex_parts.append(re.escape(ch))
    rx = re.compile("^" + "".join(regex_parts) + "$")
    return bool(rx.match(segment))
