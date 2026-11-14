#!/usr/bin/env python3
"""Planted external-wire violations for flow-gate's semantic checks."""

import importlib.util
import base64
import hashlib
import http.client
import io
import json
from pathlib import Path
import re
import queue
import struct
import threading
import time
from types import SimpleNamespace
import urllib.parse
import unittest
from unittest import mock

spec = importlib.util.spec_from_file_location("flow_driver", Path(__file__).with_name("driver.py"))
driver = importlib.util.module_from_spec(spec)
spec.loader.exec_module(driver)


class Response(io.BytesIO):
    def __init__(self, body=b"", status=200, headers=None):
        super().__init__(body)
        self.status, self.headers = status, headers or {}

    def getheader(self, name, default=None):
        return self.headers.get(name, default)


class Connection:
    def close(self):
        pass


class ResumePeer:
    """Independent retained-output model; mutations change observable responses."""
    def __init__(self, kind="e", violation=None):
        self.kind, self.violation = kind, violation
        self.units = [f"id: v1.e.{i}\n".encode() + value for i, value in enumerate(driver.bulk_records(160), 1)]
        self.body = b"".join(self.units) if kind == "e" else driver.MEDIA
        self.end = len(self.units) if kind == "e" else len(self.body)
        self.mime = "text/event-stream" if kind == "e" else "audio/mpeg"
        self.up = type("Up", (), {})()
        self.up.release = threading.Event()
        self.up.done = threading.Event()
        self.up.done.set()
        self.up.error = None
        self.up.requests = [{}]
        self.up.progress = [{"kind": "write", "time": time.monotonic()}]
        self.invalid_seen = []

    def response(self, body, after, initial=False):
        headers = {"X-Ck-Stream-Id": "retained", "X-Ck-Stream-Cursor": after,
                   "Cache-Control": "no-cache" if initial else "no-store",
                   "Content-Type": self.mime, "Content-Encoding": "identity"}
        if self.violation == ("initial-cursor" if initial else "accepted-cursor"):
            headers["X-Ck-Stream-Cursor"] = f"v1.{self.kind}.999"
        for label, key in (("identity", "X-Ck-Stream-Id"), ("cache", "Cache-Control"),
                           ("mime", "Content-Type"), ("encoding", "Content-Encoding")):
            if self.violation == label and not initial:
                headers[key] = "changed"
        return Connection(), Response(body, headers=headers)

    def request(self, method, path, body=None, headers=None, **_):
        if method == "POST":
            return self.response(self.body, f"v1.{self.kind}.0", initial=True)
        fields = list((headers or {}).items()) if isinstance(headers, dict) else list(headers or ())
        ids = [v for k, v in fields if k.lower() == "x-ck-stream-id"]
        mapping = dict(fields)
        query = urllib.parse.parse_qs(urllib.parse.urlsplit(path).query, keep_blank_values=True)
        after, last = query.get("after", [None])[0], mapping.get("Last-Event-ID")
        label = None
        if len(ids) != 1:
            label = "missing-id" if not ids else "duplicate-id"
        elif mapping.get("Authorization") == f"Bearer {driver.OTHER_KEY}":
            return Connection(), Response(status=200 if self.violation == "foreign-access" else
                                           400 if self.violation == "auth-precedence" else 410)
        elif ids[0] != "retained":
            return Connection(), Response(status=200 if self.violation == "unknown-restarts" else 410)
        elif after is None and last is None:
            label = "missing-position"
        elif last is not None and (self.kind != "e" or (after is not None and last != after)):
            label = "last-event-mismatch" if after is not None else "byte-last-event"
        else:
            after = after if after is not None else last
            match = re.fullmatch(r"v1\.([eb])\.([0-9]+)", after)
            if not match:
                label = "malformed:" + after
            elif match[1] != self.kind:
                label = "wrong-kind"
            elif int(match[2]) > (1 << 64) - 1:
                label = "overflow"
            elif int(match[2]) > self.end:
                label = "future"
        if label:
            self.invalid_seen.append(label)
            return Connection(), Response(status=200 if self.violation == label else 400)
        position = int(after.rsplit(".", 1)[1])
        suffix = b"".join(self.units[position:]) if self.kind == "e" else self.body[position:]
        if self.violation == "suffix":
            suffix = suffix[1:]
        if self.violation == "last-event-replay" and last is not None:
            suffix = self.body
        return self.response(suffix, after)


