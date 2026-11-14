#!/usr/bin/env python3
"""Exercise a real gateway against loopback-only external workloads."""

import argparse
import hashlib
import http.client
import http.server
import itertools
import json
import os
from pathlib import Path
import platform
import re
import socket
import subprocess
import sys
import threading
import time
import urllib.parse

KEY = "sk-flow-local-client"
OTHER_KEY = "sk-flow-other-client"
SIGNATURE = "opaque+/signature==do-not-change"
ARGUMENTS = '{"path":"src/測試.rs","line":17}'
MEDIA = bytes(range(256)) * 32768  # 8 MiB, including invalid textual UTF-8.
TIMEOUT = 12


def require(condition, message):
    if not condition:
        raise AssertionError(message)


def dump(path, value):
    path.write_text(json.dumps(value, indent=2, ensure_ascii=False) + "\n")


def event(value, name=None):
    prefix = f"event: {name}\n" if name else ""
    return (prefix + "data: " + json.dumps(value, ensure_ascii=False, separators=(",", ":")) + "\n\n").encode()


def chat_chunk(choices, **extra):
    return {"id": "chat-flow", "object": "chat.completion.chunk", "created": 1,
            "model": "flow-chat", "choices": choices, **extra}


def chat_records():
    yield event(chat_chunk([{"index": 1, "delta": {"role": "assistant", "content": "one:"}},
                            {"index": 0, "delta": {"role": "assistant", "content": "zero:"}}]))
    yield event(chat_chunk([{"index": 0, "delta": {}, "logprobs": {"content": [
        {"token": "z", "logprob": -0.25, "bytes": [122], "top_logprobs": []}]}}]))
    for part in ("α", "β", "γ"):
        yield event(chat_chunk([{"index": 1, "delta": {"content": part + "1"}},
                                {"index": 0, "delta": {"content": part + "0"}}]))
    for i, fragment in enumerate((ARGUMENTS[:9], ARGUMENTS[9:18], ARGUMENTS[18:])):
        tool = {"index": 0, "function": {"arguments": fragment}}
        if i == 0:
            tool.update(id="call-flow", type="function")
            tool["function"]["name"] = "read_file"
        yield event(chat_chunk([{"index": 0, "delta": {"tool_calls": [tool]}}]))
    yield event(chat_chunk([{"index": 1, "delta": {}, "finish_reason": "stop"},
                            {"index": 0, "delta": {}, "finish_reason": "tool_calls"}]))
    yield event(chat_chunk([], usage={"prompt_tokens": 17, "completion_tokens": 9, "total_tokens": 26}))
    yield b"data: [DONE]\n\n"


def claude_records():
    def send(kind, **fields):
        return event({"type": kind, **fields}, kind)
    yield send("message_start", message={"id": "msg-flow", "type": "message", "role": "assistant",
               "model": "claude-flow", "content": [], "stop_reason": None,
               "usage": {"input_tokens": 17, "output_tokens": 0}})
    yield send("content_block_start", index=0, content_block={"type": "thinking", "thinking": "", "signature": ""})
    yield send("content_block_delta", index=0, delta={"type": "thinking_delta", "thinking": "think α"})
    for fragment in (SIGNATURE[:8], SIGNATURE[8:]):
        yield send("content_block_delta", index=0, delta={"type": "signature_delta", "signature": fragment})
    yield send("content_block_stop", index=0)
    yield send("content_block_start", index=1, content_block={"type": "redacted_thinking", "data": "opaque-redacted+/=="})
    yield send("content_block_stop", index=1)
    yield send("content_block_start", index=2, content_block={"type": "tool_use", "id": "call-flow", "name": "read_file", "input": {}})
    for fragment in (ARGUMENTS[:9], ARGUMENTS[9:]):
        yield send("content_block_delta", index=2, delta={"type": "input_json_delta", "partial_json": fragment})
    yield send("content_block_stop", index=2)
    yield send("message_delta", delta={"stop_reason": "tool_use", "stop_sequence": None}, usage={"output_tokens": 9})
    yield send("message_stop")


