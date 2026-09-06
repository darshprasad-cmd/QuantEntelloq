"""Protect account entry and asset loading when the public launch is redesigned."""
from html.parser import HTMLParser
from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[1]


class LaunchMarkup(HTMLParser):
    def __init__(self):
        super().__init__()
        self.elements = []

    def handle_starttag(self, tag, attrs):
        self.elements.append((tag, dict(attrs)))


class LaunchPageContract(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.markup = LaunchMarkup()
        cls.markup.feed((ROOT / "index.html").read_text(encoding="utf-8"))

    def test_existing_account_fields_remain_unique_and_labelled(self):
        for field in ("lp3-su-name", "lp3-su-email", "lp3-su-pass", "lp3-si-email", "lp3-si-pass"):
            matches = [attrs for tag, attrs in self.markup.elements if attrs.get("id") == field]
            self.assertEqual(len(matches), 1, field)
            self.assertTrue(matches[0].get("aria-label"), field)
            self.assertTrue(matches[0].get("autocomplete"), field)

    def test_every_launch_dialog_trigger_resolves(self):
        dialogs = {attrs["id"] for tag, attrs in self.markup.elements if tag == "dialog"}
        triggers = [attrs["data-qlaunch-dialog"] for _, attrs in self.markup.elements if "data-qlaunch-dialog" in attrs]
        self.assertTrue(triggers)
        for target in triggers:
            self.assertIn(target, dialogs)

    def test_new_launch_assets_are_local_and_present(self):
        assets = []
        for _, attrs in self.markup.elements:
            for attr in ("src", "href"):
                value = attrs.get(attr, "").split("?")[0]
                if value.startswith(("css/quant-", "js/quant-launch", "assets/quant-")):
                    assets.append(value)
        self.assertGreaterEqual(len(assets), 5)
        for value in assets:
            self.assertTrue((ROOT / value).is_file(), value)


if __name__ == "__main__":
    unittest.main()
