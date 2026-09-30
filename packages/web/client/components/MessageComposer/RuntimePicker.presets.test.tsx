/** @jsxRuntime classic */
/** @jsx React.createElement */
import { describe, expect, mock, test } from "bun:test";

// @ts-expect-error Bun tests load React's runtime entrypoint directly to avoid local TS path aliases.
const React = await import("../../../node_modules/react/index.js");
// @ts-expect-error Bun tests load React's runtime entrypoint directly to avoid local TS path aliases.
const ReactJsxRuntime = await import("../../../node_modules/react/jsx-runtime.js");
// @ts-expect-error Bun tests load React's runtime entrypoint directly to avoid local TS path aliases.
const ReactJsxDevRuntime = await import("../../../node_modules/react/jsx-dev-runtime.js");

mock.module("react", () => React);
mock.module("react/jsx-runtime", () => ReactJsxRuntime);
mock.module("react/jsx-dev-runtime", () => ReactJsxDevRuntime);
// The picker portals its panel; band components render without it anyway.
mock.module("react-dom", () => ({ createPortal: (children: unknown) => children }));

// @ts-expect-error Bun tests load React DOM's runtime entrypoint directly to avoid local TS path aliases.
const ReactDomServer = await import("../../../node_modules/react-dom/server.node.js");
const { renderToStaticMarkup } = ReactDomServer;

const { RuntimePicker, ModelOptions, PresetOptions } = await import("./RuntimePicker.tsx");
const { orderModelsWithShortlist } = await import("../../lib/runtime-catalog.ts");

import type { PanelCtx } from "./RuntimePicker.tsx";
import type { RuntimeCatalog, RuntimeValue } from "../../lib/runtime-catalog.ts";

const CATALOG: RuntimeCatalog = {
  efforts: [
    { value: "low", label: "Low" },
    { value: "medium", label: "Medium" },
    { value: "high", label: "High" },
  ],
  harnesses: [
    {
      value: "claude",
      label: "Claude",
      models: [
        { value: "", label: "Default", note: "harness picks" },
        { value: "claude-opus-5", label: "Opus 5" },
        { value: "claude-haiku-4-5", label: "Haiku 4.5" },
      ],
    },
    {
      value: "codex",
      label: "Codex",
      models: [
        { value: "", label: "Default", note: "harness picks" },
        { value: "gpt-5.5", label: "GPT-5.5" },
      ],
    },
  ],
};

const PRESETS = [
  {
    id: "fusion",
    label: "Fusion",
    harness: "claude",
    model: "claude-opus-5",
    effort: "high",
    origin: "project" as const,
  },
];

function stubCtx(overrides: Partial<PanelCtx>): PanelCtx {
  const value: RuntimeValue = { harness: "claude", model: "", effort: "medium" };
  return {
    value,
    // The panel reads presets off the catalog; keep the stub's two views of
    // them consistent so a test can't pass one and not the other.
    catalog: { ...CATALOG, presets: overrides.presets ?? [] },
    set: () => {},
    applyPreset: () => {},
    status: "ready",
    harnesses: CATALOG.harnesses,
    presets: [],
    models: [],
    modelsPinned: [],
    modelsRest: [],
    efforts: null,
    harnessLabel: "Claude",
    searchable: false,
    query: "",
    setQuery: () => {},
    searchRef: { current: null },
    cell: () => ({
      ref: () => {},
      tabIndex: -1,
      onKeyDown: () => {},
      onFocus: () => {},
    }),
    onSearchKeyDown: () => {},
    ...overrides,
  };
}

describe("RuntimePicker presets band", () => {
  test("renders nothing without presets", () => {
    const html = renderToStaticMarkup(<PresetOptions ctx={stubCtx({})} />);
    expect(html).toBe("");
  });

  test("renders a chip per preset with mark, label, and pressed state", () => {
    const ctx = stubCtx({
      presets: PRESETS,
      value: { harness: "claude", model: "claude-opus-5", effort: "high" },
    });
    const html = renderToStaticMarkup(<PresetOptions ctx={ctx} />);
    expect(html).toContain("s-rt-preset-opt");
    expect(html).toContain(">Fusion</span>");
    expect(html).toContain('aria-pressed="true"');
    expect(html).toContain("claude/claude-opus-5/high");
    expect(html).toContain("Project preset");
  });

  test("a non-matching preset is not pressed", () => {
    const ctx = stubCtx({
      presets: PRESETS,
      value: { harness: "claude", model: "claude-haiku-4-5", effort: "high" },
    });
    const html = renderToStaticMarkup(<PresetOptions ctx={ctx} />);
    expect(html).toContain('aria-pressed="false"');
  });
});

describe("RuntimePicker pinned models", () => {
  const shortlist = [
    { harness: "claude", model: "claude-haiku-4-5", origin: "user" as const },
  ];

  test("pinned models precede the rule and the rest follows", () => {
    const { pinned, rest } = orderModelsWithShortlist(
      CATALOG.harnesses[0].models,
      shortlist,
      "claude",
    );
    const ctx = stubCtx({
      models: [...pinned, ...rest],
      modelsPinned: pinned,
      modelsRest: rest,
    });
    const html = renderToStaticMarkup(<ModelOptions ctx={ctx} />);
    const pinnedAt = html.indexOf('data-pinned=""');
    const ruleAt = html.indexOf("s-rt-models-rule");
    expect(pinnedAt).toBeGreaterThan(-1);
    expect(ruleAt).toBeGreaterThan(pinnedAt);
    // The pinned chip names its origin; the rest follow the rule.
    expect(html).toContain("Your shortlist");
    expect(html.indexOf("Opus 5")).toBeGreaterThan(ruleAt);
  });

  test("no rule is drawn when nothing is pinned", () => {
    const models = CATALOG.harnesses[0].models;
    const ctx = stubCtx({ models, modelsPinned: [], modelsRest: models });
    const html = renderToStaticMarkup(<ModelOptions ctx={ctx} />);
    expect(html).not.toContain("s-rt-models-rule");
    expect(html).not.toContain("data-pinned");
  });
});

describe("RuntimePicker chip readout", () => {
  test("shows the preset label on an exact match", () => {
    const html = renderToStaticMarkup(
      <RuntimePicker
        catalog={{ ...CATALOG, presets: PRESETS }}
        value={{ harness: "claude", model: "claude-opus-5", effort: "high" }}
      />,
    );
    expect(html).toContain('class="s-rt-chip-model-text">Fusion</span>');
  });

  test("shows the model label when no preset matches", () => {
    const html = renderToStaticMarkup(
      <RuntimePicker
        catalog={{ ...CATALOG, presets: PRESETS }}
        value={{ harness: "claude", model: "claude-haiku-4-5", effort: "high" }}
      />,
    );
    expect(html).toContain('class="s-rt-chip-model-text">Haiku 4.5</span>');
  });
});