def response_records():
    seq = 0
    def send(kind, **fields):
        nonlocal seq
        value = event({"type": kind, "sequence_number": seq, **fields}, kind)
        seq += 1
        return value
    response = {"id": "resp-flow", "object": "response", "created_at": 1, "model": "gpt-flow",
                "status": "in_progress", "output": []}
    yield send("response.created", response=response)
    message = {"id": "msg-flow", "type": "message", "role": "assistant", "status": "in_progress", "content": []}
    yield send("response.output_item.added", output_index=0, item=message)
    yield send("response.content_part.added", item_id="msg-flow", output_index=0, content_index=0,
               part={"type": "output_text", "text": "", "annotations": []})
    for text in ("hello ", "世界"):
        yield send("response.output_text.delta", item_id="msg-flow", output_index=0, content_index=0, delta=text)
    content = {"type": "output_text", "text": "hello 世界", "annotations": []}
    yield send("response.output_text.done", item_id="msg-flow", output_index=0, content_index=0, text=content["text"])
    yield send("response.content_part.done", item_id="msg-flow", output_index=0, content_index=0, part=content)
    message = {**message, "status": "completed", "content": [content]}
    yield send("response.output_item.done", output_index=0, item=message)
    call = {"id": "fc-flow", "call_id": "call-flow", "type": "function_call", "name": "read_file", "arguments": "", "status": "in_progress"}
    yield send("response.output_item.added", output_index=1, item=call)
    for fragment in (ARGUMENTS[:9], ARGUMENTS[9:]):
        yield send("response.function_call_arguments.delta", item_id="fc-flow", output_index=1, delta=fragment)
    yield send("response.function_call_arguments.done", item_id="fc-flow", output_index=1, arguments=ARGUMENTS)
    call = {**call, "arguments": ARGUMENTS, "status": "completed"}
    yield send("response.output_item.done", output_index=1, item=call)
    reasoning = {"id": "rs-flow", "type": "reasoning", "summary": [], "encrypted_content": "opaque-encrypted+/=="}
    yield send("response.output_item.added", output_index=2, item={"id": "rs-flow", "type": "reasoning", "summary": []})
    yield send("response.output_item.done", output_index=2, item=reasoning)
    response = {**response, "status": "completed", "output": [message, call, reasoning],
                "usage": {"input_tokens": 17, "output_tokens": 9, "total_tokens": 26}}
    yield send("response.completed", response=response)


def bulk_records(count=2048):
    for i in range(count):
        yield event(chat_chunk([{"index": 0, "delta": {"content": f"{i:05d}:" + "x" * 40960}}]))
    yield event(chat_chunk([{"index": 0, "delta": {}, "finish_reason": "stop"}]))
    yield event(chat_chunk([], usage={"prompt_tokens": 17, "completion_tokens": 9, "total_tokens": 26}))
    yield b"data: [DONE]\n\n"


class Upstream(http.server.ThreadingHTTPServer):
    daemon_threads = True
    def __init__(self, scenario, out):
        super().__init__(("127.0.0.1", 0), Handler)
        self.scenario, self.out = scenario, out
        self.done = threading.Event()
        self.release = threading.Event()
        self.requests = []
        self.progress = []
        self.error = None
        self.sent = 0


