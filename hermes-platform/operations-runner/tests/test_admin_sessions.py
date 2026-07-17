import json
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import patch

from app import main


class AdminRunnerSecurityTests(unittest.TestCase):
    def container(self, name="eligible-app", labels=None, mounts=None):
        return {"Name": f"/{name}", "Config": {"Labels": labels or {}}, "Mounts": mounts or []}

    def test_explicit_enrollment_is_accepted(self):
        with patch.object(main, "ELIGIBLE_CONTAINERS", frozenset({"eligible-app"})), \
             patch.object(main, "PROTECTED_CONTAINERS", frozenset()), \
             patch.object(main, "docker_call", return_value=(200, json.dumps(self.container()))):
            self.assertEqual(main.require_eligible_container("eligible-app")["Name"], "/eligible-app")

    def test_protected_name_overrides_enrollment(self):
        with patch.object(main, "ELIGIBLE_CONTAINERS", frozenset({"operations-runner"})), \
             patch.object(main, "PROTECTED_CONTAINERS", frozenset({"operations-runner"})):
            with self.assertRaises(main.HTTPException) as raised:
                main.require_eligible_container("operations-runner")
            self.assertEqual(raised.exception.status_code, 403)

    def test_docker_socket_holder_is_always_protected(self):
        info = self.container(mounts=[{"Destination": "/var/run/docker.sock"}])
        with patch.object(main, "ELIGIBLE_CONTAINERS", frozenset({"eligible-app"})), \
             patch.object(main, "PROTECTED_CONTAINERS", frozenset()), \
             patch.object(main, "docker_call", return_value=(200, json.dumps(info))):
            with self.assertRaises(main.HTTPException) as raised:
                main.require_eligible_container("eligible-app")
            self.assertEqual(raised.exception.status_code, 403)

    def test_legacy_lifecycle_cannot_bypass_protected_label(self):
        info = self.container(labels={main.PROTECTED_LABEL: main.PROTECTED_VALUE})
        with patch.object(main, "ALLOW_ALL_CONTAINERS", True), \
             patch.object(main, "PROTECTED_CONTAINERS", frozenset()), \
             patch.object(main, "docker_call", return_value=(200, json.dumps(info))):
            self.assertFalse(main.lifecycle_target_allowed("eligible-app"))

    def test_container_cannot_self_assign_security_labels_at_create(self):
        body = {"Image": "nginx:alpine", "Labels": {main.ELIGIBILITY_LABEL: main.ELIGIBILITY_VALUE}}
        with self.assertRaises(main.HTTPException) as raised:
            main.validate_create(body, {"name": ["factory-test"]})
        self.assertEqual(raised.exception.status_code, 403)

    def test_expired_session_is_rejected(self):
        expired = (datetime.now(timezone.utc) - timedelta(seconds=1)).isoformat()
        state = {"admin_session": {"session_id": "oas-1234567890123456", "status": "active",
                                   "expires_at": expired}, "executed": {}, "factory_exec_ids": {}}
        with tempfile.TemporaryDirectory() as directory, \
             patch.object(main, "STATE_FILE", Path(directory) / "state.json"):
            with self.assertRaises(main.HTTPException) as raised:
                main.active_session(state, "oas-1234567890123456")
            self.assertEqual(raised.exception.status_code, 403)

    def test_active_session_rejects_destructive_delete(self):
        request = main.AdminSessionAction(
            session_id="oas-1234567890123456", request_id="op-12345678",
            action="docker_api", target="eligible-app",
            docker_request={"method": "DELETE", "path": "/v1.47/containers/eligible-app", "body": {}},
        )
        with self.assertRaises(main.HTTPException) as raised:
            main.validate_session_request(request, {})
        self.assertEqual(raised.exception.status_code, 403)

    def test_step_up_delete_must_match_approved_target(self):
        request = main.DockerRequest(method="DELETE", path="/v1.47/containers/other-app", body={})
        with self.assertRaises(main.HTTPException) as raised:
            main.validate_factory_request(request, {}, "eligible-app")
        self.assertEqual(raised.exception.status_code, 400)

    def test_step_up_lifecycle_accepts_enrolled_existing_workload(self):
        request = main.DockerRequest(
            method="POST", path="/v1.47/containers/openclaw-gateway/stop", body={})
        with patch.object(main, "require_eligible_container") as eligible:
            method, endpoint, payload = main.validate_factory_request(
                request, {}, "openclaw-gateway")
        self.assertEqual((method, endpoint, payload),
                         ("POST", "/v1.47/containers/openclaw-gateway/stop", b"{}"))
        eligible.assert_called_once_with("openclaw-gateway")

    def test_step_up_lifecycle_must_match_approved_target(self):
        request = main.DockerRequest(
            method="POST", path="/v1.47/containers/other-app/stop", body={})
        with self.assertRaises(main.HTTPException) as raised:
            main.validate_factory_request(request, {}, "eligible-app")
        self.assertEqual(raised.exception.status_code, 400)

    def test_step_up_lifecycle_keeps_protected_workload_denied(self):
        request = main.DockerRequest(
            method="POST", path="/v1.47/containers/openclaw-infisical-agent/stop", body={})
        denied = main.HTTPException(status_code=403, detail="container is protected")
        with patch.object(main, "require_eligible_container", side_effect=denied):
            with self.assertRaises(main.HTTPException) as raised:
                main.validate_factory_request(request, {}, "openclaw-infisical-agent")
        self.assertEqual(raised.exception.status_code, 403)


if __name__ == "__main__":
    unittest.main()
