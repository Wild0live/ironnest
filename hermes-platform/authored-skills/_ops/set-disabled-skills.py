#!/usr/bin/env python3
"""Set skills.disabled to a proper YAML list, preserving config.yaml formatting.

Used to prune unambiguously-recreational, off-mandate skills from the six
"professional" IronNest agents. Bigbert and Wifey are intentionally left fully
stocked. Reversible: re-run with a shorter list, or set back to ["airtable"].
"""
import sys
from ruamel.yaml import YAML

DISABLED = [
    "airtable",                 # needs API keys; off by default platform-wide
    "minecraft-modpack-server", # gaming — no agent mandate
    "pokemon-player",           # gaming — no agent mandate
    "yuanbao",                  # foreign LLM-chat skill — irrelevant
    "spotify",                  # music — off-mandate for the work agents
    "openhue",                  # Philips Hue control — off-mandate for the work agents
]

path = sys.argv[1] if len(sys.argv) > 1 else "/opt/data/config.yaml"
yaml = YAML()  # round-trip: preserves comments, order, styles
yaml.preserve_quotes = True
with open(path) as f:
    cfg = yaml.load(f)
if cfg.get("skills") is None:
    cfg["skills"] = {}
cfg["skills"]["disabled"] = DISABLED
with open(path, "w") as f:
    yaml.dump(cfg, f)
print("OK skills.disabled ->", list(cfg["skills"]["disabled"]))
