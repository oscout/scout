// Dev-only lab page for prototyping Scoutbot's dispatcher-radio FX chain.
// Mounted at /dev/scoutbot-fx via main.tsx pathname gate.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  DEFAULT_VOICE_FX,
  VOICE_FX_PRESETS,
  decodeAudioFromUrl,
  playDry,
  playWithVoiceFx,
  type VoiceFxHandle,
  type VoiceFxParams,
} from "@voxd/client/fx";

type Fixture = {
  slug: string;
  text: string;
  file: string;
  contentType?: string;
  modelId?: string;
  voiceId?: string;
  bytes?: number;
};

type FixturesResponse = {
  available: boolean;
  generatedAt: string | null;
  fixtures: Fixture[];
  note?: string;
  error?: string;
};

type LoadedBuffer = {
  fixture: Fixture;
  buffer: AudioBuffer;
};

type SliderSpec = {
  key: keyof VoiceFxParams;
  label: string;
  min: number;
  max: number;
  step: number;
  format: (value: number) => string;
};

type SliderGroup = {
  title: string;
  sliders: SliderSpec[];
};

const SLIDER_GROUPS: SliderGroup[] = [
  {
    title: "Tone (band-pass)",
    sliders: [
      { key: "lowCutHz", label: "Low cut", min: 80, max: 1200, step: 10, format: (v) => `${v.toFixed(0)} Hz` },
      { key: "highCutHz", label: "High cut", min: 1500, max: 6000, step: 50, format: (v) => `${v.toFixed(0)} Hz` },
      { key: "bandQ", label: "Filter Q", min: 0.2, max: 2, step: 0.05, format: (v) => v.toFixed(2) },
    ],
  },
  {
    title: "Grit (saturation + bit-crush)",
    sliders: [
      { key: "saturationAmount", label: "Saturation", min: 0, max: 1, step: 0.01, format: (v) => v.toFixed(2) },
      { key: "bitcrushAmount", label: "Bit-crush", min: 0, max: 1, step: 0.01, format: (v) => v.toFixed(2) },
    ],
  },
  {
    title: "Carrier hiss",
    sliders: [
      { key: "hissGain", label: "Hiss level", min: 0, max: 0.25, step: 0.005, format: (v) => v.toFixed(3) },
      { key: "hissCutoffHz", label: "Hiss high-pass", min: 300, max: 4000, step: 50, format: (v) => `${v.toFixed(0)} Hz` },
    ],
  },
  {
    title: "Presence (mid-band peak — comm intelligibility)",
    sliders: [
      { key: "presencePeakDb", label: "Boost", min: 0, max: 12, step: 0.5, format: (v) => `${v.toFixed(1)} dB` },
      { key: "presenceCenterHz", label: "Center", min: 600, max: 3000, step: 50, format: (v) => `${v.toFixed(0)} Hz` },
      { key: "presenceQ", label: "Q (narrowness)", min: 0.3, max: 3, step: 0.1, format: (v) => v.toFixed(1) },
    ],
  },
  {
    title: "Squelch tail (channel-drop noise)",
    sliders: [
      { key: "squelchTailGain", label: "Tail gain", min: 0, max: 0.3, step: 0.005, format: (v) => v.toFixed(3) },
      { key: "squelchTailDurationMs", label: "Tail length", min: 40, max: 500, step: 10, format: (v) => `${v.toFixed(0)} ms` },
    ],
  },
  {
    title: "Compressor",
    sliders: [
      { key: "compressorThresholdDb", label: "Threshold", min: -60, max: 0, step: 1, format: (v) => `${v.toFixed(0)} dB` },
      { key: "compressorRatio", label: "Ratio", min: 1, max: 12, step: 0.5, format: (v) => `${v.toFixed(1)} : 1` },
    ],
  },
  {
    title: "Delivery",
    sliders: [
      { key: "playbackRate", label: "Speed (pitch-shifts)", min: 0.75, max: 1.35, step: 0.01, format: (v) => `${v.toFixed(2)}×` },
    ],
  },
  {
    title: "Kerchunk / output",
    sliders: [
      { key: "clickGain", label: "Click gain", min: 0, max: 1, step: 0.01, format: (v) => v.toFixed(2) },
      { key: "clickDurationMs", label: "Click length", min: 20, max: 200, step: 5, format: (v) => `${v.toFixed(0)} ms` },
      { key: "outputGain", label: "Output gain", min: 0, max: 2, step: 0.05, format: (v) => v.toFixed(2) },
      { key: "wetMix", label: "Wet mix", min: 0, max: 1, step: 0.01, format: (v) => v.toFixed(2) },
    ],
  },
];

