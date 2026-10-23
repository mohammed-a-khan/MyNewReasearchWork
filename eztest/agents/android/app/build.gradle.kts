// The EZTest Android agent: one instrumentation APK (it instruments itself, so it can drive any
// app through UiAutomation). Build: `gradle :app:assembleRelease`, or `eztest mobile build-agent`.
plugins {
    id("com.android.application")
}

android {
    namespace = "io.eztest.agent"
    compileSdk = 35

    defaultConfig {
        applicationId = "io.eztest.agent"
        minSdk = 26
        targetSdk = 35
        versionCode = 1
        versionName = "1.0.0"
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            // Signed with the debug key so `adb install` works without a release keystore.
            signingConfig = signingConfigs.getByName("debug")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}

dependencies {
    implementation("androidx.test.uiautomator:uiautomator:2.3.0")
    implementation("androidx.test:monitor:1.7.2")
    testImplementation("junit:junit:4.13.2")
}
