plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

// Public values only (same as js/config.js). The phone proves who it is with
// the device token it gets when paired from Admin → Payments.
val supabaseUrl = "https://ipcodsedkvxldqyxpnhx.supabase.co"
val supabaseKey = "sb_publishable_Gw8EB5CL_POqHkTF507-YA_8wbSlNkB"
val buildNumber = (System.getenv("GITHUB_RUN_NUMBER") ?: "1").toInt()

android {
    namespace = "online.xgoplus.sms"
    compileSdk = 34

    defaultConfig {
        applicationId = "online.xgoplus.sms"
        minSdk = 26
        targetSdk = 34
        versionCode = buildNumber
        versionName = "1.0.$buildNumber"
        buildConfigField("String", "SUPABASE_URL", "\"$supabaseUrl\"")
        buildConfigField("String", "SUPABASE_KEY", "\"$supabaseKey\"")
    }

    signingConfigs {
        create("release") {
            // Sideloaded internal tool: a fixed key so new versions install over old ones.
            storeFile = file("../release.keystore")
            storePassword = System.getenv("SMS_KEYSTORE_PASSWORD") ?: "xgoplus-sms"
            keyAlias = "xgosms"
            keyPassword = System.getenv("SMS_KEYSTORE_PASSWORD") ?: "xgoplus-sms"
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            signingConfig = signingConfigs.getByName("release")
        }
    }

    buildFeatures { buildConfig = true }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }
}

dependencies {
    implementation("androidx.work:work-runtime-ktx:2.9.1")
}