const SPEED_VARY_RANGE = 0.12; // ±12% around the configured speed when vary-per-loop is on.

const clampSpeed = (v: number) => Math.max(0.7, Math.min(1.45, v));

const LOOP_GAP_MS = 220;
const SCOUTBOT_CLEAN_DISPATCH_FX: VoiceFxParams = {
  ...DEFAULT_VOICE_FX,
  lowCutHz: 160,
  highCutHz: 5200,
  bandQ: 0.35,
  saturationAmount: 0.035,
  bitcrushAmount: 0,
  hissGain: 0,
  hissCutoffHz: 1800,
  presencePeakDb: 1.5,
  presenceCenterHz: 1500,
  presenceQ: 0.65,
  compressorThresholdDb: -15,
  compressorRatio: 2.2,
  clickEnabled: true,
  clickGain: 0.24,
  clickDurationMs: 45,
  squelchTailEnabled: true,
  squelchTailGain: 0.018,
  squelchTailDurationMs: 95,
  playbackRate: 1,
  outputGain: 1,
  wetMix: 0.38,
};

const CODEX_CLEAN_DISPATCH_FX: VoiceFxParams = {
  ...SCOUTBOT_CLEAN_DISPATCH_FX,
  lowCutHz: 190,
  highCutHz: 5000,
  saturationAmount: 0.055,
  bitcrushAmount: 0.01,
  hissGain: 0.006,
  presencePeakDb: 2.5,
  compressorThresholdDb: -17,
  compressorRatio: 2.8,
  clickGain: 0.28,
  squelchTailGain: 0.024,
  squelchTailDurationMs: 105,
  wetMix: 0.44,
};

function voiceFxParamsCode(params: VoiceFxParams): string {
  const entries = Object.entries(params)
    .map(([key, value]) => `  ${key}: ${typeof value === "number" ? Number(value.toFixed(3)) : String(value)},`)
    .join("\n");
  return `const SCOUTBOT_VOICE_FX: Partial<VoiceFxParams> = {\n${entries}\n};`;
}