class ResumeChecks(unittest.TestCase):
    def test_every_invalid_attachment_is_rejected(self):
        for kind in ("e", "b"):
            good = ResumePeer(kind)
            driver.check_invalid_attachments(good, "retained", kind, good.end)
            for label in good.invalid_seen:
                with self.subTest(kind=kind, violation=label), self.assertRaises(AssertionError):
                    bad = ResumePeer(kind, label)
                    driver.check_invalid_attachments(bad, "retained", kind, bad.end)

    def test_sse_replay_and_headers(self):
        good = ResumePeer()
        conn, response = good.request("POST", "/unused")
        driver.check_resume(good, response, conn, True)
        for label in ("initial-cursor", "accepted-cursor", "identity", "cache", "encoding", "last-event-replay", "suffix",
                      "foreign-access", "auth-precedence", "unknown-restarts"):
            with self.subTest(violation=label), self.assertRaises(AssertionError):
                bad = ResumePeer(violation=label)
                conn, response = bad.request("POST", "/unused")
                driver.check_resume(bad, response, conn, True)

    def test_media_replay_and_headers(self):
        driver.run_scenario(ResumePeer("b"), "media-resume")
        for label in ("initial-cursor", "accepted-cursor", "identity", "cache", "mime", "encoding", "suffix"):
            with self.subTest(violation=label), self.assertRaises(AssertionError):
                driver.run_scenario(ResumePeer("b", label), "media-resume")


def reencoded_unit(unit):
    opcode, data = unit
    if opcode != 1:
        return unit
    value = json.loads(data)
    field = {"response.audio.delta": "delta", "input_audio_buffer.append": "audio"}.get(value.get("type"))
    if field and value[field].endswith("="):
        alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"
        encoded = value[field]
        position = len(encoded.rstrip("=")) - 1
        replacement = alphabet[alphabet.index(encoded[position]) + 1]
        value[field] = encoded[:position] + replacement + encoded[position + 1:]
    return opcode, json.dumps(dict(reversed(list(value.items()))), ensure_ascii=True, indent=2).encode()


class DuplexPeer:
    def __init__(self, violation=None):
        self.violation = violation
        self.release, self.detached, self.done = (threading.Event() for _ in range(3))
        self.received, self.sessions, self.error = [], 0, None
        self.active = []
        self.threads = []

    def connect(self, path, headers):
        resumed = path.startswith("/v1/streams?")
        after = urllib.parse.parse_qs(urllib.parse.urlsplit(path).query).get("after", [None])[0]
        terminal = after == "v1.e.82"
        if resumed:
            driver.require(dict(headers).get("X-Ck-Stream-Id") == "retained", "identity missing at reattach")
            driver.require(after in ("v1.e.65", "v1.e.82"),
                           "driver advanced past a lost response marker")
        left, right = Pipe(), Pipe()
        left.other, right.other = right, left
        server = driver.realtime.WebSocket(right, masked=False)
        self.active.append(server)

        def handshake():
            try:
                request = right.readline().decode().split()
                driver.require(request == ["GET", path, "HTTP/1.1"], "WS request path changed")
                fields = http.client.parse_headers(right)
                driver.require(fields.get("Upgrade") == "websocket" and fields.get("Sec-WebSocket-Version") == "13",
                               "WS upgrade/version missing")
                accept = base64.b64encode(hashlib.sha1((fields["Sec-WebSocket-Key"] + driver.realtime.GUID).encode()).digest()).decode()
                response = {"Upgrade": "websocket", "Connection": "Upgrade", "Sec-WebSocket-Accept": accept,
                            "X-Ck-Stream-Id": "changed" if resumed and self.violation == "identity" else "retained",
                            "X-Ck-Stream-Cursor": "v1.e.0" if not resumed else
                            "v1.e.64" if self.violation == "resume-cursor" else after}
                if self.violation == "missing-id":
                    del response["X-Ck-Stream-Id"]
                if self.violation == "initial-cursor" and not resumed:
                    response["X-Ck-Stream-Cursor"] = "v1.e.1"
                if self.violation == "handshake":
                    response["Sec-WebSocket-Accept"] = "wrong"
                right.sendall(("HTTP/1.1 101 Switching Protocols\r\n" + "".join(
                    f"{k}: {v}\r\n" for k, v in response.items()) + "\r\n").encode())
                DuplexHandler.exchange(self, server, resumed, terminal)
            except (OSError, AssertionError, ValueError) as exc:
                self.error = str(exc)
                self.done.set()
                self.detached.set()

        thread = threading.Thread(target=handshake, daemon=True)
        self.threads.append(thread)
        thread.start()
        with mock.patch.object(driver.realtime.socket, "create_connection", return_value=left):
            client, response = driver.realtime.WebSocket.connect(0, path, headers)
        self.active.append(client)
        return client, response


