/**
 * `eztest mobile ...` commands: list devices, build and install the EZTest
 * device agents, and inspect a screen (hierarchy + screenshot) on a device.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Command } from 'commander';
import { AdbClient } from './adb.js';
import { AndroidDevice } from './android.js';
import { UsbmuxClient } from './usbmux.js';

export interface MobileCliIO {
  out(s: string): void;
  err(s: string): void;
  cwd: string;
}

/** The package's agents/ directory (next to src/ or dist/). */
export function agentsDir(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), '../../agents');
}

export const PREBUILT_APK = () => join(agentsDir(), 'android', 'prebuilt', 'eztest-agent.apk');

function which(cmd: string): boolean {
  return spawnSync(process.platform === 'win32' ? 'where' : 'which', [cmd], { stdio: 'ignore' }).status === 0;
}

/** Build the Android agent APK with Gradle (needs the Android SDK: ANDROID_HOME). */
export function buildAndroidAgent(io: MobileCliIO, out?: string): string | undefined {
  const project = join(agentsDir(), 'android');
  const gradle = existsSync(join(project, 'gradlew')) ? join(project, 'gradlew') : which('gradle') ? 'gradle' : undefined;
  const sdk = process.env.ANDROID_HOME ?? process.env.ANDROID_SDK_ROOT;
  if (!gradle || !sdk) {
    io.err([
      'Cannot build the EZTest Android agent here:',
      !gradle ? '  - Gradle is not installed' : '',
      !sdk ? '  - the Android SDK is not configured (set ANDROID_HOME)' : '',
      'Build it with Docker instead (any image with the Android SDK and Gradle), e.g.:',
      `  docker run --rm -v "${project}:/project" -w /project mingc/android-build-box gradle :app:assembleRelease`,
      `then copy app/build/outputs/apk/release/app-release.apk to ${PREBUILT_APK()} (or set mobile.android.agentApk).`,
    ].filter(Boolean).join('\n'));
    return undefined;
  }
  const r = spawnSync(gradle, ['-p', project, ':app:assembleRelease', '--console=plain'], { stdio: 'inherit' });
  if (r.status !== 0) {
    io.err('Gradle build of the EZTest Android agent failed');
    return undefined;
  }
  const apk = join(project, 'app', 'build', 'outputs', 'apk', 'release', 'app-release.apk');
  const dest = out ? resolve(io.cwd, out) : PREBUILT_APK();
  mkdirSync(dirname(dest), { recursive: true });
  copyFileSync(apk, dest);
  const sha = createHash('sha256').update(readFileSync(dest)).digest('hex');
  writeFileSync(`${dest}.sha256`, `${sha}  ${dest.split(/[\\/]/).pop()}\n`);
  io.out(`built ${dest} (sha256 ${sha})`);
  return dest;
}

/** Build the iOS agent (XCTest UI-test bundle) with xcodebuild; prints the .xctestrun to use as mobile.ios.xctestrun. */
export function buildIosAgent(io: MobileCliIO, simulator: boolean): string | undefined {
  if (process.platform !== 'darwin' || !which('xcodebuild')) {
    io.err('The EZTest iOS agent builds on macOS with Xcode (xcodebuild); see agents/ios/README.md');
    return undefined;
  }
  const project = join(agentsDir(), 'ios');
  const derived = join(project, 'build');
  const r = spawnSync('xcodebuild', ['build-for-testing', '-project', join(project, 'EZTestAgent.xcodeproj'), '-scheme', 'EZTestAgent', '-destination', simulator ? 'generic/platform=iOS Simulator' : 'generic/platform=iOS', '-derivedDataPath', derived], { stdio: 'inherit' });
  if (r.status !== 0) {
    io.err('xcodebuild build-for-testing failed (signing for devices needs your team: see agents/ios/README.md)');
    return undefined;
  }
  io.out(`built the iOS agent under ${join(derived, 'Build', 'Products')} (use the .xctestrun file there as mobile.ios.xctestrun)`);
  return derived;
}

export function registerMobileCommands(program: Command, io: MobileCliIO): void {
  const mobile = program.command('mobile').description('native mobile: devices, the EZTest device agents, screen inspection');
  const adbOpts = (c: Command) => c.option('--adb-host <host>', 'adb server host', '127.0.0.1').option('--adb-port <port>', 'adb server port', '5037');
  const adbOf = (o: { adbHost: string; adbPort: string }) => new AdbClient({ host: o.adbHost, port: Number(o.adbPort) });

  adbOpts(mobile.command('devices'))
    .description('list Android devices (adb) and iOS devices (usbmuxd)')
    .action(async (o: { adbHost: string; adbPort: string }) => {
      try {
        for (const d of await adbOf(o).devices()) io.out(`android  ${d.serial}  ${d.state}${d.props.model ? `  ${d.props.model}` : ''}`);
      } catch (e) {
        io.err(`android  ${(e as Error).message}`);
      }
      try {
        for (const d of await new UsbmuxClient().listDevices()) io.out(`ios      ${d.udid}  ${d.connectionType}`);
      } catch (e) {
        io.err(`ios      ${(e as Error).message}`);
      }
    });

  mobile
    .command('build-agent')
    .description('build the EZTest device agent: the Android instrumentation APK (Gradle + Android SDK) or the iOS XCTest runner (Xcode)')
    .option('--ios', 'build the iOS agent instead')
    .option('--device', 'iOS: build for devices (default: simulator)')
    .option('-o, --out <file>', 'Android: where to write the APK (default agents/android/prebuilt/eztest-agent.apk)')
    .action((o: { ios?: boolean; device?: boolean; out?: string }) => {
      const ok = o.ios ? buildIosAgent(io, !o.device) : buildAndroidAgent(io, o.out);
      if (!ok) process.exitCode = 1;
    });

  adbOpts(mobile.command('install-agent'))
    .description('install the EZTest Android agent APK on a device')
    .option('-s, --serial <serial>')
    .option('--apk <file>', 'agent APK', PREBUILT_APK())
    .action(async (o: { adbHost: string; adbPort: string; serial?: string; apk: string }) => {
      const adb = adbOf(o);
      const { pickAndroidDevice } = await import('./android.js');
      const serial = await pickAndroidDevice(adb, o.serial);
      if (!existsSync(o.apk)) throw new Error(`${o.apk} not found; run "eztest mobile build-agent" first`);
      await adb.install(serial, readFileSync(o.apk), 'eztest-agent.apk');
      io.out(`installed the EZTest agent on ${serial}`);
    });

  adbOpts(mobile.command('inspect'))
    .description('dump the current screen of an Android device: hierarchy XML and screenshot (an inspector for writing targets)')
    .option('-s, --serial <serial>')
    .option('-o, --out <prefix>', 'output file prefix', 'screen')
    .action(async (o: { adbHost: string; adbPort: string; serial?: string; out: string }) => {
      const apk = PREBUILT_APK();
      const device = await AndroidDevice.connect({ adb: adbOf(o), serial: o.serial, agentApk: existsSync(apk) ? apk : undefined });
      try {
        writeFileSync(resolve(io.cwd, `${o.out}.xml`), await device.source());
        writeFileSync(resolve(io.cwd, `${o.out}.png`), await device.screenshot());
        io.out(`wrote ${o.out}.xml and ${o.out}.png from ${device.deviceId}`);
      } finally {
        await device.close();
      }
    });
}
