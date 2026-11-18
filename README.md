# AwaazForm

A multilingual, voice-guided form assistant (English and Hindi) for people who find forms hard to fill: low vision, limited dexterity, low literacy, or language barriers.

AwaazForm asks one question at a time, listens to the answer, reads it back, and fills the form only after the user confirms. It never submits anything.

Built for Katathon 6.0, Problem 402, Theme 4: Assistive Technology. Team CodeKweens.

## Features

- Guided one-question-at-a-time flow with progress
- Voice answers (Web Speech API) and typed answers
- Read-back and explicit confirmation before every fill
- Numbered options for choice questions
- Validation for dates, mobile numbers, emails, PIN codes and sensitive IDs
- Paste questions, or upload a `.txt` or PDF file
- Review screen with edit-any-answer, save as PDF, or copy
- English and Hindi, switchable without losing answers
- Optional progress save on the device, deleted after 24 hours
- Accessibility: keyboard shortcuts, high contrast, large text, read-aloud toggle, ARIA live updates

## Run it

**Easiest (no server):** open `awaazform-standalone.html` in Chrome or Edge.

**Modular version (needs a local server):**

```bash
python -m http.server 8000
```

Then open http://localhost:8000. Voice features need Chrome or Edge on `localhost` or HTTPS.

## Project layout

```
index.html                  App page (modular version)
css/styles.css              All styles
js/i18n.js                  English and Hindi strings
js/data.js                  Sample forms, parser, validation, masking
js/speech.js                Speech input and output wrappers
js/app.js                   Screens, flow, review, export, accessibility
awaazform-standalone.html   Single-file build of everything above
tools/build_standalone.py   Regenerates the standalone file
```

After editing the modular files, rebuild the standalone file:

```bash
python3 tools/build_standalone.py
```

## Known limits (MVP)

- Speech uses the browser Web Speech API, not the Whisper server in the spec.
- Google Form links are checked, but their questions must be copied in by hand. Reading links needs the backend.
- Saved progress uses browser localStorage, not server-side encrypted sessions.
- PDF export uses the browser print dialog, so output is not a tagged PDF.
- Hindi voice depends on the computer having one installed.
- Marathi, the NVIDIA Nemotron step, and server TTS are not included yet.

## Team

Shagun (frontend), Meenakshi (prompts and LLM), Vidhi (backend), Shruti (pitch and spec), Harika (testing and QA).
