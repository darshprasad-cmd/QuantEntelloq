from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[1]


class StaticSiteContract(unittest.TestCase):
    def test_required_public_files_exist(self):
        for name in ("index.html", "js/app.js", "js/app.min.js", "CNAME", "manifest.webmanifest"):
            self.assertTrue((ROOT / name).is_file(), name)

    def test_custom_domain_is_stable(self):
        self.assertEqual((ROOT / "CNAME").read_text(encoding="utf-8").strip(), "quant.entelloq.com")

    def test_product_entry_points_remain_present(self):
        html = (ROOT / "index.html").read_text(encoding="utf-8").lower()
        for label in ("quant", "portfolio", "intelligence"):
            self.assertIn(label, html)

    def test_frontend_source_and_served_bundle_are_nonempty(self):
        self.assertGreater((ROOT / "js/app.js").stat().st_size, 100_000)
        self.assertGreater((ROOT / "js/app.min.js").stat().st_size, 100_000)


if __name__ == "__main__":
    unittest.main()
