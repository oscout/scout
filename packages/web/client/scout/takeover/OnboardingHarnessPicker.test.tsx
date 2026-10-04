import { describe, expect, mock, test } from "bun:test";

// @ts-expect-error Load runtime entrypoints to avoid the local TS declaration aliases.
const React = await import("../../../node_modules/react/index.js");
// @ts-expect-error Load runtime entrypoints to avoid the local TS declaration aliases.
const ReactJsxRuntime = await import("../../../node_modules/react/jsx-runtime.js");
// @ts-expect-error Load runtime entrypoints to avoid the local TS declaration aliases.
const ReactJsxDevRuntime = await import("../../../node_modules/react/jsx-dev-runtime.js");
// @ts-expect-error Load runtime entrypoints to avoid the local TS declaration aliases.
const { renderToStaticMarkup } = await import("../../../node_modules/react-dom/server.node.js");
mock.module("react", () => React);
mock.module("react/jsx-runtime", () => ReactJsxRuntime);
mock.module("react/jsx-dev-runtime", () => ReactJsxDevRuntime);

const { OnboardingHarnessPicker, onboardingHarnessDefault } = await import("./OnboardingHarnessPicker.tsx");

describe("saved onboarding harness preference", () => {
  test("a stored Grok alias selects the visible Grok choice instead of Claude", () => {
    const html = renderToStaticMarkup(
      React.createElement(OnboardingHarnessPicker, { value: onboardingHarnessDefault("grok"), onChange: () => {} }),
    );
    expect(html).toContain('data-harness="grok-acp" aria-pressed="true"');
    expect(html).toContain('data-harness="claude" aria-pressed="false"');
  });

  test("current saved choices remain selected", () => {
    expect(onboardingHarnessDefault("grok-acp")).toBe("grok-acp");
    expect(onboardingHarnessDefault("codex")).toBe("codex");
    expect(onboardingHarnessDefault("kimi")).toBe("kimi");
  });

  test("unknown and absent preferences use the catalog default", () => {
    expect(onboardingHarnessDefault("retired-tool")).toBe("claude");
    expect(onboardingHarnessDefault()).toBe("claude");
  });
});
