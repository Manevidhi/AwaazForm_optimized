from datetime import datetime
from typing import Any, Literal, Optional

from pydantic import BaseModel, Field

FieldType = Literal["text", "date", "select", "phone", "email", "pin", "number", "sensitive"]
Lang = Literal["en", "hi"]


class Option(BaseModel):
    v: str
    en: str
    hi: Optional[str] = None


class FormField(BaseModel):
    id: str
    type: FieldType = "text"
    required: bool = True
    label: dict[str, str]
    hint: Optional[dict[str, str]] = None
    options: Optional[list[Option]] = None
    flag: bool = False
    lang: Optional[Lang] = None


class FormDef(BaseModel):
    id: str
    title: dict[str, str]
    fields: list[FormField]


# ---- validation ----
class ValidateRequest(BaseModel):
    field: FormField
    raw: str = Field(default="", max_length=2000)


class ValidateResponse(BaseModel):
    valid: bool
    value: Optional[str] = None
    err: Optional[str] = None  # i18n key, e.g. "errPhone"


# ---- parsing ----
class ParseTextRequest(BaseModel):
    text: str = Field(max_length=50_000)


class ParseResponse(BaseModel):
    title: dict[str, str]
    fields: list[FormField]
    flagged: int  # how many fields the parser could not understand


# ---- sessions ----
class SessionIn(BaseModel):
    form: FormDef
    answers: dict[str, Any] = {}
    idx: int = Field(default=0, ge=0)
    lang: Lang = "en"


class SessionOut(SessionIn):
    id: str
    expires_at: datetime


class SessionCreated(BaseModel):
    id: str
    expires_at: datetime
