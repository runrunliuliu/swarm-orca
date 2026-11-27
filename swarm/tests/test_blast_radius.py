"""The (e) path policy: a diff that touches only a skill is not a no-op.

`core.test_offline_baseline` pins the selector's invariants for Python sources, test modules and
shared helpers. The path policy added for `skills/incident-triage/**` answers a different question
— "which module pins this document?" — and it is answered by data (`PATH_MAP`) because no AST scan
can see a file read by path. Data that is wrong fails quietly, so it gets its own assertions here:
the mapping names a module that actually exists, it wins over the "non-Python is skipped" fallback,
and a mapping that has gone stale fails closed instead of selecting nothing.

The git diff is the only input patched; the module tree, the radius and `main`'s output split are
the real ones, so these assertions fail if the selector stops honouring the policy.
"""

import io
import json
import unittest
from contextlib import redirect_stderr, redirect_stdout
from unittest.mock import patch

import blast_radius

SKILL = "swarm/skills/incident-triage/SKILL.md"
CONTRACT = "swarm/skills/incident-triage/contract.example.json"
PINNING_MODULE = "core.test_incident_triage_skill"


class PathPolicyTests(unittest.TestCase):
    def setUp(self):
        self.blast = blast_radius
        self.radius = blast_radius.Radius()

    def test_the_skill_directory_maps_to_the_module_that_pins_it(self):
        self.assertEqual(self.blast.path_policy_modules(SKILL), (PINNING_MODULE,))
        self.assertEqual(self.blast.path_policy_modules(CONTRACT), (PINNING_MODULE,))
        self.assertEqual(self.blast.path_policy_modules("swarm/skills/other/SKILL.md"), ())

    def test_every_mapped_module_is_a_listed_module(self):
        # Why: a renamed test module would leave the mapping selecting nothing, which is the
        # "green while under-testing" hole this policy exists to close.
        for prefix, modules in self.blast.PATH_MAP.items():
            self.assertTrue(prefix.startswith("swarm/"), prefix)
            for module in modules:
                self.assertIn(module, self.radius.available,
                              f"{prefix} -> {module} is not a module --list prints")

    def test_a_skill_only_diff_selects_the_pinning_module(self):
        with patch.object(self.blast, "changed_paths", return_value=[SKILL, CONTRACT]):
            selection, skipped, removed, unmapped = self.blast.select("HEAD")
        self.assertEqual(selection, {SKILL: {PINNING_MODULE: "path"},
                                      CONTRACT: {PINNING_MODULE: "path"}})
        self.assertEqual((skipped, removed, unmapped), ([], [], []))

    def test_a_stale_mapping_fails_closed_instead_of_selecting_nothing(self):
        with patch.object(self.blast, "PATH_MAP",
                          {"swarm/skills/incident-triage/": ("core.test_gone",)}), \
                patch.object(self.blast, "changed_paths", return_value=[SKILL]):
            selection, skipped, removed, unmapped = self.blast.select("HEAD")
        self.assertEqual(selection, {})
        self.assertEqual(unmapped, [SKILL])

    def test_auto_evolve_documents_and_dynamic_scripts_share_a_radius(self):
        paths = ["swarm/skills/auto-evolve/" + suffix for suffix in
                 ("SKILL.md", "references/rpc.md", "scripts/rpc.py", "scripts/rpc_transport.py")]
        with patch.object(self.blast, "changed_paths", return_value=paths):
            selection, skipped, removed, unmapped = self.blast.select("HEAD")
        self.assertEqual(selection, {path: {"core.test_auto_evolve": "path"} for path in paths})
        self.assertEqual((skipped, removed, unmapped), ([], [], []))

    def test_a_stale_python_path_mapping_also_fails_closed(self):
        script = "swarm/skills/auto-evolve/scripts/rpc.py"
        with patch.object(self.blast, "PATH_MAP",
                          {"swarm/skills/auto-evolve/": ("core.test_gone",)}), \
                patch.object(self.blast, "changed_paths", return_value=[script]):
            selection, skipped, removed, unmapped = self.blast.select("HEAD")
        self.assertEqual(selection, {})
        self.assertEqual((skipped, removed, unmapped), ([], [], [script]))

    def test_a_path_without_a_mapping_is_skipped_not_silently_selected(self):
        design_doc = "swarm/docs/design/issue-sedimentation.md"
        with patch.object(self.blast, "changed_paths", return_value=[design_doc]):
            selection, skipped, removed, unmapped = self.blast.select("HEAD")
        self.assertEqual(selection, {})
        self.assertEqual(skipped, [design_doc])
        self.assertEqual(unmapped, [])

    def test_main_reports_the_selection_and_exits_zero(self):
        with patch.object(self.blast, "changed_paths", return_value=[SKILL]), \
                redirect_stdout(io.StringIO()) as out, redirect_stderr(io.StringIO()) as err:
            code = self.blast.main(["--range", "HEAD~0"])
        self.assertEqual(code, 0, err.getvalue())
        self.assertIn(f"{PINNING_MODULE} (path)", out.getvalue())
        self.assertIn("selection: 1/", out.getvalue())

    def test_json_stays_on_stdout_and_the_human_lines_on_stderr(self):
        with patch.object(self.blast, "changed_paths", return_value=[SKILL]), \
                redirect_stdout(io.StringIO()) as out, redirect_stderr(io.StringIO()) as err:
            code = self.blast.main(["--range", "HEAD~0", "--json"])
        self.assertEqual(code, 0, err.getvalue())
        self.assertEqual(json.loads(out.getvalue()),
                         {"modules": [PINNING_MODULE], "unmapped": [], "skipped": [],
                          "removed": []})
        self.assertIn("path", err.getvalue())


if __name__ == "__main__":
    unittest.main()
