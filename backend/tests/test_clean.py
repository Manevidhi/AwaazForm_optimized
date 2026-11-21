from fastapi.testclient import TestClient
from app.main import app
from app.validation import clean_answer


def test_clean_answer_rule():
    assert clean_answer("Vidhi Mani.") == "Vidhi Mani"
    assert clean_answer("1234?") == "1234"
    assert clean_answer("Ramesh Kulkarni |") == "Ramesh Kulkarni"
    assert clean_answer("रमेश कुलकर्णी।") == "रमेश कुलकर्णी"
    assert clean_answer("Who? What!") == "Who What"
    assert clean_answer("Mr. Kumar") == "Mr. Kumar"


def test_validate_endpoint_cleans_text_and_numbers():
    with TestClient(app) as client:
        field = {"id": "q1", "type": "text", "required": True, "label": {"en": "Student Name"}}
        r = client.post("/api/validate", json={"field": field, "raw": "Vidhi Mani."})
        assert r.json()["value"] == "Vidhi Mani"
        field = {"id": "q2", "type": "number", "required": True, "label": {"en": "UID"}}
        r = client.post("/api/validate", json={"field": field, "raw": "1234."})
        assert r.json() == {"valid": True, "value": "1234", "err": None}
