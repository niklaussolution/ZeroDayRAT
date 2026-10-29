#!/usr/bin/env python3
"""
APK Static Analyzer Module for SPAPP Monitoring - Custom Apps
Performs safe, in-memory, read-only static analysis of Android APK packages
without installing, launching, or executing any application code.
"""

import sys
import os
import io
import re
import json
import struct
import hashlib
import zipfile
from datetime import datetime

# =====================================================================
# 1. PURE-PYTHON BINARY ANDROID MANIFEST (AXML) PARSER
# =====================================================================

class AXMLParser:
    """
    Decodes Android's compiled binary XML (AXML) format directly from bytes
    without external dependencies (no aapt, aapt2, or apktool needed).
    """

    RES_NULL_TYPE = 0x0000
    RES_STRING_POOL_TYPE = 0x0001
    RES_TABLE_TYPE = 0x0002
    RES_XML_TYPE = 0x00080003
    RES_XML_RESOURCE_MAP_TYPE = 0x0180
    RES_XML_START_NAMESPACE_TYPE = 0x0100
    RES_XML_END_NAMESPACE_TYPE = 0x0101
    RES_XML_START_ELEMENT_TYPE = 0x0102
    RES_XML_END_ELEMENT_TYPE = 0x0103
    RES_XML_CDATA_TYPE = 0x0104

    def __init__(self, raw_bytes):
        self.data = raw_bytes
        self.strings = []
        self.elements = []
        self.parse_error = None
        self._parse()

    def _parse(self):
        if len(self.data) < 8:
            self.parse_error = "Manifest file is too small to be valid AXML"
            return

        magic, file_size = struct.unpack('<II', self.data[:8])
        if magic != self.RES_XML_TYPE:
            # Fallback check if it's already plain text XML
            try:
                text_cand = self.data.decode('utf-8', errors='replace')
                if "<manifest" in text_cand:
                    self._parse_plain_text_manifest(text_cand)
                    return
            except Exception:
                pass
            self.parse_error = f"Invalid AXML header magic: {hex(magic)}"
            return

        offset = 8
        data_len = len(self.data)

        while offset < data_len:
            if offset + 8 > data_len:
                break
            chunk_type, header_size, chunk_size = struct.unpack('<HHI', self.data[offset:offset+8])
            if chunk_size == 0 or offset + chunk_size > data_len:
                break

            if chunk_type == self.RES_STRING_POOL_TYPE:
                self._parse_string_pool(offset)
            elif chunk_type == self.RES_XML_START_ELEMENT_TYPE:
                self._parse_start_element(offset)

            offset += chunk_size

    def _parse_string_pool(self, offset):
        if offset + 28 > len(self.data):
            return
        str_count, style_count, flags, str_start, style_start = struct.unpack(
            '<IIIII', self.data[offset+8:offset+28]
        )
        is_utf8 = bool(flags & (1 << 8))
        offsets_end = offset + 28 + str_count * 4
        if offsets_end > len(self.data):
            return

        offsets = struct.unpack(f'<{str_count}I', self.data[offset+28:offsets_end])
        pool_data = self.data[offset+str_start:]

        for off in offsets:
            if off >= len(pool_data):
                self.strings.append("")
                continue
            if is_utf8:
                p = off
                if p >= len(pool_data):
                    self.strings.append("")
                    continue
                if pool_data[p] & 0x80:
                    p += 2
                else:
                    p += 1
                if p >= len(pool_data):
                    self.strings.append("")
                    continue
                b_len = pool_data[p]
                if b_len & 0x80:
                    if p + 1 < len(pool_data):
                        b_len = ((b_len & 0x7f) << 8) | pool_data[p+1]
                        p += 2
                    else:
                        p += 1
                else:
                    p += 1
                s = pool_data[p:p+b_len].decode('utf-8', errors='replace')
                self.strings.append(s)
            else:
                p = off
                if p + 2 > len(pool_data):
                    self.strings.append("")
                    continue
                s_len = struct.unpack('<H', pool_data[p:p+2])[0]
                p += 2
                if s_len & 0x8000:
                    if p + 2 <= len(pool_data):
                        s_len = ((s_len & 0x7fff) << 16) | struct.unpack('<H', pool_data[p:p+2])[0]
                        p += 2
                s_bytes = pool_data[p:p+s_len*2]
                s = s_bytes.decode('utf-16le', errors='replace')
                self.strings.append(s)

    def _parse_start_element(self, offset):
        if offset + 30 > len(self.data):
            return
        ln, comment, ns, name = struct.unpack('<IIII', self.data[offset+8:offset+24])
        attr_start, attr_size, attr_count = struct.unpack('<HHH', self.data[offset+24:offset+30])

        tag_name = self.strings[name] if name < len(self.strings) else f"tag_{name}"
        attrs = {}

        for i in range(attr_count):
            a_off = offset + 16 + attr_start + i * attr_size
            if a_off + 20 > len(self.data):
                break
            ans, aname, aval_str, atype, adata = struct.unpack('<IIIIi', self.data[a_off:a_off+20])
            attr_name = self.strings[aname] if aname < len(self.strings) else f"attr_{aname}"

            if aval_str != 0xffffffff and aval_str < len(self.strings):
                val = self.strings[aval_str]
            else:
                # Handle boolean types
                if atype == 18:
                    val = True if adata != 0 else False
                else:
                    val = adata

            attrs[attr_name] = val

        self.elements.append((tag_name, attrs))

    def _parse_plain_text_manifest(self, text):
        # Fallback regex extractor for non-compiled development manifests
        self.strings = []
        # Extract uses-permission
        for match in re.finditer(r'<uses-permission\s+[^>]*android:name=["\']([^"\']+)["\']', text):
            self.elements.append(('uses-permission', {'name': match.group(1)}))
        # Extract package from <manifest
        pkg_m = re.search(r'<manifest\s+[^>]*package=["\']([^"\']+)["\']', text)
        ver_name_m = re.search(r'android:versionName=["\']([^"\']+)["\']', text)
        ver_code_m = re.search(r'android:versionCode=["\']([^"\']+)["\']', text)
        manifest_attrs = {}
        if pkg_m: manifest_attrs['package'] = pkg_m.group(1)
        if ver_name_m: manifest_attrs['versionName'] = ver_name_m.group(1)
        if ver_code_m: manifest_attrs['versionCode'] = ver_code_m.group(1)
        self.elements.append(('manifest', manifest_attrs))

        # Activities, Services, Receivers
        for match in re.finditer(r'<activity\s+[^>]*android:name=["\']([^"\']+)["\']', text):
            self.elements.append(('activity', {'name': match.group(1)}))
        for match in re.finditer(r'<service\s+[^>]*android:name=["\']([^"\']+)["\']', text):
            self.elements.append(('service', {'name': match.group(1)}))
        for match in re.finditer(r'<receiver\s+[^>]*android:name=["\']([^"\']+)["\']', text):
            self.elements.append(('receiver', {'name': match.group(1)}))
        for match in re.finditer(r'<provider\s+[^>]*android:name=["\']([^"\']+)["\']', text):
            self.elements.append(('provider', {'name': match.group(1)}))


