import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from app import main


class MissionControlCronRecoveryTests(unittest.TestCase):
    def setUp(self):
        self.tempdir = tempfile.TemporaryDirectory()
        self.state_file = Path(self.tempdir.name) / "cron-recovery.json"
        self.state_patch = patch.object(main, "CRON_RECOVERY_STATE_FILE", self.state_file)
        self.state_patch.start()

    def tearDown(self):
        self.state_patch.stop()
        self.tempdir.cleanup()

    def state(self):
        return json.loads(self.state_file.read_text(encoding="utf-8"))

    def test_first_start_initializes_heartbeat_without_replaying_history(self):
        with patch.object(main, "_profiles", return_value=[{"name": "mark"}]):
            main._prepare_cron_recovery("2026-07-17T00:00:00Z")
        state = self.state()
        self.assertEqual(state["last_seen_at"], "2026-07-17T00:00:00Z")
        self.assertEqual(state["pending_windows"], [])

    def test_restart_records_only_the_offline_interval(self):
        with patch.object(main, "_profiles", return_value=[{"name": "mark"}]):
            main._prepare_cron_recovery("2026-07-17T00:00:00Z")
            main._prepare_cron_recovery("2026-07-17T02:00:00Z")
        window = self.state()["pending_windows"][0]
        self.assertEqual(window["window_start"], "2026-07-17T00:00:00Z")
        self.assertEqual(window["window_end"], "2026-07-17T02:00:00Z")
        self.assertEqual(window["target_profiles"], ["mark"])

    def test_successful_profile_catchup_completes_window(self):
        profile = {"name": "mark", "container_name": "hermes-pf-mark"}
        with patch.object(main, "_profiles", return_value=[profile]):
            main._prepare_cron_recovery("2026-07-17T00:00:00Z")
            main._prepare_cron_recovery("2026-07-17T02:00:00Z")
            with patch.object(main, "_post_agent_cron_catchup",
                              return_value=("mark", {"ok": True, "ran": []})) as post:
                main._process_cron_recovery_windows()
        self.assertEqual(self.state()["pending_windows"], [])
        args = post.call_args.args
        self.assertEqual(args[0], profile)
        self.assertIsNone(args[1])
        self.assertEqual(args[2:], ("2026-07-17T00:00:00Z", "2026-07-17T02:00:00Z"))

    def test_unreachable_profile_keeps_window_for_retry(self):
        profile = {"name": "mark", "container_name": "hermes-pf-mark"}
        with patch.object(main, "_profiles", return_value=[profile]), \
             patch.object(main, "_post_agent_cron_catchup",
                          return_value=("mark", {"ok": False, "error": "offline"})):
            main._prepare_cron_recovery("2026-07-17T00:00:00Z")
            main._prepare_cron_recovery("2026-07-17T02:00:00Z")
            main._process_cron_recovery_windows()
        self.assertEqual(len(self.state()["pending_windows"]), 1)


if __name__ == "__main__":
    unittest.main()
