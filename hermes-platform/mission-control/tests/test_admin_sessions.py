import unittest
from datetime import datetime, timedelta, timezone
from unittest.mock import patch

from starlette.requests import Request

from app import main


class _AutheliaResponse:
    status = 200
    headers = {"Remote-User": "phoenix", "Remote-Name": "Phoenix", "Remote-Groups": "admins"}

    def __enter__(self):
        return self

    def __exit__(self, *_):
        return False


def request(cookie=""):
    headers = [] if not cookie else [(b"cookie", cookie.encode())]
    return Request({"type": "http", "method": "POST", "path": "/api/test",
                    "headers": headers, "scheme": "https", "server": ("mission.ironnest.local", 443)})


class MissionControlAdminSecurityTests(unittest.TestCase):
    def test_internal_request_without_authelia_cookie_is_denied(self):
        with self.assertRaises(main.HTTPException) as raised:
            main.require_admin(request())
        self.assertEqual(raised.exception.status_code, 401)

    def test_operator_identity_comes_from_authelia_verification(self):
        with patch.object(main.urllib.request, "urlopen", return_value=_AutheliaResponse()):
            identity = main.require_admin(request("authelia_session=opaque"))
        self.assertEqual(identity["subject"], "phoenix")

    def test_webauthn_requires_user_verification_not_only_presence(self):
        only_presence = b"x" * 32 + bytes([0x01]) + b"\0\0\0\0"
        with self.assertRaises(main.HTTPException) as raised:
            main._parse_authenticator_data(only_presence)
        self.assertEqual(raised.exception.status_code, 403)
        verified = b"x" * 32 + bytes([0x05]) + b"\0\0\0\0"
        with patch.object(main, "APPROVAL_WEBAUTHN_RP_ID", "test"), \
             patch.object(main.hashlib, "sha256") as digest:
            digest.return_value.digest.return_value = b"x" * 32
            self.assertTrue(main._parse_authenticator_data(verified)["flags"] & 0x04)

    def test_single_active_session_is_enforced(self):
        now = datetime.now(timezone.utc)
        store = {"octo_admin_sessions": [{
            "session_id": "oas-one", "status": "active",
            "issued_at": now.isoformat(), "last_activity_at": now.isoformat(),
            "expires_at": (now + timedelta(minutes=10)).isoformat(),
        }, {
            "session_id": "oas-two", "status": "active",
            "issued_at": now.isoformat(), "last_activity_at": now.isoformat(),
            "expires_at": (now + timedelta(minutes=10)).isoformat(),
        }]}
        with self.assertRaises(main.HTTPException) as raised:
            main._active_octo_admin_session(store)
        self.assertEqual(raised.exception.status_code, 409)

    def test_unbound_legacy_credential_is_not_usable(self):
        operator = {"subject": "phoenix", "name": "Phoenix"}
        store = {"approval_webauthn": {"credentials": [{
            "id": "legacy-key", "name": "Legacy key", "public_key_cose": "unused",
        }], "challenges": []}}
        self.assertEqual(main._operator_webauthn_credentials(store, operator), [])
        with self.assertRaises(main.HTTPException) as raised:
            main._verify_webauthn_assertion(
                store, {"id": "operation-one"}, {"rawId": "legacy-key"}, operator)
        self.assertEqual(raised.exception.status_code, 403)
        self.assertIn("re-enrolled", str(raised.exception.detail))

    def test_legacy_security_keys_get_usb_transport_hint(self):
        descriptor = main._credential_descriptor({"id": "usb-key"})
        self.assertEqual(descriptor, {
            "type": "public-key", "id": "usb-key", "transports": ["usb"],
        })

    def test_registered_transport_hints_are_sanitized(self):
        descriptor = main._credential_descriptor({
            "id": "key", "transports": ["USB", "hybrid", "unsupported", "usb"],
        })
        self.assertEqual(descriptor["transports"], ["usb", "hybrid"])


if __name__ == "__main__":
    unittest.main()
