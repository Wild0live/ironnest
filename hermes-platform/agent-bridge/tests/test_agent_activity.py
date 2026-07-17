import importlib.util
import unittest
from pathlib import Path


BRIDGE_PATH = Path(__file__).resolve().parents[1] / "agent-chat-bridge.py"
SPEC = importlib.util.spec_from_file_location("agent_chat_bridge_activity_test", BRIDGE_PATH)
bridge = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(bridge)


class AgentBridgeActivityTests(unittest.TestCase):
    def test_raw_command_and_secret_never_leave_bridge(self):
        tools = {}
        event = bridge._activity_event_from_update({
            "sessionUpdate": "tool_call", "toolCallId": "tc-one",
            "kind": "execute", "title": "terminal: curl -H 'Bearer abcdef' https://example",
            "rawInput": {"command": "curl -H 'Bearer top-secret-token' https://example"},
            "status": "in_progress",
        }, tools)
        self.assertEqual(event, {
            "event": "tool", "id": "tc-one", "label": "Running a command",
            "category": "execute", "status": "in_progress",
        })
        self.assertNotIn("rawInput", event)
        self.assertNotIn("top-secret", str(event))

    def test_workspace_path_is_sanitized_to_relative_detail(self):
        event = bridge._activity_event_from_update({
            "sessionUpdate": "tool_call", "toolCallId": "tc-read",
            "kind": "read", "title": "read: /opt/data/workspace/app/main.py",
            "rawInput": {"path": "/opt/data/workspace/app/main.py"},
        }, {})
        self.assertEqual(event["detail"], "app/main.py")
        self.assertEqual(event["label"], "Reading a file")

    def test_sensitive_path_detail_is_omitted(self):
        event = bridge._activity_event_from_update({
            "sessionUpdate": "tool_call", "toolCallId": "tc-secret",
            "kind": "read", "title": "read: /opt/data/workspace/.env",
            "rawInput": {"path": "/opt/data/workspace/.env"},
        }, {})
        self.assertNotIn("detail", event)

    def test_raw_thought_chunk_is_discarded(self):
        event = bridge._activity_event_from_update({
            "sessionUpdate": "agent_thought_chunk",
            "content": {"type": "text", "text": "private chain of thought"},
        }, {})
        self.assertIsNone(event)

    def test_plan_values_are_bounded_and_secret_values_redacted(self):
        event = bridge._activity_event_from_update({
            "sessionUpdate": "plan", "entries": [
                {"content": "Call API with token=super-secret-value", "status": "in_progress"},
            ],
        }, {})
        self.assertEqual(event["entries"][0]["content"], "Call API with token=[redacted]")

    def test_completion_update_reuses_only_sanitized_start_metadata(self):
        tools = {}
        bridge._activity_event_from_update({
            "sessionUpdate": "tool_call", "toolCallId": "tc-read", "kind": "read",
            "title": "read: /opt/data/workspace/docs/guide.md",
            "rawInput": {"path": "/opt/data/workspace/docs/guide.md"},
        }, tools)
        event = bridge._activity_event_from_update({
            "sessionUpdate": "tool_call_update", "toolCallId": "tc-read",
            "status": "completed", "rawOutput": "entire private file contents",
        }, tools)
        self.assertEqual(event["status"], "completed")
        self.assertEqual(event["detail"], "docs/guide.md")
        self.assertNotIn("private file", str(event))


if __name__ == "__main__":
    unittest.main()
