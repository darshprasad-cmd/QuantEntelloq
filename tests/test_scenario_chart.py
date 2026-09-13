"""Run the dependency-free behavioral regression in the existing static CI job."""
from pathlib import Path
import subprocess
import unittest


class ScenarioChartRegression(unittest.TestCase):
    def test_chart_retains_data_across_navigation_and_resize(self):
        result = subprocess.run(
            ["node", str(Path(__file__).with_name("scenario_chart_regression.cjs"))],
            capture_output=True, text=True, timeout=15, check=False,
        )
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
