/**
 * CI pipelines written by `eztest init --ci <system>`. Every system gets the
 * same five things, in its own syntax:
 *
 * 1. a pull-request smoke job       (`eztest run --pipeline pr`: @smoke, impacted journeys, 10 min budget)
 * 2. a scheduled nightly regression (`--pipeline nightly`), split into parallel shards that are merged into one verified run
 * 3. an on-deploy job per environment (`--pipeline deploy-sit`, `deploy-uat`), after that environment's deployment
 * 4. JUnit results in the system's test view, the HTML report as an artifact
 * 5. the readiness gate: NO_GO fails the job (`eztest gate`)
 *
 * Retries, quarantine and test splitting are EZTest's own (`retries`, the
 * quarantine list, `--shard` balanced by historical duration); the CI system
 * only provides parallel machines. The `pipelines:` block that `eztest init`
 * writes into eztest.config.yaml defines what each `--pipeline` runs.
 */

export const CI_SYSTEMS = ['azure', 'github', 'gitlab', 'jenkins', 'teamcity', 'bitbucket', 'circleci'] as const;
export type CiSystemName = (typeof CI_SYSTEMS)[number];

const RUN = 'npx eztest run --reporter html,json,junit';

const GITHUB = `# EZTest on GitHub Actions (written by eztest init --ci github; docs/pipelines.md).
#
#   pull_request        -> smoke: --pipeline pr (@smoke, impacted journeys, 10 min budget)
#   schedule (nightly)  -> regression: --pipeline nightly in duration-balanced shards, merged into one verified run
#   workflow_dispatch   -> deploy-sit, then deploy-uat: run after that environment's deployment
#                          (or call this workflow from your deployment workflow: workflow_call)
#
# Schedules run in UTC on GitHub: '0 2 * * *' is 02:00 UTC every day.
# JUnit results: junit.xml artifacts and the job summary (GitHub has no built-in test tab).
# The readiness gate (eztest gate) fails the job on NO_GO.
# Optional: repository variable EZTEST_SERVER_URL and secret EZTEST_SERVER_TOKEN (a tester token) to publish runs,
# keep deployment records and share heal decisions, history and the shared store across machines.
name: EZTest
on:
  pull_request:
  schedule:
    - cron: '0 2 * * *'
  workflow_dispatch:
    inputs:
      environment:
        description: Environment that was just deployed (sit or uat)
        required: true
        default: sit
        type: choice
        options: [sit, uat]
  workflow_call:
    inputs:
      environment:
        required: true
        type: string
env:
  EZTEST_MASTER_KEY: \${{ secrets.EZTEST_MASTER_KEY }}
  EZTEST_SERVER_TOKEN: \${{ secrets.EZTEST_SERVER_TOKEN }}
  EZTEST_APP_VERSION: \${{ github.sha }}
jobs:
  smoke:
    if: github.event_name == 'pull_request'
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with: { fetch-depth: 0 }
      - uses: actions/setup-node@v4
        with: { node-version: 22 }
      - run: npm ci
      - run: npx eztest install-browsers chromium
      - run: ${RUN} --pipeline pr
        env: { EZTEST_BASE_REF: 'origin/\${{ github.base_ref }}' }
      # The run fails on failed journeys and on a NO_GO readiness decision (pipelines.pr.gate: readiness).
      - if: always()
        run: npx eztest ci summary "$(ls -td eztest-results/run-* | head -1)" >> "$GITHUB_STEP_SUMMARY"
      - if: always()
        uses: actions/upload-artifact@v4
        with: { name: eztest-pr, path: eztest-results }
  plan:
    if: github.event_name == 'schedule'
    runs-on: ubuntu-latest
    outputs:
      matrix: \${{ steps.m.outputs.matrix }}
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22 }
      - run: npm ci
      - uses: actions/cache/restore@v4
        with:
          path: .eztest
          key: eztest-history-\${{ github.run_id }}
          restore-keys: eztest-history-
      # Shard count and balance come from historical durations (results server or .eztest/history.json).
      - id: m
        run: echo "matrix=$(npx eztest ci matrix --shards auto --target 10m)" >> "$GITHUB_OUTPUT"
  test:
    needs: plan
    runs-on: ubuntu-latest
    strategy:
      fail-fast: false
      matrix: \${{ fromJSON(needs.plan.outputs.matrix) }}
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22 }
      - run: npm ci
      - run: npx eztest install-browsers chromium
      - uses: actions/cache/restore@v4
        with:
          path: .eztest
          key: eztest-history-\${{ github.run_id }}
          restore-keys: eztest-history-
      - run: npx eztest run --pipeline nightly --shard \${{ matrix.shard }} --reporter json,junit
      - if: always()
        uses: actions/upload-artifact@v4
        with:
          name: 'shard-\${{ matrix.index }}'
          path: eztest-results
  merge:
    needs: test
    if: always() && needs.test.result != 'skipped'
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22 }
      - run: npm ci
      - uses: actions/cache/restore@v4
        with:
          path: .eztest
          key: eztest-history-\${{ github.run_id }}
          restore-keys: eztest-history-
      - uses: actions/download-artifact@v4
        with: { pattern: 'shard-*', path: shards }
      # One run: evidence re-chained and linked to every shard chain, history, triage, readiness, reports.
      - run: npx eztest merge shards -o eztest-results/merged --reporter html,json,junit
      - run: npx eztest evidence verify eztest-results/merged
      - if: vars.EZTEST_SERVER_URL != ''
        run: npx eztest publish eztest-results/merged --server "\${{ vars.EZTEST_SERVER_URL }}"
      - uses: actions/cache/save@v4
        if: always()
        with:
          path: .eztest
          key: eztest-history-\${{ github.run_id }}
      - if: always()
        run: npx eztest ci summary eztest-results/merged >> "$GITHUB_STEP_SUMMARY"
      - if: always()
        uses: actions/upload-artifact@v4
        with: { name: eztest-results, path: eztest-results/merged }
      - run: npx eztest gate eztest-results/merged --on-no-go fail
  deploy-sit:
    if: inputs.environment == 'sit'
    runs-on: ubuntu-latest
    environment: sit
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22 }
      - run: npm ci
      - run: npx eztest install-browsers chromium
      # deploy-sit: --env sit, the SIT test plan, a deployment record; values saved "for the pipeline" become job outputs.
      - id: eztest
        run: ${RUN} --pipeline deploy-sit
      - if: always()
        uses: actions/upload-artifact@v4
        with: { name: eztest-sit, path: eztest-results }
  deploy-uat:
    if: inputs.environment == 'uat'
    runs-on: ubuntu-latest
    environment: uat
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22 }
      - run: npm ci
      - run: npx eztest install-browsers chromium
      # requires: [deploy-sit] in the config: the run stops unless SIT passed for this version (results server).
      - run: ${RUN} --pipeline deploy-uat
      - if: always()
        uses: actions/upload-artifact@v4
        with: { name: eztest-uat, path: eztest-results }
`;

