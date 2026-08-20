#!/usr/bin/env python3
from __future__ import annotations

import tempfile
import unittest
from datetime import timedelta
from pathlib import Path
from unittest.mock import patch

from retention_common import explain_safety, ignored_path_is_derived, isoformat, normalize_remote, parse_worktree_porcelain, utc_now
from reap import block_fetch_failures, linked_worktree_paths


class RetentionPolicyTests(unittest.TestCase):
    def safe_record(self):
        return {
            "kind": "worktree",
            "exists": True,
            "head": "abc",
            "dirty": False,
            "orphanRisk": "none",
            "mergedIntoMain": True,
            "remoteRefsContaining": ["refs/remotes/origin/main"],
            "unpushedCommits": 0,
            "activeProcesses": [],
            "registration": {
                "state": "active",
                "expiresAt": isoformat(utc_now() - timedelta(hours=1)),
            },
        }

    def test_expired_safe_copy_is_eligible(self):
        decision, _ = explain_safety(self.safe_record())
        self.assertEqual(decision, "reap:eligible")

    def test_every_safety_uncertainty_wins_over_expiry(self):
        cases = [
            ("dirty", True, "keep:dirty"),
            ("dirty", None, "keep:unknown"),
            ("orphanRisk", "high", "keep:orphan"),
            ("mergedIntoMain", False, "keep:unmerged"),
            ("remoteRefsContaining", [], "keep:unreachable"),
            ("unpushedCommits", None, "keep:unknown"),
            ("unpushedCommits", 1, "keep:unpushed"),
            ("activeProcesses", [{"pid": 1}], "keep:active"),
        ]
        for field, value, expected in cases:
            with self.subTest(field=field, value=value):
                record = self.safe_record()
                record[field] = value
                self.assertEqual(explain_safety(record)[0], expected)

    def test_unregistered_safe_copy_escalates(self):
        record = self.safe_record()
        record["registration"] = None
        self.assertEqual(explain_safety(record)[0], "review:unregistered")

    def test_live_lease_keeps_copy(self):
        record = self.safe_record()
        record["registration"]["expiresAt"] = isoformat(utc_now() + timedelta(hours=1))
        self.assertEqual(explain_safety(record)[0], "keep:leased")

    def test_remote_normalization(self):
        expected = "github.com/oscout/scout"
        self.assertEqual(normalize_remote("git@github.com:oscout/scout.git"), expected)
        self.assertEqual(normalize_remote("https://github.com/oscout/scout.git"), expected)

    def test_only_known_derived_ignored_paths_are_allowlisted(self):
        self.assertTrue(ignored_path_is_derived("design/studio/.next/cache/file"))
        self.assertTrue(ignored_path_is_derived("apps/macos/.build/object"))
        self.assertTrue(ignored_path_is_derived("packages/agent-sessions/dist/"))
        self.assertTrue(ignored_path_is_derived("packages/runtime/dist/index.js"))
        self.assertTrue(ignored_path_is_derived("apps/macos/dist/Scout.app"))
        self.assertTrue(ignored_path_is_derived("landing/openscout.app/out/"))
        self.assertTrue(ignored_path_is_derived("landing/openscout.app/out/index.html"))
        self.assertTrue(ignored_path_is_derived("landing/openscout.app/next-env.d.ts"))
        self.assertTrue(ignored_path_is_derived("design/studio/next-env.d.ts"))
        self.assertTrue(ignored_path_is_derived("design/studio/tsconfig.tsbuildinfo"))
        self.assertTrue(ignored_path_is_derived("packages/scout-native-core/.swiftpm/config"))
        self.assertTrue(ignored_path_is_derived("packages/cli/bin/scoutd"))
        self.assertFalse(ignored_path_is_derived("docs/out/idea.md"))
        self.assertFalse(ignored_path_is_derived("tools/dist/hand-authored.js"))
        self.assertFalse(ignored_path_is_derived("packages/cli/bin/release-notes.txt"))
        self.assertFalse(ignored_path_is_derived("notes/next-env.d.ts"))
        self.assertFalse(ignored_path_is_derived(".env.local"))
        self.assertFalse(ignored_path_is_derived("notes/private.txt"))

    def test_cargo_target_needs_the_tag_not_the_name(self):
        # Without a root there is no evidence, so ``target`` stays non-derived.
        self.assertFalse(ignored_path_is_derived("target/debug/scoutd"))
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            (root / "target" / "debug").mkdir(parents=True)
            (root / "tools" / "target").mkdir(parents=True)
            # A hand-authored directory that merely shares the name is untagged
            # and must keep blocking retirement.
            self.assertFalse(ignored_path_is_derived("tools/target/notes.md", root))
            self.assertFalse(ignored_path_is_derived("target/debug/scoutd", root))
            (root / "target" / "CACHEDIR.TAG").write_text("Signature: 8a477f597d28d172789f06886806bc55\n")
            self.assertTrue(ignored_path_is_derived("target/debug/scoutd", root))
            self.assertTrue(ignored_path_is_derived("target/", root))
            # The tag on one target says nothing about a different one.
            self.assertFalse(ignored_path_is_derived("tools/target/notes.md", root))

    def test_worktree_porcelain_parser(self):
        records = parse_worktree_porcelain("worktree /a\nHEAD abc\nbranch refs/heads/main\n\nworktree /b\nHEAD def\ndetached\n")
        self.assertEqual(records[0]["worktree"], "/a")
        self.assertEqual(records[1]["detached"], "true")

    def test_failed_fetch_blocks_only_its_git_store(self):
        failed = Path("/git/failed")
        records = [
            {"commonDir": failed, "decision": "reap:eligible", "decisionReasons": []},
            {"commonDir": Path("/git/fresh"), "decision": "reap:eligible", "decisionReasons": []},
        ]

        block_fetch_failures(records, {failed})

        self.assertEqual(records[0]["decision"], "keep:unknown")
        self.assertIn("fetch failed", records[0]["decisionReasons"][0])
        self.assertEqual(records[1]["decision"], "reap:eligible")

    @patch("reap.git_text")
    def test_independent_clone_reports_linked_worktrees(self, git_text_mock):
        git_text_mock.return_value = (
            "worktree /copies/owner\nHEAD abc\nbranch refs/heads/main\n\n"
            "worktree /copies/feature\nHEAD def\nbranch refs/heads/feature\n"
        )

        self.assertEqual(
            linked_worktree_paths(Path("/copies/owner")),
            [Path("/copies/feature")],
        )

    @patch("reap.git_text", return_value=None)
    def test_unreadable_worktree_ownership_fails_closed(self, _git_text_mock):
        self.assertIsNone(linked_worktree_paths(Path("/copies/owner")))


if __name__ == "__main__":
    unittest.main()
