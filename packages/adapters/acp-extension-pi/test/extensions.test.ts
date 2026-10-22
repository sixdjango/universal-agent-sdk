import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { discoverPiExtensions, parsePiLaunchArgs } from "../src/extensions.js";

const roots: string[] = [];
function root() {
  const dir = mkdtempSync(join(tmpdir(), "pi-extensions-test-"));
  roots.push(dir);
  return dir;
}
function snapshot(dir: string): Record<string, string> {
  const entries: Record<string, string> = {};
  const walk = (current: string, prefix: string) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      const key = prefix + entry.name;
      if (entry.isDirectory()) walk(path, `${key}/`);
      else entries[key] = readFileSync(path, "utf8");
    }
  };
  walk(dir, "");
  return entries;
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe("parsePiLaunchArgs", () => {
  it("accepts empty input and passes known pairs through unchanged", () => {
    expect(parsePiLaunchArgs([])).toEqual({ args: [], extensions: [] });
    expect(
      parsePiLaunchArgs([
        "--provider",
        "localtest",
        "--model",
        "fixture",
        "--thinking",
        "high",
      ]),
    ).toEqual({
      args: [
        "--provider",
        "localtest",
        "--model",
        "fixture",
        "--thinking",
        "high",
      ],
      extensions: [],
    });
  });

  it("normalizes explicit file and directory extensions once", () => {
    const dir = join(root(), "with space");
    mkdirSync(dir, { recursive: true });
    const file = join(dir, "ext.ts");
    writeFileSync(file, "export default function() {}");
    const parsed = parsePiLaunchArgs([
      "--model",
      "fixture",
      "-e",
      file,
      "--extension",
      join(dir, ".", "ext.ts"),
      "-e",
      dir,
    ]);
    expect(parsed.extensions).toEqual([file, dir]);
    expect(parsed.args).toEqual(["--model", "fixture", "-e", file, "-e", dir]);
  });

  it("trims selection values and dedupes real path aliases", () => {
    const dir = root();
    const file = join(dir, "ext.ts");
    writeFileSync(file, "export default function() {}");
    const parsed = parsePiLaunchArgs(["-e", ` ${file} `, "-e", file]);
    expect(parsed.extensions).toEqual([file]);
    if (process.platform !== "win32") {
      const link = join(dir, "alias.ts");
      symlinkSync(file, link);
      expect(parsePiLaunchArgs(["-e", link, "-e", file]).extensions).toEqual([
        link,
      ]);
    }
  });

  it("expands tilde extension paths against the home directory", () => {
    const home = root();
    vi.stubEnv("HOME", home);
    vi.stubEnv("USERPROFILE", home);
    const file = join(home, "pi-ext.ts");
    writeFileSync(file, "export default function() {}");
    const parsed = parsePiLaunchArgs(["-e", "~/pi-ext.ts"]);
    expect(parsed.extensions).toEqual([file]);
  });

  it("rejects remote, relative and missing extension paths", () => {
    const dir = root();
    for (const value of [
      "npm:package",
      "https://example.com/ext.git",
      "relative/path.ts",
      "./sibling.ts",
      join(dir, "missing.ts"),
    ]) {
      expect(() => parsePiLaunchArgs(["-e", value])).toThrow(/extension path/i);
    }
  });

  it("rejects unknown flags and missing values", () => {
    for (const args of [
      ["--extensions"],
      ["--provider"],
      ["--model", "-e"],
      ["--unknown", "value"],
    ]) {
      expect(() => parsePiLaunchArgs(args)).toThrow(/--provider|--extension/);
    }
  });

  it("bounds explicit selections", () => {
    const dir = root();
    const args: string[] = [];
    for (let i = 0; i < 33; i++) {
      const file = join(dir, `ext-${i}.ts`);
      writeFileSync(file, "export default function() {}");
      args.push("-e", file);
    }
    expect(() => parsePiLaunchArgs(args)).toThrow(/32/);
  });
});

