import json
import os
import urllib.request

os.environ.setdefault("DATABASE_URL", "sqlite:///./test.db")

from fastapi.testclient import TestClient

from app.main import app


class _FakeResponse:
    def __init__(self, body: bytes):
        self._body = body

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def read(self):
        return self._body


def _install(monkeypatch, seen, translated):
    def fake_urlopen(request, timeout=None):
        seen.append(request.full_url)
        body = json.dumps([[[translated, "orig", None, None, 1]], None, "hi"]).encode("utf-8")
        return _FakeResponse(body)

    monkeypatch.setattr(urllib.request, "urlopen", fake_urlopen)


def test_translates_hindi_answer_into_english(monkeypatch):
    seen = []
    _install(monkeypatch, seen, "Ramesh Kulkarni")
    with TestClient(app) as client:
        r = client.post("/api/translate", json={"text": "रमेश कुलकर्णी", "target": "en"})
    assert r.status_code == 200
    assert r.json() == {"translated": "Ramesh Kulkarni"}
    assert "tl=en" in seen[0]


def test_translates_english_question_into_hindi(monkeypatch):
    seen = []
    _install(monkeypatch, seen, "आपका नाम क्या है?")
    with TestClient(app) as client:
        r = client.post("/api/translate", json={"text": "What is your name?", "target": "hi"})
    assert r.json() == {"translated": "आपका नाम क्या है?"}
    assert "tl=hi" in seen[0]
