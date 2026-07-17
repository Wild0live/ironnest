import unittest
from pathlib import Path

from app import main


class MissionControlActivityTests(unittest.TestCase):
    def test_streaming_activity_preempts_legacy_thinking_dots(self):
        app_js = (Path(main.__file__).parent / "static" / "app.js").read_text(encoding="utf-8")
        self.assertIn('m.streaming && !m.text && !m.activity', app_js)

    def test_bridge_activity_gets_a_second_allowlist_pass(self):
        event = main._safe_activity_event({
            "event": "tool", "id": "tc-read", "category": "read",
            "label": "Reading a file", "status": "completed",
            "detail": "mission-control/app/main.py",
            "rawInput": {"path": "/run/secrets/token"},
            "rawOutput": "secret contents",
        })
        self.assertEqual(event, {
            "event": "tool", "id": "tc-read", "label": "Reading a file",
            "category": "read", "status": "completed",
            "detail": "mission-control/app/main.py",
        })

    def test_sensitive_detail_is_removed(self):
        event = main._safe_activity_event({
            "event": "tool", "id": "tc-read", "category": "read",
            "label": "Reading a file", "status": "in_progress",
            "detail": "config/.env",
        })
        self.assertNotIn("detail", event)

    def test_unknown_activity_and_status_labels_are_rejected(self):
        self.assertIsNone(main._safe_activity_event({"event": "thought", "text": "private"}))
        self.assertIsNone(main._safe_activity_event({
            "event": "status", "label": "Reveal hidden prompt", "status": "in_progress",
        }))

    def test_summary_collapses_tool_updates_and_does_not_persist_ids(self):
        summary = main._activity_summary([
            {"event": "tool", "id": "tc-one", "label": "Searching files",
             "category": "search", "status": "in_progress", "detail": "app"},
            {"event": "tool", "id": "tc-one", "label": "Searching files",
             "category": "search", "status": "completed", "detail": "app"},
            {"event": "plan", "label": "Plan updated · 1 steps",
             "entries": [{"content": "Inspect the implementation", "status": "completed"}]},
        ], "completed", "2026-07-17T00:00:00Z", 2.34)
        self.assertEqual(summary["tool_count"], 1)
        self.assertEqual(summary["elapsed_s"], 2.3)
        self.assertEqual(summary["milestones"][0]["status"], "completed")
        self.assertNotIn("id", summary["milestones"][0])
        self.assertEqual(summary["plan"][0]["content"], "Inspect the implementation")


if __name__ == "__main__":
    unittest.main()