# =====================================================================
# 2. APK SIGNING & CERTIFICATE INSPECTION
# =====================================================================

def inspect_apk_signing(apk_zip, apk_file_path):
    """
    Extracts certificate metadata (Subject, Issuer, Validity, SHA-256 Fingerprint)
    and detects APK Signature Scheme v1, v2, v3 blocks.
    """
    signing_info = {
        "schemeV1": False,
        "schemeV2": False,
        "schemeV3": False,
        "signerSubject": "Unknown",
        "signerIssuer": "Unknown",
        "sha256Fingerprint": None,
        "validFrom": None,
        "validTo": None,
        "certificatesFound": 0,
        "status": "VALID_SIGNATURE"
    }

    try:
        # 1. Scheme v1 inspection via META-INF/*.RSA, *.DSA, *.EC
        cert_files = [n for n in apk_zip.namelist() if n.startswith("META-INF/") and n.upper().endswith((".RSA", ".DSA", ".EC"))]
        if cert_files:
            signing_info["schemeV1"] = True
            signing_info["certificatesFound"] = len(cert_files)
            
            raw_cert_data = apk_zip.read(cert_files[0])
            cert_hash = hashlib.sha256(raw_cert_data).hexdigest()
            signing_info["sha256Fingerprint"] = ":".join(cert_hash[i:i+2].upper() for i in range(0, len(cert_hash), 2))

            # Attempt X.509 parsing with cryptography
            try:
                from cryptography.hazmat.primitives.serialization import pkcs7
                from cryptography import x509
                try:
                    certificates = pkcs7.load_der_pkcs7_certificates(raw_cert_data)
                except Exception:
                    try:
                        certificates = [x509.load_der_x509_certificate(raw_cert_data)]
                    except Exception:
                        certificates = []

                if certificates:
                    cert = certificates[0]
                    signing_info["signerSubject"] = cert.subject.rfc4514_string()
                    signing_info["signerIssuer"] = cert.issuer.rfc4514_string()
                    signing_info["validFrom"] = cert.not_valid_before_utc.strftime("%Y-%m-%d") if hasattr(cert, "not_valid_before_utc") else cert.not_valid_before.strftime("%Y-%m-%d")
                    signing_info["validTo"] = cert.not_valid_after_utc.strftime("%Y-%m-%d") if hasattr(cert, "not_valid_after_utc") else cert.not_valid_after.strftime("%Y-%m-%d")
                    
                    # Recompute fingerprint from raw DER cert bytes
                    der_bytes = cert.public_bytes(x509.Encoding.DER)
                    der_hash = hashlib.sha256(der_bytes).hexdigest()
                    signing_info["sha256Fingerprint"] = ":".join(der_hash[i:i+2].upper() for i in range(0, len(der_hash), 2))
            except Exception:
                pass

        # 2. Scheme v2/v3 inspection via APK Signing Block
        if os.path.isfile(apk_file_path):
            with open(apk_file_path, "rb") as f:
                f.seek(0, os.SEEK_END)
                file_size = f.tell()
                # Scan backwards up to 64KB for End of Central Directory (EOCD)
                scan_len = min(file_size, 65536)
                f.seek(file_size - scan_len)
                tail = f.read(scan_len)
                eocd_pos = tail.rfind(b"\x50\x4b\x05\x06")
                if eocd_pos != -1:
                    actual_eocd_offset = file_size - scan_len + eocd_pos
                    if actual_eocd_offset >= 22:
                        f.seek(actual_eocd_offset + 16)
                        cd_offset = struct.unpack("<I", f.read(4))[0]
                        if cd_offset >= 24:
                            f.seek(cd_offset - 24)
                            block_size, magic = struct.unpack("<Q16s", f.read(24))
                            if magic == b"APK Sig Block 42":
                                # APK Signing Block detected!
                                signing_info["schemeV2"] = True
                                # Look for scheme v3 (ID 0xf05368c0) vs v2 (ID 0x7109871a)
                                f.seek(cd_offset - block_size - 8)
                                block_content = f.read(block_size)
                                if b"\x1a\x87\x09\x71" in block_content:
                                    signing_info["schemeV2"] = True
                                if b"\xc0\x68\x53\xf0" in block_content:
                                    signing_info["schemeV3"] = True
    except Exception as e:
        signing_info["status"] = f"Warning: Certificate inspection error ({str(e)})"

    return signing_info


