"""Sends a finished form's answers to the form's own website, from the server.

Only Google Forms can be delivered this way: their public `formResponse` address takes the
same `entry.<id>` keys that the link reader already collects. Any other form (the built-in
samples, pasted questions, ordinary HTML forms) is recorded inside AwaazForm instead.

Called only after the user confirms in the app. Answers are sent once, to docs.google.com,
and are neither logged nor kept by this module.
"""
import re
from urllib.parse import urlparse

import httpx

from .fetcher import HEADERS, FetchError, assert_public_url, fetch_html
from .schemas import SubmitRequest

CONFIRM_MARKERS = ("ConfirmationMessage", "freebirdFormviewerViewResponseConfirmation", "/formResponse")
_FORM_PATH = re.compile(r"^/forms/d/(e/)?([\w-]+)")


def google_response_url(source_url: str | None) -> str | None:
    """The formResponse address for a Google Form link, or None if it is not a Google Form."""
    if not source_url:
        return None
    parts = urlparse(source_url)
    if parts.scheme != "https" or (parts.hostname or "").lower() != "docs.google.com":
        return None
    m = _FORM_PATH.match(parts.path)
    if not m:
        return None
    return f"https://docs.google.com/forms/d/{m.group(1) or ''}{m.group(2)}/formResponse"


def build_payload(req: SubmitRequest) -> tuple[dict[str, str], list[str]]:
    """Maps answers to Google's entry keys. Returns (payload, ids of required questions that cannot be sent)."""
    payload: dict[str, str] = {}
    unsendable: list[str] = []
    for f in req.form.fields:
        value = req.answers.get(f.id)
        has = value is not None and str(value).strip() != ""
        key = f.source_key or ""
        if not re.fullmatch(r"entry\.\d+", key):
            if f.required and not has or (f.required and f.flag):
                unsendable.append(f.id)
            continue
        if not has:
            continue
        if f.type == "date":
            try:
                y, mo, d = (int(x) for x in str(value).split("-"))
            except ValueError:
                continue
            payload[f"{key}_year"], payload[f"{key}_month"], payload[f"{key}_day"] = str(y), str(mo), str(d)
        else:
            payload[key] = str(value)
    return payload, unsendable


def _page_extras(html: str) -> dict[str, str]:
    """Hidden values Google expects back, so multi-page forms are accepted."""
    extras: dict[str, str] = {"fvv": "1"}
    m = re.search(r'name="fbzx"\s+value="([^"]+)"', html)
    if m:
        extras["fbzx"] = m.group(1)
    pages = len(re.findall(r',\s*8\s*,\s*null', html))  # page-break items; best effort
    extras["pageHistory"] = ",".join(str(i) for i in range(max(pages, 0) + 1))
    return extras


def submit_to_google(url: str, payload: dict[str, str], transport: httpx.BaseTransport | None = None) -> None:
    """Posts the answers. Raises FetchError('rejected' | 'fetch_failed' | 'blocked')."""
    assert_public_url(url)
    try:
        _, page = fetch_html(url.replace("/formResponse", "/viewform"), transport=transport)
    except FetchError:
        page = ""  # still try without the hidden values
    data = {**payload, **_page_extras(page)}
    try:
        with httpx.Client(transport=transport, timeout=httpx.Timeout(15.0), follow_redirects=False, headers=HEADERS) as client:
            resp = client.post(url, data=data)
    except httpx.HTTPError:
        raise FetchError("fetch_failed", "Could not reach the form's website.")

    if resp.status_code in (301, 302, 303):
        loc = resp.headers.get("location", "")
        if "accounts.google.com" in loc:
            raise FetchError("needs_signin", "This form needs a sign-in.")
        return
    if resp.status_code == 200 and "FB_PUBLIC_LOAD_DATA_" in resp.text and "ConfirmationMessage" not in resp.text:
        raise FetchError("rejected", "The form site did not accept the answers.")
    if resp.status_code >= 400:
        raise FetchError("rejected", f"The form site answered with error {resp.status_code}.")
