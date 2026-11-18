import pymupdf  # PyMuPDF
from fastapi import APIRouter, File, HTTPException, UploadFile

from ..config import settings
from ..parser import parse_text
from ..samples import SAMPLE_FORMS
from ..schemas import FormDef, ParseResponse, ParseTextRequest, ValidateRequest, ValidateResponse
from ..validation import normalize

router = APIRouter(prefix="/api", tags=["forms"])


@router.get("/forms", response_model=list[FormDef])
def list_forms():
    return list(SAMPLE_FORMS.values())


@router.get("/forms/{form_id}", response_model=FormDef)
def get_form(form_id: str):
    form = SAMPLE_FORMS.get(form_id)
    if not form:
        raise HTTPException(404, "Form not found")
    return form


@router.post("/validate", response_model=ValidateResponse)
def validate_answer(req: ValidateRequest):
    valid, value, err = normalize(req.field, req.raw)
    return ValidateResponse(valid=valid, value=value, err=err)


def _response(fields, lang_hint: str) -> ParseResponse:
    title = {"en": "Your form", "hi": "आपका फॉर्म"}
    return ParseResponse(title=title, fields=fields, flagged=sum(1 for f in fields if f.flag))


@router.post("/parse/text", response_model=ParseResponse)
def parse_pasted_text(req: ParseTextRequest):
    fields = parse_text(req.text)
    if not fields:
        raise HTTPException(422, "No questions found in the text")
    return _response(fields, "en")


@router.post("/parse/file", response_model=ParseResponse)
async def parse_uploaded_file(file: UploadFile = File(...)):
    data = await file.read()
    if len(data) > settings.max_upload_mb * 1024 * 1024:
        raise HTTPException(413, f"File is larger than {settings.max_upload_mb} MB")

    name = (file.filename or "").lower()
    if name.endswith(".pdf") or file.content_type == "application/pdf":
        try:
            with pymupdf.open(stream=data, filetype="pdf") as doc:
                text = "\n".join(page.get_text() for page in doc)
        except Exception:
            raise HTTPException(422, "Could not read this PDF")
        if not text.strip():
            raise HTTPException(422, "This PDF has no readable text (it may be a scan)")
    elif name.endswith(".txt") or (file.content_type or "").startswith("text/"):
        text = data.decode("utf-8", errors="replace")
    else:
        raise HTTPException(415, "Upload a .pdf or .txt file")

    fields = parse_text(text)
    if not fields:
        raise HTTPException(422, "No questions found in the file")
    return _response(fields, "en")