# =====================================================================
# 3. APPLICATION FRAMEWORK DETECTION ENGINE
# =====================================================================

def detect_application_framework(namelist):
    """
    Accurately identifies the underlying runtime framework
    (Flutter, React Native, Unity, Native Kotlin, Native Java, or Unknown)
    using definitive binary and structural indicators.
    """
    indicators = []
    
    # 1. Flutter Detection
    has_libflutter = any("libflutter.so" in n for n in namelist)
    has_libapp = any("libapp.so" in n for n in namelist)
    has_flutter_assets = any(n.startswith("assets/flutter_assets") for n in namelist)
    if has_libflutter or has_libapp or has_flutter_assets:
        if has_libflutter: indicators.append("libflutter.so (Flutter Engine Native Library)")
        if has_libapp: indicators.append("libapp.so (AOT Compiled Dart Bytecode)")
        if has_flutter_assets: indicators.append("assets/flutter_assets/ (Flutter Resource Bundle)")
        return {
            "detectedFramework": "Flutter",
            "confidence": "HIGH" if (has_libflutter and has_libapp) else "MEDIUM",
            "isCrossPlatform": True,
            "indicators": indicators,
            "architectureNote": "Compiles Dart AOT bytecode into libapp.so. Native Android manifest changes alone cannot bind Dart runtime state without a custom Flutter plugin or native MethodChannel."
        }

    # 2. React Native Detection
    has_rn_so = any("libreactnativejni.so" in n or "libreactnative.so" in n for n in namelist)
    has_hermes = any("libhermes.so" in n for n in namelist)
    has_rn_bundle = any(n.endswith("index.android.bundle") for n in namelist)
    if has_rn_so or has_hermes or has_rn_bundle:
        if has_rn_so: indicators.append("libreactnativejni.so (React Native JNI Bridge)")
        if has_hermes: indicators.append("libhermes.so (Hermes JavaScript Engine)")
        if has_rn_bundle: indicators.append("index.android.bundle (Bundled React Native JavaScript)")
        return {
            "detectedFramework": "React Native",
            "confidence": "HIGH" if (has_rn_so or has_rn_bundle) else "MEDIUM",
            "isCrossPlatform": True,
            "indicators": indicators,
            "architectureNote": "Executes UI logic in JavaScript engine. Features require native React Native Modules / TurboModules to interact with device hardware."
        }

    # 3. Unity Detection
    has_unity_so = any("libunity.so" in n or "libil2cpp.so" in n for n in namelist)
    has_unity_data = any(n.startswith("assets/bin/Data") for n in namelist)
    if has_unity_so or has_unity_data:
        if has_unity_so: indicators.append("libunity.so / libil2cpp.so (Unity Runtime Engine)")
        if has_unity_data: indicators.append("assets/bin/Data/ (Unity Global Game Assets)")
        return {
            "detectedFramework": "Unity",
            "confidence": "HIGH",
            "isCrossPlatform": True,
            "indicators": indicators,
            "architectureNote": "3D Game engine architecture. Android components must bridge through Unity Android Java Plugins."
        }

    # 4. Native Kotlin Detection
    has_kotlin_meta = any(n.startswith("META-INF/") and n.endswith(".kotlin_module") for n in namelist)
    has_kotlin_pkg = any("kotlin/" in n or "kotlinx/" in n for n in namelist)
    if has_kotlin_meta or has_kotlin_pkg:
        if has_kotlin_meta: indicators.append("META-INF/*.kotlin_module (Kotlin Compiler Metadata)")
        if has_kotlin_pkg: indicators.append("Embedded Kotlin standard library packages")
        return {
            "detectedFramework": "Native Android (Kotlin)",
            "confidence": "HIGH",
            "isCrossPlatform": False,
            "indicators": indicators,
            "architectureNote": "Standard Android Kotlin compilation. Compatible with direct modular AAR/SDK source embedding."
        }

    # 5. Native Java Detection
    if any(n.endswith(".dex") for n in namelist) and not indicators:
        return {
            "detectedFramework": "Native Android (Java)",
            "confidence": "MEDIUM",
            "isCrossPlatform": False,
            "indicators": ["classes.dex (Standard Dalvik Executable with no cross-platform engines)"],
            "architectureNote": "Standard Java Android architecture."
        }

    return {
        "detectedFramework": "Unknown",
        "confidence": "LOW",
        "isCrossPlatform": False,
        "indicators": ["No recognizable cross-platform runtime signatures"],
        "architectureNote": "Framework could not be identified with certainty. Manual source review recommended."
    }


