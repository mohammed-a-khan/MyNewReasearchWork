/**
 * Java Swing/AWT apps: start the app's JVM with EZTest's own `-javaagent`
 * (agents/java), wait for the agent to publish its port, and talk to it with
 * the ez-agent/1 client. The agent jar is built from the packaged sources
 * with the JDK's javac/jar when no prebuilt jar is configured.
 */
import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { AgentClient, AgentError } from './agent.js';

const run = promisify(execFile);
export const JAVA_AGENT_VERSION = '0.1.0';

/** Directory of the agent sources shipped with EZTest (agents/java). */
export function javaAgentSourceDir(): string {
  // src/desktop/java.ts and dist/desktop/java.js are both two levels below the package root.
  return resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'agents', 'java');
}

/** The agent jar: `configured` when given, else built once into `cacheDir` with javac + jar. */
export async function ensureJavaAgentJar(o: { configured?: string; cacheDir: string; javaHome?: string }): Promise<string> {
  if (o.configured) {
    if (!existsSync(o.configured)) throw new AgentError(`desktop.java.agentJar ${o.configured} does not exist (leave desktop.java.agentJar unset and EZTest compiles the agent with javac on first use, or build a jar from a clone of the repository with agents/java/build.sh)`, 'no-agent');
    return o.configured;
  }
  const jar = join(o.cacheDir, `ez-java-agent-${JAVA_AGENT_VERSION}.jar`);
  if (existsSync(jar)) return jar;
  const src = join(javaAgentSourceDir(), 'src', 'dev', 'eztest', 'agent');
  if (!existsSync(src)) throw new AgentError(`the Java agent sources are missing (${src}); set desktop.java.agentJar`, 'no-agent');
  const bin = (t: string) => (o.javaHome ? join(o.javaHome, 'bin', t) : t);
  const work = await mkdtemp(join(tmpdir(), 'ez-java-agent-'));
  try {
    const files = (await readdir(src)).filter((f) => f.endsWith('.java')).map((f) => join(src, f));
    await run(bin('javac'), ['--release', '11', '-d', join(work, 'classes'), ...files]);
    await writeFile(join(work, 'MANIFEST.MF'), 'Premain-Class: dev.eztest.agent.EzAgent\nAgent-Class: dev.eztest.agent.EzAgent\n');
    await mkdir(o.cacheDir, { recursive: true });
    await run(bin('jar'), ['cfm', jar, join(work, 'MANIFEST.MF'), '-C', join(work, 'classes'), '.']);
  } catch (e) {
    throw new AgentError(`could not build the Java agent with javac/jar (install a JDK 11+ or set desktop.java.agentJar): ${(e as Error).message.split('\n')[0]}`, 'no-agent');
  } finally {
    await rm(work, { recursive: true, force: true });
  }
  return jar;
}

export interface JavaAppHandle {
  client: AgentClient;
  process: ChildProcess;
  /** stderr/stdout tail of the app (for failure messages). */
  output(): string;
  stop(): Promise<void>;
}

/**
 * Start `command` (e.g. ["java", "-jar", "app.jar"]) with the agent. When the
 * command is not `java` itself (a launcher script), the agent goes in through
 * JAVA_TOOL_OPTIONS.
 */
export async function launchJavaApp(command: string[], o: { agentJar: string; cwd?: string; env?: Record<string, string>; timeoutMs?: number; token?: string }): Promise<JavaAppHandle> {
  const token = o.token ?? randomBytes(16).toString('hex');
  const dir = await mkdtemp(join(tmpdir(), 'ez-java-app-'));
  const portFile = join(dir, 'port');
  const agentArg = `-javaagent:${o.agentJar}=port=0,token=${token},portFile=${portFile}`;
  const [exe, ...rest] = command;
  const isJava = /^java(?:w)?(?:\.exe)?$/i.test(basename(exe));
  const env: NodeJS.ProcessEnv = { ...process.env, ...(o.env ?? {}) };
  if (!isJava) env.JAVA_TOOL_OPTIONS = `${env.JAVA_TOOL_OPTIONS ? `${env.JAVA_TOOL_OPTIONS} ` : ''}${agentArg}`;
  const args = isJava ? [agentArg, ...rest] : rest;
  const proc = spawn(exe, args, { cwd: o.cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  const keep = (d: Buffer) => {
    out = (out + d.toString('utf8')).slice(-4000);
  };
  proc.stdout?.on('data', keep);
  proc.stderr?.on('data', keep);
  let exited: number | null | undefined;
  proc.on('exit', (code) => {
    exited = code;
  });
  const stop = async () => {
    if (proc.exitCode === null && !proc.killed) {
      proc.kill('SIGTERM');
      await new Promise((r) => {
        const t = setTimeout(() => {
          proc.kill('SIGKILL');
          r(undefined);
        }, 3000);
        proc.once('exit', () => {
          clearTimeout(t);
          r(undefined);
        });
      });
    }
    await rm(dir, { recursive: true, force: true });
  };
  const deadline = Date.now() + (o.timeoutMs ?? 30_000);
  let port: number | undefined;
  while (Date.now() < deadline) {
    if (exited !== undefined) break;
    if (existsSync(portFile)) {
      port = Number((await readFile(portFile, 'utf8')).trim());
      if (port) break;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  if (!port) {
    await stop();
    throw new AgentError(`the Java app did not start the EZTest agent${exited !== undefined ? ` (it exited with code ${exited})` : ''}: ${out.trim().split('\n').slice(-5).join(' | ')}`, 'no-agent');
  }
  const client = new AgentClient({ url: `http://127.0.0.1:${port}`, token });
  await client.hello();
  // Wait for the first window.
  while (Date.now() < deadline) {
    if ((await client.windows()).length) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  return { client, process: proc, output: () => out, stop };
}
