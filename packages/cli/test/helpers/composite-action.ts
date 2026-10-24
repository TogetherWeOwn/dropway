import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { runInNewContext } from "node:vm";
import { expect } from "vitest";
import { parse } from "yaml";

/** A deliberately bounded local runner, not a replacement for GitHub's runner.
 * Executes the actual composite bash steps; external actions fail closed.
 * Context values remain data. Unsupported expressions fail rather than skip.
 */
export async function actionMetadata(root: string) {
  const file = join(root, "action.yml");
  expect(existsSync(file), "root action.yml must exist before preview lifecycle behavior can run").toBe(true);
  const action = parse(await readFile(file, "utf8"));
  expect(action.runs?.using).toBe("composite");
  expect(Array.isArray(action.runs.steps)).toBe(true);
  return action;
}

function fileCommands(text: string): Record<string, string> {
  const values: Record<string, string> = {};
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const multiline = line.match(/^([^=<]+)<<(.+)$/);
    if (multiline) {
      const chunks: string[] = [];
      while (++i < lines.length && lines[i] !== multiline[2]) chunks.push(lines[i]!);
      values[multiline[1]!] = chunks.join("\n");
    } else {
      const equals = line.indexOf("=");
      if (equals > 0) values[line.slice(0, equals)] = line.slice(equals + 1);
    }
  }
  return values;
}

export async function executeAction(opts: {
  root: string;
  cwd: string;
  temp: string;
  event: Record<string, any>;
  eventName?: string;
  repository: string;
  inputs: Record<string, string>;
  env: Record<string, string>;
}) {
  const action = await actionMetadata(opts.root);
  const eventFile = join(opts.temp, "event.json");
  await writeFile(eventFile, JSON.stringify(opts.event));
  const env: Record<string, string> = {
    ...opts.env,
    GITHUB_ACTION_PATH: opts.root,
    GITHUB_WORKSPACE: opts.cwd,
    GITHUB_EVENT_PATH: eventFile,
    GITHUB_EVENT_NAME: opts.eventName ?? "pull_request",
    GITHUB_REPOSITORY: opts.repository,
    GITHUB_REPOSITORY_ID: String(opts.event.repository?.id ?? ""),
    GITHUB_RUN_ID: "100",
    GITHUB_RUN_ATTEMPT: "1",
    GITHUB_REF: `refs/pull/${opts.event.number}/merge`,
    GITHUB_SHA: "a".repeat(40),
    GITHUB_BASE_REF: "main",
    GITHUB_HEAD_REF: "preview-content",
    GITHUB_ACTOR: "contributor",
  };
  const context: Record<string, any> = {
    inputs: {}, env, steps: new Proxy({}, { get: (steps: Record<string, any>, name: string) => steps[name] ?? { outputs: {} } }),
    github: {
      event: opts.event, event_name: env.GITHUB_EVENT_NAME, repository: opts.repository,
      repository_id: env.GITHUB_REPOSITORY_ID, token: env.GITHUB_TOKEN ?? "",
      api_url: env.GITHUB_API_URL, ref: env.GITHUB_REF, sha: env.GITHUB_SHA,
      workspace: opts.cwd, action_path: opts.root, run_id: env.GITHUB_RUN_ID,
    },
    runner: { temp: opts.temp, os: "Linux" },
    always: () => true, success: () => true, failure: () => false, cancelled: () => false,
    toJSON: JSON.stringify, fromJSON: JSON.parse,
  };
  const evaluate = (expression: string) => runInNewContext(
    expression.trim().replace(/\.([A-Za-z_][\w-]*)/g, (_match, key) => `[${JSON.stringify(key)}]`),
    context, { timeout: 100 },
  );
  const render = (value: unknown): string => String(value ?? "").replace(/\$\{\{([\s\S]*?)\}\}/g, (_match, expression) => String(evaluate(expression) ?? ""));
  for (const [name, definition] of Object.entries<any>(action.inputs ?? {})) {
    context.inputs[name] = opts.inputs[name] ?? render(definition.default);
  }
  Object.assign(context.inputs, opts.inputs);
  let code = 0;
  let logs = "";
  for (const [index, step] of action.runs.steps.entries()) {
    if (step.if && !evaluate(String(step.if).replace(/^\$\{\{([\s\S]*)\}\}$/, "$1"))) continue;
    expect(step.uses, "offline harness supports local bash run steps, not external actions").toBeUndefined();
    expect(step.shell).toBe("bash");
    expect(typeof step.run).toBe("string");
    const output = join(opts.temp, `output-${index}`);
    const envFile = join(opts.temp, `env-${index}`);
    const pathFile = join(opts.temp, `path-${index}`);
    const summary = join(opts.temp, `summary-${index}`);
    await Promise.all([output, envFile, pathFile, summary].map((file) => writeFile(file, "")));
    const stepEnv = Object.fromEntries(Object.entries(step.env ?? {}).map(([key, value]) => [key, render(value)]));
    const script = join(opts.temp, `step-${index}.sh`);
    await writeFile(script, render(step.run));
    try {
      const result = await promisify(execFile)("/bin/bash", ["--noprofile", "--norc", "-eo", "pipefail", script], {
        cwd: step["working-directory"] ? render(step["working-directory"]) : opts.cwd,
        env: { ...env, ...stepEnv, GITHUB_OUTPUT: output, GITHUB_ENV: envFile, GITHUB_PATH: pathFile, GITHUB_STEP_SUMMARY: summary },
        timeout: 20_000, maxBuffer: 1024 * 1024,
      });
      logs += result.stdout + result.stderr;
    } catch (error: any) {
      code = typeof error.code === "number" ? error.code : 1;
      logs += (error.stdout ?? "") + (error.stderr ?? "");
    }
    const outputs = fileCommands(await readFile(output, "utf8"));
    if (step.id) context.steps[step.id] = { outputs };
    Object.assign(env, fileCommands(await readFile(envFile, "utf8")));
    const paths = (await readFile(pathFile, "utf8")).trim();
    if (paths) env.PATH = `${paths.split("\n").join(":")}:${env.PATH}`;
    logs += await readFile(summary, "utf8");
    if (code !== 0) break;
  }
  const outputs = Object.fromEntries(Object.entries<any>(action.outputs ?? {}).map(([name, definition]) => [name, render(definition.value)]));
  return { code, logs: logs.replace(/^::add-mask::.*$/gm, ""), outputs };
}
