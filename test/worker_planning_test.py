"""Fast unit checks for Music 3 semantic-plan policy (no model download)."""

import hashlib
import importlib.util
import json
import os
import re
import unittest
from pathlib import Path

try:
    import numpy as np
except ModuleNotFoundError:  # The packaged worker environment always has it.
    np = None


WORKER_PATH = Path(
    os.environ.get(
        "MAXMUSIC_WORKER_PATH",
        Path(__file__).resolve().parents[1] / "worker" / "minimax_worker.py",
    )
)
FIXTURE_PATH = Path(
    os.environ.get(
        "MAXMUSIC_COMFY_FIXTURE",
        Path(__file__).resolve().parents[1]
        / "test-artifacts"
        / "comfy-duration-gate"
        / "comfy-ascending-v2-20260816"
        / "report.json",
    )
)
SPEC = importlib.util.spec_from_file_location("maxmusic_worker", WORKER_PATH)
WORKER = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(WORKER)


class SemanticPlanPolicyTests(unittest.TestCase):
    def test_duration_ballpark_is_a_quarter_either_way_with_a_floor(self):
        self.assertEqual(WORKER.duration_ballpark(30), (15.0, 45.0))
        self.assertEqual(WORKER.duration_ballpark(60), (45.0, 75.0))
        self.assertEqual(WORKER.duration_ballpark(210), (157.5, 262.5))
        self.assertEqual(WORKER.duration_ballpark(300), (225.0, 360.0))

    def test_a_five_minute_request_is_not_answered_with_fifty_seconds(self):
        self.assertFalse(WORKER.plan_is_in_ballpark(50.0, 300.0))
        self.assertEqual(WORKER.ballpark_miss(50.0, 300.0), 175.0)
        # Shorter than asked but recognisably the song that was ordered.
        self.assertTrue(WORKER.plan_is_in_ballpark(240.0, 300.0))
        self.assertEqual(WORKER.ballpark_miss(240.0, 300.0), 0.0)
        # Overshooting counts too, and the shortest songs keep absolute slack.
        self.assertFalse(WORKER.plan_is_in_ballpark(120.0, 60.0))
        self.assertTrue(WORKER.plan_is_in_ballpark(20.0, 30.0))

    def test_the_plan_that_answers_the_request_is_the_one_that_is_rendered(self):
        def plan(attempt, planned, target=300.0, natural=True):
            return {
                "attempt": attempt,
                "plannedSeconds": planned,
                "semanticAccepted": natural,
                "ballparkMiss": WORKER.ballpark_miss(planned, target),
            }

        # A composition that hit the frame ceiling never wins, however close to
        # the requested length it stopped.
        self.assertFalse(WORKER.plan_beats(plan(1, 290.0, natural=False), None))

        # The first complete plan is the incumbent; a closer one takes over.
        first = plan(1, 90.0)
        self.assertTrue(WORKER.plan_beats(first, None))
        closer = plan(2, 260.0)
        self.assertTrue(WORKER.plan_beats(closer, first))

        # Once a plan is inside the band nothing else can beat it, so the run
        # stops there rather than shopping for a rounder number.
        self.assertEqual(closer["ballparkMiss"], 0.0)
        self.assertFalse(WORKER.plan_beats(plan(3, 300.0), closer))
        self.assertFalse(WORKER.plan_beats(plan(3, 100.0), closer))

    def test_candidate_seeds_are_reproducible_and_distinct(self):
        self.assertEqual(WORKER.candidate_seed(42, 0), 42)
        self.assertEqual(WORKER.candidate_seed(42, 1), 104771)
        self.assertEqual(WORKER.candidate_seed(42, 2), 209500)

    def test_comfy_planner_uses_the_supplied_hard_completion_ceiling(self):
        self.assertEqual(WORKER.comfy_candidate_seed(910210, 0), 910210)
        self.assertEqual(WORKER.comfy_candidate_seed(910210, 1), 1910210)
        self.assertEqual(WORKER.comfy_candidate_seed(910210, 2), 2910210)
        self.assertEqual(WORKER.comfy_generation_ceiling(30, 45), 45.0)
        self.assertEqual(WORKER.comfy_generation_ceiling(210, 231), 231.0)
        self.assertEqual(WORKER.comfy_generation_ceiling(300, 330), 330.0)
        self.assertEqual(WORKER.comfy_generation_ceiling(90, 999), 360.0)

    def test_a_natural_ending_is_about_eos_not_about_length(self):
        # This predicate answers one question only: did the model stop because
        # the composition resolved, or because it ran out of frames? Whether
        # the result answers the request is a separate judgement.
        self.assertTrue(WORKER.semantic_plan_is_natural(117.08, 360.0))
        self.assertTrue(WORKER.semantic_plan_is_natural(25.0, 360.0))
        self.assertFalse(WORKER.semantic_plan_is_natural(359.4, 360.0))
        self.assertFalse(WORKER.semantic_plan_is_natural(360.0, 360.0))

    def test_sampling_seed_matches_comfyui_music3_derivation(self):
        self.assertEqual(WORKER.derive_sampling_seed(42, "ar"), 146933486985881370)
        self.assertEqual(WORKER.derive_sampling_seed(910060, "ar"), 2532519809750802265)

    def test_plan_attempts_are_bounded(self):
        self.assertEqual(WORKER.DEFAULT_PLAN_ATTEMPTS, 4)
        self.assertEqual(WORKER.clamp_plan_attempts(None), WORKER.DEFAULT_PLAN_ATTEMPTS)
        self.assertEqual(WORKER.clamp_plan_attempts(0), 1)
        self.assertEqual(WORKER.clamp_plan_attempts(99), WORKER.MAX_PLAN_ATTEMPTS)

    def test_target_cannot_exceed_generation_ceiling(self):
        self.assertEqual(WORKER.clamp_target_duration(210, 227), 210.0)
        self.assertEqual(WORKER.clamp_target_duration(240, 227), 227.0)

    def test_lyrics_match_comfyui_section_whitespace(self):
        source = "[Intro]\nFirst line.\n\n[Verse] Same-line words.\n\n[OUTRO]\nLast line."
        self.assertEqual(
            WORKER.tidy_lyrics(source),
            "[intro]\nFirst line.\n[verse]\nSame-line words.\n[outro]\nLast line.",
        )

    def test_terminal_outro_is_repaired_without_losing_words(self):
        source = "[verse]\nFirst line.\n[outro]\nLast line.\n[instrumental]"
        repaired = WORKER.normalize_song_ending(source)
        self.assertEqual(
            repaired,
            "[verse]\nFirst line.\n[instrumental]\n[outro]\nLast line.",
        )
        self.assertEqual(re.findall(r"\b(?:First|line|Last)\b", repaired), ["First", "line", "Last", "line"])

    def test_missing_outro_receives_a_bare_terminal_section(self):
        self.assertEqual(
            WORKER.normalize_song_ending("[verse]\nKeep every word."),
            "[verse]\nKeep every word.\n[outro]",
        )

    def test_terminal_lyric_guard_accepts_the_final_line_near_song_end(self):
        lyrics = (
            "[verse]\nNight opens softly over the city.\n"
            "[outro]\nThe final chord settles into dawn.\n"
            "At last, the silver river carries us safely home."
        )
        result = WORKER.assess_lyric_completion(
            lyrics,
            "Night opens softly. The final chord settles into dawn. "
            "At last the silver river carries us safely home.",
        )
        self.assertEqual(result["verdict"], "pass")
        self.assertTrue(result["finalWordNearEnd"])

    def test_terminal_lyric_guard_tolerates_normal_singing_asr_mistakes(self):
        result = WORKER.assess_lyric_completion(
            "[outro]\nLet our two absences become one living chord",
            "Beloved unknown, take the tender dissonance I cannot hide. "
            "Let our two absence become one Living Core",
        )
        self.assertEqual(result["verdict"], "pass")
        self.assertGreaterEqual(result["fuzzyTerminalSimilarity"], 0.88)
        self.assertEqual(result["fuzzyTerminalEndGapWords"], 0)

    def test_terminal_lyric_guard_rejects_a_clean_early_ending(self):
        lyrics = (
            "[verse]\nBreathe with the drums as the old echoes fall.\n"
            "[outro]\nNow every restless light grows quiet.\n"
            "At last, the silver river carries us safely home."
        )
        result = WORKER.assess_lyric_completion(
            lyrics,
            "Breathe with the drums as the old echoes fall.",
        )
        self.assertEqual(result["verdict"], "fail")
        self.assertEqual(result["reason"], "terminal-lyric-missing")
        self.assertFalse(result["finalWordNearEnd"])

    def test_short_terminal_line_is_anchored_with_the_line_before_it(self):
        words = WORKER.terminal_lyric_words(
            "[outro]\nThe last bell resolves under rain.\nGo home."
        )
        self.assertEqual(words, ["the", "last", "bell", "resolves", "under", "rain", "go", "home"])

    def test_full_lyric_coverage_excludes_structure_tags(self):
        words = WORKER.all_lyric_words(
            "[verse]\nNight opens softly.\n[bridge]\nHold the light.\n[outro]\nSafely home."
        )
        self.assertEqual(
            words,
            ["night", "opens", "softly", "hold", "the", "light", "safely", "home"],
        )

    def test_lyric_verifier_adds_a_tail_window_when_boundary_splits_the_ending(self):
        self.assertEqual(
            WORKER.lyric_verification_windows(193, 90),
            [
                (0, 90, "coverage"),
                (90, 180, "coverage"),
                (180, 193, "coverage"),
                (103, 193, "terminal-tail"),
            ],
        )

    def test_lyric_verifier_reuses_an_aligned_final_coverage_window(self):
        self.assertEqual(
            WORKER.lyric_verification_windows(180, 90),
            [
                (0, 90, "coverage"),
                (90, 180, "coverage-and-terminal"),
            ],
        )

    def test_comfy_release_accepts_an_empty_success_response(self):
        original_runtime = WORKER.RUNTIME
        original_request = WORKER._comfy_request
        calls = []
        try:
            WORKER.RUNTIME = "comfy"
            WORKER._comfy_request = lambda path, **options: calls.append((path, options)) or b""
            studio = WORKER.Studio()
            self.assertTrue(studio.unload(reason="unit test"))
            self.assertEqual(calls[0][0], "/free")
            self.assertEqual(
                calls[0][1]["payload"],
                {"unload_models": True, "free_memory": True},
            )
            self.assertIn("accelerator memory released", studio.note)
        finally:
            WORKER.RUNTIME = original_runtime
            WORKER._comfy_request = original_request

    @unittest.skipIf(np is None, "numpy is installed in the worker image, not this host Python")
    def test_loud_boundary_gets_an_adaptive_fade_and_silence(self):
        sample_rate = 1000
        original = np.full((2, sample_rate * 3), 0.25, dtype=np.float32)
        finished, report = WORKER.finish_waveform(original, sample_rate, np)
        self.assertEqual(report["action"], "adaptive-fade")
        self.assertEqual(report["before"]["signalVerdict"], "fail")
        self.assertEqual(report["after"]["signalVerdict"], "pass")
        self.assertEqual(finished.shape[-1], original.shape[-1] + 250)
        self.assertEqual(float(finished[0, -1]), 0.0)
        np.testing.assert_array_equal(finished[:, :1500], original[:, :1500])

    @unittest.skipIf(np is None, "numpy is installed in the worker image, not this host Python")
    def test_natural_decay_is_not_modified(self):
        sample_rate = 1000
        original = np.full((1, sample_rate * 3), 0.2, dtype=np.float32)
        original[:, -sample_rate:] *= np.linspace(1.0, 0.0, sample_rate, dtype=np.float32)
        finished, report = WORKER.finish_waveform(original, sample_rate, np)
        self.assertEqual(report["action"], "natural-decay")
        self.assertEqual(report["after"]["signalVerdict"], "pass")
        np.testing.assert_array_equal(finished, original)

    @unittest.skipUnless(FIXTURE_PATH.is_file(), "accepted ComfyUI fixture is not mounted")
    def test_accepted_fixture_matches_comfyui_model_lyrics_hash(self):
        report = json.loads(FIXTURE_PATH.read_text())
        fixture = next(
            item
            for item in report["results"]
            if item["target"] == 60 and item.get("accepted") is not False
        )
        parts = re.split(r"\s*(\[[^\]]+\])\s*", fixture["lyrics"])
        comfy_model_lyrics = "[start]\n" + "\n".join(
            part.lower() if part.startswith("[") else part
            for part in parts
            if part
        )
        native_model_lyrics = "[start]\n" + WORKER.tidy_lyrics(fixture["lyrics"])
        self.assertEqual(native_model_lyrics, comfy_model_lyrics)
        self.assertEqual(
            hashlib.sha256(native_model_lyrics.encode()).hexdigest(),
            "8e40c08e63d3f31f46aa4c1f347b759a03acac6f8beb70b8d2f14db49e33f968",
        )


if __name__ == "__main__":
    unittest.main()
