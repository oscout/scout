import type { CSSProperties, ReactNode } from "react";

/**
 * HarnessMark — a small monochrome brand glyph for the runtime a session runs
 * on (Claude, Codex, Grok, …). It replaces writing the harness name as text:
 * the mark reads at a glance and tints with `currentColor`, so it sits cleanly
 * as a corner badge on an agent avatar or inline beside a label.
 *
 * Glyphs are category-recognisable rather than pixel-exact trademarks — enough
 * to tell the runtimes apart without shipping knock-off logos. Unknown
 * harnesses fall back to a lettered chip.
 */

/** Canonical harness key after alias folding (anthropic → claude, etc.). */
export function normalizeHarnessKey(harness: string | null | undefined): string {
  const raw = harness?.trim().toLowerCase();
  if (!raw) return "unknown";
  // Strip common decorations: "claude-code", "claude_code", "claude (sonnet)".
  const base = raw.replace(/[\s(].*$/, "").replace(/[_-].*$/, "");
  const ALIASES: Record<string, string> = {
    anthropic: "claude",
    claude: "claude",
    claudecode: "claude",
    sonnet: "claude",
    opus: "claude",
    openai: "codex",
    codex: "codex",
    gpt: "codex",
    chatgpt: "codex",
    oai: "codex",
    xai: "grok",
    grok: "grok",
    kimi: "kimi",
    moonshot: "kimi",
    google: "gemini",
    gemini: "gemini",
    vertex: "gemini",
    cursor: "cursor",
    github: "github",
    opencode: "opencode",
    oc: "opencode",
    amp: "amp",
    sourcegraph: "amp",
    pi: "pi",
    inflection: "pi",
    omp: "pi",
    "oh-my-pi": "pi",
    claw: "claw",
    native: "native",
    worker: "worker",
    quad: "quad",
  };
  return ALIASES[base] ?? ALIASES[raw.replace(/[\s(].*$/, "")] ?? raw;
}

const HARNESS_LABEL: Record<string, string> = {
  claude: "Claude",
  codex: "Codex",
  grok: "Grok",
  kimi: "Kimi",
  gemini: "Gemini",
  cursor: "Cursor",
  github: "GitHub",
  opencode: "OpenCode",
  amp: "Amp",
  pi: "Pi",
  claw: "Claw",
  native: "Native",
  worker: "Worker",
  quad: "Quad",
};

export function harnessLabel(harness: string | null | undefined): string {
  const key = normalizeHarnessKey(harness);
  return HARNESS_LABEL[key] ?? (harness?.trim() || "Unknown");
}

const S = {
  fill: { fill: "currentColor" } as const,
  line: {
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 2,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
  } as const,
};

// ── Brand marks ──────────────────────────────────────────────────────────────
// Official logo path data from simple-icons (CC0 / public domain), 24×24 viewBox,
// filled with currentColor. Used for nominative identification of the runtime.
const BRAND_PATHS: Record<string, string> = {
  claude:
    "m4.7144 15.9555 4.7174-2.6471.079-.2307-.079-.1275h-.2307l-.7893-.0486-2.6956-.0729-2.3375-.0971-2.2646-.1214-.5707-.1215-.5343-.7042.0546-.3522.4797-.3218.686.0608 1.5179.1032 2.2767.1578 1.6514.0972 2.4468.255h.3886l.0546-.1579-.1336-.0971-.1032-.0972L6.973 9.8356l-2.55-1.6879-1.3356-.9714-.7225-.4918-.3643-.4614-.1578-1.0078.6557-.7225.8803.0607.2246.0607.8925.686 1.9064 1.4754 2.4893 1.8336.3643.3035.1457-.1032.0182-.0728-.164-.2733-1.3539-2.4467-1.445-2.4893-.6435-1.032-.17-.6194c-.0607-.255-.1032-.4674-.1032-.7285L6.287.1335 6.6997 0l.9957.1336.419.3642.6192 1.4147 1.0018 2.2282 1.5543 3.0296.4553.8985.2429.8318.091.255h.1579v-.1457l.1275-1.706.2368-2.0947.2307-2.6957.0789-.7589.3764-.9107.7468-.4918.5828.2793.4797.686-.0668.4433-.2853 1.8517-.5586 2.9021-.3643 1.9429h.2125l.2429-.2429.9835-1.3053 1.6514-2.0643.7286-.8196.85-.9046.5464-.4311h1.0321l.759 1.1293-.34 1.1657-1.0625 1.3478-.8804 1.1414-1.2628 1.7-.7893 1.36.0729.1093.1882-.0183 2.8535-.607 1.5421-.2794 1.8396-.3157.8318.3886.091.3946-.3278.8075-1.967.4857-2.3072.4614-3.4364.8136-.0425.0304.0486.0607 1.5482.1457.6618.0364h1.621l3.0175.2247.7892.522.4736.6376-.079.4857-1.2142.6193-1.6393-.3886-3.825-.9107-1.3113-.3279h-.1822v.1093l1.0929 1.0686 2.0035 1.8092 2.5075 2.3314.1275.5768-.3218.4554-.34-.0486-2.2039-1.6575-.85-.7468-1.9246-1.621h-.1275v.17l.4432.6496 2.3436 3.5214.1214 1.0807-.17.3521-.6071.2125-.6679-.1214-1.3721-1.9246L14.38 17.959l-1.1414-1.9428-.1397.079-.674 7.2552-.3156.3703-.7286.2793-.6071-.4614-.3218-.7468.3218-1.4753.3886-1.9246.3157-1.53.2853-1.9004.17-.6314-.0121-.0425-.1397.0182-1.4328 1.9672-2.1796 2.9446-1.7243 1.8456-.4128.164-.7164-.3704.0667-.6618.4008-.5889 2.386-3.0357 1.4389-1.882.929-1.0868-.0062-.1579h-.0546l-6.3385 4.1164-1.1293.1457-.4857-.4554.0608-.7467.2307-.2429 1.9064-1.3114Z",
  gemini:
    "M11.04 19.32Q12 21.51 12 24q0-2.49.93-4.68.96-2.19 2.58-3.81t3.81-2.55Q21.51 12 24 12q-2.49 0-4.68-.93a12.3 12.3 0 0 1-3.81-2.58 12.3 12.3 0 0 1-2.58-3.81Q12 2.49 12 0q0 2.49-.96 4.68-.93 2.19-2.55 3.81a12.3 12.3 0 0 1-3.81 2.58Q2.49 12 0 12q2.49 0 4.68.96 2.19.93 3.81 2.55t2.55 3.81",
  cursor:
    "M11.503.131 1.891 5.678a.84.84 0 0 0-.42.726v11.188c0 .3.162.575.42.724l9.609 5.55a1 1 0 0 0 .998 0l9.61-5.55a.84.84 0 0 0 .42-.724V6.404a.84.84 0 0 0-.42-.726L12.497.131a1.01 1.01 0 0 0-.996 0M2.657 6.338h18.55c.263 0 .43.287.297.515L12.23 22.918c-.062.107-.229.064-.229-.06V12.335a.59.59 0 0 0-.295-.51l-9.11-5.257c-.109-.063-.064-.23.061-.23",
  github:
    "M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12",
  opencode: "M22 24H2V0h20zM17 4.8H7v14.4h10z",
};

const brandGlyph = (path: string): ReactNode => <path d={path} fill="currentColor" />;

// Brand marks with a non-24 viewBox (official logos from the openai/agents.md
// asset set). Each carries its own viewBox + path list so it renders faithfully.
const BRAND_MARKS: Record<string, { viewBox: string; paths: string[] }> = {
  amp: {
    viewBox: "0.6 1.4 8.8 8.8",
    paths: [
      "M2.37694 9.23487L4.34679 7.23716L5.06365 9.95891L6.10505 9.67408L5.06749 5.72214L1.17831 4.6688L0.901367 5.73289L3.5775 6.45984L1.61584 8.45465L2.37694 9.23487Z",
      "M8.05742 6.91898L9.09885 6.63416L8.0613 2.68224L4.17209 1.62891L3.89515 2.693L7.17936 3.58514L8.05742 6.91898Z",
      "M6.56226 8.43797L7.60365 8.15314L6.5661 4.20121L2.67692 3.14787L2.39998 4.21196L5.68416 5.10411L6.56226 8.43797Z",
    ],
  },
  grok: {
    viewBox: "0 0 34 33",
    paths: [
      "M13.2371 21.0407L24.3186 12.8506C24.8619 12.4491 25.6384 12.6057 25.8973 13.2294C27.2597 16.5185 26.651 20.4712 23.9403 23.1851C21.2297 25.8989 17.4581 26.4941 14.0108 25.1386L10.2449 26.8843C15.6463 30.5806 22.2053 29.6665 26.304 25.5601C29.5551 22.3051 30.562 17.8683 29.6205 13.8673L29.629 13.8758C28.2637 7.99809 29.9647 5.64871 33.449 0.844576C33.5314 0.730667 33.6139 0.616757 33.6964 0.5L29.1113 5.09055V5.07631L13.2343 21.0436",
      "M10.9503 23.0313C7.07343 19.3235 7.74185 13.5853 11.0498 10.2763C13.4959 7.82722 17.5036 6.82767 21.0021 8.2971L24.7595 6.55998C24.0826 6.07017 23.215 5.54334 22.2195 5.17313C17.7198 3.31926 12.3326 4.24192 8.67479 7.90126C5.15635 11.4239 4.0499 16.8403 5.94992 21.4622C7.36924 24.9165 5.04257 27.3598 2.69884 29.826C1.86829 30.7002 1.0349 31.5745 0.36364 32.5L10.9474 23.0341",
    ],
  },
};

/** Cloud enclosing a `>_` terminal prompt — OpenAI / Codex.
 *  Official mark from lobehub/lobe-icons (filled, `>_` knocked out). */
const openaiGlyph = (
  <path
    fill="currentColor"
    fillRule="evenodd"
    clipRule="evenodd"
    d="M8.086.457a6.105 6.105 0 013.046-.415c1.333.153 2.521.72 3.564 1.7a.117.117 0 00.107.029c1.408-.346 2.762-.224 4.061.366l.063.03.154.076c1.357.703 2.33 1.77 2.918 3.198.278.679.418 1.388.421 2.126a5.655 5.655 0 01-.18 1.631.167.167 0 00.04.155 5.982 5.982 0 011.578 2.891c.385 1.901-.01 3.615-1.183 5.14l-.182.22a6.063 6.063 0 01-2.934 1.851.162.162 0 00-.108.102c-.255.736-.511 1.364-.987 1.992-1.199 1.582-2.962 2.462-4.948 2.451-1.583-.008-2.986-.587-4.21-1.736a.145.145 0 00-.14-.032c-.518.167-1.04.191-1.604.185a5.924 5.924 0 01-2.595-.622 6.058 6.058 0 01-2.146-1.781c-.203-.269-.404-.522-.551-.821a7.74 7.74 0 01-.495-1.283 6.11 6.11 0 01-.017-3.064.166.166 0 00.008-.074.115.115 0 00-.037-.064 5.958 5.958 0 01-1.38-2.202 5.196 5.196 0 01-.333-1.589 6.915 6.915 0 01.188-2.132c.45-1.484 1.309-2.648 2.577-3.493.282-.188.55-.334.802-.438.286-.12.573-.22.861-.304a.129.129 0 00.087-.087A6.016 6.016 0 015.635 2.31C6.315 1.464 7.132.846 8.086.457zm-.804 7.85a.848.848 0 00-1.473.842l1.694 2.965-1.688 2.848a.849.849 0 001.46.864l1.94-3.272a.849.849 0 00.007-.854l-1.94-3.393zm5.446 6.24a.849.849 0 000 1.695h4.848a.849.849 0 000-1.696h-4.848z"
  />
);

/** Angular K with the small orbit dot used by Kimi's current identity. The
 * shared mark stays monochrome so it can inherit state and surface tint. */
const kimiGlyph = (
  <g fill="currentColor">
    <path d="M4.5 3h3.4v7.4L14.7 3h4.5l-7.9 8.5L19.8 21h-4.6l-7.3-8.2V21H4.5Z" />
    <circle cx="20.2" cy="3.8" r="1.8" />
  </g>
);

/** π — Pi. */
const piGlyph = (
  <g {...S.line} strokeWidth={2}>
    <path d="M6.5 8.5h11" />
    <path d="M10 8.5 9 17M14.2 8.5 15.2 17" />
  </g>
);

/** Terminal prompt — Native. */
const nativeGlyph = (
  <g {...S.line}>
    <path d="M6.5 8 11 12l-4.5 4" />
    <path d="M12.5 16.5H18" strokeWidth={1.8} />
  </g>
);

/** Hex nut — Worker. */
const workerGlyph = (
  <g {...S.line} strokeWidth={1.8}>
    <path d="M12 4.5 18.5 8.2v7.6L12 19.5 5.5 15.8V8.2L12 4.5Z" />
    <circle cx={12} cy={12} r={2.7} />
  </g>
);

/** Four squares — Quad. */
const quadGlyph = (
  <g {...S.fill}>
    <rect x={5.5} y={5.5} width={5.4} height={5.4} rx={1.3} />
    <rect x={13.1} y={5.5} width={5.4} height={5.4} rx={1.3} />
    <rect x={5.5} y={13.1} width={5.4} height={5.4} rx={1.3} />
    <rect x={13.1} y={13.1} width={5.4} height={5.4} rx={1.3} />
  </g>
);

/** Three rake marks — Claw. */
const clawGlyph = (
  <g {...S.line} strokeWidth={2}>
    <path d="M7.5 6Q9.5 12 8.5 18" />
    <path d="M12 5.5Q14 12 13 18.5" />
    <path d="M16.5 6Q18.5 12 17.5 18" />
  </g>
);

const HARNESS_GLYPHS: Record<string, ReactNode> = {
  claude: brandGlyph(BRAND_PATHS.claude),
  codex: openaiGlyph,
  kimi: kimiGlyph,
  gemini: brandGlyph(BRAND_PATHS.gemini),
  cursor: brandGlyph(BRAND_PATHS.cursor),
  github: brandGlyph(BRAND_PATHS.github),
  opencode: brandGlyph(BRAND_PATHS.opencode),
  pi: piGlyph,
  native: nativeGlyph,
  worker: workerGlyph,
  quad: quadGlyph,
  claw: clawGlyph,
};

export interface HarnessMarkProps {
  harness: string | null | undefined;
  /** Glyph box (square), px. */
  size?: number;
  className?: string;
  style?: CSSProperties;
  /** Override the tooltip; defaults to the harness label. Pass null for none. */
  title?: string | null;
}

export function HarnessMark({ harness, size = 14, className, style, title }: HarnessMarkProps) {
  const key = normalizeHarnessKey(harness);
  const brand = BRAND_MARKS[key];
  const glyph = HARNESS_GLYPHS[key];
  const tip = title === null ? undefined : title ?? harnessLabel(harness);

  return (
    <span className={className} style={style} title={tip} aria-hidden={tip ? undefined : true}>
      <svg
        viewBox={brand?.viewBox ?? "0 0 24 24"}
        width={size}
        height={size}
        style={{ display: "block" }}
        role="img"
        aria-label={tip}
      >
        {brand ? (
          brand.paths.map((d, index) => <path key={index} d={d} fill="currentColor" />)
        ) : glyph ?? (
          <text
            x="12"
            y="12"
            textAnchor="middle"
            dominantBaseline="central"
            fontSize="13"
            fontWeight="600"
            fontFamily="var(--font-mono)"
            fill="currentColor"
          >
            {(key[0] ?? "?").toUpperCase()}
          </text>
        )}
      </svg>
    </span>
  );
}
