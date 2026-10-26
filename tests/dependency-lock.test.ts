import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

type DependencyMap = Record<string, string>;

interface PackageManifest {
  name: string;
  version: string;
  dependencies?: DependencyMap;
  devDependencies?: DependencyMap;
}

interface LockPackage {
  name?: string;
  version?: string;
  resolved?: string;
  integrity?: string;
  link?: boolean;
  dependencies?: DependencyMap;
  devDependencies?: DependencyMap;
  optionalDependencies?: DependencyMap;
  peerDependencies?: DependencyMap;
  peerDependenciesMeta?: Record<string, { optional?: boolean }>;
}

interface PackageLock {
  name?: string;
  version?: string;
  lockfileVersion?: number;
  packages: Record<string, LockPackage>;
}

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function readJson<T>(file: string): T {
  return JSON.parse(fs.readFileSync(path.join(ROOT, file), "utf8")) as T;
}

function sameDependencyMap(actual: DependencyMap | undefined, expected: DependencyMap | undefined): boolean {
  const normalize = (value: DependencyMap | undefined): Array<[string, string]> =>
    Object.entries(value ?? {}).sort(([left], [right]) => left.localeCompare(right));
  return JSON.stringify(normalize(actual)) === JSON.stringify(normalize(expected));
}

function dependencyCandidates(issuer: string, dependency: string): string[] {
  const candidates: string[] = [];
  let current = issuer;
  for (;;) {
    if (path.posix.basename(current) !== "node_modules") {
      candidates.push(current ? `${current}/node_modules/${dependency}` : `node_modules/${dependency}`);
    }
    if (!current) return candidates;
    const parent = path.posix.dirname(current);
    current = parent === "." ? "" : parent;
  }
}

function resolveLockedDependency(
  packages: Record<string, LockPackage>,
  issuer: string,
  dependency: string,
): string | undefined {
  return dependencyCandidates(issuer, dependency).find((candidate) => packages[candidate] !== undefined);
}

function requiredDependencies(entry: LockPackage, includeDev: boolean): string[] {
  const required = new Set(Object.keys(entry.dependencies ?? {}));
  for (const name of Object.keys(entry.optionalDependencies ?? {})) required.add(name);
  if (includeDev) for (const name of Object.keys(entry.devDependencies ?? {})) required.add(name);
  for (const name of Object.keys(entry.peerDependencies ?? {})) {
    if (entry.peerDependenciesMeta?.[name]?.optional !== true) required.add(name);
  }
  return [...required].sort();
}

function hasValidIntegrity(value: string | undefined): boolean {
  if (value === undefined) return false;
  const match = /^(sha256|sha384|sha512)-([A-Za-z0-9+/]+={0,2})$/.exec(value);
  if (match === null || match[2] === undefined) return false;
  const bytes = Buffer.from(match[2], "base64");
  const expectedBytes = { sha256: 32, sha384: 48, sha512: 64 }[match[1] as "sha256" | "sha384" | "sha512"];
  return bytes.length === expectedBytes && bytes.toString("base64").replace(/=+$/, "") === match[2].replace(/=+$/, "");
}

function hasConcreteVersion(value: string | undefined): boolean {
  return typeof value === "string" && /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(value);
}

function validateLock(manifest: PackageManifest, lock: PackageLock): string[] {
  const errors: string[] = [];
  const root = lock.packages[""];
  if (root === undefined) return ["lock packages must contain a root entry"];

  if (
    lock.name !== manifest.name ||
    root.version !== manifest.version ||
    lock.version !== manifest.version ||
    root.name !== manifest.name
  ) {
    errors.push("lock root name/version must match package.json");
  }
  if (!sameDependencyMap(root.dependencies, manifest.dependencies)) {
    errors.push("lock root dependencies must match package.json");
  }
  if (!sameDependencyMap(root.devDependencies, manifest.devDependencies)) {
    errors.push("lock root devDependencies must match package.json");
  }

  for (const [packagePath, entry] of Object.entries(lock.packages)) {
    if (packagePath !== "" && entry.link !== true) {
      if (!hasConcreteVersion(entry.version)) {
        errors.push(`${packagePath}: registry package has no concrete version`);
      }
      try {
        if (entry.resolved === undefined || new URL(entry.resolved).protocol !== "https:") {
          errors.push(`${packagePath}: registry package resolved must be https`);
        }
      } catch {
        errors.push(`${packagePath}: registry package resolved must be https`);
      }
      if (!hasValidIntegrity(entry.integrity)) {
        errors.push(`${packagePath}: registry package integrity is invalid`);
      }
    }

    for (const dependency of requiredDependencies(entry, packagePath === "")) {
      const resolved = resolveLockedDependency(lock.packages, packagePath, dependency);
      if (resolved === undefined) errors.push(`${packagePath || "<root>"}: missing ${dependency}`);
    }
  }
  return errors;
}

describe("source dependency lock", () => {
  const manifest = readJson<PackageManifest>("package.json");
  const lock = readJson<PackageLock>("package-lock.json");

  it("matches the root manifest and contains a valid complete dependency closure", () => {
    expect(lock.lockfileVersion).toBe(3);
    expect(validateLock(manifest, lock)).toEqual([]);
  });

  it("resolves hoisted, nested, and scoped packages with Node ancestor lookup", () => {
    const packages: Record<string, LockPackage> = {
      "": {},
      "node_modules/hoisted": {},
      "node_modules/@scope/consumer": {},
      "node_modules/@scope/consumer/node_modules/nested": {},
      "node_modules/@scope/tool": {},
    };

    expect(resolveLockedDependency(packages, "node_modules/@scope/consumer", "hoisted")).toBe(
      "node_modules/hoisted",
    );
    expect(resolveLockedDependency(packages, "node_modules/@scope/consumer", "nested")).toBe(
      "node_modules/@scope/consumer/node_modules/nested",
    );
    expect(resolveLockedDependency(packages, "node_modules/@scope/consumer", "@scope/tool")).toBe(
      "node_modules/@scope/tool",
    );
  });

  it("detects a missing native optional dependency in an in-memory copy", () => {
    const broken = structuredClone(lock);
    const native = resolveLockedDependency(lock.packages, "node_modules/esbuild", "@esbuild/win32-x64");
    expect(native).toBeDefined();
    delete broken.packages[native!];
    expect(validateLock(manifest, broken)).toContain("node_modules/esbuild: missing @esbuild/win32-x64");
  });

  it("rejects an empty registry placeholder in an in-memory copy", () => {
    const broken = structuredClone(lock);
    const native = resolveLockedDependency(lock.packages, "node_modules/esbuild", "@esbuild/win32-x64");
    expect(native).toBeDefined();
    broken.packages[native!] = { optional: true } as LockPackage;
    const errors = validateLock(manifest, broken);
    expect(errors).toContain(`${native}: registry package has no concrete version`);
    expect(errors).toContain(`${native}: registry package resolved must be https`);
    expect(errors).toContain(`${native}: registry package integrity is invalid`);
  });

  it("requires optional dependencies but permits explicitly optional peers", () => {
    expect(requiredDependencies({ dependencies: { shared: "1" }, optionalDependencies: { shared: "2", native: "1" } }, false)).toEqual([
      "native",
      "shared",
    ]);
    expect(
      requiredDependencies(
        {
          peerDependencies: { requiredPeer: "1", optionalPeer: "1" },
          peerDependenciesMeta: { optionalPeer: { optional: true } },
        },
        false,
      ),
    ).toEqual(["requiredPeer"]);
  });
});
