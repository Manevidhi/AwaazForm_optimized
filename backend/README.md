# AwaazForm Backend

FastAPI + SQLite + SQLAlchemy + Pydantic. Handles answer validation, form parsing (pasted text, .txt, PDF) and optional progress saving.

## Run

```bash
cd backend
python -m venv venv
source venv/bin/activate        # Windows: venv\Scripts\activate
pip install -r requirements.txt
cp .env.example .env            # Windows: copy .env.example .env
uvicorn app.main:app --reload --port 8001
```

Interactive docs: http://localhost:8001/docs

## Test

```bash
python -m pytest -q
```

## Endpoints

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/health` | Health check |
| GET | `/api/forms` | List sample forms |
| GET | `/api/forms/{id}` | One sample form (`scholar`, `camp`) |
| POST | `/api/validate` | Body `{field, raw}` -> `{valid, value, err}` |
| POST | `/api/parse/text` | Body `{text}` -> fields (unclear ones flagged) |
| POST | `/api/parse/file` | Multipart `file` (.txt or .pdf) -> fields |
| POST | `/api/sessions` | Save progress (optional, user-initiated) |
| GET | `/api/sessions/{id}` | Load saved progress |
| DELETE | `/api/sessions/{id}` | Delete saved progress |

## Privacy

- Sensitive answers (Aadhaar, PAN etc.) are never stored.
- Saved progress expires after 24 hours (`SESSION_TTL_HOURS`).
- Audio is never received or stored.
- The server never submits any form.

## Calling it from the frontend

```js
const API = 'http://localhost:8001/api';

const res = await fetch(`${API}/validate`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ field, raw: answerText }),
});
const { valid, value, err } = await res.json();
```

`err` is an i18n key the frontend already has (`errPhone`, `errDate`, ...).
