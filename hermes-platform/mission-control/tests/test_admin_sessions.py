import unittest
import json
from datetime import datetime, timedelta, timezone
from unittest.mock import MagicMock, patch

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

    def test_legacy_security_keys_omit_unknown_transport_hint(self):
        descriptor = main._credential_descriptor({"id": "usb-key"})
        self.assertEqual(descriptor, {
            "type": "public-key", "id": "usb-key",
        })

    def test_registered_transport_hints_are_sanitized(self):
        descriptor = main._credential_descriptor({
            "id": "key", "transports": ["USB", "hybrid", "unsupported", "usb"],
        })
        self.assertEqual(descriptor["transports"], ["usb", "hybrid"])

    def test_operator_can_reject_pending_operation_without_runner_dispatch(self):
        store = {"operations": [{
            "id": "op-one", "status": "pending_approval", "action": "docker_api",
            "target": "workload", "requested_by": "octo", "reason": "Stop workload",
        }]}
        operator = {"subject": "phoenix", "name": "Phoenix"}
        with patch.object(main, "_read_store", return_value=store), \
             patch.object(main, "_write_store") as write_store, \
             patch.object(main, "_notify_operation_thread") as notify:
            response = main.operations_reject(
                "op-one", main.OperationRejection(note="Not approved"), operator)
        payload = json.loads(response.body)
        self.assertTrue(payload["ok"])
        self.assertEqual(store["operations"][0]["status"], "rejected")
        self.assertEqual(store["operations"][0]["rejected_by"], "phoenix")
        self.assertEqual(store["operations"][0]["rejection_note"], "Not approved")
        notify.assert_called_once_with(store["operations"][0], "rejected")
        write_store.assert_called_once_with(store)

    def test_rejection_is_terminal_and_cannot_be_repeated(self):
        store = {"operations": [{"id": "op-one", "status": "rejected"}]}
        with patch.object(main, "_read_store", return_value=store), \
             patch.object(main, "_write_store") as write_store:
            with self.assertRaises(main.HTTPException) as raised:
                main.operations_reject(
                    "op-one", main.OperationRejection(),
                    {"subject": "phoenix", "name": "Phoenix"})
        self.assertEqual(raised.exception.status_code, 409)
        write_store.assert_not_called()

    def test_rejected_operation_cannot_enter_fido_or_runner_path(self):
        store = {"operations": [{"id": "op-one", "status": "rejected"}]}
        approval = main.OperationApproval(approved_by="Phoenix", webauthn={})
        with patch.object(main, "_operations_enabled", return_value=True), \
             patch.object(main, "_read_store", return_value=store), \
             patch.object(main, "_verify_webauthn_assertion") as verify:
            with self.assertRaises(main.HTTPException) as raised:
                main.operations_approve(
                    "op-one", approval,
                    {"subject": "phoenix", "name": "Phoenix"})
        self.assertEqual(raised.exception.status_code, 409)
        verify.assert_not_called()

    def test_agent_reply_binds_referenced_operation_to_exact_conversation(self):
        operation_id = "op-" + "a" * 32
        store = {"operations": [{
            "id": operation_id, "status": "pending_approval",
            "requested_by": "littlejohn", "action": "host_powershell",
            "target": "localhost", "reason": "Remediate software",
        }]}
        with patch.object(main, "list_conversations", return_value=[{"id": "c-origin"}]), \
             patch.object(main, "_read_store", return_value=store), \
             patch.object(main, "_write_store") as write_store, \
             patch.object(main, "_notify_operation_thread") as notify:
            main._bind_operation_references(
                "littlejohn", "c-origin", f"Pending approval: `{operation_id}`")
        item = store["operations"][0]
        self.assertEqual(item["conversation_id"], "c-origin")
        self.assertEqual(item["conversation_binding"], "agent-reply")
        notify.assert_called_once_with(item, "requested")
        write_store.assert_called_once_with(store)

    def test_operation_notification_waits_for_conversation_binding(self):
        item = {"id": "op-" + "b" * 32, "requested_by": "octo"}
        with patch.object(main, "_profiles", return_value=[{"name": "octo"}]), \
             patch.object(main, "conv_append") as append:
            main._notify_operation_thread(item, "executing")
        append.assert_not_called()
        self.assertNotIn("operation_events", item)

    def test_operation_notification_is_idempotent_and_queues_agent_ack(self):
        item = {
            "id": "op-" + "c" * 32, "requested_by": "octo",
            "conversation_id": "c-origin", "action": "docker_api",
            "target": "eligible-app", "status": "executing",
        }
        with patch.object(main, "_profiles", return_value=[{"name": "octo"}]), \
             patch.object(main, "conv_history", return_value=[]), \
             patch.object(main, "conv_append") as append, \
             patch.object(main, "_schedule_next_operation_agent_ack") as schedule:
            main._notify_operation_thread(item, "executing")
        self.assertEqual(item["operation_events"], ["executing"])
        self.assertEqual(append.call_count, 1)
        message = append.call_args.args[2]
        self.assertEqual(message["operation_event_id"], f"{item['id']}:executing")
        schedule.assert_called_once_with(item)

    def test_terminal_agent_prompt_preserves_authoritative_failure(self):
        item = {
            "id": "op-" + "d" * 32, "action": "host_powershell",
            "target": "localhost", "result": {"error": "remediation id is not allowlisted"},
        }
        prompt = main._operation_ack_prompt(item, "failed")
        self.assertIn("remediation id is not allowlisted", prompt)
        self.assertIn("do not claim the requested change succeeded", prompt)
        self.assertIn("Do not call tools", prompt)

    def test_operation_ack_delivery_uses_same_bridge_conversation(self):
        item = {
            "id": "op-" + "e" * 32, "requested_by": "littlejohn",
            "conversation_id": "c-origin", "action": "host_powershell",
            "target": "localhost", "status": "executing", "operation_events": ["executing"],
        }
        response = MagicMock()
        response.__enter__.return_value = response
        response.read.return_value = json.dumps({
            "ok": True, "reply": "I received your approval; the operation is executing now."
        }).encode()
        with patch.object(main, "_profiles", return_value=[{
                 "name": "littlejohn", "container_name": "hermes-pf-littlejohn"}]), \
             patch.object(main, "conv_history", return_value=[]), \
             patch.object(main.urllib.request, "urlopen", return_value=response) as urlopen, \
             patch.object(main, "conv_append") as append, \
             patch.object(main, "_read_store", return_value={"operations": []}):
            main._deliver_operation_agent_ack(item, "executing", f"{item['id']}:executing")
        request_body = json.loads(urlopen.call_args.args[0].data)
        self.assertEqual(request_body["session"], "c-origin")
        self.assertIn("FIDO approval was cryptographically verified", request_body["message"])
        message = append.call_args.args[2]
        self.assertEqual(message["role"], "agent")
        self.assertTrue(message["operation_ack"])


if __name__ == "__main__":
    unittest.main()