class Handler(http.server.BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    def log_message(self, *_):
        pass

    def request_body(self):
        if self.headers.get("Transfer-Encoding", "").lower() != "chunked":
            return self.rfile.read(int(self.headers.get("Content-Length", 0)))
        chunks = []
        while True:
            size = int(self.rfile.readline().split(b";", 1)[0], 16)
            if size == 0:
                while self.rfile.readline() not in (b"\r\n", b"\n", b""):
                    pass
                return b"".join(chunks)
            chunk = self.rfile.read(size)
            require(len(chunk) == size and self.rfile.read(2) == b"\r\n", "truncated upstream request chunk")
            chunks.append(chunk)


    def do_POST(self):
        up = self.server
        self.connection.settimeout(TIMEOUT)
        try:
            body = self.request_body()
            length = len(body)
            request = json.loads(body)
            # Never retain authentication or resume headers in benchmark artifacts.
            up.requests.append({"path": self.path, "body": request})
            up.progress.append({"time": time.monotonic(), "kind": "request", "bytes": length})
            self.send_response(200)
            media = up.scenario in ("long-media", "media-resume")
            self.send_header("Content-Type", "audio/mpeg" if media else "text/event-stream")
            self.send_header("Transfer-Encoding", "chunked")
            self.end_headers()
            if media:
                records = (MEDIA[i:i + 16384] for i in range(0, len(MEDIA), 16384))
            elif up.scenario == "signatures-tools":
                records = claude_records()
            elif up.scenario == "terminal-snapshots":
                records = response_records()
            elif up.scenario == "slow-downstream":
                records = bulk_records()
            elif up.scenario == "stream-limit":
                records = bulk_records(7000)
            elif up.scenario in ("live-resume", "completed-resume"):
                records = bulk_records(160)
            else:
                records = chat_records()
            for i, record in enumerate(records):
                self.wfile.write(f"{len(record):x}\r\n".encode() + record + b"\r\n")
                self.wfile.flush()
                up.sent += len(record)
                up.progress.append({"time": time.monotonic(), "kind": "write", "ordinal": i, "bytes": up.sent})
                if up.scenario in ("live-resume", "completed-resume"):
                    if i == 1:
                        require(up.release.wait(TIMEOUT), "resume driver never released upstream")
                    time.sleep(0.005)
                elif media:
                    time.sleep(0.001)
                else:
                    time.sleep(0.002)
            self.wfile.write(b"0\r\n\r\n")
            self.wfile.flush()
        except (OSError, AssertionError, ValueError) as exc:
            up.error = str(exc)
        finally:
            up.progress.append({"time": time.monotonic(), "kind": "end", "bytes": up.sent, "error": up.error})
            up.done.set()


def records(response):
    lines = []
    while True:
        line = response.readline()
        if not line:
            require(not lines, "truncated SSE record")
            return
        if line in (b"\n", b"\r\n"):
            if lines:
                yield b"".join(lines) + b"\n"
                lines = []
        else:
            lines.append(line)


def payload(record):
    text = b"\n".join(line[5:].lstrip(b" ") for line in record.splitlines() if line.startswith(b"data:"))
    if not text or text == b"[DONE]":
        return None
    return json.loads(text)


def cursor(record):
    values = [line[3:].strip().decode() for line in record.splitlines() if line.startswith(b"id:")]
    require(len(values) == 1 and re.fullmatch(r"v1\.e\.\d+", values[0]), "missing/invalid S1 SSE cursor")
    return values[0]


def check_chat(data):
    require(data, "empty Chat stream")
    values = [payload(r) for r in data]
    require(data[-1].split(b"data:", 1)[-1].strip() == b"[DONE]", "missing Chat terminal")
    text = {0: "", 1: ""}
    arguments, logprobs, tool_fragments, usage = "", [], [], []
    for value in filter(None, values):
        if "usage" in value:
            usage.append(value["usage"])
        for choice in value.get("choices", []):
            idx = choice["index"]
            require(idx in text, "unexpected choice index")
            delta = choice.get("delta", {})
            text[idx] += delta.get("content") or ""
            logprobs.extend((choice.get("logprobs") or {}).get("content", []))
            for tool in delta.get("tool_calls", []):
                part = tool.get("function", {}).get("arguments", "")
                arguments += part
                if part:
                    tool_fragments.append(part)
    require(text == {0: "zero:α0β0γ0", 1: "one:α1β1γ1"}, "choice text/order corrupted")
    require(arguments == ARGUMENTS and len(tool_fragments) >= 2, "tool arguments lost or buffered into one event")
    require(any(p.get("token") == "z" and p.get("logprob") == -0.25 for p in logprobs), "logprobs-only chunk lost")
    require(usage and usage[-1].get("total_tokens") == 26, "usage snapshot lost")


def check_claude(data):
    require(data, "empty Messages stream")
    values = [payload(r) for r in data]
    require(values[-1]["type"] == "message_stop", "missing Messages terminal")
    deltas = [v["delta"] for v in values if v["type"] == "content_block_delta"]
    signature = "".join(v.get("signature", "") for v in deltas)
    arguments = "".join(v.get("partial_json", "") for v in deltas)
    require(signature == SIGNATURE, "opaque signature bytes changed")
    require(arguments == ARGUMENTS, "Messages tool fragments corrupted")
    require(sum("partial_json" in v for v in deltas) >= 2, "Messages tool fragments buffered")
    require(any(v.get("content_block", {}).get("data") == "opaque-redacted+/==" for v in values), "redacted thinking lost")


def check_snapshots(data):
    values = [payload(r) for r in data]
    values = [v for v in values if v]
    require(values, "empty Responses stream")
    require(values[-1]["type"] == "response.completed", "missing Responses terminal snapshot")
    text = "".join(v["delta"] for v in values if v["type"] == "response.output_text.delta")
    args = "".join(v["delta"] for v in values if v["type"] == "response.function_call_arguments.delta")
    output = values[-1]["response"]["output"]
    messages = [v for v in output if v["type"] == "message"]
    calls = [v for v in output if v["type"] == "function_call"]
    require(text == "hello 世界" and messages and messages[0]["content"][0]["text"] == text, "terminal text snapshot disagrees with deltas")
    require(args == ARGUMENTS and calls and calls[0]["arguments"] == args, "terminal tool snapshot disagrees with deltas")
    require(any(v.get("encrypted_content") == "opaque-encrypted+/==" for v in output), "encrypted reasoning lost")
    require(values[-1]["response"]["usage"]["total_tokens"] == 26, "terminal usage lost")


def check_bulk(data, count):
    actual, expected = hashlib.sha256(), hashlib.sha256()
    done, usage, finishes = 0, [], []
    for record in data:
        require(not done, "output continued after bulk terminal")
        if b"data: [DONE]" in record:
            done += 1
        value = payload(record)
        if value:
            if value.get("usage") is not None:
                usage.append(value["usage"])
            for choice in value.get("choices", []):
                require(choice["index"] == 0, "bulk choice identity changed")
                if choice.get("finish_reason") is not None:
                    finishes.append(choice["finish_reason"])
                actual.update((choice.get("delta", {}).get("content") or "").encode())
    for i in range(count):
        expected.update(f"{i:05d}:".encode())
        expected.update(b"x" * 40960)
    require(actual.digest() == expected.digest(), "bulk content has gaps, repeats or modifications")
    require(done == 1, "bulk stream lost terminal")
    require(finishes == ["stop"], "bulk finish reason lost, changed or duplicated")
    require(usage == [{"prompt_tokens": 17, "completion_tokens": 9, "total_tokens": 26}],
            "bulk usage snapshot lost, changed or duplicated")


class RecordedResponse:
    def __init__(self, response, path):
        self.response = response
        self.raw = path.open("wb")

    def __getattr__(self, name):
        return getattr(self.response, name)

    def read(self, *args):
        data = self.response.read(*args)
        self.raw.write(data)
        return data

    def readline(self, *args):
        data = self.response.readline(*args)
        self.raw.write(data)
        return data

    def close(self):
        self.raw.close()
        self.response.close()


class Gateway:
    def __init__(self, binary, out, upstream):
        self.request_number = 0
        self.out, self.up = out, upstream
        with socket.socket() as sock:
            sock.bind(("127.0.0.1", 0))
            self.port = sock.getsockname()[1]
        self.log = (out / "server.log").open("wb")
        runtime = out / "runtime"
        runtime.mkdir(mode=0o700)
        base = f"http://127.0.0.1:{upstream.server_port}"
        config = f'''config-version: 8
server:
  host: 127.0.0.1
  port: {self.port}
management:
  disable-control-panel: true
access:
  api-keys: [{KEY}, {OTHER_KEY}]
api-keys:
  openai-compatibility:
    - name: flow
      base-url: {base}/v1
      models:
        - name: flow-chat
      keys:
        - api-key: sk-fake-flow-upstream
  claude:
    - name: flow-claude
      base-url: {base}
      models:
        - name: claude-flow
      keys:
        - api-key: sk-ant-api03-FAKE-flow
  codex:
    - name: flow-codex
      base-url: {base}
      models:
        - name: gpt-flow
      keys:
        - api-key: sk-fake-flow-codex
  xai:
    - name: flow-media
      base-url: {base}/v1
      keys:
        - api-key: sk-fake-flow-xai
'''
        (out / "config.yaml").write_text(config)
        env = {**os.environ, "CK_DB": str(out / "cooker.db"), "XDG_RUNTIME_DIR": str(runtime),
               "HTTP_PROXY": "http://127.0.0.1:9", "HTTPS_PROXY": "http://127.0.0.1:9",
               "ALL_PROXY": "http://127.0.0.1:9", "NO_PROXY": "127.0.0.1,localhost"}
        env.update({k.lower(): env[k] for k in ("HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY")})
        self.process = subprocess.Popen([str(binary), "--config", str(out / "config.yaml"), "--local-model"],
                                        cwd=out, env=env, stdout=self.log, stderr=subprocess.STDOUT)

    def await_ready(self):
        deadline = time.monotonic() + TIMEOUT
        while time.monotonic() < deadline:
            require(self.process.poll() is None, "gateway exited before readiness; see server.log")
            try:
                conn, response = self.request("GET", "/healthz")
                body = response.read()
                conn.close()
                if response.status == 200 and json.loads(body) == {"status": "ok"}:
                    return
            except (OSError, ValueError, http.client.HTTPException):
                pass
            time.sleep(0.05)
        raise AssertionError("gateway health timeout")

    def request(self, method, path, body=None, headers=None, small_window=False):
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=TIMEOUT)
        conn.connect()
        if small_window:
            conn.sock.setsockopt(socket.SOL_SOCKET, socket.SO_RCVBUF, 4096)
        data = json.dumps(body, ensure_ascii=False).encode() if body is not None else None
        conn.request(method, path, data, {"Authorization": f"Bearer {KEY}", "Content-Type": "application/json",
                                         "Accept-Encoding": "identity", **(headers or {})})
        self.request_number += 1
        try:
            response = conn.getresponse()
        except (OSError, http.client.HTTPException):
            conn.close()
            raise
        return conn, RecordedResponse(response, self.out / f"response-{self.request_number}.body")

    def stop(self):
        self.up.release.set()
        try:
            if self.process.poll() is None:
                self.process.terminate()
                try:
                    self.process.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    self.process.kill()
                    self.process.wait()
                    raise AssertionError("gateway did not stop within five seconds")
        finally:
            self.log.close()