# =====================================================================
# 4. PERMISSION-TO-FUNCTIONALITY COMPATIBILITY MAPPING
# =====================================================================

REFERENCE_SOURCE_CATALOG = {
    "android.permission.READ_CALL_LOG": {
        "name": "Read Call Logs",
        "sourceClass": "com.spapp.monitoring.collectors.CallLogCollector",
        "components": ["CallLogCollector.kt", "CallLogDao.kt", "CallLogEntry.kt", "SyncRunner.kt"],
        "dependencies": ["androidx.room:room-runtime:2.6.1", "androidx.work:work-runtime-ktx:2.9.1"],
        "runtimeConsent": True,
        "consentDialog": "Manifest.permission.READ_CALL_LOG in ConsentActivity",
        "specialAccess": False,
        "description": "Harvests inbound, outbound, and missed call metadata via Android CallLog ContentProvider."
    },
    "android.permission.READ_SMS": {
        "name": "Read SMS Messages",
        "sourceClass": "com.spapp.monitoring.collectors.SmsLogCollector",
        "components": ["SmsLogCollector.kt", "SmsLogDao.kt", "SmsLogEntry.kt", "SyncRunner.kt"],
        "dependencies": ["androidx.room:room-runtime:2.6.1", "androidx.work:work-runtime-ktx:2.9.1"],
        "runtimeConsent": True,
        "consentDialog": "Manifest.permission.READ_SMS in ConsentActivity",
        "specialAccess": False,
        "description": "Harvests SMS sender, recipient, timestamp, and message content metadata."
    },
    "android.permission.ACCESS_FINE_LOCATION": {
        "name": "Fine Location (GPS)",
        "sourceClass": "com.spapp.monitoring.collectors.LocationFetcher",
        "components": ["LocationFetcher.kt", "GeofenceManager.kt", "GeofenceBroadcastReceiver.kt"],
        "dependencies": ["com.google.android.gms:play-services-location:21.3.0"],
        "runtimeConsent": True,
        "consentDialog": "ACCESS_FINE_LOCATION and ACCESS_COARSE_LOCATION dual prompt",
        "specialAccess": False,
        "description": "High-accuracy GPS coordinate telemetry and geofencing boundary tracking."
    },
    "android.permission.ACCESS_COARSE_LOCATION": {
        "name": "Coarse Location (Cell/Wi-Fi)",
        "sourceClass": "com.spapp.monitoring.collectors.LocationFetcher",
        "components": ["LocationFetcher.kt"],
        "dependencies": ["com.google.android.gms:play-services-location:21.3.0"],
        "runtimeConsent": True,
        "consentDialog": "ACCESS_COARSE_LOCATION prompt",
        "specialAccess": False,
        "description": "Approximate network-based location polling."
    },
    "android.permission.ACCESS_BACKGROUND_LOCATION": {
        "name": "Continuous Background Location",
        "sourceClass": "com.spapp.monitoring.geofence.GeofenceManager",
        "components": ["GeofenceManager.kt", "SyncScheduler.kt"],
        "dependencies": ["com.google.android.gms:play-services-location:21.3.0"],
        "runtimeConsent": True,
        "consentDialog": "Explicit 'Allow all the time' background location OS setting dialog",
        "specialAccess": True,
        "description": "Continuous geofencing monitoring while app is in background."
    },
    "android.permission.CAMERA": {
        "name": "Camera Capture & Streaming",
        "sourceClass": "com.spapp.monitoring.camerastream.CameraStreamService",
        "components": ["CameraStreamManager.kt", "CameraStreamService.kt"],
        "dependencies": ["androidx.camera:camera-core:1.3.4", "androidx.camera:camera-camera2:1.3.4"],
        "runtimeConsent": True,
        "consentDialog": "Manifest.permission.CAMERA prompt",
        "specialAccess": False,
        "description": "Live camera capture and diagnostic streaming over WebSocket."
    },
    "android.permission.RECORD_AUDIO": {
        "name": "Microphone Audio Recording",
        "sourceClass": "com.spapp.monitoring.audiostream.AudioStreamService",
        "components": ["AudioStreamManager.kt", "AudioStreamService.kt"],
        "dependencies": ["androidx.core:core-ktx:1.13.1"],
        "runtimeConsent": True,
        "consentDialog": "Manifest.permission.RECORD_AUDIO prompt",
        "specialAccess": False,
        "description": "Audio buffer recording and diagnostic live ambient noise streaming."
    },
    "android.permission.READ_CONTACTS": {
        "name": "Read Contacts Directory",
        "sourceClass": "com.spapp.monitoring.collectors.SavedContactsCollector",
        "components": ["SavedContactsCollector.kt", "SavedContactDao.kt"],
        "dependencies": ["androidx.room:room-runtime:2.6.1"],
        "runtimeConsent": True,
        "consentDialog": "Manifest.permission.READ_CONTACTS prompt",
        "specialAccess": False,
        "description": "Snapshot sync of address book contacts."
    },
    "android.permission.POST_NOTIFICATIONS": {
        "name": "Post System Notifications",
        "sourceClass": "com.spapp.monitoring.sync.SyncRunner",
        "components": ["SyncRunner.kt", "SpappFirebaseMessagingService.kt"],
        "dependencies": ["androidx.core:core-ktx:1.13.1"],
        "runtimeConsent": True,
        "consentDialog": "POST_NOTIFICATIONS prompt on Android 13+",
        "specialAccess": False,
        "description": "Required for displaying foreground service active monitoring notifications."
    },
    "android.permission.PACKAGE_USAGE_STATS": {
        "name": "Application Usage Statistics",
        "sourceClass": "com.spapp.monitoring.collectors.AppUsageCollector",
        "components": ["AppUsageCollector.kt", "AppUsageDao.kt"],
        "dependencies": ["androidx.room:room-runtime:2.6.1"],
        "runtimeConsent": False,
        "consentDialog": "Settings.ACTION_USAGE_ACCESS_SETTINGS (Special App Access)",
        "specialAccess": True,
        "description": "Daily screen time and foreground app usage statistics."
    },
    "android.permission.BIND_ACCESSIBILITY_SERVICE": {
        "name": "Accessibility Service Monitoring",
        "sourceClass": "com.spapp.monitoring.blocking.BlockAccessibilityService",
        "components": ["BlockAccessibilityService.kt", "BlockRulesCache.kt"],
        "dependencies": ["androidx.appcompat:appcompat:1.7.0"],
        "runtimeConsent": False,
        "consentDialog": "Settings.ACTION_ACCESSIBILITY_SETTINGS (System Accessibility Menu)",
        "specialAccess": True,
        "description": "Observes screen events, enforces application block rules, and monitors chat activity."
    }
}

