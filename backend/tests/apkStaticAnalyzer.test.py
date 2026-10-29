#!/usr/bin/env python3
"""
Test Suite for APK Static Analyzer (SPAPP Monitoring - Custom Apps)
Verifies manifest decoding, security barriers (Zip Slip, corrupted files),
framework identification, and compatibility classifications.
"""

import unittest
import os
import sys
import io
import json
import zipfile
import tempfile
import struct

# Ensure backend/src/utils is importable
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "../src/utils")))
import apkStaticAnalyzer as analyzer


class TestAPKStaticAnalyzer(unittest.TestCase):

    def setUp(self):
        self.temp_dir = tempfile.mkdtemp()

    def tearDown(self):
        import shutil
        if os.path.isdir(self.temp_dir):
            shutil.rmtree(self.temp_dir, ignore_errors=True)

    def test_missing_file(self):
        """Verify non-existent file path returns clean error without crashing."""
        result = analyzer.analyze_apk("f:/non_existent_file_xyz.apk")
        self.assertIn("error", result)
        self.assertIn("not found", result["error"])

    def test_corrupted_archive(self):
        """Verify non-zip corrupted binary returns BadZipFile error gracefully."""
        corrupt_path = os.path.join(self.temp_dir, "corrupt.apk")
        with open(corrupt_path, "wb") as f:
            f.write(b"NOT_A_VALID_ZIP_ARCHIVE_HEADER_CORRUPTED_BYTES")
        
        result = analyzer.analyze_apk(corrupt_path)
        self.assertIn("error", result)
        self.assertEqual(result.get("archiveIntegrity"), "CORRUPTED_ARCHIVE")

    def test_missing_manifest(self):
        """Verify zip archive missing AndroidManifest.xml is identified."""
        no_manifest_path = os.path.join(self.temp_dir, "no_manifest.apk")
        with zipfile.ZipFile(no_manifest_path, "w") as z:
            z.writestr("assets/test.txt", "Sample asset without manifest")

        result = analyzer.analyze_apk(no_manifest_path)
        self.assertIn("error", result)
        self.assertEqual(result.get("archiveIntegrity"), "MISSING_MANIFEST")

    def test_path_traversal_zip_slip_prevention(self):
        """Verify Zip Slip path traversal sequences are blocked."""
        malicious_apk = os.path.join(self.temp_dir, "malicious.apk")
        with zipfile.ZipFile(malicious_apk, "w") as z:
            z.writestr("../../etc/passwd", "malicious payload")
            z.writestr("AndroidManifest.xml", "dummy")

        result = analyzer.analyze_apk(malicious_apk)
        self.assertIn("error", result)
        self.assertEqual(result.get("archiveIntegrity"), "MALICIOUS_ZIP_SLIP_DETECTED")

    def test_framework_detection_flutter(self):
        """Verify Flutter detection using libflutter.so, libapp.so, and flutter_assets."""
        namelist = [
            "AndroidManifest.xml",
            "classes.dex",
            "lib/arm64-v8a/libflutter.so",
            "lib/arm64-v8a/libapp.so",
            "assets/flutter_assets/kernel_blob.bin"
        ]
        detection = analyzer.detect_application_framework(namelist)
        self.assertEqual(detection["detectedFramework"], "Flutter")
        self.assertEqual(detection["confidence"], "HIGH")
        self.assertTrue(detection["isCrossPlatform"])

    def test_framework_detection_react_native(self):
        """Verify React Native detection using libhermes.so and index.android.bundle."""
        namelist = [
            "AndroidManifest.xml",
            "classes.dex",
            "lib/arm64-v8a/libhermes.so",
            "assets/index.android.bundle"
        ]
        detection = analyzer.detect_application_framework(namelist)
        self.assertEqual(detection["detectedFramework"], "React Native")
        self.assertEqual(detection["confidence"], "HIGH")
        self.assertTrue(detection["isCrossPlatform"])

    def test_framework_detection_unity(self):
        """Verify Unity game engine detection."""
        namelist = [
            "AndroidManifest.xml",
            "classes.dex",
            "lib/arm64-v8a/libunity.so",
            "assets/bin/Data/sharedassets0.assets"
        ]
        detection = analyzer.detect_application_framework(namelist)
        self.assertEqual(detection["detectedFramework"], "Unity")
        self.assertTrue(detection["isCrossPlatform"])

    def test_framework_detection_kotlin(self):
        """Verify Native Kotlin detection."""
        namelist = [
            "AndroidManifest.xml",
            "classes.dex",
            "META-INF/app_release.kotlin_module",
            "kotlin/Unit.class"
        ]
        detection = analyzer.detect_application_framework(namelist)
        self.assertEqual(detection["detectedFramework"], "Native Android (Kotlin)")
        self.assertFalse(detection["isCrossPlatform"])

    def test_framework_detection_native_java(self):
        """Verify Native Java fallback when no cross-platform engines exist."""
        namelist = [
            "AndroidManifest.xml",
            "classes.dex",
            "res/layout/activity_main.xml"
        ]
        detection = analyzer.detect_application_framework(namelist)
        self.assertEqual(detection["detectedFramework"], "Native Android (Java)")
        self.assertFalse(detection["isCrossPlatform"])

    def test_compatibility_classification(self):
        """Verify permissions are properly classified into policy states."""
        perms = ["android.permission.READ_CALL_LOG", "android.permission.RECORD_AUDIO"]
        flutter_framework = {"detectedFramework": "Flutter", "isCrossPlatform": True}
        
        # Unauthorized third-party Flutter app
        matrix = analyzer.evaluate_permission_compatibility(perms, flutter_framework, is_authorized_source=False)
        self.assertEqual(len(matrix), 2)
        call_log = next(m for m in matrix if m["permission"] == "android.permission.READ_CALL_LOG")
        self.assertEqual(call_log["classification"], "Requires Source Integration")
        self.assertTrue(call_log["runtimeConsentRequired"])
        self.assertIn("CallLogCollector", call_log["sourceFrameworkReference"])

        # Authorized in-house app
        matrix_auth = analyzer.evaluate_permission_compatibility(perms, flutter_framework, is_authorized_source=True)
        call_log_auth = next(m for m in matrix_auth if m["permission"] == "android.permission.READ_CALL_LOG")
        self.assertEqual(call_log_auth["classification"], "Supported")

    def test_real_apk_inspection(self):
        """Verify full inspection against local test APK if available."""
        real_apk = r"F:\targetApk\com.lotteryonline.kerala_3.0.4.apk"
        if not os.path.exists(real_apk):
            self.skipTest(f"Test fixture not found: {real_apk}")

        result = analyzer.analyze_apk(real_apk, is_authorized_source=False)
        self.assertTrue(result["success"])
        self.assertEqual(result["basicInfo"]["packageName"], "com.lotteryonline.kerala")
        self.assertEqual(result["basicInfo"]["versionCode"], 34)
        self.assertEqual(result["basicInfo"]["versionName"], "3.0.4")
        self.assertEqual(result["frameworkDetection"]["detectedFramework"], "Flutter")
        self.assertGreater(result["manifest"]["activitiesCount"], 0)
        self.assertFalse(result["authorization"]["canProceedToBuild"])


if __name__ == "__main__":
    unittest.main()