const AZURE = `# EZTest on Azure Pipelines (written by eztest init --ci azure; docs/pipelines.md, docs/azure-devops.md).
#
#   PR                 -> Smoke: --pipeline pr (@smoke, impacted journeys, 10 min budget), PR status
#   schedules          -> Regression: --pipeline nightly in duration-balanced shards, merged into one verified run
#   main               -> DeploySIT -> TestSIT -> DeployUAT -> TestUAT: deployment jobs in environments, then the tests
#
# Schedules: cron is UTC in Azure Pipelines ('0 2 * * *' = 02:00 UTC). always: true runs even without new commits.
# JUnit results go to the Tests tab, the run directory to the pipeline artifacts, and the readiness gate
# (eztest gate) fails the stage on NO_GO, so later stages do not run.
# Variables: EZTEST_MASTER_KEY (secret), optional EZTEST_SERVER_URL / EZTEST_SERVER_TOKEN (secret).
# Multi-stage templates with the EZTest task: node_modules/eztest/integrations/azure-devops/templates.
trigger: [main]
pr: [main]
schedules:
  - cron: '0 2 * * *'
    displayName: Nightly regression (02:00 UTC)
    branches: { include: [main] }
    always: true

pool: { vmImage: ubuntu-latest }
variables:
  npm_config_cache: $(Pipeline.Workspace)/.npm
  EZTEST_APP_VERSION: $(Build.BuildNumber)

stages:
  - stage: Smoke
    condition: eq(variables['Build.Reason'], 'PullRequest')
    jobs:
      - job: smoke
        steps:
          - checkout: self
            fetchDepth: 0
          - task: NodeTool@0
            inputs: { versionSpec: '22.x' }
          - script: npm ci
          - script: npx eztest install-browsers chromium
          - script: ${RUN} --pipeline pr
            name: eztest
            env:
              EZTEST_MASTER_KEY: $(EZTEST_MASTER_KEY)
              EZTEST_BASE_REF: origin/$(System.PullRequest.TargetBranchName)
          - script: |
              RUN_DIR=$(ls -td eztest-results/run-* | head -1)
              echo "##vso[task.setvariable variable=EZTEST_RUN_DIR]$RUN_DIR"
            condition: always()
          - task: PublishTestResults@2
            condition: always()
            inputs: { testResultsFormat: JUnit, testResultsFiles: '$(EZTEST_RUN_DIR)/junit.xml', testRunTitle: 'EZTest smoke' }
          - task: PublishPipelineArtifact@1
            condition: always()
            inputs: { targetPath: '$(EZTEST_RUN_DIR)', artifact: eztest-smoke }
          # PR status "EZTest: GO / NO_GO" and the summary thread (the run itself already failed on NO_GO).
          - script: npx eztest pr report "$(EZTEST_RUN_DIR)"
            condition: always()
            env: { SYSTEM_ACCESSTOKEN: $(System.AccessToken) }

  - stage: Regression
    condition: eq(variables['Build.Reason'], 'Schedule')
    jobs:
      - job: plan
        steps:
          - task: NodeTool@0
            inputs: { versionSpec: '22.x' }
          - script: npm ci
          - script: echo "##vso[task.setvariable variable=matrix;isOutput=true]$(npx eztest ci matrix --provider azure --shards auto --target 10m)"
            name: m
            env: { EZTEST_SERVER_TOKEN: $(EZTEST_SERVER_TOKEN) }
      - job: test
        dependsOn: plan
        strategy:
          matrix: $[ dependencies.plan.outputs['m.matrix'] ]
        steps:
          - task: NodeTool@0
            inputs: { versionSpec: '22.x' }
          - script: npm ci
          - script: npx eztest install-browsers chromium
          - script: npx eztest run --pipeline nightly --shard $(SHARD) --reporter json,junit
            env:
              EZTEST_MASTER_KEY: $(EZTEST_MASTER_KEY)
              EZTEST_SERVER_TOKEN: $(EZTEST_SERVER_TOKEN)
          - task: PublishPipelineArtifact@1
            condition: always()
            inputs: { targetPath: eztest-results, artifact: 'shard-$(SHARD_INDEX)' }
      - job: merge
        dependsOn: test
        condition: succeededOrFailed()
        steps:
          - task: NodeTool@0
            inputs: { versionSpec: '22.x' }
          - script: npm ci
          - task: DownloadPipelineArtifact@2
            inputs: { patterns: 'shard-*/**', path: shards }
          - script: npx eztest merge shards -o eztest-results/merged --reporter html,json,junit
          - script: npx eztest evidence verify eztest-results/merged
          - script: npx eztest publish eztest-results/merged --server "$(EZTEST_SERVER_URL)"
            condition: and(succeededOrFailed(), ne(variables['EZTEST_SERVER_URL'], ''))
            env: { EZTEST_SERVER_TOKEN: $(EZTEST_SERVER_TOKEN) }
          - task: PublishTestResults@2
            condition: always()
            inputs: { testResultsFormat: JUnit, testResultsFiles: 'eztest-results/merged/junit.xml', testRunTitle: 'EZTest nightly regression' }
          - task: PublishPipelineArtifact@1
            condition: always()
            inputs: { targetPath: eztest-results/merged, artifact: eztest-results }
          - script: npx eztest gate eztest-results/merged --on-no-go fail --on-risks warn
            condition: succeededOrFailed()

  - stage: DeploySIT
    condition: and(succeeded(), eq(variables['Build.SourceBranch'], 'refs/heads/main'), ne(variables['Build.Reason'], 'Schedule'))
    jobs:
      - deployment: deploy
        environment: sit
        strategy: { runOnce: { deploy: { steps: [ { script: echo "deploy the app to SIT here" } ] } } }

  # Run after deployment: a deployment job in the same environment, so the run shows on the environment's history.
  - stage: TestSIT
    dependsOn: DeploySIT
    jobs:
      - deployment: eztest
        environment: sit
        strategy:
          runOnce:
            deploy:
              steps:
                - checkout: self
                - task: NodeTool@0
                  inputs: { versionSpec: '22.x' }
                - script: npm ci
                - script: npx eztest install-browsers chromium
                # deploy-sit: --env sit, the SIT test plan, a deployment record, build tags and summary.
                # Values saved "for the pipeline" become output variables of this step (eztest.<name>).
                - script: ${RUN} --pipeline deploy-sit
                  name: eztest
                  env:
                    EZTEST_MASTER_KEY: $(EZTEST_MASTER_KEY)
                    EZTEST_SERVER_TOKEN: $(EZTEST_SERVER_TOKEN)
                    SYSTEM_ACCESSTOKEN: $(System.AccessToken)
                - task: PublishTestResults@2
                  condition: always()
                  inputs: { testResultsFormat: JUnit, testResultsFiles: 'eztest-results/run-*/junit.xml', testRunTitle: 'EZTest SIT' }
                - task: PublishPipelineArtifact@1
                  condition: always()
                  inputs: { targetPath: eztest-results, artifact: eztest-sit }

  - stage: DeployUAT
    dependsOn: TestSIT
    jobs:
      - deployment: deploy
        environment: uat
        strategy: { runOnce: { deploy: { steps: [ { script: echo "deploy the app to UAT here" } ] } } }

  - stage: TestUAT
    dependsOn: DeployUAT
    jobs:
      - deployment: eztest
        environment: uat
        strategy:
          runOnce:
            deploy:
              steps:
                - checkout: self
                - task: NodeTool@0
                  inputs: { versionSpec: '22.x' }
                - script: npm ci
                - script: npx eztest install-browsers chromium
                - script: ${RUN} --pipeline deploy-uat
                  name: eztest
                  env:
                    EZTEST_MASTER_KEY: $(EZTEST_MASTER_KEY)
                    EZTEST_SERVER_TOKEN: $(EZTEST_SERVER_TOKEN)
                    SYSTEM_ACCESSTOKEN: $(System.AccessToken)
                - task: PublishTestResults@2
                  condition: always()
                  inputs: { testResultsFormat: JUnit, testResultsFiles: 'eztest-results/run-*/junit.xml', testRunTitle: 'EZTest UAT' }
                - task: PublishPipelineArtifact@1
                  condition: always()
                  inputs: { targetPath: eztest-results, artifact: eztest-uat }
`;

