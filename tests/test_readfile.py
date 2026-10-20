"""讀檔 on the scan page: a PDF becomes its pages (kept flat, no photo correction), a transparent PNG is
white paper, a photo is still corrected, and a file that is neither is refused."""
import io

import numpy as np
from PIL import Image, ImageDraw

from app import scanner
from app.config import MEDIA_DIR
from tests.test_app import wait


def _page(text: str, rgba: bool = False) -> Image.Image:
    im = Image.new("RGBA" if rgba else "RGB", (1240, 1754), (255, 255, 255, 0) if rgba else "white")
    d = ImageDraw.Draw(im)
    d.rectangle([60, 60, 1180, 1694], outline=(0, 0, 0, 255), width=4)  # a table border: no "paper outline"
    for i in range(14):
        d.text((120, 140 + i * 100), f"{text} {i + 1}. 3/4 x 2 = ( )", fill=(0, 0, 0, 255))
    d.rectangle([700, 900, 1100, 1300], fill=(200, 200, 200, 255))  # a grey figure: flat-field would whiten it
    return im


def test_looks_digital():
    import cv2
    assert scanner.looks_digital(cv2.cvtColor(np.asarray(_page("A")), cv2.COLOR_RGB2BGR))
    # a photo of paper: shaded, noisy, desk around it
    rng = np.random.default_rng(1)
    photo = np.full((1200, 900, 3), 90, np.uint8)
    photo[100:1100, 120:780] = 215
    photo = np.clip(photo.astype(int) + rng.normal(0, 4, photo.shape), 0, 255).astype(np.uint8)
    assert not scanner.looks_digital(photo)


def test_pdf_png_and_photo(client, sample):
    buf = io.BytesIO()
    a, b = _page("第一頁"), _page("第二頁")
    a.save(buf, "PDF", save_all=True, append_images=[b], resolution=150)
    r = client.post("/api/exams", files=[("files", ("三上數學.pdf", buf.getvalue(), "application/pdf"))],
                    data={"sources": '["file"]'})
    assert r.status_code == 200, r.text
    assert r.json()["pages"] == 2
    assert wait(client, r.json()["job_id"])["status"] == "done"
    e = client.get(f"/api/exams/{r.json()['exam_id']}").json()
    assert len(e["pages"]) == 2
    for p in e["pages"]:
        assert p["meta"]["digital"] is True and p["meta"]["scan"]["digital"] and not p["meta"]["scan"]["warped"]
        im = Image.open(MEDIA_DIR / p["scan_path"])
        assert max(im.size) == 2400  # long side
        g = np.asarray(im.convert("L"))
        h, w = g.shape
        assert 170 < g[int(h * 0.62), int(w * 0.72)] < 230  # the grey figure stays grey (no flat-field)

    # a transparent PNG read in (讀檔) + a camera photo, one exam: the PNG is white paper and kept flat
    png = io.BytesIO()
    _page("透明", rgba=True).save(png, "PNG")
    with open(sample, "rb") as f:
        r = client.post("/api/exams", files=[("files", ("s.png", png.getvalue(), "image/png")),
                                             ("files", ("p.jpg", f.read(), "image/jpeg"))],
                        data={"sources": '["file", "photo"]'})
    assert r.status_code == 200, r.text
    assert wait(client, r.json()["job_id"])["status"] == "done"
    pages = client.get(f"/api/exams/{r.json()['exam_id']}").json()["pages"]
    assert pages[0]["meta"]["digital"] == "auto" and pages[0]["meta"]["scan"]["digital"]
    assert np.asarray(Image.open(MEDIA_DIR / pages[0]["scan_path"]).convert("L"))[30, 30] > 240  # not black
    assert "digital" not in pages[1]["meta"] and pages[1]["meta"]["scan"]["warped"]  # the photo: corrected

    # 再拍一頁 with a PDF: its pages are added
    buf2 = io.BytesIO()
    _page("補").save(buf2, "PDF")
    j = client.post(f"/api/exams/{r.json()['exam_id']}/pages", files={"files": ("more.pdf", buf2.getvalue(), "application/pdf")}).json()
    assert j["pages"] == 1 and wait(client, j["job_id"])["status"] == "done"


def test_bad_files_refused(client):
    r = client.post("/api/exams", files=[("files", ("x.pdf", b"%PDF-1.4 broken", "application/pdf"))])
    assert r.status_code == 400 and "PDF" in r.json()["detail"]
    r = client.post("/api/exams", files=[("files", ("notes.txt", b"hello", "text/plain"))])
    assert r.status_code == 400 and "不是圖片或 PDF" in r.json()["detail"]