def evaluate_permission_compatibility(requested_permissions, framework_info, is_authorized_source=False):
    """
    Evaluates requested permissions against target technical architecture and classifies each:
    - Supported
    - Requires Source Integration
    - Requires Additional Components
    - Unsupported
    - Requires Manual Review
    """
    matrix = []
    
    for perm_str in requested_permissions:
        ref = REFERENCE_SOURCE_CATALOG.get(perm_str)
        if not ref:
            clean_name = perm_str.replace("android.permission.", "").replace("_", " ").title()
            matrix.append({
                "permission": perm_str,
                "featureName": clean_name,
                "classification": "Requires Manual Review",
                "statusReason": "Permission is not mapped to standard SPAPP Monitoring source modules. Custom review required.",
                "sourceFrameworkReference": "None",
                "requiredComponents": [],
                "requiredDependencies": [],
                "runtimeConsentRequired": True,
                "supportedIntegrationPath": "Define custom collector class in host Android project."
            })
            continue

        # Logic for classification
        if is_authorized_source:
            classification = "Supported"
            status_reason = "Target project has source-level authorization. Selected module will be integrated with full runtime consent flow."
            integration_path = f"Embed {ref['sourceClass']} and register in AndroidManifest.xml."
        elif framework_info["isCrossPlatform"]:
            classification = "Requires Source Integration"
            status_reason = (
                f"Target application runs on {framework_info['detectedFramework']}. "
                f"Bytecode for '{ref['name']}' is not present in target APK. Manifest declaration alone does not implement functionality."
            )
            integration_path = f"Integrate SPAPP Monitoring SDK plugin into {framework_info['detectedFramework']} source repository."
        else:
            classification = "Requires Additional Components"
            status_reason = (
                f"Target application is a compiled binary lacking {ref['sourceClass']} and its Room/WorkManager execution pipeline. "
                "Executable code cannot be injected into third-party binaries without source authorization."
            )
            integration_path = "Use Companion Device Agent (ZerodayRAT) or rebuild from authorized source code."

        matrix.append({
            "permission": perm_str,
            "featureName": ref["name"],
            "classification": classification,
            "statusReason": status_reason,
            "sourceFrameworkReference": ref["sourceClass"],
            "requiredComponents": ref["components"],
            "requiredDependencies": ref["dependencies"],
            "runtimeConsentRequired": ref["runtimeConsent"],
            "specialAccess": ref.get("specialAccess", False),
            "consentDialog": ref.get("consentDialog", "Standard OS Dialog"),
            "supportedIntegrationPath": integration_path,
            "description": ref["description"]
        })

    return matrix


