"""The scanner's focus check: a photo the phone had not focused on yet is told from a sharp one."""
import cv2
import numpy as np

from app import scanner


def _blurred(img, sigma):
    return cv2.GaussianBlur(img, (0, 0), sigma)


def test_sharpness_tells_focus(sample):
    img = cv2.imread(str(sample))
    q = scanner.find_page(img)
    page = scanner.warp(img, q)
    sharp = scanner.sharpness(page)
    assert sharp >= scanner.SHARP_MIN, sharp
    assert scanner.sharpness(_blurred(page, 2.0)) < scanner.SHARP_MIN
    assert scanner.sharpness(np.full((800, 600, 3), 255, np.uint8)) == 0.0  # blank: nothing to judge


def test_check_photo_flags_blur(client, sample):
    img = cv2.imread(str(sample))
    for sigma, blurry in ((0, False), (3.0, True)):
        im = _blurred(img, sigma) if sigma else img
        ok, buf = cv2.imencode(".jpg", im, [cv2.IMWRITE_JPEG_QUALITY, 85])
        r = client.post("/api/scan/check", files={"file": ("p.jpg", buf.tobytes(), "image/jpeg")})
        assert r.status_code == 200, r.text
        j = r.json()
        assert len(j["corners"]) == 4
        assert j["blurry"] is blurry, j["sharp"]
