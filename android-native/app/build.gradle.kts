plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("com.google.gms.google-services")
}

android {
    namespace = "com.reedersystems.commandcomms"
    compileSdk = 34

    defaultConfig {
        applicationId = "com.reedersystems.commandcomms"
        minSdk = 26
        targetSdk = 34
        versionCode = 1
        versionName = "1.0"

        buildConfigField("String", "BASE_URL", "\"https://comms.reeder-systems.com\"")
    }

    // Per-device build flavors.
    //
    // The audio transport, signaling, floor control, jitter buffer, Opus
    // codec, and dispatch UI are shared across every flavor — only
    // device-integration code and the device_type reported to the backend
    // differ. The regular phone build uses the existing Firebase package ID.
    // The bridge and SD7 builds use separate package IDs so they can coexist.
    flavorDimensions += "device"
    productFlavors {
        create("t320") {
            dimension = "device"
            buildConfigField("String", "RADIO_DEVICE_TYPE", "\"t320\"")
        }
        create("phone") {
            dimension = "device"
            versionCode = 4
            versionNameSuffix = "-phone-v4"
            // Reuse the existing authenticated phone session flow. The phone
            // source set renders the normal touch PTT UI, not the UHF bridge.
            buildConfigField("String", "RADIO_DEVICE_TYPE", "\"android_phone_bridge\"")
        }
        create("bridge") {
            dimension = "device"
            applicationIdSuffix = ".bridge"
            versionCode = 3
            versionNameSuffix = "-phone-bridge-v3"
            buildConfigField("String", "RADIO_DEVICE_TYPE", "\"android_phone_bridge\"")
        }
        create("sd7") {
            dimension = "device"
            applicationIdSuffix = ".sd7"
            versionNameSuffix = "-sd7"
            buildConfigField("String", "RADIO_DEVICE_TYPE", "\"siyata_sd7\"")
        }
    }

    // Preserve the existing bridge implementation under the new `bridge`
    // flavor name. The new `phone` flavor gets a clean handset source set.
    sourceSets {
        getByName("bridge").setRoot("src/phone")
        getByName("phone").setRoot("src/phoneClient")
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro"
            )
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }

    buildFeatures {
        compose = true
        buildConfig = true
    }

    composeOptions {
        kotlinCompilerExtensionVersion = "1.5.8"
    }

    packaging {
        resources {
            excludes += "/META-INF/{AL2.0,LGPL2.1}"
            excludes += "META-INF/INDEX.LIST"
            excludes += "META-INF/io.netty.versions.properties"
        }
    }
}

dependencies {
    val composeBom = platform("androidx.compose:compose-bom:2024.02.00")
    implementation(composeBom)

    val firebaseBom = platform("com.google.firebase:firebase-bom:33.6.0")
    implementation(firebaseBom)
    implementation("com.google.firebase:firebase-messaging-ktx")

    implementation("androidx.compose.ui:ui")
    implementation("androidx.compose.ui:ui-graphics")
    implementation("androidx.compose.ui:ui-tooling-preview")
    implementation("androidx.compose.material3:material3")
    implementation("androidx.compose.material:material-icons-extended")

    implementation("androidx.activity:activity-compose:1.8.2")
    implementation("androidx.navigation:navigation-compose:2.7.6")
    implementation("androidx.lifecycle:lifecycle-viewmodel-compose:2.7.0")
    implementation("androidx.lifecycle:lifecycle-runtime-ktx:2.7.0")
    implementation("androidx.lifecycle:lifecycle-runtime-compose:2.7.0")

    implementation("androidx.core:core-ktx:1.12.0")
    implementation("androidx.appcompat:appcompat:1.6.1")

    implementation("com.squareup.okhttp3:okhttp:4.12.0")
    implementation("com.google.code.gson:gson:2.10.1")

    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.7.3")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-play-services:1.7.3")

    implementation("io.socket:socket.io-client:2.1.0") {
        exclude(group = "org.json", module = "json")
    }

    implementation("com.google.android.gms:play-services-location:21.0.1")

    implementation(fileTree("libs") { include("*.jar") })

    debugImplementation("androidx.compose.ui:ui-tooling")
    debugImplementation("androidx.compose.ui:ui-test-manifest")
}
