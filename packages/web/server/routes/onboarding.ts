import type { Hono } from "hono";
import { rmSync, statSync } from "node:fs";
import { resolve } from "node:path";
import {
  loadUserConfig,
  loadUserConfigFresh,
  saveUserConfig,
  resolveOperatorName,
} from "@openscout/runtime/user-config";
import { normalizeRuntimePresetsInput, normalizeRuntimeShortlistInput } from "@openscout/runtime/user-config-fields";
import { applyProvisionalAgentNamesFromBody, provisionalAgentNamesApiFields } from "@openscout/runtime/provisional-agent-names";
import { localConfigPath } from "@openscout/runtime/local-config";
import {
  ensureOpenScoutOnboardingCompletion,
  ensureOpenScoutOnboardingLocalConfig,
  loadOpenScoutOnboardingState,
  ONBOARDING_HARNESS_CHOICES,
  parseOnboardingHarness,
  restartOpenScoutOnboarding,
  runOpenScoutOnboardingSetup,
  saveOpenScoutOnboardingIdentity,
  saveOpenScoutOnboardingProject,
  skipOpenScoutOnboarding,
} from "@openscout/runtime/onboarding";
import { expandHomePath } from "../local-paths.ts";
import { onboardingInitBody, onboardingProjectBody, operatorProfilePatchBody } from "../../shared/api/onboarding.ts";
import { readJsonBody } from "../request-body.ts";

export type OnboardingRouteDeps = {
  currentDirectory: string;
  invalidateRunnerOptions?: () => void;
};