const GITLAB = `# EZTest on GitLab CI/CD (written by eztest init --ci gitlab; docs/pipelines.md).
#
#   merge requests  -> eztest:smoke    --pipeline pr (@smoke, impacted journeys, 10 min budget)
#   schedules       -> eztest:regression (parallel: 4, EZTest shards by historical duration) -> eztest:merge
#                      Create the schedule in Build > Pipeline schedules: cron "0 2 * * *", and pick the time zone
#                      there (GitLab schedules run in the time zone you choose; the example means 02:00 in it).
#   main            -> deploy:sit -> eztest:sit -> deploy:uat -> eztest:uat (per environment, after its deployment)
#
# JUnit reports show on the merge request and the pipeline's Tests tab; the HTML report is an artifact;
# eztest gate fails the job on NO_GO. Variables: EZTEST_MASTER_KEY (masked), optional EZTEST_SERVER_URL / EZTEST_SERVER_TOKEN.
default:
  image: mcr.microsoft.com/devcontainers/javascript-node:22
  before_script:
    - npm ci
    - npx eztest install-browsers chromium

stages: [test, merge, deploy-sit, test-sit, deploy-uat, test-uat]

variables:
  EZTEST_APP_VERSION: $CI_COMMIT_SHORT_SHA

.eztest-artifacts: &eztest-artifacts
  when: always
  paths: [eztest-results/]
  reports:
    junit: eztest-results/**/junit.xml

eztest:smoke:
  stage: test
  rules:
    - if: $CI_PIPELINE_SOURCE == "merge_request_event"
  variables:
    GIT_DEPTH: "0"
    EZTEST_BASE_REF: origin/$CI_MERGE_REQUEST_TARGET_BRANCH_NAME
  script:
    # Fails on failed journeys and on a NO_GO readiness decision (pipelines.pr.gate: readiness).
    - ${RUN} --pipeline pr
  artifacts: *eztest-artifacts

eztest:regression:
  stage: test
  rules:
    - if: $CI_PIPELINE_SOURCE == "schedule"
  parallel: 4
  script:
    # CI_NODE_INDEX / CI_NODE_TOTAL select this job's shard (pipelines.nightly.shards).
    - npx eztest run --pipeline nightly --reporter json,junit || true
    - mkdir -p shards && cp -r eztest-results/run-* shards/
  artifacts:
    when: always
    paths: [shards/]

eztest:merge:
  stage: merge
  rules:
    - if: $CI_PIPELINE_SOURCE == "schedule"
      when: always
  needs: [eztest:regression]
  before_script: [npm ci]
  script:
    - npx eztest merge shards -o eztest-results/merged --reporter html,json,junit
    - npx eztest evidence verify eztest-results/merged
    - if [ -n "$EZTEST_SERVER_URL" ]; then npx eztest publish eztest-results/merged --server "$EZTEST_SERVER_URL"; fi
    - npx eztest gate eztest-results/merged --on-no-go fail
  artifacts: *eztest-artifacts

deploy:sit:
  stage: deploy-sit
  rules:
    - if: $CI_COMMIT_BRANCH == $CI_DEFAULT_BRANCH && $CI_PIPELINE_SOURCE != "schedule"
  environment: { name: sit }
  before_script: []
  script:
    - echo "deploy the app to SIT here"

eztest:sit:
  stage: test-sit
  rules:
    - if: $CI_COMMIT_BRANCH == $CI_DEFAULT_BRANCH && $CI_PIPELINE_SOURCE != "schedule"
  needs: [deploy:sit]
  environment: { name: sit, action: verify }
  script:
    - ${RUN} --pipeline deploy-sit
  artifacts: *eztest-artifacts

deploy:uat:
  stage: deploy-uat
  rules:
    - if: $CI_COMMIT_BRANCH == $CI_DEFAULT_BRANCH && $CI_PIPELINE_SOURCE != "schedule"
      when: manual
  needs: [eztest:sit]
  environment: { name: uat }
  before_script: []
  script:
    - echo "deploy the app to UAT here"

eztest:uat:
  stage: test-uat
  rules:
    - if: $CI_COMMIT_BRANCH == $CI_DEFAULT_BRANCH && $CI_PIPELINE_SOURCE != "schedule"
  needs: [deploy:uat]
  environment: { name: uat, action: verify }
  script:
    - ${RUN} --pipeline deploy-uat
  artifacts: *eztest-artifacts
`;