describe("discoverPiExtensions", () => {
  async function inProfile(
    setup: (agentDir: string, project: string, dir: string) => void,
  ) {
    const dir = root();
    const agentDir = join(dir, "agent");
    const project = join(dir, "project");
    mkdirSync(join(agentDir, "extensions"), { recursive: true });
    mkdirSync(join(project, ".pi", "extensions"), { recursive: true });
    setup(agentDir, project, dir);
    vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
    vi.stubEnv("HOME", dir);
    const cwd = process.cwd();
    process.chdir(project);
    try {
      return { result: await discoverPiExtensions(), agentDir, dir };
    } finally {
      process.chdir(cwd);
    }
  }

  it("lists installed global candidates without executing them", async () => {
    const markerName = "imported-marker";
    const guard = (dir: string) =>
      `import {writeFileSync} from 'node:fs'; writeFileSync(${JSON.stringify(join(dir, markerName))}, 'x'); throw new Error('imported');`;
    let agentDir = "";
    let before: Record<string, string> = {};
    const { result, dir } = await inProfile((agent, project, dir) => {
      agentDir = agent;
      const explicit = join(dir, "explicit ext.ts");
      writeFileSync(join(agent, "extensions", "ambient.ts"), guard(dir));
      writeFileSync(explicit, guard(dir));
      const localPackage = join(dir, "local package");
      mkdirSync(localPackage);
      writeFileSync(
        join(localPackage, "package.json"),
        JSON.stringify({
          name: "local-package",
          version: "1.0.0",
          pi: { extensions: ["./entry.js"] },
        }),
      );
      writeFileSync(join(localPackage, "entry.js"), guard(dir));
      const npmPackage = join(agent, "npm", "node_modules", "fixture-package");
      mkdirSync(npmPackage, { recursive: true });
      writeFileSync(
        join(npmPackage, "package.json"),
        JSON.stringify({
          name: "fixture-package",
          version: "1.2.3",
          pi: { extensions: ["./index.js"] },
        }),
      );
      writeFileSync(join(npmPackage, "index.js"), guard(dir));
      const npmPackages: Array<[string, string[]]> = [
        ["@fixture/scoped", ["./index.ts"]],
        ["fixture-nested", ["./build/adapters/pi/extension.js"]],
        [
          "fixture-multi",
          ["./extensions/named.ts", "./extensions/other/index.tsx"],
        ],
      ];
      for (const [name, entries] of npmPackages) {
        const packageDir = join(agent, "npm", "node_modules", name);
        mkdirSync(join(packageDir, "build", "adapters", "pi"), {
          recursive: true,
        });
        mkdirSync(join(packageDir, "extensions", "other"), { recursive: true });
        writeFileSync(
          join(packageDir, "package.json"),
          JSON.stringify({
            name,
            version: "1.0.0",
            pi: { extensions: entries },
          }),
        );
        for (const entry of entries)
          writeFileSync(join(packageDir, entry), guard(dir));
      }
      for (const name of ["alpha", "beta"]) {
        mkdirSync(join(agent, "extensions", name));
        writeFileSync(join(agent, "extensions", name, "index.ts"), guard(dir));
      }
      writeFileSync(
        join(project, ".pi", "extensions", "project.ts"),
        guard(dir),
      );
      writeFileSync(
        join(project, ".pi", "settings.json"),
        JSON.stringify({ extensions: [join(project, "project-local.ts")] }),
      );
      writeFileSync(
        join(agent, "settings.json"),
        JSON.stringify({
          extensions: [explicit],
          packages: [
            "npm:fixture-package@1.2.3",
            "npm:@fixture/scoped@1.0.0",
            "npm:fixture-nested@1.0.0",
            "npm:fixture-multi@1.0.0",
            localPackage,
            "npm:@ua-fixture/missing-package@9.9.9",
          ],
        }),
      );
      before = snapshot(agent);
    });
    expect(result.version).toBe(1);
    expect(result.agentDir).toBe(agentDir);
    const npm = "agent/npm/node_modules/";
    expect(
      result.extensions
        .map((item) => [
          relative(dir, item.path).split(sep).join("/"),
          item.name,
          item.source,
        ])
        .sort(([a], [b]) => (a < b ? -1 : 1)),
    ).toEqual([
      ["agent/extensions/alpha/index.ts", "alpha", "directory"],
      ["agent/extensions/ambient.ts", "ambient.ts", "directory"],
      ["agent/extensions/beta/index.ts", "beta", "directory"],
      [`${npm}@fixture/scoped/index.ts`, "@fixture/scoped", "package"],
      [
        `${npm}fixture-multi/extensions/named.ts`,
        "fixture-multi:named.ts",
        "package",
      ],
      [
        `${npm}fixture-multi/extensions/other/index.tsx`,
        "fixture-multi:other",
        "package",
      ],
      [
        `${npm}fixture-nested/build/adapters/pi/extension.js`,
        "fixture-nested",
        "package",
      ],
      [`${npm}fixture-package/index.js`, "fixture-package", "package"],
      ["explicit ext.ts", "explicit ext.ts", "settings"],
      ["local package/entry.js", "local package", "package"],
    ]);
    expect(
      result.warnings.some((warning) => /not installed/i.test(warning)),
    ).toBe(true);
    expect(existsSync(join(dir, markerName))).toBe(false);
    expect(snapshot(agentDir)).toEqual(before);
  });

  it("rejects malformed settings without echoing their contents", async () => {
    const secret = "SECRET_SENTINEL_VALUE";
    const attempt = async (content: string) => {
      try {
        await inProfile((agent) => {
          writeFileSync(join(agent, "settings.json"), content);
        });
        return undefined;
      } catch (error) {
        return error;
      }
    };
    for (const content of [
      `{"apiKey": "${secret}",`,
      JSON.stringify({ packages: secret }),
    ]) {
      const error = await attempt(content);
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toMatch(/settings/i);
      expect((error as Error).message).not.toContain(secret);
    }
  });

  it("rejects settings beyond the size limit", async () => {
    await expect(
      inProfile((agent) => {
        writeFileSync(
          join(agent, "settings.json"),
          `{"extensions": [${" ".repeat(1024 * 1024 + 1)}]}`,
        );
      }),
    ).rejects.toThrow(/settings/i);
  });
});