def initial(gateway, scenario):
    if scenario in ("long-media", "media-resume"):
        return gateway.request("POST", "/v1/audio/speech", {"model": "grok-tts", "input": "flow media", "voice": "eve"})
    if scenario == "signatures-tools":
        return gateway.request("POST", "/v1/messages", {"model": "claude-flow", "max_tokens": 256, "stream": True,
                               "messages": [{"role": "user", "content": "flow"}]})
    if scenario == "terminal-snapshots":
        return gateway.request("POST", "/v1/responses", {"model": "gpt-flow", "stream": True, "input": "flow"})
    return gateway.request("POST", "/v1/chat/completions", {"model": "flow-chat", "stream": True, "n": 2,
                           "stream_options": {"include_usage": True}, "messages": [{"role": "user", "content": "flow"}]},
                           small_window=scenario == "slow-downstream")


def wait_upstream(up):
    require(up.done.wait(TIMEOUT), "upstream stopped making progress")
    require(up.error is None, f"upstream cancelled/failed: {up.error}")


def resume(gateway, stream_id, after, key=KEY):
    return gateway.request("GET", "/v1/streams?after=" + urllib.parse.quote(after),
                           headers={"X-Ck-Stream-Id": stream_id, "Authorization": f"Bearer {key}"})


def check_resume(gateway, response, conn, live):
    up = gateway.up
    first = next(records(response))
    stream_id = response.getheader("X-Ck-Stream-Id")
    after = cursor(first)
    require(stream_id, "missing X-Ck-Stream-Id: resume is not implemented")
    response.close()
    conn.close()
    if not live:
        up.release.set()
        wait_upstream(up)
    attach, suffix = resume(gateway, stream_id, after)
    require(suffix.status == 200, f"resume returned HTTP {suffix.status}")
    require(suffix.getheader("X-Ck-Stream-Cursor") == after, "resume did not acknowledge starting cursor")
    require(suffix.getheader("X-Ck-Stream-Id") == stream_id, "resume identity response header changed")
    require(suffix.getheader("Cache-Control") == "no-store", "resume response is cacheable")
    up.release.set()
    tail = list(records(suffix))
    attach.close()
    wait_upstream(up)
    actual = [first, *tail]
    check_bulk(actual, 160)
    ordinals = [int(cursor(r).rsplit(".", 1)[1]) for r in actual]
    require(ordinals == list(range(1, len(actual) + 1)), "resume event cursors are not consecutive")
    end = cursor(actual[-1])
    again, replay = resume(gateway, stream_id, end)
    require(replay.status == 200 and replay.read() == b"", "terminal cursor repeated output instead of EOF")
    again.close()
    future, failure = resume(gateway, stream_id, f"v1.e.{ordinals[-1] + 1}")
    require(failure.status == 400, "future cursor did not return 400")
    failure.read()
    future.close()
    foreign, failure = resume(gateway, stream_id, after, OTHER_KEY)
    require(failure.status == 410, "foreign identity did not return 410")
    failure.read()
    foreign.close()
    require(len(up.requests) == 1, "resume created a new upstream request")
    return {"resumed_events": len(tail), "cursor_end": end, "upstream_requests": len(up.requests)}


