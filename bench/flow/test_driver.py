#!/usr/bin/env python3
"""Planted external-wire violations for flow-gate's semantic checks."""

import importlib.util
import io
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location("flow_driver", Path(__file__).with_name("driver.py"))
driver = importlib.util.module_from_spec(spec)
spec.loader.exec_module(driver)


class FlowChecks(unittest.TestCase):
    def test_empty_success_streams_are_rejected(self):
        for check in (driver.check_chat, driver.check_claude, driver.check_snapshots):
            with self.subTest(check=check.__name__), self.assertRaisesRegex(AssertionError, "empty"):
                check([])

    def test_bulk_loss_and_usage_duplication_are_rejected(self):
        good = list(driver.bulk_records(2))
        driver.check_bulk(good, 2)
        nullable = [driver.event({**driver.payload(good[0]), "usage": None}), *good[1:]]
        driver.check_bulk(nullable, 2)
        for broken in ([good[-1]], good[1:], [*good[:2], *good[3:]],
                       [*good[:-1], good[-2], good[-1]]):
            with self.subTest(records=len(broken)), self.assertRaises(AssertionError):
                driver.check_bulk(broken, 2)

    def test_signature_erasure_is_rejected(self):
        good = list(driver.claude_records())
        driver.check_claude(good)
        erased = [r.replace(driver.SIGNATURE[:8].encode(), b"") for r in good]
        with self.assertRaisesRegex(AssertionError, "signature"):
            driver.check_claude(erased)

    def test_interleaved_choice_overwrite_is_rejected(self):
        good = list(driver.chat_records())
        driver.check_chat(good)
        overwritten = [r.replace(b'"index":1', b'"index":0') for r in good]
        with self.assertRaisesRegex(AssertionError, "choice"):
            driver.check_chat(overwritten)

    def test_logprobs_only_loss_is_rejected(self):
        good = list(driver.chat_records())
        lost = [r for r in good if b'"logprobs"' not in r]
        with self.assertRaisesRegex(AssertionError, "logprobs"):
            driver.check_chat(lost)

    def test_snapshot_disagreement_is_rejected(self):
        good = list(driver.response_records())
        driver.check_snapshots(good)
        changed = [r.replace("hello 世界".encode(), b"wrong") if b'"type":"response.completed"' in r else r for r in good]
        with self.assertRaisesRegex(AssertionError, "snapshot"):
            driver.check_snapshots(changed)

    def test_partial_record_cannot_advance_cursor(self):
        with self.assertRaisesRegex(AssertionError, "truncated"):
            list(driver.records(io.BytesIO(b'id: v1.e.1\ndata: {"x":1}\n')))
        with self.assertRaisesRegex(AssertionError, "cursor"):
            driver.cursor(b'data: {"x":1}\n\n')


if __name__ == "__main__":
    unittest.main()
