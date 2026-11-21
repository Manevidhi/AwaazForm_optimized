import os

os.environ["DATABASE_URL"] = "sqlite:///./test.db"

import httpx
import pytest
from fastapi.testclient import TestClient

from app import fetcher, submitter
from app.database import Base, engine
from app.main import app
from app.schemas import SubmitRequest
from app.submitter import build_payload, google_response_url


@pytest.fixture()
def client():
    Base.metadata.drop_all(bind=engine)
    with TestClient(app) as c:
        yield c


def f(id_, type_="text", required=True, key=None, flag=False):
    return {"id": id_, "type": type_, "required": required, "label": {"en": id_}, "source_key": key, "flag": flag}


def body(fields, answers, source_url=None):
    return {"form": {"id": "x", "title": {"en": "My form"}, "fields": fields, "source_url": source_url}, "answers": answers, "lang": "en"}


def test_submit_in_app_returns_reference_and_hides_sensitive(client):
    r = client.post("/api/submit", json=body([f("q1"), f("q2", "sensitive", False)], {"q1": "Ravi", "q2": "123412341234"}))
    assert r.status_code == 200
    j = r.json()
    assert j["delivered_to"] == "awaaz" and j["reference"].startswith("AWZ-")
    from app.database import SessionLocal
    from app.models import Submission
    with SessionLocal() as db:
        row = db.query(Submission).one()
        assert "Ravi" in row.answers_json and "1234" not in row.answers_json


def test_missing_required_is_refused(client):
    r = client.post("/api/submit", json=body([f("q1")], {}))
    assert r.status_code == 422 and r.json()["detail"]["code"] == "unsupported"


def test_google_url_and_payload():
    assert google_response_url("https://docs.google.com/forms/d/e/ABC123/viewform?usp=sf") == "https://docs.google.com/forms/d/e/ABC123/formResponse"
    assert google_response_url("https://evil.example.com/forms/d/e/ABC/viewform") is None
    assert google_response_url("http://docs.google.com/forms/d/e/ABC/viewform") is None
    req = SubmitRequest(**body([f("q1", key="entry.111"), f("q2", "date", key="entry.222")], {"q1": "Ravi", "q2": "2008-08-15"}))
    payload, bad = build_payload(req)
    assert payload == {"entry.111": "Ravi", "entry.222_year": "2008", "entry.222_month": "8", "entry.222_day": "15"} and not bad


def test_required_question_without_key_cannot_be_sent():
    req = SubmitRequest(**body([f("q1", key="entry.111"), f("q2", "select", True, None, True)], {"q1": "a", "q2": "b"}))
    _, bad = build_payload(req)
    assert bad == ["q2"]


def test_google_delivery(client, monkeypatch):
    sent = {}

    def fake(url, payload, transport=None):
        sent["url"], sent["payload"] = url, payload

    import app.routers.submissions as sub
    monkeypatch.setattr(sub, "submit_to_google", fake)
    r = client.post("/api/submit", json=body([f("q1", key="entry.111")], {"q1": "Ravi"}, "https://docs.google.com/forms/d/e/ABC123/viewform"))
    assert r.status_code == 200 and r.json()["delivered_to"] == "google_forms"
    assert sent["url"].endswith("/ABC123/formResponse") and sent["payload"] == {"entry.111": "Ravi"}


def test_google_rejection_is_reported(client, monkeypatch):
    def fake(url, payload, transport=None):
        raise fetcher.FetchError("rejected", "no")

    import app.routers.submissions as sub
    monkeypatch.setattr(sub, "submit_to_google", fake)
    r = client.post("/api/submit", json=body([f("q1", key="entry.111")], {"q1": "Ravi"}, "https://docs.google.com/forms/d/e/ABC123/viewform"))
    assert r.status_code == 422 and r.json()["detail"]["code"] == "rejected"
    # nothing is recorded as submitted
    from app.database import SessionLocal
    from app.models import Submission
    with SessionLocal() as db:
        assert db.query(Submission).count() == 0


def test_submit_to_google_with_mock_transport(monkeypatch):
    monkeypatch.setattr(fetcher, "_resolve", lambda host, port: ["142.250.80.46"])
    seen = {}

    def handler(request: httpx.Request):
        if request.method == "GET":
            return httpx.Response(200, headers={"content-type": "text/html"}, text='<input name="fbzx" value="777">')
        seen["body"] = request.content.decode()
        return httpx.Response(302, headers={"location": "https://docs.google.com/forms/d/e/ABC/formResponse"})

    submitter.submit_to_google("https://docs.google.com/forms/d/e/ABC/formResponse", {"entry.1": "x"}, transport=httpx.MockTransport(handler))
    assert "entry.1=x" in seen["body"] and "fbzx=777" in seen["body"]