class Pipe:
    """Socket-like byte pipe: exercise RFC 6455 encoding without network privileges."""
    def __init__(self):
        self.incoming = queue.Queue(maxsize=256)
        self.pending = bytearray()
        self.closed = False
        self.other = None

    def makefile(self, *_):
        return self

    def settimeout(self, *_):
        pass

    def setsockopt(self, *_):
        pass

    def flush(self):
        pass

    def sendall(self, data):
        if self.closed or self.other.closed:
            raise BrokenPipeError("closed control pipe")
        self.other.incoming.put(data, timeout=2)

    def read(self, count):
        while len(self.pending) < count:
            if (self.closed or self.other.closed) and self.incoming.empty():
                break
            try:
                data = self.incoming.get(timeout=2)
            except queue.Empty as exc:
                raise AssertionError("control peer stopped making progress") from exc
            if data is None:
                break
            self.pending.extend(data)
        data = bytes(self.pending[:count])
        del self.pending[:count]
        return data

    def readline(self, limit=65536):
        line = bytearray()
        while len(line) < limit:
            byte = self.read(1)
            if not byte:
                break
            line.extend(byte)
            if byte == b"\n":
                break
        return bytes(line)

    def shutdown(self, *_):
        if not self.closed:
            self.closed = True
            for pipe in (self, self.other):
                try:
                    pipe.incoming.put_nowait(None)
                except queue.Full:
                    pass

    def close(self):
        self.shutdown()