def run_scenario(gateway, name):
    up = gateway.up
    conn, response = initial(gateway, name)
    try:
        if response.status != 200:
            raise AssertionError(f"initial request returned HTTP {response.status}: {response.read(512)!r}")
        if name.endswith("-resume") and name != "media-resume":
            return check_resume(gateway, response, conn, name == "live-resume")
        if name == "slow-downstream":
            first = next(records(response))
            read_bytes = len(first)
            t0 = time.monotonic()
            sent_before = up.sent
            # No response reads occur during this interval. An 80 MiB body and a
            # small receive window prevent socket buffers from hiding client stalls.
            require(up.done.wait(TIMEOUT), "upstream blocked while downstream was stalled")
            elapsed = time.monotonic() - t0
            require(up.error is None, f"upstream failed during client stall: {up.error}")
            limits = [int(Path(p).read_text().split()[-1]) for p in
                      ("/proc/sys/net/ipv4/tcp_wmem", "/proc/sys/net/ipv4/tcp_rmem")]
            require(up.sent - read_bytes > sum(limits) * 2, "workload does not exceed socket buffering; stall proof invalid")
            require(up.sent > sent_before, "upstream did not progress during client stall")
            conn.sock.setsockopt(socket.SOL_SOCKET, socket.SO_RCVBUF, 4 * 1024 * 1024)
            check_bulk(itertools.chain([first], records(response)), 2048)
            return {"stall_s": elapsed, "upstream_bytes_during_stall": up.sent - sent_before,
                    "client_bytes_before_stall": read_bytes, "socket_buffer_bound_bytes": sum(limits) * 2}
        if name == "stream-limit":
            exhausted, successful, delivered = False, False, 0
            for record in records(response):
                delivered += len(record)
                value = payload(record)
                if value and isinstance(value.get("error"), dict):
                    require(value["error"].get("code") == "stream.storage_exhausted",
                            "wrong per-stream limit error")
                    exhausted = True
                elif value and value.get("type") == "error":
                    require(value.get("code") == "stream.storage_exhausted", "wrong stream limit error")
                    exhausted = True
                else:
                    require(not exhausted, "output continued after exhaustion error")
                successful |= b"data: [DONE]" in record
            require(exhausted and not successful, "stream exceeded 256 MiB without a visible storage error")
            require(up.done.wait(3), "exhaustion did not cancel upstream collection")
            require(len(up.requests) == 1, "storage exhaustion retried another upstream")
            gateway.await_ready()
            return {"delivered_bytes": delivered, "upstream_bytes": up.sent,
                    "terminal": "stream.storage_exhausted"}
        if name in ("long-media", "media-resume"):
            require(response.getheader("Content-Type", "").startswith("audio/mpeg"), "media MIME changed")
            prefix = response.read(65536)
            first_write = next(p["time"] for p in up.progress if p["kind"] == "write")
            first_delivery_s = time.monotonic() - first_write
            if name == "media-resume":
                stream_id = response.getheader("X-Ck-Stream-Id")
                require(stream_id, "missing X-Ck-Stream-Id for byte resume")
                response.close()
                conn.close()
                wait_upstream(up)
                attach, suffix = resume(gateway, stream_id, f"v1.b.{len(prefix)}")
                require(suffix.status == 200, f"media resume returned HTTP {suffix.status}")
                body = prefix + suffix.read()
                attach.close()
                require(len(up.requests) == 1, "media resume regenerated upstream output")
            else:
                body = prefix + response.read()
            require(body == MEDIA, "long media bytes lost, repeated or corrupted")
            return {"decoded_bytes": len(body), "sha256": hashlib.sha256(body).hexdigest(),
                    "first_delivery_s": first_delivery_s}
        data = list(records(response))
        {"choices-logprobs-tools": check_chat, "signatures-tools": check_claude,
         "terminal-snapshots": check_snapshots}[name](data)
        wait_upstream(up)
        return {"events": len(data), "encoded_bytes": sum(map(len, data))}
    finally:
        response.close()
        conn.close()