export function mountOnboardingRoutes(app: Hono, deps: OnboardingRouteDeps) {
  const { currentDirectory } = deps;

  app.get("/api/user", (c) => {
    const config = loadUserConfig();
    return c.json({
      name: resolveOperatorName(),
      handle: config.handle ?? "",
      pronouns: config.pronouns ?? "",
      hue: config.hue ?? 195,
      monogram: config.monogram ?? "",
      avatar: config.avatar ?? "",
      bio: config.bio ?? "",
      timezone: config.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
      workingHours: config.workingHours ?? "08:00 – 18:00",
      interruptThreshold: config.interruptThreshold ?? "blocking-only",
      batchWindow: config.batchWindow ?? 15,
      channel: config.channel ?? "here+mobile",
      verbosity: config.verbosity ?? "terse",
      tone: config.tone ?? "direct",
      quietHours: config.quietHours ?? "22:00 – 07:00",
      runtimeShortlist: config.runtimeShortlist ?? [],
      runtimePresets: config.runtimePresets ?? [],
      ...provisionalAgentNamesApiFields(config),
    });
  });

  app.get("/api/onboarding/state", async (c) => {
    return c.json(await ensureOpenScoutOnboardingCompletion({ currentDirectory }));
  });

  app.post("/api/onboarding/restart", async (c) => {
    return c.json(await restartOpenScoutOnboarding({ currentDirectory }));
  });

  app.delete("/api/onboarding/state", (c) => {
    try {
      rmSync(localConfigPath(), { force: true });
    } catch {
      /* already absent */
    }
    return c.json({ ok: true, localConfigPath: localConfigPath() });
  });

  app.post("/api/onboarding/skip", async (c) => {
    return c.json(await skipOpenScoutOnboarding({ currentDirectory }));
  });

  app.post("/api/onboarding/setup", async (c) => {
    const state = await loadOpenScoutOnboardingState({ currentDirectory });
    const contextRoot = state.contextRoot || state.projectRoot || state.suggestedContextRoot;
    if (!contextRoot) {
      return c.json({ error: "Choose an existing project folder before running setup." }, 400);
    }
    const expanded = resolve(expandHomePath(contextRoot));
    if (!statSync(expanded, { throwIfNoEntry: false })?.isDirectory()) {
      return c.json({ error: `Choose an existing project folder. That folder is no longer available: ${expanded}` }, 400);
    }
    try {
      const result = await runOpenScoutOnboardingSetup({
        currentDirectory: contextRoot,
        contextRoot,
        sourceRoots: state.sourceRoots,
        defaultHarness: state.defaultHarness,
      });
      deps.invalidateRunnerOptions?.();
      return c.json({
        ok: true,
        projectConfigPath: result.setup.currentProjectConfigPath,
        brokerReachable: result.broker.reachable,
        brokerWarning: result.brokerWarning,
        hasReadyRuntime: result.state.hasReadyRuntime,
        state: result.state,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error("[onboarding/setup]", message);
      return c.json({ error: message }, 500);
    }
  });

  app.post("/api/onboarding/project", async (c) => {
    const parsed = await readJsonBody(c, onboardingProjectBody);
    if (!parsed.ok) return parsed.response;
    const body = parsed.body;
    const contextRoot = body.contextRoot?.trim();
    if (!contextRoot) {
      return c.json({ error: "contextRoot is required" }, 400);
    }
    const sourceRoots = (body.sourceRoots ?? [])
      .map((entry) => entry.trim())
      .filter((entry): entry is string => Boolean(entry && entry.length > 0));
    // Keep the chosen harness; an unknown one is an error, never Claude.
    const requestedHarness = body.defaultHarness?.trim();
    const harness = requestedHarness ? parseOnboardingHarness(requestedHarness) : null;
    if (requestedHarness && !harness) {
      return c.json({
        error: `Unknown harness "${requestedHarness}". Choose one of: ${ONBOARDING_HARNESS_CHOICES.join(", ")}.`,
        choices: ONBOARDING_HARNESS_CHOICES,
      }, 400);
    }

    // Reject folders that do not exist before we save — otherwise a typo'd
    // root gets silently `mkdir -p`'d by downstream setup.
    for (const candidate of [contextRoot, ...sourceRoots]) {
      const expanded = resolve(expandHomePath(candidate));
      if (!statSync(expanded, { throwIfNoEntry: false })?.isDirectory()) {
        return c.json({ error: `That folder doesn't exist: ${expanded}` }, 400);
      }
    }

    try {
      await saveOpenScoutOnboardingProject({
        currentDirectory,
        contextRoot,
        sourceRoots,
        defaultHarness: harness,
      });
      // Invalidate immediately after the durable save, including when the
      // subsequent service/readiness step fails. Native Home can open in this
      // same server process and must see the newly selected harness.
      deps.invalidateRunnerOptions?.();

      const result = await runOpenScoutOnboardingSetup({
        currentDirectory: contextRoot,
        contextRoot,
        sourceRoots,
        defaultHarness: harness,
      });
      deps.invalidateRunnerOptions?.();
      return c.json({
        ok: true,
        projectConfigPath: result.setup.currentProjectConfigPath,
        brokerReachable: result.broker.reachable,
        brokerWarning: result.brokerWarning,
        hasReadyRuntime: result.state.hasReadyRuntime,
        state: result.state,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error("[onboarding/project]", message);
      return c.json({ error: message }, 500);
    }
  });

  app.post("/api/onboarding/init", async (c) => {
    const parsed = await readJsonBody(c, onboardingInitBody);
    if (!parsed.ok) return parsed.response;
    const body = parsed.body;
    const state = await ensureOpenScoutOnboardingLocalConfig({
      currentDirectory,
      host: body.host,
      ports: body.ports,
    });
    return c.json({
      ok: true,
      localConfig: state.localConfig,
      localConfigPath: state.localConfigPath,
      state,
    });
  });

  app.post("/api/user", async (c) => {
    const parsed = await readJsonBody(c, operatorProfilePatchBody);
    if (!parsed.ok) return parsed.response;
    const body = parsed.body;
    // Fresh read: this is a read-modify-write, and a memoized copy here would
    // overwrite whatever another process (CLI, broker) saved since the memo.
    const config = loadUserConfigFresh();

    const stringFields = [
      "name", "handle", "pronouns", "monogram", "avatar", "bio", "timezone",
      "workingHours", "interruptThreshold", "channel",
      "verbosity", "tone", "quietHours",
    ] as const;
    for (const key of stringFields) {
      if (key in body) {
        const val = body[key];
        if (typeof val === "string" && val.trim()) {
          (config as Record<string, unknown>)[key] = val.trim();
        } else {
          delete (config as Record<string, unknown>)[key];
        }
      }
    }
    if ("hue" in body && typeof body.hue === "number") {
      config.hue = body.hue;
    }
    if ("batchWindow" in body && typeof body.batchWindow === "number") {
      config.batchWindow = body.batchWindow;
    }

    // Runtime lists share the CLI field validation so `scout config set` and
    // this endpoint can never accept different grammars.
    try {
      if ("runtimeShortlist" in body) {
        const specs = normalizeRuntimeShortlistInput(body.runtimeShortlist);
        if (specs.length) {
          config.runtimeShortlist = specs;
        } else {
          delete config.runtimeShortlist;
        }
      }
      if ("runtimePresets" in body) {
        const presets = normalizeRuntimePresetsInput(body.runtimePresets);
        if (presets.length) {
          config.runtimePresets = presets;
        } else {
          delete config.runtimePresets;
        }
      }
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }

    applyProvisionalAgentNamesFromBody(config, body);

    saveUserConfig(config);
    let state;
    if (typeof body.name === "string" && body.name.trim()) {
      state = await saveOpenScoutOnboardingIdentity({
        currentDirectory,
        name: body.name.trim(),
      });
    }
    return c.json({
      name: resolveOperatorName(),
      handle: config.handle ?? "",
      pronouns: config.pronouns ?? "",
      hue: config.hue ?? 195,
      monogram: config.monogram ?? "",
      avatar: config.avatar ?? "",
      bio: config.bio ?? "",
      timezone: config.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
      workingHours: config.workingHours ?? "08:00 – 18:00",
      interruptThreshold: config.interruptThreshold ?? "blocking-only",
      batchWindow: config.batchWindow ?? 15,
      channel: config.channel ?? "here+mobile",
      verbosity: config.verbosity ?? "terse",
      tone: config.tone ?? "direct",
      quietHours: config.quietHours ?? "22:00 – 07:00",
      runtimeShortlist: config.runtimeShortlist ?? [],
      runtimePresets: config.runtimePresets ?? [],
      ...provisionalAgentNamesApiFields(config),
      ...(state ? { state } : {}),
    });
  });
}
