"""Exercise AI request contracts without a provider key or network access."""
from pathlib import Path
import subprocess
import unittest


class AIProxyRegression(unittest.TestCase):
    def test_managed_ai_contracts(self):
        result = subprocess.run(
            ["node", "--test", str(Path(__file__).with_name("ai_proxy_regression.cjs"))],
            capture_output=True, text=True, timeout=20, check=False,
        )
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