export function ScoutbotFxLab() {
  const [response, setResponse] = useState<FixturesResponse | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [buffers, setBuffers] = useState<Record<string, LoadedBuffer>>({});
  const [params, setParams] = useState<VoiceFxParams>(SCOUTBOT_CLEAN_DISPATCH_FX);
  const [activePresetId, setActivePresetId] = useState<string | null>(null);
  const [playingSlug, setPlayingSlug] = useState<string | null>(null);
  const [copyStatus, setCopyStatus] = useState<string | null>(null);
  const [loopEnabled, setLoopEnabled] = useState(false);
  const [varySpeed, setVarySpeed] = useState(false);
  const handleRef = useRef<VoiceFxHandle | null>(null);
  const sessionRef = useRef<symbol | null>(null);
  const paramsRef = useRef(params);
  const loopRef = useRef(loopEnabled);
  const varyRef = useRef(varySpeed);

  useEffect(() => { paramsRef.current = params; }, [params]);
  useEffect(() => { loopRef.current = loopEnabled; }, [loopEnabled]);
  useEffect(() => { varyRef.current = varySpeed; }, [varySpeed]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/dev/scoutbot-fx/fixtures");
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = (await res.json()) as FixturesResponse;
        if (!cancelled) setResponse(data);
      } catch (error) {
        if (!cancelled) setLoadError(error instanceof Error ? error.message : String(error));
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const ensureBuffer = useCallback(async (fixture: Fixture): Promise<AudioBuffer> => {
    if (buffers[fixture.slug]) return buffers[fixture.slug].buffer;
    const buffer = await decodeAudioFromUrl(`/api/dev/scoutbot-fx/audio/${encodeURIComponent(fixture.file)}`);
    setBuffers((prev) => ({ ...prev, [fixture.slug]: { fixture, buffer } }));
    return buffer;
  }, [buffers]);

  const stopCurrent = useCallback(() => {
    sessionRef.current = null;
    handleRef.current?.stop();
    handleRef.current = null;
    setPlayingSlug(null);
  }, []);

  const applyPreset = useCallback((id: string) => {
    const preset = VOICE_FX_PRESETS.find((p) => p.id === id);
    if (!preset) return;
    setParams(preset.params);
    setActivePresetId(id);
  }, []);

  const copyParams = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(voiceFxParamsCode(params));
      setCopyStatus("Copied");
      window.setTimeout(() => setCopyStatus(null), 1600);
    } catch (error) {
      setCopyStatus(error instanceof Error ? error.message : "Copy failed");
    }
  }, [params]);

  const playSession = useCallback(async (
    fixture: Fixture,
    mode: "fx" | "dry",
  ): Promise<void> => {
    stopCurrent();
    const token = Symbol(`${mode}:${fixture.slug}`);
    sessionRef.current = token;
    const slugKey = `${mode}:${fixture.slug}`;
    try {
      const buffer = await ensureBuffer(fixture);
      while (sessionRef.current === token) {
        const iterationParams = varyRef.current
          ? {
              ...paramsRef.current,
              playbackRate: clampSpeed(
                paramsRef.current.playbackRate + (Math.random() * 2 - 1) * SPEED_VARY_RANGE,
              ),
            }
          : paramsRef.current;
        const handle = mode === "fx"
          ? playWithVoiceFx(buffer, { params: iterationParams })
          : playDry(buffer);
        handleRef.current = handle;
        setPlayingSlug(slugKey);
        await handle.promise;
        if (sessionRef.current !== token) break;
        if (!loopRef.current) break;
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, LOOP_GAP_MS);
          // If the session is invalidated during the gap, resolve early.
          const tick = setInterval(() => {
            if (sessionRef.current !== token) {
              clearTimeout(timer);
              clearInterval(tick);
              resolve();
            }
          }, 40);
        });
      }
    } catch (error) {
      console.error(`[scoutbot-fx] ${mode} playback failed`, error);
    } finally {
      if (sessionRef.current === token) sessionRef.current = null;
      handleRef.current = null;
      setPlayingSlug((current) => (current === slugKey ? null : current));
    }
  }, [ensureBuffer, stopCurrent]);

  const playFx = useCallback((fixture: Fixture) => playSession(fixture, "fx"), [playSession]);
  const playDryFixture = useCallback((fixture: Fixture) => playSession(fixture, "dry"), [playSession]);

  const sliderGroups = useMemo(() => SLIDER_GROUPS.map((group) => ({
    title: group.title,
    rows: group.sliders.map((spec) => ({ spec, value: params[spec.key] as number })),
  })), [params]);

  const fixtures = response?.fixtures ?? [];

  return (
    <div style={pageStyle}>
      <header style={headerStyle}>
        <div>
          <h1 style={titleStyle}>Scoutbot FX Lab</h1>
          <p style={subTitleStyle}>
            Dispatcher-radio FX prototyping. Generate fixtures with{" "}
            <code style={codeStyle}>node packages/web/scripts/generate-scoutbot-fx-fixtures.mjs</code>.
          </p>
        </div>
        <div style={metaStyle}>
          {response?.generatedAt ? (
            <span>Fixtures generated {new Date(response.generatedAt).toLocaleString()}</span>
          ) : null}
          {response?.note ? <span style={warnStyle}>{response.note}</span> : null}
          {loadError ? <span style={errorStyle}>Could not load fixtures: {loadError}</span> : null}
        </div>
      </header>

      <section style={presetsStyle}>
        <div style={controlsHeaderStyle}>
          <h2 style={sectionTitleStyle}>Presets</h2>
          <div style={presetHintStyle}>Click to load. Tweaking any slider clears the active preset.</div>
        </div>
        <div style={presetGridStyle}>
          {VOICE_FX_PRESETS.map((preset) => {
            const active = activePresetId === preset.id;
            return (
              <button
                key={preset.id}
                type="button"
                style={active ? presetCardActiveStyle : presetCardStyle}
                onClick={(e) => {
                  applyPreset(preset.id);
                  // Drop focus so the browser focus outline doesn't linger and
                  // look like a second "selected" state on the previous card.
                  e.currentTarget.blur();
                }}
                title={preset.description}
              >
                <div style={active ? presetLabelActiveStyle : presetLabelStyle}>
                  {preset.label}
                  <span style={familyBadgeStyle}>{preset.family}</span>
                </div>
                <div style={active ? presetDescActiveStyle : presetDescStyle}>{preset.description}</div>
              </button>
            );
          })}
        </div>
      </section>

      <section style={controlsStyle}>
        <div style={controlsHeaderStyle}>
          <h2 style={sectionTitleStyle}>FX chain</h2>
          <div style={{ display: "flex", gap: 8 }}>
            <label style={toggleStyle}>
              <input
                type="checkbox"
                checked={params.clickEnabled}
                onChange={(e) => {
                  const next = e.target.checked;
                  setActivePresetId(null);
                  setParams((prev) => ({ ...prev, clickEnabled: next }));
                }}
              />
              Kerchunk click
            </label>
            <label style={toggleStyle}>
              <input
                type="checkbox"
                checked={params.squelchTailEnabled}
                onChange={(e) => {
                  const next = e.target.checked;
                  setActivePresetId(null);
                  setParams((prev) => ({ ...prev, squelchTailEnabled: next }));
                }}
              />
              Squelch tail
            </label>
            <button
              type="button"
              style={buttonStyle}
              onClick={() => {
                setActivePresetId("scoutbot-clean-dispatch");
                setParams(SCOUTBOT_CLEAN_DISPATCH_FX);
              }}
            >
              Scoutbot default
            </button>
            <button
              type="button"
              style={buttonStyle}
              onClick={() => {
                setActivePresetId("codex-clean-dispatch");
                setParams(CODEX_CLEAN_DISPATCH_FX);
              }}
            >
              Codex take
            </button>
            <button
              type="button"
              style={buttonStyle}
              onClick={() => {
                setActivePresetId(null);
                setParams(DEFAULT_VOICE_FX);
              }}
            >
              Raw default
            </button>
            <button
              type="button"
              style={buttonPrimaryStyle}
              onClick={() => void copyParams()}
            >
              {copyStatus ?? "Copy params"}
            </button>
          </div>
        </div>
        <div style={groupColumnStyle}>
          {sliderGroups.map((group) => (
            <div key={group.title} style={groupBlockStyle}>
              <div style={groupTitleStyle}>{group.title}</div>
              <div style={slidersGridStyle}>
                {group.rows.map(({ spec, value }) => (
                  <label key={spec.key} style={sliderRowStyle}>
                    <div style={sliderLabelRowStyle}>
                      <span>{spec.label}</span>
                      <span style={sliderValueStyle}>{spec.format(value)}</span>
                    </div>
                    <input
                      type="range"
                      min={spec.min}
                      max={spec.max}
                      step={spec.step}
                      value={value}
                      onChange={(e) => {
                        const next = Number(e.target.value);
                        setActivePresetId(null);
                        setParams((prev) => ({ ...prev, [spec.key]: next }));
                      }}
                    />
                  </label>
                ))}
              </div>
            </div>
          ))}
        </div>
      </section>

      <section style={fixturesSectionStyle}>
        <div style={controlsHeaderStyle}>
          <h2 style={sectionTitleStyle}>Fixtures</h2>
          <div style={{ display: "flex", gap: 16 }}>
            <label style={toggleStyle}>
              <input
                type="checkbox"
                checked={loopEnabled}
                onChange={(e) => setLoopEnabled(e.target.checked)}
              />
              Loop playback{loopEnabled ? " (tweaks apply next iteration)" : ""}
            </label>
            <label style={toggleStyle}>
              <input
                type="checkbox"
                checked={varySpeed}
                onChange={(e) => setVarySpeed(e.target.checked)}
              />
              Vary speed ±{Math.round(SPEED_VARY_RANGE * 100)}%
            </label>
          </div>
        </div>
        {!response ? (
          <p style={mutedStyle}>Loading…</p>
        ) : fixtures.length === 0 ? (
          <p style={mutedStyle}>
            No fixtures yet. Run{" "}
            <code style={codeStyle}>node packages/web/scripts/generate-scoutbot-fx-fixtures.mjs</code>{" "}
            (Vox must be running) and reload.
          </p>
        ) : (
          <ul style={fixtureListStyle}>
            {fixtures.map((fixture) => {
              const dryPlaying = playingSlug === `dry:${fixture.slug}`;
              const fxPlaying = playingSlug === `fx:${fixture.slug}`;
              return (
                <li key={fixture.slug} style={fixtureItemStyle}>
                  <div style={fixtureTextStyle}>
                    <div style={fixtureSlugStyle}>{fixture.slug}</div>
                    <div style={fixtureBodyStyle}>{fixture.text}</div>
                    <div style={fixtureMetaStyle}>
                      {fixture.voiceId ? `voice ${fixture.voiceId}` : null}
                      {fixture.voiceId && fixture.bytes ? " · " : null}
                      {fixture.bytes ? `${Math.round(fixture.bytes / 1024)} KB` : null}
                    </div>
                  </div>
                  <div style={fixtureControlsStyle}>
                    <button
                      type="button"
                      style={dryPlaying ? buttonActiveStyle : buttonStyle}
                      onClick={() => (dryPlaying ? stopCurrent() : playDryFixture(fixture))}
                    >
                      {dryPlaying ? "Stop" : "Play dry"}
                    </button>
                    <button
                      type="button"
                      style={fxPlaying ? buttonPrimaryActiveStyle : buttonPrimaryStyle}
                      onClick={() => (fxPlaying ? stopCurrent() : playFx(fixture))}
                    >
                      {fxPlaying ? "Stop" : "Play with FX"}
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}

const pageStyle: React.CSSProperties = {
  minHeight: "100vh",
  background: "#0b0d10",
  color: "#e6e8eb",
  padding: "32px 40px 64px",
  fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
};

const headerStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "flex-start",
  justifyContent: "space-between",
  gap: 24,
  marginBottom: 28,
};

const titleStyle: React.CSSProperties = { fontSize: 22, fontWeight: 600, margin: 0 };
const subTitleStyle: React.CSSProperties = { color: "#9aa1ab", fontSize: 13, marginTop: 6, marginBottom: 0 };
const metaStyle: React.CSSProperties = { display: "flex", flexDirection: "column", gap: 4, fontSize: 12, color: "#9aa1ab", alignItems: "flex-end" };
const warnStyle: React.CSSProperties = { color: "#f5b342" };
const errorStyle: React.CSSProperties = { color: "#ef6b6b" };
const codeStyle: React.CSSProperties = { fontFamily: "ui-monospace, SFMono-Regular, monospace", background: "#181b20", padding: "1px 6px", borderRadius: 4, fontSize: 12 };

const presetsStyle: React.CSSProperties = {
  background: "#121519",
  border: "1px solid #1f242b",
  borderRadius: 10,
  padding: 20,
  marginBottom: 18,
};
const presetHintStyle: React.CSSProperties = { fontSize: 11, color: "#6b727d" };
const presetGridStyle: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
  gap: 10,
  marginTop: 12,
};
const presetCardStyle: React.CSSProperties = {
  textAlign: "left",
  background: "#0f1216",
  borderWidth: 1,
  borderStyle: "solid",
  borderColor: "#1f242b",
  borderRadius: 8,
  padding: "12px 14px",
  color: "#c5cad2",
  cursor: "pointer",
  display: "flex",
  flexDirection: "column",
  gap: 6,
  fontFamily: "inherit",
  // Kill the browser focus outline so it doesn't look like a second
  // "selected" state on top of our custom active style.
  outline: "none",
  WebkitAppearance: "none",
  appearance: "none",
  transition: "border-color 80ms ease, background 80ms ease, color 80ms ease",
};
const presetCardActiveStyle: React.CSSProperties = {
  ...presetCardStyle,
  background: "#1a1f26",
  borderColor: "#f1f3f5",
  color: "#ffffff",
  boxShadow: "0 0 0 1px rgba(241,243,245,0.18)",
};
const presetLabelStyle: React.CSSProperties = { fontSize: 13, fontWeight: 600, display: "flex", alignItems: "center", gap: 8 };
const presetLabelActiveStyle: React.CSSProperties = { ...presetLabelStyle, color: "#ffffff" };
const presetDescStyle: React.CSSProperties = { fontSize: 11, color: "#9aa1ab", lineHeight: 1.4 };
const presetDescActiveStyle: React.CSSProperties = { ...presetDescStyle, color: "#c5cad2" };
const familyBadgeStyle: React.CSSProperties = {
  fontSize: 9,
  fontWeight: 500,
  letterSpacing: 0.6,
  textTransform: "uppercase",
  padding: "2px 6px",
  borderRadius: 4,
  background: "rgba(255,255,255,0.06)",
  color: "#9aa1ab",
};

const controlsStyle: React.CSSProperties = {
  background: "#121519",
  border: "1px solid #1f242b",
  borderRadius: 10,
  padding: 20,
  marginBottom: 28,
};
const controlsHeaderStyle: React.CSSProperties = { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 };
const sectionTitleStyle: React.CSSProperties = { fontSize: 14, textTransform: "uppercase", letterSpacing: 0.6, color: "#9aa1ab", margin: 0 };
const groupColumnStyle: React.CSSProperties = { display: "flex", flexDirection: "column", gap: 18 };
const groupBlockStyle: React.CSSProperties = { display: "flex", flexDirection: "column", gap: 10 };
const groupTitleStyle: React.CSSProperties = { fontSize: 11, textTransform: "uppercase", letterSpacing: 0.8, color: "#6b727d", fontWeight: 600 };
const slidersGridStyle: React.CSSProperties = { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 16 };
const sliderRowStyle: React.CSSProperties = { display: "flex", flexDirection: "column", gap: 6, fontSize: 12 };
const sliderLabelRowStyle: React.CSSProperties = { display: "flex", justifyContent: "space-between", color: "#c5cad2" };
const sliderValueStyle: React.CSSProperties = { color: "#7f8693", fontFamily: "ui-monospace, SFMono-Regular, monospace" };

const fixturesSectionStyle: React.CSSProperties = {
  background: "#121519",
  border: "1px solid #1f242b",
  borderRadius: 10,
  padding: 20,
};
const fixtureListStyle: React.CSSProperties = { listStyle: "none", padding: 0, margin: "16px 0 0", display: "flex", flexDirection: "column", gap: 12 };
const fixtureItemStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 16,
  background: "#0f1216",
  border: "1px solid #1f242b",
  borderRadius: 8,
  padding: "14px 16px",
};
const fixtureTextStyle: React.CSSProperties = { flex: 1, display: "flex", flexDirection: "column", gap: 4 };
const fixtureSlugStyle: React.CSSProperties = { fontFamily: "ui-monospace, SFMono-Regular, monospace", color: "#9aa1ab", fontSize: 12 };
const fixtureBodyStyle: React.CSSProperties = { color: "#e6e8eb", fontSize: 14 };
const fixtureMetaStyle: React.CSSProperties = { color: "#6b727d", fontSize: 11 };
const fixtureControlsStyle: React.CSSProperties = { display: "flex", gap: 8 };
const buttonStyle: React.CSSProperties = {
  background: "#1c2128",
  color: "#e6e8eb",
  borderWidth: 1,
  borderStyle: "solid",
  borderColor: "#2a3038",
  padding: "6px 12px",
  borderRadius: 6,
  fontSize: 12,
  cursor: "pointer",
};
const buttonActiveStyle: React.CSSProperties = { ...buttonStyle, background: "#2a3038", borderColor: "#3c4350" };
const buttonPrimaryStyle: React.CSSProperties = {
  background: "#2e6cdf",
  color: "#fff",
  borderWidth: 1,
  borderStyle: "solid",
  borderColor: "#2e6cdf",
  padding: "6px 12px",
  borderRadius: 6,
  fontSize: 12,
  cursor: "pointer",
};
const buttonPrimaryActiveStyle: React.CSSProperties = { ...buttonPrimaryStyle, background: "#1f57bf", borderColor: "#1f57bf" };
const toggleStyle: React.CSSProperties = { display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: "#c5cad2", cursor: "pointer" };
const mutedStyle: React.CSSProperties = { color: "#9aa1ab", fontSize: 13, margin: "12px 0 0" };
