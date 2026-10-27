import os
import re
import subprocess
import tempfile
import zipfile
from pathlib import Path, PurePosixPath

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse

UPLOAD_DIR = Path(os.getenv('UPLOAD_DIR', '/uploads')).resolve()
PREVIEW_DIR = Path(os.getenv('PREVIEW_DIR', '/previews')).resolve()
PREVIEW_DIR.mkdir(parents=True, exist_ok=True)
app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)
UUID_RE = re.compile(r'^[a-f0-9]{32}$')
OFFICE_EXTS = {'.doc', '.docx', '.odt', '.rtf', '.ppt', '.pptx', '.odp'}
MAX_ARCHIVE_ENTRIES = 10000
MAX_ARCHIVE_EXPANDED_SIZE = 5 * 1024**3
MAX_PREVIEW_PDF_SIZE = 500 * 1024**2
CONVERSION_TIMEOUT_SECONDS = 90


def source_file(uid: str) -> Path:
    if not UUID_RE.fullmatch(uid):
        raise HTTPException(400, 'Invalid file id')
    path = (UPLOAD_DIR / uid).resolve()
    if path.parent != UPLOAD_DIR or not path.is_file():
        raise HTTPException(404, 'File not found')
    return path


def safe_archive_name(raw_name: str) -> str:
    name = raw_name.replace('\\\\', '/')
    parts = PurePosixPath(name).parts
    if name.startswith('/') or '..' in parts or (parts and ':' in parts[0]):
        raise HTTPException(422, 'Archive contains an unsafe path')
    return name

@app.get('/health')
def health(): return {'status': 'ok'}

@app.get('/archive/{uid}/{filename:path}')
def archive(uid: str, filename: str):
    src = source_file(uid)
    if Path(filename).suffix.lower() not in {'.zip', '.cbz'}:
        raise HTTPException(415, 'Archive format not supported')
    rows = []
    try:
        with zipfile.ZipFile(src) as zf:
            infos = zf.infolist()
            if len(infos) > MAX_ARCHIVE_ENTRIES:
                raise HTTPException(413, 'Too many archive entries')
            total = 0
            for info in infos:
                name = safe_archive_name(info.filename)
                total += info.file_size
                if total > MAX_ARCHIVE_EXPANDED_SIZE:
                    raise HTTPException(413, 'Archive expansion exceeds preview budget')
                rows.append({'name': name, 'size': info.file_size,
                             'compressedSize': info.compress_size, 'directory': info.is_dir()})
    except zipfile.BadZipFile:
        raise HTTPException(422, 'Invalid ZIP archive')
    return {'entries': rows}

@app.get('/document/{uid}/{filename:path}')
def document(uid: str, filename: str):
    src = source_file(uid)
    ext = Path(filename).suffix.lower()
    if ext not in OFFICE_EXTS: raise HTTPException(415, 'Document format not supported')
    out = PREVIEW_DIR / f'{uid}.pdf'
    if not out.is_file() or out.stat().st_mtime < src.stat().st_mtime:
        with tempfile.TemporaryDirectory(prefix='lo-') as td:
            profile = Path(td) / 'profile'
            try:
                proc = subprocess.run(
                    ['libreoffice', f'-env:UserInstallation=file://{profile}', '--headless',
                     '--convert-to', 'pdf', '--outdir', td, str(src)],
                    capture_output=True, text=True, timeout=CONVERSION_TIMEOUT_SECONDS, check=False)
            except subprocess.TimeoutExpired:
                raise HTTPException(504, 'Document conversion timed out')
            converted = Path(td) / f'{src.name}.pdf'
            if proc.returncode or not converted.is_file():
                raise HTTPException(422, 'Unable to convert document')
            if converted.stat().st_size > MAX_PREVIEW_PDF_SIZE:
                raise HTTPException(413, 'Preview PDF exceeds limit')
            converted.replace(out)
    return FileResponse(out, media_type='application/pdf', filename='preview.pdf')
