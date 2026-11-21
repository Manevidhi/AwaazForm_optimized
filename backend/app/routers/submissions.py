"""Submit a finished form from inside the app.

The frontend calls this only after the user confirms in the submit dialog.
- Google Form links: the answers are delivered to the real form.
- Everything else: recorded in AwaazForm and a reference number is returned.
Sensitive answers (Aadhaar, PAN etc.) are delivered to Google if the form asks for them,
but are never written to this database.
"""
import json
import secrets
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import delete
from sqlalchemy.orm import Session

from ..config import settings
from ..database import get_db
from ..fetcher import FetchError
from ..models import Submission
from ..schemas import SubmitRequest, SubmitResponse
from ..submitter import build_payload, google_response_url, submit_to_google

router = APIRouter(prefix="/api", tags=["submissions"])


def _reference() -> str:
    return "AWZ-" + "".join(secrets.choice("ABCDEFGHJKLMNPQRSTUVWXYZ23456789") for _ in range(6))


def _purge_old(db: Session) -> None:
    cutoff = datetime.now(timezone.utc) - timedelta(days=settings.submission_ttl_days)
    db.execute(delete(Submission).where(Submission.created_at < cutoff))
    db.commit()


@router.post("/submit", response_model=SubmitResponse)
def submit_form(req: SubmitRequest, db: Session = Depends(get_db)):
    missing = [f.id for f in req.form.fields if f.required and str(req.answers.get(f.id, "")).strip() == ""]
    if missing:
        raise HTTPException(422, detail={"code": "unsupported", "message": "Required questions are not answered."})

    delivered = "awaaz"
    target = google_response_url(req.form.source_url)
    if target:
        payload, unsendable = build_payload(req)
        if unsendable:
            raise HTTPException(422, detail={"code": "unsupported", "message": "Some required questions cannot be sent."})
        try:
            submit_to_google(target, payload)
        except FetchError as e:
            raise HTTPException(e.status if e.code != "rejected" else 422, detail={"code": e.code, "message": e.message})
        delivered = "google_forms"

    _purge_old(db)
    sensitive = {f.id for f in req.form.fields if f.type == "sensitive"}
    kept = {k: v for k, v in req.answers.items() if k not in sensitive}
    title = req.form.title.get(req.lang) or req.form.title.get("en") or "Form"
    row = Submission(
        reference=_reference(),
        form_title=title[:300],
        delivered_to=delivered,
        answers_json=json.dumps(kept, ensure_ascii=False),
        lang=req.lang,
    )
    db.add(row)
    db.commit()
    db.refresh(row)
    return SubmitResponse(reference=row.reference, delivered_to=delivered, submitted_at=row.created_at)