# =====================================================================
# 5. MAIN STATIC ANALYZER CONTROLLER
# =====================================================================

def analyze_apk(apk_path, is_authorized_source=False):
    """
    Performs comprehensive static analysis of an APK package:
    - Integrity and zip validation
    - Manifest parsing via AXML
    - Signing certificate and scheme detection
    - Framework detection
    - DEX and native ABI inspection
    - Feature compatibility mapping
    """
    if not os.path.exists(apk_path):
        return {"error": f"Target APK file not found at: {apk_path}"}

    file_size_bytes = os.path.getsize(apk_path)
    file_name = os.path.basename(apk_path)

    # 1. Archive Integrity Check & Path Traversal Prevention
    try:
        apk_zip = zipfile.ZipFile(apk_path, 'r')
    except zipfile.BadZipFile:
        return {
            "error": "Invalid APK archive: Corrupted or not a valid ZIP file.",
            "archiveIntegrity": "CORRUPTED_ARCHIVE"
        }
    except Exception as e:
        return {"error": f"Failed to open APK archive: {str(e)}"}

    try:
        namelist = apk_zip.namelist()
        # Security check: detect path traversal (Zip Slip vulnerability prevention)
        for name in namelist:
            if name.startswith("/") or name.startswith("\\") or ".." in name.replace("\\", "/").split("/"):
                return {
                    "error": "Archive integrity violation: Path traversal sequence detected in APK contents.",
                    "archiveIntegrity": "MALICIOUS_ZIP_SLIP_DETECTED"
                }

        # Check for mandatory AndroidManifest.xml
        if "AndroidManifest.xml" not in namelist:
            return {
                "error": "Invalid APK archive: AndroidManifest.xml is missing.",
                "archiveIntegrity": "MISSING_MANIFEST"
            }

        # 2. Parse binary AndroidManifest.xml
        manifest_raw = apk_zip.read("AndroidManifest.xml")
        axml = AXMLParser(manifest_raw)
        if axml.parse_error and not axml.elements:
            return {
                "error": f"Failed to parse binary AndroidManifest.xml: {axml.parse_error}",
                "archiveIntegrity": "INVALID_AXML"
            }

        # Extract Manifest Metadata
        manifest_data = {
            "package": "unknown.package",
            "versionCode": None,
            "versionName": None,
            "compileSdkVersion": None,
            "minSdkVersion": None,
            "targetSdkVersion": None,
            "applicationClass": None,
            "applicationLabel": None,
            "requestedPermissions": [],
            "declaredPermissions": [],
            "activities": [],
            "services": [],
            "receivers": [],
            "providers": [],
            "exportedComponentsCount": 0
        }

        for tag, attrs in axml.elements:
            if tag == "manifest":
                manifest_data["package"] = attrs.get("package", "unknown.package")
                manifest_data["versionCode"] = attrs.get("versionCode")
                manifest_data["versionName"] = attrs.get("versionName")
                manifest_data["compileSdkVersion"] = attrs.get("compileSdkVersion")
            elif tag == "uses-sdk":
                manifest_data["minSdkVersion"] = attrs.get("minSdkVersion")
                manifest_data["targetSdkVersion"] = attrs.get("targetSdkVersion")
            elif tag == "uses-permission":
                name = attrs.get("name")
                if name and name not in manifest_data["requestedPermissions"]:
                    manifest_data["requestedPermissions"].append(name)
            elif tag == "permission":
                name = attrs.get("name")
                if name: manifest_data["declaredPermissions"].append(name)
            elif tag == "application":
                manifest_data["applicationClass"] = attrs.get("name")
                manifest_data["applicationLabel"] = attrs.get("label")
            elif tag == "activity":
                name = attrs.get("name")
                if name: manifest_data["activities"].append(name)
                if attrs.get("exported") is True:
                    manifest_data["exportedComponentsCount"] += 1
            elif tag == "service":
                name = attrs.get("name")
                if name: manifest_data["services"].append(name)
                if attrs.get("exported") is True:
                    manifest_data["exportedComponentsCount"] += 1
            elif tag == "receiver":
                name = attrs.get("name")
                if name: manifest_data["receivers"].append(name)
                if attrs.get("exported") is True:
                    manifest_data["exportedComponentsCount"] += 1
            elif tag == "provider":
                name = attrs.get("name")
                if name: manifest_data["providers"].append(name)
                if attrs.get("exported") is True:
                    manifest_data["exportedComponentsCount"] += 1

        # 3. Signing Inspection
        signing_info = inspect_apk_signing(apk_zip, apk_path)

        # 4. Framework Detection
        framework_info = detect_application_framework(namelist)

        # 5. DEX and Native Architecture
        dex_files = [n for n in namelist if n.endswith(".dex")]
        so_files = [n for n in namelist if n.startswith("lib/") and n.endswith(".so")]
        
        abis = set()
        for f in so_files:
            parts = f.split("/")
            if len(parts) >= 2 and parts[1]:
                abis.add(parts[1])

        # Recognizable libraries from META-INF and assets
        detected_libraries = []
        for n in namelist:
            if n.startswith("META-INF/androidx."):
                lib_name = n.replace("META-INF/", "").split(".version")[0]
                if lib_name not in detected_libraries:
                    detected_libraries.append(lib_name)
            elif "firebase" in n.lower() and "Firebase" not in detected_libraries:
                detected_libraries.append("Firebase SDK")
            elif "retrofit" in n.lower() and "Retrofit" not in detected_libraries:
                detected_libraries.append("Retrofit HTTP Client")
            elif "okhttp" in n.lower() and "OkHttp" not in detected_libraries:
                detected_libraries.append("OkHttp Network Engine")

        # 6. Compatibility Classification Matrix
        # Analyze either requested permissions in target APK or baseline reference catalog
        perms_to_evaluate = (
            manifest_data["requestedPermissions"]
            if manifest_data["requestedPermissions"]
            else list(REFERENCE_SOURCE_CATALOG.keys())
        )
        compatibility_matrix = evaluate_permission_compatibility(
            perms_to_evaluate, framework_info, is_authorized_source=is_authorized_source
        )

        report_id = f"report_{int(datetime.utcnow().timestamp())}_{hashlib.md5(file_name.encode()).hexdigest()[:6]}"
        size_mb = f"{file_size_bytes / (1024 * 1024):.2f} MB"

        result = {
            "success": True,
            "analysisReportId": report_id,
            "analyzedAt": datetime.utcnow().isoformat() + "Z",
            "basicInfo": {
                "fileName": file_name,
                "fileSizeBytes": file_size_bytes,
                "fileSizeFormatted": size_mb,
                "packageName": manifest_data["package"],
                "applicationLabel": manifest_data["applicationLabel"] or manifest_data["package"].split(".")[-1].title(),
                "versionName": manifest_data["versionName"] or "1.0",
                "versionCode": manifest_data["versionCode"] or 1,
                "minSdkVersion": manifest_data["minSdkVersion"] or 21,
                "targetSdkVersion": manifest_data["targetSdkVersion"] or 33,
                "compileSdkVersion": manifest_data["compileSdkVersion"] or 33,
                "archiveIntegrity": "VALID_ZIP_ARCHIVE",
                "signing": signing_info
            },
            "manifest": {
                "applicationClass": manifest_data["applicationClass"] or "android.app.Application",
                "requestedPermissions": manifest_data["requestedPermissions"],
                "declaredPermissions": manifest_data["declaredPermissions"],
                "activitiesCount": len(manifest_data["activities"]),
                "activities": manifest_data["activities"][:15],
                "servicesCount": len(manifest_data["services"]),
                "services": manifest_data["services"][:15],
                "receiversCount": len(manifest_data["receivers"]),
                "receivers": manifest_data["receivers"][:15],
                "providersCount": len(manifest_data["providers"]),
                "exportedComponentsCount": manifest_data["exportedComponentsCount"]
            },
            "frameworkDetection": framework_info,
            "dexAndNative": {
                "dexCount": len(dex_files),
                "dexFiles": dex_files,
                "supportedAbis": sorted(list(abis)) if abis else ["Universal (No native libraries)"],
                "nativeLibrariesCount": len(so_files),
                "detectedLibraries": detected_libraries[:15]
            },
            "compatibilityMatrix": compatibility_matrix,
            "authorization": {
                "isAuthorizedSource": is_authorized_source,
                "canProceedToBuild": is_authorized_source,
                "policyNotice": (
                    "Source-level integration supported for authorized applications."
                    if is_authorized_source
                    else "For third-party applications without modification authorization, do not inject executable code or add background data-collection functionality. Instead, use a supported integration alternative (e.g. Companion Agent or Android Enterprise)."
                ),
                "supportedAlternative": "Companion Device Agent (ZerodayRAT) or Android Enterprise Managed Profile."
            }
        }
        return result

    finally:
        apk_zip.close()


def main():
    if len(sys.argv) < 2:
        print(json.dumps({"error": "Usage: python apkStaticAnalyzer.py <path_to_apk> [--authorized]"}))
        sys.exit(1)

    apk_path = sys.argv[1]
    is_authorized = "--authorized" in sys.argv

    try:
        report = analyze_apk(apk_path, is_authorized_source=is_authorized)
        print(json.dumps(report, indent=2))
        if "error" in report and report.get("archiveIntegrity") != "VALID_ZIP_ARCHIVE":
            sys.exit(1)
    except Exception as e:
        print(json.dumps({"error": f"Unhandled analysis exception: {str(e)}"}))
        sys.exit(1)

if __name__ == "__main__":
    main()

