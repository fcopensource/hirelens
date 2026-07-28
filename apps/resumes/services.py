from pathlib import Path

MAX_RESUME_BYTES = 5 * 1024 * 1024
MAX_RESUME_TEXT_CHARS = 18_000
ALLOWED_RESUME_EXTENSIONS = {".pdf", ".docx", ".txt"}


class ResumeError(ValueError):
    pass


def validate_and_extract_resume(uploaded_file) -> str:
    extension = Path(uploaded_file.name).suffix.lower()
    if extension not in ALLOWED_RESUME_EXTENSIONS:
        raise ResumeError("Upload a PDF, DOCX, or TXT resume.")
    if uploaded_file.size > MAX_RESUME_BYTES:
        raise ResumeError("The resume must be smaller than 5 MB.")

    try:
        if extension == ".pdf":
            text = _extract_pdf(uploaded_file)
        elif extension == ".docx":
            text = _extract_docx(uploaded_file)
        else:
            text = uploaded_file.read().decode("utf-8", errors="replace")
    except ResumeError:
        raise
    except Exception as exc:
        raise ResumeError(
            "We could not read this resume. Try exporting it as a text-based PDF."
        ) from exc
    finally:
        uploaded_file.seek(0)

    normalized = "\n".join(
        line.strip() for line in text.splitlines() if line.strip()
    )
    if len(normalized) < 40:
        raise ResumeError(
            "The resume has too little readable text. Scanned-image PDFs are not supported yet."
        )
    return normalized[:MAX_RESUME_TEXT_CHARS]


def _extract_pdf(uploaded_file) -> str:
    from pypdf import PdfReader

    reader = PdfReader(uploaded_file)
    if reader.is_encrypted:
        try:
            reader.decrypt("")
        except Exception as exc:
            raise ResumeError("Password-protected resumes are not supported.") from exc
    return "\n".join(page.extract_text() or "" for page in reader.pages[:12])


def _extract_docx(uploaded_file) -> str:
    from docx import Document

    document = Document(uploaded_file)
    return "\n".join(paragraph.text for paragraph in document.paragraphs)