const SHARD_STAGE = (i: number) => `          stage('Shard ${i}/4') {
            agent { label 'eztest' }
            steps {
              sh 'npm ci && npx eztest install-browsers chromium'
              sh 'npx eztest run --pipeline nightly --shard ${i}/4 --reporter json,junit || true'
              stash name: 'shard-${i}', includes: 'eztest-results/**', allowEmpty: true
            }
          }`;

const JENKINS = `// EZTest on Jenkins: a declarative pipeline (written by eztest init --ci jenkins; docs/pipelines.md).
//
//   pull requests (multibranch)  -> Smoke: --pipeline pr (@smoke, impacted journeys, 10 min budget)
//   cron (nightly)               -> Regression: 4 parallel shards (EZTest balances them), merged into one verified run
//   main                         -> Deploy SIT -> Test SIT -> Deploy UAT -> Test UAT
//
// The cron trigger uses the controller's time zone unless the spec starts with TZ=: here 02:00 UTC.
// JUnit results go to the build's Test Result view (junit step), the run directory is archived, and
// eztest gate fails the stage on NO_GO. Credentials: eztest-master-key (secret text), optional eztest-server-token.
pipeline {
  agent { label 'eztest' }
  options {
    timestamps()
    disableConcurrentBuilds(abortPrevious: true)
  }
  triggers {
    cron('''TZ=UTC
H 2 * * *''')
  }
  environment {
    EZTEST_MASTER_KEY = credentials('eztest-master-key')
    EZTEST_APP_VERSION = "\${env.BUILD_NUMBER}"
  }
  stages {
    stage('Smoke') {
      when { changeRequest() }
      environment { EZTEST_BASE_REF = "origin/\${env.CHANGE_TARGET}" }
      steps {
        sh 'npm ci && npx eztest install-browsers chromium'
        // Fails on failed journeys and on a NO_GO readiness decision (pipelines.pr.gate: readiness).
        sh '${RUN} --pipeline pr'
      }
      post {
        always {
          junit allowEmptyResults: true, testResults: 'eztest-results/run-*/junit.xml'
          archiveArtifacts artifacts: 'eztest-results/**', allowEmptyArchive: true
        }
      }
    }
    stage('Regression') {
      when { triggeredBy 'TimerTrigger' }
      stages {
        stage('Shards') {
          parallel {
${[1, 2, 3, 4].map(SHARD_STAGE).join('\n')}
          }
        }
        stage('Merge') {
          steps {
            sh 'npm ci'
            script {
              for (int i = 1; i <= 4; i++) {
                dir("shards/\${i}") { unstash "shard-\${i}" }
              }
            }
            sh 'npx eztest merge shards -o eztest-results/merged --reporter html,json,junit'
            sh 'npx eztest evidence verify eztest-results/merged'
            sh 'npx eztest gate eztest-results/merged --on-no-go fail'
          }
          post {
            always {
              junit allowEmptyResults: true, testResults: 'eztest-results/merged/junit.xml'
              archiveArtifacts artifacts: 'eztest-results/merged/**', allowEmptyArchive: true
            }
          }
        }
      }
    }
    stage('Deploy SIT') {
      when { allOf { branch 'main'; not { triggeredBy 'TimerTrigger' } } }
      steps {
        sh 'echo "deploy the app to SIT here"'
      }
    }
    stage('Test SIT') {
      when { allOf { branch 'main'; not { triggeredBy 'TimerTrigger' } } }
      steps {
        sh 'npm ci && npx eztest install-browsers chromium'
        sh '${RUN} --pipeline deploy-sit'
      }
      post {
        always {
          junit allowEmptyResults: true, testResults: 'eztest-results/run-*/junit.xml'
          archiveArtifacts artifacts: 'eztest-results/**', allowEmptyArchive: true
        }
      }
    }
    stage('Deploy UAT') {
      when { allOf { branch 'main'; not { triggeredBy 'TimerTrigger' } } }
      input { message 'Deploy to UAT?' }
      steps {
        sh 'echo "deploy the app to UAT here"'
      }
    }
    stage('Test UAT') {
      when { allOf { branch 'main'; not { triggeredBy 'TimerTrigger' } } }
      steps {
        sh '${RUN} --pipeline deploy-uat'
      }
      post {
        always {
          junit allowEmptyResults: true, testResults: 'eztest-results/run-*/junit.xml'
          archiveArtifacts artifacts: 'eztest-results/**', allowEmptyArchive: true
        }
      }
    }
  }
}
`;

