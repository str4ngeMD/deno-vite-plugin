import type { Plugin } from "vite";
import {
  type Loader,
  type MediaType,
  Workspace,
  type WorkspaceOptions,
} from "@deno/loader";
import { parse as parseJsonc } from "@std/jsonc";
import fs from "node:fs";
import path from "node:path";
import prefixPlugin from "./prefixPlugin.js";
import mainPlugin from "./resolvePlugin.js";
import {
  type DenoResolveResult,
  isDenoSpecifier,
  parseDenoSpecifier,
} from "./resolver.js";

export type { MediaType } from "@deno/loader";

export interface LoadContext {
  /** The transpiled code from @deno/loader. */
  code: string;
  /** The module specifier. */
  id: string;
  /** The media type of the original source. */
  mediaType: MediaType;
  /** The Vite environment name (e.g. "client", "ssr"). */
  environment: string;
  /** Whether this is a server-side environment. */
  ssr: boolean;
}

export type OnLoadResult =
  | { code: string; map?: string | null }
  | null
  | undefined
  | void;

export interface DenoPluginOptions {
  /**
   * Per-environment Workspace options. Keys are Vite environment names
   * (e.g. "client", "ssr"). Unmatched environments use the default options.
   *
   * @example
   * ```ts
   * deno({
   *   environments: {
   *     ssr: { platform: "node" },
   *     client: { platform: "browser", preserveJsx: true },
   *   },
   * })
   * ```
   */
  environments?: Record<string, Omit<WorkspaceOptions, "configPath">>;

  /**
   * Default Workspace options applied to all environments unless
   * overridden by `environments`.
   */
  workspaceOptions?: Omit<WorkspaceOptions, "configPath">;

  /**
   * Hook called after @deno/loader transpiles a module. Return
   * `{ code, map? }` to replace the output, or `null`/`undefined`
   * to use the default.
   */
  onLoad?: (ctx: LoadContext) => OnLoadResult | Promise<OnLoadResult>;
}

/**
 * Walk up from `startDir` to find the nearest deno.json or deno.jsonc.
 * If a config with a "workspace" field is found, return that (the workspace
 * root). Otherwise return the nearest config file found.
 */
function findDenoConfig(startDir: string): string | null {
  let nearest: string | null = null;
  let dir = path.resolve(startDir);
  const root = path.parse(dir).root;

  while (true) {
    for (const name of ["deno.json", "deno.jsonc"]) {
      const candidate = path.join(dir, name);
      try {
        const content = fs.readFileSync(candidate, "utf-8");
        if (nearest === null) nearest = candidate;

        const json = parseJsonc(content) as Record<string, unknown>;
        if (json.workspace) {
          // Found the workspace root
          return candidate;
        }
      } catch {
        // File doesn't exist or isn't valid JSON, continue
      }
    }

    if (dir === root) break;
    dir = path.dirname(dir);
  }

  return nearest;
}

/**
 * Find the Deno config governing an importer. Deno virtual module ids encode
 * the real resolved path, so unwrap those before walking the filesystem.
 */
function findDenoConfigForImporter(
  importer: string | undefined,
  fallbackConfigPath: string | null,
): string | null {
  if (importer === undefined) return fallbackConfigPath;

  let importerPath = importer.split("?")[0];

  if (isDenoSpecifier(importer)) {
    const { resolved } = parseDenoSpecifier(importer);

    if (path.isAbsolute(resolved)) {
      importerPath = resolved;
    } else {
      // Remote/opaque virtual modules have no filesystem scope to discover.
      return fallbackConfigPath;
    }
  }

  if (!path.isAbsolute(importerPath)) return fallbackConfigPath;
  if (importerPath.startsWith("/@")) return fallbackConfigPath;
  if (importerPath.includes("/node_modules/")) return fallbackConfigPath;

  return findDenoConfig(path.dirname(importerPath)) ?? fallbackConfigPath;
}

export default function deno(options?: DenoPluginOptions): Plugin[] {
  // A single Vite graph may cross multiple Deno config/workspace scopes.
  // Keep loaders and resolution caches isolated by environment + config.
  const loaders = new Map<string, Promise<Loader>>();
  const caches = new Map<string, Map<string, DenoResolveResult>>();
  let configPath: string | null = null;
  let configResolved = false;

  function createLoaderForEnv(
    envName: string | undefined,
    requestedConfigPath: string | null,
  ): Promise<Loader> {
    const envOpts = envName === undefined
      ? undefined
      : options?.environments?.[envName];
    const baseOpts = options?.workspaceOptions ?? {};
    const wsOpts: WorkspaceOptions = {
      ...baseOpts,
      ...envOpts,
      ...(requestedConfigPath ? { configPath: requestedConfigPath } : {}),
    };
    return new Workspace(wsOpts).createLoader();
  }

  function loaderKey(
    envName: string | undefined,
    requestedConfigPath: string | null,
  ): string {
    return JSON.stringify([
      envName ?? "__default__",
      requestedConfigPath ?? "__default__",
    ]);
  }

  function getLoader(
    envName?: string,
    importer?: string,
  ): Promise<Loader> {
    if (!configResolved) {
      throw new Error("deno plugin: loader not initialized");
    }

    const requestedConfigPath = findDenoConfigForImporter(importer, configPath);
    const key = loaderKey(envName, requestedConfigPath);

    let promise = loaders.get(key);
    if (!promise) {
      promise = createLoaderForEnv(envName, requestedConfigPath);
      loaders.set(key, promise);
    }
    return promise;
  }

  function getCache(
    envName?: string,
    importer?: string,
  ): Map<string, DenoResolveResult> {
    if (!configResolved) {
      throw new Error("deno plugin: loader not initialized");
    }

    const requestedConfigPath = findDenoConfigForImporter(importer, configPath);
    const key = loaderKey(envName, requestedConfigPath);

    let cache = caches.get(key);
    if (!cache) {
      cache = new Map();
      caches.set(key, cache);
    }
    return cache;
  }

  return [
    {
      name: "deno:config",
      configResolved(config) {
        const root = path.normalize(config.root);
        // Default scope for imports originating from the Vite project itself.
        configPath = findDenoConfig(root);
        configResolved = true;
      },
    },
    prefixPlugin(getCache, getLoader),
    mainPlugin(getCache, getLoader, options?.onLoad),
  ];
}