SCENARIOS = ("choices-logprobs-tools", "signatures-tools", "terminal-snapshots", "slow-downstream",
             "live-resume", "completed-resume", "long-media", "media-resume", "stream-limit")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("binary", type=Path)
    parser.add_argument("out", type=Path)
    args = parser.parse_args()
    binary, out = args.binary.resolve(strict=True), args.out.resolve()
    require(os.access(binary, os.X_OK), "gateway binary is not executable")
    out.mkdir(parents=True, exist_ok=False)
    dump(out / "provenance.json", {"schema": 1, "binary": str(binary),
         "sha256": hashlib.sha256(binary.read_bytes()).hexdigest(), "host": platform.uname()._asdict(),
         "page_size": os.sysconf("SC_PAGE_SIZE"), "affinity": sorted(os.sched_getaffinity(0)),
         "load": os.getloadavg(), "filesystem": subprocess.check_output(["stat", "-f", "-c", "%T", str(out)], text=True).strip(),
         "version": subprocess.check_output([str(binary), "--version"], text=True).strip(),
         "build_provenance": os.environ.get("FLOW_BUILD_PROVENANCE", "UNVERIFIED: supply release build revision/compiler/profile/features/flags"),
         "scenarios": SCENARIOS, "timeout_s": TIMEOUT})
    results = []
    for name in SCENARIOS:
        directory = out / name
        directory.mkdir()
        up = Upstream(name, directory)
        thread = threading.Thread(target=up.serve_forever, daemon=True)
        thread.start()
        gateway = None
        start = time.monotonic()
        row = {"scenario": name, "status": "fail"}
        try:
            gateway = Gateway(binary, directory, up)
            gateway.await_ready()
            row.update(run_scenario(gateway, name))
            row["status"] = "pass"
        except (AssertionError, OSError, ValueError, KeyError, IndexError, TypeError,
                StopIteration, http.client.HTTPException) as exc:
            row["error"] = str(exc) or type(exc).__name__
        finally:
            up.release.set()
            if gateway:
                try:
                    gateway.stop()
                except AssertionError as exc:
                    row.update(status="fail", error=str(exc))
            up.shutdown()
            up.server_close()
            thread.join(timeout=2)
            dump(directory / "upstream.json", {"requests": up.requests, "progress": up.progress,
                                               "done": up.done.is_set(), "error": up.error})
        row["elapsed_s"] = time.monotonic() - start
        results.append(row)
        print(json.dumps(row), flush=True)
        with (out / "results.jsonl").open("a") as raw:
            raw.write(json.dumps(row) + "\n")
    dump(out / "summary.json", {"pass": all(r["status"] == "pass" for r in results), "results": results})
    return 0 if all(r["status"] == "pass" for r in results) else 1


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (AssertionError, OSError, ValueError) as error:
        print(f"flow-gate: {error}", file=sys.stderr)
        sys.exit(1)