class DuplexHandler:
    @staticmethod
    def exchange(peer, ws, resumed, terminal=False):
        try:
            if terminal:
                ws.json(driver.realtime.marker("request", 6))
                if peer.violation == "terminal-repeat":
                    ws.json({"type": "response.done", "response": {"id": "flow-turn", "status": "cancelled"}})
                    ws.json(driver.realtime.marker("response", 82))
                ws.send(8, driver.realtime.CLOSE)
                return

            def cursor(direction, number):
                if peer.violation == "missing-request-cursor" and direction == "request" and number == 1:
                    return
                if peer.violation == "request-cursor" and direction == "request" and number:
                    number += 1
                if peer.violation == "reattach-prefix" and resumed and direction == "request" and number == 3:
                    number += 1
                ws.json(driver.realtime.marker(direction, number))

            def input_unit(number, execute=True, ack=True):
                driver.realtime.expect_json(ws, {"type": "x_ck.input", "unit": number, "direction": "request"}, "input envelope")
                unit = ws.receive()
                if peer.violation == "semantic-json":
                    unit = reencoded_unit(unit)
                if peer.violation == "input-corruption" and number == 1:
                    value = json.loads(unit[1])
                    value["session"]["instructions"] += " changed"
                    unit = 1, driver.realtime.text(value)
                if execute or peer.violation == "duplicate-input":
                    peer.received.append(unit)
                if ack:
                    cursor("request", number)
                return unit

            def output(number, unit):
                if peer.violation == "payload" and number == 2:
                    unit = unit[0], unit[1][:-1]
                if peer.violation == "media-repeat" and number == 4:
                    unit = driver.realtime.traffic(1)
                if peer.violation == "media-order" and number in (3, 4):
                    unit = driver.realtime.traffic(3 if number == 3 else 2)
                if peer.violation == "semantic-json":
                    unit = reencoded_unit(unit)
                ws.send(*unit)
                if peer.violation == "missing-response-cursor" and number == 2:
                    return
                cursor("response", number + (1 if peer.violation == "response-cursor" else 0))

            cursor("request", 3 if resumed else 0)
            if not resumed:
                peer.sessions += 1
                input_unit(1)
                input_unit(2)
                output(1, (1, driver.realtime.text({"type": "session.updated", "session": {"instructions": "flow control α"}})))
                driver.require(peer.release.wait(driver.TIMEOUT), "producer was not released")
                for index in range(1, 65):
                    output(index + 1, driver.realtime.traffic(index))
                    if index == 32:
                        input_unit(3)
                ws.send(*driver.realtime.traffic(65))
                # Wait for socket loss; do not manufacture a normal-close outcome.
                driver.require(ws.reader.read(1) == b"", "expected abnormal client disconnect")
                if peer.violation == "disconnect-cancels":
                    peer.done.set()
                peer.detached.set()
            else:
                if peer.violation == "new-session":
                    peer.sessions += 1
                input_unit(3, execute=False, ack=peer.violation != "interleaved")
                for index in range(65, 81):
                    value = driver.realtime.traffic(index)
                    if peer.violation == "replay-loss" and index == 65:
                        value = driver.realtime.traffic(66)
                    output(index + 1, value)
                if peer.violation == "interleaved":
                    cursor("request", 3)
                input_unit(4)
                input_unit(5)
                input_unit(6, execute=peer.violation != "cancel-loss")
                output(82, (1, driver.realtime.text({"type": "response.done", "response": {
                    "id": "flow-turn", "status": "completed" if peer.violation == "cancel-status" else "cancelled"}})))
                peer.received.append(ws.receive())
                ws.send(8, b"\x03\xe9wrong" if peer.violation == "close" else driver.realtime.CLOSE)
                peer.done.set()
        except (OSError, AssertionError, ValueError) as exc:
            peer.error = str(exc)
            peer.done.set()
            peer.detached.set()


class RealtimeChecks(unittest.TestCase):
    def run_peer(self, violation=None):
        peer = DuplexPeer(violation)
        try:
            return driver.realtime.exercise_session(
                peer.connect, peer, "/v1/realtime?model=gpt-realtime", driver.KEY)
        finally:
            peer.release.set()
            for ws in peer.active:
                ws.abort()
            for thread in peer.threads:
                thread.join(timeout=2)
                self.assertFalse(thread.is_alive(), "control peer leaked a background thread")

    def test_valid_duplex_wire(self):
        for control in (None, "interleaved", "semantic-json"):
            result = self.run_peer(control)
            self.assertEqual((result["response_units"], result["request_units"], result["upstream_sessions"]), (82, 6, 1))
            self.assertGreaterEqual(result["media_bytes"], 8 * 1024 * 1024)

    def test_each_duplex_violation_is_rejected(self):
        for violation in ("handshake", "missing-id", "initial-cursor", "identity", "resume-cursor", "request-cursor", "response-cursor", "payload",
                          "media-repeat", "media-order", "missing-response-cursor", "missing-request-cursor",
                          "reattach-prefix", "input-corruption",
                          "disconnect-cancels", "duplicate-input", "new-session", "replay-loss",
                          "cancel-loss", "cancel-status", "close", "terminal-repeat"):
            with self.subTest(violation=violation), self.assertRaises(AssertionError):
                self.run_peer(violation)


