// EZTest on TeamCity: Kotlin DSL (written by eztest init --ci teamcity; docs/pipelines.md).
// Needs the EZTest package in package.json (npm install --save-dev @eztech.com/eztest): npm ci installs it and the eztest command that npx runs.
// Commit as .teamcity/settings.kts and enable versioned settings (Kotlin) on the project.
//
//   EZTest smoke        VCS trigger on pull request branches       --pipeline pr
//   EZTest shard 1..4   nightly schedule trigger on the merge build --pipeline nightly --shard i/4 (EZTest balances them)
//   EZTest regression   merges the shards into one verified run, readiness gate
//   EZTest SIT / UAT    deployment configurations: run after that environment's deployment
//
// The schedule trigger runs at 02:00 in the time zone set below (timezone = "UTC").
// JUnit results go to the build's Tests tab (XML report processing), the run directory to the artifacts,
// and eztest gate fails the build on NO_GO. Parameters: env.EZTEST_MASTER_KEY (password type).
import jetbrains.buildServer.configs.kotlin.*
import jetbrains.buildServer.configs.kotlin.buildFeatures.XmlReport
import jetbrains.buildServer.configs.kotlin.buildFeatures.xmlReport
import jetbrains.buildServer.configs.kotlin.buildSteps.script
import jetbrains.buildServer.configs.kotlin.triggers.finishBuildTrigger
import jetbrains.buildServer.configs.kotlin.triggers.schedule
import jetbrains.buildServer.configs.kotlin.triggers.vcs

version = "2024.03"

// Shard build configurations (declared before the project uses them).
val shards = (1..4).map { i ->
    BuildType({
        id("EztestShard$i")
        name = "EZTest shard $i/4"
        eztestDefaults()
        steps {
            script { name = "Install"; scriptContent = "npm ci && npx eztest install-browsers chromium" }
            script { name = "Shard"; scriptContent = "npx eztest run --pipeline nightly --shard $i/4 --reporter json,junit || true" }
        }
    })
}

project {
    params {
        password("env.EZTEST_MASTER_KEY", "credentialsJSON:eztest-master-key")
        param("env.EZTEST_APP_VERSION", "%build.number%")
    }
    buildType(Smoke)
    shards.forEach { buildType(it) }
    buildType(Regression)
    buildType(DeploySit)
    buildType(TestSit)
    buildType(DeployUat)
    buildType(TestUat)
}

fun BuildType.eztestDefaults() {
    vcs { root(DslContext.settingsRoot) }
    artifactRules = "eztest-results => eztest-results"
    features {
        xmlReport {
            reportType = XmlReport.XmlReportType.JUNIT
            rules = "+:eztest-results/**/junit.xml"
        }
    }
}

object Smoke : BuildType({
    name = "EZTest smoke (pull requests)"
    eztestDefaults()
    params { param("env.EZTEST_BASE_REF", "origin/main") }
    steps {
        script { name = "Install"; scriptContent = "npm ci && npx eztest install-browsers chromium" }
        // Fails on failed journeys and on a NO_GO readiness decision (pipelines.pr.gate: readiness).
        script { name = "Smoke"; scriptContent = "npx eztest run --reporter html,json,junit --pipeline pr" }
    }
    triggers {
        vcs { branchFilter = "+:pull/*" }
    }
})


object Regression : BuildType({
    name = "EZTest nightly regression"
    vcs { root(DslContext.settingsRoot) }
    artifactRules = "eztest-results/merged => eztest-results"
    features {
        xmlReport {
            reportType = XmlReport.XmlReportType.JUNIT
            rules = "+:eztest-results/merged/junit.xml"
        }
    }
    steps {
        script { name = "Merge"; scriptContent = "npm ci && npx eztest merge shards -o eztest-results/merged --reporter html,json,junit --policy readiness-policy.yaml" }
        script { name = "Verify evidence"; scriptContent = "npx eztest evidence verify eztest-results/merged" }
        script { name = "Readiness gate"; scriptContent = "npx eztest gate eztest-results/merged --on-no-go fail" }
    }
    triggers {
        schedule {
            schedulingPolicy = daily {
                hour = 2
                timezone = "UTC"
            }
            branchFilter = "+:<default>"
            triggerBuild = always()
            withPendingChangesOnly = false
        }
    }
    dependencies {
        shards.forEachIndexed { index, shard ->
            dependency(shard) {
                snapshot { onDependencyFailure = FailureAction.ADD_PROBLEM }
                artifacts { artifactRules = "eztest-results => shards/${index + 1}" }
            }
        }
    }
})

object DeploySit : BuildType({
    name = "Deploy SIT"
    type = BuildTypeSettings.Type.DEPLOYMENT
    vcs { root(DslContext.settingsRoot) }
    steps { script { scriptContent = "echo deploy the app to SIT here" } }
})

object TestSit : BuildType({
    name = "EZTest SIT (after deployment)"
    eztestDefaults()
    params { param("env.EZTEST_DEPLOY_ENVIRONMENT", "sit") }
    steps {
        script { name = "Install"; scriptContent = "npm ci && npx eztest install-browsers chromium" }
        script { name = "SIT"; scriptContent = "npx eztest run --reporter html,json,junit --pipeline deploy-sit --policy readiness-policy.yaml" }
    }
    triggers { finishBuildTrigger { buildType = "${DeploySit.id}"; successfulOnly = true } }
    dependencies { snapshot(DeploySit) {} }
})

object DeployUat : BuildType({
    name = "Deploy UAT"
    type = BuildTypeSettings.Type.DEPLOYMENT
    vcs { root(DslContext.settingsRoot) }
    steps { script { scriptContent = "echo deploy the app to UAT here" } }
    dependencies { snapshot(TestSit) { onDependencyFailure = FailureAction.FAIL_TO_START } }
})

object TestUat : BuildType({
    name = "EZTest UAT (after deployment)"
    eztestDefaults()
    params { param("env.EZTEST_DEPLOY_ENVIRONMENT", "uat") }
    steps {
        script { name = "Install"; scriptContent = "npm ci && npx eztest install-browsers chromium" }
        script { name = "UAT"; scriptContent = "npx eztest run --reporter html,json,junit --pipeline deploy-uat --policy readiness-policy.yaml" }
    }
    triggers { finishBuildTrigger { buildType = "${DeployUat.id}"; successfulOnly = true } }
    dependencies { snapshot(DeployUat) {} }
})
