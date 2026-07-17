import importlib.util
import unittest
from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import patch


BRIDGE_PATH = Path(__file__).resolve().parents[1] / "agent-chat-bridge.py"
SPEC = importlib.util.spec_from_file_location("agent_chat_bridge_test", BRIDGE_PATH)
bridge = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(bridge)


def cron_job(**overrides):
    job = {
        "id": "job-one",
        "enabled": True,
        "state": "scheduled",
        "created_at": "2026-07-01T00:00:00+00:00",
        "schedule": {"kind": "cron", "expr": "0 * * * *"},
        "next_run_at": "2026-07-17T03:00:00+00:00",
        "last_run_at": "2026-07-17T00:00:05+00:00",
        "fire_claim": None,
    }
    job.update(overrides)
    return job


class AgentBridgeCronCatchupTests(unittest.TestCase):
    def test_latest_due_inside_offline_window_is_selected(self):
        due = datetime(2026, 7, 17, 1, 0, tzinfo=timezone.utc)
        with patch.object(bridge, "_cron_latest_expr_due", return_value=due):
            result = bridge._cron_missed_due_at(
                cron_job(), "2026-07-17T00:30:00Z", "2026-07-17T02:00:00Z")
        self.assertEqual(result, due.isoformat())

    def test_failed_execution_still_counts_as_an_attempt(self):
        due = datetime(2026, 7, 17, 1, 0, tzinfo=timezone.utc)
        job = cron_job(last_run_at="2026-07-17T01:00:10+00:00", last_status="error")
        with patch.object(bridge, "_cron_latest_expr_due", return_value=due):
            result = bridge._cron_missed_due_at(
                job, "2026-07-17T00:30:00Z", "2026-07-17T02:00:00Z")
        self.assertIsNone(result)

    def test_fire_claim_counts_as_attempt_after_mid_run_crash(self):
        due = datetime(2026, 7, 17, 1, 0, tzinfo=timezone.utc)
        job = cron_job(last_run_at=None, fire_claim={"at": "2026-07-17T01:00:02+00:00"})
        with patch.object(bridge, "_cron_latest_expr_due", return_value=due):
            result = bridge._cron_missed_due_at(
                job, "2026-07-17T00:30:00Z", "2026-07-17T02:00:00Z")
        self.assertIsNone(result)

    def test_due_before_last_heartbeat_is_not_recovered(self):
        due = datetime(2026, 7, 17, 0, 0, tzinfo=timezone.utc)
        with patch.object(bridge, "_cron_latest_expr_due", return_value=due):
            result = bridge._cron_missed_due_at(
                cron_job(last_run_at=None),
                "2026-07-17T00:30:00Z", "2026-07-17T02:00:00Z")
        self.assertIsNone(result)


if __name__ == "__main__":
    unittest.main()