class WebSocketFramingChecks(unittest.TestCase):
    def test_fixture_proxy_accepts_local_bootstrap_and_blocks_external_targets(self):
        body = json.dumps({"sdp": "v=0\r\no=flow-offer\r\n",
                           "session": {"model": "gpt-live-1-codex"}}).encode()
        for target, expected in (("http://127.0.0.1:1777/v1/realtime/calls", 201),
                                 ("http://example.invalid/v1/realtime/calls", None),
                                 ("CONNECT api.openai.com:443", 403)):
            with self.subTest(target=target):
                left, right = Pipe(), Pipe()
                left.other, right.other = right, left
                server = SimpleNamespace(server_port=1777, scenario="sideband-resume", requests=[], progress=[],
                                         error=None, done=threading.Event(), sent=0)
                request = target if target.startswith("CONNECT ") else "POST " + target
                right.sendall((request + " HTTP/1.1\r\nHost: 127.0.0.1:1777\r\nConnection: close\r\n"
                               + f"Content-Length: {len(body)}\r\n\r\n").encode() + body)
                try:
                    driver.Handler(left, ("127.0.0.1", 1), server)
                    left.close()
                    if expected is None:
                        self.assertEqual(right.read(1), b"")
                        self.assertIn("blocked non-loopback", server.error)
                        self.assertEqual(server.requests, [])
                    else:
                        response = http.client.HTTPResponse(right)
                        response.begin()
                        self.assertEqual(response.status, expected)
                        if expected == 201:
                            self.assertEqual(response.getheader("Location"), "/v1/realtime/calls/flow-call")
                            self.assertEqual(response.read(), b"v=0\r\no=flow-answer\r\n")
                            self.assertIsNone(server.error)
                        else:
                            self.assertIn("blocked hard-coded TLS", server.error)
                            self.assertEqual(server.requests, [])
                        response.close()
                finally:
                    left.close()
                    right.close()

    def test_http_duplicate_identity_fields_reach_the_wire(self):
        left, right = Pipe(), Pipe()
        left.other, right.other = right, left
        right.sendall(b"HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\n\r\n")
        gateway = object.__new__(driver.Gateway)
        gateway.port, gateway.out, gateway.request_number = 1, Path("/unused"), 0
        with mock.patch.object(driver.socket, "create_connection", return_value=left), \
                mock.patch.object(driver, "RecordedResponse", side_effect=lambda response, _: response):
            conn, response = gateway.request("GET", "/v1/streams?after=v1.e.0",
                                             headers=[("X-Ck-Stream-Id", "one"), ("X-Ck-Stream-Id", "one")])
        try:
            self.assertEqual(response.status, 400)
            self.assertEqual(right.readline(), b"GET /v1/streams?after=v1.e.0 HTTP/1.1\r\n")
            fields = http.client.parse_headers(right)
            self.assertEqual(fields.get_all("X-Ck-Stream-Id"), ["one", "one"])
        finally:
            response.close()
            conn.close()

    def test_fragmentation_and_ping_preserve_complete_unit(self):
        left, right = Pipe(), Pipe()
        left.other, right.other = right, left
        ws = driver.realtime.WebSocket(left)
        try:
            right.sendall(b"\x02\x03abc\x89\x01p\x80\x03def")
            self.assertEqual(ws.receive(), (2, b"abcdef"))
            self.assertEqual(right.read(2), b"\x8a\x81")
            mask = right.read(4)
            self.assertEqual(bytes([right.read(1)[0] ^ mask[0]]), b"p")
        finally:
            ws.abort()

    def test_truncated_and_wrong_direction_frames_are_rejected(self):
        for frame in (b"\x82\x04abc", b"\x82\x80", b"\x82\x7f" + struct.pack("!Q", 1 << 21)):
            left, right = Pipe(), Pipe()
            left.other, right.other = right, left
            ws = driver.realtime.WebSocket(left)
            right.sendall(frame)
            right.close()
            try:
                with self.assertRaises(AssertionError):
                    ws.receive()
            finally:
                ws.abort()

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