const TEAMCITY = `// EZTest on TeamCity: Kotlin DSL (written by eztest init --ci teamcity; docs/pipelines.md).
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
        script { name = "Smoke"; scriptContent = "${RUN} --pipeline pr" }
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
        script { name = "Merge"; scriptContent = "npm ci && npx eztest merge shards -o eztest-results/merged --reporter html,json,junit" }
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
                artifacts { artifactRules = "eztest-results => shards/${'$'}{index + 1}" }
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
        script { name = "SIT"; scriptContent = "${RUN} --pipeline deploy-sit" }
    }
    triggers { finishBuildTrigger { buildType = "\${DeploySit.id}"; successfulOnly = true } }
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
        script { name = "UAT"; scriptContent = "${RUN} --pipeline deploy-uat" }
    }
    triggers { finishBuildTrigger { buildType = "\${DeployUat.id}"; successfulOnly = true } }
    dependencies { snapshot(DeployUat) {} }
})
`;

const BITBUCKET = `# EZTest on Bitbucket Pipelines (written by eztest init --ci bitbucket; docs/pipelines.md).
#
#   pull requests    -> smoke: --pipeline pr (@smoke, impacted journeys, 10 min budget)
#   custom: nightly  -> 4 parallel shards (EZTest balances them) merged into one verified run.
#                       Schedule it in Repository settings > Pipelines > Schedules: Daily, 02:00 (Bitbucket asks for
#                       the time in your local time zone and stores it as UTC).
#   main             -> deploy and test SIT, then UAT (deployment environments sit and uat)
#
# Test reports: junit.xml is copied into test-results/, which Bitbucket shows in the Tests tab; the run directory is an
# artifact; eztest gate fails the step on NO_GO. Repository variables: EZTEST_MASTER_KEY (secured).
image: mcr.microsoft.com/devcontainers/javascript-node:22

definitions:
  caches:
    eztest-browsers: ~/.cache/eztest
  steps:
    - step: &shard
        name: EZTest shard
        caches: [node, eztest-browsers]
        script:
          - npm ci && npx eztest install-browsers chromium
          # BITBUCKET_PARALLEL_STEP / _COUNT select this step's shard (pipelines.nightly.shards).
          - npx eztest run --pipeline nightly --reporter json,junit || true
          - mkdir -p shards && cp -r eztest-results/run-* shards/
        artifacts: [shards/**]

pipelines:
  pull-requests:
    '**':
      - step:
          name: EZTest smoke
          caches: [node, eztest-browsers]
          script:
            - export EZTEST_BASE_REF="origin/$BITBUCKET_PR_DESTINATION_BRANCH" EZTEST_APP_VERSION="$BITBUCKET_BUILD_NUMBER"
            - git fetch origin "$BITBUCKET_PR_DESTINATION_BRANCH"
            - npm ci && npx eztest install-browsers chromium
            # Fails on failed journeys and on a NO_GO readiness decision (pipelines.pr.gate: readiness).
            - ${RUN} --pipeline pr; status=$?
            - mkdir -p test-results && cp eztest-results/run-*/junit.xml test-results/ 2>/dev/null || true
            - exit $status
          artifacts: [eztest-results/**]
  custom:
    nightly:
      - parallel:
          - step: *shard
          - step: *shard
          - step: *shard
          - step: *shard
      - step:
          name: EZTest merge and gate
          caches: [node]
          script:
            - export EZTEST_SCHEDULED=true
            - npm ci
            - npx eztest merge shards -o eztest-results/merged --reporter html,json,junit
            - npx eztest evidence verify eztest-results/merged
            - mkdir -p test-results && cp eztest-results/merged/junit.xml test-results/eztest.xml
            - npx eztest gate eztest-results/merged --on-no-go fail
          artifacts: [eztest-results/merged/**]
  branches:
    main:
      - step:
          name: Deploy SIT
          deployment: sit
          script:
            - echo "deploy the app to SIT here"
      - step:
          name: EZTest SIT
          caches: [node, eztest-browsers]
          script:
            - export EZTEST_DEPLOY_ENVIRONMENT=sit EZTEST_APP_VERSION="$BITBUCKET_BUILD_NUMBER"
            - npm ci && npx eztest install-browsers chromium
            - ${RUN} --pipeline deploy-sit; status=$?
            - mkdir -p test-results && cp eztest-results/run-*/junit.xml test-results/ 2>/dev/null || true
            - exit $status
          artifacts: [eztest-results/**]
      - step:
          name: Deploy UAT
          deployment: uat
          trigger: manual
          script:
            - echo "deploy the app to UAT here"
      - step:
          name: EZTest UAT
          caches: [node, eztest-browsers]
          script:
            - export EZTEST_DEPLOY_ENVIRONMENT=uat EZTEST_APP_VERSION="$BITBUCKET_BUILD_NUMBER"
            - npm ci && npx eztest install-browsers chromium
            - ${RUN} --pipeline deploy-uat; status=$?
            - mkdir -p test-results && cp eztest-results/run-*/junit.xml test-results/ 2>/dev/null || true
            - exit $status
          artifacts: [eztest-results/**]
`;

