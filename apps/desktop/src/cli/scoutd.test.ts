import { describe, expect, test } from "bun:test";

import {
  nativeScoutdCommandTimeoutMs,
  normalizeNativeScoutdDoctorReport,
  renderNativeScoutdDoctorSection,
} from "./scoutd.ts";

describe("native scoutd doctor helpers", () => {
  test("allows the native restart lifecycle to reach its own stop and start deadlines", () => {
    expect(nativeScoutdCommandTimeoutMs("status")).toBe(20_000);
    expect(nativeScoutdCommandTimeoutMs("restart")).toBe(180_000);
    expect(nativeScoutdCommandTimeoutMs("restart", 1_000)).toBe(1_000);
  });

  test("normalizes current scoutd doctor JSON with warnings and process observations", () => {
    const report = normalizeNativeScoutdDoctorReport({
      scoutdPath: "/opt/openscout/scoutd",
      source: "package",
      raw: {
        status: {
          label: "com.openscout.scoutd",
          loaded: true,
          pid: 42,
          reachable: false,
          brokerSocketPath: "/Users/art/Library/Application Support/OpenScout/runtime/broker.sock",
          health: {
            ok: false,
            transport: "unix_socket",
            error: "connection refused",
          },
          runtimeFreshness: {
            state: "unverified",
            intentional: false,
            basis: "explicit_pin",
            reasonCode: "pin_mismatch",
            actualBuiltAt: "2026-08-01T12:00:00.000Z",
            expectedBuiltAt: null,
            detail: "Running runtime commit old does not match explicit pin new.",
          },
        },
        warnings: [
          "broker socket exists but health is unreachable",
          "multiple scout-broker processes found: 2",
        ],
        processes: [
          {
            pid: 42,
            ppid: 1,
            pcpu: "0.0",
            pmem: "0.1",
            elapsed: "00:15",
            command: "/opt/openscout/scoutd supervise",
          },
        ],
      },
    });

    expect(report.available).toBe(true);
    expect(report.status?.label).toBe("com.openscout.scoutd");
    expect(report.warnings).toContain("broker socket exists but health is unreachable");
    expect(report.processes[0]?.command).toContain("scoutd supervise");

    const rendered = renderNativeScoutdDoctorSection(report);
    expect(rendered).toContain("Native daemon:");
    expect(rendered).toContain("multiple scout-broker processes found");
    expect(rendered).toContain("Runtime freshness: unverified");
    expect(rendered).toContain("Runtime reason: pin_mismatch");
    expect(rendered).toContain("pid 42 ppid 1");
  });

  test("renders unsupported repairs without failing the doctor path", () => {
    const report = normalizeNativeScoutdDoctorReport({
      scoutdPath: "/opt/openscout/scoutd",
      source: "package",
      fixRequested: true,
      yes: true,
      raw: {
        status: {
          loaded: true,
          reachable: true,
        },
        warnings: [],
        processes: [],
      },
    });

    expect(report.fix.supported).toBe(false);
    expect(renderNativeScoutdDoctorSection(report)).toContain("Repair: not supported by this scoutd build");
  });

  test("renders future repair action reports generically", () => {
    const report = normalizeNativeScoutdDoctorReport({
      scoutdPath: "/opt/openscout/scoutd",
      source: "package",
      fixRequested: true,
      raw: {
        version: "0.2.75",
        fixes: [
          {
            id: "stale-socket",
            title: "Remove stale broker socket",
            status: "applied",
            detail: "Removed socket after broker health stayed unreachable.",
          },
        ],
      },
    });

    expect(report.buildIdentity).toBe("0.2.75");
    expect(report.fix.supported).toBe(true);
    expect(report.fix.entries[0]?.id).toBe("stale-socket");
    const rendered = renderNativeScoutdDoctorSection(report);
    expect(rendered).toContain("Build: 0.2.75");
    expect(rendered).toContain("Remove stale broker socket [applied]");
  });
});
