import io
import os
import subprocess
import zipfile

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient

import app as worker


@pytest.fixture
def client(tmp_path, monkeypatch):
    uploads = tmp_path / "uploads"
    previews = tmp_path / "previews"
    uploads.mkdir()
    previews.mkdir()
    monkeypatch.setattr(worker, "UPLOAD_DIR", uploads)
    monkeypatch.setattr(worker, "PREVIEW_DIR", previews)
    return TestClient(worker.app), uploads, previews


def zip_bytes(entries):
    stream = io.BytesIO()
    with zipfile.ZipFile(stream, "w", zipfile.ZIP_DEFLATED) as archive:
        for name, data in entries:
            archive.writestr(name, data)
    return stream.getvalue()


def put(client, uploads, body, uid="a" * 32):
    (uploads / uid).write_bytes(body)
    return client.get(f"/archive/{uid}/bundle.zip")


def test_safe_uuid_paths_and_zip_list_without_extracting(client):
    http, uploads, _ = client
    uid = "a" * 32
    (uploads / uid).write_bytes(zip_bytes([("folder/file.txt", b"hello")]))
    response = http.get(f"/archive/{uid}/bundle.zip")
    assert response.status_code == 200
    assert response.json()["entries"] == [{"name": "folder/file.txt", "size": 5, "compressedSize": 7, "directory": False}]
    assert list(uploads.iterdir()) == [uploads / uid]
    for bad_uid in ("A" * 32, "a" * 31):
        assert http.get(f"/archive/{bad_uid}/bundle.zip").status_code == 400
    with pytest.raises(HTTPException):
        worker.source_file("../" + "a" * 29)


def test_archive_rejects_traversal_entries(client):
    http, uploads, _ = client
    (uploads / ("a" * 32)).write_bytes(zip_bytes([("../escape.txt", b"bad"), ("safe.txt", b"ok")]))
    response = http.get(f"/archive/{'a' * 32}/bundle.zip")
    assert response.status_code == 422


def test_archive_entry_count_and_expanded_size_caps(client, monkeypatch):
    http, uploads, _ = client
    monkeypatch.setattr(worker, "MAX_ARCHIVE_ENTRIES", 1, raising=False)
    (uploads / ("b" * 32)).write_bytes(zip_bytes([("one", b"1"), ("two", b"2")]))
    assert http.get(f"/archive/{'b' * 32}/x.zip").status_code == 413
    monkeypatch.setattr(worker, "MAX_ARCHIVE_ENTRIES", 10000)
    monkeypatch.setattr(worker, "MAX_ARCHIVE_EXPANDED_SIZE", 2, raising=False)
    (uploads / ("c" * 32)).write_bytes(zip_bytes([("large", b"123")]))
    assert http.get(f"/archive/{'c' * 32}/x.zip").status_code == 413


def test_office_conversion_cache_and_error_paths(client, monkeypatch):
    http, uploads, previews = client
    uid = "d" * 32
    source = uploads / uid
    source.write_bytes(b"office")
    calls = []

    def convert(args, **kwargs):
        calls.append(args)
        output = next(arg[9:] for arg in args if arg.startswith("--outdir ")) if False else None
        outdir = args[args.index("--outdir") + 1]
        (os.path.join(outdir, uid + ".pdf"))
        with open(os.path.join(outdir, uid + ".pdf"), "wb") as pdf:
            pdf.write(b"%PDF-1.4 fake")
        return subprocess.CompletedProcess(args, 0, "", "")

    monkeypatch.setattr(worker.subprocess, "run", convert)
    first = http.get(f"/document/{uid}/file.docx")
    assert first.status_code == 200 and first.content.startswith(b"%PDF")
    assert len(calls) == 1
    assert http.get(f"/document/{uid}/file.docx").content == first.content
    assert len(calls) == 1

    def failed(*args, **kwargs):
        return subprocess.CompletedProcess(args, 1, "", "conversion failed")

    (previews / f"{uid}.pdf").unlink()
    monkeypatch.setattr(worker.subprocess, "run", failed)
    assert http.get(f"/document/{uid}/file.docx").status_code == 422

    def timeout(*args, **kwargs):
        raise subprocess.TimeoutExpired(args[0], kwargs.get("timeout", 90))

    monkeypatch.setattr(worker.subprocess, "run", timeout)
    assert http.get(f"/document/{uid}/file.docx").status_code == 504
