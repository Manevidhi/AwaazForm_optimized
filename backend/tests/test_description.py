import json

from app.urlforms import extract_from_page, page_description


def _google(desc):
    data = [None, [desc, [[1, "Name?", None, 0, [[111, None, 1]]]], None, None, None, None, None, None, "Travel"]]
    return f"<html><script>var FB_PUBLIC_LOAD_DATA_ = {json.dumps(data)};</script></html>"


def test_google_form_description_is_read():
    html = _google("Please share how you travel.")
    assert page_description(html) == "Please share how you travel."


def test_description_is_empty_when_missing():
    assert page_description("<html></html>") == ""


def test_description_does_not_change_questions():
    html = _google("Intro")
    source, title, fields = extract_from_page("https://docs.google.com/forms/d/e/x/viewform", html)
    assert source == "google_forms" and title == "Travel" and len(fields) == 1