const CIRCLECI = `# EZTest on CircleCI (written by eztest init --ci circleci; docs/pipelines.md).
#
#   pull requests / branches -> pr workflow: smoke, --pipeline pr (@smoke, impacted journeys, 10 min budget)
#   nightly                  -> regression workflow: parallelism 4 (EZTest balances the shards itself; no
#                               "circleci tests split"), merged into one verified run. Scheduled with a scheduled
#                               trigger at 02:00 UTC (CircleCI cron is UTC); or create a scheduled pipeline in the
#                               project settings that sets the pipeline parameter nightly: true.
#   main                     -> deploy workflow: deploy-sit -> eztest-sit -> approve -> deploy-uat -> eztest-uat
#
# JUnit results: store_test_results (the Tests tab); the HTML report: store_artifacts; eztest gate fails the job on NO_GO.
# Context "eztest": EZTEST_MASTER_KEY, optional EZTEST_SERVER_URL / EZTEST_SERVER_TOKEN.
version: 2.1

parameters:
  nightly:
    type: boolean
    default: false

executors:
  node:
    docker:
      - image: cimg/node:22.11-browsers

commands:
  setup:
    steps:
      - checkout
      - run: npm ci
      - run: npx eztest install-browsers chromium
  results:
    steps:
      - run:
          name: JUnit results
          when: always
          command: mkdir -p test-results && cp eztest-results/run-*/junit.xml test-results/ 2>/dev/null || true
      - store_test_results: { path: test-results }
      - store_artifacts: { path: eztest-results }

jobs:
  smoke:
    executor: node
    steps:
      - setup
      - run:
          name: EZTest smoke
          # Fails on failed journeys and on a NO_GO readiness decision (pipelines.pr.gate: readiness).
          command: EZTEST_BASE_REF=origin/main EZTEST_APP_VERSION=$CIRCLE_SHA1 ${RUN} --pipeline pr
      - results
  shard:
    executor: node
    parallelism: 4
    steps:
      - setup
      # CIRCLE_NODE_INDEX / CIRCLE_NODE_TOTAL select this container's shard (pipelines.nightly.shards).
      - run: EZTEST_SCHEDULED=true npx eztest run --pipeline nightly --reporter json,junit || true
      - run: mkdir -p shards/$CIRCLE_NODE_INDEX && cp -r eztest-results/run-* shards/$CIRCLE_NODE_INDEX/
      - persist_to_workspace: { root: ., paths: [shards] }
  merge:
    executor: node
    steps:
      - checkout
      - run: npm ci
      - attach_workspace: { at: . }
      - run: npx eztest merge shards -o eztest-results/merged --reporter html,json,junit
      - run: npx eztest evidence verify eztest-results/merged
      - run:
          name: JUnit results
          when: always
          command: mkdir -p test-results && cp eztest-results/merged/junit.xml test-results/
      - store_test_results: { path: test-results }
      - store_artifacts: { path: eztest-results/merged }
      - run: npx eztest gate eztest-results/merged --on-no-go fail
  deploy:
    parameters:
      environment: { type: string }
    executor: node
    steps:
      - run: echo "deploy the app to << parameters.environment >> here"
  eztest-after-deploy:
    parameters:
      environment: { type: string }
    executor: node
    steps:
      - setup
      - run:
          name: EZTest << parameters.environment >>
          command: EZTEST_DEPLOY_ENVIRONMENT=<< parameters.environment >> EZTEST_APP_VERSION=$CIRCLE_SHA1 ${RUN} --pipeline deploy-<< parameters.environment >>
      - results

workflows:
  pr:
    when:
      and:
        - not: << pipeline.parameters.nightly >>
        - not: { equal: [ main, << pipeline.git.branch >> ] }
    jobs:
      - smoke: { context: eztest }
  regression:
    when: << pipeline.parameters.nightly >>
    jobs:
      - shard: { context: eztest }
      - merge: { context: eztest, requires: [shard] }
  nightly:
    triggers:
      - schedule:
          cron: '0 2 * * *'
          filters: { branches: { only: [main] } }
    jobs:
      - shard: { context: eztest }
      - merge: { context: eztest, requires: [shard] }
  deploy:
    when:
      and:
        - not: << pipeline.parameters.nightly >>
        - equal: [ main, << pipeline.git.branch >> ]
    jobs:
      - deploy: { name: deploy-sit, environment: sit }
      - eztest-after-deploy: { name: eztest-sit, environment: sit, context: eztest, requires: [deploy-sit] }
      - approve-uat: { type: approval, requires: [eztest-sit] }
      - deploy: { name: deploy-uat, environment: uat, requires: [approve-uat] }
      - eztest-after-deploy: { name: eztest-uat, environment: uat, context: eztest, requires: [deploy-uat] }
`;

export const CI_TEMPLATES: Record<CiSystemName, Array<[path: string, content: string]>> = {
  azure: [['azure-pipelines.yml', AZURE]],
  github: [['.github/workflows/eztest.yml', GITHUB]],
  gitlab: [['.gitlab-ci.yml', GITLAB]],
  jenkins: [['Jenkinsfile', JENKINS]],
  teamcity: [['.teamcity/settings.kts', TEAMCITY]],
  bitbucket: [['bitbucket-pipelines.yml', BITBUCKET]],
  circleci: [['.circleci/config.yml', CIRCLECI]],
};
